import argparse
import json
import math
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="yolo11n.pt")
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    images = payload.get("images", [])
    try:
        result = run_yolo(images, args.model)
    except Exception as yolo_error:
        result = run_opencv_fallback(images, str(yolo_error))
    print(json.dumps(result, ensure_ascii=False))


def run_yolo(images, model_name):
    from ultralytics import YOLO

    model = YOLO(model_name)
    frames = []
    for item in images:
        prediction = model.predict(item["path"], verbose=False)[0]
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


def run_opencv_fallback(images, yolo_error):
    import cv2

    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    frames = []
    for item in images:
        image = cv2.imread(item["path"])
        if image is None:
            frames.append(frame_result(item, 0, 0, [], "opencv-fallback", False, "image read failed"))
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
        frames.append(frame_result(item, width, height, boxes, "opencv-fallback", True, yolo_error))
    return {"available": True, "provider": "opencv-fallback", "model": "hog+hough", "frames": frames, "warning": yolo_error}


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
