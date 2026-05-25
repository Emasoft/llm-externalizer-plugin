"""TDD guards for _bench_helpers batch-resilience contract (TRDD-6e859d3c D2).

The module's contract — established by _is_viable's use of `.get(..., {})` — is
that one malformed benchmark record (missing "tests" or "perf") must not crash
the whole rank/render batch. These tests fail against the pre-fix direct-index
versions and pass after the `.get(...)` fix.

scripts/setup/ is already on sys.path via tests/conftest.py, so a plain
`import _bench_helpers` resolves. importlib fallback covers the case where the
test file is run outside the conftest-managed sys.path.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

try:
    import _bench_helpers as bh
except ModuleNotFoundError:  # run without conftest on sys.path
    _PATH = Path(__file__).resolve().parent.parent / "scripts" / "setup" / "_bench_helpers.py"
    _spec = importlib.util.spec_from_file_location("_bench_helpers", _PATH)
    assert _spec and _spec.loader
    bh = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(bh)


def _good_record(model: str = "good/model", tps: float = 50.0) -> dict:
    """A well-formed record that passes the viability gate."""
    return {
        "model": model,
        "tests": {
            "smoke": {"score": 1.0},
            "structured_output": {"score": 1.0},
            "code_understanding": {"score": 0.8},
            "long_context": {"score": 0.6},
            "output_length": {"score": 0.9},
        },
        "perf": {"tokens_per_second": tps, "ttft_s": 0.2, "source": "measured"},
    }


def test_rank_models_record_missing_perf_does_not_raise() -> None:
    """rank_models tolerates a record with no 'perf' key and still ranks it."""
    records = [_good_record("a/b", tps=80.0), {"model": "no/perf", "tests": {}}]
    ranked = bh.rank_models(records, min_tps=10.0)
    assert len(ranked) == 2
    # The well-formed viable model must sort ahead of the perf-less one.
    assert ranked[0]["model"] == "a/b"
    assert ranked[0]["viable"] is True
    # The perf-less record is annotated, not crashed, and is non-viable.
    no_perf = next(r for r in ranked if r["model"] == "no/perf")
    assert no_perf["viable"] is False
    assert no_perf["average_score"] == 0.0


def test_render_markdown_record_missing_tests_and_perf_does_not_raise() -> None:
    """render_markdown renders a 'tests'/'perf'-less record without crashing."""
    ranked = bh.rank_models(
        [_good_record("a/b"), {"model": "bare/model"}],
        min_tps=10.0,
    )
    md = bh.render_markdown(ranked, min_tps=10.0)
    assert isinstance(md, str)
    assert "`bare/model`" in md  # the malformed record still appears in the table
    assert "`a/b`" in md
    assert "Recommended" in md  # the viable model is still recommended


def test_avg_test_score_missing_tests_returns_zero() -> None:
    """_avg_test_score returns the 0.0 safe default when 'tests' is absent."""
    assert bh._avg_test_score({"model": "x/y"}) == 0.0


def test_wellformed_batch_ranks_and_renders_correctly() -> None:
    """A clean batch still ranks by viability/score and renders the table (no regression)."""
    fast_viable = _good_record("fast/viable", tps=120.0)
    slow_nonviable = _good_record("slow/fail", tps=120.0)
    slow_nonviable["tests"]["structured_output"]["score"] = 0.1  # fails the gate

    ranked = bh.rank_models([slow_nonviable, fast_viable], min_tps=10.0)
    # Viable model floats to the top despite being second in input order.
    assert ranked[0]["model"] == "fast/viable"
    assert ranked[0]["viable"] is True
    assert ranked[1]["model"] == "slow/fail"
    assert ranked[1]["viable"] is False

    md = bh.render_markdown(ranked, min_tps=10.0)
    assert "**Recommended:** `fast/viable`" in md
    assert "| `fast/viable` | YES " in md
    assert "| `slow/fail` | no " in md
