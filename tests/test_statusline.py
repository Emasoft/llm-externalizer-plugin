#!/usr/bin/env python3
"""Tests for scripts/statusline/statusline.py.

Covers v9.10.0 / v9.9.0 audit fixes:
  - _format_12h_ampm midnight/noon/PM edge cases (T2.25)
  - _format_12h_ampm locale-independence (de_DE.UTF-8 regression — T2.25)
  - _log_exception OSError dedup-via-errno (T2.21)
  - End-to-end CLI smoke through main() reading stdin

Helper signatures (verified by reading the source — DO NOT change without
re-reading statusline.py):

  _format_12h_ampm(local_dt: datetime) -> str
      Takes a datetime, NOT an int hour. Returns "{hour12}:{MM}{am|pm}",
      always lowercase suffix, locale-independent.

  _log_exception(label: str, exc: BaseException) -> None
      Two args, NOT three. Dedup is by errno of OSError raised during log
      write (uses module-level _LOG_EXCEPTION_WARN_SEEN set keyed by errno).
      Two failing OSError calls with the SAME errno emit one stderr line;
      two with DIFFERENT errnos emit two.
"""

from __future__ import annotations

import importlib.util
import json
import locale
import subprocess
import sys
import urllib.error
from datetime import datetime
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATUSLINE_PATH = PROJECT_ROOT / "scripts" / "statusline" / "statusline.py"


def _load_statusline_module():
    """Import statusline.py for whitebox testing of internal helpers.

    conftest.py prepends scripts/statusline/ to sys.path so plain
    `import statusline` works; we use importlib for symmetry with
    test_benchmark_models.py and to avoid module-state bleed across tests.
    """
    spec = importlib.util.spec_from_file_location("statusline", STATUSLINE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# _format_12h_ampm — edge cases (T2.25)
# ---------------------------------------------------------------------------


def test_format_12h_ampm_midnight_returns_12_00_am() -> None:
    """Midnight (hour=0) must render as '12:00am' — the 12h-clock edge case
    that returns 12 (not 0) for the hour-12 fold of hour-24."""
    mod = _load_statusline_module()
    dt = datetime(2026, 1, 1, 0, 0)
    assert mod._format_12h_ampm(dt) == "12:00am"


def test_format_12h_ampm_noon_returns_12_00_pm() -> None:
    """Noon (hour=12) must render as '12:00pm' — the OTHER 12h-clock edge:
    hour12 = 12 % 12 = 0 → folded back to 12, suffix flips to pm."""
    mod = _load_statusline_module()
    dt = datetime(2026, 1, 1, 12, 0)
    assert mod._format_12h_ampm(dt) == "12:00pm"


def test_format_12h_ampm_13_returns_1_pm() -> None:
    """13:00 must render as '1:00pm' — normal PM conversion (no zero pad)."""
    mod = _load_statusline_module()
    dt = datetime(2026, 1, 1, 13, 0)
    assert mod._format_12h_ampm(dt) == "1:00pm"


def test_format_12h_ampm_is_locale_independent_under_de_DE() -> None:
    """Under German locale (de_DE.UTF-8) the C library's %p emits the empty
    string, which broke the v9.8.x bar (produced 'Resets at 3:00' with no
    suffix). T2.25 fixed this by stringifying am/pm ourselves. Test asserts
    the suffix is still lowercase 'am'/'pm' under that locale.
    """
    mod = _load_statusline_module()
    original = locale.setlocale(locale.LC_TIME)
    try:
        try:
            locale.setlocale(locale.LC_TIME, "de_DE.UTF-8")
        except locale.Error:
            pytest.skip("de_DE.UTF-8 locale not installed on this system")
        # Pick a non-edge hour so the suffix is unambiguously 'pm'
        result = mod._format_12h_ampm(datetime(2026, 1, 1, 15, 30))
        # Must end with lowercase 'am' or 'pm' — the regression was an empty
        # suffix, which we explicitly reject here.
        assert result.endswith(("am", "pm")), (
            f"locale-dependent suffix leaked: got {result!r}"
        )
        assert result == "3:30pm"
    finally:
        # Restore so other tests in the same process see the original locale.
        locale.setlocale(locale.LC_TIME, original)


# ---------------------------------------------------------------------------
# _log_exception — dedup-by-errno breadcrumb (T2.21)
# ---------------------------------------------------------------------------


def test_log_exception_same_errno_emits_one_stderr_breadcrumb(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When _log_exception cannot write the log (OSError on file open), it
    emits ONE stderr breadcrumb per unique errno. Calling it twice with the
    same triggering errno must NOT spam stderr — T2.21 dedup contract.

    We force the OSError by monkey-patching pathlib.Path.open inside the
    statusline module so any attempt to open the log file raises OSError
    with errno=28 (ENOSPC = disk full). The dedup set is keyed by errno,
    so two calls produce exactly one breadcrumb.
    """
    mod = _load_statusline_module()
    # Reset module-level dedup set so prior tests don't poison this one.
    mod._LOG_EXCEPTION_WARN_SEEN.clear()

    # Patch Path.open at the module's bound symbol so the with-statement in
    # _log_exception sees our error. We target the module's `Path` import.
    real_open = mod.Path.open

    def boom(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        # Only blow up the statusline log path so we don't poison the
        # mkdir/parents check earlier in the function. mkdir succeeds
        # (Path.mkdir is unaffected), then Path.open raises ENOSPC.
        if "statusline-error.log" in str(self):
            err = OSError(28, "No space left on device")
            raise err
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(mod.Path, "open", boom)

    # Capture baseline (nothing yet)
    capsys.readouterr()

    primary = RuntimeError("simulated primary failure in 'effort' section")
    mod._log_exception("effort", primary)
    mod._log_exception("effort", primary)  # same key, same errno → must dedup

    err = capsys.readouterr().err
    # Count breadcrumb occurrences — the breadcrumb line contains the fixed
    # prefix '[llm-externalizer statusline] cannot write error log'.
    crumbs = err.count("[llm-externalizer statusline] cannot write error log")
    assert crumbs == 1, f"expected 1 dedup'd breadcrumb, got {crumbs}; stderr={err!r}"
    # And confirm the breadcrumb mentioned both the errno AND the original
    # label, so the user has enough to triage.
    assert "errno 28" in err
    assert "[effort]" in err


# ---------------------------------------------------------------------------
# End-to-end CLI smoke
# ---------------------------------------------------------------------------


def test_statusline_cli_smoke_minimal_envelope_exits_0(tmp_path: Path) -> None:
    """Pipe a minimal Claude Code stdin envelope through statusline.py and
    assert it exits 0 with non-empty stdout. This is the contract Claude
    Code itself depends on: any non-zero exit from the statusline hook
    blanks the bar.

    HOME is redirected to tmp_path so ensure_cache_dir doesn't poison the
    real ~/.claude cache during CI runs, and so the test stays hermetic.
    """
    envelope = {
        "cwd": "/tmp",
        "model": {"display_name": "opus"},
        "session_id": "x",
    }
    payload = json.dumps(envelope).encode("utf-8")

    # Resolve venv python the same way the spec asks (absolute path).
    venv_python = PROJECT_ROOT / ".venv" / "bin" / "python"
    python_bin = str(venv_python) if venv_python.exists() else sys.executable

    env = {
        # Keep PATH so subprocess can still find `git`, `claude`, etc. —
        # the helpers tolerate missing-binary FileNotFoundError gracefully.
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "LANG": "C.UTF-8",
        # The statusline calls `claude --version` with a 5s timeout; without
        # a real binary it fails to FileNotFoundError, which the code
        # swallows. No further env coaxing needed.
    }
    r = subprocess.run(
        [python_bin, str(STATUSLINE_PATH)],
        input=payload,
        capture_output=True,
        env=env,
        timeout=20,
    )
    assert r.returncode == 0, (
        f"non-zero exit: {r.returncode}\nstderr={r.stderr.decode(errors='replace')!r}"
    )
    # stdout is the rendered bar — must contain SOMETHING (model name
    # falls through to "opus" from our envelope).
    assert r.stdout, f"empty stdout; stderr={r.stderr.decode(errors='replace')!r}"


# ---------------------------------------------------------------------------
# D6 — fetchers LOG the cause instead of silently swallowing (TRDD-6e859d3c)
#
# Before D6 both fetchers used a bare `except Exception: ...` that dropped the
# error with no diagnostic. These tests fail on that old code (no _log_exception
# call) and pass after the fix, while confirming the happy path still parses.
# ---------------------------------------------------------------------------


def _fake_urlopen_returning(body: dict):
    """Build a urlopen replacement that yields `body` as a JSON HTTP response.

    The real urllib.request.urlopen returns a context manager whose .read()
    gives raw bytes; we mimic exactly that minimal surface the fetchers use.
    """
    payload = json.dumps(body).encode("utf-8")

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return payload

    def _urlopen(req, timeout=None):  # noqa: ARG001 — signature match only
        return _Resp()

    return _urlopen


def _fake_urlopen_raising(exc: BaseException):
    """Build a urlopen replacement that always raises `exc` (network failure)."""

    def _urlopen(req, timeout=None):  # noqa: ARG001 — signature match only
        raise exc

    return _urlopen


def test_fetch_usage_logs_on_network_error_and_returns_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the usage fetch's urlopen raises URLError, fetch_usage_from_api
    returns the fail-soft fallback (None, no cache) AND logs the cause."""
    mod = _load_statusline_module()
    monkeypatch.setattr(mod, "get_oauth_token", lambda: "tok")  # force a fetch
    monkeypatch.setattr(
        mod.urllib.request,
        "urlopen",
        _fake_urlopen_raising(urllib.error.URLError("boom")),
    )
    logged: list[str] = []
    monkeypatch.setattr(mod, "_log_exception", lambda label, exc: logged.append(label))

    result = mod.fetch_usage_from_api(tmp_path, "1.2.3")

    assert result is None  # fail-soft: no stale cache → None
    assert logged, "network error was swallowed without logging (D6 regression)"


def test_fetch_usage_happy_path_returns_parsed_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful usage fetch returns the parsed JSON dict (no regression)."""
    mod = _load_statusline_module()
    monkeypatch.setattr(mod, "get_oauth_token", lambda: "tok")
    monkeypatch.setattr(
        mod.urllib.request,
        "urlopen",
        _fake_urlopen_returning({"rate_limits": {"five_hour": {}}}),
    )

    result = mod.fetch_usage_from_api(tmp_path, "1.2.3")

    assert result == {"rate_limits": {"five_hour": {}}}


def test_fetch_openrouter_logs_on_network_error_and_returns_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the OpenRouter fetch's urlopen raises URLError, the function logs
    the cause and returns the fail-soft fallback (None, no stale cache)."""
    mod = _load_statusline_module()
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    monkeypatch.setattr(
        mod.urllib.request,
        "urlopen",
        _fake_urlopen_raising(urllib.error.URLError("boom")),
    )
    logged: list[str] = []
    monkeypatch.setattr(mod, "_log_exception", lambda label, exc: logged.append(label))

    result = mod.fetch_openrouter_budget(tmp_path)

    assert result is None  # fail-soft: no stale cache → drop the 🏦 segment
    assert logged, "network error was swallowed without logging (D6 regression)"


def test_fetch_openrouter_happy_path_returns_remaining_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful OpenRouter fetch returns total_credits - total_usage."""
    mod = _load_statusline_module()
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    monkeypatch.setattr(
        mod.urllib.request,
        "urlopen",
        _fake_urlopen_returning({"data": {"total_credits": 70.0, "total_usage": 5.5}}),
    )

    result = mod.fetch_openrouter_budget(tmp_path)

    assert result == pytest.approx(64.5)
