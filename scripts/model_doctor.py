#!/usr/bin/env python3
import importlib.util
import json
import shutil
import sys


def present(module_name):
    return importlib.util.find_spec(module_name) is not None


result = {
    "python": sys.version.split()[0],
    "ffmpeg": shutil.which("ffmpeg"),
    "ffprobe": shutil.which("ffprobe"),
    "whisper": present("whisper"),
    "faster_whisper": present("faster_whisper"),
    "paddleocr": present("paddleocr"),
    "paddle": present("paddle"),
    "sentence_transformers": present("sentence_transformers"),
    "open_clip": present("open_clip"),
    "torchvision": present("torchvision"),
}

print(json.dumps(result, indent=2))
