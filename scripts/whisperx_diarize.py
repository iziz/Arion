#!/usr/bin/env python3
import argparse
import json
import os
import sys


def normalize_auto(value):
    if not value or str(value).strip().lower() == "auto":
        return None
    return value


def configure_threading():
    threads = optional_positive_int(os.environ.get("WHISPERX_CPU_THREADS") or os.environ.get("WHISPER_CPU_THREADS"))
    if threads is None:
        return None
    for key in ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"]:
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


def main():
    configure_threading()
    parser = argparse.ArgumentParser(description="Run optional WhisperX alignment and speaker diarization.")
    parser.add_argument("audio_path")
    parser.add_argument("--model", default=os.environ.get("WHISPERX_MODEL") or os.environ.get("WHISPER_MODEL", "large-v3"))
    parser.add_argument("--language", default=os.environ.get("WHISPER_LANGUAGE"))
    parser.add_argument("--hf-token", default=os.environ.get("WHISPERX_HF_TOKEN") or os.environ.get("HF_TOKEN"))
    parser.add_argument("--segments-json", default=None)
    args = parser.parse_args()
    language_arg = normalize_auto(args.language)

    try:
        import torch
        import whisperx
        from whisperx.diarize import DiarizationPipeline
    except Exception as error:
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": "whisperx",
                    "speakers": [],
                    "segments": [],
                    "error": f"{type(error).__name__}: {error}",
                },
                ensure_ascii=False,
            )
        )
        return

    if not args.hf_token:
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": "whisperx",
                    "speakers": [],
                    "segments": [],
                    "error": "WHISPERX_HF_TOKEN or HF_TOKEN is required for pyannote speaker diarization.",
                },
                ensure_ascii=False,
            )
        )
        return

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        audio = whisperx.load_audio(args.audio_path)
        diarize_model = DiarizationPipeline(token=args.hf_token, device=device)
        diarized = diarize_model(audio)
        if args.segments_json:
            source_segments = load_segments(args.segments_json)
            language = language_arg or "unknown"
            assigned = {"segments": assign_speakers_by_overlap(diarized, source_segments)}
        else:
            compute_type = "float16" if device == "cuda" else "int8"
            model = whisperx.load_model(args.model, device, compute_type=compute_type, language=language_arg)
            result = model.transcribe(audio, batch_size=int(os.environ.get("WHISPERX_BATCH_SIZE", "4")))
            language = result.get("language") or language_arg or "unknown"
            align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
            aligned = whisperx.align(result.get("segments", []), align_model, metadata, audio, device, return_char_alignments=False)
            assigned = whisperx.assign_word_speakers(diarized, aligned)
        segments = []
        speakers = set()
        for segment in assigned.get("segments", []):
            text = str(segment.get("text", "")).strip()
            speaker = str(segment.get("speaker", "speaker_unknown"))
            if not text:
                continue
            speakers.add(speaker)
            segments.append(
                {
                    "start": round(float(segment.get("start") or 0), 3),
                    "end": round(float(segment.get("end") or segment.get("start") or 0), 3),
                    "speaker": speaker,
                    "text": text,
                }
            )
        print(
            json.dumps(
                {
                    "available": True,
                    "provider": "whisperx",
                    "model": args.model,
                    "language": language,
                    "speakers": sorted(speakers),
                    "segments": segments,
                    "error": None,
                },
                ensure_ascii=False,
            )
        )
    except Exception as error:
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": "whisperx",
                    "speakers": [],
                    "segments": [],
                    "error": f"{type(error).__name__}: {error}",
                },
                ensure_ascii=False,
            )
        )


def load_segments(path):
    with open(path, "r", encoding="utf-8") as handle:
        raw_segments = json.load(handle)
    segments = []
    for item in raw_segments if isinstance(raw_segments, list) else []:
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        start = float(item.get("start") or 0)
        end = float(item.get("end") or start)
        segments.append({"start": start, "end": max(end, start), "text": text})
    return segments


def assign_speakers_by_overlap(diarized, source_segments):
    diarized_segments = list(iter_diarized_segments(diarized))
    assigned = []
    for segment in source_segments:
        best = None
        for diarized_segment in diarized_segments:
            overlap = overlap_duration(segment["start"], segment["end"], diarized_segment["start"], diarized_segment["end"])
            if overlap <= 0:
                continue
            if not best or overlap > best["overlap"]:
                best = {**diarized_segment, "overlap": overlap}
        assigned.append(
            {
                **segment,
                "speaker": best["speaker"] if best else "speaker_unknown",
            }
        )
    return assigned


def iter_diarized_segments(diarized):
    if hasattr(diarized, "iterrows"):
        for _, row in diarized.iterrows():
            row_dict = row.to_dict()
            segment = row_dict.get("segment")
            yield {
                "start": float(row_dict.get("start", getattr(segment, "start", 0)) or 0),
                "end": float(row_dict.get("end", getattr(segment, "end", 0)) or 0),
                "speaker": str(row_dict.get("speaker") or row_dict.get("label") or "speaker_unknown"),
            }
        return
    if hasattr(diarized, "itertracks"):
        for segment, _, speaker in diarized.itertracks(yield_label=True):
            yield {"start": float(segment.start), "end": float(segment.end), "speaker": str(speaker)}


def overlap_duration(start_a, end_a, start_b, end_b):
    return max(0, min(end_a, end_b) - max(start_a, start_b))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"available": False, "provider": "whisperx", "speakers": [], "segments": [], "error": str(error)}, ensure_ascii=False))
        sys.exit(0)
