import path from "node:path";

export const pythonBin = process.env.LOCAL_AI_PYTHON || process.env.PYTHON_BIN || path.resolve(".venv-ai", "bin", "python");
export const detectorScript = path.resolve("scripts", "detect_objects.py");
export const trackerScript = path.resolve("scripts", "track_objects.py");
export const detectorBackend = process.env.VISION_DETECTOR_BACKEND || "auto";
export const detectorModel = process.env.VISION_DETECTOR_MODEL || "yolo11n.pt";
export const detectorConfidence = process.env.VISION_DETECTOR_CONF || "0.25";
export const rfDetrModel = process.env.VISION_RFDETR_MODEL || "RFDETRNano";
export const allowHeuristicDetectorFallback = process.env.VISION_ALLOW_OPENCV_HEURISTIC === "true";
export const trackerName = process.env.VISION_TRACKER || "bytetrack.yaml";
