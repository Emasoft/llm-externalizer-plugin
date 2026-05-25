#!/usr/bin/env python3
"""Tests for scripts/setup/build-snippet.py (TRDD-6e859d3c item D1).

Covers the four contract/validation fixes:
  (a) `_yaml_dquote` REJECTS control chars incl. `\\n`/`\\r` (the docstring no
      longer claims they are escaped); tab is still escaped as `\\t`.
  (b) safety-guard violations exit with code 2 (not the bare-SystemExit 1).
  (c) `_validate_profile_name` rejects YAML-reserved tokens (null/true/false/
      yes/no/on/off, case-insensitive) which the regex alone would accept.
  (d) `_build_snippet` happy path emits well-formed unindented YAML lines.

These are whitebox tests — they import the dashed-name script via importlib
and call the helpers directly. They also exercise the real CLI for exit-code
assertions (argparse + the script's own guards).
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SNIPPET_PATH = PROJECT_ROOT / "scripts" / "setup" / "build-snippet.py"


def _load_snippet_module():
    """Import the dashed-name build-snippet.py as a module for whitebox tests."""
    spec = importlib.util.spec_from_file_location("build_snippet", SNIPPET_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# (a) control-char rejection — newline/carriage-return are NOT escaped
# ---------------------------------------------------------------------------


def test_yaml_dquote_rejects_newline() -> None:
    """`_yaml_dquote` with an embedded newline must raise SystemExit (not escape it)."""
    mod = _load_snippet_module()
    with pytest.raises(SystemExit):
        mod._yaml_dquote("a\nb")


def test_yaml_dquote_rejects_carriage_return() -> None:
    """`_yaml_dquote` with an embedded carriage return must raise SystemExit."""
    mod = _load_snippet_module()
    with pytest.raises(SystemExit):
        mod._yaml_dquote("a\rb")


def test_yaml_dquote_docstring_does_not_claim_newline_escaping() -> None:
    """The `_yaml_dquote` docstring must describe rejection, not escaping, of newlines."""
    mod = _load_snippet_module()
    doc = mod._yaml_dquote.__doc__ or ""
    assert "REJECTED" in doc
    # The old false claim "Newlines are escaped as `\n`" must be gone.
    assert "escaped as" not in doc.replace("escaped as `\\t`", "")


def test_yaml_dquote_no_dead_newline_replace() -> None:
    """The dead `.replace(\"\\n\", ...)` / `.replace(\"\\r\", ...)` lines must be gone."""
    src = SNIPPET_PATH.read_text(encoding="utf-8")
    assert '.replace("\\n"' not in src
    assert '.replace("\\r"' not in src


# ---------------------------------------------------------------------------
# (a) tab is allowed past the guard and still escaped
# ---------------------------------------------------------------------------


def test_yaml_dquote_escapes_tab() -> None:
    """`_yaml_dquote(\"a\\tb\")` returns the tab escaped and wrapped in quotes."""
    mod = _load_snippet_module()
    assert mod._yaml_dquote("a\tb") == '"a\\tb"'


def test_yaml_dquote_escapes_backslash_and_quote() -> None:
    """`_yaml_dquote` escapes backslash first, then double-quote (order matters)."""
    mod = _load_snippet_module()
    assert mod._yaml_dquote('a\\"b') == '"a\\\\\\"b"'


def test_yaml_dquote_preserves_colon() -> None:
    """A model id with a colon round-trips quoted, e.g. `qwen2.5-coder:7b`."""
    mod = _load_snippet_module()
    assert mod._yaml_dquote("qwen2.5-coder:7b") == '"qwen2.5-coder:7b"'


# ---------------------------------------------------------------------------
# (c) YAML-reserved profile names are rejected
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["null", "true", "false", "yes", "no", "on", "off"])
def test_validate_profile_name_rejects_reserved_lowercase(name: str) -> None:
    """`_validate_profile_name` rejects YAML-reserved tokens (lowercase)."""
    mod = _load_snippet_module()
    with pytest.raises(SystemExit):
        mod._validate_profile_name(name)


@pytest.mark.parametrize("name", ["Null", "TRUE", "Yes", "OFF", "No"])
def test_validate_profile_name_rejects_reserved_caseinsensitive(name: str) -> None:
    """`_validate_profile_name` rejects YAML-reserved tokens case-insensitively."""
    mod = _load_snippet_module()
    with pytest.raises(SystemExit):
        mod._validate_profile_name(name)


def test_validate_profile_name_accepts_normal_name() -> None:
    """A normal name like `ollama-qwen2.5-coder-7b` passes validation unchanged."""
    mod = _load_snippet_module()
    assert mod._validate_profile_name("ollama-qwen2.5-coder-7b") == "ollama-qwen2.5-coder-7b"


def test_validate_profile_name_rejects_bad_chars() -> None:
    """A name failing the regex (leading dot) still raises SystemExit."""
    mod = _load_snippet_module()
    with pytest.raises(SystemExit):
        mod._validate_profile_name(".bad")


# ---------------------------------------------------------------------------
# (d) happy-path snippet build
# ---------------------------------------------------------------------------


def test_build_snippet_happy_path() -> None:
    """`_build_snippet` emits well-formed unindented YAML for a valid request."""
    mod = _load_snippet_module()
    out = mod._build_snippet(
        profile_name="ollama-qwen2.5-coder-7b",
        runner="ollama",
        model="qwen2.5-coder:7b",
        url=None,
        context_window=32768,
        mode="local",
    )
    lines = out.splitlines()
    assert lines[0] == "ollama-qwen2.5-coder-7b:"
    assert "  mode: local" in lines
    assert "  api: ollama-local" in lines
    assert '  model: "qwen2.5-coder:7b"' in lines
    assert '  url: "http://localhost:11434/v1"' in lines
    assert "  context_window: 32768" in lines
    assert out.endswith("\n")


def test_build_snippet_uses_explicit_url() -> None:
    """An explicit --url overrides the runner's default endpoint (quoted)."""
    mod = _load_snippet_module()
    out = mod._build_snippet(
        profile_name="lmstudio-local",  # note: not a reserved token
        runner="lmstudio",
        model="some-model",
        url="http://127.0.0.1:9999/v1",
        context_window=8192,
        mode="local",
    )
    assert '  url: "http://127.0.0.1:9999/v1"' in out.splitlines()


# ---------------------------------------------------------------------------
# (b) exit codes — safety guards exit 2, in-function arg guards exit 1
# ---------------------------------------------------------------------------


def _run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SNIPPET_PATH), *args],
        capture_output=True, text=True, timeout=10,
    )


def test_cli_reserved_profile_name_exits_2() -> None:
    """A reserved profile name (--profile-name null) exits 2 (safety guard)."""
    r = _run_cli("--profile-name", "null", "--runner", "ollama", "--model", "m")
    assert r.returncode == 2, f"stderr={r.stderr}"


def test_cli_bad_profile_name_exits_2() -> None:
    """A regex-failing profile name (leading dot) exits 2 (safety guard)."""
    r = _run_cli("--profile-name", ".bad", "--runner", "ollama", "--model", "m")
    assert r.returncode == 2, f"stderr={r.stderr}"


def test_cli_low_context_window_exits_1() -> None:
    """A too-low --context-window is an in-function arg guard → exit 1."""
    r = _run_cli(
        "--profile-name", "ok-name", "--runner", "ollama",
        "--model", "m", "--context-window", "100",
    )
    assert r.returncode == 1, f"stderr={r.stderr}"


def test_cli_unknown_runner_choice_exits_2() -> None:
    """An out-of-`choices` --runner is an argparse usage error → exit 2."""
    r = _run_cli("--profile-name", "ok-name", "--runner", "bogus", "--model", "m")
    assert r.returncode == 2, f"stderr={r.stderr}"


def test_cli_happy_path_exits_0() -> None:
    """A valid invocation exits 0 and prints the profile key on stdout."""
    r = _run_cli(
        "--profile-name", "ollama-qwen2.5-coder-7b", "--runner", "ollama",
        "--model", "qwen2.5-coder:7b",
    )
    assert r.returncode == 0, f"stderr={r.stderr}"
    assert r.stdout.startswith("ollama-qwen2.5-coder-7b:")
