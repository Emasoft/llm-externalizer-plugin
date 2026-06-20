#!/usr/bin/env python3
"""Tests for scripts/check_references.py — the broken-internal-reference validator.

Exercises the PURE, deterministic helpers (dynamic-marker classification, URL
fragment stripping, reference extraction, and the inside-root existence guard)
plus the real end-to-end main() verdict against REAL temporary plugin trees
containing both valid and broken references. Only the filesystem is real (via
pytest tmp_path) — nothing the unit under test does is mocked.

The module filename is not a hyphenated identifier, but scripts/ is not an
importable package, so it is loaded via importlib.util.spec_from_file_location
(same pattern as tests/test_detect_runners.py and tests/test_vllm_cuda_autoconfig.py).
The module is registered in sys.modules BEFORE exec_module to match the safe
dynamic-load pattern.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CHECK_REFERENCES_PY = PROJECT_ROOT / "scripts" / "check_references.py"


def _load_module():
    """Load the script scripts/check_references.py as a module via importlib."""
    spec = importlib.util.spec_from_file_location("check_references", CHECK_REFERENCES_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


check_references = _load_module()


# ── pure helpers ────────────────────────────────────────────────────────────


def test_is_dynamic_flags_template_and_env_markers():
    """A path with $, %, {{ or }} is dynamic; a plain relative path is not."""
    assert check_references._is_dynamic("$SUBDIR/x.py") is True
    assert check_references._is_dynamic("scripts/{{ inputs.path }}") is True
    assert check_references._is_dynamic("%VAR%/foo") is True
    assert check_references._is_dynamic("scripts/check_references.py") is False


def test_strip_url_fragment_removes_anchor_and_query():
    """#anchor and ?query suffixes are stripped, leaving the bare path."""
    assert check_references._strip_url_fragment("scripts/foo.py#section") == "scripts/foo.py"
    assert check_references._strip_url_fragment("docs/bar.md?v=2") == "docs/bar.md"
    assert check_references._strip_url_fragment("scripts/foo.py") == "scripts/foo.py"


def test_strip_trailing_punct_removes_sentence_marks():
    """Trailing sentence punctuation is stripped without touching interior dots."""
    assert check_references._strip_trailing_punct("scripts/foo.py.") == "scripts/foo.py"
    assert check_references._strip_trailing_punct("a/b.md!?;") == "a/b.md"
    assert check_references._strip_trailing_punct("scripts/foo.py") == "scripts/foo.py"


def test_extract_references_known_dir_and_plugin_root(tmp_path):
    """A known-dir path and a ${CLAUDE_PLUGIN_ROOT}/ path are both extracted with correct resolution roots."""
    src = tmp_path / "agents" / "doc.md"
    src.parent.mkdir(parents=True)
    text = "see scripts/check_references.py and ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"
    refs = check_references._extract_references(text, src, tmp_path)
    by_raw = {raw: (target_rel, rel_file, rel_root) for raw, target_rel, rel_file, rel_root in refs}

    # known-dir ref resolves under BOTH the source dir and the plugin root
    assert "scripts/check_references.py" in by_raw
    target_rel, rel_file, rel_root = by_raw["scripts/check_references.py"]
    assert target_rel == "scripts/check_references.py"
    assert rel_file == src.parent / "scripts/check_references.py"
    assert rel_root == tmp_path / "scripts/check_references.py"

    # plugin-root ref resolves under root only (rel_file is None), target stripped of prefix
    assert "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" in by_raw
    target_rel, rel_file, rel_root = by_raw["${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"]
    assert target_rel == "hooks/run.sh"
    assert rel_file is None
    assert rel_root == tmp_path / "hooks/run.sh"


def test_extract_references_markdown_link_relative_to_file(tmp_path):
    """A markdown link with a known suffix is extracted and resolved relative to the source file dir; http links are ignored."""
    src = tmp_path / "skills" / "a" / "SKILL.md"
    src.parent.mkdir(parents=True)
    text = "[sibling](./other.md) and [web](https://example.com/x.md) and [up](../b/ref.py)"
    refs = check_references._extract_references(text, src, tmp_path)
    raws = {raw for raw, *_ in refs}

    # relative md link captured (with the ./ preserved as the raw target)
    assert "./other.md" in raws
    # the .py relative link captured too
    assert "../b/ref.py" in raws
    # the http link is NOT captured
    assert not any("example.com" in r for r in raws)

    # the ./other.md link resolves relative to the file's parent dir
    by_raw = {raw: rel_file for raw, _t, rel_file, _r in refs}
    assert by_raw["./other.md"] == src.parent / "./other.md"


def test_exists_within_rejects_traversal_outside_root(tmp_path):
    """A real file inside root returns True; a ../ traversal to a real file outside root returns False."""
    root = tmp_path / "plugin"
    (root / "scripts").mkdir(parents=True)
    inside = root / "scripts" / "real.py"
    inside.write_text("x", encoding="utf-8")
    # a real file OUTSIDE the plugin root
    outside = tmp_path / "secret.txt"
    outside.write_text("y", encoding="utf-8")

    assert check_references._exists_within(inside, root) is True
    # path that exists but resolves outside root must be rejected
    traversal = root / "scripts" / ".." / ".." / "secret.txt"
    assert traversal.exists() is True
    assert check_references._exists_within(traversal, root) is False
    # a non-existent path is False
    assert check_references._exists_within(root / "scripts" / "nope.py", root) is False


# ── end-to-end main() against real temp plugin trees ────────────────────────


def _write(path: Path, content: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _run_main(monkeypatch, argv: list[str]) -> int:
    """Invoke main() with a synthetic argv (main() parses sys.argv via argparse)."""
    monkeypatch.setattr(sys, "argv", ["check_references.py", *argv])
    return check_references.main()


def test_main_all_valid_references_exit_zero(tmp_path, capsys, monkeypatch):
    """A tree whose every reference resolves to a real on-disk target exits 0."""
    root = tmp_path
    _write(root / "scripts" / "check_references.py", "print('hi')")
    _write(root / "skills" / "a" / "ref.md", "content")
    # doc references both a known-dir path and a relative md link, both real
    _write(
        root / "skills" / "a" / "SKILL.md",
        "uses scripts/check_references.py and [sib](./ref.md)\n",
    )
    rc = _run_main(monkeypatch, ["--root", str(root)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "0 broken" in out


def test_main_broken_reference_exit_one(tmp_path, capsys, monkeypatch):
    """A reference to a non-existent known-dir path is reported BROKEN and exits 1."""
    root = tmp_path
    _write(root / "agents" / "doc.md", "points at scripts/does_not_exist.py\n")
    rc = _run_main(monkeypatch, ["--root", str(root)])
    out = capsys.readouterr().out
    assert rc == 1
    assert "BROKEN" in out
    assert "scripts/does_not_exist.py" in out


def test_main_no_references_exit_zero(tmp_path, capsys, monkeypatch):
    """A scannable file containing zero path-like references exits 0 with 0 references."""
    root = tmp_path
    _write(root / "docs" / "plain.md", "Just prose. No paths, no links here.\n")
    rc = _run_main(monkeypatch, ["--root", str(root)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "0 references" in out
    assert "0 broken" in out


def test_main_dynamic_reference_warns_but_strict_fails(tmp_path, capsys, monkeypatch):
    """A dynamic (${VAR}) reference is a warning-only exit 0 by default, but --strict makes it exit 1."""
    root = tmp_path
    # ${CLAUDE_PLUGIN_ROOT}/$SUBDIR/x.py — after the canonical prefix is stripped,
    # the remaining "$SUBDIR/x.py" still contains '$', so it is classified DYNAMIC.
    _write(root / "commands" / "cmd.md", "run ${CLAUDE_PLUGIN_ROOT}/$SUBDIR/x.py here\n")

    rc_default = _run_main(monkeypatch, ["--root", str(root)])
    out_default = capsys.readouterr().out
    assert rc_default == 0
    assert "1 dynamic" in out_default

    rc_strict = _run_main(monkeypatch, ["--root", str(root), "--strict"])
    assert rc_strict == 1
