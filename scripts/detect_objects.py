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
            if requested == "ultralytics":
                return unavailable("ultralytics", args.model, errors)
    if requested in {"auto", "rfdetr"}:
        try:
            return run_rfdetr(images, args.rfdetr_model, args.conf)
        except Exception as error:
            errors.append(f"rfdetr:{type(error).__name__}: {error}")
            if requested == "rfdetr":
                return unavailable("rfdetr", args.rfdetr_model, errors)
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
