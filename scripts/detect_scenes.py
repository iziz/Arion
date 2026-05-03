#!/usr/bin/env python3
"""Detect video scene boundaries with PySceneDetect, emitting compact JSON."""

from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="Detect scene boundaries with PySceneDetect.")
    parser.add_argument("media_path")
    parser.add_argument("--detector", default=os.environ.get("SCENE_DETECTOR", "adaptive"))
    parser.add_argument("--threshold", type=float, default=float(os.environ.get("SCENE_CONTENT_THRESHOLD", "27.0")))
    parser.add_argument("--adaptive-threshold", type=float, default=float(os.environ.get("SCENE_ADAPTIVE_THRESHOLD", "3.0")))
    parser.add_argument("--min-scene-len", type=int, default=int(os.environ.get("SCENE_MIN_LEN_FRAMES", "15")))
    args = parser.parse_args()

    try:
        result = detect_scenes(args)
    except Exception as error:
        result = {
            "available": False,
            "provider": "pyscenedetect",
            "detector": args.detector,
            "boundaries": [],
            "error": f"{type(error).__name__}: {error}",
        }
    print(json.dumps(result, ensure_ascii=False))


def detect_scenes(args: argparse.Namespace) -> dict:
    from scenedetect import SceneManager, open_video
    from scenedetect.detectors import AdaptiveDetector, ContentDetector

    video = open_video(args.media_path)
    scene_manager = SceneManager()
    detector_name = str(args.detector or "adaptive").strip().lower()
    if detector_name == "content":
        scene_manager.add_detector(ContentDetector(threshold=args.threshold, min_scene_len=args.min_scene_len))
    else:
        detector_name = "adaptive"
        scene_manager.add_detector(
            AdaptiveDetector(
                adaptive_threshold=args.adaptive_threshold,
                min_scene_len=args.min_scene_len,
                min_content_val=args.threshold,
            )
        )

    scene_manager.detect_scenes(video=video, show_progress=False)
    scene_list = scene_manager.get_scene_list()
    boundaries = []
    for index, (start_time, _end_time) in enumerate(scene_list):
        if index == 0:
            continue
        at = float(start_time.get_seconds())
        if at <= 0:
            continue
        boundaries.append(
            {
                "at": round(at, 3),
                "score": None,
                "source": "pyscenedetect",
                "detector": detector_name,
            }
        )

    return {
        "available": True,
        "provider": "pyscenedetect",
        "detector": detector_name,
        "boundaries": boundaries,
        "error": None,
    }


if __name__ == "__main__":
    try:
        main()
    except Exception as fatal:
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": "pyscenedetect",
                    "detector": os.environ.get("SCENE_DETECTOR", "adaptive"),
                    "boundaries": [],
                    "error": f"{type(fatal).__name__}: {fatal}",
                },
                ensure_ascii=False,
            )
        )
        sys.exit(0)
