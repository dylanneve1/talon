"""
Antigravity model discovery helper.

One-shot Python script: query `google.genai.Client(...).models.list()`
with the provided API key, emit a JSON array of chat-capable Gemini
models on stdout, exit 0. On error (bad key, network failure), emit
`{"error": "..."}` and exit non-zero.

The TS side calls this once per Talon process (or on /model refresh)
to populate the Antigravity model catalog dynamically. Caching +
fallback live on the TS side.

Why a Python script: the `google-genai` SDK is the supported way to
query Gemini model availability. The REST endpoint is documented but
auth + pagination are wrapped by the SDK in a way that's not worth
re-implementing in TS for a one-shot lookup.

Usage:
    python3 list_models.py --api-key-fd 3

  ...where fd 3 carries the API key as a UTF-8 byte string (closed
  after read). Same fd-handoff pattern as agent_bridge.py for the
  same reason: api keys on argv leak into `ps`.

Output:
    {
      "ok": true,
      "models": [
        {
          "id": "models/gemini-3.5-flash",
          "name": "models/gemini-3.5-flash",
          "displayName": "Gemini 3.5 Flash",
          "inputTokenLimit": 1000000,
          "outputTokenLimit": 8192,
          "supportsThinking": true,
          "supportedActions": ["generateContent", "countTokens"]
        },
        ...
      ]
    }

Filters: only models that include "generateContent" in
`supported_actions` are included (chat-capable). Embeddings / image
generation / etc. are dropped. Tuned models are dropped.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def read_api_key(fd: int) -> str:
    """Read the API key as bytes from fd, then close."""
    chunks: list[bytes] = []
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(fd)
    return b"".join(chunks).decode("utf-8").strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--api-key-fd",
        type=int,
        default=3,
        help="File descriptor carrying the API key",
    )
    parser.add_argument(
        "--api-key-env",
        action="store_true",
        help="Read GEMINI_API_KEY from env instead of fd",
    )
    args = parser.parse_args()

    if args.api_key_env:
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    else:
        try:
            api_key = read_api_key(args.api_key_fd)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"fd read failed: {e}"}))
            return 2

    if not api_key:
        print(json.dumps({"ok": False, "error": "missing API key"}))
        return 2

    try:
        from google import genai
    except ImportError as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": (
                        "google-genai not installed in this venv. "
                        f"Install with: pip install google-genai ({e})"
                    ),
                }
            )
        )
        return 3

    try:
        client = genai.Client(api_key=api_key)
        page = client.models.list()
        out: list[dict[str, object]] = []
        for m in page:
            actions = list(m.supported_actions or [])
            if "generateContent" not in actions:
                # Skip embeddings, image gen, etc.
                continue
            # Skip user-tuned models — they're per-key, not catalog.
            # Newer google-genai builds always populate `tuned_model_info`
            # with an empty dataclass (`base_model=None ...`) for stock
            # models instead of returning None, so the old `is not None`
            # check filtered out every model. Detect a real tuned entry
            # by the presence of a `base_model` reference.
            tmi = m.tuned_model_info
            if tmi is not None and getattr(tmi, "base_model", None):
                continue
            name = m.name or ""
            if not name:
                continue
            display = m.display_name or name.split("/")[-1]
            out.append(
                {
                    "id": name,
                    "name": name,
                    "displayName": display,
                    "inputTokenLimit": m.input_token_limit or 0,
                    "outputTokenLimit": m.output_token_limit or 0,
                    "supportsThinking": bool(m.thinking),
                    "supportedActions": actions,
                }
            )
        print(json.dumps({"ok": True, "models": out}))
        return 0
    except Exception as e:  # noqa: BLE001
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"models.list failed: {type(e).__name__}: {e}",
                }
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
