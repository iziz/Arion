#!/usr/bin/env python3
"""Track player/ball candidates over a video and aggregate tracks per segment."""

from __future__ import annotations

import argparse
import colorsys
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

    team_assignments = cluster_team_profiles(summarize_tracks(collect_tracks(segment_frames)))
    summaries = [summarize_segment(segment, segment_frames.get(segment["id"], []), args, team_assignments) for segment in segment_items]
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
        item = {
            "label": label,
            "trackId": track_id,
            "confidence": round(float(box.conf[0]), 3),
            "x": round(x1 / width, 4),
            "y": round(y1 / height, 4),
            "width": round((x2 - x1) / width, 4),
            "height": round((y2 - y1) / height, 4),
            "source": "ultralytics-track",
        }
        appearance = appearance_from_box(getattr(result, "orig_img", None), x1, y1, x2, y2, label)
        if appearance:
            item["appearance"] = appearance
        boxes.append(item)
    return boxes


def summarize_segment(segment: dict, frames: list[dict], args: argparse.Namespace, team_assignments: dict[str, dict]) -> dict:
    tracks = empty_track_map()
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
            collect_box_track(tracks, box, float(frame["at"]))
        ball = primary_box([box for box in boxes if box["label"] == "sports_ball"])
        players = [box for box in boxes if box["label"] == "person" and box.get("trackId")]
        nearest = nearest_player(ball, players) if ball else None
        if nearest:
            nearest_counter[nearest["trackId"]] += 1
            distances.append(nearest["distance"])

    track_summaries = summarize_tracks(tracks, team_assignments)
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


def empty_track_map():
    return defaultdict(lambda: {"label": "", "frames": 0, "confidence": [], "centers": [], "appearances": [], "firstSeen": None, "lastSeen": None})


def collect_tracks(segment_frames: dict[str, list[dict]]) -> dict:
    tracks = empty_track_map()
    for frames in segment_frames.values():
        for frame in frames:
            for box in frame["boxes"]:
                track_id = box.get("trackId")
                if track_id:
                    collect_box_track(tracks, box, float(frame["at"]))
    return tracks


def collect_box_track(tracks: dict, box: dict, at: float) -> None:
    track_id = box.get("trackId")
    if not track_id:
        return
    item = tracks[track_id]
    item["label"] = box["label"]
    item["frames"] += 1
    item["confidence"].append(float(box["confidence"]))
    item["centers"].append((at, center(box)))
    if box.get("appearance"):
        item["appearances"].append(box["appearance"])
    item["firstSeen"] = at if item["firstSeen"] is None else min(item["firstSeen"], at)
    item["lastSeen"] = at if item["lastSeen"] is None else max(item["lastSeen"], at)


def summarize_tracks(tracks: dict, team_assignments: dict[str, dict] | None = None) -> list[dict]:
    summaries = []
    team_assignments = team_assignments or {}
    for track_id, track in tracks.items():
        confidence = sum(track["confidence"]) / max(1, len(track["confidence"]))
        summary = {
            "id": track_id,
            "label": track["label"],
            "frames": int(track["frames"]),
            "confidence": round(confidence, 3),
            "firstSeen": track["firstSeen"],
            "lastSeen": track["lastSeen"],
        }
        appearance = aggregate_appearance(track["appearances"])
        if appearance:
            summary["appearance"] = appearance
        assignment = team_assignments.get(track_id)
        if assignment:
            summary.update(assignment)
        summaries.append(summary)
    return sorted(summaries, key=lambda item: (item["frames"], item["confidence"]), reverse=True)


def appearance_from_box(image, x1: float, y1: float, x2: float, y2: float, label: str) -> dict | None:
    if label != "person" or image is None:
        return None
    height, width = image.shape[:2]
    left = clamp_int(x1 + (x2 - x1) * 0.22, 0, width - 1)
    right = clamp_int(x1 + (x2 - x1) * 0.78, left + 1, width)
    top = clamp_int(y1 + (y2 - y1) * 0.18, 0, height - 1)
    bottom = clamp_int(y1 + (y2 - y1) * 0.62, top + 1, height)
    if right - left < 3 or bottom - top < 3:
        return None

    import cv2

    crop = image[top:bottom, left:right]
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    mask = (saturation > 35) & (value > 45)
    sample_count = int(mask.sum())
    if sample_count < 20:
        return None
    hue_value = float(median([float(item) for item in hsv[:, :, 0][mask]]))
    saturation_value = float(median([float(item) for item in saturation[mask]]))
    brightness_value = float(median([float(item) for item in value[mask]]))
    return {
        "dominantHex": hsv_to_hex(hue_value, saturation_value, brightness_value),
        "hue": round(hue_value / 179.0, 3),
        "saturation": round(saturation_value / 255.0, 3),
        "brightness": round(brightness_value / 255.0, 3),
        "samplePixels": sample_count,
        "region": "upper_body",
    }


def aggregate_appearance(appearances: list[dict]) -> dict | None:
    usable = [item for item in appearances if item.get("samplePixels", 0) > 0]
    if not usable:
        return None
    total_weight = sum(float(item["samplePixels"]) for item in usable)
    hue_x = sum(math.cos(float(item["hue"]) * math.tau) * float(item["samplePixels"]) for item in usable)
    hue_y = sum(math.sin(float(item["hue"]) * math.tau) * float(item["samplePixels"]) for item in usable)
    hue = (math.atan2(hue_y, hue_x) / math.tau) % 1.0
    saturation = sum(float(item["saturation"]) * float(item["samplePixels"]) for item in usable) / total_weight
    brightness = sum(float(item["brightness"]) * float(item["samplePixels"]) for item in usable) / total_weight
    return {
        "dominantHex": hsv_to_hex(hue * 179.0, saturation * 255.0, brightness * 255.0),
        "hue": round(hue, 3),
        "saturation": round(saturation, 3),
        "brightness": round(brightness, 3),
        "samplePixels": int(total_weight),
        "region": "upper_body",
    }


def cluster_team_profiles(track_summaries: list[dict]) -> dict[str, dict]:
    profiles = [
        item for item in track_summaries
        if item.get("label") == "person"
        and item.get("appearance")
        and item["appearance"].get("samplePixels", 0) >= 20
        and item["appearance"].get("saturation", 0) >= 0.12
    ]
    if not profiles:
        return {}
    first = sorted(profiles, key=lambda item: (item.get("frames", 0), item.get("confidence", 0), item["appearance"].get("samplePixels", 0)), reverse=True)[0]
    second = sorted(
        [item for item in profiles if item["id"] != first["id"]],
        key=lambda item: hue_distance(item["appearance"]["hue"], first["appearance"]["hue"]),
        reverse=True,
    )[0] if len(profiles) > 1 else None
    assignments: dict[str, dict] = {}
    if not second or hue_distance(first["appearance"]["hue"], second["appearance"]["hue"]) < 0.1:
        for item in profiles:
            assignments[item["id"]] = team_assignment("team-1", 0.44, item, "single dominant kit-color cluster")
        return assignments

    centers = {"team-1": first["appearance"]["hue"], "team-2": second["appearance"]["hue"]}
    for item in profiles:
        distances = {cluster: hue_distance(item["appearance"]["hue"], hue) for cluster, hue in centers.items()}
        ordered = sorted(distances.items(), key=lambda pair: pair[1])
        gap = ordered[1][1] - ordered[0][1]
        if gap < 0.06:
            assignments[item["id"]] = team_assignment("unknown", 0.34, item, "ambiguous kit-color distance")
            continue
        confidence = min(0.86, 0.45 + gap * 1.2 + float(item["appearance"].get("saturation", 0)) * 0.15)
        assignments[item["id"]] = team_assignment(ordered[0][0], confidence, item, f"hue distance gap {gap:.3f}")
    return assignments


def team_assignment(cluster: str, confidence: float, item: dict, reason: str) -> dict:
    appearance = item.get("appearance") or {}
    return {
        "teamCluster": cluster,
        "teamConfidence": round(confidence, 3),
        "teamEvidence": [
            f"upper-body kit color {appearance.get('dominantHex', 'unknown')}",
            reason,
        ],
    }


def hue_distance(left: float, right: float) -> float:
    diff = abs(float(left) - float(right))
    return min(diff, 1.0 - diff)


def hsv_to_hex(hue: float, saturation: float, brightness: float) -> str:
    red, green, blue = colorsys.hsv_to_rgb(max(0.0, min(1.0, hue / 179.0)), max(0.0, min(1.0, saturation / 255.0)), max(0.0, min(1.0, brightness / 255.0)))
    return f"#{int(red * 255):02x}{int(green * 255):02x}{int(blue * 255):02x}"


def clamp_int(value: float, minimum: int, maximum: int) -> int:
    return int(max(minimum, min(maximum, round(value))))


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
