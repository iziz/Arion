#!/usr/bin/env python3
import argparse
import json
import multiprocessing
import os
import sys

_WORKER_OCR = None
_WORKER_LANG = "en"


def main():
    parser = argparse.ArgumentParser(description="Run PaddleOCR over extracted frame images.")
    parser.add_argument("frames_dir")
    parser.add_argument("--lang", default=os.environ.get("PADDLEOCR_LANG", "en"))
    parser.add_argument("--subtitle-interval", type=float, default=0.5)
    parser.add_argument("--full-interval", type=float, default=10)
    parser.add_argument("--dedupe-threshold", type=float, default=float(os.environ.get("PADDLEOCR_DEDUPE_THRESHOLD", "3.0")))
    parser.add_argument("--workers", type=int, default=int(os.environ.get("PADDLEOCR_WORKERS", "2")))
    args = parser.parse_args()
    configure_threading()

    try:
        from paddleocr import PaddleOCR
    except Exception as error:
        emit_result(
            {
                "available": False,
                "provider": "none",
                "tokens": [],
                "confidence": 0,
                "error": f"{type(error).__name__}: {error}",
            }
        )
        return

    image_paths = [
        os.path.join(args.frames_dir, name)
        for name in sorted(os.listdir(args.frames_dir))
        if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
    ]
    emit_progress(10, f"Preparing {len(image_paths)} OCR snapshots for {args.lang}")

    last_signatures = {}
    selected_image_paths = []
    for image_path in image_paths:
        lane = infer_lane(image_path)
        signature = image_signature(image_path)
        previous = last_signatures.get(lane)
        if previous is not None and signature is not None and image_delta(previous, signature) < args.dedupe_threshold:
            continue
        if signature is not None:
            last_signatures[lane] = signature
        selected_image_paths.append(image_path)

    workers = normalize_worker_count(args.workers, len(selected_image_paths))
    total_frames = len(selected_image_paths)
    emit_progress(15, f"Selected {total_frames} OCR snapshots for {args.lang} after dedupe")
    if total_frames == 0:
        emit_progress(98, f"No OCR snapshots to analyze for {args.lang}")
        frame_results = []
    elif workers > 1:
        with multiprocessing.get_context("spawn").Pool(processes=workers, initializer=init_worker, initargs=(args.lang,)) as pool:
            completed_frames = 0

            def report_completed(_result):
                nonlocal completed_frames
                completed_frames += 1
                emit_frame_progress(completed_frames, total_frames, args.lang, workers)

            async_results = [
                pool.apply_async(
                    run_ocr_frame_worker,
                    ((image_path, args.subtitle_interval, args.full_interval),),
                    callback=report_completed,
                )
                for image_path in selected_image_paths
            ]
            frame_results = [result.get() for result in async_results]
    else:
        init_worker(args.lang)
        frame_results = []
        for index, image_path in enumerate(selected_image_paths, start=1):
            frame_results.append(run_ocr_frame_worker((image_path, args.subtitle_interval, args.full_interval)))
            emit_frame_progress(index, total_frames, args.lang, workers)
    emit_progress(98, f"Finalizing OCR tokens from {total_frames} snapshots for {args.lang}")

    tokens = []
    confidences = []
    for frame in frame_results:
        tokens.extend(frame["tokens"])
        confidences.extend([box.get("confidence", 0) for box in frame["boxes"]])

    unique_tokens = []
    seen = set()
    for token in tokens:
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        unique_tokens.append(token)

    confidence_value = sum(confidences) / len(confidences) if confidences else 0
    emit_result(
        {
            "available": True,
            "provider": "paddleocr",
            "tokens": unique_tokens[:80],
            "confidence": round(confidence_value, 3),
            "frames": len(image_paths),
            "processedFrames": len(selected_image_paths),
            "workers": workers,
            "frameResults": frame_results,
        }
    )


def normalize_worker_count(configured_workers, item_count):
    if item_count <= 1:
        return 1
    if configured_workers <= 1:
        return 1
    cpu_count = os.cpu_count() or 2
    return max(1, min(configured_workers, item_count, cpu_count))


def configure_threading():
    threads = optional_positive_int(os.environ.get("PADDLEOCR_CPU_THREADS_PER_WORKER"))
    if threads is None:
        return None
    for key in ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"]:
        os.environ.setdefault(key, str(threads))
    return threads


def optional_positive_int(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = int(str(value))
    except Exception:
        return None
    return parsed if parsed > 0 else None


def init_worker(lang):
    global _WORKER_OCR, _WORKER_LANG
    configure_threading()
    _WORKER_LANG = lang
    if _WORKER_OCR is not None:
        return
    from paddleocr import PaddleOCR

    try:
        _WORKER_OCR = PaddleOCR(use_angle_cls=True, lang=lang)
    except Exception:
        _WORKER_OCR = PaddleOCR(lang=lang)


def run_ocr_frame_worker(payload):
    image_path, subtitle_interval, full_interval = payload
    tokens = []
    confidences = []
    boxes = []
    width, height = image_size(image_path)
    if hasattr(_WORKER_OCR, "predict"):
        result = _WORKER_OCR.predict(image_path)
        collect_predict_result(result, tokens, confidences, boxes, width, height)
    else:
        result = _WORKER_OCR.ocr(image_path)
        collect_legacy_result(result, tokens, confidences, boxes, width, height)
    role_hint = infer_role_hint(image_path)
    if role_hint:
        for box in boxes:
            box["role"] = role_hint
    return {
        "framePath": image_path,
        "at": infer_frame_time(image_path, subtitle_interval, full_interval),
        "tokens": tokens,
        "boxes": boxes,
        "confidence": round(sum(confidences) / len(confidences), 3) if confidences else 0,
    }


def emit_result(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)
    stop_resource_tracker()


def emit_progress(progress, message):
    payload = {
        "type": "progress",
        "stage": "ocr",
        "progress": max(0, min(100, int(round(progress)))),
        "message": message,
    }
    print(f"ARION_PROGRESS {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


def emit_frame_progress(completed, total, lang, workers):
    if total <= 0:
        return
    progress = 20 + (min(1, completed / total) * 75)
    worker_text = f" with {workers} workers" if workers > 1 else ""
    emit_progress(progress, f"Analyzing OCR snapshots {completed} / {total} for {lang}{worker_text}")


def stop_resource_tracker():
    try:
        from multiprocessing import resource_tracker

        tracker = getattr(resource_tracker, "_resource_tracker", None)
        if tracker is not None:
            tracker._stop()
    except Exception:
        pass

def image_size(image_path):
    try:
        from PIL import Image

        with Image.open(image_path) as image:
            return image.size
    except Exception:
        return 0, 0


def infer_frame_time(image_path, subtitle_interval, full_interval):
    name = os.path.basename(image_path)
    import re

    match = re.search(r"(?:subtitle-(?:top|bottom)-frame|full-frame|frame)-(\d+)", name, re.I)
    if not match:
        return None
    frame_number = max(1, int(match.group(1)))
    interval = full_interval if name.startswith("full-") or name.startswith("frame-") else subtitle_interval
    return round((frame_number - 1) * interval, 2)


def infer_role_hint(image_path):
    name = os.path.basename(image_path).lower()
    if name.startswith("subtitle-"):
        return "subtitle"
    return None


def infer_lane(image_path):
    name = os.path.basename(image_path).lower()
    if name.startswith("subtitle-top-"):
        return "subtitle-top"
    if name.startswith("subtitle-bottom-"):
        return "subtitle-bottom"
    if name.startswith("full-"):
        return "full"
    return "default"


def image_signature(image_path):
    try:
        from PIL import Image

        with Image.open(image_path) as image:
            return list(image.convert("L").resize((96, 24)).getdata())
    except Exception:
        return None


def image_delta(left, right):
    if not left or not right or len(left) != len(right):
        return 255
    return sum(abs(int(a) - int(b)) for a, b in zip(left, right)) / len(left)


def collect_legacy_result(result, tokens, confidences, boxes, image_width, image_height):
    for page in result or []:
        for line in page or []:
            if len(line) < 2:
                continue
            bbox = normalize_bbox(line[0]) if line else []
            text_info = line[1]
            if not text_info:
                continue
            text = str(text_info[0]).strip()
            confidence = float(text_info[1]) if len(text_info) > 1 else 0
            if text:
                tokens.append(text)
                confidences.append(confidence)
                boxes.append(build_box(text, confidence, bbox, image_width, image_height))


def collect_predict_result(result, tokens, confidences, boxes, image_width, image_height):
    for page in result or []:
        if isinstance(page, dict):
            texts = pick_value(page, ["rec_texts", "texts"], [])
            scores = pick_value(page, ["rec_scores", "scores"], [])
            raw_boxes = pick_value(page, ["rec_polys", "rec_boxes", "dt_polys", "boxes"], [])
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
            texts = pick_value(data, ["rec_texts", "texts"], [])
            scores = pick_value(data, ["rec_scores", "scores"], [])
            raw_boxes = pick_value(data, ["rec_polys", "rec_boxes", "dt_polys", "boxes"], [])
        for index, text in enumerate(texts):
            text = str(text).strip()
            if not text:
                continue
            confidence = 0
            try:
                confidence = float(scores[index])
            except Exception:
                confidence = 0
            tokens.append(text)
            confidences.append(confidence)
            bbox = normalize_bbox(raw_boxes[index]) if index < len(raw_boxes) else []
            boxes.append(build_box(text, confidence, bbox, image_width, image_height))


def pick_value(data, keys, fallback):
    for key in keys:
        if not isinstance(data, dict) or key not in data:
            continue
        value = data.get(key)
        if value is not None:
            return value
    return fallback


def normalize_bbox(raw_box):
    if raw_box is None:
        return []
    try:
        if hasattr(raw_box, "tolist"):
            raw_box = raw_box.tolist()
        if len(raw_box) == 4 and all(is_number(value) for value in raw_box):
            x1, y1, x2, y2 = [float(value) for value in raw_box]
            return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
        points = []
        for point in raw_box:
            if hasattr(point, "tolist"):
                point = point.tolist()
            if len(point) >= 2:
                points.append([float(point[0]), float(point[1])])
        return points[:4]
    except Exception:
        return []


def is_number(value):
    try:
        float(value)
        return True
    except Exception:
        return False


def build_box(text, confidence, bbox, image_width, image_height):
    region = classify_region(bbox, image_width, image_height)
    role = classify_role(region, bbox, image_width, image_height)
    return {
        "text": text,
        "confidence": round(confidence, 3),
        "bbox": bbox,
        "region": region,
        "role": role,
    }


def classify_region(bbox, image_width, image_height):
    if not bbox or image_width <= 0 or image_height <= 0:
        return "middle"
    xs = [point[0] for point in bbox]
    ys = [point[1] for point in bbox]
    center_x = ((min(xs) + max(xs)) / 2) / image_width
    center_y = ((min(ys) + max(ys)) / 2) / image_height
    if center_y < 0.24:
        return "top"
    if center_y > 0.72:
        return "bottom"
    if center_x < 0.2:
        return "left"
    if center_x > 0.8:
        return "right"
    return "middle"


def classify_role(region, bbox, image_width, image_height):
    if not bbox or image_width <= 0 or image_height <= 0:
        return "screen_text"
    xs = [point[0] for point in bbox]
    ys = [point[1] for point in bbox]
    center_x = ((min(xs) + max(xs)) / 2) / image_width
    width_ratio = max(0, (max(xs) - min(xs)) / image_width)
    height_ratio = max(0, (max(ys) - min(ys)) / image_height)
    if region == "bottom" and 0.18 <= center_x <= 0.82 and width_ratio > 0.12:
        return "subtitle"
    if region in ("top", "left", "right") and (width_ratio < 0.28 or height_ratio < 0.08):
        return "watermark"
    if region in ("top", "bottom"):
        return "overlay"
    return "screen_text"


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit_result({"available": False, "provider": "paddleocr", "tokens": [], "confidence": 0, "error": str(error)})
        sys.exit(0)
