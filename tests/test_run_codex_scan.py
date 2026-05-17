#!/usr/bin/env python3
"""Tests for scripts/codex/run-codex-scan.py.

Covers:
  - Rate-limit detection (true / false branches of looks_like_rate_limit)
  - Bin packing (pack_batches) — small fit, multi-bin split, oversized lone file
  - Prompt assembly (build_prompt + build_files_block + load_prompt_template)
  - Missing-file behaviour in the file-block renderer
  - Finding-count regex (count_findings) — non-zero and zero cases
  - CLI smoke test (--help exits 0 with usage)

The SUT helpers are invoked directly. No external services are mocked away —
codex/git/Opus are not touched because none of these tests run main(). The
script's module name has dashes, so it is loaded via importlib.util the
same way tests/test_benchmark_models.py loads benchmark-models.py.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SUT_PATH = PROJECT_ROOT / "scripts" / "codex" / "run-codex-scan.py"


def _load_sut():
    """Load run-codex-scan.py as a module. Dashed filename → importlib.

    The module is registered in sys.modules BEFORE exec_module so that
    `@dataclass` (with `from __future__ import annotations`) can resolve
    its own class namespace during decorator evaluation. Without the
    registration, dataclasses._is_type does
    `sys.modules.get(cls.__module__).__dict__` and crashes on NoneType.
    """
    spec = importlib.util.spec_from_file_location("run_codex_scan", SUT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["run_codex_scan"] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def sut():
    """Module-scoped SUT load — same module instance across all tests."""
    return _load_sut()


# ---------------------------------------------------------------------------
# 1-2. Rate-limit detection
# ---------------------------------------------------------------------------


def test_rate_limit_detected_in_response_body(sut) -> None:
    """looks_like_rate_limit returns True when stderr contains 'rate limit'."""
    stdout = ""
    stderr = "Error: you have hit the rate limit, please retry later."
    assert sut.looks_like_rate_limit(stdout, stderr) is True


def test_normal_response_not_flagged_as_rate_limit(sut) -> None:
    """looks_like_rate_limit returns False for a clean completion message."""
    stdout = "## File: foo.py\n- [low] line 3: unused import\n"
    stderr = ""
    assert sut.looks_like_rate_limit(stdout, stderr) is False


# ---------------------------------------------------------------------------
# 3-5. Bin packing (pack_batches)
# ---------------------------------------------------------------------------


def _make_file(tmp_path: Path, name: str, size_bytes: int) -> Path:
    """Create a file of exactly `size_bytes` bytes."""
    p = tmp_path / name
    # 'a' * N produces exactly N bytes in UTF-8
    p.write_bytes(b"a" * size_bytes)
    return p


def test_pack_batches_three_small_files_fit_in_one_bin(sut, tmp_path) -> None:
    """3 files of 10 KB each, max 400 KB → 1 bin holding all 3 files."""
    files = [_make_file(tmp_path, f"f{i}.py", 10_000) for i in range(3)]
    batches = sut.pack_batches(files, max_bytes=400_000)
    assert len(batches) == 1
    assert len(batches[0].paths) == 3
    assert batches[0].total_bytes == 30_000
    assert set(batches[0].paths) == set(files)


def test_pack_batches_five_large_files_split_into_multiple_bins(sut, tmp_path) -> None:
    """5 files × 100 KB, max 400 KB → ≥2 bins, none exceeding the cap."""
    files = [_make_file(tmp_path, f"big{i}.py", 100_000) for i in range(5)]
    batches = sut.pack_batches(files, max_bytes=400_000)
    assert len(batches) >= 2, f"expected ≥2 bins, got {len(batches)}"
    for b in batches:
        assert b.total_bytes <= 400_000, (
            f"bin overflow: {b.total_bytes} > 400_000 with {len(b.paths)} files"
        )
    # All 5 files must be accounted for exactly once.
    all_packed = [p for b in batches for p in b.paths]
    assert len(all_packed) == 5
    assert set(all_packed) == set(files)


def test_pack_batches_oversized_file_gets_its_own_bin_no_crash(sut, tmp_path) -> None:
    """A single file > max_bytes returns in its own bin without raising."""
    big = _make_file(tmp_path, "huge.py", 500_000)
    # Must NOT raise ValueError or any other exception.
    batches = sut.pack_batches([big], max_bytes=400_000)
    assert len(batches) == 1
    assert batches[0].paths == [big]
    assert batches[0].total_bytes == 500_000


# ---------------------------------------------------------------------------
# 6-7. Prompt assembly
# ---------------------------------------------------------------------------


def test_build_prompt_includes_system_header_and_file_markers(sut, tmp_path) -> None:
    """build_prompt's output must contain the template's system header
    AND a `## File: <path>` marker for every file in the batch."""
    f1 = _make_file(tmp_path, "alpha.py", 50)
    f2 = _make_file(tmp_path, "beta.py", 50)
    batch = sut.Batch(paths=[f1, f2], total_bytes=100)
    template = sut.load_prompt_template()
    prompt = sut.build_prompt(batch, template)

    # System header from the real template (line 1 of codex-scan-prompt.txt)
    assert "senior code reviewer" in prompt
    # Per-file markers — exact format from build_files_block (line 258)
    assert f"## File: {f1}" in prompt
    assert f"## File: {f2}" in prompt
    # The {FILES_BLOCK} placeholder must have been substituted away.
    assert "{FILES_BLOCK}" not in prompt


def test_build_files_block_handles_missing_file_without_raising(sut, tmp_path) -> None:
    """A path that does not exist on disk must not crash build_files_block;
    the path is still emitted as a `## File:` section with an error
    placeholder body. (Per SUT line 256-258, OSError is caught and the
    content is replaced with `(could not read: ...)`.)"""
    missing = tmp_path / "does-not-exist.py"
    real = _make_file(tmp_path, "real.py", 20)
    assert not missing.exists()
    batch = sut.Batch(paths=[missing, real], total_bytes=20)

    # Must not raise OSError / FileNotFoundError.
    block = sut.build_files_block(batch)

    # The real file's content is rendered normally.
    assert f"## File: {real}" in block
    # The missing file path still appears as a section header, with a
    # parenthesised error in place of its body (no source code).
    assert f"## File: {missing}" in block
    assert "could not read" in block


# ---------------------------------------------------------------------------
# 8-9. Finding-count extraction (count_findings)
# ---------------------------------------------------------------------------


def test_count_findings_detects_three_severity_tagged_lines(sut) -> None:
    """count_findings returns 3 when the report has 3 severity-tagged
    findings (the real format the prompt asks Codex to emit)."""
    report = (
        "## File: foo.py\n"
        "- [critical] line 12: SQL injection via string concat\n"
        "  Fix: use parameterized queries\n"
        "- [high] line 45: unclosed file handle\n"
        "  Fix: use a context manager\n"
        "- [medium] line 87: bare except\n"
        "  Fix: catch specific exceptions\n"
    )
    assert sut.count_findings(report) == 3


def test_count_findings_returns_zero_for_empty_or_no_findings_report(sut) -> None:
    """count_findings returns 0 when the report has no severity-tagged
    lines. Both an empty string and a '(no findings)' marker count as 0."""
    assert sut.count_findings("") == 0
    assert sut.count_findings(
        "## File: clean.py\n(no findings)\n"
    ) == 0


# ---------------------------------------------------------------------------
# 10. CLI smoke test
# ---------------------------------------------------------------------------


def test_cli_help_exits_zero_with_usage(tmp_path) -> None:
    """`python run-codex-scan.py --help` exits 0 and prints 'usage'."""
    r = subprocess.run(
        [sys.executable, str(SUT_PATH), "--help"],
        capture_output=True, text=True, timeout=15,
    )
    assert r.returncode == 0, (
        f"non-zero exit {r.returncode}; stderr={r.stderr!r}"
    )
    combined = (r.stdout + r.stderr).lower()
    assert "usage" in combined, f"no 'usage' in output: {combined[:300]!r}"
