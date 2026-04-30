#!/usr/bin/env python3
import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Run PaddleOCR over extracted frame images.")
    parser.add_argument("frames_dir")
    parser.add_argument("--lang", default=os.environ.get("PADDLEOCR_LANG", "en"))
    args = parser.parse_args()

    try:
        from paddleocr import PaddleOCR
    except Exception as error:
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": "none",
                    "tokens": [],
                    "confidence": 0,
                    "error": f"{type(error).__name__}: {error}",
                },
                ensure_ascii=False,
            )
        )
        return

    try:
        ocr = PaddleOCR(use_angle_cls=True, lang=args.lang)
    except Exception:
        ocr = PaddleOCR(lang=args.lang)

    tokens = []
    confidences = []
    image_paths = [
        os.path.join(args.frames_dir, name)
        for name in sorted(os.listdir(args.frames_dir))
        if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
    ]

    frame_results = []
    for image_path in image_paths:
        before_count = len(tokens)
        before_scores = len(confidences)
        if hasattr(ocr, "predict"):
            result = ocr.predict(image_path)
            collect_predict_result(result, tokens, confidences)
        else:
            result = ocr.ocr(image_path)
            collect_legacy_result(result, tokens, confidences)
        frame_tokens = tokens[before_count:]
        frame_scores = confidences[before_scores:]
        frame_results.append(
            {
                "framePath": image_path,
                "tokens": frame_tokens,
                "confidence": round(sum(frame_scores) / len(frame_scores), 3) if frame_scores else 0,
            }
        )

    unique_tokens = []
    seen = set()
    for token in tokens:
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        unique_tokens.append(token)

    confidence_value = sum(confidences) / len(confidences) if confidences else 0
    print(
        json.dumps(
            {
                "available": True,
                "provider": "paddleocr",
                "tokens": unique_tokens[:80],
                "confidence": round(confidence_value, 3),
                "frames": len(image_paths),
                "frameResults": frame_results,
            },
            ensure_ascii=False,
        )
    )

def collect_legacy_result(result, tokens, confidences):
    for page in result or []:
        for line in page or []:
            if len(line) < 2:
                continue
            text_info = line[1]
            if not text_info:
                continue
            text = str(text_info[0]).strip()
            confidence = float(text_info[1]) if len(text_info) > 1 else 0
            if text:
                tokens.append(text)
                confidences.append(confidence)


def collect_predict_result(result, tokens, confidences):
    for page in result or []:
        if isinstance(page, dict):
            texts = page.get("rec_texts") or page.get("texts") or []
            scores = page.get("rec_scores") or page.get("scores") or []
        else:
            data = getattr(page, "json", None)
            if callable(data):
                data = data()
            elif isinstance(data, dict):
                data = data
            elif hasattr(page, "__dict__"):
                data = page.__dict__
            else:
                data = {}
            if isinstance(data, dict) and "res" in data and isinstance(data["res"], dict):
                data = data["res"]
            texts = data.get("rec_texts") or data.get("texts") or []
            scores = data.get("rec_scores") or data.get("scores") or []
        for index, text in enumerate(texts):
            text = str(text).strip()
            if not text:
                continue
            tokens.append(text)
            try:
                confidences.append(float(scores[index]))
            except Exception:
                confidences.append(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"available": False, "provider": "paddleocr", "tokens": [], "confidence": 0, "error": str(error)}, ensure_ascii=False))
        sys.exit(0)
