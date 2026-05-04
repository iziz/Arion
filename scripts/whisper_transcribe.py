#!/usr/bin/env python3
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile


def main():
    configure_threading()
    parser = argparse.ArgumentParser(description="Transcribe audio/video with a local Whisper implementation.")
    parser.add_argument("media_path")
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "large-v3"))
    parser.add_argument("--language", default=os.environ.get("WHISPER_LANGUAGE"))
    parser.add_argument("--backend", default=os.environ.get("WHISPER_BACKEND", "auto"))
    args = parser.parse_args()
    language = normalize_auto(args.language)
    backend = normalize_backend(args.backend)

    errors = []
    for candidate in backend_candidates(backend):
        try:
            emit_progress(2, f"Preparing {display_backend(candidate)} ASR backend")
            if candidate == "whispercpp":
                result = transcribe_with_whispercpp(args.media_path, args.model, language)
            elif candidate == "faster-whisper":
                result = transcribe_with_faster_whisper(args.media_path, args.model, language)
            elif candidate == "openai-whisper":
                result = transcribe_with_openai_whisper(args.media_path, args.model, language)
            else:
                raise ValueError(f"Unsupported Whisper backend: {candidate}")
            emit_result(result)
            return
        except Exception as error:
            errors.append(f"{candidate}: {type(error).__name__}: {error}")
            if backend != "auto":
                break

    emit_result(
        {
            "available": False,
            "provider": "none",
            "transcript": "",
            "language": "unknown",
            "confidence": 0,
            "segments": [],
            "error": "; ".join(errors) if errors else "No Whisper backend was attempted.",
        }
    )


def normalize_backend(value):
    normalized = str(value or "auto").strip().lower().replace("_", "-")
    aliases = {
        "faster": "faster-whisper",
        "fasterwhisper": "faster-whisper",
        "openai": "openai-whisper",
        "whisper": "openai-whisper",
        "whisper-cpp": "whispercpp",
        "whisper.cpp": "whispercpp",
        "cpp": "whispercpp",
    }
    return aliases.get(normalized, normalized)


def display_backend(value):
    labels = {
        "whispercpp": "whisper.cpp",
        "faster-whisper": "Faster-Whisper",
        "openai-whisper": "OpenAI Whisper",
    }
    return labels.get(value, value)


def backend_candidates(backend):
    if backend == "auto":
        candidates = []
        if whispercpp_configured():
            candidates.append("whispercpp")
        return candidates + ["faster-whisper", "openai-whisper"]
    if backend in {"whispercpp", "faster-whisper", "openai-whisper"}:
        return [backend]
    raise ValueError(f"Unsupported WHISPER_BACKEND={backend}")


def whispercpp_configured():
    return bool(os.environ.get("WHISPER_CPP_BIN") or os.environ.get("WHISPER_CPP_MODEL") or default_whispercpp_bin())


def default_whispercpp_bin():
    candidates = [
        os.path.join(os.getcwd(), ".local", "whisper.cpp", "build", "bin", "whisper-cli"),
        os.path.join(os.getcwd(), "whisper.cpp", "build", "bin", "whisper-cli"),
    ]
    return next((candidate for candidate in candidates if os.path.isfile(candidate) and os.access(candidate, os.X_OK)), None) or shutil.which("whisper-cli")


def resolve_whispercpp_bin():
    configured = normalize_auto(os.environ.get("WHISPER_CPP_BIN"))
    if configured:
        if os.path.isfile(configured) and os.access(configured, os.X_OK):
            return configured
        resolved = shutil.which(configured)
        if resolved:
            return resolved
        raise RuntimeError(f"WHISPER_CPP_BIN is not executable: {configured}")
    discovered = default_whispercpp_bin()
    if discovered:
        return discovered
    raise RuntimeError("whisper.cpp binary not found. Set WHISPER_CPP_BIN to whisper-cli.")


def resolve_whispercpp_model(model_name):
    configured = normalize_auto(os.environ.get("WHISPER_CPP_MODEL"))
    candidates = []
    if configured:
        candidates.append(configured)
    if model_name:
        candidates.append(model_name)
        normalized_name = model_name
        if not normalized_name.startswith("ggml-"):
            normalized_name = f"ggml-{normalized_name}"
        if not normalized_name.endswith(".bin"):
            normalized_name = f"{normalized_name}.bin"
        candidates.extend(
            [
                os.path.join(os.getcwd(), ".local", "whisper.cpp", "models", normalized_name),
                os.path.join(os.getcwd(), "whisper.cpp", "models", normalized_name),
            ]
        )
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    raise RuntimeError("whisper.cpp model not found. Set WHISPER_CPP_MODEL to a ggml model .bin file.")


def transcribe_with_whispercpp(media_path, model_name, language):
    whisper_bin = resolve_whispercpp_bin()
    model_path = resolve_whispercpp_model(model_name)
    emit_progress(8, f"Running whisper.cpp ASR with {os.path.basename(model_path)}")
    with tempfile.TemporaryDirectory(prefix="arion-whispercpp-") as temp_dir:
        output_prefix = os.path.join(temp_dir, "transcript")
        command = [
            whisper_bin,
            "-m",
            model_path,
            "-f",
            media_path,
            "-oj",
            "-of",
            output_prefix,
        ]
        command.extend(["-l", language or "auto"])
        threads = optional_positive_int(os.environ.get("WHISPER_CPP_THREADS") or os.environ.get("WHISPER_CPU_THREADS"))
        if threads is not None:
            command.extend(["-t", str(threads)])
        extra_args = normalize_auto(os.environ.get("WHISPER_CPP_EXTRA_ARGS"))
        if extra_args:
            command.extend(shlex.split(extra_args))
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(f"whisper-cli exited with {completed.returncode}: {completed.stderr.strip() or completed.stdout.strip()}")
        payload = read_whispercpp_json(output_prefix, completed.stdout)
    emit_progress(98, "Finalizing whisper.cpp transcript")
    segments = normalize_whispercpp_segments(payload)
    transcript = " ".join(segment["text"] for segment in segments).strip() or str(payload.get("text") or payload.get("transcript") or "").strip()
    return {
        "available": True,
        "provider": "whisper.cpp",
        "model": os.path.basename(model_path),
        "transcript": transcript,
        "language": infer_whispercpp_language(payload, language),
        "confidence": 0.74,
        "segments": segments,
    }


def read_whispercpp_json(output_prefix, stdout):
    json_path = f"{output_prefix}.json"
    if os.path.isfile(json_path):
        with open(json_path, "r", encoding="utf-8") as file:
            return json.load(file)
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("{") and line.endswith("}"):
            return json.loads(line)
    parsed_segments = parse_whispercpp_stdout_segments(stdout)
    if parsed_segments:
        return {"transcription": parsed_segments}
    raise RuntimeError("whisper.cpp did not produce JSON output.")


def normalize_whispercpp_segments(payload):
    result = payload.get("result")
    result_segments = result.get("segments") if isinstance(result, dict) else []
    raw_segments = payload.get("transcription") or payload.get("segments") or result_segments or []
    if not isinstance(raw_segments, list):
        return []
    segments = []
    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        start = parse_whispercpp_time(item, "from", "start")
        end = parse_whispercpp_time(item, "to", "end")
        if end < start:
            end = start
        segments.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    return segments


def parse_whispercpp_time(item, timestamp_key, direct_key):
    timestamps = item.get("timestamps")
    if isinstance(timestamps, dict):
        parsed = parse_timestamp_string(timestamps.get(timestamp_key))
        if parsed is not None:
            return parsed
    offsets = item.get("offsets")
    if isinstance(offsets, dict):
        parsed = parse_offset_milliseconds(offsets.get(timestamp_key))
        if parsed is not None:
            return parsed
    direct = parse_numeric_seconds(item.get(direct_key))
    if direct is not None:
        return direct
    return 0.0


def parse_timestamp_string(value):
    if not isinstance(value, str):
        return None
    match = re.match(r"^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$", value.strip())
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    millis = int((match.group(4) or "0").ljust(3, "0")[:3])
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def parse_offset_milliseconds(value):
    if value is None:
        return None
    try:
        return float(value) / 1000
    except Exception:
        return None


def parse_numeric_seconds(value):
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def parse_whispercpp_stdout_segments(stdout):
    segments = []
    pattern = re.compile(r"^\s*\[(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\]\s*(.+?)\s*$")
    for line in stdout.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        segments.append(
            {
                "timestamps": {"from": match.group(1), "to": match.group(2)},
                "text": match.group(3).strip(),
            }
        )
    return segments


def infer_whispercpp_language(payload, fallback):
    result = payload.get("result")
    if isinstance(result, dict) and result.get("language"):
        return str(result.get("language"))
    if payload.get("language"):
        return str(payload.get("language"))
    return fallback or "unknown"


def normalize_auto(value):
    if not value or str(value).strip().lower() == "auto":
        return None
    return value


def configure_threading():
    threads = optional_positive_int(os.environ.get("WHISPER_CPU_THREADS"))
    if threads is None:
        return None
    for key in ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS", "CT2_NUM_THREADS"]:
        os.environ.setdefault(key, str(threads))
    try:
        import torch

        torch.set_num_threads(threads)
    except Exception:
        pass
    return threads


def optional_positive_int(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = int(str(value))
    except Exception:
        return None
    return parsed if parsed > 0 else None


def emit_result(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)
    stop_resource_tracker()


def stop_resource_tracker():
    try:
        from multiprocessing import resource_tracker

        tracker = getattr(resource_tracker, "_resource_tracker", None)
        if tracker is not None:
            tracker._stop()
    except Exception:
        pass


def emit_progress(progress, message):
    payload = {
        "type": "progress",
        "stage": "asr",
        "progress": max(0, min(100, int(round(progress)))),
        "message": message,
    }
    print(f"ARION_PROGRESS {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


def transcription_duration(info):
    for key in ["duration", "duration_after_vad"]:
        value = getattr(info, key, None)
        try:
            parsed = float(value)
            if parsed > 0:
                return parsed
        except Exception:
            continue
    return 0.0


def format_media_time(seconds):
    try:
        safe = max(0, int(round(float(seconds))))
    except Exception:
        safe = 0
    minutes = safe // 60
    rest = safe % 60
    return f"{minutes}:{rest:02d}"


def transcribe_with_faster_whisper(media_path, model_name, language):
    from faster_whisper import WhisperModel

    model_options = {}
    cpu_threads = optional_positive_int(os.environ.get("WHISPER_CPU_THREADS"))
    num_workers = optional_positive_int(os.environ.get("WHISPER_NUM_WORKERS"))
    if cpu_threads is not None:
        model_options["cpu_threads"] = cpu_threads
    if num_workers is not None:
        model_options["num_workers"] = num_workers
    emit_progress(5, f"Loading Faster-Whisper {model_name} ASR model")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", **model_options)
    emit_progress(12, f"Preparing Faster-Whisper {model_name} transcription")
    segments, info = model.transcribe(media_path, language=language, beam_size=5, vad_filter=True)
    duration = transcription_duration(info)
    segment_list = []
    last_progress = 12
    for segment in segments:
        segment_list.append(segment)
        end_time = float(segment.end or 0)
        progress = 15 + (min(1, end_time / duration) * 80 if duration > 0 else 0)
        if progress >= last_progress + 3 or progress >= 95:
            suffix = f" ({format_media_time(end_time)} / {format_media_time(duration)})" if duration > 0 else ""
            emit_progress(progress, f"Transcribing speech with Faster-Whisper {model_name}{suffix}")
            last_progress = progress
    emit_progress(98, f"Finalizing Faster-Whisper {model_name} transcript")
    transcript = " ".join(segment.text.strip() for segment in segment_list).strip()
    confidence = 0.75
    if segment_list:
        no_speech = [getattr(segment, "no_speech_prob", None) for segment in segment_list]
        no_speech = [value for value in no_speech if value is not None]
        if no_speech:
            confidence = max(0, min(1, 1 - (sum(no_speech) / len(no_speech))))
    return {
        "available": True,
        "provider": "faster-whisper",
        "model": model_name,
        "transcript": transcript,
        "language": info.language or language or "unknown",
        "confidence": round(confidence, 3),
        "segments": [
            {"start": round(float(segment.start or 0), 3), "end": round(float(segment.end or 0), 3), "text": segment.text.strip()}
            for segment in segment_list
        ],
    }


def transcribe_with_openai_whisper(media_path, model_name, language):
    import whisper

    emit_progress(5, f"Loading OpenAI Whisper {model_name} ASR model")
    model = whisper.load_model(model_name)
    emit_progress(12, f"Transcribing speech with OpenAI Whisper {model_name}")
    result = model.transcribe(media_path, language=language)
    emit_progress(98, f"Finalizing OpenAI Whisper {model_name} transcript")
    transcript = result.get("text", "").strip()
    language_value = result.get("language") or language or "unknown"
    segments = result.get("segments", [])
    confidence = 0.72
    if segments:
        no_speech = [segment.get("no_speech_prob") for segment in segments if segment.get("no_speech_prob") is not None]
        if no_speech:
            confidence = max(0, min(1, 1 - (sum(no_speech) / len(no_speech))))
    return {
        "available": True,
        "provider": "openai-whisper",
        "model": model_name,
        "transcript": transcript,
        "language": language_value,
        "confidence": round(confidence, 3),
        "segments": [
            {"start": round(float(segment.get("start") or 0), 3), "end": round(float(segment.get("end") or 0), 3), "text": segment.get("text", "").strip()}
            for segment in segments
        ],
    }


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit_result({"available": False, "provider": "none", "error": str(error)})
        sys.exit(0)
