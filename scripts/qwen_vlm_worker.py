#!/usr/bin/env python3
"""Qwen2.5-VL worker for sports video segment structuring."""

from __future__ import annotations

import json
import os
import platform
import re
import threading
from functools import lru_cache
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel


DEFAULT_MODEL = os.environ.get("QWEN_VLM_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
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
    return {
        "ok": True,
        "backend": "qwen2.5-vl",
        "model": DEFAULT_MODEL,
        "loaded": _model_loaded(),
    }


@app.post("/structure/sports-event")
def structure_sports_event(request: StructureRequest) -> dict[str, Any]:
    if request.domain != "sports.football":
        return _empty_response("Unsupported domain.")

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
    output_text = processor.batch_decode(
        generated_ids_trimmed,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )[0]
    parsed = _parse_json(output_text)
    if not parsed:
        return _empty_response("Model did not return parseable JSON.", raw=output_text)

    return _normalize_response(parsed, output_text)


def _model_loaded() -> bool:
    return "_cached_model" in globals()


@lru_cache(maxsize=1)
def _load_model():
    with MODEL_LOAD_LOCK:
        return _load_model_once()


@lru_cache(maxsize=1)
def _load_model_once():
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


def _build_messages(request: StructureRequest) -> list[dict[str, Any]]:
    segment = request.segment
    scene_data = segment.get("sceneData") or {}
    text = scene_data.get("text") or {}
    existing_domain = segment.get("existingDomain") or {}
    prompt = {
        "task": (
            "Return compact valid JSON only, no markdown. "
            "Use this exact shape: "
            "{\"caption\":\"...\",\"eventType\":\"pass_receive|shot|dribble|pressure|save|progressive_pass|scene\","
            "\"confidence\":0.0,\"labels\":[\"sports.football\"],\"evidence\":[\"...\"],"
            "\"football\":{\"phase\":\"attack|transition|set_piece|unknown\",\"fieldZone\":\"defensive_third|middle_third|final_third|penalty_area|unknown\","
            "\"passType\":\"through_ball|cross|cutback|short_pass|long_ball|unknown\","
            "\"receivingPlayer\":{\"present\":false,\"name\":null,\"confidence\":0.0},"
            "\"passingPlayer\":{\"present\":false,\"name\":null,\"confidence\":0.0},"
            "\"ballState\":\"in_play|pass_travel|shot|unknown\",\"attackingDirection\":\"left_to_right|right_to_left|unknown\"}}"
        ),
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
    if request.imagePath and os.path.exists(request.imagePath):
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
    football = parsed.get("football") if isinstance(parsed.get("football"), dict) else {}
    labels = parsed.get("labels")
    if isinstance(labels, dict):
        labels = [key for key, value in labels.items() if value]
    return {
        "provider": "qwen2.5-vl",
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
        "provider": "qwen2.5-vl",
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
