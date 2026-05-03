#!/usr/bin/env python3
"""Qwen2.5-VL worker for sports video segment structuring."""

from __future__ import annotations

import json
import os
import platform
import re
import threading
from functools import lru_cache
from importlib.util import find_spec
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel


DEFAULT_TRANSFORMERS_MODEL = os.environ.get("QWEN_VLM_TRANSFORMERS_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")
DEFAULT_MLX_MODEL = os.environ.get("QWEN_VLM_MLX_MODEL", "mlx-community/Qwen2.5-VL-7B-Instruct-4bit")
REQUESTED_BACKEND = os.environ.get("QWEN_VLM_BACKEND", "auto").strip().lower()
DEFAULT_BACKEND = "mlx" if platform.system() == "Darwin" and find_spec("mlx_vlm") else "transformers"
BACKEND = DEFAULT_BACKEND if REQUESTED_BACKEND in ("", "auto") else REQUESTED_BACKEND
DEFAULT_MODEL = os.environ.get("QWEN_VLM_MODEL", DEFAULT_MLX_MODEL if BACKEND == "mlx" else DEFAULT_TRANSFORMERS_MODEL)
DEFAULT_DEVICE_MAP = "mps" if platform.system() == "Darwin" else "auto"
DEVICE_MAP = os.environ.get("QWEN_VLM_DEVICE_MAP", DEFAULT_DEVICE_MAP)
TORCH_DTYPE = os.environ.get("QWEN_VLM_TORCH_DTYPE", "float32" if DEVICE_MAP == "cpu" else "auto")
MAX_NEW_TOKENS = int(os.environ.get("QWEN_VLM_MAX_NEW_TOKENS", "384"))
MODEL_LOAD_LOCK = threading.Lock()


class StructureRequest(BaseModel):
    domain: str = "sports.football"
    ontologyVersion: str = "sports-domain-v1"
    model: str | None = None
    imagePath: str | None = None
    asset: dict[str, Any] = {}
    index: dict[str, Any] = {}
    segment: dict[str, Any] = {}


app = FastAPI(title="Arion Qwen VLM Worker", version="0.1.0")


@app.get("/health")
def health() -> dict[str, Any]:
    backend_error = _backend_error()
    return {
        "ok": backend_error is None,
        "backend": f"qwen2.5-vl:{BACKEND}",
        "model": DEFAULT_MODEL,
        "loaded": _model_loaded(),
        "error": backend_error,
    }


@app.post("/structure/sports-event")
async def structure_sports_event(request: StructureRequest) -> dict[str, Any]:
    if request.domain not in ("sports.football", "sports.american_football"):
        return _empty_response("Unsupported domain.")

    output_text = _generate_text(request)
    parsed = _parse_json(output_text)
    if not parsed:
        return _empty_response("Model did not return parseable JSON.", raw=output_text)

    parsed.setdefault("domain", request.domain)
    return _normalize_response(parsed, output_text)


def _model_loaded() -> bool:
    return "_cached_model" in globals()


@lru_cache(maxsize=1)
def _load_model():
    with MODEL_LOAD_LOCK:
        return _load_model_once()


@lru_cache(maxsize=1)
def _load_model_once():
    if BACKEND == "mlx":
        return _load_mlx_model_once()
    if BACKEND != "transformers":
        raise ValueError(f"Unsupported QWEN_VLM_BACKEND: {BACKEND}")
    return _load_transformers_model_once()


def _backend_error() -> str | None:
    if BACKEND == "mlx" and not find_spec("mlx_vlm"):
        return "QWEN_VLM_BACKEND=mlx requires mlx-vlm in this Python environment."
    if BACKEND == "transformers" and not find_spec("transformers"):
        return "QWEN_VLM_BACKEND=transformers requires transformers in this Python environment."
    if BACKEND not in ("mlx", "transformers"):
        return f"Unsupported QWEN_VLM_BACKEND: {BACKEND}"
    return None


def _load_transformers_model_once():
    import torch
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

    dtype = _torch_dtype(torch)
    if DEVICE_MAP == "mps":
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(DEFAULT_MODEL, torch_dtype=dtype).to("mps")
    else:
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            DEFAULT_MODEL,
            torch_dtype=dtype,
            device_map=DEVICE_MAP,
        )
    processor = AutoProcessor.from_pretrained(DEFAULT_MODEL)
    globals()["_cached_model"] = model
    return model, processor


def _load_mlx_model_once():
    from mlx_vlm import load

    model, processor = load(DEFAULT_MODEL)
    globals()["_cached_model"] = model
    return model, processor


def _generate_text(request: StructureRequest) -> str:
    if BACKEND == "mlx":
        return _generate_text_with_mlx(request)
    return _generate_text_with_transformers(request)


def _generate_text_with_transformers(request: StructureRequest) -> str:
    model, processor = _load_model()
    messages = _build_messages(request)
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, video_inputs = _process_vision_info(messages)
    inputs = processor(
        text=[text],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    )
    inputs = inputs.to(model.device)
    generated_ids = model.generate(**inputs, max_new_tokens=MAX_NEW_TOKENS)
    generated_ids_trimmed = [
        output_ids[len(input_ids) :] for input_ids, output_ids in zip(inputs.input_ids, generated_ids)
    ]
    return processor.batch_decode(
        generated_ids_trimmed,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )[0]


def _generate_text_with_mlx(request: StructureRequest) -> str:
    from mlx_vlm import apply_chat_template, generate

    model, processor = _load_model()
    messages = _build_messages(request)
    image_path = _image_path(request)
    prompt = apply_chat_template(
        processor,
        model.config,
        messages,
        add_generation_prompt=True,
        num_images=1 if image_path else 0,
    )
    result = generate(
        model,
        processor,
        prompt,
        image=[image_path] if image_path else None,
        max_tokens=MAX_NEW_TOKENS,
        temperature=0.0,
        verbose=False,
    )
    return result.text


def _torch_dtype(torch_module):
    if TORCH_DTYPE == "float32":
        return torch_module.float32
    if TORCH_DTYPE == "float16":
        return torch_module.float16
    if TORCH_DTYPE == "bfloat16":
        return torch_module.bfloat16
    return "auto"


def _process_vision_info(messages):
    from qwen_vl_utils import process_vision_info

    return process_vision_info(messages)


def _image_path(request: StructureRequest) -> str | None:
    return request.imagePath if request.imagePath and os.path.exists(request.imagePath) else None


def _build_messages(request: StructureRequest) -> list[dict[str, Any]]:
    segment = request.segment
    scene_data = segment.get("sceneData") or {}
    text = scene_data.get("text") or {}
    existing_domain = segment.get("existingDomain") or {}
    shape = (
        "{\"caption\":\"...\",\"eventType\":\"pass_receive|shot|dribble|pressure|save|progressive_pass|scene\","
        "\"confidence\":0.0,\"labels\":[\"sports.football\"],\"evidence\":[\"...\"],"
        "\"football\":{\"phase\":\"attack|transition|set_piece|unknown\",\"fieldZone\":\"defensive_third|middle_third|final_third|penalty_area|unknown\","
        "\"passType\":\"through_ball|cross|cutback|short_pass|long_ball|unknown\","
        "\"receivingPlayer\":{\"present\":false,\"name\":null,\"confidence\":0.0},"
        "\"passingPlayer\":{\"present\":false,\"name\":null,\"confidence\":0.0},"
        "\"ballState\":\"in_play|pass_travel|shot|unknown\",\"attackingDirection\":\"left_to_right|right_to_left|unknown\"}}"
    )
    if request.domain == "sports.american_football":
        shape = (
            "{\"domain\":\"sports.american_football\",\"caption\":\"...\","
            "\"eventType\":\"scramble|pressure|pocket_escape|throw_on_run|scene\","
            "\"confidence\":0.0,\"labels\":[\"sports.american_football\"],\"evidence\":[\"...\"],"
            "\"americanFootball\":{\"phase\":\"dropback|designed_run|scramble|play_action|unknown\","
            "\"playType\":\"scramble|pocket_escape|throw_on_run|pressure|pass|rush|unknown\","
            "\"quarterback\":{\"present\":false,\"name\":null,\"confidence\":0.0},"
            "\"pressure\":{\"present\":false,\"confidence\":0.0,\"source\":\"text|vision|vlm|unknown\"},"
            "\"pocket\":{\"status\":\"intact|collapsing|escaped|unknown\",\"confidence\":0.0},"
            "\"decision\":{\"outcome\":\"run|throw|sack_avoidance|unknown\",\"confidence\":0.0}}}"
        )
    prompt = {
        "task": (
            "Return compact valid JSON only, no markdown. "
            f"Use this exact shape: {shape}"
        ),
        "domain": request.domain,
        "asset": {
            "title": request.asset.get("title"),
            "description": request.asset.get("description"),
            "tags": request.asset.get("tags"),
        },
        "segment": {
            "start": segment.get("start"),
            "end": segment.get("end"),
            "label": segment.get("label"),
            "transcript": segment.get("transcript"),
            "speech": text.get("speech"),
            "subtitles": text.get("subtitles"),
            "screenText": text.get("screenText"),
            "existingCaptions": existing_domain.get("captions"),
            "existingLabels": existing_domain.get("labels"),
        },
        "instruction": "Set player name to null unless supported by visible shirt/name text or indexed text.",
    }
    content: list[dict[str, Any]] = []
    if _image_path(request):
        content.append({"type": "image", "image": request.imagePath})
    content.append({"type": "text", "text": json.dumps(prompt, ensure_ascii=False)})
    return [{"role": "user", "content": content}]


def _parse_json(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?", "", stripped).strip()
        stripped = re.sub(r"```$", "", stripped).strip()
    candidates = [stripped]
    match = re.search(r"\{.*\}", stripped, re.DOTALL)
    if match:
        candidates.append(match.group(0))
    for candidate in candidates:
        try:
            value = json.loads(candidate)
            return value if isinstance(value, dict) else None
        except json.JSONDecodeError:
            continue
    return None


def _normalize_response(parsed: dict[str, Any], raw: str) -> dict[str, Any]:
    domain = str(parsed.get("domain") or "sports.football").strip()
    if domain == "sports.american_football":
        return _normalize_american_football_response(parsed, raw)
    football = parsed.get("football") if isinstance(parsed.get("football"), dict) else {}
    labels = parsed.get("labels")
    if isinstance(labels, dict):
        labels = [key for key, value in labels.items() if value]
    return {
        "domain": "sports.football",
        "provider": f"qwen2.5-vl:{BACKEND}",
        "model": DEFAULT_MODEL,
        "caption": str(parsed.get("caption") or "").strip(),
        "eventType": str(parsed.get("eventType") or "scene").strip(),
        "confidence": _confidence(parsed.get("confidence")),
        "labels": labels if isinstance(labels, list) else [],
        "evidence": _evidence(parsed.get("evidence"), raw),
        "rawResponse": raw[:2000],
        "football": {
            "phase": football.get("phase", "unknown"),
            "fieldZone": football.get("fieldZone", "unknown"),
            "passType": football.get("passType", "unknown"),
            "receivingPlayer": _role(football.get("receivingPlayer")),
            "passingPlayer": _role(football.get("passingPlayer")),
            "ballState": football.get("ballState", "unknown"),
            "attackingDirection": football.get("attackingDirection", "unknown"),
        },
    }


def _normalize_american_football_response(parsed: dict[str, Any], raw: str) -> dict[str, Any]:
    american = parsed.get("americanFootball") if isinstance(parsed.get("americanFootball"), dict) else {}
    labels = parsed.get("labels")
    if isinstance(labels, dict):
        labels = [key for key, value in labels.items() if value]
    pressure = american.get("pressure") if isinstance(american.get("pressure"), dict) else {}
    pocket = american.get("pocket") if isinstance(american.get("pocket"), dict) else {}
    decision = american.get("decision") if isinstance(american.get("decision"), dict) else {}
    return {
        "domain": "sports.american_football",
        "provider": f"qwen2.5-vl:{BACKEND}",
        "model": DEFAULT_MODEL,
        "caption": str(parsed.get("caption") or "").strip(),
        "eventType": str(parsed.get("eventType") or "scene").strip(),
        "confidence": _confidence(parsed.get("confidence")),
        "labels": labels if isinstance(labels, list) else [],
        "evidence": _evidence(parsed.get("evidence"), raw),
        "rawResponse": raw[:2000],
        "americanFootball": {
            "phase": american.get("phase", "unknown"),
            "playType": american.get("playType", "unknown"),
            "quarterback": _role(american.get("quarterback")),
            "pressure": {
                "present": bool(pressure.get("present")),
                "confidence": _confidence(pressure.get("confidence")),
                "source": pressure.get("source", "unknown"),
            },
            "pocket": {
                "status": pocket.get("status", "unknown"),
                "confidence": _confidence(pocket.get("confidence")),
            },
            "decision": {
                "outcome": decision.get("outcome", "unknown"),
                "confidence": _confidence(decision.get("confidence")),
            },
        },
    }


def _role(value: Any) -> dict[str, Any]:
    role = value if isinstance(value, dict) else {}
    return {
        "present": bool(role.get("present")),
        "name": role.get("name") if role.get("name") else None,
        "confidence": _confidence(role.get("confidence")),
        "trackId": role.get("trackId") if role.get("trackId") else None,
    }


def _evidence(value: Any, raw: str) -> list[str]:
    if not isinstance(value, list):
        return [raw[:240]]
    evidence: list[str] = []
    for item in value[:6]:
        if isinstance(item, str):
            evidence.append(item)
        else:
            evidence.append(json.dumps(item, ensure_ascii=False)[:240])
    return evidence


def _confidence(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _empty_response(reason: str, raw: str = "") -> dict[str, Any]:
    return {
        "provider": f"qwen2.5-vl:{BACKEND}",
        "model": DEFAULT_MODEL,
        "caption": "",
        "eventType": "scene",
        "confidence": 0,
        "labels": [],
        "evidence": [reason, raw[:240]] if raw else [reason],
        "rawResponse": raw[:2000] if raw else "",
        "football": {
            "phase": "unknown",
            "fieldZone": "unknown",
            "passType": "unknown",
            "receivingPlayer": {"present": False, "name": None, "confidence": 0},
            "passingPlayer": {"present": False, "name": None, "confidence": 0},
            "ballState": "unknown",
            "attackingDirection": "unknown",
        },
    }


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("QWEN_VLM_HOST", "127.0.0.1")
    port = int(os.environ.get("QWEN_VLM_PORT", "8791"))
    uvicorn.run(app, host=host, port=port)
