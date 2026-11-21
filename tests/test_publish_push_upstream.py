"""Tests for publish.py's push destination (TRDD-Z20KCBZY).

The 14.6.2 publish failed because `git push --follow-tags` obeys
push.default=simple, which refuses a branch whose name differs from its
upstream (dev/after-14.3.0 tracking origin/main). The publisher now pushes
to the branch's configured upstream explicitly, the two release tags by explicit
refspec (not --follow-tags), and fails fast without one.

Real git, a real local bare remote, the real `_run_publish` (loaded via
importlib like test_publish_failed_push.py); only the two heavy gates, the
npm build and `gh` are stubbed, none of which is the code under test.
"""

from __future__ import annotations

import importlib.util
import json
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


def test_push_goes_to_main_when_branch_name_differs(publish_repo, monkeypatch, tmp_path):
    """Promotion sends the exact candidate to main and does not follow unrelated tags."""
    repo, remote = publish_repo
    manifest = repo / ".claude-plugin" / "plugin.json"
    manifest.write_text(json.dumps({"name": "test-plugin", "version": RELEASE_VERSION}), encoding="utf-8")
    _git(repo, "add", ".claude-plugin/plugin.json")
    _git(repo, "commit", "-m", f"chore(release): {TAG}")
    head = _git(repo, "rev-parse", "HEAD").stdout.strip()
    ref = publish.candidate_ref(head)
    _git(remote, "fetch", str(repo), f"{head}:{ref}")
    _git(repo, "config", "push.followTags", "true")
    _git(repo, "tag", "-a", "stale", "-m", "Unrelated", "HEAD")
    # Exercise the real local Git transaction, not GitHub or the full suite.
    unintended = tmp_path / "unintended.git"
    subprocess.run(["git", "init", "--bare", str(unintended)], check=True, capture_output=True)
    monkeypatch.setattr(publish, "require_release_target", lambda root: str(remote))
    monkeypatch.setattr(publish, "verify_windows_run", lambda *args: None)
    def validate(root, *, candidate):
        assert root == repo and candidate == head
        _git(repo, "remote", "set-url", "--push", "origin", str(unintended))
        _git(repo, "config", f"url.{unintended}.insteadOf", str(remote))
        _git(repo, "config", f"url.{unintended}.pushInsteadOf", "release-pin-")
        return True

    monkeypatch.setattr(publish, "run_checks", validate)

    publish.promote_candidate(repo, manifest, repo / "CHANGELOG.md", head, 1)

    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == head
    assert _git(remote, "rev-parse", "refs/heads/main").stdout.strip() == head
    assert _git(remote, "rev-parse", ref).stdout.strip() == head
    for name in (TAG, RESOLVER_TAG):
        assert _git(remote, "rev-parse", f"refs/tags/{name}^{{commit}}").stdout.strip() == head
    assert _git(remote, "tag", "--list", "stale").stdout == ""
    assert _git(unintended, "for-each-ref").stdout == ""


def test_no_upstream_fails_fast_and_pushes_nothing(publish_repo):
    """A canonical origin without an upstream is rejected before any network operation."""
    repo, remote = publish_repo
    _git(repo, "remote", "set-url", "origin", f"https://github.com/{publish.RELEASE_REPO}.git")
    with pytest.raises(SystemExit, match="must track origin/main"):
        publish.require_release_target(repo)
    assert _git(remote, "for-each-ref").stdout == ""
