#!/usr/bin/env python3
"""Tests for scripts/validate_fixer_summary.py — the post-flight validator that
mechanically proves a fixer summary file is well-formed without trusting the
agent that wrote it.

These exercise the REAL main() via monkeypatched sys.argv (the only IO boundary)
against real tmp_path files, covering the documented exit-code contract:
  0 valid · 2 missing · 3 missing `.fixer.` tag · 4 path-traversal · 5 missing
  header · 6 missing section markers · 7 empty file.

The module filename is a plain identifier but lives in scripts/ (not a package),
so it is loaded via importlib.util.spec_from_file_location rather than `import`.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VALIDATE_FIXER_SUMMARY_PY = PROJECT_ROOT / "scripts" / "validate_fixer_summary.py"

_VALID_BODY = "# Fixer Summary\n\n## Findings\n\n- nothing to fix\n\nTotal findings: 0\n"


def _load_module():
    """Load validate_fixer_summary.py as a module via importlib."""
    spec = importlib.util.spec_from_file_location("validate_fixer_summary", VALIDATE_FIXER_SUMMARY_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before exec so any decorator that resolves cls.__module__ via
    # sys.modules works for this dynamically-loaded module (defensive parity
    # with the dataclass-bearing sibling test).
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


validate_fixer_summary = _load_module()


def _run(monkeypatch, summary: Path, reports_dir: Path) -> int:
    """Invoke main() with monkeypatched argv; return its exit code."""
    monkeypatch.setattr(
        sys, "argv",
        ["validate_fixer_summary.py", "--summary", str(summary), "--reports-dir", str(reports_dir)],
    )
    return validate_fixer_summary.main()


def test_well_formed_summary_is_valid(tmp_path, monkeypatch, capsys):
    """A summary with the `.fixer.` tag, H1 header, and a section marker exits 0."""
    summary = tmp_path / "report.fixer.summary.md"
    summary.write_text(_VALID_BODY, encoding="utf-8")
    rc = _run(monkeypatch, summary, tmp_path)
    out = capsys.readouterr().out
    assert rc == 0
    assert out.startswith("OK ")
    assert str(summary.resolve()) in out


def test_missing_file_exits_2(tmp_path, monkeypatch):
    """A --summary path that does not exist exits 2 (file missing)."""
    rc = _run(monkeypatch, tmp_path / "does-not-exist.fixer.md", tmp_path)
    assert rc == 2


def test_empty_summary_exits_7(tmp_path, monkeypatch):
    """A 0-byte summary file is rejected with exit 7 (empty) before any parsing."""
    summary = tmp_path / "empty.fixer.md"
    summary.write_text("", encoding="utf-8")
    rc = _run(monkeypatch, summary, tmp_path)
    assert rc == 7


def test_missing_fixer_tag_in_filename_exits_3(tmp_path, monkeypatch):
    """A non-empty, well-bodied summary whose filename lacks `.fixer.` exits 3."""
    summary = tmp_path / "report.summary.md"  # no `.fixer.` join tag
    summary.write_text(_VALID_BODY, encoding="utf-8")
    rc = _run(monkeypatch, summary, tmp_path)
    assert rc == 3


def test_path_traversal_outside_reports_dir_exits_4(tmp_path, monkeypatch):
    """A summary that resolves outside --reports-dir is rejected with exit 4."""
    outside = tmp_path / "outside"
    reports_dir = tmp_path / "reports"
    outside.mkdir()
    reports_dir.mkdir()
    summary = outside / "report.fixer.md"
    summary.write_text(_VALID_BODY, encoding="utf-8")
    rc = _run(monkeypatch, summary, reports_dir)
    assert rc == 4


def test_missing_header_exits_5(tmp_path, monkeypatch):
    """A summary lacking the `# Fixer Summary` H1 header exits 5 (even with a section marker)."""
    summary = tmp_path / "noheader.fixer.md"
    summary.write_text("## Findings\n\nTotal findings: 1\n", encoding="utf-8")  # has marker, no H1 header
    rc = _run(monkeypatch, summary, tmp_path)
    assert rc == 5


def test_header_present_but_no_section_markers_exits_6(tmp_path, monkeypatch):
    """A summary with the H1 header but none of the required section markers exits 6."""
    summary = tmp_path / "nomarker.fixer.md"
    summary.write_text("# Fixer Summary\n\nSome prose with no recognised section.\n", encoding="utf-8")
    rc = _run(monkeypatch, summary, tmp_path)
    assert rc == 6
