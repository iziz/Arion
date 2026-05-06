#!/usr/bin/env python3
"""Normalize American-football action spotting output for the server runtime.

This script intentionally does not synthesize plays. It either reads explicit
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
from pathlib import Path
from typing import Any


DEFAULT_SPOTS_DIR = Path.cwd() / ".data" / "american-football-action-spots"


def main() -> None:
    parser = argparse.ArgumentParser(description="Run or normalize American-football action spotting predictions.")
    parser.add_argument("media_path")
    parser.add_argument("--model", default=os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTTING_MODEL", "external"))
    parser.add_argument("--spots-json", default=os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTS_JSON") or os.environ.get("NFL_ACTION_SPOTS_JSON"))
    parser.add_argument("--spots-dir", default=os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTS_DIR") or os.environ.get("NFL_ACTION_SPOTS_DIR") or str(DEFAULT_SPOTS_DIR))
    parser.add_argument("--command", default=os.environ.get("AMERICAN_FOOTBALL_ACTION_SPOTTING_COMMAND") or os.environ.get("NFL_ACTION_SPOTTING_COMMAND"))
    args = parser.parse_args()
    payload = load_stdin_payload()

    try:
        raw = load_raw_predictions(args, payload)
        spots = normalize_spots(raw, payload)
        print(
            json.dumps(
                {
                    "available": True,
                    "provider": "american-football-action-spotting",
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
                    "provider": "american-football-action-spotting",
                    "model": args.model,
                    "task": "action_spotting",
                    "spots": [],
                    "error": f"{type(error).__name__}: {error}",
                },
                ensure_ascii=False,
            )
        )


def load_stdin_payload() -> dict[str, Any]:
    if sys.stdin.isatty():
        return {}
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    value = json.loads(raw)
    return value if isinstance(value, dict) else {}


def load_raw_predictions(args: argparse.Namespace, payload: dict[str, Any]) -> Any:
    if args.spots_json:
        with open(args.spots_json, "r", encoding="utf-8") as handle:
            return json.load(handle)
    spots_path = resolve_spots_file(args.media_path, args.spots_dir)
    if spots_path:
        with open(spots_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    if args.command:
        command = shlex.split(args.command) + [args.media_path]
        completed = subprocess.run(
            command,
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "AMERICAN_FOOTBALL_MEDIA_PATH": args.media_path, "NFL_MEDIA_PATH": args.media_path},
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"External action spotting command exited with {completed.returncode}")
        return json.loads(extract_json(completed.stdout))
    raise RuntimeError("AMERICAN_FOOTBALL_ACTION_SPOTTING_COMMAND, AMERICAN_FOOTBALL_ACTION_SPOTS_JSON, or an asset JSON under AMERICAN_FOOTBALL_ACTION_SPOTS_DIR is required.")


def resolve_spots_file(media_path: str, spots_dir: str | None) -> Path | None:
    if not spots_dir:
        return None
    directory = Path(spots_dir)
    if not directory.is_dir():
        return None
    asset_id = asset_id_from_media_path(media_path)
    candidates = []
    if asset_id:
        candidates.append(directory / f"{asset_id}.json")
    candidates.extend([directory / "predictions.json", directory / "spots.json"])
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def asset_id_from_media_path(media_path: str) -> str | None:
    parts = Path(media_path).parts
    for index, part in enumerate(parts):
        if part == "assets" and index + 1 < len(parts):
            return parts[index + 1]
    return None


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
        label = str(item.get("label") or item.get("class") or item.get("event") or item.get("playType") or item.get("name") or "").strip()
        if not label:
            continue
        position = parse_position(item)
        if position is None:
            continue
        if max_end > 0 and position > max_end + 30:
            position = position / 1000.0
        confidence = float(item.get("confidence", item.get("score", item.get("probability", 1.0))) or 0)
        event = event_type(str(item.get("eventType") or label))
        spot = {
            "label": label,
            "eventType": event,
            "position": round(max(0.0, float(position)), 3),
            "period": parse_period(item),
            "confidence": round(max(0.0, min(1.0, confidence)), 3),
            "evidence": evidence_for_item(item),
        }
        play_metadata = play_metadata_for_item(item)
        participants = participants_for_item(item)
        tracking = tracking_for_item(item)
        if play_metadata:
            spot["playMetadata"] = play_metadata
        if participants:
            spot["participants"] = participants
        if tracking:
            spot["tracking"] = tracking
        spots.append(spot)
    return sorted(spots, key=lambda spot: (spot["position"], -spot["confidence"]))


def candidate_items(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if not isinstance(raw, dict):
        return []
    for key in ("spots", "predictions", "annotations", "actions", "events", "plays"):
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
    game_time = item.get("gameTime") or item.get("clock")
    if isinstance(game_time, str):
        return parse_game_time(game_time)
    return None


def parse_game_time(value: str) -> float | None:
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


def parse_period(item: dict[str, Any]) -> int | None:
    for key in ("period", "quarter", "half"):
        value = item.get(key)
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
    if "scramble" in normalized or "qb_run" in normalized or "quarterback_run" in normalized:
        return "scramble"
    if "throw_on_run" in normalized or "rolling" in normalized or "off_platform" in normalized:
        return "throw_on_run"
    if "pocket_escape" in normalized or "escape_pocket" in normalized or "out_of_pocket" in normalized:
        return "pocket_escape"
    if "pressure" in normalized or "pass_rush" in normalized or "blitz" in normalized or "sack" in normalized:
        return "pressure"
    if "touchdown" in normalized or normalized == "td":
        return "touchdown"
    if "pass" in normalized or "completion" in normalized or "interception" in normalized:
        return "pass"
    if "rush" in normalized or "run" in normalized or "carry" in normalized:
        return "rush"
    if "field_goal" in normalized:
        return "field_goal"
    if "punt" in normalized:
        return "punt"
    if "kickoff" in normalized or "kick_off" in normalized:
        return "kickoff"
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
    for key in ("gameId", "playId", "gameTime", "clock", "period", "quarter", "down", "distance", "yardline", "possession", "team", "player"):
        if key in item and item[key] is not None:
            evidence.append(f"{key}={item[key]}")
    return evidence


def play_metadata_for_item(item: dict[str, Any]) -> dict[str, Any] | None:
    raw = item.get("playMetadata")
    metadata = raw if isinstance(raw, dict) else item
    game_id = string_value(metadata, "gameId", "game_id")
    play_id = string_value(metadata, "playId", "play_id")
    if not game_id and not play_id:
        return None
    source_text = metadata.get("sourceText")
    if isinstance(source_text, str):
        source_values = [source_text]
    elif isinstance(source_text, list):
        source_values = [str(value)[:500] for value in source_text if value is not None]
    else:
        source_values = []
    description = string_value(metadata, "description", "desc")
    if description and description not in source_values:
        source_values.append(description)
    provider = string_value(metadata, "provider") or "unknown"
    if provider not in {"nflverse", "big-data-bowl", "manual", "unknown"}:
        provider = "unknown"
    return {
        "provider": provider,
        "gameId": game_id,
        "playId": play_id,
        "season": string_value(metadata, "season"),
        "week": int_value(metadata, "week"),
        "possessionTeam": string_value(metadata, "possessionTeam", "possession_team", "posteam", "team"),
        "defensiveTeam": string_value(metadata, "defensiveTeam", "defensive_team", "defteam"),
        "down": int_value(metadata, "down"),
        "distance": number_value(metadata, "distance", "ydstogo", "yardsToGo"),
        "yardline": string_value(metadata, "yardline", "yrdln"),
        "yardline100": number_value(metadata, "yardline100", "yardline_100"),
        "quarter": int_value(metadata, "quarter", "qtr", "period"),
        "clock": string_value(metadata, "clock", "time"),
        "description": description,
        "sourceText": source_values,
    }


def participants_for_item(item: dict[str, Any]) -> list[dict[str, Any]]:
    raw = item.get("participants")
    if isinstance(raw, list):
        return [participant_for_item(value) for value in raw if isinstance(value, dict) and participant_for_item(value)]
    participants = []
    for role, id_keys, name_keys in (
        ("passer", ("passerPlayerId", "passer_player_id"), ("passerPlayerName", "passer_player_name", "passer")),
        ("rusher", ("rusherPlayerId", "rusher_player_id"), ("rusherPlayerName", "rusher_player_name", "rusher")),
        ("receiver", ("receiverPlayerId", "receiver_player_id"), ("receiverPlayerName", "receiver_player_name", "receiver")),
        ("quarterback", ("quarterbackPlayerId", "quarterback_player_id", "qb_player_id"), ("quarterbackPlayerName", "quarterback_player_name", "quarterback", "qb")),
    ):
        participant = participant_for_item(
            {
                "role": role,
                "playerId": string_value(item, *id_keys),
                "name": string_value(item, *name_keys),
                "team": string_value(item, "team", "possessionTeam", "possession_team", "posteam"),
                "trackId": string_value(item, f"{role}TrackId", f"{role}_track_id"),
                "confidence": item.get("alignmentConfidence", item.get("confidence")),
                "source": "nflverse",
            }
        )
        if participant:
            participants.append(participant)
    return participants


def participant_for_item(item: dict[str, Any]) -> dict[str, Any] | None:
    name = string_value(item, "name", "player", "playerName", "player_name")
    player_id = string_value(item, "playerId", "player_id", "id")
    track_id = string_value(item, "trackId", "track_id")
    if not name and not player_id and not track_id:
        return None
    role = string_value(item, "role") or "unknown"
    if role not in {"quarterback", "rusher", "receiver", "passer", "tackler", "contact", "unknown"}:
        role = "unknown"
    source = string_value(item, "source") or "unknown"
    if source not in {"nflverse", "helmet_assignment", "tracking", "asr", "ocr", "vlm", "unknown"}:
        source = "unknown"
    return {
        "role": role,
        "playerId": player_id,
        "name": name,
        "team": string_value(item, "team"),
        "trackId": track_id,
        "confidence": round(max(0.0, min(1.0, float(item.get("confidence") or 0))), 3),
        "source": source,
    }


def tracking_for_item(item: dict[str, Any]) -> dict[str, Any] | None:
    raw = item.get("tracking")
    tracking = raw if isinstance(raw, dict) else item
    track_ids = string_list(tracking.get("trackIds") or tracking.get("track_ids"))
    frame_ids = string_list(tracking.get("frameIds") or tracking.get("frame_ids"))
    contact_ids = string_list(tracking.get("contactIds") or tracking.get("contact_ids"))
    if not track_ids and not frame_ids and not contact_ids:
        return None
    schema = string_value(tracking, "schema") or "unavailable"
    if schema not in {"big-data-bowl", "mot", "unavailable"}:
        schema = "unavailable"
    return {
        "schema": schema,
        "playId": string_value(tracking, "playId", "play_id") or string_value(item, "playId", "play_id"),
        "frameIds": frame_ids,
        "trackIds": track_ids,
        "contactIds": contact_ids,
        "confidence": round(max(0.0, min(1.0, float(tracking.get("confidence") or 0))), 3),
    }


def string_value(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = item.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def number_value(item: dict[str, Any], *keys: str) -> float | None:
    value = string_value(item, *keys)
    if value is None:
        return None
    try:
        return float(value.replace(",", ""))
    except ValueError:
        return None


def int_value(item: dict[str, Any], *keys: str) -> int | None:
    value = number_value(item, *keys)
    return int(value) if value is not None else None


def string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [part.strip() for part in value.split(",") if part.strip()]
    return []


if __name__ == "__main__":
    main()
