#!/usr/bin/env python3
"""Track player/ball candidates over a video and aggregate tracks per segment."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from statistics import median


def main() -> None:
    parser = argparse.ArgumentParser(description="Track objects with Ultralytics ByteTrack/BoT-SORT.")
    parser.add_argument("media_path")
    parser.add_argument("--model", default=os.environ.get("VISION_DETECTOR_MODEL", "yolo11n.pt"))
    parser.add_argument("--tracker", default=os.environ.get("VISION_TRACKER", "bytetrack.yaml"))
    parser.add_argument("--conf", type=float, default=float(os.environ.get("VISION_TRACKER_CONF", "0.2")))
    parser.add_argument("--vid-stride", type=int, default=int(os.environ.get("VISION_TRACKER_VID_STRIDE", "3")))
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    segments = payload.get("segments", [])
    try:
        result = track_objects(args, segments)
    except Exception as error:
        result = {
            "available": False,
            "provider": "ultralytics-track",
            "model": args.model,
            "tracker": args.tracker,
            "segments": [],
            "error": f"{type(error).__name__}: {error}",
        }
    print(json.dumps(result, ensure_ascii=False))


def track_objects(args: argparse.Namespace, segments: list[dict]) -> dict:
    import cv2
    from ultralytics import YOLO

    segment_items = normalize_segments(segments)
    if not segment_items:
        return unavailable(args, "No segments were provided for tracking.")

    fps = read_fps(cv2, args.media_path)
    model = YOLO(args.model)
    segment_frames: dict[str, list[dict]] = defaultdict(list)
    frame_number = 0
    for result in model.track(
        source=args.media_path,
        stream=True,
        persist=True,
        tracker=args.tracker,
        conf=args.conf,
        vid_stride=max(1, args.vid_stride),
        verbose=False,
    ):
        at = frame_number / fps
        frame_number += max(1, args.vid_stride)
        segment = segment_for_time(segment_items, at)
        if not segment:
            continue
        boxes = boxes_from_result(result)
        if boxes:
            segment_frames[segment["id"]].append({"at": round(at, 3), "boxes": boxes})

    summaries = [summarize_segment(segment, segment_frames.get(segment["id"], []), args) for segment in segment_items]
    summaries = [summary for summary in summaries if summary["trackedFrameCount"] > 0]
    return {
        "available": True,
        "provider": "ultralytics-track",
        "model": args.model,
        "tracker": args.tracker,
        "segments": summaries,
        "error": None,
    }


def unavailable(args: argparse.Namespace, error: str) -> dict:
    return {
        "available": False,
        "provider": "ultralytics-track",
        "model": args.model,
        "tracker": args.tracker,
        "segments": [],
        "error": error,
    }


def normalize_segments(segments: list[dict]) -> list[dict]:
    normalized = []
    for segment in segments:
        segment_id = str(segment.get("id") or "").strip()
        if not segment_id:
            continue
        start = float(segment.get("start") or 0)
        end = float(segment.get("end") or start)
        if end <= start:
            end = start + 0.1
        normalized.append({"id": segment_id, "start": max(0.0, start), "end": max(0.0, end)})
    return sorted(normalized, key=lambda item: (item["start"], item["end"]))


def read_fps(cv2, media_path: str) -> float:
    capture = cv2.VideoCapture(media_path)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    capture.release()
    return fps if fps > 0 else 30.0


def segment_for_time(segments: list[dict], at: float) -> dict | None:
    for segment in segments:
        if segment["start"] <= at <= segment["end"]:
            return segment
    return None


def boxes_from_result(result) -> list[dict]:
    names = result.names or {}
    width = int(result.orig_shape[1])
    height = int(result.orig_shape[0])
    boxes = []
    for box in result.boxes:
        cls = int(box.cls[0])
        name = str(names.get(cls, cls)).lower()
        label = "person" if name == "person" else "sports_ball" if name in {"sports ball", "ball"} else "unknown"
        if label == "unknown":
            continue
        track_id = None
        if getattr(box, "id", None) is not None:
            try:
                track_id = f"{label}-{int(box.id[0])}"
            except Exception:
                track_id = None
        x1, y1, x2, y2 = [float(value) for value in box.xyxy[0]]
        boxes.append(
            {
                "label": label,
                "trackId": track_id,
                "confidence": round(float(box.conf[0]), 3),
                "x": round(x1 / width, 4),
                "y": round(y1 / height, 4),
                "width": round((x2 - x1) / width, 4),
                "height": round((y2 - y1) / height, 4),
                "source": "ultralytics-track",
            }
        )
    return boxes


def summarize_segment(segment: dict, frames: list[dict], args: argparse.Namespace) -> dict:
    tracks = defaultdict(lambda: {"label": "", "frames": 0, "confidence": [], "centers": [], "firstSeen": None, "lastSeen": None})
    nearest_counter: Counter[str] = Counter()
    distances = []
    best_frame = None
    for frame in frames:
        boxes = frame["boxes"]
        if best_frame is None or len(boxes) > len(best_frame["boxes"]):
            best_frame = frame
        for box in boxes:
            track_id = box.get("trackId")
            if not track_id:
                continue
            item = tracks[track_id]
            item["label"] = box["label"]
            item["frames"] += 1
            item["confidence"].append(float(box["confidence"]))
            item["centers"].append((float(frame["at"]), center(box)))
            item["firstSeen"] = frame["at"] if item["firstSeen"] is None else min(item["firstSeen"], frame["at"])
            item["lastSeen"] = frame["at"] if item["lastSeen"] is None else max(item["lastSeen"], frame["at"])
        ball = primary_box([box for box in boxes if box["label"] == "sports_ball"])
        players = [box for box in boxes if box["label"] == "person" and box.get("trackId")]
        nearest = nearest_player(ball, players) if ball else None
        if nearest:
            nearest_counter[nearest["trackId"]] += 1
            distances.append(nearest["distance"])

    track_summaries = summarize_tracks(tracks)
    ball_tracks = [track for track in track_summaries if track["label"] == "sports_ball"]
    player_tracks = [track for track in track_summaries if track["label"] == "person"]
    primary_ball = top_track(ball_tracks)
    primary_player = nearest_counter.most_common(1)[0][0] if nearest_counter else (top_track(player_tracks) or {}).get("id")
    ball_movement = movement_for_track(tracks.get(primary_ball["id"]) if primary_ball else None)
    track_coverage = len(frames) / max(1, expected_frame_count(segment, args.vid_stride))
    return {
        "segmentId": segment["id"],
        "frameCount": expected_frame_count(segment, args.vid_stride),
        "trackedFrameCount": len(frames),
        "trackCoverage": round(min(1.0, track_coverage), 3),
        "ballTrackId": primary_ball["id"] if primary_ball else None,
        "nearestPlayerTrackId": primary_player,
        "ballMovement": ball_movement,
        "proximity": proximity_from_distances(distances),
        "playerTracks": player_tracks[:16],
        "ballTracks": ball_tracks[:6],
        "idSwitches": max(0, len(ball_tracks) - 1) + max(0, len(player_tracks) - 1),
        "boxes": (best_frame or {}).get("boxes", [])[:24],
        "provider": "ultralytics-track",
        "model": args.model,
        "tracker": args.tracker,
    }


def summarize_tracks(tracks: dict) -> list[dict]:
    summaries = []
    for track_id, track in tracks.items():
        confidence = sum(track["confidence"]) / max(1, len(track["confidence"]))
        summaries.append(
            {
                "id": track_id,
                "label": track["label"],
                "frames": int(track["frames"]),
                "confidence": round(confidence, 3),
                "firstSeen": track["firstSeen"],
                "lastSeen": track["lastSeen"],
            }
        )
    return sorted(summaries, key=lambda item: (item["frames"], item["confidence"]), reverse=True)


def top_track(tracks: list[dict]) -> dict | None:
    return sorted(tracks, key=lambda item: (item["frames"], item["confidence"]), reverse=True)[0] if tracks else None


def movement_for_track(track: dict | None) -> dict:
    if not track or len(track["centers"]) < 2:
        return {"fromPrevious": None, "speedPerSecond": None, "direction": "unknown"}
    ordered = sorted(track["centers"], key=lambda item: item[0])
    start_at, start_center = ordered[0]
    end_at, end_center = ordered[-1]
    distance_value = distance(start_center, end_center)
    seconds = max(0.001, end_at - start_at)
    return {
        "fromPrevious": round(distance_value, 4),
        "speedPerSecond": round(distance_value / seconds, 4),
        "direction": movement_direction(start_center, end_center),
    }


def proximity_from_distances(distances: list[float]) -> dict:
    if not distances:
        return {"ballNearPlayer": False, "confidence": 0, "normalizedDistance": None}
    value = float(median(distances))
    return {
        "ballNearPlayer": value <= 0.22,
        "confidence": round(max(0.0, min(0.86, 0.82 - value)), 3),
        "normalizedDistance": round(value, 4),
    }


def expected_frame_count(segment: dict, vid_stride: int) -> int:
    duration = max(0.1, float(segment["end"]) - float(segment["start"]))
    return max(1, int(duration * 30 / max(1, vid_stride)))


def primary_box(boxes: list[dict]) -> dict | None:
    return sorted(boxes, key=lambda item: item["confidence"], reverse=True)[0] if boxes else None


def nearest_player(ball: dict, players: list[dict]) -> dict | None:
    if not ball or not players:
        return None
    ball_center = center(ball)
    nearest = sorted(players, key=lambda player: distance(ball_center, center(player)))[0]
    return {**nearest, "distance": distance(ball_center, center(nearest))}


def center(box: dict) -> tuple[float, float]:
    return (float(box["x"]) + float(box["width"]) / 2, float(box["y"]) + float(box["height"]) / 2)


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def movement_direction(previous: tuple[float, float], next_value: tuple[float, float]) -> str:
    dx = next_value[0] - previous[0]
    dy = next_value[1] - previous[1]
    if abs(dx) < 0.025 and abs(dy) < 0.025:
        return "stationary"
    if abs(dx) >= abs(dy):
        return "right" if dx > 0 else "left"
    return "vertical"


if __name__ == "__main__":
    try:
        main()
    except Exception as fatal:
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": "ultralytics-track",
                    "model": os.environ.get("VISION_DETECTOR_MODEL", "yolo11n.pt"),
                    "tracker": os.environ.get("VISION_TRACKER", "bytetrack.yaml"),
                    "segments": [],
                    "error": f"{type(fatal).__name__}: {fatal}",
                },
                ensure_ascii=False,
            )
        )
        sys.exit(0)
