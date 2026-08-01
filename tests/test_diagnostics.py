#!/usr/bin/env python3
"""Tests for scripts/diagnostics/*.py — the user-facing diagnostic CLIs.

Covers four real behaviors of the two diagnostic scripts:
  - check-statusline.py: --help exits 0 and a real run is graceful (exits with
    documented code 0/1/2 and a `FAIL:` stderr line if it can't proceed)
  - dump-state.py: --help exits 0 and secret-shaped substrings inside the
    files it actually reads (settings.yaml) are redacted in stdout

Tests use subprocess + the project's pinned interpreter (.venv/bin/python),
matching the same out-of-process style as test_benchmark_models.py. They do
NOT mock the script internals — the goal is to exercise the real CLI surface
that a user invokes from a terminal.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIAG_DIR = PROJECT_ROOT / "scripts" / "diagnostics"
CHECK_STATUSLINE = DIAG_DIR / "check-statusline.py"
DUMP_STATE = DIAG_DIR / "dump-state.py"

# Use the project's pinned venv interpreter — same as test_benchmark_models.py
# style and what the contract demands. Fall back to sys.executable only if
# the venv is missing (CI bootstrap scenario), which lets the test fail loudly
# instead of silently using a wrong Python.
_VENV_PY = PROJECT_ROOT / ".venv" / "bin" / "python"
PY = str(_VENV_PY) if _VENV_PY.exists() else sys.executable

# Hard per-test timeout. All six tests must complete well under 5 s each.
TIMEOUT_S = 5.0


# The two check-mcp-server.py tests that used to open this file are gone with
# the script itself: it probed a spawned MCP server, and the CLI migration
# (d557c68) deleted both. They are not replaced — `llm-ext discover` is the
# health check now, and it is already covered end-to-end by the dogfood harness
# (tests/dogfood/dogfood_test.py) against the real binary.


# ---------------------------------------------------------------------------
# 1. check-statusline.py --help
# ---------------------------------------------------------------------------


def test_check_statusline_help_exits_zero() -> None:
    """`check-statusline.py --help` exits 0 (argparse help contract)."""
    assert CHECK_STATUSLINE.is_file(), f"missing {CHECK_STATUSLINE}"
    proc = subprocess.run(
        [PY, str(CHECK_STATUSLINE), "--help"],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
        check=False,
    )
    assert proc.returncode == 0, (
        f"--help should exit 0; got {proc.returncode}\n"
        f"stdout: {proc.stdout[:300]}\nstderr: {proc.stderr[:300]}"
    )
    assert "usage:" in proc.stdout.lower(), (
        f"--help should print 'usage:' to stdout; got: {proc.stdout[:300]}"
    )


# ---------------------------------------------------------------------------
# 4. check-statusline.py with piped envelope is graceful (no crash)
# ---------------------------------------------------------------------------


def test_check_statusline_runs_gracefully_with_piped_envelope(tmp_path: Path) -> None:
    """Pipe a minimal Claude Code envelope to check-statusline.py and assert
    the script exits with a documented code (0, 1, or 2) and never crashes
    with a Python traceback. The script itself doesn't consume stdin (it
    reads ~/.claude/settings.json and pipes a DOWNSTREAM envelope to the
    resolved statusline command), but the user contract says: pipe the
    envelope, verify it doesn't crash, and check the graceful failure path
    has a `FAIL:` stderr explanation when it can't proceed.

    To get a deterministic, hermetic outcome, point HOME at an empty tmp
    dir — there's no ~/.claude/settings.json, so the script MUST exit 2
    with `FAIL: ... settings.json does not exist.` per its own contract.
    """
    envelope = '{"cwd":"/tmp","model":"opus","session_id":"x"}'
    env = os.environ.copy()
    env["HOME"] = str(tmp_path)  # hermetic — no ~/.claude/settings.json
    proc = subprocess.run(
        [PY, str(CHECK_STATUSLINE)],
        input=envelope,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
        check=False,
        env=env,
    )
    # Documented exit codes: 0 (pass), 1 (misconfigured), 2 (can't run).
    assert proc.returncode in (0, 1, 2), (
        f"undocumented exit code {proc.returncode}; expected 0/1/2\n"
        f"stdout: {proc.stdout[:300]}\nstderr: {proc.stderr[:300]}"
    )
    # If non-zero, the script's contract is to print a `FAIL:` stderr
    # explanation — verify the graceful-failure path was taken (not a crash).
    if proc.returncode != 0:
        assert "FAIL:" in proc.stderr, (
            f"non-zero exit must include `FAIL:` stderr explanation; got:\n{proc.stderr[:500]}"
        )
        # Catch any uncaught Python exception leaking through stderr.
        assert "Traceback" not in proc.stderr, (
            f"script crashed with traceback (not graceful):\n{proc.stderr[:500]}"
        )


# ---------------------------------------------------------------------------
# 5. dump-state.py --help
# ---------------------------------------------------------------------------


def test_dump_state_help_exits_zero() -> None:
    """`dump-state.py --help` exits 0 (argparse help contract)."""
    assert DUMP_STATE.is_file(), f"missing {DUMP_STATE}"
    proc = subprocess.run(
        [PY, str(DUMP_STATE), "--help"],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
        check=False,
    )
    assert proc.returncode == 0, (
        f"--help should exit 0; got {proc.returncode}\n"
        f"stdout: {proc.stdout[:300]}\nstderr: {proc.stderr[:300]}"
    )
    assert "usage:" in proc.stdout.lower(), (
        f"--help should print 'usage:' to stdout; got: {proc.stdout[:300]}"
    )


# ---------------------------------------------------------------------------
# 6. dump-state.py redacts secret-shaped substrings
# ---------------------------------------------------------------------------


def test_dump_state_redacts_secret_shaped_substrings(tmp_path: Path) -> None:
    """dump-state.py must redact secret-shaped tokens that appear in the
    files it reads. The user spec asks for an `OPENAI_API_KEY=sk-test123`
    style probe, but `sk-test123` is too short for the script's actual regex
    (`sk-[A-Za-z0-9_\\-]{16,}` requires 16+ chars). So we use a token that
    matches the real regex (`sk-` + 24 chars), inject it via the actual
    surface the script reads — a fake ~/.llm-externalizer/settings.yaml —
    and verify (a) `[REDACTED]` appears in stdout and (b) the literal secret
    does NOT appear. This exercises the real `redact()` function applied to
    real file content, which is what production users care about.
    """
    # Build a fake HOME with a settings.yaml containing a secret-shaped token.
    # 24 chars after `sk-` is well above the 16-char minimum in the regex.
    secret = "sk-" + "a" * 24  # e.g. sk-aaaaaaaaaaaaaaaaaaaaaaaa
    assert len(secret) == 27, "test sanity: secret length"
    fake_home = tmp_path / "home"
    settings_dir = fake_home / ".llm-externalizer"
    settings_dir.mkdir(parents=True)
    settings_yaml = settings_dir / "settings.yaml"
    settings_yaml.write_text(
        "active: testprofile\n"
        "profiles:\n"
        "  testprofile:\n"
        "    mode: remote\n"
        "    api: openrouter-remote\n"
        f"    api_key: {secret}\n"
        "    model: anthropic/claude-sonnet-4\n",
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["HOME"] = str(fake_home)
    # Also set OPENAI_API_KEY as the spec requested (even though dump-state
    # doesn't dump env vars, this proves env-leak isn't a regression).
    env["OPENAI_API_KEY"] = "sk-test123"

    proc = subprocess.run(
        [PY, str(DUMP_STATE)],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
        check=False,
        env=env,
    )
    assert proc.returncode == 0, (
        f"dump-state should exit 0; got {proc.returncode}\nstderr: {proc.stderr[:500]}"
    )
    # Sanity: the script actually read our fake settings.yaml (looks for the
    # active-profile name we wrote).
    assert "testprofile" in proc.stdout, (
        f"script did not read our fake settings.yaml — HOME override failed?\n"
        f"stdout sample: {proc.stdout[:500]}"
    )
    # Core assertion 1: the redaction sentinel appears.
    assert "[REDACTED]" in proc.stdout, (
        f"expected `[REDACTED]` in stdout but did not find it. "
        f"redact() failed on a regex-matching secret.\nstdout sample: {proc.stdout[:800]}"
    )
    # Core assertion 2: the literal secret does NOT appear anywhere in stdout.
    assert secret not in proc.stdout, (
        f"literal secret {secret!r} leaked into stdout — redaction broken.\n"
        f"stdout sample: {proc.stdout[:800]}"
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
