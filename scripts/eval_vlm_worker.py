#!/usr/bin/env python3
"""Evaluate an Arion VLM worker against a JSON fixture.

Fixture shape:
{
  "cases": [
    {
      "id": "query-routing-basic",
      "endpoint": "/plan/query",
      "request": {"query": "find Messi receiving passes"},
      "expect": {
        "requiredKeys": ["route", "retrieval.textQuery"],
        "fields": {"route": "asset_evidence"}
      }
    }
  ]
}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the local Arion Qwen VLM worker.")
    parser.add_argument("--worker-url", default=os.environ.get("VLM_WORKER_URL", "http://127.0.0.1:8791"))
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--no-fail", action="store_true", help="Always exit 0 and report failures in JSON only.")
    args = parser.parse_args()

    fixture = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
    cases = fixture.get("cases")
    if not isinstance(cases, list):
        raise ValueError("fixture must contain a cases array")

    results = [run_case(args.worker_url.rstrip("/"), case, args.timeout) for case in cases]
    summary = {
        "ok": all(item["ok"] for item in results),
        "passed": sum(1 for item in results if item["ok"]),
        "failed": sum(1 for item in results if not item["ok"]),
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ok"] or args.no_fail else 1


def run_case(worker_url: str, case: dict[str, Any], timeout: float) -> dict[str, Any]:
    case_id = str(case.get("id") or "unnamed")
    endpoint = str(case.get("endpoint") or "/plan/query")
    request_payload = case.get("request") if isinstance(case.get("request"), dict) else {}
    started = time.perf_counter()
    try:
        response = post_json(f"{worker_url}{endpoint}", request_payload, timeout)
        errors = expectation_errors(response, case.get("expect") if isinstance(case.get("expect"), dict) else {})
        return {
            "id": case_id,
            "endpoint": endpoint,
            "ok": not errors,
            "latencyMs": round((time.perf_counter() - started) * 1000, 2),
            "errors": errors,
            "response": trim_response(response),
        }
    except Exception as error:
        return {
            "id": case_id,
            "endpoint": endpoint,
            "ok": False,
            "latencyMs": round((time.perf_counter() - started) * 1000, 2),
            "errors": [str(error)],
            "response": None,
        }


def post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail[:400]}") from error


def expectation_errors(response: dict[str, Any], expect: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for key in expect.get("requiredKeys") or []:
        if value_at(response, str(key)) is None:
            errors.append(f"missing required key: {key}")
    fields = expect.get("fields") if isinstance(expect.get("fields"), dict) else {}
    for key, expected in fields.items():
        actual = value_at(response, str(key))
        if actual != expected:
            errors.append(f"{key} expected {expected!r}, got {actual!r}")
    contains = expect.get("contains") if isinstance(expect.get("contains"), dict) else {}
    for key, expected_text in contains.items():
        actual = value_at(response, str(key))
        if str(expected_text).lower() not in str(actual or "").lower():
            errors.append(f"{key} does not contain {expected_text!r}")
    return errors


def value_at(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def trim_response(value: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(value, ensure_ascii=False)
    if len(encoded) <= 4000:
        return value
    return {"truncated": True, "preview": encoded[:4000]}


if __name__ == "__main__":
    sys.exit(main())
