#!/usr/bin/env python3
"""test-model.py — Compatibility test for an OpenAI-compatible local LLM endpoint.

Sends five calibrated tests to <url>/chat/completions and scores each on a
0.0-1.0 scale. The llm-externalizer plugin REQUIRES structured-output support
(response_format with json_schema) — a model that scores 0 on test #2 cannot
run the plugin at all.

Tests:
  1. smoke              — basic completion. Tests transport + tokenizer.
  2. structured_output  — strict JSON schema via response_format. CRITICAL.
  3. code_understanding — find an off-by-one bug in 4 lines of Python.
  4. long_context       — accept ~30K-token input, produce a relevant summary.
  5. output_length      — emit ≥4K tokens (≥16K chars) before stopping.

Verdict:
    - average ≥ 0.6 AND structured_output ≥ 0.5 → pass
    - otherwise → fail (the agent loops back to Step 4 with a different model)

Usage:
    test-model.py --url http://localhost:11434/v1 --model qwen2.5-coder:7b
    test-model.py --url http://localhost:1234/v1  --model deepseek-coder-v2-lite-instruct \\
                  --api-key sk-... --timeout 900

Outputs a single JSON object to stdout with per-test scores and verdict.
Progress lines go to stderr so the calling agent can show them live without
polluting the JSON.

Why standard library only: same constraint as detect-runners.py — this
script must work before the user has a real Python toolchain. urllib +
json + argparse is enough.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


def call_chat(
    url: str,
    model: str,
    messages: list[dict[str, str]],
    *,
    response_format: Optional[dict] = None,
    max_tokens: int = 512,
    api_key: Optional[str] = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    """POST /chat/completions and return the parsed response or an {error} dict.

    Returning a structured dict (vs raising) keeps test-scoring uniform: each
    test handler can branch on `"error" in resp` without try/except per call.
    """
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.1,  # match the externalizer's fixed temperature
    }
    if response_format is not None:
        body["response_format"] = response_format

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    endpoint = url.rstrip("/") + "/chat/completions"
    req = Request(endpoint, data=json.dumps(body).encode("utf-8"),
                  headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except HTTPError as e:
        # Read the body if we can — error messages from llama.cpp / vLLM /
        # Ollama vary a lot and the body is usually the most informative.
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            err_body = ""
        return {"error": f"HTTP {e.code}: {err_body[:200]}"}
    except (URLError, TimeoutError, socket.timeout) as e:
        return {"error": f"transport: {e}"}
    except json.JSONDecodeError as e:
        return {"error": f"non-JSON response: {e}"}


def _validate_local_url(url: str) -> str:
    """Reject non-http(s) URLs and missing hosts.

    SSRF guard. Without this, `--url file:///proc/self/environ` would dump the
    wizard's environment (including HF_TOKEN / OPENROUTER_API_KEY) into the
    test output, and `--url http://169.254.169.254/...` would probe cloud
    metadata endpoints. urllib.request.urlopen silently accepts file://,
    ftp://, and several other schemes; we restrict to http(s) only.
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit(f"--url must be an http(s) URL, got: {url!r}")
    return url


def extract_content(resp: dict[str, Any]) -> str:
    """Pull the assistant message content out of an OpenAI-style response."""
    try:
        return resp["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ""


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_smoke(url: str, model: str, **kw) -> dict[str, Any]:
    """Tiny prompt → non-empty response. Tests transport + basic generation."""
    t0 = time.time()
    resp = call_chat(
        url, model,
        [{"role": "user", "content": "Say hello in exactly two words."}],
        max_tokens=32, **kw,
    )
    duration = time.time() - t0

    if "error" in resp:
        return {"score": 0.0, "detail": resp["error"], "duration_s": round(duration, 2)}
    content = extract_content(resp).strip()
    if not content:
        return {"score": 0.0, "detail": "empty response", "duration_s": round(duration, 2)}
    return {
        "score": 1.0,
        "detail": f"got {len(content)} chars: {content[:50]!r}",
        "duration_s": round(duration, 2),
    }


def test_structured_output(url: str, model: str, **kw) -> dict[str, Any]:
    """Strict JSON schema via response_format. Non-negotiable for this plugin."""
    schema = {
        "type": "object",
        "properties": {
            "color": {"type": "string"},
            "count": {"type": "integer"},
        },
        "required": ["color", "count"],
        "additionalProperties": False,
    }
    rf = {"type": "json_schema",
          "json_schema": {"name": "color_count", "schema": schema, "strict": True}}

    t0 = time.time()
    resp = call_chat(
        url, model,
        [{"role": "user",
          "content": "Return a JSON object with a 'color' (string) "
                     "and 'count' (integer between 1 and 10)."}],
        response_format=rf, max_tokens=256, **kw,
    )
    duration = time.time() - t0

    if "error" in resp:
        return {"score": 0.0, "detail": resp["error"], "duration_s": round(duration, 2)}
    content = extract_content(resp).strip()
    if not content:
        return {"score": 0.0, "detail": "empty response", "duration_s": round(duration, 2)}
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return {
            "score": 0.0,
            "detail": f"not valid JSON: {content[:120]!r}",
            "duration_s": round(duration, 2),
        }
    if (isinstance(parsed.get("color"), str)
            and isinstance(parsed.get("count"), int)
            and 1 <= parsed["count"] <= 10):
        return {
            "score": 1.0,
            "detail": "valid schema-conformant JSON",
            "duration_s": round(duration, 2),
        }
    return {
        "score": 0.5,
        "detail": f"JSON parsed but schema-noncompliant: {parsed}",
        "duration_s": round(duration, 2),
    }


def test_code_understanding(url: str, model: str, **kw) -> dict[str, Any]:
    """Find a real off-by-one bug in 4 lines of Python. Return JSON."""
    code = (
        "def divide_chunks(items, chunk_size):\n"
        '    """Split items into chunks of given size."""\n'
        "    for i in range(0, len(items), chunk_size):\n"
        "        yield items[i:i + chunk_size + 1]  # off-by-one on the slice end"
    )
    schema = {
        "type": "object",
        "properties": {
            "has_bug": {"type": "boolean"},
            "line": {"type": "integer"},
            "description": {"type": "string"},
        },
        "required": ["has_bug", "line", "description"],
        "additionalProperties": False,
    }
    rf = {"type": "json_schema",
          "json_schema": {"name": "bug_report", "schema": schema, "strict": True}}

    t0 = time.time()
    resp = call_chat(
        url, model,
        [{"role": "user",
          "content": (
              f"Find any bugs in this Python function:\n\n"
              f"```python\n{code}\n```\n\n"
              f"Respond as JSON with has_bug (boolean), line (1-indexed integer), "
              f"and description (string explaining the bug)."
          )}],
        response_format=rf, max_tokens=512, **kw,
    )
    duration = time.time() - t0

    if "error" in resp:
        return {"score": 0.0, "detail": resp["error"], "duration_s": round(duration, 2)}
    content = extract_content(resp)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return {
            "score": 0.0,
            "detail": f"non-JSON response: {content[:120]!r}",
            "duration_s": round(duration, 2),
        }
    if parsed.get("has_bug") is True:
        line = parsed.get("line", 0)
        # The bug is on line 4 of the snippet. Accept 3-5 as "correct" since
        # different models number lines differently (1- vs 0-indexed, count
        # the docstring or not).
        if isinstance(line, int) and 3 <= line <= 5:
            return {
                "score": 1.0,
                "detail": f"correctly identified bug at line {line}",
                "duration_s": round(duration, 2),
            }
        return {
            "score": 0.7,
            "detail": f"found a bug but at wrong line ({line}): "
                      f"{parsed.get('description', '')[:80]}",
            "duration_s": round(duration, 2),
        }
    return {
        "score": 0.3,
        "detail": f"missed the bug: {parsed}",
        "duration_s": round(duration, 2),
    }


def test_long_context(url: str, model: str, **kw) -> dict[str, Any]:
    """Inject ~30K tokens; ask for a relevant summary."""
    # ~4 chars per token. We want ~30K tokens, so ~120K chars.
    # The sentence below is 45 chars ≈ 11 tokens. Need ~2700 repetitions.
    filler_sentence = "The quick brown fox jumps over the lazy dog. "  # 45 chars
    filler = filler_sentence * 2700  # ~120K chars, ~30K tokens
    prompt = (
        "The following text mentions a fox repeatedly. "
        "In one short sentence, name the animal mentioned and what it does.\n\n"
        + filler
    )

    t0 = time.time()
    resp = call_chat(
        url, model,
        [{"role": "user", "content": prompt}],
        max_tokens=200, **kw,
    )
    duration = time.time() - t0

    if "error" in resp:
        return {
            "score": 0.0,
            "detail": f"failed at ~30K-token input: {resp['error']}",
            "duration_s": round(duration, 2),
        }
    content = extract_content(resp).strip().lower()
    if not content:
        return {
            "score": 0.0,
            "detail": "empty response on long-context input",
            "duration_s": round(duration, 2),
        }
    if "fox" in content:
        return {
            "score": 1.0,
            "detail": f"accepted ~30K-token input, named the animal correctly ({duration:.1f}s)",
            "duration_s": round(duration, 2),
        }
    return {
        "score": 0.5,
        "detail": f"accepted input but summary may be irrelevant "
                  f"({duration:.1f}s): {content[:80]}",
        "duration_s": round(duration, 2),
    }


def test_output_length(url: str, model: str, **kw) -> dict[str, Any]:
    """Verify the model can emit ≥4K tokens without truncating early."""
    t0 = time.time()
    resp = call_chat(
        url, model,
        [{"role": "user",
          "content": (
              "Write a detailed 4000-word essay about the history of "
              "programming languages, with sections on assembly, C, Python, "
              "and Rust. For each language include the designer's name, "
              "year of first release, key innovations, and example code. "
              "Be thorough — do not stop early."
          )}],
        max_tokens=8192, **kw,
    )
    duration = time.time() - t0

    if "error" in resp:
        return {"score": 0.0, "detail": resp["error"], "duration_s": round(duration, 2)}
    content = extract_content(resp)
    char_count = len(content)
    # ~4 chars per token. 4096 tokens ≈ 16K chars target.
    if char_count >= 16000:
        return {
            "score": 1.0,
            "detail": f"produced {char_count} chars (~{char_count // 4} tokens)",
            "duration_s": round(duration, 2),
        }
    if char_count >= 8000:
        return {
            "score": 0.5,
            "detail": f"truncated at {char_count} chars (~{char_count // 4} tokens) "
                      f"— output cap may be too low",
            "duration_s": round(duration, 2),
        }
    return {
        "score": 0.2,
        "detail": f"only produced {char_count} chars — model stops too early",
        "duration_s": round(duration, 2),
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


TESTS = [
    ("smoke", test_smoke),
    ("structured_output", test_structured_output),
    ("code_understanding", test_code_understanding),
    ("long_context", test_long_context),
    ("output_length", test_output_length),
]

PASS_AVG_THRESHOLD = 0.6
PASS_STRUCTURED_THRESHOLD = 0.5  # structured_output is non-negotiable
STRUCTURED_TEST_KEY = "structured_output"  # MUST match the TESTS entry above —
# decoupling the verdict logic from a brittle string literal so renames stay
# safe.


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Compatibility test for an OpenAI-compatible LLM endpoint.",
    )
    ap.add_argument("--url", required=True,
                    help="OpenAI-compatible API base, e.g. http://localhost:11434/v1")
    ap.add_argument("--model", required=True, help="Model ID")
    ap.add_argument("--api-key", default=None, help="Optional bearer token")
    ap.add_argument("--timeout", type=float, default=600.0,
                    help="Per-request timeout in seconds (default: 600)")
    args = ap.parse_args()
    args.url = _validate_local_url(args.url)

    kw = {"api_key": args.api_key, "timeout": args.timeout}

    print(f"Testing {args.model} at {args.url}...", file=sys.stderr)
    results: dict[str, dict] = {}
    for name, fn in TESTS:
        print(f"  Running {name}...", end=" ", file=sys.stderr, flush=True)
        try:
            r = fn(args.url, args.model, **kw)
        except Exception as e:  # noqa: BLE001
            r = {"score": 0.0, "detail": f"test crashed: {e}", "duration_s": 0.0}
        results[name] = r
        print(f"score={r['score']:.1f} ({r['duration_s']}s)", file=sys.stderr)

    avg = sum(r["score"] for r in results.values()) / len(results)
    # .get() guards against TESTS being reordered/renamed without updating the
    # verdict logic — a missing structured test scores 0 and fails the AND-gate
    # rather than crashing with KeyError and producing no JSON.
    structured_score = results.get(STRUCTURED_TEST_KEY, {"score": 0.0})["score"]
    passed = (avg >= PASS_AVG_THRESHOLD
              and structured_score >= PASS_STRUCTURED_THRESHOLD)

    output = {
        "url": args.url,
        "model": args.model,
        "tests": results,
        "average_score": round(avg, 2),
        "verdict": "pass" if passed else "fail",
        "threshold_average": PASS_AVG_THRESHOLD,
        "threshold_structured": PASS_STRUCTURED_THRESHOLD,
    }
    json.dump(output, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
