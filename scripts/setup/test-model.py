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
import re
import socket
import sys
import time
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# Token shapes we redact from any user-visible error body. Defence-in-depth:
# `call_chat` does NOT log or echo the bearer token itself, but an upstream
# server that mis-handles auth could echo the user's own token back inside its
# error response — at which point that body lands in the wizard's stdout JSON
# unless we sanitise it. Covers OpenAI-style `sk-…`, Hugging Face `hf_…`, and
# generic `Bearer <token>` patterns.
_BEARER_REDACTION_PATTERN = re.compile(
    r"(sk-[A-Za-z0-9_\-]{8,}|hf_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9_\-]{8,})"
)


def _sanitise_error_body(body: str) -> str:
    """Strip bearer-token-shaped substrings from an upstream error body."""
    return _BEARER_REDACTION_PATTERN.sub("[REDACTED]", body)

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
        # Narrow the inner catch: only OSError (socket reset reading body) and
        # UnicodeDecodeError (binary-content error bodies) are expected.
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except (OSError, UnicodeDecodeError, AttributeError):
            err_body = ""
        return {"error": f"HTTP {e.code}: {_sanitise_error_body(err_body)[:200]}"}
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


def extract_content(resp: dict[str, Any]) -> tuple[str, str | None]:
    """Return (text, hint) for an OpenAI-style chat response.

    Discriminates:
      - regular text reply: ("text", None)
      - None content (model used tool_calls / function_call): ("", "model used tool_calls instead of text content — non-text responses are not testable")
      - list content (multimodal parts): ("", "model returned a list of content parts (multimodal); only text replies can be scored")
      - missing fields (malformed shape): ("", "unexpected response shape — no .choices[0].message.content present")

    The previous implementation collapsed all non-text shapes to "" with no
    hint, making it impossible to tell "model failed" from "model used a
    different content shape we don't support".
    """
    try:
        msg = resp["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return "", "unexpected response shape — no .choices[0].message present"
    raw = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(raw, str):
        return raw, None
    if raw is None:
        # Could be tool_calls / function_call. Surface the hint so the user
        # knows their model is using a non-text return shape rather than
        # "failing" the test.
        if isinstance(msg, dict) and (msg.get("tool_calls") or msg.get("function_call")):
            return "", "model used tool_calls / function_call instead of text content"
        return "", "empty response (.choices[0].message.content was null)"
    if isinstance(raw, list):
        return "", "model returned a list of content parts (multimodal); only text replies can be scored"
    return "", f"unexpected content type: {type(raw).__name__}"


def _err_from_call(resp: dict[str, Any]) -> str | None:
    """Return the call_chat sentinel error if present, else None.

    Robust against OpenAI-compatible responses that legitimately include
    `"error": null` alongside a successful `choices` array (common in
    proxy servers and some llama.cpp builds). `if "error" in resp:` would
    falsely treat such responses as failures.
    """
    err = resp.get("error")
    if isinstance(err, str) and err:
        return err
    return None


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

    err = _err_from_call(resp)
    if err is not None:
        return {"score": 0.0, "detail": err, "duration_s": round(duration, 2)}
    content, hint = extract_content(resp)
    content = content.strip()
    if not content:
        return {"score": 0.0, "detail": hint or "empty response", "duration_s": round(duration, 2)}
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

    err = _err_from_call(resp)
    if err is not None:
        return {"score": 0.0, "detail": err, "duration_s": round(duration, 2)}
    content, hint = extract_content(resp)
    content = content.strip()
    if not content:
        return {"score": 0.0, "detail": hint or "empty response", "duration_s": round(duration, 2)}
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

    err = _err_from_call(resp)
    if err is not None:
        return {"score": 0.0, "detail": err, "duration_s": round(duration, 2)}
    content, hint = extract_content(resp)
    if not content:
        return {"score": 0.0, "detail": hint or "empty response", "duration_s": round(duration, 2)}
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
    """Inject ~32K tokens with a needle at ~90% depth; require verbatim recall.

    The previous version used 30K filler tokens with a 1-token "fox" answer —
    a model with a 16K context window could still pattern-match on just the
    prompt prefix and score 1.0, so the test was effectively measuring
    "model can echo a word from the prompt", not "model has 32K context".

    Needle-in-a-haystack is the canonical content-grounded long-context probe:
      - place a unique sentence at the 90 % depth of the input
      - ask the model to return that sentence verbatim
      - score by exact / partial match
    """
    needle = "The blue umbrella belongs to Captain Nemo and lives on the third shelf."
    filler_sentence = "The quick brown fox jumps over the lazy dog. "  # 45 chars ≈ 11 tokens
    # Target ~32K tokens (the plugin's hard requirement) = ~128 K chars at the
    # 4-char-per-token rule of thumb. The needle sits at the 90 % mark so the
    # model can't recover it from a short-context window of just the prompt
    # head.
    total_chars_target = 128 * 1024
    needle_position_chars = int(total_chars_target * 0.9)
    prefix_repetitions = needle_position_chars // len(filler_sentence)
    prefix = filler_sentence * prefix_repetitions
    suffix_target_chars = total_chars_target - len(prefix) - len(needle) - 32
    suffix_repetitions = max(0, suffix_target_chars // len(filler_sentence))
    suffix = filler_sentence * suffix_repetitions

    prompt = (
        "The text below contains exactly one unique 'special sentence' hidden "
        "inside a wall of filler. Find it and return ONLY that sentence, "
        "verbatim, with no extra commentary.\n\nThe text:\n\n"
        + prefix
        + "\nSPECIAL SENTENCE: "
        + needle
        + "\n\n"
        + suffix
    )

    t0 = time.time()
    resp = call_chat(
        url, model,
        [{"role": "user", "content": prompt}],
        max_tokens=200, **kw,
    )
    duration = time.time() - t0

    err = _err_from_call(resp)
    if err is not None:
        return {
            "score": 0.0,
            "detail": f"failed at ~32K-token input: {err}",
            "duration_s": round(duration, 2),
        }
    content, hint = extract_content(resp)
    content = content.strip()
    if not content:
        return {
            "score": 0.0,
            "detail": hint or "empty response on long-context input",
            "duration_s": round(duration, 2),
        }
    lower = content.lower()
    if needle.lower() in lower:
        return {
            "score": 1.0,
            "detail": f"recalled the needle verbatim from ~32K-token input ({duration:.1f}s)",
            "duration_s": round(duration, 2),
        }
    # Distinctive tokens — "umbrella" / "nemo" / "captain" — show partial recall
    # (model found the right region but paraphrased). Better than nothing but
    # not the full ≥32K-context signal we need.
    key_tokens = ("umbrella", "nemo", "captain")
    if any(tok in lower for tok in key_tokens):
        return {
            "score": 0.5,
            "detail": f"partial needle recall (paraphrased) at ~32K tokens "
                      f"({duration:.1f}s): {content[:120]}",
            "duration_s": round(duration, 2),
        }
    return {
        "score": 0.2,
        "detail": f"input accepted but needle NOT recovered — context window "
                  f"may be smaller than 32K ({duration:.1f}s): {content[:120]}",
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

    err = _err_from_call(resp)
    if err is not None:
        return {"score": 0.0, "detail": err, "duration_s": round(duration, 2)}
    content, _hint = extract_content(resp)
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

    print(f"Testing {args.model} at {args.url}", file=sys.stderr)
    print(f"  Running {len(TESTS)} calibrated tests (typical total: 30-90 s)...",
          file=sys.stderr)
    results: dict[str, dict] = {}
    for name, fn in TESTS:
        print(f"  [{name}] ...", end=" ", file=sys.stderr, flush=True)
        try:
            r = fn(args.url, args.model, **kw)
        except (URLError, HTTPError, TimeoutError, socket.timeout, OSError,
                json.JSONDecodeError, KeyError, IndexError, ValueError) as e:
            # Narrow the catch per fail-fast — anything outside this set is a
            # real bug in the test harness and should propagate as a Python
            # traceback rather than masquerade as a model failure. The error
            # class is included in the detail so the agent can distinguish
            # transport (URLError) from harness bugs (KeyError) from model
            # bugs (JSONDecodeError) when surfacing the failure.
            r = {"score": 0.0,
                 "detail": f"test crashed ({type(e).__name__}): {e}",
                 "duration_s": 0.0}
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
