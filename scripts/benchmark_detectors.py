#!/usr/bin/env python3
"""Benchmark Arion object detector backends on a frame manifest.

Manifest shape:
{
  "images": ["/abs/frame-001.jpg", "/abs/frame-002.jpg"],
  "backends": ["ultralytics", "rfdetr"]
}
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark Arion detector backends.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--backend", action="append", choices=["ultralytics", "rfdetr"], help="Override manifest backends.")
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--rfdetr-model", default="RFDETRNano")
    parser.add_argument("--conf", default="0.25")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    images = manifest.get("images") or []
    if not isinstance(images, list) or not images:
        raise ValueError("manifest.images must contain at least one image path")
    backends = args.backend or manifest.get("backends") or ["ultralytics", "rfdetr"]
    if not isinstance(backends, list):
        raise ValueError("manifest.backends must be an array")

    results = [
        benchmark_backend(args.python, str(backend), images, args.model, args.rfdetr_model, args.conf)
        for backend in backends
    ]
    summary = {
        "ok": all(item["ok"] for item in results),
        "images": len(images),
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ok"] else 1


def benchmark_backend(python_bin: str, backend: str, images: list[Any], model: str, rfdetr_model: str, conf: str) -> dict[str, Any]:
    started = time.perf_counter()
    command = [
        python_bin,
        "scripts/detect_objects.py",
        "--backend",
        backend,
        "--model",
        model,
        "--rfdetr-model",
        rfdetr_model,
        "--conf",
        conf,
    ]
    process = subprocess.run(
        command,
        input=json.dumps({"images": images}, ensure_ascii=False),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    latency_ms = round((time.perf_counter() - started) * 1000, 2)
    if process.returncode != 0:
        return {
            "backend": backend,
            "ok": False,
            "latencyMs": latency_ms,
            "error": process.stderr[-1200:] or f"detect_objects.py exited {process.returncode}",
        }
    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        return {
            "backend": backend,
            "ok": False,
            "latencyMs": latency_ms,
            "error": f"detector returned non-JSON output: {error}",
        }
    frames = payload.get("frames") if isinstance(payload, dict) else []
    detections = sum(len(frame.get("detections") or []) for frame in frames if isinstance(frame, dict))
    return {
        "backend": backend,
        "ok": bool(payload.get("available")) if isinstance(payload, dict) else False,
        "provider": payload.get("provider") if isinstance(payload, dict) else None,
        "model": payload.get("model") if isinstance(payload, dict) else None,
        "latencyMs": latency_ms,
        "frames": len(frames) if isinstance(frames, list) else 0,
        "detections": detections,
        "stderr": process.stderr[-1200:] or None,
    }


if __name__ == "__main__":
    sys.exit(main())
