#!/usr/bin/env python3
import argparse
import contextlib
import json
import sys


def normalize(rows):
    vectors = []
    for row in rows:
        vectors.append([round(float(value), 6) for value in row])
    return vectors


def main():
    parser = argparse.ArgumentParser(description="Embed images or text with a local OpenCLIP model.")
    parser.add_argument("--model", default="ViT-L-14")
    parser.add_argument("--pretrained", default="datacomp_xl_s13b_b90k")
    parser.add_argument("--mode", choices=["image", "text"], default="image")
    args = parser.parse_args()

    try:
        import torch
        import open_clip
        from PIL import Image

        payload = json.load(sys.stdin)
        device = "cpu"
        with contextlib.redirect_stdout(sys.stderr), contextlib.redirect_stderr(sys.stderr):
            model, _, preprocess = open_clip.create_model_and_transforms(args.model, pretrained=args.pretrained, device=device)
            tokenizer = open_clip.get_tokenizer(args.model)
        model.eval()

        with torch.no_grad():
            if args.mode == "image":
                images = payload.get("images", [])
                tensors = []
                for image_path in images:
                    image = Image.open(str(image_path)).convert("RGB")
                    tensors.append(preprocess(image))
                if tensors:
                    batch = torch.stack(tensors).to(device)
                    features = model.encode_image(batch)
                else:
                    features = torch.empty((0, 512))
            else:
                texts = [str(text).replace("\n", " ").strip() for text in payload.get("texts", [])]
                tokens = tokenizer(texts).to(device) if texts else torch.empty((0, 77), dtype=torch.long)
                features = model.encode_text(tokens) if texts else torch.empty((0, 512))

            if features.shape[0] > 0:
                features = features / features.norm(dim=-1, keepdim=True)

        vectors = normalize(features.cpu().tolist())
        print(
            json.dumps(
                {
                    "available": True,
                    "provider": "open_clip",
                    "model": args.model,
                    "pretrained": args.pretrained,
                    "mode": args.mode,
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
                    "provider": "open_clip",
                    "model": args.model,
                    "pretrained": args.pretrained,
                    "mode": args.mode,
                    "dimension": 0,
                    "embeddings": [],
                    "error": str(error),
                }
            )
        )


if __name__ == "__main__":
    main()
