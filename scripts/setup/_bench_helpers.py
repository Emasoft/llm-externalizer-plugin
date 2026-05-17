"""_bench_helpers.py — helpers for benchmark-models.py.

Kept separate so benchmark-models.py stays under the 500-LOC project cap.
Stdlib-only (same constraint as the parent script). Each helper is
deterministic and easy to unit-test in isolation.

Contents:
  - BACKEND_PORTS                — backend → port map
  - backend_url                  — resolve a backend name to its OpenAI base URL
  - _strip_v1_suffix             — substring-aware /v1 removal (NOT rstrip)
  - _http_get                    — transport-error-safe HTTP GET
  - is_backend_reachable         — /v1/models reachability probe
  - is_vmlx_runner               — /health-based vMLX discrimination
  - list_backend_models          — auto-discover loaded models
  - atomic_write_json            — tmp + os.replace JSON writer
  - render_markdown              — pipe-table rendering
  - _avg_test_score, _is_viable  — ranking primitives
  - rank_models                  — viability gate + sort
  - PERF_PROMPT                  — fixed throughput prompt
  - VIABILITY_THRESHOLD          — smoke / structured floor (0.5)
"""

from __future__ import annotations

import json
import os
import socket
import tempfile
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Backend → URL resolution
# ---------------------------------------------------------------------------
# Default ports match detect-runners.py and the settings.yaml API presets.
# vllm-metal and vmlx both expose OpenAI-compatible APIs on :8000 (see
# TRDD-65867b68 Notes section).
BACKEND_PORTS: dict[str, int] = {
    "lmstudio": 1234,
    "ollama": 11434,
    "vllm": 8000,
    "vllm-metal": 8000,
    "vmlx": 8000,
}


def backend_url(backend: str, host: str = "localhost") -> str:
    """Resolve a backend name to its OpenAI-compatible base URL.

    Fail-fast (ValueError) on unknown backend rather than silently falling
    back — the setup-agent's recommendation depends on knowing exactly which
    runner it's probing.
    """
    if backend not in BACKEND_PORTS:
        raise ValueError(
            f"unknown backend: {backend!r}. "
            f"Supported: {sorted(BACKEND_PORTS)}"
        )
    # Optional override for tests that need to probe a guaranteed-unreachable
    # port. NEVER documented in --help; only used by the test harness.
    port_override = os.environ.get("LLMEXT_BENCH_PROBE_PORT")
    port = int(port_override) if port_override else BACKEND_PORTS[backend]
    return f"http://{host}:{port}/v1"


# ---------------------------------------------------------------------------
# Reachability probe (fail-fast per spec)
# ---------------------------------------------------------------------------


def _http_get(url: str, timeout: float = 3.0) -> tuple[int, dict[str, str], bytes]:
    """GET <url> returning (status, headers, body). Never raises on transport."""
    try:
        with urlopen(Request(url), timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except HTTPError as e:
        try:
            body = e.read()
        except (OSError, AttributeError):
            body = b""
        return e.code, dict(e.headers or {}), body
    except (URLError, TimeoutError, socket.timeout, OSError):
        return 0, {}, b""


def is_backend_reachable(url: str) -> bool:
    """Probe <url>/models — returns True iff the server responds with anything ≥ 200."""
    status, _h, _b = _http_get(url.rstrip("/") + "/models", timeout=3.0)
    return status >= 200


def _strip_v1_suffix(url: str) -> str:
    """Return <url> with a trailing '/v1' (and any trailing slash) removed.

    Subtle: an earlier draft used `url.rstrip('/').rstrip('/v1')` which is
    a real bug — `str.rstrip` operates on a character SET, not a substring.
    For `http://192.168.1.11/v1` the trailing `.11` matches `{., 1}` and
    gets eaten, leaving `http://192.168.1.`. We use plain string slicing
    here so the host part is never touched.
    """
    stripped = url.rstrip("/")
    if stripped.endswith("/v1"):
        stripped = stripped[: -len("/v1")]
    return stripped


def is_vmlx_runner(url: str) -> bool:
    """Discriminate vMLX from vanilla vLLM/llama.cpp on :8000.

    vMLX exposes /health (200 OK with a small JSON body) and identifies via
    the `server` header. Vanilla vLLM has /health too but does NOT advertise
    vmlx — we check both signals defensively so a future vmlx fork that drops
    the header still gets detected via /health probing.
    """
    base = _strip_v1_suffix(url)
    status, headers, body = _http_get(base + "/health", timeout=3.0)
    if status == 0:
        return False
    server_header = (headers.get("Server") or headers.get("server") or "").lower()
    if "vmlx" in server_header:
        return True
    try:
        payload = json.loads(body.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False
    # vmlx /health response includes a "service" or "name" field; vLLM does not.
    if isinstance(payload, dict):
        for k in ("service", "name", "engine"):
            v = payload.get(k)
            if isinstance(v, str) and "vmlx" in v.lower():
                return True
    return False


# ---------------------------------------------------------------------------
# Auto-detect models from the active backend
# ---------------------------------------------------------------------------


def list_backend_models(url: str, api_key: Optional[str] = None) -> list[str]:
    """GET <url>/models → list of model ids. Empty list on any failure."""
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = Request(url.rstrip("/") + "/models", headers=headers)
    try:
        with urlopen(req, timeout=5.0) as r:
            payload = json.loads(r.read().decode("utf-8", errors="replace"))
    except (URLError, HTTPError, TimeoutError, socket.timeout,
            json.JSONDecodeError, OSError):
        return []
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []
    return [item["id"] for item in data
            if isinstance(item, dict) and isinstance(item.get("id"), str)]


# ---------------------------------------------------------------------------
# Throughput primitives
# ---------------------------------------------------------------------------
# Fixed prompt used by measure_throughput. The benchmark must be deterministic
# across runs — same prompt, same max_tokens, so tokens/s is comparable.
PERF_PROMPT = (
    "Write a short Python function that returns the nth Fibonacci number "
    "using memoization. Include a docstring and a 5-line example usage. "
    "Keep the entire response under 400 tokens."
)

# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------
# Viability gate (TRDD-65867b68 Phase 3):
#   passes_smoke      = tests.smoke.score             >= 0.5
#   passes_structured = tests.structured_output.score >= 0.5
#   meets_tps         = perf.tokens_per_second        >= min_tps
#   viable = passes_smoke AND passes_structured AND meets_tps
VIABILITY_THRESHOLD = 0.5  # matches test-model.py PASS_STRUCTURED_THRESHOLD


def _avg_test_score(record: dict[str, Any]) -> float:
    """Average across all 5 reliability tests."""
    scores = [t["score"] for t in record["tests"].values()
              if isinstance(t, dict) and isinstance(t.get("score"), (int, float))]
    return sum(scores) / len(scores) if scores else 0.0


def _is_viable(record: dict[str, Any], min_tps: float) -> bool:
    """Apply the TRDD viability gate to a single benchmark record."""
    tests = record.get("tests", {})
    smoke = tests.get("smoke", {}).get("score", 0.0)
    structured = tests.get("structured_output", {}).get("score", 0.0)
    tps = record.get("perf", {}).get("tokens_per_second", 0.0)
    return (smoke >= VIABILITY_THRESHOLD
            and structured >= VIABILITY_THRESHOLD
            and tps >= min_tps)


def rank_models(records: list[dict[str, Any]], min_tps: float) -> list[dict[str, Any]]:
    """Annotate each record with .viable + .average_score, return sorted list.

    Sort key: (viable DESC, average_score DESC, tokens_per_second DESC).
    Python's sort is stable so two models with identical numbers preserve
    input order — the caller's --model order shows through as a deterministic
    tie-breaker.
    """
    annotated = []
    for rec in records:
        avg = _avg_test_score(rec)
        viable = _is_viable(rec, min_tps)
        annotated.append({**rec, "viable": viable, "average_score": round(avg, 2)})
    annotated.sort(
        key=lambda r: (
            0 if r["viable"] else 1,
            -r["average_score"],
            -r["perf"].get("tokens_per_second", 0.0),
        )
    )
    return annotated


# ---------------------------------------------------------------------------
# Output rendering
# ---------------------------------------------------------------------------


def render_markdown(ranked: list[dict[str, Any]], min_tps: float) -> str:
    """Markdown pipe-table of ranked results — readable in any markdown viewer."""
    lines = [
        "# Local model benchmark",
        "",
        f"Viability rule: `smoke ≥ 0.5` AND `structured_output ≥ 0.5` "
        f"AND `tokens/s ≥ {min_tps}`. Models that fail any gate are listed "
        "below the viable ones for visibility but are NOT recommended.",
        "",
        "| Model | Viable | Avg score | Tokens/s | TTFT (s) | "
        "Smoke | Struct | Code | LongCtx | OutLen | Perf source |",
        "|-------|--------|-----------|----------|----------|"
        "-------|--------|------|---------|--------|-------------|",
    ]
    for r in ranked:
        t = r["tests"]
        perf = r["perf"]
        lines.append(
            f"| `{r['model']}` "
            f"| {'YES' if r['viable'] else 'no'} "
            f"| {r['average_score']:.2f} "
            f"| {perf.get('tokens_per_second', 0.0):.1f} "
            f"| {perf.get('ttft_s', 0.0):.3f} "
            f"| {t.get('smoke', {}).get('score', 0.0):.1f} "
            f"| {t.get('structured_output', {}).get('score', 0.0):.1f} "
            f"| {t.get('code_understanding', {}).get('score', 0.0):.1f} "
            f"| {t.get('long_context', {}).get('score', 0.0):.1f} "
            f"| {t.get('output_length', {}).get('score', 0.0):.1f} "
            f"| {perf.get('source', '?')} |"
        )
    viable_top = next((r for r in ranked if r["viable"]), None)
    lines += ["", ""]
    if viable_top:
        lines.append(
            f"**Recommended:** `{viable_top['model']}` — "
            f"avg {viable_top['average_score']:.2f}, "
            f"{viable_top['perf'].get('tokens_per_second', 0.0):.1f} tok/s."
        )
    else:
        lines.append(
            "**No viable model found.** Lower `--min-tps` or try a different "
            "model. A model that fails `structured_output` cannot run the "
            "llm-externalizer plugin at all."
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Atomic JSON write
# ---------------------------------------------------------------------------


def atomic_write_json(path: Path, payload: Any) -> None:
    """Write JSON via tmp + os.replace so partial writes never corrupt the target.

    The tmp file lives in the SAME directory as the target — os.replace is
    only atomic across files on the same filesystem, and crossing /tmp →
    $HOME would silently degrade to a copy + delete on many setups.
    """
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".tmp.", dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        # Best-effort cleanup of the tmp file if anything fails before replace.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
