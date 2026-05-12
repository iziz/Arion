#!/usr/bin/env python3
"""Build a player face embedding gallery from a manifest of reference images."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from track_objects import FaceEmbeddingModel, crop_face_candidate


def main() -> None:
    parser = argparse.ArgumentParser(description="Build an Arion player face gallery JSON file.")
    parser.add_argument("--manifest", required=True, help="JSON file with players and reference image paths.")
    parser.add_argument("--model", default=os.environ.get("FACE_IDENTITY_MODEL_PATH", ""), help="ONNX face embedding model path.")
    parser.add_argument("--output", required=True, help="Output gallery JSON path.")
    args = parser.parse_args()

    model = FaceEmbeddingModel(args.model)
    if not model.available():
        raise SystemExit("Face embedding model is unavailable. Set --model or FACE_IDENTITY_MODEL_PATH to a valid ONNX model.")

    with open(args.manifest, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    players = manifest.get("players") if isinstance(manifest, dict) else manifest
    if not isinstance(players, list):
        raise SystemExit("Manifest must be a list or an object with a players array.")

    gallery_players = []
    for player in players:
        if not isinstance(player, dict):
            continue
        images = player.get("images") or player.get("imagePaths") or []
        embeddings = [embedding for image_path in images for embedding in [embed_image(model, image_path)] if embedding]
        if not embeddings:
            continue
        gallery_players.append(
            {
                "playerId": player.get("playerId"),
                "canonicalName": player.get("canonicalName") or player.get("name"),
                "team": player.get("team"),
                "embeddings": embeddings,
                "sourceImages": [str(path) for path in images],
            }
        )

    output = {
        "generatedBy": "arion-face-gallery-builder-v1",
        "modelPath": str(args.model),
        "players": gallery_players,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"players": len(gallery_players), "output": str(output_path)}, ensure_ascii=False))


def embed_image(model: FaceEmbeddingModel, image_path: str):
    import cv2

    image = cv2.imread(str(image_path))
    if image is None or image.size == 0:
        return None
    height, width = image.shape[:2]
    face_crop = crop_face_candidate(image, 0, 0, width, height)
    if face_crop is None:
        return None
    return model.embed(face_crop)


if __name__ == "__main__":
    main()
