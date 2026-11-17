"""Tests for publish.py's push destination (TRDD-Z20KCBZY).

The 14.6.2 publish failed because `git push --follow-tags` obeys
push.default=simple, which refuses a branch whose name differs from its
upstream (dev/after-14.3.0 tracking origin/main). The publisher now pushes
to the branch's configured upstream explicitly, and fails fast without one.

Real git, a real local bare remote, the real `_run_publish` (loaded via
importlib like test_publish_failed_push.py); only the two heavy gates, the
npm build and `gh` are stubbed, none of which is the code under test.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

_PUBLISH_PATH = Path(__file__).resolve().parent.parent / "scripts" / "publish.py"
_spec = importlib.util.spec_from_file_location("publish", _PUBLISH_PATH)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

RELEASE_VERSION = "0.1.0"
TAG = f"v{RELEASE_VERSION}"
RESOLVER_TAG = "test-plugin--v0.1.0"


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True)


@pytest.fixture
def publish_repo(tmp_path, monkeypatch):
    """A temp git repo on branch dev/x wired to an accepting bare remote, cwd = repo."""
    repo = tmp_path / "repo"
    remote = tmp_path / "remote.git"
    repo.mkdir()
    subprocess.run(["git", "init", "-b", "dev/x", str(repo)], check=True, capture_output=True)
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    # push.default=simple is git's default; pinned so the test proves the
    # explicit destination, not a lenient local setting.
    _git(repo, "config", "push.default", "simple")
    # A machine-level core.hooksPath would run its pre-push hook here; point
    # the repo at an empty hooks dir so only the publisher's push is tested.
    empty_hooks = tmp_path / "no-hooks"
    empty_hooks.mkdir()
    _git(repo, "config", "core.hooksPath", str(empty_hooks))

    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "--local", "core.hooksPath", str(empty_hooks)],
        check=True,
        capture_output=True,
        env={**os.environ, "GIT_DIR": str(remote)},
    )
    _git(repo, "remote", "add", "origin", str(remote))

    (repo / ".claude-plugin").mkdir()
    (repo / ".claude-plugin" / "plugin.json").write_text('{"name": "test-plugin", "version": "0.0.0"}\n', encoding="utf-8")
    cliff_toml = Path(__file__).resolve().parent.parent / "cliff.toml"
    (repo / "cliff.toml").write_text(cliff_toml.read_text(encoding="utf-8"), encoding="utf-8")
    (repo / "CHANGELOG.md").write_text(
        "# Changelog\n\nAll notable changes to this project will be documented in this file.\n",
        encoding="utf-8",
    )
    dist = repo / "scripts" / "llm-ext" / "dist"
    dist.mkdir(parents=True)
    (dist / "llm-ext.js").write_text(f"// VERSION={RELEASE_VERSION}\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: initial commit")

    monkeypatch.chdir(repo)

    stub_bin = tmp_path / "stub-bin"
    stub_bin.mkdir()
    (stub_bin / "gh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (stub_bin / "gh").chmod(0o755)
    monkeypatch.setenv("PATH", f"{stub_bin}{os.pathsep}{os.environ['PATH']}")

    monkeypatch.setattr(publish, "run_checks", lambda root: True)
    monkeypatch.setattr(publish, "run_cpv_validation", lambda root: True)
    real_run = publish.run

    def instrumented_run(cmd, *, check=True, capture=True, cwd=None, env=None):
        if cmd[:3] == ["npm", "run", "build"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return real_run(cmd, check=check, capture=capture, cwd=cwd, env=env)

    monkeypatch.setattr(publish, "run", instrumented_run)
    return repo, remote


def _publish(repo: Path) -> None:
    args = argparse.Namespace(
        patch=False,
        minor=False,
        major=False,
        set=RELEASE_VERSION,
        dry_run=False,
        check_only=False,
    )
    publish._run_publish(args, repo, repo / ".claude-plugin" / "plugin.json", repo / "CHANGELOG.md")


def test_push_goes_to_upstream_when_branch_name_differs(publish_repo):
    """Branch dev/x tracking origin/main: remote main equals local HEAD and both tags arrive."""
    repo, remote = publish_repo
    _git(repo, "config", "branch.dev/x.remote", "origin")
    _git(repo, "config", "branch.dev/x.merge", "refs/heads/main")

    _publish(repo)

    head = _git(repo, "rev-parse", "HEAD").stdout.strip()
    assert _git(remote, "rev-parse", "refs/heads/main").stdout.strip() == head
    for t in (TAG, RESOLVER_TAG):
        assert _git(remote, "rev-parse", f"refs/tags/{t}^{{commit}}").stdout.strip() == head


def test_no_upstream_fails_fast_and_pushes_nothing(publish_repo, capsys):
    """Branch with no upstream: exit 1, 'has no upstream' on stderr, remote left empty."""
    repo, remote = publish_repo

    with pytest.raises(SystemExit) as excinfo:
        _publish(repo)

    assert excinfo.value.code == 1
    assert "has no upstream" in capsys.readouterr().err
    assert _git(remote, "for-each-ref").stdout.strip() == ""
