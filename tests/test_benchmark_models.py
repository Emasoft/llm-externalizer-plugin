#!/usr/bin/env python3
"""Tests for scripts/setup/benchmark-models.py.

Covers:
  - CLI help runs without crash
  - Argparse contract matches the TRDD-65867b68 Phase 3 spec
  - Backend port resolution (lmstudio:1234, ollama:11434, vllm:8000, vmlx:8000)
  - Ranking algorithm (viability rules + tie-breakers)
  - Decision rule: viable iff smoke+structured PASS AND tps >= floor
  - Atomic JSON write (tmp + mv)
  - vMLX detection + delegation to `vmlx bench` JSON output
  - Fail-fast: unreachable backend → exit 1 with diagnostic
  - Markdown rendering

These tests deliberately do NOT mock the LLM endpoints — they probe the script
surface (CLI, ranking, atomic writes) and use real backend-reachability
checks (which fail-fast in offline CI exactly as required).
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BENCH_PATH = PROJECT_ROOT / "scripts" / "setup" / "benchmark-models.py"


def _load_bench_module():
    """Import the dashed-name script as a module for whitebox testing.

    benchmark-models.py is invoked as a CLI but the helpers (rank_models,
    backend_url, atomic_write_json, etc.) are easier to test in-process.
    """
    spec = importlib.util.spec_from_file_location("benchmark_models", BENCH_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


def test_script_exists() -> None:
    """The script file must exist at the canonical setup/ location."""
    assert BENCH_PATH.is_file(), f"missing {BENCH_PATH}"


def test_script_is_executable() -> None:
    """The script must have the executable bit set (matches sibling scripts)."""
    assert os.access(BENCH_PATH, os.X_OK), f"not executable: {BENCH_PATH}"


def test_help_does_not_crash() -> None:
    """`benchmark-models.py --help` must exit 0 and print Usage."""
    r = subprocess.run(
        [sys.executable, str(BENCH_PATH), "--help"],
        capture_output=True, text=True, timeout=10,
    )
    assert r.returncode == 0, f"non-zero exit: {r.returncode}, stderr={r.stderr}"
    assert "usage" in r.stdout.lower() or "usage" in r.stderr.lower()


def test_help_advertises_required_flags() -> None:
    """All flags from the TRDD spec must appear in --help output."""
    r = subprocess.run(
        [sys.executable, str(BENCH_PATH), "--help"],
        capture_output=True, text=True, timeout=10,
    )
    combined = (r.stdout + r.stderr).lower()
    required_flags = [
        "--backend", "--model", "--auto-detect-models",
        "--min-tps", "--output", "--results-path", "--quiet",
    ]
    missing = [f for f in required_flags if f not in combined]
    assert not missing, f"missing flags in --help: {missing}"


# ---------------------------------------------------------------------------
# Backend URL resolution
# ---------------------------------------------------------------------------


def test_backend_url_lmstudio_default() -> None:
    """lmstudio backend resolves to localhost:1234/v1."""
    mod = _load_bench_module()
    assert mod.backend_url("lmstudio") == "http://localhost:1234/v1"


def test_backend_url_ollama_default() -> None:
    """ollama backend resolves to localhost:11434/v1."""
    mod = _load_bench_module()
    assert mod.backend_url("ollama") == "http://localhost:11434/v1"


def test_backend_url_vllm_default() -> None:
    """vllm backend resolves to localhost:8000/v1."""
    mod = _load_bench_module()
    assert mod.backend_url("vllm") == "http://localhost:8000/v1"


def test_backend_url_vllm_metal_default() -> None:
    """vllm-metal also uses :8000 (same OpenAI-compatible surface)."""
    mod = _load_bench_module()
    assert mod.backend_url("vllm-metal") == "http://localhost:8000/v1"


def test_backend_url_vmlx_default() -> None:
    """vmlx uses :8000."""
    mod = _load_bench_module()
    assert mod.backend_url("vmlx") == "http://localhost:8000/v1"


def test_backend_url_unknown_raises() -> None:
    """An unknown backend name is a config error, not a silent fallback."""
    mod = _load_bench_module()
    with pytest.raises((ValueError, KeyError, SystemExit)):
        mod.backend_url("nonexistent-backend")


# ---------------------------------------------------------------------------
# Ranking algorithm
# ---------------------------------------------------------------------------


def test_rank_models_marks_viable_when_smoke_and_structured_pass() -> None:
    """A model that passes smoke + structured AND meets tps floor is viable."""
    mod = _load_bench_module()
    record = {
        "model": "qwen3-8b",
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 0.7},
            "long_context": {"score": 0.5},
            "output_length": {"score": 1.0},
        },
        "perf": {"tokens_per_second": 25.0, "ttft_s": 0.4},
    }
    ranked = mod.rank_models([record], min_tps=5.0)
    assert ranked[0]["viable"] is True


def test_rank_models_not_viable_when_structured_fails() -> None:
    """structured_output failure → not viable (plugin requires JSON schema)."""
    mod = _load_bench_module()
    record = {
        "model": "broken-json",
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 0.0},
            "code_understanding": {"score": 1.0},
            "long_context": {"score": 1.0},
            "output_length": {"score": 1.0},
        },
        "perf": {"tokens_per_second": 100.0, "ttft_s": 0.1},
    }
    ranked = mod.rank_models([record], min_tps=5.0)
    assert ranked[0]["viable"] is False


def test_rank_models_not_viable_when_smoke_fails() -> None:
    """smoke failure → not viable (basic transport is broken)."""
    mod = _load_bench_module()
    record = {
        "model": "dead",
        "tests": {
            "smoke": {"score": 0.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 0.0},
            "long_context": {"score": 0.0},
            "output_length": {"score": 0.0},
        },
        "perf": {"tokens_per_second": 100.0, "ttft_s": 0.1},
    }
    ranked = mod.rank_models([record], min_tps=5.0)
    assert ranked[0]["viable"] is False


def test_rank_models_not_viable_when_tps_below_floor() -> None:
    """tokens/s below --min-tps → not viable even if all tests pass."""
    mod = _load_bench_module()
    record = {
        "model": "slow",
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 1.0},
            "long_context": {"score": 1.0},
            "output_length": {"score": 1.0},
        },
        "perf": {"tokens_per_second": 2.0, "ttft_s": 5.0},
    }
    ranked = mod.rank_models([record], min_tps=5.0)
    assert ranked[0]["viable"] is False


def test_rank_models_orders_viable_above_non_viable() -> None:
    """Viable models always rank above non-viable, regardless of perf."""
    mod = _load_bench_module()
    fast_broken = {
        "model": "fast-broken",
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 0.0},  # disqualifies
            "code_understanding": {"score": 0.0},
            "long_context": {"score": 0.0},
            "output_length": {"score": 0.0},
        },
        "perf": {"tokens_per_second": 200.0, "ttft_s": 0.05},
    }
    slow_good = {
        "model": "slow-good",
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 0.7},
            "long_context": {"score": 1.0},
            "output_length": {"score": 0.5},
        },
        "perf": {"tokens_per_second": 10.0, "ttft_s": 1.0},
    }
    ranked = mod.rank_models([fast_broken, slow_good], min_tps=5.0)
    assert ranked[0]["model"] == "slow-good"
    assert ranked[1]["model"] == "fast-broken"


def test_rank_models_orders_viable_by_combined_score() -> None:
    """Among viable models, higher average + higher tps ranks first."""
    mod = _load_bench_module()
    higher_quality = {
        "model": "high-q",
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 1.0},
            "long_context": {"score": 1.0},
            "output_length": {"score": 1.0},
        },
        "perf": {"tokens_per_second": 15.0, "ttft_s": 0.5},
    }
    lower_quality = {
        "model": "low-q",
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 0.3},
            "long_context": {"score": 0.2},
            "output_length": {"score": 0.5},
        },
        "perf": {"tokens_per_second": 30.0, "ttft_s": 0.3},
    }
    ranked = mod.rank_models([higher_quality, lower_quality], min_tps=5.0)
    assert ranked[0]["model"] == "high-q"


# ---------------------------------------------------------------------------
# Atomic JSON write
# ---------------------------------------------------------------------------


def test_atomic_write_json_round_trip() -> None:
    """atomic_write_json writes JSON and the file is readable + parseable."""
    mod = _load_bench_module()
    payload = {"a": 1, "b": ["x", "y"], "nested": {"k": 3.14}}
    with tempfile.TemporaryDirectory() as td:
        target = Path(td) / "out.json"
        mod.atomic_write_json(target, payload)
        assert target.is_file()
        assert json.loads(target.read_text()) == payload


def test_atomic_write_json_no_tmp_leak() -> None:
    """After a successful write, no .tmp* sibling is left behind."""
    mod = _load_bench_module()
    with tempfile.TemporaryDirectory() as td:
        target = Path(td) / "out.json"
        mod.atomic_write_json(target, {"k": 1})
        tmps = [p for p in Path(td).iterdir() if ".tmp" in p.name]
        assert tmps == [], f"leftover tmp files: {tmps}"


def test_atomic_write_json_creates_parent_dir() -> None:
    """atomic_write_json must mkdir -p the parent (results-path may be new)."""
    mod = _load_bench_module()
    with tempfile.TemporaryDirectory() as td:
        target = Path(td) / "new" / "subdir" / "out.json"
        mod.atomic_write_json(target, {"k": 1})
        assert target.is_file()


# ---------------------------------------------------------------------------
# vMLX detection + delegation
# ---------------------------------------------------------------------------


def test_is_vmlx_runner_returns_false_when_endpoint_unreachable() -> None:
    """A bogus URL must NOT be mis-detected as vMLX."""
    mod = _load_bench_module()
    assert mod.is_vmlx_runner("http://127.0.0.1:1/v1") is False


def test_strip_v1_suffix_preserves_host_with_dots_and_digits() -> None:
    """Regression: rstrip('/v1') is character-wise and eats IPs like 192.168.1.11.

    The fix uses substring-aware slicing. Tests cover IPs, hostnames, and
    URLs with and without trailing slashes — all must keep their host intact.
    """
    mod = _load_bench_module()
    assert mod._strip_v1_suffix("http://192.168.1.11/v1") == "http://192.168.1.11"
    assert mod._strip_v1_suffix("http://192.168.1.11/v1/") == "http://192.168.1.11"
    assert mod._strip_v1_suffix("http://srv.local/v1") == "http://srv.local"
    assert mod._strip_v1_suffix("http://localhost:8000/v1") == "http://localhost:8000"
    # No /v1 suffix at all → unchanged.
    assert mod._strip_v1_suffix("http://localhost:8000") == "http://localhost:8000"


def test_vmlx_bench_delegation_when_cli_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """When `vmlx bench` is available, perf numbers come from its --json output."""
    mod = _load_bench_module()

    fake_output = json.dumps({
        "tokens_per_second": 42.5,
        "ttft_ms": 350,
        "prompt_tokens": 100,
        "completion_tokens": 500,
    })

    class FakeCompleted:
        returncode = 0
        stdout = fake_output
        stderr = ""

    def fake_run(args, **kwargs):  # noqa: ARG001
        # Verify the script invokes `vmlx bench <model> --json`
        assert args[0] == "vmlx"
        assert args[1] == "bench"
        assert "--json" in args
        return FakeCompleted()

    monkeypatch.setattr(subprocess, "run", fake_run)
    perf = mod.run_vmlx_bench("mlx-community/Qwen3-8B-4bit")
    assert perf["tokens_per_second"] == 42.5
    # ttft in seconds, converted from ms
    assert abs(perf["ttft_s"] - 0.35) < 1e-6


def test_vmlx_bench_returns_none_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """If `vmlx bench` exits non-zero, return None so caller falls back to in-script timing."""
    mod = _load_bench_module()

    class FakeCompleted:
        returncode = 1
        stdout = ""
        stderr = "boom"

    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: FakeCompleted())
    assert mod.run_vmlx_bench("any-model") is None


# ---------------------------------------------------------------------------
# Fail-fast on unreachable backend
# ---------------------------------------------------------------------------


def test_unreachable_backend_exits_one_with_diagnostic() -> None:
    """Per spec: if backend not reachable, exit 1 with a one-line diagnostic."""
    # Use port 1 which the kernel reserves and refuses immediately.
    r = subprocess.run(
        [sys.executable, str(BENCH_PATH),
         "--backend", "vllm",
         "--model", "bogus-model",
         "--results-path", "/tmp/llmext-benchmark-test-unreachable.json"],
        capture_output=True, text=True, timeout=30,
        env={**os.environ, "LLMEXT_BENCH_PROBE_PORT": "1"},
    )
    assert r.returncode == 1, (
        f"expected exit 1 on unreachable backend, got {r.returncode}\n"
        f"stdout={r.stdout!r}\nstderr={r.stderr!r}"
    )
    # The diagnostic must mention what failed in some recognizable way.
    combined = (r.stdout + r.stderr).lower()
    assert any(k in combined for k in (
        "unreach", "not running", "connection", "refused", "could not",
        "backend", "vllm",
    )), f"no diagnostic found. stdout={r.stdout!r} stderr={r.stderr!r}"


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


def test_render_markdown_includes_table_header() -> None:
    """The markdown output must include a pipe-table header for the ranked rows."""
    mod = _load_bench_module()
    ranked = [{
        "model": "qwen3-8b",
        "viable": True,
        "average_score": 0.84,
        "perf": {"tokens_per_second": 22.0, "ttft_s": 0.4},
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 0.7},
            "long_context": {"score": 0.5},
            "output_length": {"score": 1.0},
        },
    }]
    md = mod.render_markdown(ranked, min_tps=5.0)
    assert "| Model" in md
    assert "qwen3-8b" in md
    # The decision rule should be documented somewhere in the output.
    assert "viable" in md.lower() or "min-tps" in md.lower() or "5" in md
