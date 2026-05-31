#!/usr/bin/env python3
"""Tests for scripts/fix_found_bugs_helper.py — the --skip-if-fixer-exists filter.

Regression coverage for the D5 bug (TRDD-6e859d3c): `_find_report_files`
hardcoded the `.fixer.` literal in its skip-filter while `_is_sidecar`
recognizes BOTH canonical fixer shapes (`.fixer.` and `-fixer-`) via the
shared `FIXER_MARKERS`/`SIDECAR_MARKERS` constants. A report whose fixer
sidecar used the hyphen shape (`-fixer-`) was therefore never skipped and
got re-aggregated. The fix routes the skip-filter through FIXER_MARKERS so
both separator shapes match — single source of truth.

The SUT helper `_find_report_files` is invoked directly against a tmp dir
populated with real on-disk filenames; no services are mocked. The module
name uses underscores so it is importable by name, but it is loaded via
importlib.util pointing at the exact script path so the test does not
depend on sys.path.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SUT_PATH = PROJECT_ROOT / "scripts" / "fix_found_bugs_helper.py"


def _load_sut():
    """Load fix_found_bugs_helper.py as a module via importlib (path-pinned)."""
    spec = importlib.util.spec_from_file_location("fix_found_bugs_helper", SUT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def sut():
    """Module-scoped SUT handle so the import cost is paid once."""
    return _load_sut()


def _write(path: Path, text: str = "# report\n") -> Path:
    """Create a file with minimal content and return its path."""
    path.write_text(text, encoding="utf-8")
    return path


def test_skips_report_with_canonical_hyphen_fixer_sidecar(sut, tmp_path):
    """A report with a canonical '-fixer-' sidecar is SKIPPED (the D5 regression)."""
    report = _write(tmp_path / "20260525.foo.md")
    # Canonical hyphen-separated fixer sidecar that _is_sidecar recognizes.
    _write(tmp_path / "20260525.foo-fixer-summary.md")
    result = sut._find_report_files(tmp_path, skip_if_fixer_exists=True)
    assert report not in result
    assert result == []


def test_includes_report_when_no_fixer_sidecar(sut, tmp_path):
    """Without any fixer sidecar, the report IS included in the result."""
    report = _write(tmp_path / "20260525.foo.md")
    result = sut._find_report_files(tmp_path, skip_if_fixer_exists=True)
    assert result == [report]


def test_skips_report_with_dot_fixer_sidecar(sut, tmp_path):
    """The old dot-separated '.fixer.' sidecar also skips its report (must not regress)."""
    report = _write(tmp_path / "20260525.foo.md")
    # Old dot-separated shape — was the ONLY shape the buggy filter handled.
    _write(tmp_path / "20260525.foo.fixer.summary.md")
    result = sut._find_report_files(tmp_path, skip_if_fixer_exists=True)
    assert report not in result
    assert result == []
