#!/usr/bin/env python3
"""HTTP boundary for Arion local Python model runtimes.

The service owns Python model execution. Node workers call this process over
HTTP instead of spawning model scripts directly.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT_DIR / "scripts"
PROGRESS_PREFIX = "ARION_PROGRESS "

app = FastAPI(title="Arion Python Runtime Service", version="0.1.0")
MODEL_CACHE_LOCK = asyncio.Lock()
TEXT_EMBEDDING_MODELS: dict[str, Any] = {}
TEXT_EMBEDDING_LOAD_LOCKS: dict[str, asyncio.Lock] = {}
TEXT_EMBEDDING_ENCODE_LOCKS: dict[str, threading.RLock] = {}
VISUAL_EMBEDDING_MODELS: dict[str, dict[str, Any]] = {}
VISUAL_EMBEDDING_LOAD_LOCKS: dict[str, asyncio.Lock] = {}
VISUAL_EMBEDDING_ENCODE_LOCKS: dict[str, threading.RLock] = {}


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
    return await run_script_response(request, ["model_doctor.py"], body)


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
    return await run_script_response(request, args, body)


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
    return await run_script_response(request, args, body)


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
    return await run_script_response(request, args, body)


@app.post("/v1/embed-text")
async def embed_text(request: Request) -> JSONResponse:
    body = await request.json()
    kind = str(body.get("kind") or "passage")
    if kind not in {"query", "passage"}:
        raise HTTPException(status_code=400, detail="kind must be query or passage")
    model_name = str(body.get("model") or os.environ.get("EMBEDDING_MODEL") or "intfloat/multilingual-e5-base")
    texts = body.get("texts") or []
    if not isinstance(texts, list):
        raise HTTPException(status_code=400, detail="texts must be a list")
    return await run_cached_response(request, lambda: embed_text_cached(model_name, kind, texts))


@app.post("/v1/embed-visual")
async def embed_visual(request: Request) -> JSONResponse:
    body = await request.json()
    mode = str(body.get("mode") or "image")
    if mode not in {"image", "text"}:
        raise HTTPException(status_code=400, detail="mode must be image or text")
    model_name = str(body.get("model") or os.environ.get("VISUAL_EMBEDDING_MODEL") or "ViT-L-14")
    pretrained = str(body.get("pretrained") or os.environ.get("VISUAL_EMBEDDING_PRETRAINED") or "datacomp_xl_s13b_b90k")
    items = body.get("items") or []
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be a list")
    return await run_cached_response(request, lambda: embed_visual_cached(model_name, pretrained, mode, items))


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
    return await run_script_response(request, args, body)


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
    return await run_script_response(
        request,
        args,
        body,
        stdin_payload={"images": body.get("images") or []},
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
    return await run_script_response(
        request,
        args,
        body,
        stdin_payload={"segments": body.get("segments") or []},
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
    return await run_script_response(request, args, body, stdin_payload=stdin_payload)


async def run_cached_response(request: Request, task: Callable[[], Any]) -> JSONResponse:
    request_id = request.headers.get("x-request-id") or ""
    started = time.perf_counter()
    result = await task()
    return JSONResponse(
        {
            "ok": True,
            "result": result,
            "progressEvents": [],
            "stderr": None,
            "durationMs": round((time.perf_counter() - started) * 1000, 2),
            "requestId": request_id or None,
        }
    )


async def embed_text_cached(model_name: str, kind: str, texts: list[Any]) -> dict[str, Any]:
    try:
        model, lock = await get_text_embedding_model(model_name)
        return await asyncio.to_thread(encode_text_embeddings, model, lock, model_name, kind, texts)
    except Exception as error:
        return {
            "available": False,
            "provider": "sentence-transformers",
            "model": model_name,
            "kind": kind,
            "dimension": 0,
            "embeddings": [],
            "error": str(error),
        }


async def get_text_embedding_model(model_name: str) -> tuple[Any, threading.RLock]:
    async with MODEL_CACHE_LOCK:
        load_lock = TEXT_EMBEDDING_LOAD_LOCKS.setdefault(model_name, asyncio.Lock())
        encode_lock = TEXT_EMBEDDING_ENCODE_LOCKS.setdefault(model_name, threading.RLock())
    async with load_lock:
        model = TEXT_EMBEDDING_MODELS.get(model_name)
        if model is None:
            model = await asyncio.to_thread(load_text_embedding_model, model_name)
            TEXT_EMBEDDING_MODELS[model_name] = model
        return model, encode_lock


def load_text_embedding_model(model_name: str) -> Any:
    from sentence_transformers import SentenceTransformer

    with contextlib.redirect_stdout(sys.stderr):
        return SentenceTransformer(model_name)


def encode_text_embeddings(model: Any, lock: threading.RLock, model_name: str, kind: str, texts: list[Any]) -> dict[str, Any]:
    prefix = "query: " if kind == "query" else "passage: "
    prepared = [prefix + str(text).replace("\n", " ").strip() for text in texts]
    with sync_lock(lock):
        embeddings = model.encode(prepared, normalize_embeddings=True, show_progress_bar=False)
    vectors = normalize_vectors(embeddings)
    return {
        "available": True,
        "provider": "sentence-transformers",
        "model": model_name,
        "kind": kind,
        "dimension": len(vectors[0]) if vectors else 0,
        "embeddings": vectors,
    }


async def embed_visual_cached(model_name: str, pretrained: str, mode: str, items: list[Any]) -> dict[str, Any]:
    try:
        cached_model, lock = await get_visual_embedding_model(model_name, pretrained)
        return await asyncio.to_thread(encode_visual_embeddings, cached_model, lock, model_name, pretrained, mode, items)
    except Exception as error:
        return {
            "available": False,
            "provider": "open_clip",
            "model": model_name,
            "pretrained": pretrained,
            "mode": mode,
            "dimension": 0,
            "embeddings": [],
            "error": str(error),
        }


async def get_visual_embedding_model(model_name: str, pretrained: str) -> tuple[dict[str, Any], threading.RLock]:
    cache_key = f"{model_name}\0{pretrained}"
    async with MODEL_CACHE_LOCK:
        load_lock = VISUAL_EMBEDDING_LOAD_LOCKS.setdefault(cache_key, asyncio.Lock())
        encode_lock = VISUAL_EMBEDDING_ENCODE_LOCKS.setdefault(cache_key, threading.RLock())
    async with load_lock:
        cached_model = VISUAL_EMBEDDING_MODELS.get(cache_key)
        if cached_model is None:
            cached_model = await asyncio.to_thread(load_visual_embedding_model, model_name, pretrained)
            VISUAL_EMBEDDING_MODELS[cache_key] = cached_model
        return cached_model, encode_lock


def load_visual_embedding_model(model_name: str, pretrained: str) -> dict[str, Any]:
    import open_clip

    device = "cpu"
    with contextlib.redirect_stdout(sys.stderr), contextlib.redirect_stderr(sys.stderr):
        model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained, device=device)
        tokenizer = open_clip.get_tokenizer(model_name)
    model.eval()
    return {
        "device": device,
        "model": model,
        "preprocess": preprocess,
        "tokenizer": tokenizer,
    }


def encode_visual_embeddings(cached_model: dict[str, Any], lock: threading.RLock, model_name: str, pretrained: str, mode: str, items: list[Any]) -> dict[str, Any]:
    import torch
    from PIL import Image

    device = cached_model["device"]
    model = cached_model["model"]
    preprocess = cached_model["preprocess"]
    tokenizer = cached_model["tokenizer"]
    with sync_lock(lock), torch.no_grad():
        if mode == "image":
            tensors = []
            for image_path in items:
                with Image.open(str(image_path)) as image:
                    tensors.append(preprocess(image.convert("RGB")))
            features = model.encode_image(torch.stack(tensors).to(device)) if tensors else torch.empty((0, 512))
        else:
            texts = [str(text).replace("\n", " ").strip() for text in items]
            tokens = tokenizer(texts).to(device) if texts else torch.empty((0, 77), dtype=torch.long)
            features = model.encode_text(tokens) if texts else torch.empty((0, 512))

        if features.shape[0] > 0:
            features = features / features.norm(dim=-1, keepdim=True)
        vectors = normalize_vectors(features.cpu().tolist())

    return {
        "available": True,
        "provider": "open_clip",
        "model": model_name,
        "pretrained": pretrained,
        "mode": mode,
        "dimension": len(vectors[0]) if vectors else 0,
        "embeddings": vectors,
    }


def normalize_vectors(rows: Any) -> list[list[float]]:
    vectors = []
    for row in rows:
        vectors.append([round(float(value), 6) for value in row])
    return vectors


@contextlib.contextmanager
def sync_lock(lock: threading.RLock):
    with lock:
        yield


async def run_script_response(
    request: Request,
    args: list[str],
    body: dict[str, Any],
    *,
    stdin_payload: dict[str, Any] | None = None,
) -> JSONResponse:
    request_id = request.headers.get("x-request-id") or ""
    started = time.perf_counter()
    try:
        result = await run_script(args, stdin_payload=stdin_payload, request_id=request_id)
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    result["durationMs"] = round((time.perf_counter() - started) * 1000, 2)
    result["requestId"] = request_id or None
    return JSONResponse(result)


async def run_script(
    args: list[str],
    *,
    stdin_payload: dict[str, Any] | None = None,
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
    input_bytes = input_text.encode("utf-8") if input_text is not None else None
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE if input_bytes is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=ROOT_DIR,
            env=env,
            start_new_session=True,
        )
        stdout_bytes, stderr_bytes = await process.communicate(input=input_bytes)
    except asyncio.CancelledError:
        if process is not None:
            await terminate_process_group(process)
        raise

    stdout = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
    stderr = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""

    progress_events = parse_progress_events(stderr)
    if process.returncode != 0:
        detail = stderr.strip() or stdout.strip() or f"{args[0]} exited with code {process.returncode}"
        raise RuntimeError(detail)

    return {
        "ok": True,
        "result": parse_json_output(stdout),
        "progressEvents": progress_events,
        "stderr": trim_stderr(stderr),
    }


async def terminate_process_group(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    await process.wait()


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
    uvicorn.run(app, host=host, port=port, lifespan="off")
