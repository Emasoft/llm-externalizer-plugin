"""TRDD-EWU9OAYI box 2: the REAL build against a stale dist, then the REAL report_working_tree.

A temp git repo holds a copy of scripts/llm-ext whose committed dist/llm-ext.js differs from
what the source builds to. publish.run_build_check (the exact function run_checks calls) runs the
real `npm run build` (real tsc + esbuild) there, and report_working_tree must then name the
rewritten dist file instead of claiming the tree is unchanged. Real git and real npm, no mocks.
Limits: the source is the committed HEAD (git archive), so uncommitted source or package.json edits are NOT covered;
node_modules is the live tree one (symlinked, never installed by the test: no network), and must exist.
"""

from __future__ import annotations

import importlib.util
import io
import re
import shutil
import subprocess
import tarfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_PUBLISH_PATH = _ROOT / "scripts" / "publish.py"
_spec = importlib.util.spec_from_file_location("publish", _PUBLISH_PATH)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

_REAL_MCP_DIR = _ROOT / "scripts" / "llm-ext"
DIST_FILE = "scripts/llm-ext/dist/llm-ext.js"


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    # timeout: a hung git would stall the publish gate (ubs py.security.subprocess-timeout).
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, timeout=120)


# WHY unmarked (no slow/integration marker): the publish gate, ci.yml and release.yml all run
# `pytest -m "not integration and not slow"`; a marker would drop this test from every one of them.
def test_real_build_of_stale_dist_is_named_not_reported_unchanged(tmp_path, capsys):
    """A real `npm run build` over a stale committed dist makes report_working_tree name the dist file."""
    assert shutil.which("npm") is not None, (
        "npm is not on PATH: this test runs the real build and cannot run without it"
    )

    repo = tmp_path / "release"
    mcp_dir = repo / "scripts" / "llm-ext"
    # Build from COMMITTED content (git archive HEAD), not the live working tree: other edits in progress
    # (half-written files, untracked sources) must not decide whether this test passes.
    repo.mkdir()
    archive = subprocess.run(
        ["git", "-C", str(_ROOT), "archive", "--format=tar", "HEAD", "scripts/llm-ext"],
        check=True,
        capture_output=True,
        timeout=120,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(repo, filter="data")
    # WHY no install here: a test must not reach the network. The dependencies are the live tree node_modules
    # (installed by ci.yml, release.yml and publish.py before pytest), linked in; a missing directory fails at once.
    real_modules = _REAL_MCP_DIR / "node_modules"
    assert real_modules.is_dir(), f"{real_modules} is missing: run `npm ci` in {_REAL_MCP_DIR} first"
    # Symlink, not a copy (184 MB). The .gitignore pattern below has no trailing slash: "node_modules/" does not match a symlink.
    (mcp_dir / "node_modules").symlink_to(real_modules, target_is_directory=True)
    (repo / ".gitignore").write_text("node_modules\nreports_dev\n", encoding="utf-8")
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True, timeout=120)
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: initial commit")

    # Stale dist: commit a dist that the real build cannot reproduce (the 14.7.6 incident: dist older than source).
    dist = repo / DIST_FILE
    with dist.open("a", encoding="utf-8") as handle:
        handle.write("\n// stale: not produced by the current source\n")
    _git(repo, "commit", "-am", "chore: stale dist")

    # Control: before the build the tree is clean, so a later file list is caused by the build alone.
    publish.report_working_tree(repo)
    assert "Working tree is unchanged." in capsys.readouterr().err

    assert publish.run_build_check(repo) is True, (
        f"the real build failed in {mcp_dir}, see {repo / 'reports_dev' / 'publish' / 'build.log'}"
    )
    capsys.readouterr()  # drop the build step output

    publish.report_working_tree(repo)
    err = capsys.readouterr().err
    assert DIST_FILE in err
    assert "Working tree is unchanged" not in err
    assert DIST_FILE in publish.changed_tracked_files(repo)
    assert "stale: not produced" not in dist.read_text(encoding="utf-8")


def test_real_build_without_node_modules_fails_and_writes_the_log(tmp_path, capsys):
    """run_build_check over a tree with no node_modules returns False and build.log names the missing dependency."""
    assert shutil.which("npm") is not None, (
        "npm is not on PATH: this test runs the real build and cannot run without it"
    )
    repo = tmp_path / "release"
    repo.mkdir()
    archive = subprocess.run(
        ["git", "-C", str(_ROOT), "archive", "--format=tar", "HEAD", "scripts/llm-ext"],
        check=True,
        capture_output=True,
        timeout=120,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(repo, filter="data")
    # WHY no node_modules: git archive carries none (it is gitignored), so this is the real
    # "dependencies not installed" tree. run_build_check has no branch for it (TRDD-VQKH92OI premise was wrong);
    # this covers only the generic _run_check failure path, so the log must name the missing dependency,
    # otherwise any unrelated build failure would pass: TS2688 when a global tsc is on PATH (tsc cannot find
    # @types/node), "tsc ... not found" when it is not.
    assert not (repo / "scripts" / "llm-ext" / "node_modules").exists()

    assert publish.run_build_check(repo) is False
    assert "build failed" in capsys.readouterr().err
    log = (repo / "reports_dev" / "publish" / "build.log").read_text(encoding="utf-8")
    # WHY: a bare "not found" matches unrelated failures. The shell's missing-command wording is "sh: tsc: command not found" (bash/zsh sh) or "sh: 1: tsc: not found" (dash); the pattern "tsc: (command )?not found" matches both and not a tsc message about a missing file. Only the missing @types/node (TS2688) or a missing tsc names the missing dependency.
    assert re.search(r"TS2688.*'node'", log) or re.search(r"\btsc: (?:command )?not found", log), log
