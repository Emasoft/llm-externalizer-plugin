"""Regression tests for TRDD-EWU9OAYI: publish.py names the tracked files the checks changed.

run_checks runs `npm run build`, which rewrites tracked scripts/llm-ext/dist files.
publish.py used to print "Working tree is unchanged" after a failed validate even
then. These tests run the REAL report_working_tree and the REAL `_run_publish`
(loaded via importlib, same pattern as test_publish_runs_git_in_repo_root.py)
against a real temp git repo. run_checks is replaced by a function that rewrites
a tracked file, standing in for the build; a real `npm run build` against a stale
dist is not run here (it needs the full node toolchain and the full check suite).
"""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
from pathlib import Path

import pytest

_PUBLISH_PATH = Path(__file__).resolve().parent.parent / "scripts" / "publish.py"
_spec = importlib.util.spec_from_file_location("publish", _PUBLISH_PATH)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

VERSION = "0.1.0"
DIST_FILE = "scripts/llm-ext/dist/llm-ext.js"


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    # timeout: a hung git would stall the publish gate (ubs py.security.subprocess-timeout).
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, timeout=120)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """Clean release repo with a committed dist file; cwd is an unrelated directory."""
    repo = tmp_path / "release"
    repo.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True, timeout=120)
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / ".claude-plugin").mkdir()
    (repo / ".claude-plugin" / "plugin.json").write_text(
        '{"name": "test-plugin", "version": "0.0.0"}\n', encoding="utf-8"
    )
    dist = repo / DIST_FILE
    dist.parent.mkdir(parents=True)
    dist.write_text("// stale\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: initial commit")
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.chdir(other)
    monkeypatch.setattr(publish, "run_cpv_validation", lambda root: True)
    return repo


def _rebuild_dist(root: Path) -> None:
    (root / DIST_FILE).write_text("// rebuilt\n", encoding="utf-8")


def _dry_run(repo: Path) -> None:
    args = argparse.Namespace(patch=False, minor=False, major=False, set=VERSION, dry_run=True, check_only=False)
    publish._run_publish(args, repo, repo / ".claude-plugin" / "plugin.json", repo / "CHANGELOG.md")


def test_clean_tree_reports_unchanged(repo, capsys):
    """A clean repo prints the unchanged line and no file list."""
    publish.report_working_tree(repo)
    err = capsys.readouterr().err
    assert "Working tree is unchanged." in err
    assert "tracked file" not in err


def test_modified_tracked_file_is_named(repo, capsys):
    """A modified tracked file is named with a restore hint, never reported as unchanged."""
    _rebuild_dist(repo)
    publish.report_working_tree(repo)
    err = capsys.readouterr().err
    assert DIST_FILE in err
    assert f"git restore {DIST_FILE}" in err
    assert "Working tree is unchanged" not in err


def test_failed_validate_names_files_the_checks_changed(repo, monkeypatch, capsys):
    """run_checks fails after rewriting dist: the abort message names it, not "unchanged"."""

    def failing_checks(root: Path) -> bool:
        _rebuild_dist(root)
        return False

    monkeypatch.setattr(publish, "run_checks", failing_checks)
    with pytest.raises(SystemExit) as excinfo:
        _dry_run(repo)
    assert excinfo.value.code == 1
    err = capsys.readouterr().err
    assert "validation failed" in err
    assert DIST_FILE in err
    assert "Working tree is unchanged" not in err


def test_passing_dry_run_names_files_the_checks_changed(repo, monkeypatch, capsys):
    """A passing dry run that left a rebuilt dist behind names that file."""

    def passing_checks(root: Path) -> bool:
        _rebuild_dist(root)
        return True

    monkeypatch.setattr(publish, "run_checks", passing_checks)
    _dry_run(repo)
    captured = capsys.readouterr()
    assert "[DRY RUN] All checks passed." in captured.out
    assert DIST_FILE in captured.err
    assert "Working tree is unchanged" not in captured.err


def test_path_with_space_and_rename_come_out_exact(repo, capsys):
    """A tracked path with a space and a renamed file are named exactly, restore command quoted."""
    spaced = repo / "dir with space" / "my file.js"
    spaced.parent.mkdir()
    spaced.write_text("a\n", encoding="utf-8")
    old = repo / "old.js"
    old.write_text("b\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: add files")
    spaced.write_text("changed\n", encoding="utf-8")
    _git(repo, "mv", "old.js", "new.js")
    # a rename is reported as its new path only
    assert sorted(publish.changed_tracked_files(repo)) == ["dir with space/my file.js", "new.js"]
    publish.report_working_tree(repo)
    err = capsys.readouterr().err
    assert "dir with space/my file.js" in err
    assert "'dir with space/my file.js'" in err
