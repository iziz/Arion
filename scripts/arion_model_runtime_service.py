#!/usr/bin/env python3
"""HTTP boundary for Arion local Python model runtimes.

The service owns Python model execution. Node workers call this process over
HTTP instead of spawning model scripts directly.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT_DIR / "scripts"
PROGRESS_PREFIX = "ARION_PROGRESS "

app = FastAPI(title="Arion Python Runtime Service", version="0.1.0")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "arion-python-runtime",
        "python": sys.executable,
        "cwd": str(ROOT_DIR),
    }


@app.post("/v1/model-doctor")
async def model_doctor(request: Request) -> JSONResponse:
    body = await request.json()
    return run_script_response(request, ["model_doctor.py"], body, timeout_ms=optional_positive_int(body.get("timeoutMs")))


@app.post("/v1/whisper")
async def whisper(request: Request) -> JSONResponse:
    body = await request.json()
    args = [
        "whisper_transcribe.py",
        require_string(body, "mediaPath"),
        "--model",
        str(body.get("model") or os.environ.get("WHISPER_MODEL") or "large-v3"),
        "--backend",
        str(body.get("backend") or os.environ.get("WHISPER_BACKEND") or "auto"),
    ]
    language = normalize_auto(body.get("language"))
    if language:
        args.extend(["--language", language])
    return run_script_response(request, args, body, timeout_ms=optional_positive_int(body.get("timeoutMs")))


@app.post("/v1/whisperx")
async def whisperx(request: Request) -> JSONResponse:
    body = await request.json()
    args = [
        "whisperx_diarize.py",
        require_string(body, "audioPath"),
        "--model",
        str(body.get("model") or os.environ.get("WHISPERX_MODEL") or os.environ.get("WHISPER_MODEL") or "large-v3"),
    ]
    language = normalize_auto(body.get("language"))
    if language:
        args.extend(["--language", language])
    segments_json = normalize_auto(body.get("segmentsJsonPath"))
    if segments_json:
        args.extend(["--segments-json", segments_json])
    return run_script_response(request, args, body, timeout_ms=optional_positive_int(body.get("timeoutMs")))


@app.post("/v1/paddleocr")
async def paddleocr(request: Request) -> JSONResponse:
    body = await request.json()
    args = [
        "paddle_ocr_extract.py",
        require_string(body, "framesDir"),
        "--lang",
        str(body.get("language") or os.environ.get("PADDLEOCR_LANG") or "en"),
        "--subtitle-interval",
        str(body.get("subtitleIntervalSeconds") or 0.5),
        "--full-interval",
        str(body.get("fullIntervalSeconds") or 10),
        "--workers",
        str(body.get("workers") or os.environ.get("PADDLEOCR_WORKERS") or 2),
    ]
    return run_script_response(request, args, body, timeout_ms=optional_positive_int(body.get("timeoutMs")))


@app.post("/v1/embed-text")
async def embed_text(request: Request) -> JSONResponse:
    body = await request.json()
    kind = str(body.get("kind") or "passage")
    if kind not in {"query", "passage"}:
        raise HTTPException(status_code=400, detail="kind must be query or passage")
    args = [
        "embed_text.py",
        "--model",
        str(body.get("model") or os.environ.get("EMBEDDING_MODEL") or "intfloat/multilingual-e5-base"),
        "--kind",
        kind,
    ]
    stdin_payload = {"texts": body.get("texts") or []}
    return run_script_response(request, args, body, stdin_payload=stdin_payload, timeout_ms=optional_positive_int(body.get("timeoutMs")))


@app.post("/v1/embed-visual")
async def embed_visual(request: Request) -> JSONResponse:
    body = await request.json()
    mode = str(body.get("mode") or "image")
    if mode not in {"image", "text"}:
        raise HTTPException(status_code=400, detail="mode must be image or text")
    args = [
        "embed_visual.py",
        "--model",
        str(body.get("model") or os.environ.get("VISUAL_EMBEDDING_MODEL") or "ViT-L-14"),
        "--pretrained",
        str(body.get("pretrained") or os.environ.get("VISUAL_EMBEDDING_PRETRAINED") or "datacomp_xl_s13b_b90k"),
        "--mode",
        mode,
    ]
    stdin_payload = {"images": body.get("items") or []} if mode == "image" else {"texts": body.get("items") or []}
    return run_script_response(request, args, body, stdin_payload=stdin_payload, timeout_ms=optional_positive_int(body.get("timeoutMs")))


@app.post("/v1/detect-scenes")
async def detect_scenes(request: Request) -> JSONResponse:
    body = await request.json()
    args = [
        "detect_scenes.py",
        require_string(body, "mediaPath"),
        "--detector",
        str(body.get("detector") or os.environ.get("SCENE_DETECTOR") or "adaptive"),
        "--threshold",
        str(body.get("threshold") or os.environ.get("SCENE_CONTENT_THRESHOLD") or "27.0"),
        "--adaptive-threshold",
        str(body.get("adaptiveThreshold") or os.environ.get("SCENE_ADAPTIVE_THRESHOLD") or "3.0"),
        "--min-scene-len",
        str(body.get("minSceneLen") or os.environ.get("SCENE_MIN_LEN_FRAMES") or "15"),
    ]
    return run_script_response(request, args, body, timeout_ms=optional_positive_int(body.get("timeoutMs")))


@app.post("/v1/detect-objects")
async def detect_objects(request: Request) -> JSONResponse:
    body = await request.json()
    args = [
        "detect_objects.py",
        "--backend",
        str(body.get("backend") or os.environ.get("VISION_DETECTOR_BACKEND") or "auto"),
        "--model",
        str(body.get("model") or os.environ.get("VISION_DETECTOR_MODEL") or "yolo11n.pt"),
        "--rfdetr-model",
        str(body.get("rfDetrModel") or os.environ.get("VISION_RFDETR_MODEL") or "RFDETRNano"),
        "--conf",
        str(body.get("confidence") or os.environ.get("VISION_DETECTOR_CONF") or "0.25"),
    ]
    if bool(body.get("allowHeuristicFallback")):
        args.append("--allow-heuristic-fallback")
    return run_script_response(
        request,
        args,
        body,
        stdin_payload={"images": body.get("images") or []},
        timeout_ms=optional_positive_int(body.get("timeoutMs")),
    )


@app.post("/v1/track-objects")
async def track_objects(request: Request) -> JSONResponse:
    body = await request.json()
    args = [
        "track_objects.py",
        require_string(body, "mediaPath"),
        "--model",
        str(body.get("model") or os.environ.get("VISION_DETECTOR_MODEL") or "yolo11n.pt"),
        "--tracker",
        str(body.get("tracker") or os.environ.get("VISION_TRACKER") or "bytetrack.yaml"),
        "--conf",
        str(body.get("confidence") or os.environ.get("VISION_TRACKER_CONF") or "0.2"),
        "--vid-stride",
        str(body.get("vidStride") or os.environ.get("VISION_TRACKER_VID_STRIDE") or "3"),
    ]
    return run_script_response(
        request,
        args,
        body,
        stdin_payload={"segments": body.get("segments") or []},
        timeout_ms=optional_positive_int(body.get("timeoutMs")),
    )


@app.post("/v1/soccernet-action-spotting")
async def soccernet_action_spotting(request: Request) -> JSONResponse:
    body = await request.json()
    args = [
        "soccernet_action_spotting.py",
        require_string(body, "mediaPath"),
        "--model",
        str(body.get("model") or os.environ.get("SOCCERNET_ACTION_SPOTTING_MODEL") or "external"),
    ]
    stdin_payload = {"duration": body.get("duration"), "segments": body.get("segments") or []}
    return run_script_response(request, args, body, stdin_payload=stdin_payload, timeout_ms=optional_positive_int(body.get("timeoutMs")))


def run_script_response(
    request: Request,
    args: list[str],
    body: dict[str, Any],
    *,
    stdin_payload: dict[str, Any] | None = None,
    timeout_ms: int | None = None,
) -> JSONResponse:
    request_id = request.headers.get("x-request-id") or ""
    started = time.perf_counter()
    try:
        result = run_script(args, stdin_payload=stdin_payload, timeout_ms=timeout_ms, request_id=request_id)
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    result["durationMs"] = round((time.perf_counter() - started) * 1000, 2)
    result["requestId"] = request_id or None
    return JSONResponse(result)


def run_script(
    args: list[str],
    *,
    stdin_payload: dict[str, Any] | None = None,
    timeout_ms: int | None = None,
    request_id: str = "",
) -> dict[str, Any]:
    script = SCRIPT_DIR / args[0]
    if not script.exists():
        raise RuntimeError(f"Runtime script not found: {script}")

    command = [sys.executable, str(script), *args[1:]]
    env = {
        **os.environ,
        "ARION_PYTHON_RUNTIME_SERVICE": "true",
        "ARION_RUNTIME_SERVICE_REQUEST_ID": request_id,
    }
    env.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    input_text = json.dumps(stdin_payload, ensure_ascii=False) if stdin_payload is not None else None
    try:
        completed = subprocess.run(
            command,
            input=input_text,
            cwd=ROOT_DIR,
            env=env,
            text=True,
            capture_output=True,
            check=False,
            timeout=(timeout_ms / 1000) if timeout_ms and timeout_ms > 0 else None,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"{args[0]} exceeded safety limit after {timeout_ms}ms") from error

    progress_events = parse_progress_events(completed.stderr)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or f"{args[0]} exited with code {completed.returncode}"
        raise RuntimeError(detail)

    return {
        "ok": True,
        "result": parse_json_output(completed.stdout),
        "progressEvents": progress_events,
        "stderr": trim_stderr(completed.stderr),
    }


def parse_json_output(stdout: str) -> Any:
    stripped = stdout.strip()
    if stripped:
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("{") and line.endswith("}"):
            return json.loads(line)
    raise RuntimeError(f"Runtime script did not return JSON. Last output: {(lines[-1] if lines else 'empty')[:240]}")


def parse_progress_events(stderr: str) -> list[dict[str, Any]]:
    events = []
    for line in stderr.splitlines():
        trimmed = line.strip()
        if not trimmed.startswith(PROGRESS_PREFIX):
            continue
        try:
            event = json.loads(trimmed[len(PROGRESS_PREFIX) :])
        except json.JSONDecodeError:
            continue
        if event.get("type") == "progress":
            events.append(event)
    return events


def trim_stderr(stderr: str) -> str:
    lines = [line for line in stderr.splitlines() if not line.strip().startswith(PROGRESS_PREFIX)]
    return "\n".join(lines)[-4000:]


def require_string(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail=f"{key} is required")
    return value


def normalize_auto(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "auto":
        return None
    return text


def optional_positive_int(value: Any) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = int(float(str(value)))
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def load_dotenv() -> None:
    env_path = ROOT_DIR / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        os.environ[key] = value


if __name__ == "__main__":
    load_dotenv()
    import uvicorn

    host = os.environ.get("PYTHON_RUNTIME_SERVICE_HOST", "127.0.0.1")
    port = int(os.environ.get("PYTHON_RUNTIME_SERVICE_PORT", "8792"))
    uvicorn.run(app, host=host, port=port)
