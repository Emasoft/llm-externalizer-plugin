"""Regression tests for publish.py's failed-push recovery (non-destructive).

Guards the v13.6.1 fix: on a failed release push (`git push --follow-tags` at the time), the publisher
used to run `git reset --hard HEAD~1` and delete BOTH tags. That destroyed
the release commit and the exact refs needed to diagnose the failure — a
transient push failure (network blip, rate limit, branch protection) became
permanent lost work, and the operator was invited to blind-rerun while the
remote may hold PARTIALLY updated refs.

The fix: on push failure the publisher prints the original stderr, states
that the commit and both tags are preserved locally, warns that remote refs
may be partially updated and must be inspected before any retry, and exits
nonzero BEFORE the GitHub-release step (step 11 is unreachable).

These tests exercise the REAL publisher (`_run_publish` loaded via
importlib, same pattern as test_publish_resolver_tag.py) against a real
temporary git repository whose remote is a bare repo with a pre-receive
hook that exits 1. No external service is contacted: `gh` is stubbed on
PATH with a logging script, and the test asserts it is never invoked.
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
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=check, capture_output=True, text=True
    )


@pytest.fixture
def publish_repo(tmp_path, monkeypatch):
    """A real temp git repo wired to a rejecting bare remote, cwd = repo."""
    repo = tmp_path / "repo"
    remote = tmp_path / "remote.git"
    repo.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    # publish.py pushes to the branch's configured upstream (TRDD-Z20KCBZY)
    # and refuses to run without one, so the fixture configures it.
    _git(repo, "config", "branch.main.remote", "origin")
    _git(repo, "config", "branch.main.merge", "refs/heads/main")

    # Remote: bare repo whose pre-receive hook rejects EVERY push.
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    hook = remote / "hooks" / "pre-receive"
    hook.write_text('#!/bin/sh\necho "REJECTED-BY-TEST-HOOK" >&2\nexit 1\n', encoding="utf-8")
    hook.chmod(0o755)
    # WHY: a machine-level core.hooksPath (e.g. ~/.config/git/hooks with its
    # own pre-push) OVERRIDES the bare repo's built-in hooks dir, so this
    # pre-receive would never run and the push would succeed. Point the
    # remote's own config back at its hooks dir to make rejection reliable.
    subprocess.run(
        ["git", "config", "--local", "core.hooksPath", str(remote / "hooks")],
        check=True,
        capture_output=True,
        env={**os.environ, "GIT_DIR": str(remote)},
    )
    _git(repo, "remote", "add", "origin", str(remote))

    # Minimal publish inputs. Only files with unconditional gates need to
    # exist: plugin.json (step 3), CHANGELOG.md + cliff.toml (step 4
    # git-cliff) and dist/llm-ext.js (step 6's shipped-artifact check).
    # The other version-sync targets sit behind exists() guards and are
    # deliberately absent, so the pyproject/uv-lock/npm paths are not walked.
    (repo / ".claude-plugin").mkdir()
    (repo / ".claude-plugin" / "plugin.json").write_text(
        '{"name": "test-plugin", "version": "0.0.0"}\n', encoding="utf-8"
    )
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

    # Stub gh on PATH: logs its argv, exits 0. The test asserts the log file
    # never appears — the publisher must exit before step 11.
    stub_bin = tmp_path / "stub-bin"
    stub_bin.mkdir()
    gh_log = tmp_path / "gh-calls.log"
    (stub_bin / "gh").write_text(
        '#!/bin/sh\necho "$@" >> "$GH_CALL_LOG"\nexit 0\n', encoding="utf-8"
    )
    (stub_bin / "gh").chmod(0o755)
    monkeypatch.setenv("GH_CALL_LOG", str(gh_log))
    monkeypatch.setenv("PATH", f"{stub_bin}{os.pathsep}{os.environ['PATH']}")

    return repo, remote, gh_log


def test_failed_push_is_non_destructive(publish_repo, monkeypatch, capsys):
    """Push rejected by the remote: publisher exits 1 with local work intact.

    Snapshot of the working repo state before the push is taken at the
    moment the publisher creates the release tags (the commit the push
    carries); after the failure the test compares against it.
    """
    repo, remote, gh_log = publish_repo
    base_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()

    # Patch the two heavy gates (full check suite / CPV) — they are not the
    # code under test. Everything else (git, git-cliff, the push itself) is
    # REAL, executed by the actual publisher code.
    monkeypatch.setattr(publish, "run_checks", lambda root: True)
    monkeypatch.setattr(publish, "run_cpv_validation", lambda root: True)

    real_run = publish.run
    captured: dict = {}

    def instrumented_run(cmd, *, check=True, capture=True, cwd=None, env=None):
        if cmd[:3] == ["npm", "run", "build"]:
            # Step 6 dist rebuild is a real npm invocation against a repo
            # with no package.json — out of scope; dist/llm-ext.js is
            # pre-seeded with the version string.
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        if cmd[:3] == ["git", "tag", "-a"]:
            # Pre-push snapshot: HEAD at the moment the release tags are
            # created — the release commit the push will carry.
            captured["pre_push_head"] = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(repo),
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        return real_run(cmd, check=check, capture=capture, cwd=cwd, env=env)

    monkeypatch.setattr(publish, "run", instrumented_run)

    args = argparse.Namespace(
        patch=False,
        minor=False,
        major=False,
        set=RELEASE_VERSION,
        dry_run=False,
        check_only=False,
    )
    with pytest.raises(SystemExit) as excinfo:
        publish._run_publish(
            args,
            repo,
            repo / ".claude-plugin" / "plugin.json",
            repo / "CHANGELOG.md",
        )
    assert excinfo.value.code == 1

    err = capsys.readouterr().err
    assert "Release commit and both tags are preserved locally" in err
    assert "Remote refs may be partially updated" in err
    assert "REJECTED-BY-TEST-HOOK" in err  # original push stderr surfaced
    assert "Rolling back" not in err

    release_sha = captured["pre_push_head"]
    # HEAD unchanged from the pre-push release commit; its parent is the
    # pre-publish base and the message is the release commit's.
    head = _git(repo, "rev-parse", "HEAD").stdout.strip()
    assert head == release_sha
    assert _git(repo, "rev-parse", "HEAD~1").stdout.strip() == base_sha
    assert _git(repo, "log", "-1", "--format=%s").stdout.strip() == f"chore(release): {TAG}"

    # Both tags survive, annotated, and point at the release commit.
    for t in (TAG, RESOLVER_TAG):
        assert _git(repo, "rev-parse", "--verify", t, check=False).returncode == 0
        assert _git(repo, "cat-file", "-t", t).stdout.strip() == "tag"  # annotated
        assert _git(repo, "rev-parse", f"{t}^{{commit}}").stdout.strip() == release_sha

    # No reset in HEAD's reflog — nothing was undone.
    reflog = _git(repo, "reflog", "HEAD").stdout
    assert "reset" not in reflog

    # The GitHub-release step (11) is unreachable on push failure: the gh
    # stub never logged a single invocation.
    assert not gh_log.exists()
