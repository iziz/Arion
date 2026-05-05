#!/usr/bin/env python3
"""Normalize SoccerNet-style action spotting output for the server runtime.

This script intentionally does not synthesize actions. It either reads explicit
prediction JSON or executes a configured external spotting command that returns
JSON. Without one of those inputs it reports unavailable.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from typing import Any


SOCCERNET_CLASSES = {
    "Penalty",
    "Kick-off",
    "Goal",
    "Substitution",
    "Offside",
    "Shots on target",
    "Shots off target",
    "Clearance",
    "Ball out of play",
    "Throw-in",
    "Foul",
    "Indirect free-kick",
    "Direct free-kick",
    "Corner",
    "Yellow card",
    "Red card",
    "Yellow->red card",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run or normalize SoccerNet action spotting predictions.")
    parser.add_argument("media_path")
    parser.add_argument("--model", default=os.environ.get("SOCCERNET_ACTION_SPOTTING_MODEL", "external"))
    parser.add_argument("--spots-json", default=os.environ.get("SOCCERNET_ACTION_SPOTS_JSON"))
    parser.add_argument("--command", default=os.environ.get("SOCCERNET_ACTION_SPOTTING_COMMAND"))
    args = parser.parse_args()
    payload = json.load(sys.stdin) if not sys.stdin.isatty() else {}

    try:
        raw = load_raw_predictions(args, payload)
        spots = normalize_spots(raw, payload)
        print(
            json.dumps(
                {
                    "available": True,
                    "provider": "soccernet-action-spotting",
                    "model": args.model,
                    "task": "action_spotting",
                    "spots": spots,
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
                    "provider": "soccernet-action-spotting",
                    "model": args.model,
                    "task": "action_spotting",
                    "spots": [],
                    "error": f"{type(error).__name__}: {error}",
                },
                ensure_ascii=False,
            )
        )


def load_raw_predictions(args: argparse.Namespace, payload: dict[str, Any]) -> Any:
    if args.spots_json:
        with open(args.spots_json, "r", encoding="utf-8") as handle:
            return json.load(handle)
    if args.command:
        command = shlex.split(args.command) + [args.media_path]
        completed = subprocess.run(
            command,
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "SOCCERNET_MEDIA_PATH": args.media_path},
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"External action spotting command exited with {completed.returncode}")
        return json.loads(extract_json(completed.stdout))
    raise RuntimeError("SOCCERNET_ACTION_SPOTTING_COMMAND or SOCCERNET_ACTION_SPOTS_JSON is required.")


def extract_json(stdout: str) -> str:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("{") and line.endswith("}"):
            return line
    return stdout


def normalize_spots(raw: Any, payload: dict[str, Any]) -> list[dict[str, Any]]:
    max_end = max((float(segment.get("end") or 0) for segment in payload.get("segments", [])), default=float(payload.get("duration") or 0))
    items = candidate_items(raw)
    spots = []
    for item in items:
        label = str(item.get("label") or item.get("class") or item.get("event") or item.get("name") or "").strip()
        if not label:
            continue
        position = parse_position(item)
        if position is None:
            continue
        if max_end > 0 and position > max_end + 30:
            position = position / 1000.0
        confidence = float(item.get("confidence", item.get("score", item.get("probability", 1.0))) or 0)
        spots.append(
            {
                "label": label,
                "eventType": event_type(label),
                "position": round(max(0.0, float(position)), 3),
                "half": parse_half(item),
                "confidence": round(max(0.0, min(1.0, confidence)), 3),
                "evidence": evidence_for_item(item),
            }
        )
    return sorted(spots, key=lambda spot: (spot["position"], -spot["confidence"]))


def candidate_items(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if not isinstance(raw, dict):
        return []
    for key in ("spots", "predictions", "annotations", "actions", "events"):
        value = raw.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def parse_position(item: dict[str, Any]) -> float | None:
    for key in ("position", "time", "timestamp", "second", "seconds", "start"):
        if key in item and item[key] is not None:
            try:
                return float(item[key])
            except (TypeError, ValueError):
                continue
    game_time = item.get("gameTime")
    if isinstance(game_time, str):
        return parse_game_time(game_time)
    return None


def parse_game_time(value: str) -> float | None:
    # SoccerNet labels commonly use "1 - 00:12" or "2 - 45:03".
    cleaned = value.strip()
    if " - " in cleaned:
        _, cleaned = cleaned.split(" - ", 1)
    parts = cleaned.split(":")
    try:
        if len(parts) == 2:
            minutes, seconds = parts
            return float(minutes) * 60 + float(seconds)
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return float(hours) * 3600 + float(minutes) * 60 + float(seconds)
    except ValueError:
        return None
    return None


def parse_half(item: dict[str, Any]) -> int | None:
    value = item.get("half")
    if value is not None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    game_time = item.get("gameTime")
    if isinstance(game_time, str) and " - " in game_time:
        try:
            return int(game_time.split(" - ", 1)[0].strip())
        except ValueError:
            return None
    return None


def event_type(label: str) -> str:
    normalized = normalize_label(label)
    if "shot" in normalized:
        return "shot"
    if "goal" in normalized:
        return "goal"
    if "corner" in normalized:
        return "corner"
    if "free_kick" in normalized:
        return "free_kick"
    if "kick_off" in normalized:
        return "kickoff"
    if "throw_in" in normalized:
        return "throw_in"
    if "yellow" in normalized or "red_card" in normalized:
        return "card"
    return normalized or "scene"


def normalize_label(label: str) -> str:
    value = label.strip().lower().replace("->", "_to_")
    value = "".join(character if character.isalnum() else "_" for character in value)
    while "__" in value:
        value = value.replace("__", "_")
    return value.strip("_")


def evidence_for_item(item: dict[str, Any]) -> list[str]:
    evidence = []
    raw_evidence = item.get("evidence")
    if isinstance(raw_evidence, list):
        for value in raw_evidence:
            if isinstance(value, str) and value.strip():
                evidence.append(value.strip()[:240])
    if "gameTime" in item:
        evidence.append(f"gameTime={item['gameTime']}")
    if "position" in item:
        evidence.append(f"position={item['position']}")
    label = str(item.get("label") or "")
    if label and label in SOCCERNET_CLASSES:
        evidence.append("class=soccernet-v2")
    return evidence


if __name__ == "__main__":
    main()
