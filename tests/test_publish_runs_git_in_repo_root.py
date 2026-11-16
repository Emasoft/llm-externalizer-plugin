"""Regression tests for TRDD-IM2NBX1S: publish.py acts on repo_root, not the caller cwd.

publish.py used to leave cwd unset on its git calls, so a publish started from
another checkout ran git status/tag/add/commit/push there. These tests run the
REAL `_run_publish` (loaded via importlib, same pattern as
test_publish_failed_push.py) against two real temp git repos: the release repo
(repo_root) and an unrelated caller repo that is the process cwd.
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
TAG = f"v{VERSION}"


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def _init_repo(repo: Path) -> None:
    repo.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "tracked.txt").write_text("a\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-m", "feat: initial commit")


@pytest.fixture
def two_repos(tmp_path, monkeypatch):
    """Release repo with plugin.json plus an unrelated clean repo that is the cwd."""
    release = tmp_path / "release"
    caller = tmp_path / "caller"
    _init_repo(release)
    (release / ".claude-plugin").mkdir()
    (release / ".claude-plugin" / "plugin.json").write_text(
        '{"name": "test-plugin", "version": "0.0.0"}\n', encoding="utf-8"
    )
    _git(release, "add", ".claude-plugin/plugin.json")
    _git(release, "commit", "-m", "feat: add manifest")
    _init_repo(caller)
    monkeypatch.chdir(caller)
    monkeypatch.setattr(publish, "run_checks", lambda root: True)
    monkeypatch.setattr(publish, "run_cpv_validation", lambda root: True)
    return release, caller


def _dry_run(release: Path) -> None:
    args = argparse.Namespace(
        patch=False, minor=False, major=False, set=VERSION, dry_run=True, check_only=False
    )
    publish._run_publish(
        args, release, release / ".claude-plugin" / "plugin.json", release / "CHANGELOG.md"
    )


def test_run_forwards_explicit_cwd_to_git(two_repos):
    """run() with cwd=release reports the release repo toplevel, not the caller repo."""
    release, caller = two_repos
    result = publish.run(["git", "rev-parse", "--show-toplevel"], cwd=str(release))
    assert Path(result.stdout.strip()).resolve() == release.resolve()
    assert Path(result.stdout.strip()).resolve() != caller.resolve()


def test_preflight_checks_repo_root_not_caller(two_repos, capsys):
    """A dirty release tree aborts the preflight even though the caller cwd repo is clean."""
    release, caller = two_repos
    (release / "tracked.txt").write_text("dirty\n", encoding="utf-8")
    assert _git(caller, "status", "--porcelain").stdout == ""
    with pytest.raises(SystemExit) as excinfo:
        _dry_run(release)
    assert excinfo.value.code == 1
    err = capsys.readouterr().err
    assert "working tree has uncommitted changes" in err
    assert "tracked.txt" in err


def test_preflight_ignores_dirty_caller(two_repos, capsys):
    """A dirty caller cwd repo does not abort a clean release tree's dry run."""
    release, caller = two_repos
    (caller / "tracked.txt").write_text("dirty\n", encoding="utf-8")
    _dry_run(release)
    assert "[DRY RUN] All checks passed." in capsys.readouterr().out


def test_tag_check_uses_repo_root_not_caller(two_repos, capsys):
    """A release tag existing only in the release repo is found from an unrelated cwd."""
    release, caller = two_repos
    _git(release, "tag", TAG)
    assert _git(caller, "tag", "--list", TAG).stdout.strip() == ""
    with pytest.raises(SystemExit) as excinfo:
        _dry_run(release)
    assert excinfo.value.code == 1
    assert f"tag '{TAG}' already exists locally" in capsys.readouterr().err


def test_full_release_runs_every_git_call_in_repo_root(tmp_path, monkeypatch):
    """A full release started from an unrelated cwd runs git, git-cliff and gh only in repo_root."""
    import os

    release = tmp_path / "release"
    caller = tmp_path / "caller"
    remote = tmp_path / "remote.git"
    _init_repo(release)
    _init_repo(caller)
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    _git(release, "remote", "add", "origin", str(remote))
    _git(release, "config", "push.default", "current")
    hooks = tmp_path / "no-hooks"
    hooks.mkdir()
    _git(release, "config", "core.hooksPath", str(hooks))
    (release / ".claude-plugin").mkdir()
    (release / ".claude-plugin" / "plugin.json").write_text(
        '{"name": "test-plugin", "version": "0.0.0"}\n', encoding="utf-8"
    )
    cliff = Path(__file__).resolve().parent.parent / "cliff.toml"
    (release / "cliff.toml").write_text(cliff.read_text(encoding="utf-8"), encoding="utf-8")
    (release / "CHANGELOG.md").write_text(
        "# Changelog\n\nAll notable changes to this project will be documented in this file.\n",
        encoding="utf-8",
    )
    dist = release / "scripts" / "llm-ext" / "dist"
    dist.mkdir(parents=True)
    (dist / "llm-ext.js").write_text(f"// VERSION={VERSION}\n", encoding="utf-8")
    _git(release, "add", "-A")
    _git(release, "commit", "-m", "feat: add manifest")
    caller_head = _git(caller, "rev-parse", "HEAD").stdout.strip()

    stub_bin = tmp_path / "stub-bin"
    stub_bin.mkdir()
    (stub_bin / "gh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (stub_bin / "gh").chmod(0o755)
    monkeypatch.setenv("PATH", f"{stub_bin}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.chdir(caller)
    monkeypatch.setattr(publish, "run_checks", lambda root: True)
    monkeypatch.setattr(publish, "run_cpv_validation", lambda root: True)

    real_run = publish.run
    seen: list[tuple[list[str], str | None]] = []

    def recording_run(cmd, *, check=True, capture=True, cwd=None, env=None):
        if cmd[:3] == ["npm", "run", "build"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        seen.append((list(cmd), cwd))
        return real_run(cmd, check=check, capture=capture, cwd=cwd, env=env)

    monkeypatch.setattr(publish, "run", recording_run)
    args = argparse.Namespace(
        patch=False, minor=False, major=False, set=VERSION, dry_run=False, check_only=False
    )
    publish._run_publish(
        args, release, release / ".claude-plugin" / "plugin.json", release / "CHANGELOG.md"
    )

    repo_cmds = [(c, d) for c, d in seen if c[0] in ("git", "git-cliff", "gh")]
    verbs = {c[1] for c, _ in repo_cmds if c[0] == "git"}
    assert {"status", "tag", "add", "commit", "push"} <= verbs
    assert all(d == str(release) for _, d in repo_cmds), repo_cmds
    # The release landed in the release repo; the unrelated caller repo is untouched.
    assert _git(release, "log", "-1", "--format=%s").stdout.strip() == f"chore(release): {TAG}"
    assert _git(caller, "rev-parse", "HEAD").stdout.strip() == caller_head
    assert _git(caller, "tag", "--list").stdout.strip() == ""



def test_every_repo_command_call_passes_cwd():
    """Every literal git, git-cliff or gh run() call in publish.py passes an explicit cwd."""
    import ast

    tree = ast.parse(_PUBLISH_PATH.read_text(encoding="utf-8"))
    missing = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "run"):
            continue
        if not node.args:
            continue
        first = node.args[0]
        head = None
        if isinstance(first, ast.List) and first.elts and isinstance(first.elts[0], ast.Constant):
            head = first.elts[0].value
        elif isinstance(first, ast.BinOp) and isinstance(first.left, ast.List) and first.left.elts:
            head = getattr(first.left.elts[0], "value", None)
        if head in ("git", "git-cliff", "gh") and not any(k.arg == "cwd" for k in node.keywords):
            missing.append(node.lineno)
    assert missing == [], f"run() calls without cwd at publish.py lines {missing}"
