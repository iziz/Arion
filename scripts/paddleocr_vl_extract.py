#!/usr/bin/env python3
"""Experimental PaddleOCR-VL frame text extraction for document-like overlays."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Run PaddleOCR-VL on sampled OCR frames.")
    parser.add_argument("frames_dir")
    parser.add_argument("--lang", default=os.environ.get("PADDLEOCR_LANG", "en"))
    parser.add_argument("--model", default=os.environ.get("PADDLEOCR_VL_MODEL", "PaddleOCR-VL-0.9B"))
    parser.add_argument("--max-frames", type=int, default=int(os.environ.get("PADDLEOCR_VL_MAX_FRAMES", "24")))
    args = parser.parse_args()

    try:
        frames = frame_paths(Path(args.frames_dir), args.max_frames)
        if not frames:
            raise RuntimeError("No OCR frames found for PaddleOCR-VL.")
        engine = load_engine(args.model, args.lang)
        frame_results = [parse_prediction(path, run_prediction(engine, path), index) for index, path in enumerate(frames)]
        tokens = unique([token for frame in frame_results for token in frame.get("tokens", [])])
        print(json.dumps({
            "available": True,
            "provider": "paddleocr-vl",
            "model": args.model,
            "language": args.lang,
            "tokens": tokens,
            "confidence": mean_confidence(frame_results),
            "frameResults": frame_results,
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({
            "available": False,
            "provider": "paddleocr-vl",
            "model": args.model,
            "language": args.lang,
            "tokens": [],
            "confidence": 0,
            "frameResults": [],
            "error": str(error),
        }, ensure_ascii=False))
    return 0


def frame_paths(frames_dir: Path, limit: int) -> list[Path]:
    patterns = ("full-frame-*.png", "subtitle-top-frame-*.png", "subtitle-bottom-frame-*.png")
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(sorted(frames_dir.glob(pattern)))
    return paths[: max(1, limit)]


def load_engine(model_name: str, lang: str) -> Any:
    from paddleocr import PaddleOCR

    try:
        from paddleocr import PaddleOCRVL  # type: ignore
    except Exception:
        PaddleOCRVL = None
    if PaddleOCRVL is not None:
        return PaddleOCRVL(model_name=model_name, lang=lang)
    try:
        return PaddleOCR(model_name=model_name, lang=lang)
    except TypeError as error:
        raise RuntimeError("Installed paddleocr does not expose PaddleOCR-VL. Upgrade paddleocr or disable PADDLEOCR_VL_ENABLED.") from error


def run_prediction(engine: Any, image_path: Path) -> Any:
    if hasattr(engine, "predict"):
        return engine.predict(str(image_path))
    if hasattr(engine, "ocr"):
        return engine.ocr(str(image_path))
    raise RuntimeError("PaddleOCR-VL engine has no predict or ocr method.")


def parse_prediction(image_path: Path, prediction: Any, index: int) -> dict[str, Any]:
    boxes = collect_boxes(prediction)
    return {
        "frame": image_path.name,
        "path": str(image_path),
        "timestamp": index,
        "tokens": unique([box["text"] for box in boxes]),
        "confidence": mean([box["confidence"] for box in boxes]),
        "boxes": boxes,
    }


def collect_boxes(value: Any) -> list[dict[str, Any]]:
    boxes: list[dict[str, Any]] = []
    walk_prediction(value, boxes)
    return boxes[:200]


def walk_prediction(value: Any, boxes: list[dict[str, Any]]) -> None:
    if isinstance(value, dict):
        text = first_text(value)
        if text:
            boxes.append({
                "text": text,
                "confidence": first_confidence(value),
                "box": value.get("bbox") or value.get("box") or value.get("dt_polys") or None,
            })
        for child in value.values():
            walk_prediction(child, boxes)
    elif isinstance(value, list):
        for child in value:
            walk_prediction(child, boxes)


def first_text(value: dict[str, Any]) -> str:
    for key in ("text", "transcription", "rec_text", "label"):
        text = value.get(key)
        if isinstance(text, str) and text.strip():
            return text.strip()
    texts = value.get("rec_texts")
    if isinstance(texts, list) and texts:
        return str(texts[0]).strip()
    return ""


def first_confidence(value: dict[str, Any]) -> float:
    for key in ("confidence", "score", "rec_score"):
        score = value.get(key)
        if isinstance(score, (int, float)):
            return max(0.0, min(1.0, float(score)))
    scores = value.get("rec_scores")
    if isinstance(scores, list) and scores and isinstance(scores[0], (int, float)):
        return max(0.0, min(1.0, float(scores[0])))
    return 0.0


def mean_confidence(frames: list[dict[str, Any]]) -> float:
    return mean([float(frame.get("confidence") or 0) for frame in frames if frame.get("tokens")])


def mean(values: list[float]) -> float:
    return round(sum(values) / len(values), 3) if values else 0


def unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = " ".join(str(value).split())
        key = text.casefold()
        if text and key not in seen:
            seen.add(key)
            result.append(text)
    return result[:120]


if __name__ == "__main__":
    sys.exit(main())
