import argparse
import json
import math
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--backend", default=os.environ.get("VISION_DETECTOR_BACKEND", "auto"))
    parser.add_argument("--rfdetr-model", default=os.environ.get("VISION_RFDETR_MODEL", "RFDETRNano"))
    parser.add_argument("--conf", type=float, default=float(os.environ.get("VISION_DETECTOR_CONF", "0.25")))
    parser.add_argument("--allow-heuristic-fallback", action="store_true", default=os.environ.get("VISION_ALLOW_OPENCV_HEURISTIC", "").lower() == "true")
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    images = payload.get("images", [])
    result = run_detector(images, args)
    print(json.dumps(result, ensure_ascii=False))


def run_detector(images, args):
    if not images:
        return unavailable("none", args.model, ["No images were provided for object detection."])
    errors = []
    requested = normalize_backend(args.backend)
    if requested in {"auto", "ultralytics"}:
        try:
            return run_yolo(images, args.model, args.conf)
        except Exception as error:
            errors.append(f"ultralytics:{type(error).__name__}: {error}")
            if requested == "ultralytics" and not args.allow_heuristic_fallback:
                return unavailable("ultralytics", args.model, errors)
    if requested in {"auto", "rfdetr"}:
        try:
            return run_rfdetr(images, args.rfdetr_model, args.conf)
        except Exception as error:
            errors.append(f"rfdetr:{type(error).__name__}: {error}")
            if requested == "rfdetr" and not args.allow_heuristic_fallback:
                return unavailable("rfdetr", args.rfdetr_model, errors)
    if args.allow_heuristic_fallback:
        return run_opencv_heuristic(images, "; ".join(errors) or "Detector backend unavailable")
    return unavailable("vision-detector", f"{args.model}|{args.rfdetr_model}", errors or [f"Unsupported detector backend: {args.backend}"])


def normalize_backend(value):
    normalized = str(value or "auto").strip().lower()
    if normalized in {"yolo", "yolo11"}:
        return "ultralytics"
    if normalized in {"rf-detr", "rf_detr"}:
        return "rfdetr"
    return normalized


def unavailable(provider, model_name, errors):
    return {
        "available": False,
        "provider": provider,
        "model": model_name,
        "frames": [],
        "error": "; ".join(errors),
    }


def run_yolo(images, model_name, confidence_threshold):
    from ultralytics import YOLO

    model = YOLO(model_name)
    frames = []
    for item in images:
        prediction = model.predict(item["path"], conf=confidence_threshold, verbose=False)[0]
        boxes = []
        names = prediction.names or {}
        width = int(prediction.orig_shape[1])
        height = int(prediction.orig_shape[0])
        for box in prediction.boxes:
            cls = int(box.cls[0])
            name = str(names.get(cls, cls)).lower()
            label = "person" if name == "person" else "sports_ball" if name in {"sports ball", "ball"} else "unknown"
            if label == "unknown":
                continue
            x1, y1, x2, y2 = [float(value) for value in box.xyxy[0]]
            boxes.append(
                {
                    "label": label,
                    "confidence": round(float(box.conf[0]), 3),
                    "x": round(x1 / width, 4),
                    "y": round(y1 / height, 4),
                    "width": round((x2 - x1) / width, 4),
                    "height": round((y2 - y1) / height, 4),
                    "source": f"ultralytics:{model_name}",
                }
            )
        frames.append(frame_result(item, width, height, boxes, f"ultralytics:{model_name}", True, None))
    return {"available": True, "provider": "ultralytics", "model": model_name, "frames": frames}


def run_rfdetr(images, model_name, confidence_threshold):
    from rfdetr.assets.coco_classes import COCO_CLASSES

    model = create_rfdetr_model(model_name)
    frames = []
    for item in images:
        image_path = item["path"]
        width, height = image_dimensions(image_path)
        detections = model.predict(image_path, threshold=confidence_threshold)
        boxes = []
        xyxy = sequence(getattr(detections, "xyxy", []))
        confidences = sequence(getattr(detections, "confidence", []))
        class_ids = sequence(getattr(detections, "class_id", []))
        class_names = detection_class_names(detections, class_ids, COCO_CLASSES)
        for coords, confidence, class_id, class_name in zip(xyxy, confidences, class_ids, class_names):
            label = normalize_detection_label(class_name, class_id)
            if label == "unknown":
                continue
            x1, y1, x2, y2 = [float(value) for value in coords]
            boxes.append(normalized_box(label, x1, y1, x2 - x1, y2 - y1, width, height, float(confidence), f"rfdetr:{model_name}"))
        frames.append(frame_result(item, width, height, boxes, f"rfdetr:{model_name}", True, None))
    return {"available": True, "provider": "rfdetr", "model": model_name, "frames": frames}


def create_rfdetr_model(model_name):
    import rfdetr

    class_name = normalize_rfdetr_class_name(model_name)
    model_class = getattr(rfdetr, class_name)
    weights = os.environ.get("VISION_RFDETR_WEIGHTS")
    if weights:
        try:
            return model_class(pretrain_weights=weights)
        except TypeError:
            return model_class()
    return model_class()


def normalize_rfdetr_class_name(model_name):
    aliases = {
        "nano": "RFDETRNano",
        "n": "RFDETRNano",
        "small": "RFDETRSmall",
        "s": "RFDETRSmall",
        "medium": "RFDETRMedium",
        "m": "RFDETRMedium",
        "base": "RFDETRBase",
        "b": "RFDETRBase",
        "large": "RFDETRLarge",
        "l": "RFDETRLarge",
    }
    value = str(model_name or "RFDETRNano").strip()
    return aliases.get(value.lower(), value)


def image_dimensions(path):
    from PIL import Image

    with Image.open(path) as image:
        return image.size


def detection_class_names(detections, class_ids, coco_classes):
    data = getattr(detections, "data", {}) or {}
    raw_class_names = data.get("class_name")
    if raw_class_names is None:
        raw_class_names = data.get("class_names")
    class_names = sequence(raw_class_names)
    if len(class_names) == len(class_ids):
        return [str(item) for item in class_names]
    return [coco_class_name(coco_classes, class_id) for class_id in class_ids]


def coco_class_name(coco_classes, class_id):
    index = int(class_id)
    if hasattr(coco_classes, "get"):
        return str(coco_classes.get(index, index))
    if 0 <= index < len(coco_classes):
        return str(coco_classes[index])
    return str(index)


def sequence(value):
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


def normalize_detection_label(class_name, class_id):
    name = str(class_name or "").strip().lower().replace("_", " ")
    if name == "person" or int(class_id) == 0:
        return "person"
    if name in {"sports ball", "ball"} or int(class_id) == 32:
        return "sports_ball"
    return "unknown"


def run_opencv_heuristic(images, yolo_error):
    import cv2

    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    frames = []
    for item in images:
        image = cv2.imread(item["path"])
        if image is None:
            frames.append(frame_result(item, 0, 0, [], "opencv-heuristic", False, "image read failed"))
            continue
        height, width = image.shape[:2]
        boxes = []
        resized = resize_for_detection(image, 960)
        scale_x = width / resized.shape[1]
        scale_y = height / resized.shape[0]
        people, weights = hog.detectMultiScale(resized, winStride=(8, 8), padding=(8, 8), scale=1.08)
        for (x, y, w, h), weight in zip(people[:16], weights[:16]):
            confidence = max(0.18, min(0.72, float(weight) / 2.8))
            boxes.append(normalized_box("person", x * scale_x, y * scale_y, w * scale_x, h * scale_y, width, height, confidence, "opencv-hog"))
        for circle in detect_ball_candidates(image)[:3]:
            x, y, radius, confidence = circle
            boxes.append(normalized_box("sports_ball", x - radius, y - radius, radius * 2, radius * 2, width, height, confidence, "opencv-hough"))
        frames.append(frame_result(item, width, height, boxes, "opencv-heuristic", False, yolo_error))
    return {"available": False, "provider": "opencv-heuristic", "model": "hog+hough", "frames": frames, "warning": yolo_error, "error": yolo_error}


def detect_ball_candidates(image):
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    small = resize_for_detection(image, 720)
    scale_x = width / small.shape[1]
    scale_y = height / small.shape[0]
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    green_mask = cv2.inRange(hsv, np.array([35, 35, 20]), np.array([95, 255, 235]))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    circles = cv2.HoughCircles(gray, cv2.HOUGH_GRADIENT, 1.2, minDist=24, param1=80, param2=18, minRadius=2, maxRadius=12)
    if circles is None:
      return []
    candidates = []
    for x, y, radius in np.round(circles[0, :]).astype("int"):
        if x < 0 or y < 0 or x >= small.shape[1] or y >= small.shape[0]:
            continue
        green_context = green_mask[max(0, y - 18) : min(small.shape[0], y + 18), max(0, x - 18) : min(small.shape[1], x + 18)]
        green_ratio = float(np.count_nonzero(green_context)) / max(1, green_context.size)
        if green_ratio < 0.18:
            continue
        confidence = round(min(0.45, 0.2 + green_ratio * 0.25), 3)
        candidates.append((float(x * scale_x), float(y * scale_y), float(radius * (scale_x + scale_y) / 2), confidence))
    return sorted(candidates, key=lambda item: item[3], reverse=True)


def resize_for_detection(image, max_width):
    import cv2

    height, width = image.shape[:2]
    if width <= max_width:
        return image
    scale = max_width / width
    return cv2.resize(image, (max_width, max(1, int(height * scale))))


def normalized_box(label, x, y, width_box, height_box, width, height, confidence, source):
    return {
        "label": label,
        "confidence": round(float(confidence), 3),
        "x": round(max(0, x) / width, 4),
        "y": round(max(0, y) / height, 4),
        "width": round(max(0, min(width_box, width - max(0, x))) / width, 4),
        "height": round(max(0, min(height_box, height - max(0, y))) / height, 4),
        "source": source,
    }


def frame_result(item, width, height, boxes, provider, available, error):
    proximity = proximity_result(boxes)
    return {
        "segmentId": item.get("segmentId"),
        "path": item.get("path"),
        "frameAt": item.get("frameAt"),
        "width": width,
        "height": height,
        "provider": provider,
        "available": available,
        "error": error,
        "boxes": boxes,
        "proximity": proximity,
    }


def proximity_result(boxes):
    players = [box for box in boxes if box["label"] == "person"]
    balls = [box for box in boxes if box["label"] == "sports_ball"]
    if not players or not balls:
        return {"ballNearPlayer": False, "confidence": 0, "normalizedDistance": None}
    best = min(distance(center(player), center(ball)) for player in players for ball in balls)
    near = best <= 0.18
    return {
        "ballNearPlayer": near,
        "confidence": round(max(0, min(0.75, 0.75 - best)), 3),
        "normalizedDistance": round(best, 4),
    }


def center(box):
    return (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def distance(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


if __name__ == "__main__":
    main()
