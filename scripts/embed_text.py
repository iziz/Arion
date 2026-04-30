#!/usr/bin/env python3
import argparse
import contextlib
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Embed text with a local sentence-transformers model.")
    parser.add_argument("--model", default="intfloat/multilingual-e5-small")
    parser.add_argument("--kind", choices=["query", "passage"], default="passage")
    args = parser.parse_args()

    try:
        from sentence_transformers import SentenceTransformer

        payload = json.load(sys.stdin)
        texts = payload.get("texts", [])
        if not isinstance(texts, list):
            raise ValueError("texts must be a list")

        prefix = "query: " if args.kind == "query" else "passage: "
        prepared = [prefix + str(text).replace("\n", " ").strip() for text in texts]
        with contextlib.redirect_stdout(sys.stderr):
            model = SentenceTransformer(args.model)
            embeddings = model.encode(prepared, normalize_embeddings=True, show_progress_bar=False)
        vectors = [[round(float(value), 6) for value in row] for row in embeddings]
        print(
            json.dumps(
                {
                    "available": True,
                    "provider": "sentence-transformers",
                    "model": args.model,
                    "kind": args.kind,
                    "dimension": len(vectors[0]) if vectors else 0,
                    "embeddings": vectors,
                }
            )
        )
    except Exception as error:
        print(
            json.dumps(
                {
                    "available": False,
                    "provider": "sentence-transformers",
                    "model": args.model,
                    "kind": args.kind,
                    "dimension": 0,
                    "embeddings": [],
                    "error": str(error),
                }
            )
        )


if __name__ == "__main__":
    main()
