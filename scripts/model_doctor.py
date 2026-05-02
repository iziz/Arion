#!/usr/bin/env python3
import importlib.util
import json
import shutil
import sys


def present(module_name):
    try:
        return importlib.util.find_spec(module_name) is not None
    except ModuleNotFoundError:
        return False


result = {
    "python": sys.version.split()[0],
    "ffmpeg": shutil.which("ffmpeg"),
    "ffprobe": shutil.which("ffprobe"),
    "whisper": present("whisper"),
    "faster_whisper": present("faster_whisper"),
    "whisperx": present("whisperx"),
    "whisperx_diarize": present("whisperx.diarize"),
    "pyannote_audio": present("pyannote.audio"),
    "torchaudio": present("torchaudio"),
    "paddleocr": present("paddleocr"),
    "paddle": present("paddle"),
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
