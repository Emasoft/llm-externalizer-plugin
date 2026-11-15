"""Regression test for TRDD-CV2OAB7D: the shellcheck gate lints only git-tracked .sh files.

Real git repo in a temp dir, real shellcheck: a failing gitignored script must not
reach the gate, a failing tracked one must.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

_PUBLISH_PATH = Path(__file__).resolve().parent.parent / "scripts" / "publish.py"
_spec = importlib.util.spec_from_file_location("publish", _PUBLISH_PATH)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

BAD_SH = "#!/bin/sh\nrm -rf $UNQUOTED\n"  # SC2086: shellcheck fails on this


def _git(repo: Path, *args: str) -> None:
    # timeout=60: a hang must raise TimeoutExpired here, not stall pytest or the gate.
    subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        timeout=60,
    )


def _repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    (tmp_path / ".gitignore").write_text("/reports/\n", encoding="utf-8")
    (tmp_path / "reports").mkdir()
    (tmp_path / "reports" / "probe.sh").write_text(BAD_SH, encoding="utf-8")
    return tmp_path


def test_ignored_sh_file_is_not_selected(tmp_path: Path) -> None:
    """A gitignored scratch script never reaches the shellcheck list."""
    repo = _repo(tmp_path)
    assert publish.tracked_shell_files(repo) == []


def test_tracked_sh_file_is_selected_and_still_fails_shellcheck(tmp_path: Path) -> None:
    """A tracked failing script is selected and shellcheck still rejects it."""
    if shutil.which("shellcheck") is None:
        pytest.fail("shellcheck is required for this test (publish.py requires it too)")
    repo = _repo(tmp_path)
    (repo / "bad.sh").write_text(BAD_SH, encoding="utf-8")
    _git(repo, "add", "bad.sh")
    files = publish.tracked_shell_files(repo)
    assert files == [repo / "bad.sh"]
    # timeout=60: a hang must raise TimeoutExpired here, not stall pytest or the gate.
    rc = subprocess.run(
        ["shellcheck", *map(str, files)],
        capture_output=True,
        timeout=60,
    ).returncode
    assert rc != 0


def test_tracked_file_deleted_in_worktree_is_skipped(tmp_path: Path) -> None:
    """A tracked script removed from disk is not handed to shellcheck."""
    repo = _repo(tmp_path)
    (repo / "gone.sh").write_text("#!/bin/sh\ntrue\n", encoding="utf-8")
    _git(repo, "add", "gone.sh")
    (repo / "gone.sh").unlink()
    assert publish.tracked_shell_files(repo) == []
