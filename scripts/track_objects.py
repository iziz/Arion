#!/usr/bin/env python3
"""Track player/ball candidates over a video and aggregate tracks per segment."""

from __future__ import annotations

import argparse
import colorsys
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from statistics import median


def main() -> None:
    parser = argparse.ArgumentParser(description="Track objects with Ultralytics ByteTrack/BoT-SORT.")
    parser.add_argument("media_path")
    parser.add_argument("--model", default=os.environ.get("VISION_DETECTOR_MODEL", "yolo11n.pt"))
    parser.add_argument("--tracker", default=os.environ.get("VISION_TRACKER", "bytetrack.yaml"))
    parser.add_argument("--conf", type=float, default=float(os.environ.get("VISION_TRACKER_CONF", "0.2")))
    parser.add_argument("--vid-stride", type=int, default=int(os.environ.get("VISION_TRACKER_VID_STRIDE", "3")))
    parser.add_argument("--jersey-ocr", nargs="?", const="1", default=os.environ.get("JERSEY_OCR_ENABLED", "1"))
    parser.add_argument("--jersey-ocr-lang", default=os.environ.get("JERSEY_OCR_LANG", "en"))
    parser.add_argument("--jersey-ocr-min-confidence", type=float, default=float(os.environ.get("JERSEY_OCR_MIN_CONFIDENCE", "0.6")))
    parser.add_argument("--jersey-ocr-max-samples-per-track", type=int, default=int(os.environ.get("JERSEY_OCR_MAX_SAMPLES_PER_TRACK", "3")))
    parser.add_argument("--jersey-ocr-max-total-samples", type=int, default=int(os.environ.get("JERSEY_OCR_MAX_TOTAL_SAMPLES", "48")))
    parser.add_argument("--jersey-ocr-min-box-height", type=float, default=float(os.environ.get("JERSEY_OCR_MIN_BOX_HEIGHT", "0.12")))
    parser.add_argument("--face-identity", nargs="?", const="1", default=os.environ.get("FACE_IDENTITY_ENABLED", "0"))
    parser.add_argument("--face-identity-model", default=os.environ.get("FACE_IDENTITY_MODEL_PATH", ""))
    parser.add_argument("--face-identity-gallery", default=os.environ.get("FACE_IDENTITY_GALLERY_PATH", ""))
    parser.add_argument("--face-identity-min-confidence", type=float, default=float(os.environ.get("FACE_IDENTITY_MIN_CONFIDENCE", "0.62")))
    parser.add_argument("--face-identity-max-samples-per-track", type=int, default=int(os.environ.get("FACE_IDENTITY_MAX_SAMPLES_PER_TRACK", "2")))
    parser.add_argument("--face-identity-max-total-samples", type=int, default=int(os.environ.get("FACE_IDENTITY_MAX_TOTAL_SAMPLES", "32")))
    parser.add_argument("--field-calibration", default=os.environ.get("FIELD_CALIBRATION_CONFIG", ""))
    parser.add_argument("--diagnostics-frame-limit", type=int, default=int(os.environ.get("TRACKER_DIAGNOSTICS_FRAME_LIMIT", "240")))
    parser.add_argument("--diagnostics-decision-limit", type=int, default=int(os.environ.get("TRACKER_DIAGNOSTICS_DECISION_LIMIT", "160")))
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    segments = payload.get("segments", [])
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    try:
        result = track_objects(args, segments, metadata)
    except Exception as error:
        result = {
            "available": False,
            "provider": "ultralytics-track",
            "model": args.model,
            "tracker": args.tracker,
            "segments": [],
            "error": f"{type(error).__name__}: {error}",
            "diagnostics": unavailable_diagnostics(args, f"{type(error).__name__}: {error}", metadata),
        }
    print(json.dumps(result, ensure_ascii=False))


def track_objects(args: argparse.Namespace, segments: list[dict], metadata: dict | None = None) -> dict:
    import cv2
    from ultralytics import YOLO

    metadata = metadata if isinstance(metadata, dict) else {}
    started_at = utc_now_iso()
    started_perf = time.perf_counter()
    run_id = str(metadata.get("runId") or f"tracker-{uuid.uuid4()}")
    segment_items = normalize_segments(segments)
    if not segment_items:
        return unavailable(args, "No segments were provided for tracking.", metadata, run_id=run_id, started_at=started_at, duration_ms=elapsed_ms(started_perf))

    media_info = read_media_info(cv2, args.media_path)
    fps = float(media_info.get("fps") or 30.0)
    model = YOLO(args.model)
    jersey_ocr = JerseyNumberOcr(args)
    face_identity = FaceIdentityMatcher(args)
    field_calibration = FieldCalibration.from_path(args.field_calibration)
    segment_frames: dict[str, list[dict]] = defaultdict(list)
    frame_audit: list[dict] = []
    frame_audit_overflow = 0
    frame_number = 0
    processed_frame_count = 0
    outside_segment_frame_count = 0
    boxless_segment_frame_count = 0
    for result in model.track(
        source=args.media_path,
        stream=True,
        persist=True,
        tracker=args.tracker,
        conf=args.conf,
        vid_stride=max(1, args.vid_stride),
        verbose=False,
    ):
        processed_frame_count += 1
        source_frame_number = frame_number
        at = source_frame_number / fps
        frame_number += max(1, args.vid_stride)
        segment = segment_for_time(segment_items, at)
        if not segment:
            outside_segment_frame_count += 1
            frame_audit_overflow += append_frame_audit(
                frame_audit,
                args.diagnostics_frame_limit,
                processed_frame_count,
                source_frame_number,
                at,
                None,
                [],
                "outside_segment",
                "frame_time_not_in_any_requested_segment",
            )
            continue
        boxes = boxes_from_result(result, jersey_ocr, face_identity, at, processed_frame_count, source_frame_number)
        frame_status = "tracked" if boxes else "no_boxes"
        frame_reason = None if boxes else "detector_returned_no_supported_person_or_ball_boxes"
        frame_audit_overflow += append_frame_audit(
            frame_audit,
            args.diagnostics_frame_limit,
            processed_frame_count,
            source_frame_number,
            at,
            segment,
            boxes,
            frame_status,
            frame_reason,
        )
        if boxes:
            segment_frames[segment["id"]].append({"at": round(at, 3), "frameIndex": processed_frame_count, "sourceFrameNumber": source_frame_number, "boxes": boxes})
        else:
            boxless_segment_frame_count += 1

    team_assignments = cluster_team_profiles(summarize_tracks(collect_tracks(segment_frames)))
    all_summaries = [summarize_segment(segment, segment_frames.get(segment["id"], []), args, team_assignments, field_calibration) for segment in segment_items]
    summaries = [summary for summary in all_summaries if summary["trackedFrameCount"] > 0]
    diagnostics = tracker_diagnostics(
        args,
        media_info,
        segment_items,
        segment_frames,
        all_summaries,
        summaries,
        processed_frame_count,
        outside_segment_frame_count,
        boxless_segment_frame_count,
        jersey_ocr,
        face_identity,
        field_calibration,
        cv2,
        metadata,
        run_id,
        started_at,
        elapsed_ms(started_perf),
        frame_audit,
        frame_audit_overflow,
    )
    return {
        "available": True,
        "provider": "ultralytics-track",
        "model": args.model,
        "tracker": args.tracker,
        "segments": summaries,
        "diagnostics": diagnostics,
        "error": None,
    }


def unavailable(args: argparse.Namespace, error: str, metadata: dict | None = None, run_id: str | None = None, started_at: str | None = None, duration_ms: float | None = None) -> dict:
    return {
        "available": False,
        "provider": "ultralytics-track",
        "model": args.model,
        "tracker": args.tracker,
        "segments": [],
        "error": error,
        "diagnostics": unavailable_diagnostics(args, error, metadata, run_id=run_id, started_at=started_at, duration_ms=duration_ms),
    }


def unavailable_diagnostics(args: argparse.Namespace, error: str, metadata: dict | None = None, run_id: str | None = None, started_at: str | None = None, duration_ms: float | None = None) -> dict:
    metadata = metadata if isinstance(metadata, dict) else {}
    started_at = started_at or utc_now_iso()
    return {
        "schema": "tracking_diagnostics_v1",
        "status": "unavailable",
        "error": error,
        "provenance": provenance_metadata(metadata, run_id or str(metadata.get("runId") or f"tracker-{uuid.uuid4()}"), started_at, duration_ms),
        "config": {
            "model": args.model,
            "tracker": args.tracker,
            "confidenceThreshold": round(float(args.conf), 4),
            "vidStride": max(1, int(args.vid_stride)),
            "jerseyOcrEnabled": parse_bool(args.jersey_ocr),
            "faceIdentityEnabled": parse_bool(args.face_identity),
            "fieldCalibrationConfigured": bool(str(args.field_calibration or "").strip()),
            "diagnosticsFrameLimit": max(0, int(args.diagnostics_frame_limit)),
            "diagnosticsDecisionLimit": max(0, int(args.diagnostics_decision_limit)),
        },
        "runtime": {
            "processedFrameCount": 0,
            "emittedSegmentCount": 0,
        },
        "fingerprints": tracker_fingerprints(args),
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
    return float(read_media_info(cv2, media_path).get("fps") or 30.0)


def read_media_info(cv2, media_path: str) -> dict:
    capture = cv2.VideoCapture(media_path)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    codec = fourcc_to_string(capture.get(cv2.CAP_PROP_FOURCC) or 0)
    capture.release()
    effective_fps = fps if fps > 0 else 30.0
    exists = os.path.exists(media_path)
    return {
        "sourceFile": os.path.basename(media_path),
        "exists": exists,
        "sizeBytes": os.path.getsize(media_path) if exists else None,
        "mtime": round(os.path.getmtime(media_path), 3) if exists else None,
        "contentFingerprint": file_content_fingerprint(media_path) if exists else None,
        "fps": round(effective_fps, 3),
        "reportedFps": round(fps, 3) if fps > 0 else None,
        "width": width or None,
        "height": height or None,
        "frameCount": frame_count or None,
        "durationSeconds": round(frame_count / effective_fps, 3) if frame_count > 0 and effective_fps > 0 else None,
        "codec": codec,
    }


def fourcc_to_string(value) -> str | None:
    try:
        code = int(value)
    except Exception:
        return None
    if code <= 0:
        return None
    chars = [chr((code >> (8 * index)) & 0xFF) for index in range(4)]
    text = "".join(chars).strip()
    return text if text and all(31 < ord(char) < 127 for char in text) else None


def segment_for_time(segments: list[dict], at: float) -> dict | None:
    for segment in segments:
        if segment["start"] <= at <= segment["end"]:
            return segment
    return None


def append_frame_audit(audit: list[dict], limit: int, frame_index: int, source_frame_number: int, at: float, segment: dict | None, boxes: list[dict], status: str, reason: str | None) -> int:
    if len(audit) >= max(0, int(limit)):
        return 1
    boxes_by_label = Counter(str(box.get("label") or "unknown") for box in boxes)
    track_ids = [box.get("trackId") for box in boxes if box.get("trackId")]
    audit.append(
        {
            "frameIndex": frame_index,
            "sourceFrameNumber": source_frame_number,
            "frameAt": round(at, 3),
            "segmentId": segment.get("id") if segment else None,
            "status": status,
            "reason": reason,
            "boxCount": len(boxes),
            "boxesByLabel": compact_counter(boxes_by_label),
            "trackIds": track_ids[:12],
            "maxConfidence": round(max([float(box.get("confidence") or 0) for box in boxes], default=0.0), 3),
        }
    )
    return 0


def boxes_from_result(result, jersey_ocr=None, face_identity=None, at: float | None = None, frame_index: int | None = None, source_frame_number: int | None = None) -> list[dict]:
    names = result.names or {}
    width = int(result.orig_shape[1])
    height = int(result.orig_shape[0])
    boxes = []
    image = getattr(result, "orig_img", None)
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
        appearance = appearance_from_box(image, x1, y1, x2, y2, label)
        if appearance:
            item["appearance"] = appearance
        audit_context = {
            "frameIndex": frame_index,
            "sourceFrameNumber": source_frame_number,
            "frameAt": round(at, 3) if at is not None else None,
            "trackId": track_id,
            "label": label,
            "confidence": item["confidence"],
            "bbox": {
                "x1": round(x1, 2),
                "y1": round(y1, 2),
                "x2": round(x2, 2),
                "y2": round(y2, 2),
                "width": round(x2 - x1, 2),
                "height": round(y2 - y1, 2),
            },
            "normalizedBbox": {
                "x": item["x"],
                "y": item["y"],
                "width": item["width"],
                "height": item["height"],
            },
        }
        if jersey_ocr:
            jersey_candidates = jersey_ocr.candidates_for_box(image, x1, y1, x2, y2, label, track_id, at, audit_context)
            if jersey_candidates:
                item["jerseyNumberCandidates"] = jersey_candidates
        if face_identity:
            face_candidates = face_identity.candidates_for_box(image, x1, y1, x2, y2, label, track_id, at, audit_context)
            if face_candidates:
                item["faceIdentityCandidates"] = face_candidates
        boxes.append(item)
    return boxes


def summarize_segment(segment: dict, frames: list[dict], args: argparse.Namespace, team_assignments: dict[str, dict], field_calibration=None) -> dict:
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

    track_summaries = summarize_tracks(tracks, team_assignments, field_calibration)
    ball_tracks = [track for track in track_summaries if track["label"] == "sports_ball"]
    player_tracks = [track for track in track_summaries if track["label"] == "person"]
    primary_ball = top_track(ball_tracks)
    primary_player = nearest_counter.most_common(1)[0][0] if nearest_counter else (top_track(player_tracks) or {}).get("id")
    ball_movement = movement_for_track(tracks.get(primary_ball["id"]) if primary_ball else None)
    expected_count = expected_frame_count(segment, args.vid_stride)
    track_coverage = len(frames) / max(1, expected_count)
    calibration_summary = field_calibration.segment_summary(player_tracks, primary_player) if field_calibration else None
    summary = {
        "segmentId": segment["id"],
        "frameCount": expected_count,
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
        "diagnostics": segment_diagnostics(
            segment,
            frames,
            track_summaries,
            player_tracks,
            ball_tracks,
            best_frame,
            distances,
            expected_count,
            track_coverage,
            calibration_summary,
        ),
    }
    if calibration_summary:
        summary["fieldCalibration"] = calibration_summary
    return summary


def segment_diagnostics(
    segment: dict,
    frames: list[dict],
    track_summaries: list[dict],
    player_tracks: list[dict],
    ball_tracks: list[dict],
    best_frame: dict | None,
    distances: list[float],
    expected_count: int,
    track_coverage: float,
    calibration_summary: dict | None,
) -> dict:
    boxes = [box for frame in frames for box in frame.get("boxes", [])]
    boxes_by_label = Counter(str(box.get("label") or "unknown") for box in boxes)
    confidence_by_label: defaultdict[str, list[float]] = defaultdict(list)
    boxes_without_track = 0
    jersey_box_count = 0
    jersey_candidate_count = 0
    face_box_count = 0
    face_candidate_count = 0
    for box in boxes:
        label = str(box.get("label") or "unknown")
        confidence_by_label[label].append(float(box.get("confidence") or 0))
        if not box.get("trackId"):
            boxes_without_track += 1
        jersey_candidates = box.get("jerseyNumberCandidates") or []
        if jersey_candidates:
            jersey_box_count += 1
            jersey_candidate_count += len(jersey_candidates)
        face_candidates = box.get("faceIdentityCandidates") or []
        if face_candidates:
            face_box_count += 1
            face_candidate_count += len(face_candidates)

    team_clusters = Counter(str(track.get("teamCluster") or "unassigned") for track in player_tracks)
    movement_modes = Counter(str((track.get("movement") or {}).get("coordinateMode") or "missing") for track in player_tracks)
    field_zones = Counter(str((track.get("movement") or {}).get("fieldZoneHint") or "unknown") for track in player_tracks)
    width_lanes = Counter(str((track.get("movement") or {}).get("widthLaneHint") or "unknown") for track in player_tracks)
    frame_times = [float(frame.get("at")) for frame in frames if frame.get("at") is not None]
    best_boxes = (best_frame or {}).get("boxes", [])
    return {
        "schema": "tracking_segment_diagnostics_v1",
        "segmentId": segment["id"],
        "segmentStart": round(float(segment["start"]), 3),
        "segmentEnd": round(float(segment["end"]), 3),
        "segmentDurationSeconds": round(max(0.0, float(segment["end"]) - float(segment["start"])), 3),
        "expectedFrameCount": expected_count,
        "expectedFrameCountAssumptionFps": 30,
        "trackedFrameCount": len(frames),
        "trackCoverage": round(min(1.0, track_coverage), 3),
        "firstTrackedFrameAt": round(min(frame_times), 3) if frame_times else None,
        "lastTrackedFrameAt": round(max(frame_times), 3) if frame_times else None,
        "firstFrameIndex": min([int(frame.get("frameIndex")) for frame in frames if frame.get("frameIndex") is not None], default=None),
        "lastFrameIndex": max([int(frame.get("frameIndex")) for frame in frames if frame.get("frameIndex") is not None], default=None),
        "bestFrameAt": (best_frame or {}).get("at"),
        "bestFrameBoxCount": len(best_boxes),
        "frameTrace": [
            {
                "frameIndex": frame.get("frameIndex"),
                "sourceFrameNumber": frame.get("sourceFrameNumber"),
                "frameAt": frame.get("at"),
                "boxCount": len(frame.get("boxes", [])),
                "boxesByLabel": compact_counter(Counter(str(box.get("label") or "unknown") for box in frame.get("boxes", []))),
                "trackIds": [box.get("trackId") for box in frame.get("boxes", []) if box.get("trackId")][:12],
            }
            for frame in frames[:80]
        ],
        "frameTraceOverflow": max(0, len(frames) - 80),
        "frameBoxCount": numeric_summary([len(frame.get("boxes", [])) for frame in frames]),
        "framesWithPlayers": sum(1 for frame in frames if any(box.get("label") == "person" for box in frame.get("boxes", []))),
        "framesWithBall": sum(1 for frame in frames if any(box.get("label") == "sports_ball" for box in frame.get("boxes", []))),
        "boxCount": len(boxes),
        "boxesByLabel": compact_counter(boxes_by_label),
        "boxesWithoutTrackId": boxes_without_track,
        "boxConfidence": {label: numeric_summary(values) for label, values in sorted(confidence_by_label.items())},
        "trackCount": len(track_summaries),
        "playerTrackCount": len(player_tracks),
        "ballTrackCount": len(ball_tracks),
        "trackFrameCount": numeric_summary([int(track.get("frames") or 0) for track in track_summaries]),
        "trackConfidence": numeric_summary([float(track.get("confidence") or 0) for track in track_summaries]),
        "topTrackIds": [track.get("id") for track in track_summaries[:16] if track.get("id")],
        "candidateEvidence": {
            "jerseyBoxCount": jersey_box_count,
            "jerseyCandidateCount": jersey_candidate_count,
            "faceBoxCount": face_box_count,
            "faceCandidateCount": face_candidate_count,
        },
        "teamClusters": compact_counter(team_clusters),
        "movementCoordinateModes": compact_counter(movement_modes),
        "fieldZoneHints": compact_counter(field_zones),
        "widthLaneHints": compact_counter(width_lanes),
        "proximitySampleCount": len(distances),
        "proximityDistance": numeric_summary(distances),
        "fieldCalibrationStatus": (calibration_summary or {}).get("status") or "not_configured",
    }


def tracker_diagnostics(
    args: argparse.Namespace,
    media_info: dict,
    segment_items: list[dict],
    segment_frames: dict[str, list[dict]],
    all_summaries: list[dict],
    emitted_summaries: list[dict],
    processed_frame_count: int,
    outside_segment_frame_count: int,
    boxless_segment_frame_count: int,
    jersey_ocr,
    face_identity,
    field_calibration,
    cv2,
    metadata: dict,
    run_id: str,
    started_at: str,
    duration_ms: float,
    frame_audit: list[dict],
    frame_audit_overflow: int,
) -> dict:
    all_boxes = [box for frames in segment_frames.values() for frame in frames for box in frame.get("boxes", [])]
    boxes_by_label = Counter(str(box.get("label") or "unknown") for box in all_boxes)
    emitted_ids = {summary["segmentId"] for summary in emitted_summaries}
    empty_segments = [segment["id"] for segment in segment_items if segment["id"] not in emitted_ids]
    player_tracks = [track for summary in emitted_summaries for track in summary.get("playerTracks", [])]
    ball_tracks = [track for summary in emitted_summaries for track in summary.get("ballTracks", [])]
    team_clusters = Counter(str(track.get("teamCluster") or "unassigned") for track in player_tracks)
    movement_modes = Counter(str((track.get("movement") or {}).get("coordinateMode") or "missing") for track in player_tracks)
    field_zones = Counter(str((track.get("movement") or {}).get("fieldZoneHint") or "unknown") for track in player_tracks)
    width_lanes = Counter(str((track.get("movement") or {}).get("widthLaneHint") or "unknown") for track in player_tracks)
    return {
        "schema": "tracking_diagnostics_v1",
        "status": "available",
        "provenance": provenance_metadata(metadata, run_id, started_at, duration_ms),
        "media": media_info,
        "config": {
            "model": args.model,
            "tracker": args.tracker,
            "confidenceThreshold": round(float(args.conf), 4),
            "vidStride": max(1, int(args.vid_stride)),
            "segmentCount": len(segment_items),
            "jerseyOcrEnabled": parse_bool(args.jersey_ocr),
            "faceIdentityEnabled": parse_bool(args.face_identity),
            "fieldCalibrationConfigured": bool(str(args.field_calibration or "").strip()),
            "diagnosticsFrameLimit": max(0, int(args.diagnostics_frame_limit)),
            "diagnosticsDecisionLimit": max(0, int(args.diagnostics_decision_limit)),
        },
        "runtime": {
            "processedFrameCount": processed_frame_count,
            "segmentMatchedFrameCount": sum(len(frames) for frames in segment_frames.values()),
            "outsideSegmentFrameCount": outside_segment_frame_count,
            "boxlessSegmentFrameCount": boxless_segment_frame_count,
            "emittedSegmentCount": len(emitted_summaries),
            "emptySegmentCount": len(empty_segments),
            "emptySegmentIds": empty_segments[:32],
        },
        "frameAudit": {
            "limit": max(0, int(args.diagnostics_frame_limit)),
            "items": frame_audit,
            "overflowCount": frame_audit_overflow,
        },
        "segments": {
            "inputCount": len(segment_items),
            "inputDurationSeconds": round(sum(max(0.0, float(item["end"]) - float(item["start"])) for item in segment_items), 3),
            "emittedIds": [summary["segmentId"] for summary in emitted_summaries[:64]],
            "trackCoverage": numeric_summary([float(summary.get("trackCoverage") or 0) for summary in all_summaries]),
            "trackedFrameCount": numeric_summary([int(summary.get("trackedFrameCount") or 0) for summary in all_summaries]),
            "expectedFrameCount": numeric_summary([int(summary.get("frameCount") or 0) for summary in all_summaries]),
        },
        "boxes": {
            "total": len(all_boxes),
            "byLabel": compact_counter(boxes_by_label),
            "withoutTrackId": sum(1 for box in all_boxes if not box.get("trackId")),
            "confidence": numeric_summary([float(box.get("confidence") or 0) for box in all_boxes]),
        },
        "tracks": {
            "playerTrackCount": len(player_tracks),
            "ballTrackCount": len(ball_tracks),
            "idSwitches": sum(int(summary.get("idSwitches") or 0) for summary in emitted_summaries),
            "playerFrameCount": numeric_summary([int(track.get("frames") or 0) for track in player_tracks]),
            "ballFrameCount": numeric_summary([int(track.get("frames") or 0) for track in ball_tracks]),
            "teamClusters": compact_counter(team_clusters),
            "movementCoordinateModes": compact_counter(movement_modes),
            "fieldZoneHints": compact_counter(field_zones),
            "widthLaneHints": compact_counter(width_lanes),
            "tracksWithJerseyCandidates": sum(1 for track in player_tracks if track.get("jerseyNumberCandidates")),
            "tracksWithFaceCandidates": sum(1 for track in player_tracks if track.get("faceIdentityCandidates")),
        },
        "jerseyOcr": jersey_ocr.diagnostics(),
        "faceIdentity": face_identity.diagnostics(),
        "fieldCalibration": field_calibration_diagnostics(args.field_calibration, field_calibration),
        "fingerprints": tracker_fingerprints(args),
        "dependencies": dependency_versions(cv2),
    }


def numeric_summary(values: list) -> dict:
    usable = [float(value) for value in values if value is not None]
    if not usable:
        return {"count": 0, "min": None, "max": None, "mean": None, "median": None}
    return {
        "count": len(usable),
        "min": round(min(usable), 4),
        "max": round(max(usable), 4),
        "mean": round(sum(usable) / len(usable), 4),
        "median": round(float(median(usable)), 4),
    }


def compact_counter(counter: Counter) -> dict:
    return {str(key): int(value) for key, value in counter.items() if value}


def dependency_versions(cv2) -> dict:
    versions = {
        "python": sys.version.split()[0],
        "opencv": getattr(cv2, "__version__", None),
    }
    try:
        from importlib import metadata as importlib_metadata

        for package in ["ultralytics", "numpy", "paddleocr", "onnxruntime"]:
            try:
                versions[package] = importlib_metadata.version(package)
            except Exception:
                versions[package] = None
    except Exception:
        pass
    return versions


def field_calibration_diagnostics(path_value: str | None, field_calibration) -> dict:
    path_value = str(path_value or "").strip()
    if field_calibration:
        return field_calibration.diagnostics()
    return {
        "configured": bool(path_value),
        "status": "unavailable" if path_value else "not_configured",
        "method": None,
        "sourceFile": os.path.basename(path_value) if path_value else None,
        "pathExists": os.path.exists(path_value) if path_value else False,
        "homographyLoaded": False,
        "teamAttackingDirectionCount": 0,
    }


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def elapsed_ms(started_perf: float) -> float:
    return round((time.perf_counter() - started_perf) * 1000, 3)


def provenance_metadata(metadata: dict, run_id: str, started_at: str, duration_ms: float | None) -> dict:
    ended_at = utc_now_iso()
    return {
        "runId": run_id,
        "assetId": safe_metadata_value(metadata.get("assetId")),
        "jobId": safe_metadata_value(metadata.get("jobId")),
        "stage": safe_metadata_value(metadata.get("stage") or "vision-tracking"),
        "attempt": safe_metadata_value(metadata.get("attempt")),
        "requestedBy": safe_metadata_value(metadata.get("requestedBy")),
        "startedAt": started_at,
        "endedAt": ended_at,
        "durationMs": duration_ms,
        "host": os.uname().nodename if hasattr(os, "uname") else None,
        "pid": os.getpid(),
    }


def safe_metadata_value(value):
    if value is None:
        return None
    text = str(value).strip()
    return text[:160] if text else None


def tracker_fingerprints(args: argparse.Namespace) -> dict:
    return {
        "detectorModel": file_fingerprint(args.model, include_sha256=True),
        "trackerConfig": file_fingerprint(args.tracker, include_sha256=True),
        "faceIdentityModel": file_fingerprint(args.face_identity_model, include_sha256=True),
        "faceIdentityGallery": file_fingerprint(args.face_identity_gallery, include_sha256=True),
        "fieldCalibration": file_fingerprint(args.field_calibration, include_sha256=True),
    }


def file_fingerprint(path_value: str | None, include_sha256: bool = False) -> dict:
    path_value = str(path_value or "").strip()
    exists = bool(path_value) and os.path.exists(path_value)
    result = {
        "configured": bool(path_value),
        "sourceFile": os.path.basename(path_value) if path_value else None,
        "pathExists": exists,
        "sizeBytes": os.path.getsize(path_value) if exists else None,
        "mtime": round(os.path.getmtime(path_value), 3) if exists else None,
    }
    if exists:
        result["contentFingerprint"] = file_content_fingerprint(path_value)
    if include_sha256 and exists and os.path.isfile(path_value):
        result["sha256"] = file_sha256(path_value)
    return result


def file_content_fingerprint(path_value: str, sample_size: int = 1024 * 1024) -> dict:
    try:
        size = os.path.getsize(path_value)
        digest = hashlib.sha256()
        with open(path_value, "rb") as handle:
            head = handle.read(sample_size)
            digest.update(head)
            tail_size = 0
            if size > sample_size:
                handle.seek(max(0, size - sample_size))
                tail = handle.read(sample_size)
                digest.update(tail)
                tail_size = len(tail)
        return {
            "algorithm": "sha256_head_tail",
            "sampleBytes": len(head) + tail_size,
            "sha256": digest.hexdigest(),
        }
    except Exception:
        return {"algorithm": "sha256_head_tail", "sampleBytes": 0, "sha256": None}


def file_sha256(path_value: str) -> str | None:
    try:
        digest = hashlib.sha256()
        with open(path_value, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except Exception:
        return None


def empty_track_map():
    return defaultdict(lambda: {"label": "", "frames": 0, "confidence": [], "centers": [], "appearances": [], "jerseyNumbers": [], "faceIdentities": [], "firstSeen": None, "lastSeen": None})


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
    if box.get("jerseyNumberCandidates"):
        item["jerseyNumbers"].extend(box["jerseyNumberCandidates"])
    if box.get("faceIdentityCandidates"):
        item["faceIdentities"].extend(box["faceIdentityCandidates"])
    item["firstSeen"] = at if item["firstSeen"] is None else min(item["firstSeen"], at)
    item["lastSeen"] = at if item["lastSeen"] is None else max(item["lastSeen"], at)


def summarize_tracks(tracks: dict, team_assignments: dict[str, dict] | None = None, field_calibration=None) -> list[dict]:
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
        movement = movement_profile_for_track(track, field_calibration)
        if movement:
            summary["movement"] = movement
        jersey_candidates = aggregate_jersey_number_candidates(track["jerseyNumbers"])
        if jersey_candidates:
            summary["jerseyNumberCandidates"] = jersey_candidates
        face_candidates = aggregate_face_identity_candidates(track["faceIdentities"])
        if face_candidates:
            summary["faceIdentityCandidates"] = face_candidates
        assignment = team_assignments.get(track_id)
        if assignment:
            summary.update(assignment)
        summaries.append(summary)
    return sorted(summaries, key=lambda item: (item["frames"], item["confidence"]), reverse=True)


class JerseyNumberOcr:
    def __init__(self, args: argparse.Namespace):
        self.enabled = parse_bool(args.jersey_ocr)
        self.lang = args.jersey_ocr_lang
        self.min_confidence = max(0.0, min(1.0, float(args.jersey_ocr_min_confidence)))
        self.max_samples_per_track = max(0, int(args.jersey_ocr_max_samples_per_track))
        self.max_total_samples = max(0, int(args.jersey_ocr_max_total_samples))
        self.min_box_height = max(0.0, float(args.jersey_ocr_min_box_height))
        self.decision_limit = max(0, int(args.diagnostics_decision_limit))
        self.sample_counts: defaultdict[str, int] = defaultdict(int)
        self.total_samples = 0
        self.boxes_seen = 0
        self.boxes_eligible = 0
        self.crop_batches = 0
        self.crop_count = 0
        self.ocr_crop_calls = 0
        self.tokens_seen = 0
        self.candidate_count = 0
        self.skip_reasons: Counter[str] = Counter()
        self.decision_audit: list[dict] = []
        self.decision_audit_overflow = 0
        self._ocr = None
        self._available = None

    def candidates_for_box(self, image, x1: float, y1: float, x2: float, y2: float, label: str, track_id: str | None, at: float | None, audit_context: dict | None = None) -> list[dict]:
        if label != "person":
            self.skip_reasons["non_person"] += 1
            return []
        self.boxes_seen += 1
        if not self.enabled:
            self.skip_reasons["disabled"] += 1
            self.record_decision(audit_context, "skipped", "disabled")
            return []
        if not track_id:
            self.skip_reasons["missing_track_id"] += 1
            self.record_decision(audit_context, "skipped", "missing_track_id")
            return []
        if image is None:
            self.skip_reasons["missing_image"] += 1
            self.record_decision(audit_context, "skipped", "missing_image")
            return []
        if self.max_samples_per_track <= 0 or self.max_total_samples <= 0:
            self.skip_reasons["sample_budget_disabled"] += 1
            self.record_decision(audit_context, "skipped", "sample_budget_disabled")
            return []
        if self.sample_counts[track_id] >= self.max_samples_per_track or self.total_samples >= self.max_total_samples:
            self.skip_reasons["sample_budget_exhausted"] += 1
            self.record_decision(audit_context, "skipped", "sample_budget_exhausted")
            return []
        height, _width = image.shape[:2]
        if height <= 0 or (y2 - y1) / height < self.min_box_height:
            self.skip_reasons["box_too_small"] += 1
            self.record_decision(audit_context, "skipped", "box_too_small")
            return []
        self.boxes_eligible += 1
        crops = jersey_number_crop_items(image, x1, y1, x2, y2)
        remaining = self.max_total_samples - self.total_samples
        crops = crops[:remaining]
        if not crops:
            self.skip_reasons["empty_crop"] += 1
            self.record_decision(audit_context, "skipped", "empty_crop")
            return []
        ocr = self.ocr()
        if ocr is None:
            self.skip_reasons["ocr_unavailable"] += 1
            self.record_decision(audit_context, "skipped", "ocr_unavailable", {"cropCount": len(crops)})
            return []
        self.sample_counts[track_id] += 1
        self.total_samples += len(crops)
        self.crop_batches += 1
        self.crop_count += len(crops)
        self.ocr_crop_calls += len(crops)
        tokens = []
        for index, crop_item in enumerate(crops):
            crop_tokens = run_jersey_crop_ocr(ocr, crop_item["image"])
            for token in crop_tokens:
                token["cropIndex"] = index
                token["window"] = crop_item["window"]
                token["preprocess"] = crop_item["preprocess"]
            tokens.extend(crop_tokens)
        self.tokens_seen += len(tokens)
        candidates = jersey_candidates_from_tokens(tokens, self.min_confidence, at)
        self.candidate_count += len(candidates)
        token_decisions = jersey_token_decisions(tokens, self.min_confidence)
        if not candidates:
            self.skip_reasons["no_candidate_after_threshold"] += 1
            self.record_decision(
                audit_context,
                "rejected",
                "no_candidate_after_threshold",
                {"cropCount": len(crops), "tokens": token_decisions[:12], "acceptedCandidates": []},
            )
        else:
            self.record_decision(
                audit_context,
                "accepted",
                None,
                {"cropCount": len(crops), "tokens": token_decisions[:12], "acceptedCandidates": candidates},
            )
        return candidates

    def ocr(self):
        if self._available is False:
            return None
        if self._ocr is not None:
            return self._ocr
        try:
            from paddleocr import PaddleOCR

            try:
                self._ocr = PaddleOCR(use_angle_cls=True, lang=self.lang)
            except Exception:
                self._ocr = PaddleOCR(lang=self.lang)
            self._available = True
            return self._ocr
        except Exception:
            self._available = False
            return None

    def record_decision(self, context: dict | None, status: str, reason: str | None, extra: dict | None = None) -> None:
        if len(self.decision_audit) >= self.decision_limit:
            self.decision_audit_overflow += 1
            return
        item = {
            **(context or {}),
            "status": status,
            "reason": reason,
        }
        if extra:
            item.update(extra)
        self.decision_audit.append(item)

    def diagnostics(self) -> dict:
        sampled_tracks = len([track_id for track_id, count in self.sample_counts.items() if count > 0])
        return {
            "enabled": self.enabled,
            "available": self._available is True,
            "availabilityState": "available" if self._available is True else "unavailable" if self._available is False else "not_checked",
            "language": self.lang,
            "minConfidence": self.min_confidence,
            "minBoxHeight": self.min_box_height,
            "maxSamplesPerTrack": self.max_samples_per_track,
            "maxTotalSamples": self.max_total_samples,
            "personBoxesSeen": self.boxes_seen,
            "eligibleBoxes": self.boxes_eligible,
            "sampledTrackCount": sampled_tracks,
            "sampledBoxesByTrack": dict(sorted(self.sample_counts.items())[:32]),
            "cropBatchCount": self.crop_batches,
            "cropSampleCount": self.crop_count,
            "ocrCropCallCount": self.ocr_crop_calls,
            "ocrTokenCount": self.tokens_seen,
            "candidateCount": self.candidate_count,
            "skipReasons": compact_counter(self.skip_reasons),
            "decisionAudit": {
                "limit": self.decision_limit,
                "items": self.decision_audit,
                "overflowCount": self.decision_audit_overflow,
            },
        }


class FaceEmbeddingModel:
    def __init__(self, model_path: str):
        self.model_path = str(model_path or "").strip()
        self._session = None
        self._input_name = None
        self._input_shape = None
        self._available = None

    def available(self) -> bool:
        return bool(self.model_path) and os.path.exists(self.model_path) and self.session() is not None

    def session(self):
        if self._available is False:
            return None
        if self._session is not None:
            return self._session
        if not self.model_path or not os.path.exists(self.model_path):
            self._available = False
            return None
        try:
            import onnxruntime as ort

            self._session = ort.InferenceSession(self.model_path, providers=["CPUExecutionProvider"])
            model_input = self._session.get_inputs()[0]
            self._input_name = model_input.name
            self._input_shape = list(model_input.shape or [])
            self._available = True
            return self._session
        except Exception:
            self._available = False
            return None

    def embed(self, image) -> list[float] | None:
        session = self.session()
        if session is None or image is None or image.size == 0:
            return None
        try:
            import cv2
            import numpy as np

            shape = self._input_shape or [1, 3, 112, 112]
            channel_first = len(shape) == 4 and (shape[1] == 3 or shape[1] in {"3", None})
            height = int(shape[2] if channel_first and isinstance(shape[2], int) else shape[1] if len(shape) == 4 and isinstance(shape[1], int) else 112)
            width = int(shape[3] if channel_first and isinstance(shape[3], int) else shape[2] if len(shape) == 4 and isinstance(shape[2], int) else 112)
            rgb = cv2.cvtColor(cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
            tensor = rgb.astype("float32")
            tensor = (tensor - 127.5) / 128.0
            if channel_first:
                tensor = np.transpose(tensor, (2, 0, 1))
            tensor = np.expand_dims(tensor, axis=0)
            output = session.run(None, {self._input_name: tensor})[0]
            return normalize_vector(output.reshape(-1).astype("float32").tolist())
        except Exception:
            return None

    def diagnostics(self) -> dict:
        fingerprint = file_fingerprint(self.model_path, include_sha256=True)
        return {
            "configured": bool(self.model_path),
            "sourceFile": os.path.basename(self.model_path) if self.model_path else None,
            "pathExists": os.path.exists(self.model_path) if self.model_path else False,
            "fingerprint": fingerprint,
            "availabilityState": "available" if self._available is True else "unavailable" if self._available is False else "not_checked",
            "inputShape": self._input_shape,
        }


class FaceIdentityMatcher:
    def __init__(self, args: argparse.Namespace):
        self.enabled = parse_bool(args.face_identity)
        self.min_confidence = max(0.0, min(1.0, float(args.face_identity_min_confidence)))
        self.max_samples_per_track = max(0, int(args.face_identity_max_samples_per_track))
        self.max_total_samples = max(0, int(args.face_identity_max_total_samples))
        self.decision_limit = max(0, int(args.diagnostics_decision_limit))
        self.sample_counts: defaultdict[str, int] = defaultdict(int)
        self.total_samples = 0
        self.boxes_seen = 0
        self.boxes_eligible = 0
        self.face_crop_attempts = 0
        self.face_crop_count = 0
        self.embedding_attempts = 0
        self.embedding_count = 0
        self.candidate_count = 0
        self.skip_reasons: Counter[str] = Counter()
        self.decision_audit: list[dict] = []
        self.decision_audit_overflow = 0
        self.gallery_path = args.face_identity_gallery
        self.model = FaceEmbeddingModel(args.face_identity_model)
        self.gallery = load_face_gallery(args.face_identity_gallery)

    def candidates_for_box(self, image, x1: float, y1: float, x2: float, y2: float, label: str, track_id: str | None, at: float | None, audit_context: dict | None = None) -> list[dict]:
        if label != "person":
            self.skip_reasons["non_person"] += 1
            return []
        self.boxes_seen += 1
        if not self.enabled:
            self.skip_reasons["disabled"] += 1
            self.record_decision(audit_context, "skipped", "disabled")
            return []
        if not track_id:
            self.skip_reasons["missing_track_id"] += 1
            self.record_decision(audit_context, "skipped", "missing_track_id")
            return []
        if image is None:
            self.skip_reasons["missing_image"] += 1
            self.record_decision(audit_context, "skipped", "missing_image")
            return []
        if self.max_samples_per_track <= 0 or self.max_total_samples <= 0:
            self.skip_reasons["sample_budget_disabled"] += 1
            self.record_decision(audit_context, "skipped", "sample_budget_disabled")
            return []
        if self.sample_counts[track_id] >= self.max_samples_per_track or self.total_samples >= self.max_total_samples:
            self.skip_reasons["sample_budget_exhausted"] += 1
            self.record_decision(audit_context, "skipped", "sample_budget_exhausted")
            return []
        if not self.gallery or not self.model.available():
            self.skip_reasons["gallery_or_model_unavailable"] += 1
            self.record_decision(audit_context, "skipped", "gallery_or_model_unavailable")
            return []
        self.boxes_eligible += 1
        self.face_crop_attempts += 1
        face_crop = crop_face_candidate(image, x1, y1, x2, y2)
        if face_crop is None:
            self.skip_reasons["face_not_detected"] += 1
            self.record_decision(audit_context, "skipped", "face_not_detected")
            return []
        self.face_crop_count += 1
        self.sample_counts[track_id] += 1
        self.total_samples += 1
        self.embedding_attempts += 1
        embedding = self.model.embed(face_crop)
        if not embedding:
            self.skip_reasons["embedding_failed"] += 1
            self.record_decision(audit_context, "skipped", "embedding_failed")
            return []
        self.embedding_count += 1
        match_decisions = face_match_decisions(embedding, self.gallery, self.min_confidence)
        candidates = face_candidates_from_decisions(match_decisions, at)
        self.candidate_count += len(candidates)
        if not candidates:
            self.skip_reasons["no_candidate_after_threshold"] += 1
            self.record_decision(
                audit_context,
                "rejected",
                "no_candidate_after_threshold",
                {"topMatches": match_decisions[:8], "acceptedCandidates": []},
            )
        else:
            self.record_decision(
                audit_context,
                "accepted",
                None,
                {"topMatches": match_decisions[:8], "acceptedCandidates": candidates},
            )
        return candidates

    def record_decision(self, context: dict | None, status: str, reason: str | None, extra: dict | None = None) -> None:
        if len(self.decision_audit) >= self.decision_limit:
            self.decision_audit_overflow += 1
            return
        item = {
            **(context or {}),
            "status": status,
            "reason": reason,
        }
        if extra:
            item.update(extra)
        self.decision_audit.append(item)

    def diagnostics(self) -> dict:
        sampled_tracks = len([track_id for track_id, count in self.sample_counts.items() if count > 0])
        gallery_embeddings = sum(len(player.get("embeddings") or []) for player in self.gallery)
        gallery_teams = Counter(str(player.get("team") or "unknown") for player in self.gallery)
        return {
            "enabled": self.enabled,
            "minConfidence": self.min_confidence,
            "maxSamplesPerTrack": self.max_samples_per_track,
            "maxTotalSamples": self.max_total_samples,
            "personBoxesSeen": self.boxes_seen,
            "eligibleBoxes": self.boxes_eligible,
            "sampledTrackCount": sampled_tracks,
            "sampledBoxesByTrack": dict(sorted(self.sample_counts.items())[:32]),
            "faceCropAttemptCount": self.face_crop_attempts,
            "faceCropCount": self.face_crop_count,
            "embeddingAttemptCount": self.embedding_attempts,
            "embeddingCount": self.embedding_count,
            "candidateCount": self.candidate_count,
            "galleryPlayerCount": len(self.gallery),
            "galleryEmbeddingCount": gallery_embeddings,
            "galleryTeams": compact_counter(gallery_teams),
            "galleryFingerprint": file_fingerprint(self.gallery_path, include_sha256=True),
            "model": self.model.diagnostics(),
            "skipReasons": compact_counter(self.skip_reasons),
            "decisionAudit": {
                "limit": self.decision_limit,
                "items": self.decision_audit,
                "overflowCount": self.decision_audit_overflow,
            },
        }


class FieldCalibration:
    def __init__(self, payload: dict, source_path: str):
        self.payload = payload
        self.source_path = source_path
        self.homography = payload.get("homography")
        self.attacking_direction = valid_attacking_direction(payload.get("attackingDirection"))
        self.attacking_direction_confidence = clamp01(float(payload.get("attackingDirectionConfidence") or 0))
        self.team_attacking_directions = normalize_team_attacking_directions(payload.get("teamAttackingDirections"))

    @classmethod
    def from_path(cls, path_value: str | None):
        path_value = str(path_value or "").strip()
        if not path_value:
            return None
        try:
            with open(path_value, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if not isinstance(payload, dict) or not valid_homography(payload.get("homography")):
                return None
            return cls(payload, path_value)
        except Exception:
            return None

    def project(self, point: tuple[float, float]) -> tuple[float, float] | None:
        if not valid_homography(self.homography):
            return None
        x_value, y_value = point
        matrix = self.homography
        denom = float(matrix[2][0]) * x_value + float(matrix[2][1]) * y_value + float(matrix[2][2])
        if abs(denom) < 1e-9:
            return None
        px = (float(matrix[0][0]) * x_value + float(matrix[0][1]) * y_value + float(matrix[0][2])) / denom
        py = (float(matrix[1][0]) * x_value + float(matrix[1][1]) * y_value + float(matrix[1][2])) / denom
        return (clamp01(px), clamp01(py))

    def segment_summary(self, player_tracks: list[dict], primary_player: str | None) -> dict | None:
        if not valid_homography(self.homography):
            return None
        primary = next((track for track in player_tracks if track.get("id") == primary_player), None) or top_track(player_tracks)
        movement = (primary or {}).get("movement") or {}
        zone = movement.get("fieldZoneHint") or "unknown"
        zone_confidence = float(movement.get("fieldZoneConfidence") or 0)
        return {
            "status": "calibrated",
            "method": "homography",
            "zone": zone,
            "zoneConfidence": round(clamp01(zone_confidence), 3),
            "attackingDirection": self.attacking_direction,
            "attackingDirectionConfidence": self.attacking_direction_confidence,
            "teamAttackingDirections": self.team_attacking_directions,
            "evidence": [
                f"Pitch homography loaded from {os.path.basename(self.source_path)}.",
                "Track centers projected into normalized pitch coordinates.",
                "Team attacking directions loaded from calibration config." if self.team_attacking_directions else "Team attacking direction config not provided.",
            ],
            "limitations": [
                "Homography quality depends on the external calibration points.",
                "Team attacking direction is config-driven unless a possession-aware calibration stage provides it.",
            ],
        }

    def diagnostics(self) -> dict:
        calibration_points = self.payload.get("points") or self.payload.get("calibrationPoints") or self.payload.get("correspondences") or []
        reprojection_error = self.payload.get("reprojectionError") or self.payload.get("meanReprojectionError")
        return {
            "configured": True,
            "status": "calibrated" if valid_homography(self.homography) else "unavailable",
            "method": "homography" if valid_homography(self.homography) else None,
            "sourceFile": os.path.basename(self.source_path),
            "pathExists": os.path.exists(self.source_path),
            "homographyLoaded": valid_homography(self.homography),
            "schemaVersion": self.payload.get("schemaVersion") or self.payload.get("version"),
            "calibrationPointCount": len(calibration_points) if isinstance(calibration_points, list) else None,
            "reprojectionError": round(float(reprojection_error), 4) if is_number(reprojection_error) else None,
            "pitchCoordinateConvention": self.payload.get("pitchCoordinateConvention") or "normalized_0_1",
            "sourceMedia": self.payload.get("sourceMedia") or self.payload.get("sourceFile"),
            "attackingDirection": self.attacking_direction,
            "attackingDirectionConfidence": self.attacking_direction_confidence,
            "teamAttackingDirectionCount": len(self.team_attacking_directions),
            "teamsWithDirection": [item.get("team") for item in self.team_attacking_directions if item.get("team")][:16],
        }


def load_face_gallery(path_value: str | None) -> list[dict]:
    path_value = str(path_value or "").strip()
    if not path_value:
        return []
    try:
        with open(path_value, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return []
    players = payload.get("players") if isinstance(payload, dict) else payload
    if not isinstance(players, list):
        return []
    gallery = []
    for player in players:
        if not isinstance(player, dict):
            continue
        raw_embeddings = player.get("embeddings") or ([player.get("embedding")] if player.get("embedding") is not None else [])
        embeddings = [normalize_vector(vector) for vector in raw_embeddings if isinstance(vector, list)]
        embeddings = [vector for vector in embeddings if vector]
        if not embeddings:
            continue
        gallery.append({
            "playerId": player.get("playerId"),
            "canonicalName": player.get("canonicalName") or player.get("name"),
            "team": player.get("team"),
            "embeddings": embeddings,
        })
    return gallery


def crop_face_candidate(image, x1: float, y1: float, x2: float, y2: float):
    import cv2

    height, width = image.shape[:2]
    left = clamp_int(x1, 0, width - 1)
    right = clamp_int(x2, left + 1, width)
    top = clamp_int(y1, 0, height - 1)
    bottom = clamp_int(y1 + (y2 - y1) * 0.48, top + 1, height)
    region = image[top:bottom, left:right]
    if region.size == 0 or region.shape[0] < 16 or region.shape[1] < 16:
        return None
    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    classifier = cv2.CascadeClassifier(cascade_path)
    if classifier.empty():
        return None
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    faces = classifier.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3, minSize=(12, 12))
    if len(faces) == 0:
        return None
    fx, fy, fw, fh = sorted(faces, key=lambda item: item[2] * item[3], reverse=True)[0]
    pad = int(max(fw, fh) * 0.22)
    crop_left = max(0, fx - pad)
    crop_top = max(0, fy - pad)
    crop_right = min(region.shape[1], fx + fw + pad)
    crop_bottom = min(region.shape[0], fy + fh + pad)
    crop = region[crop_top:crop_bottom, crop_left:crop_right]
    return crop if crop.size > 0 else None


def face_candidates_from_embedding(embedding: list[float], gallery: list[dict], min_confidence: float, at: float | None) -> list[dict]:
    return face_candidates_from_decisions(face_match_decisions(embedding, gallery, min_confidence), at)


def face_match_decisions(embedding: list[float], gallery: list[dict], min_confidence: float) -> list[dict]:
    decisions = []
    for player in gallery:
        scores = [cosine_similarity(embedding, gallery_embedding) for gallery_embedding in player["embeddings"]]
        if not scores:
            continue
        score = max(scores)
        decisions.append({
            "playerId": player.get("playerId"),
            "canonicalName": player.get("canonicalName"),
            "team": player.get("team"),
            "score": round(clamp01(score), 3),
            "threshold": round(min_confidence, 3),
            "accepted": score >= min_confidence,
            "rejectionReason": None if score >= min_confidence else "below_threshold",
            "galleryEmbeddingCount": len(player["embeddings"]),
        })
    return sorted(decisions, key=lambda item: item["score"], reverse=True)


def face_candidates_from_decisions(decisions: list[dict], at: float | None) -> list[dict]:
    candidates = []
    for decision in decisions:
        if not decision.get("accepted"):
            continue
        candidates.append({
            "playerId": decision.get("playerId"),
            "canonicalName": decision.get("canonicalName"),
            "confidence": round(clamp01(float(decision.get("score") or 0)), 3),
            "source": "face_embedding",
            "frameAt": round(at, 3) if at is not None else None,
            "evidence": f"Matched {int(decision.get('galleryEmbeddingCount') or 0)} gallery embedding(s)",
        })
    return sorted(candidates, key=lambda item: item["confidence"], reverse=True)[:3]


def aggregate_face_identity_candidates(candidates: list[dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for candidate in candidates:
        key = str(candidate.get("playerId") or candidate.get("canonicalName") or "").strip()
        if key:
            grouped[key].append(candidate)
    summaries = []
    for items in grouped.values():
        best = sorted(items, key=lambda item: float(item.get("confidence") or 0.0), reverse=True)[0]
        confidence = min(0.98, max(float(item.get("confidence") or 0.0) for item in items) + min(0.04, (len(items) - 1) * 0.015))
        summaries.append({
            "playerId": best.get("playerId"),
            "canonicalName": best.get("canonicalName"),
            "confidence": round(confidence, 3),
            "source": "face_embedding",
            "frameAt": best.get("frameAt"),
            "evidence": f"{len(items)} face sample(s); {best.get('evidence') or 'gallery match'}",
        })
    return sorted(summaries, key=lambda item: item["confidence"], reverse=True)[:3]


def jersey_number_crop(image, x1: float, y1: float, x2: float, y2: float):
    crops = jersey_number_crops(image, x1, y1, x2, y2)
    return crops[0] if crops else None


def jersey_number_crops(image, x1: float, y1: float, x2: float, y2: float) -> list:
    return [item["image"] for item in jersey_number_crop_items(image, x1, y1, x2, y2)]


def jersey_number_crop_items(image, x1: float, y1: float, x2: float, y2: float) -> list[dict]:
    import cv2

    height, width = image.shape[:2]
    box_width = max(1.0, x2 - x1)
    box_height = max(1.0, y2 - y1)
    windows = [
        (0.24, 0.76, 0.22, 0.7),
        (0.16, 0.84, 0.18, 0.74),
        (0.28, 0.72, 0.26, 0.64),
    ]
    crops = []
    for left_ratio, right_ratio, top_ratio, bottom_ratio in windows:
        left = clamp_int(x1 + box_width * left_ratio, 0, width - 1)
        right = clamp_int(x1 + box_width * right_ratio, left + 1, width)
        top = clamp_int(y1 + box_height * top_ratio, 0, height - 1)
        bottom = clamp_int(y1 + box_height * bottom_ratio, top + 1, height)
        if right - left < 12 or bottom - top < 12:
            continue
        crop = image[top:bottom, left:right]
        if crop.size == 0:
            continue
        target_width = 160
        scale = max(2.0, min(4.5, target_width / max(1, crop.shape[1])))
        resized = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(gray)
        window = f"{round(left_ratio, 2)}-{round(right_ratio, 2)}:{round(top_ratio, 2)}-{round(bottom_ratio, 2)}"
        crops.append(
            {
                "window": window,
                "preprocess": "clahe",
                "sourceBox": {"left": left, "top": top, "right": right, "bottom": bottom},
                "image": cv2.cvtColor(clahe, cv2.COLOR_GRAY2BGR),
            }
        )
        thresholded = cv2.adaptiveThreshold(clahe, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 7)
        crops.append(
            {
                "window": window,
                "preprocess": "adaptive_threshold",
                "sourceBox": {"left": left, "top": top, "right": right, "bottom": bottom},
                "image": cv2.cvtColor(thresholded, cv2.COLOR_GRAY2BGR),
            }
        )
    return crops[:4]


def run_jersey_crop_ocr(ocr, crop) -> list[dict]:
    import cv2

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix="arion-jersey-", suffix=".png", delete=False) as handle:
            temp_path = handle.name
        cv2.imwrite(temp_path, crop)
        if hasattr(ocr, "predict"):
            result = ocr.predict(temp_path)
            return collect_predict_text_scores(result)
        result = ocr.ocr(temp_path)
        return collect_legacy_text_scores(result)
    except Exception:
        return []
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def collect_legacy_text_scores(result) -> list[dict]:
    tokens = []
    for page in result or []:
        for line in page or []:
            if len(line) < 2:
                continue
            text_info = line[1]
            if not text_info:
                continue
            text = str(text_info[0]).strip()
            try:
                confidence = float(text_info[1]) if len(text_info) > 1 else 0.0
            except Exception:
                confidence = 0.0
            if text:
                tokens.append({"text": text, "confidence": confidence})
    return tokens


def collect_predict_text_scores(result) -> list[dict]:
    tokens = []
    for page in result or []:
        if isinstance(page, dict):
            data = page
        else:
            json_data = getattr(page, "json", None)
            data = json_data() if callable(json_data) else getattr(page, "__dict__", {})
        if not isinstance(data, dict):
            data = {}
        if "res" in data and isinstance(data["res"], dict):
            data = data["res"]
        texts = pick_ocr_value(data, ["rec_texts", "texts"], [])
        scores = pick_ocr_value(data, ["rec_scores", "scores"], [])
        for index, text in enumerate(texts):
            text = str(text).strip()
            if not text:
                continue
            try:
                confidence = float(scores[index])
            except Exception:
                confidence = 0.0
            tokens.append({"text": text, "confidence": confidence})
    return tokens


def pick_ocr_value(data: dict, keys: list[str], fallback):
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return fallback


def jersey_candidates_from_tokens(tokens: list[dict], min_confidence: float, at: float | None) -> list[dict]:
    by_number = {}
    for decision in jersey_token_decisions(tokens, min_confidence):
        if not decision.get("accepted"):
            continue
        for number in decision.get("numbers") or []:
            candidate = {
                "number": number,
                "confidence": round(max(0.0, min(0.95, float(decision.get("adjustedConfidence") or 0))), 3),
                "text": str(decision.get("text") or number),
                "source": "crop_ocr",
                "frameAt": round(at, 3) if at is not None else None,
            }
            existing = by_number.get(number)
            if not existing or candidate["confidence"] > existing["confidence"]:
                by_number[number] = candidate
    return sorted(by_number.values(), key=lambda item: item["confidence"], reverse=True)[:2]


def jersey_token_decisions(tokens: list[dict], min_confidence: float) -> list[dict]:
    decisions = []
    for token in tokens:
        raw_text = str(token.get("text") or "").strip()
        try:
            raw_confidence = float(token.get("confidence") or 0.0)
        except Exception:
            raw_confidence = 0.0
        if not raw_text:
            decisions.append(token_decision(token, raw_text, raw_confidence, raw_confidence, [], False, "empty_text"))
            continue
        numbers = parse_jersey_numbers_from_raw(raw_text)
        adjusted_confidence = raw_confidence
        if not re.search(r"\d", raw_text):
            adjusted_confidence *= 0.82
        elif normalize_jersey_text(raw_text) != raw_text.upper():
            adjusted_confidence *= 0.92
        if not numbers:
            decisions.append(token_decision(token, raw_text, raw_confidence, adjusted_confidence, [], False, "no_jersey_number"))
            continue
        if adjusted_confidence < min_confidence:
            decisions.append(token_decision(token, raw_text, raw_confidence, adjusted_confidence, numbers, False, "below_threshold"))
            continue
        decisions.append(token_decision(token, raw_text, raw_confidence, adjusted_confidence, numbers, True, None))
    return decisions


def token_decision(token: dict, text: str, raw_confidence: float, adjusted_confidence: float, numbers: list[int], accepted: bool, reason: str | None) -> dict:
    return {
        "text": text,
        "rawConfidence": round(clamp01(raw_confidence), 3),
        "adjustedConfidence": round(clamp01(adjusted_confidence), 3),
        "numbers": numbers[:4],
        "accepted": accepted,
        "rejectionReason": reason,
        "cropIndex": token.get("cropIndex"),
        "window": token.get("window"),
        "preprocess": token.get("preprocess"),
    }


def aggregate_jersey_number_candidates(candidates: list[dict]) -> list[dict]:
    grouped: defaultdict[int, list[dict]] = defaultdict(list)
    for candidate in candidates:
        number = candidate.get("number")
        if isinstance(number, int) and 1 <= number <= 99:
            grouped[number].append(candidate)
    summaries = []
    for number, items in grouped.items():
        if number in {6, 9} and len(items) < 2:
            continue
        confidences = [float(item.get("confidence") or 0.0) for item in items]
        best = sorted(items, key=lambda item: float(item.get("confidence") or 0.0), reverse=True)[0]
        confidence = min(0.96, (sum(confidences) / max(1, len(confidences))) + min(0.12, (len(items) - 1) * 0.04))
        summaries.append({
            "number": number,
            "confidence": round(confidence, 3),
            "text": str(best.get("text") or number),
            "source": "crop_ocr",
            "frameAt": best.get("frameAt"),
            "samples": len(items),
        })
    return sorted(summaries, key=lambda item: (item["confidence"], item["samples"]), reverse=True)[:3]


def normalize_jersey_text(text: str) -> str:
    return text.upper().translate(str.maketrans({"O": "0", "D": "0", "I": "1", "L": "1", "S": "5", "B": "8"}))


def parse_jersey_numbers_from_raw(text: str) -> list[int]:
    upper = text.upper()
    values = parse_jersey_numbers(upper)
    compact = re.sub(r"[^A-Z0-9]", "", upper)
    if re.search(r"\d", upper):
        pass
    elif len(compact) == 2 and all(char in "ODILSB" for char in compact):
        values.extend(parse_jersey_numbers(normalize_jersey_text(compact)))
    seen = set()
    unique_values = []
    for value in values:
        if value not in seen:
            seen.add(value)
            unique_values.append(value)
    return unique_values


def parse_jersey_numbers(text: str) -> list[int]:
    values = []
    for match in re.finditer(r"(?<![A-Z0-9])(\d{1,2})(?![A-Z0-9])", text):
        value = int(match.group(1))
        if 1 <= value <= 99:
            values.append(value)
    return values


def parse_bool(value) -> bool:
    return str(value).strip().lower() not in {"0", "false", "no", "off", ""}


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def normalize_vector(vector: list[float]) -> list[float]:
    values = [float(item) for item in vector]
    norm = math.sqrt(sum(item * item for item in values))
    if norm <= 1e-9:
        return []
    return [round(item / norm, 8) for item in values]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    return clamp01(sum(float(a) * float(b) for a, b in zip(left, right)))


def valid_homography(matrix) -> bool:
    return (
        isinstance(matrix, list)
        and len(matrix) == 3
        and all(isinstance(row, list) and len(row) == 3 and all(is_number(value) for value in row) for row in matrix)
    )


def is_number(value) -> bool:
    try:
        float(value)
        return True
    except Exception:
        return False


def valid_attacking_direction(value) -> str:
    value = str(value or "unknown")
    return value if value in {"left_to_right", "right_to_left"} else "unknown"


def normalize_team_attacking_directions(items) -> list[dict]:
    if not isinstance(items, list):
        return []
    normalized = []
    for item in items:
        if not isinstance(item, dict):
            continue
        team = str(item.get("team") or "").strip()
        if not team:
            continue
        direction = valid_attacking_direction(item.get("attackingDirection"))
        normalized.append({
            "team": team,
            "attackingDirection": direction,
            "confidence": round(clamp01(float(item.get("confidence") or 0)), 3),
            "evidence": [str(value) for value in item.get("evidence", []) if str(value).strip()][:4],
        })
    return normalized[:8]


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


def movement_profile_for_track(track: dict | None, field_calibration=None) -> dict | None:
    if not track or len(track["centers"]) == 0:
        return None
    ordered = sorted(track["centers"], key=lambda item: item[0])
    projected = []
    coordinate_mode = "screen_relative"
    for _at, center_value in ordered:
        pitch_point = field_calibration.project(center_value) if field_calibration else None
        if pitch_point is not None:
            coordinate_mode = "pitch_homography"
            projected.append(pitch_point)
        else:
            projected.append(center_value)
    xs = [center_value[0] for center_value in projected]
    ys = [center_value[1] for center_value in projected]
    zone_occupancy = occupancy([(field_zone_hint(x), 1.0) for x in xs])
    lane_occupancy = occupancy([(width_lane_hint(y), 1.0) for y in ys])
    primary_zone, zone_confidence = primary_occupancy(zone_occupancy, "unknown")
    primary_lane, lane_confidence = primary_occupancy(lane_occupancy, "unknown")
    if len(ordered) < 2:
        return {
            "coordinateMode": coordinate_mode,
            "averageX": round(sum(xs) / len(xs), 4),
            "averageY": round(sum(ys) / len(ys), 4),
            "displacement": 0,
            "speedPerSecond": None,
            "direction": "unknown",
            "fieldZoneHint": primary_zone,
            "fieldZoneConfidence": zone_confidence,
            "widthLaneHint": primary_lane,
            "widthLaneConfidence": lane_confidence,
            "zoneOccupancy": zone_occupancy,
            "laneOccupancy": lane_occupancy,
            "samples": len(ordered),
        }
    start_at = ordered[0][0]
    end_at = ordered[-1][0]
    start_center = projected[0]
    end_center = projected[-1]
    displacement = distance(start_center, end_center)
    seconds = max(0.001, end_at - start_at)
    return {
        "coordinateMode": coordinate_mode,
        "averageX": round(sum(xs) / len(xs), 4),
        "averageY": round(sum(ys) / len(ys), 4),
        "displacement": round(displacement, 4),
        "speedPerSecond": round(displacement / seconds, 4),
        "direction": movement_direction(start_center, end_center),
        "fieldZoneHint": primary_zone,
        "fieldZoneConfidence": zone_confidence,
        "widthLaneHint": primary_lane,
        "widthLaneConfidence": lane_confidence,
        "zoneOccupancy": zone_occupancy,
        "laneOccupancy": lane_occupancy,
        "samples": len(ordered),
    }


def field_zone_hint(x_value: float) -> str:
    if x_value < 0.34:
        return "defensive_third"
    if x_value < 0.67:
        return "middle_third"
    return "final_third"


def width_lane_hint(y_value: float) -> str:
    if y_value < 0.34:
        return "far_side"
    if y_value < 0.67:
        return "central"
    return "near_side"


def occupancy(values: list[tuple[str, float]]) -> list[dict]:
    counts: Counter[str] = Counter()
    total = 0.0
    for key, weight in values:
        counts[key] += float(weight)
        total += float(weight)
    if total <= 0:
        return []
    return [{"zone" if key in {"defensive_third", "middle_third", "final_third"} else "lane": key, "share": round(value / total, 3)} for key, value in counts.most_common()]


def primary_occupancy(items: list[dict], fallback: str) -> tuple[str, float]:
    if not items:
        return fallback, 0
    item = sorted(items, key=lambda value: value.get("share", 0), reverse=True)[0]
    return str(item.get("zone") or item.get("lane") or fallback), round(float(item.get("share") or 0), 3)


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
                    "diagnostics": {
                        "schema": "tracking_diagnostics_v1",
                        "status": "unavailable",
                        "error": f"{type(fatal).__name__}: {fatal}",
                        "runtime": {"processedFrameCount": 0, "emittedSegmentCount": 0},
                    },
                },
                ensure_ascii=False,
            )
        )
        sys.exit(0)
