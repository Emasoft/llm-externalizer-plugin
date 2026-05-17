#!/usr/bin/env python3
"""benchmark-models.py — Reliability + throughput benchmark for local LLM backends.

For each candidate model (passed via --model or auto-detected from the backend's
/v1/models endpoint), this script:

  1. Runs the 5 reliability tests already used by the setup wizard:
     smoke, structured_output, code_understanding, long_context, output_length.
     Implementation reused from `test-model.py` (zero duplication).
  2. Measures throughput (tokens/s), TTFT (time to first token), and total
     latency on a fixed perf prompt.
  3. If the active backend is vMLX (`vmlx bench` available + server detected on
     :8000), delegates perf to `vmlx bench --json` — its numbers are calibrated
     for MLX and more accurate than naive wall-clock timing.
  4. Aggregates into a viability-ranked table:
       markdown to stdout
       JSON to ~/.llm-externalizer/benchmark-results.json (atomic: tmp + os.replace)
  5. Decision rule (from TRDD-65867b68 Phase 3): a model is a "viable local
     alternative" iff smoke + structured_output both score ≥ 0.5 AND
     tokens_per_second ≥ --min-tps (default: 5).

Usage:
    benchmark-models.py --backend lmstudio --model qwen3-coder-8b-mlx
    benchmark-models.py --backend vmlx --auto-detect-models --min-tps 10
    benchmark-models.py --backend ollama --auto-detect-models --output md

Stdlib-only except the optional `vmlx` CLI (only invoked when --backend vmlx).
Matches the test-model.py / detect-runners.py convention: this must run before
the user has any extra Python deps installed.

Per-project rule: invoke via `uv run scripts/setup/benchmark-models.py`. The
shebang is `python3` so direct execution still works.

Architecture: pure-function helpers live in _bench_helpers.py (kept separate so
this file stays under the 500-LOC project cap). This file owns orchestration —
loading test-model.py via importlib, per-model loop, vmlx delegation, CLI.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError

# Helpers live in a sibling module so this file stays small. The conftest.py
# adds scripts/setup/ to sys.path so this import works inside tests AND when
# invoked directly via shebang from anywhere on disk (the relative
# importlib trick below for test-model.py is the model we follow).
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from _bench_helpers import (  # noqa: E402 — sys.path insert MUST precede
    BACKEND_PORTS,
    PERF_PROMPT,
    VIABILITY_THRESHOLD,
    _strip_v1_suffix,
    atomic_write_json,
    backend_url,
    is_backend_reachable,
    is_vmlx_runner,
    list_backend_models,
    rank_models,
    render_markdown,
)

# Re-export so callers (including the test harness) can import them from this
# script directly. Helps consumers stay version-agnostic about the helper split.
__all__ = [
    "BACKEND_PORTS", "PERF_PROMPT", "VIABILITY_THRESHOLD",
    "_strip_v1_suffix", "atomic_write_json", "backend_url",
    "benchmark_one_model", "is_backend_reachable", "is_vmlx_runner",
    "list_backend_models", "main", "measure_throughput", "rank_models",
    "render_markdown", "run_vmlx_bench",
]

# ---------------------------------------------------------------------------
# Reuse the calibrated tests from test-model.py — zero duplication
# ---------------------------------------------------------------------------
# test-model.py uses a dashed filename so we cannot `import test_model`; load
# it via importlib. Doing this once at module top means callers get an actual
# Python module with all the test functions exposed as attributes.
_TEST_MODEL_PATH = _SCRIPT_DIR / "test-model.py"


def _load_test_model_module():
    """Import test-model.py as a Python module despite the dashed filename."""
    if not _TEST_MODEL_PATH.is_file():
        raise SystemExit(
            f"[benchmark-models] test-model.py not found at {_TEST_MODEL_PATH} — "
            "this script depends on it for the reliability suite. Reinstall the plugin."
        )
    spec = importlib.util.spec_from_file_location("test_model", _TEST_MODEL_PATH)
    if spec is None or spec.loader is None:
        raise SystemExit(f"[benchmark-models] cannot load {_TEST_MODEL_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_TM = _load_test_model_module()
TESTS = _TM.TESTS  # [(name, fn), ...]
call_chat = _TM.call_chat
extract_content = _TM.extract_content
_validate_local_url = _TM._validate_local_url


# ---------------------------------------------------------------------------
# Throughput measurement
# ---------------------------------------------------------------------------
# We use a single short prompt and ask for a bounded output. Wall-clock from
# request issue → response complete divided by completion tokens gives a
# noisy but reliable tokens/s estimate. TTFT is approximated as
# (total_latency / output_tokens) for a one-shot call — true TTFT would need
# streaming, which is out of scope for stdlib-only.


def measure_throughput(
    url: str,
    model: str,
    *,
    api_key: Optional[str] = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    """One-shot throughput probe via OpenAI-compatible /chat/completions.

    Returns:
        {
            "tokens_per_second": float,
            "ttft_s": float,              # approximate — see module docstring
            "total_latency_s": float,
            "completion_tokens": int,
            "prompt_tokens": int,
            "source": "in-script",
        }
    Failure returns the same shape with tokens_per_second=0.0 + an "error" key.
    """
    t0 = time.perf_counter()
    resp = call_chat(
        url, model,
        [{"role": "user", "content": PERF_PROMPT}],
        max_tokens=400, api_key=api_key, timeout=timeout,
    )
    elapsed = time.perf_counter() - t0

    if "error" in resp and isinstance(resp["error"], str) and resp["error"]:
        return {
            "tokens_per_second": 0.0,
            "ttft_s": 0.0,
            "total_latency_s": round(elapsed, 3),
            "completion_tokens": 0,
            "prompt_tokens": 0,
            "source": "in-script",
            "error": resp["error"],
        }

    usage = resp.get("usage") if isinstance(resp, dict) else None
    completion_tokens = 0
    prompt_tokens = 0
    if isinstance(usage, dict):
        completion_tokens = int(usage.get("completion_tokens") or 0)
        prompt_tokens = int(usage.get("prompt_tokens") or 0)

    # Fallback when the backend omits usage (some llama.cpp builds): estimate
    # ~4 chars per token from the response content. Better than reporting 0.
    if completion_tokens == 0:
        content, _hint = extract_content(resp)
        completion_tokens = max(1, len(content) // 4)

    tps = completion_tokens / elapsed if elapsed > 0 else 0.0
    # Approx TTFT — without streaming, the best we can do is assume tokens
    # arrived uniformly. Real TTFT requires SSE, deferred to vmlx bench.
    ttft = elapsed / completion_tokens if completion_tokens > 0 else elapsed

    return {
        "tokens_per_second": round(tps, 2),
        "ttft_s": round(ttft, 3),
        "total_latency_s": round(elapsed, 3),
        "completion_tokens": completion_tokens,
        "prompt_tokens": prompt_tokens,
        "source": "in-script",
    }


def run_vmlx_bench(model: str, timeout: float = 600.0) -> Optional[dict[str, Any]]:
    """Delegate throughput measurement to `vmlx bench <model> --json`.

    vMLX's CLI runs a calibrated streaming benchmark and emits structured JSON
    with tokens/s + TTFT. Return None on any failure so the caller can fall
    back to in-script timing — never raise (caller has its own fallback path).
    """
    if shutil.which("vmlx") is None:
        return None
    try:
        result = subprocess.run(
            ["vmlx", "bench", model, "--json"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    # vmlx reports TTFT in milliseconds; normalize to seconds for our schema.
    ttft_ms = payload.get("ttft_ms")
    ttft_s = float(ttft_ms) / 1000.0 if isinstance(ttft_ms, (int, float)) else 0.0
    tps_raw = payload.get("tokens_per_second")
    return {
        "tokens_per_second": float(tps_raw) if isinstance(tps_raw, (int, float)) else 0.0,
        "ttft_s": round(ttft_s, 3),
        "total_latency_s": round(float(payload.get("total_latency_s") or 0.0), 3),
        "completion_tokens": int(payload.get("completion_tokens") or 0),
        "prompt_tokens": int(payload.get("prompt_tokens") or 0),
        "source": "vmlx-bench",
    }


# ---------------------------------------------------------------------------
# Per-model orchestration
# ---------------------------------------------------------------------------


def benchmark_one_model(
    url: str,
    model: str,
    *,
    api_key: Optional[str] = None,
    timeout: float = 600.0,
    use_vmlx_bench: bool = False,
    quiet: bool = False,
) -> dict[str, Any]:
    """Run the 5 reliability tests + a throughput probe on a single model."""
    if not quiet:
        print(f"[bench] {model}: running {len(TESTS)} reliability tests + perf probe...",
              file=sys.stderr)

    kw = {"api_key": api_key, "timeout": timeout}
    test_results: dict[str, dict] = {}
    for name, fn in TESTS:
        if not quiet:
            print(f"  [{name}] ...", end=" ", file=sys.stderr, flush=True)
        try:
            r = fn(url, model, **kw)
        except (URLError, HTTPError, TimeoutError, socket.timeout, OSError,
                json.JSONDecodeError, KeyError, IndexError, ValueError) as e:
            # Same narrow catch as test-model.py — only transport / parse /
            # shape errors get classified as model failures; anything else is
            # a harness bug and must propagate.
            r = {"score": 0.0,
                 "detail": f"test crashed ({type(e).__name__}): {e}",
                 "duration_s": 0.0}
        test_results[name] = r
        if not quiet:
            print(f"score={r['score']:.1f} ({r.get('duration_s', 0.0)}s)",
                  file=sys.stderr)

    if not quiet:
        print("  [perf] ...", end=" ", file=sys.stderr, flush=True)
    perf = None
    if use_vmlx_bench:
        perf = run_vmlx_bench(model, timeout=timeout)
    if perf is None:
        perf = measure_throughput(url, model, api_key=api_key, timeout=timeout)
    if not quiet:
        print(f"{perf['tokens_per_second']} tok/s ({perf['source']})",
              file=sys.stderr)

    return {
        "model": model,
        "url": url,
        "tests": test_results,
        "perf": perf,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


DEFAULT_RESULTS_PATH = Path.home() / ".llm-externalizer" / "benchmark-results.json"


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Benchmark local LLM models for reliability + throughput. "
                    "Decides which models are viable alternatives for the "
                    "llm-externalizer plugin.",
    )
    ap.add_argument(
        "--backend", required=True,
        choices=sorted(BACKEND_PORTS),
        help="Local backend to probe (lmstudio:1234, ollama:11434, "
             "vllm/vllm-metal/vmlx:8000).",
    )
    ap.add_argument(
        "--model", action="append", default=[],
        help="Model id to benchmark. Repeatable. Mutually exclusive with "
             "--auto-detect-models.",
    )
    ap.add_argument(
        "--auto-detect-models", action="store_true",
        help="Query the backend's /v1/models endpoint and benchmark every "
             "model it lists (subject to --limit).",
    )
    ap.add_argument(
        "--limit", type=int, default=10,
        help="Max number of auto-detected models to benchmark (default: 10).",
    )
    ap.add_argument(
        "--min-tps", type=float, default=5.0,
        help="Minimum tokens/s for a model to be 'viable' (default: 5.0).",
    )
    ap.add_argument(
        "--output", choices=("md", "json", "both"), default="md",
        help="What to print to stdout. md=markdown table, json=raw JSON, "
             "both=markdown then a fenced JSON block (default: md).",
    )
    ap.add_argument(
        "--results-path", type=Path, default=DEFAULT_RESULTS_PATH,
        help=f"Where to save the JSON results (default: {DEFAULT_RESULTS_PATH}).",
    )
    ap.add_argument(
        "--api-key", default=None,
        help="Bearer token if the backend requires auth (LM Studio "
             "--api-key, vmlx serve --api-key, etc.).",
    )
    ap.add_argument(
        "--timeout", type=float, default=600.0,
        help="Per-test timeout in seconds (default: 600).",
    )
    ap.add_argument(
        "--quiet", action="store_true",
        help="Suppress per-test progress on stderr (results still go to stdout).",
    )
    return ap.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)

    url = _validate_local_url(backend_url(args.backend))

    if not args.model and not args.auto_detect_models:
        print(
            "[benchmark-models] specify at least one --model OR "
            "use --auto-detect-models",
            file=sys.stderr,
        )
        return 2  # argparse convention for usage error

    # Fail-fast on unreachable backend — the spec requires this, and a 10-min
    # silent timeout is worse than a 3-second clear error.
    if not is_backend_reachable(url):
        print(
            f"[benchmark-models] backend {args.backend!r} is not reachable at "
            f"{url} — start the server first "
            f"(e.g. `vmlx serve <model>` or `lms server start`).",
            file=sys.stderr,
        )
        return 1

    use_vmlx_bench = (args.backend == "vmlx") and is_vmlx_runner(url)

    # Resolve the model list.
    if args.auto_detect_models:
        models = list_backend_models(url, api_key=args.api_key)
        if not models:
            print(
                f"[benchmark-models] /v1/models returned no models on {url} — "
                "load a model into the backend first.",
                file=sys.stderr,
            )
            return 1
        models = models[: args.limit]
        if args.model:
            # If the user passed both, treat --model as an explicit allowlist
            # filter on the auto-detected list — useful for "benchmark every
            # loaded model in this family" workflows.
            allow = set(args.model)
            models = [m for m in models if m in allow]
            if not models:
                print(
                    f"[benchmark-models] --model filter excluded all "
                    f"auto-detected models on {url}.",
                    file=sys.stderr,
                )
                return 1
    else:
        models = list(args.model)

    if not args.quiet:
        print(
            f"[benchmark-models] backend={args.backend} url={url} "
            f"models={len(models)} vmlx_bench={'yes' if use_vmlx_bench else 'no'}",
            file=sys.stderr,
        )

    records: list[dict[str, Any]] = []
    for model in models:
        records.append(
            benchmark_one_model(
                url, model,
                api_key=args.api_key,
                timeout=args.timeout,
                use_vmlx_bench=use_vmlx_bench,
                quiet=args.quiet,
            )
        )

    ranked = rank_models(records, min_tps=args.min_tps)

    payload = {
        "backend": args.backend,
        "url": url,
        "min_tps": args.min_tps,
        "models_tested": len(ranked),
        "viable_count": sum(1 for r in ranked if r["viable"]),
        "ranked": ranked,
    }
    atomic_write_json(args.results_path, payload)

    if args.output in ("md", "both"):
        sys.stdout.write(render_markdown(ranked, args.min_tps))
    if args.output in ("json", "both"):
        if args.output == "both":
            sys.stdout.write("\n```json\n")
        json.dump(payload, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        if args.output == "both":
            sys.stdout.write("```\n")

    if not args.quiet:
        print(
            f"[benchmark-models] wrote results to {args.results_path}",
            file=sys.stderr,
        )

    # Exit 0 if at least one model is viable, 1 otherwise — gives CI / the
    # setup-agent a clean signal without parsing the JSON.
    return 0 if any(r["viable"] for r in ranked) else 1


if __name__ == "__main__":
    sys.exit(main())
