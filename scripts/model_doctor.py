#!/usr/bin/env python3
import importlib.util
import json
import os
import shutil
import sys


def present(module_name):
    try:
        return importlib.util.find_spec(module_name) is not None
    except ModuleNotFoundError:
        return False


def executable(path_or_name):
    if not path_or_name:
        return None
    if os.path.isfile(path_or_name) and os.access(path_or_name, os.X_OK):
        return path_or_name
    return shutil.which(path_or_name)


def default_whisper_cpp_bin():
    candidates = [
        os.path.join(os.getcwd(), ".local", "whisper.cpp", "build", "bin", "whisper-cli"),
        os.path.join(os.getcwd(), "whisper.cpp", "build", "bin", "whisper-cli"),
    ]
    for candidate in candidates:
        resolved = executable(candidate)
        if resolved:
            return resolved
    return shutil.which("whisper-cli")


def has_json(directory):
    try:
        return os.path.isdir(directory) and any(name.endswith(".json") for name in os.listdir(directory))
    except OSError:
        return False


def paddleocr_vl_available():
    try:
        import paddleocr

        return hasattr(paddleocr, "PaddleOCRVL")
    except Exception:
        return False


whisper_cpp_bin = executable(os.environ.get("WHISPER_CPP_BIN")) or default_whisper_cpp_bin()
whisper_cpp_model = os.environ.get("WHISPER_CPP_MODEL")
american_football_spots_dir = (
    os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTS_DIR")
    or os.environ.get("NFL_ACTION_SPOTS_DIR")
    or os.path.join(os.getcwd(), ".data", "american-football-action-spots")
)

result = {
    "python": sys.version.split()[0],
    "ffmpeg": shutil.which("ffmpeg"),
    "ffprobe": shutil.which("ffprobe"),
    "whisper": present("whisper"),
    "faster_whisper": present("faster_whisper"),
    "whisper_cpp": bool(whisper_cpp_bin),
    "whisper_cpp_bin": whisper_cpp_bin,
    "whisper_cpp_model": bool(whisper_cpp_model and os.path.isfile(whisper_cpp_model)),
    "whisperx": present("whisperx"),
    "whisperx_diarize": present("whisperx.diarize"),
    "pyannote_audio": present("pyannote.audio"),
    "torchaudio": present("torchaudio"),
    "paddleocr": present("paddleocr"),
    "paddleocr_vl": paddleocr_vl_available(),
    "paddle": present("paddle"),
    "scenedetect": present("scenedetect"),
    "ultralytics": present("ultralytics"),
    "rfdetr": present("rfdetr"),
    "soccernet": present("SoccerNet") or present("soccerNet") or present("soccernet"),
    "american_football_action_spotting": bool(
        os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTTING_ENABLED") == "true"
        or os.environ.get("NFL_ACTION_SPOTTING_ENABLED") == "true"
        or os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTTING_COMMAND")
        or os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTS_JSON")
        or os.environ.get("NFL_ACTION_SPOTTING_COMMAND")
        or os.environ.get("NFL_ACTION_SPOTS_JSON")
        or has_json(american_football_spots_dir)
    ),
    "cv2": present("cv2"),
    "nltk": present("nltk"),
    "omegaconf": present("omegaconf"),
    "sentence_transformers": present("sentence_transformers"),
    "open_clip": present("open_clip"),
    "torchvision": present("torchvision"),
    "fastapi": present("fastapi"),
    "uvicorn": present("uvicorn"),
    "transformers": present("transformers"),
    "accelerate": present("accelerate"),
    "qwen_vl_utils": present("qwen_vl_utils"),
    "mlx": present("mlx"),
    "mlx_vlm": present("mlx_vlm"),
}

print(json.dumps(result, indent=2))
