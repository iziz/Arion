#!/usr/bin/env python3
import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio/video with a local Whisper implementation.")
    parser.add_argument("media_path")
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "large-v3"))
    parser.add_argument("--language", default=os.environ.get("WHISPER_LANGUAGE"))
    args = parser.parse_args()
    language = normalize_auto(args.language)

    try:
        result = transcribe_with_faster_whisper(args.media_path, args.model, language)
        emit_result(result)
        return
    except Exception as faster_error:
        try:
            result = transcribe_with_openai_whisper(args.media_path, args.model, language)
            emit_result(result)
            return
        except Exception as whisper_error:
            emit_result(
                {
                    "available": False,
                    "provider": "none",
                    "transcript": "",
                    "language": "unknown",
                    "confidence": 0,
                    "error": f"faster-whisper: {type(faster_error).__name__}: {faster_error}; openai-whisper: {type(whisper_error).__name__}: {whisper_error}",
                }
            )


def normalize_auto(value):
    if not value or str(value).strip().lower() == "auto":
        return None
    return value


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


def transcribe_with_faster_whisper(media_path, model_name, language):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(media_path, language=language, beam_size=5, vad_filter=True)
    segment_list = list(segments)
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

    model = whisper.load_model(model_name)
    result = model.transcribe(media_path, language=language)
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
