#!/usr/bin/env python3
"""Tests for scripts/validate_report.py — the pre-flight validator that
mechanically checks a scan report's source-file + line-range references
before a fixer agent is dispatched.

Covers the pure helpers (_extract_source, _extract_line_ranges) and the
real main() exit-code contract (valid → 0, missing report → 2, no
parseable source → 3, source missing → 4, path-traversal → 5,
out-of-bounds line range → 6) using real tmp_path report + source files.

The module filename is a plain identifier but lives in scripts/ (not a
package), so it is loaded via importlib.util.spec_from_file_location and
registered in sys.modules before exec_module (mirroring the project's
other script tests).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VALIDATE_REPORT_PY = PROJECT_ROOT / "scripts" / "validate_report.py"


def _load_module():
    """Load scripts/validate_report.py as a module via importlib."""
    spec = importlib.util.spec_from_file_location("validate_report", VALIDATE_REPORT_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


validate_report = _load_module()


# ── pure helper: _extract_source ───────────────────────────────────────────────


def test_extract_source_canonical_input_file_bullet(tmp_path):
    """The canonical `- **Input file**: \\`<abs>\\`` line yields that absolute path."""
    abs_src = tmp_path / "pkg" / "mod.py"
    text = f"# Report\n\n- **Input file**: `{abs_src}`\n\nSome findings.\n"
    result = validate_report._extract_source(text, tmp_path)
    assert result == abs_src


def test_extract_source_relative_path_resolves_against_project_dir(tmp_path):
    """A relative `Source:` path is resolved against --project-dir into an absolute path."""
    (tmp_path / "src").mkdir()
    target = tmp_path / "src" / "a.py"
    target.write_text("x = 1\n", encoding="utf-8")
    text = "Source: src/a.py\n"
    result = validate_report._extract_source(text, tmp_path)
    assert result is not None and result.is_absolute()
    assert result == target.resolve()


def test_extract_source_returns_none_when_no_reference(tmp_path):
    """A report with no File:/Source: line yields None (drives exit code 3)."""
    text = "# Report\n\nThis report mentions no source file at all.\nlines 1-3 maybe.\n"
    assert validate_report._extract_source(text, tmp_path) is None


# ── pure helper: _extract_line_ranges ──────────────────────────────────────────


def test_extract_line_ranges_parses_multiple_shapes():
    """`lines 12-40`, `L5-L9`, and `:3-7` are all parsed as (start, end) tuples."""
    text = "See lines 12-40, also L5-L9 and the colon form path.py:3-7 here."
    ranges = validate_report._extract_line_ranges(text)
    assert (12, 40) in ranges
    assert (5, 9) in ranges
    assert (3, 7) in ranges


def test_extract_line_ranges_single_number_and_reversed_normalized():
    """A bare `line 8` becomes (8, 8); a reversed `lines 40-12` normalizes to (12, 40)."""
    assert validate_report._extract_line_ranges("at line 8 only") == [(8, 8)]
    assert validate_report._extract_line_ranges("lines 40-12 backwards") == [(12, 40)]


# ── main(): the real exit-code contract ────────────────────────────────────────


def _run_main(monkeypatch, report: Path, project_dir: Path) -> int:
    """Invoke main() with a real argv (main() parses sys.argv, takes no params)."""
    monkeypatch.setattr(sys, "argv", ["validate_report.py", "--report", str(report), "--project-dir", str(project_dir)])
    return validate_report.main()


def test_main_valid_report_prints_resolved_source_and_returns_0(tmp_path, capsys, monkeypatch):
    """A well-formed report with an in-bounds line range exits 0 and prints the resolved source."""
    source = tmp_path / "mod.py"
    source.write_text("line1\nline2\nline3\nline4\nline5\n", encoding="utf-8")  # 5 lines
    report = tmp_path / "report.md"
    report.write_text(f"- **Input file**: `{source}`\n\nIssue at lines 2-4.\n", encoding="utf-8")

    rc = _run_main(monkeypatch, report, tmp_path)
    out = capsys.readouterr().out
    assert rc == 0
    assert out.strip() == str(source.resolve())


def test_main_missing_report_returns_2(tmp_path, capsys, monkeypatch):
    """A report path that does not exist on disk exits 2 with an ERROR on stderr."""
    missing = tmp_path / "nope.md"
    rc = _run_main(monkeypatch, missing, tmp_path)
    err = capsys.readouterr().err
    assert rc == 2
    assert "ERROR: report not found" in err


def test_main_no_source_reference_returns_3(tmp_path, capsys, monkeypatch):
    """A report with no parseable File:/Source: line exits 3."""
    report = tmp_path / "r.md"
    report.write_text("# Findings\n\nNothing references a concrete source file here.\n", encoding="utf-8")
    rc = _run_main(monkeypatch, report, tmp_path)
    err = capsys.readouterr().err
    assert rc == 3
    assert "no parseable File: reference" in err


def test_main_out_of_bounds_line_range_returns_6(tmp_path, capsys, monkeypatch):
    """A line range past the source's real line count exits 6 (the bounds guard)."""
    source = tmp_path / "small.py"
    source.write_text("only\ntwo\n", encoding="utf-8")  # 2 lines
    report = tmp_path / "report.md"
    report.write_text(f"- **Input file**: `{source}`\n\nBug at lines 1-99.\n", encoding="utf-8")
    rc = _run_main(monkeypatch, report, tmp_path)
    err = capsys.readouterr().err
    assert rc == 6
    assert "out of bounds" in err
