#!/usr/bin/env python3
"""Tests for scripts/join_fixer_reports.py — the `.fixer.`-tagged report joiner.

Covers the real aggregation/joining logic with real tmp_path report files:
  - candidate discovery recognizes the `.fixer.` substring, recurses, and sorts
  - non-`.fixer.` reports are NOT picked up (naming-recognition rule)
  - validation rejects empty / header-less / marker-less reports
  - a valid+invalid mix joins only the valid bodies and records rejections
  - the joined body concatenates in deterministic name order with separators
  - main() exits 3 when no `.fixer.` reports exist
  - main() exits 5 when every `.fixer.` report fails validation

REAL tests only: every input is an actual file written under tmp_path; nothing
in the unit under test is mocked. main() reads sys.argv via argparse, so it is
driven by monkeypatching sys.argv (the only external boundary touched).

The module filename is a plain identifier but lives under scripts/ (not on the
import path), so it is loaded via importlib.util.spec_from_file_location rather
than `import`. It has no @dataclass, so no sys.modules pre-registration is
needed (cf. test_detect_runners.py).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
JOIN_FIXER_PY = PROJECT_ROOT / "scripts" / "join_fixer_reports.py"

_VALID_BODY = "# Fixer Summary\n\n## Findings\n\nTotal findings: 0\n"


def _load_module():
    """Load the scripts/join_fixer_reports.py file as a module via importlib."""
    spec = importlib.util.spec_from_file_location("join_fixer_reports", JOIN_FIXER_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


join_fixer = _load_module()


def _write(path: Path, text: str) -> Path:
    """Write text to path (creating parents) and return the path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_find_candidates_recognizes_fixer_tag_recursively_sorted(tmp_path):
    """_find_candidates collects `.fixer.` .md files recursively, sorted by name."""
    _write(tmp_path / "b.fixer.md", _VALID_BODY)
    _write(tmp_path / "a.fixer.md", _VALID_BODY)
    _write(tmp_path / "sub" / "c.fixer.md", _VALID_BODY)  # nested → rglob must find it
    found = join_fixer._find_candidates(tmp_path)
    names = [p.name for p in found]
    # sorted by full path string: <root>/a < <root>/b < <root>/sub/c
    assert names == ["a.fixer.md", "b.fixer.md", "c.fixer.md"]


def test_find_candidates_ignores_untagged_and_non_md(tmp_path):
    """Files without the `.fixer.` substring (or not .md) are not candidates."""
    _write(tmp_path / "report.md", _VALID_BODY)  # .md but no `.fixer.` tag
    _write(tmp_path / "notes.fixer.txt", _VALID_BODY)  # has tag but not .md
    _write(tmp_path / "real.fixer.md", _VALID_BODY)  # the only true candidate
    found = join_fixer._find_candidates(tmp_path)
    assert [p.name for p in found] == ["real.fixer.md"]


def test_validate_rejects_empty_and_headerless_and_markerless(tmp_path):
    """_validate flags empty files, missing header, and missing section markers."""
    reports_dir = tmp_path.resolve()
    empty = _write(tmp_path / "empty.fixer.md", "")
    headerless = _write(tmp_path / "noheader.fixer.md", "## Findings\nTotal findings: 1\n")
    markerless = _write(tmp_path / "nomarker.fixer.md", "# Fixer Summary\n\njust prose, no markers\n")
    good = _write(tmp_path / "good.fixer.md", _VALID_BODY)

    assert join_fixer._validate(empty, reports_dir) == (False, "empty file (0 bytes)")
    ok_h, reason_h = join_fixer._validate(headerless, reports_dir)
    assert ok_h is False and "header" in reason_h
    ok_m, reason_m = join_fixer._validate(markerless, reports_dir)
    assert ok_m is False and "section markers" in reason_m
    assert join_fixer._validate(good, reports_dir) == (True, "")


def test_write_joined_includes_only_valid_bodies_and_lists_rejected(tmp_path):
    """_write_joined writes valid report bodies and records rejected names in the header."""
    valid = _write(tmp_path / "alpha.fixer.md", "# Fixer Summary\n\n## Findings\n\nUNIQUE_ALPHA_MARKER\nTotal findings: 0\n")
    rejected = _write(tmp_path / "broken.fixer.md", "")
    output = tmp_path / "final.md"  # _write_joined assumes its parent exists (main() mkdirs it)

    join_fixer._write_joined([valid], [(rejected, "empty file (0 bytes)")], output, tmp_path.resolve())

    text = output.read_text(encoding="utf-8")
    assert "- Valid summaries joined: 1" in text
    assert "- Rejected (validation failed): 1" in text
    assert "## Rejected summaries" in text
    assert "`broken.fixer.md` — empty file (0 bytes)" in text
    assert "UNIQUE_ALPHA_MARKER" in text  # the real body content was concatenated
    assert "## [1/1] alpha.fixer.md" in text  # per-file header present


def test_write_joined_concatenates_in_order_with_separators(tmp_path):
    """_write_joined emits each valid body in list order with horizontal-rule separators."""
    first = _write(tmp_path / "one.fixer.md", "# Fixer Summary\n## Findings\nBODY_ONE\nTotal findings: 0\n")
    second = _write(tmp_path / "two.fixer.md", "# Fixer Summary\n## Findings\nBODY_TWO\nTotal findings: 0\n")
    output = tmp_path / "joined.md"

    join_fixer._write_joined([first, second], [], output, tmp_path.resolve())

    text = output.read_text(encoding="utf-8")
    assert "## [1/2] one.fixer.md" in text and "## [2/2] two.fixer.md" in text
    assert text.index("BODY_ONE") < text.index("BODY_TWO")  # preserved order
    assert text.count("\n---\n") >= 3  # header rule + one per joined body


def test_main_no_fixer_reports_returns_3(tmp_path, monkeypatch, capsys):
    """main() exits 3 when the input dir holds no `.fixer.`-tagged reports."""
    _write(tmp_path / "unrelated.md", _VALID_BODY)  # .md but untagged
    output = tmp_path / "out" / "final.md"
    monkeypatch.setattr(join_fixer.sys, "argv", ["join_fixer_reports.py", "--input-dir", str(tmp_path), "--output", str(output)])

    rc = join_fixer.main()
    assert rc == 3
    assert not output.exists()  # nothing written on the no-candidates path
    assert "no .fixer." in capsys.readouterr().err


def test_main_all_invalid_returns_5(tmp_path, monkeypatch, capsys):
    """main() exits 5 when every `.fixer.` report fails validation (nothing to join)."""
    _write(tmp_path / "bad1.fixer.md", "")  # empty
    _write(tmp_path / "bad2.fixer.md", "no header, no markers\n")  # invalid
    output = tmp_path / "out" / "final.md"
    monkeypatch.setattr(join_fixer.sys, "argv", ["join_fixer_reports.py", "--input-dir", str(tmp_path), "--output", str(output)])

    rc = join_fixer.main()
    assert rc == 5
    assert not output.exists()
    assert "failed validation" in capsys.readouterr().err
