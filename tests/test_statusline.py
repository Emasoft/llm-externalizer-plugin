#!/usr/bin/env python3
"""Tests for scripts/statusline/statusline.py.

Covers v9.10.0 / v9.9.0 audit fixes:
  - _format_12h_ampm midnight/noon/PM edge cases (T2.25)
  - _format_12h_ampm locale-independence (de_DE.UTF-8 regression — T2.25)
  - _log_exception OSError dedup-via-errno (T2.21)
  - End-to-end CLI smoke through main() reading stdin
  - ensure_cache_dir / _log_exception / _log_tier_debug write-roots
    (2026-09-18): default writes route under ~/.llm-externalizer/statusline
    (or $LLM_EXT_CONFIG_DIR/statusline), never a bare /tmp/claude

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

  ensure_cache_dir() -> Path
      No args. Resolves $LLM_EXT_CONFIG_DIR (or <HOME>/.llm-externalizer) and
      returns "<that>/statusline", creating it (mode 0o700) — mirrors the
      TypeScript CLI's getConfigDir() (scripts/llm-ext/src/config.ts).
"""

from __future__ import annotations

import importlib.util
import json
import locale
import os
import subprocess
import sys
import time
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


@pytest.fixture(autouse=True)
def _sandbox_home_and_config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """S6 (c6b review): every test in this file gets its OWN throwaway HOME
    and LLM_EXT_CONFIG_DIR under tmp_path, autouse so a test that forgets to
    sandbox one of them can never fall through to ensure_cache_dir()'s real
    <HOME>/.llm-externalizer default and touch the developer's / CI runner's
    actual home directory. A test that needs a SPECIFIC value (a particular
    cfg_dir path an assertion checks against) still sets its own env var
    after this fixture runs — the later monkeypatch call wins.
    """
    # LLM_EXT_CONFIG_DIR nested UNDER home, not a sibling: ensure_cache_dir()'s
    # S1 write-roots guard only accepts a config dir under realpath(HOME) or
    # realpath("/tmp") — pytest's own tmp_path lives under macOS's per-user
    # $TMPDIR, not /tmp, so nesting under HOME is the only path this fixture
    # can hand out that the guard accepts by construction.
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("LLM_EXT_CONFIG_DIR", str(home / "cfg"))


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
    tmp_path: Path,
) -> None:
    """When _log_exception cannot write the log (OSError on file open), it
    emits ONE stderr breadcrumb per unique errno. Calling it twice with the
    same triggering errno must NOT spam stderr — T2.21 dedup contract.

    We force the OSError by monkey-patching pathlib.Path.open inside the
    statusline module so any attempt to open the log file raises OSError
    with errno=28 (ENOSPC = disk full). The dedup set is keyed by errno,
    so two calls produce exactly one breadcrumb.

    LLM_EXT_CONFIG_DIR is sandboxed to tmp_path by the module's autouse
    _sandbox_home_and_config_dir fixture, so _log_exception's internal
    ensure_cache_dir() call (write-roots rule, 2026-09-18) creates its
    directory under tmp_path, never the real ~/.llm-externalizer — S6 (c6b
    review): the per-test setenv this test used to carry duplicated what
    the fixture already guarantees.
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
# ensure_cache_dir / _log_exception / _log_tier_debug — the statusline is
# INDEPENDENT of llm-externalizer: it has its OWN folder (/tmp/claude),
# created by the script itself, and reads no llm-ext config. The former
# coupling (reading $LLM_EXT_CONFIG_DIR and writing under
# ~/.llm-externalizer/statusline) broke the CLI-stats link, because the
# TypeScript CLI writes its stats to /tmp/claude/llm-externalizer-stats.json.
# Every test below redirects _CACHE_DIR into tmp_path — never the real /tmp.
# ---------------------------------------------------------------------------


def test_ensure_cache_dir_uses_its_own_folder_not_the_llm_ext_config_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ensure_cache_dir() resolves to the statusline's OWN /tmp/claude and
    creates it itself — it does NOT follow $LLM_EXT_CONFIG_DIR or HOME."""
    monkeypatch.delenv("LLM_EXT_CONFIG_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    mod = _load_statusline_module()
    own = tmp_path / "claude"
    monkeypatch.setattr(mod, "_CACHE_DIR", own)

    cache_dir = mod.ensure_cache_dir()

    assert cache_dir.resolve() == own.resolve()
    assert cache_dir.is_dir(), "the statusline did not create its own folder"
    # Independence: the llm-ext config dir was never consulted.
    assert not (tmp_path / ".llm-externalizer").exists(), (
        "the statusline created an llm-ext path — it must stay independent"
    )


def test_ensure_cache_dir_ignores_llm_ext_config_dir_entirely(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """$LLM_EXT_CONFIG_DIR must NOT move the statusline's cache dir — the
    statusline reads no llm-ext config."""
    monkeypatch.setenv("HOME", str(tmp_path))
    cfg_dir = tmp_path / "custom-cfg"
    monkeypatch.setenv("LLM_EXT_CONFIG_DIR", str(cfg_dir))
    mod = _load_statusline_module()
    own = tmp_path / "claude"
    monkeypatch.setattr(mod, "_CACHE_DIR", own)

    cache_dir = mod.ensure_cache_dir()

    assert cache_dir.resolve() == own.resolve()
    assert not (cfg_dir / "statusline").exists(), (
        "LLM_EXT_CONFIG_DIR moved the statusline's cache dir — the statusline "
        "must be independent of llm-externalizer"
    )


def test_ensure_cache_dir_refuses_a_symlinked_own_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The statusline's own folder is still symlink-guarded (CWE-59): a
    local user who plants the folder as a symlink must not be able to divert
    the statusline's writes."""
    mod = _load_statusline_module()
    target = tmp_path / "victim"
    target.mkdir()
    own = tmp_path / "claude"
    own.symlink_to(target)
    monkeypatch.setattr(mod, "_CACHE_DIR", own)

    with pytest.raises(RuntimeError, match="symlink"):
        mod.ensure_cache_dir()


def test_log_exception_writes_error_log_under_its_own_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_log_exception's error log lands under the statusline's own folder
    (/tmp/claude) — this write is UNCONDITIONAL (every internal exception)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LLM_EXT_CONFIG_DIR", str(tmp_path / "cfg"))
    mod = _load_statusline_module()
    own = tmp_path / "claude"
    own.mkdir()
    monkeypatch.setattr(mod, "_CACHE_DIR", own)
    mod._LOG_EXCEPTION_WARN_SEEN.clear()

    mod._log_exception("test-label", RuntimeError("boom"))

    log_path = own / "statusline-error.log"
    assert log_path.is_file()
    assert "[test-label]" in log_path.read_text()


def test_log_tier_debug_writes_under_its_own_folder_when_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_log_tier_debug, when CLAUDE_STATUSLINE_DEBUG is set, writes under the
    statusline's own folder — CLAUDE_STATUSLINE_DEBUG only gates WHETHER
    this writes, not WHERE."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LLM_EXT_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("CLAUDE_STATUSLINE_DEBUG", "1")
    mod = _load_statusline_module()
    own = tmp_path / "claude"
    own.mkdir()
    monkeypatch.setattr(mod, "_CACHE_DIR", own)

    mod._log_tier_debug(120, 80, 2)

    dbg_path = own / "statusline-debug.log"
    assert dbg_path.is_file()
    assert "cols=120" in dbg_path.read_text()


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


def test_statusline_cli_ignores_the_llm_ext_config_dir_entirely(
    tmp_path: Path,
) -> None:
    """The statusline is INDEPENDENT of llm-externalizer: an
    $LLM_EXT_CONFIG_DIR that points somewhere the CLI would REJECT must not
    affect the bar at all — the statusline never reads it. The bar renders,
    and no "cache dir unavailable" breadcrumb appears, because nothing about
    the llm-ext config dir is the statusline's business.
    """
    envelope = {
        "cwd": "/tmp",
        "model": {"display_name": "opus"},
        "session_id": "x",
    }
    payload = json.dumps(envelope).encode("utf-8")

    venv_python = PROJECT_ROOT / ".venv" / "bin" / "python"
    python_bin = str(venv_python) if venv_python.exists() else sys.executable

    # A config dir that resolves outside BOTH HOME and /tmp — the exact
    # condition ensure_cache_dir() raises RuntimeError for.
    outside_dir = tmp_path / "outside"
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(tmp_path / "home"),
        "LLM_EXT_CONFIG_DIR": str(outside_dir),
        "LANG": "C.UTF-8",
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
    assert r.stdout, "bar went blank instead of rendering"

    # Assert independence POSITIVELY: after a full render, NOTHING may exist
    # under the llm-ext config dir. Asserting the absence of an error string
    # would be vacuous — the new code cannot emit it.
    assert not outside_dir.exists(), (
        f"the statusline created the llm-ext config dir {outside_dir} — it "
        "must not read or write any llm-ext path"
    )
    stderr = r.stderr.decode(errors="replace")
    assert "cache dir unavailable" not in stderr, (
        f"the llm-ext config dir reached the statusline; stderr={stderr!r}"
    )


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


# ---------------------------------------------------------------------------
# S4 (c6b review) — _stale_fallback's CACHE_HARD_CEILING already existed
# (T2.23, 24h) before this review; these pin the behavior with a real
# regression test, since none existed. Matters now that the cache SURVIVES
# reboots (write-roots rule, 2026-09-18): "old but still present" is a real
# scenario a developer hits, not just a same-boot race.
# ---------------------------------------------------------------------------


def test_stale_fallback_returns_expired_sentinel_past_cache_hard_ceiling(
    tmp_path: Path,
) -> None:
    """A cache file older than CACHE_HARD_CEILING must render as the
    `_stale_expired` sentinel, never be served as current data."""
    mod = _load_statusline_module()
    cache_file = tmp_path / "usage-cache.json"
    cache_file.write_text(json.dumps({"rate_limits": {}}), encoding="utf-8")
    old_time = time.time() - mod.CACHE_HARD_CEILING - 60
    os.utime(cache_file, (old_time, old_time))

    result = mod._stale_fallback(cache_file)

    assert result == {"_stale_expired": True}


def test_stale_fallback_returns_cached_data_within_cache_hard_ceiling(
    tmp_path: Path,
) -> None:
    """Complementary case: within the ceiling, the cached dict is served
    as-is — guards against an off-by-one that flags everything as expired."""
    mod = _load_statusline_module()
    cache_file = tmp_path / "usage-cache.json"
    payload = {"rate_limits": {"five_hour": {}}}
    cache_file.write_text(json.dumps(payload), encoding="utf-8")

    result = mod._stale_fallback(cache_file)

    assert result == payload


# ---------------------------------------------------------------------------
# S3 (c6b review) — statusline-error.log had no size bound (T2.21 fixed this
# for the debug log at 128 MB; the error log inherited the same gap once it
# moved off /tmp, which used to give it implicit rotation via the OS).
# ---------------------------------------------------------------------------


def test_log_exception_rotates_oversized_log_before_appending(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once statusline-error.log exceeds _ERROR_LOG_MAX_BYTES, the next
    _log_exception call rotates it to a single `.1` backup instead of
    growing it forever."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LLM_EXT_CONFIG_DIR", str(tmp_path / "cfg"))
    mod = _load_statusline_module()
    mod._LOG_EXCEPTION_WARN_SEEN.clear()

    log_dir = tmp_path / "claude"
    log_dir.mkdir(parents=True)
    monkeypatch.setattr(mod, "_CACHE_DIR", log_dir)
    log_path = log_dir / "statusline-error.log"
    log_path.write_bytes(b"x" * (mod._ERROR_LOG_MAX_BYTES + 1))

    mod._log_exception("oversized-test", RuntimeError("boom"))

    backup = log_dir / "statusline-error.log.1"
    assert backup.is_file(), "oversized log was not rotated to a .1 backup"
    assert backup.stat().st_size == mod._ERROR_LOG_MAX_BYTES + 1
    # The fresh log now holds only the new entry, not the old oversized blob.
    assert log_path.stat().st_size < mod._ERROR_LOG_MAX_BYTES
    assert "[oversized-test]" in log_path.read_text()


def test_rotate_failure_emits_one_stderr_breadcrumb(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A FAILED rotation surfaces on stderr, once per unique errno.

    The bound on statusline-error.log exists for the incident where the log
    grew to 101 MB / 65k entries in one 429 storm. A rotation that fails
    PERSISTENTLY must not be silent: the cap stops holding, the log regrows,
    and the user gets no clue why. The USER's 2026-10-09 hand-fix to the
    installed statusline added this breadcrumb; this port carries it.

    We force the failure by making Path.replace raise OSError(ENOSPC), then
    rotate twice. The dedup is keyed by errno, so two calls produce exactly
    one breadcrumb — the same contract the sibling write-failure path has.
    """
    mod = _load_statusline_module()
    mod._LOG_EXCEPTION_WARN_SEEN.clear()

    log_dir = tmp_path / "claude"
    log_dir.mkdir(parents=True)
    monkeypatch.setattr(mod, "_CACHE_DIR", log_dir)
    log_path = log_dir / "statusline-error.log"
    log_path.write_bytes(b"x" * (mod._ERROR_LOG_MAX_BYTES + 1))

    def boom(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        err = OSError(28, "No space left on device")
        raise err

    monkeypatch.setattr(mod.Path, "replace", boom)

    capsys.readouterr()
    mod._rotate_log_if_oversized(log_path)
    mod._rotate_log_if_oversized(log_path)  # same key, same errno → must dedup

    err = capsys.readouterr().err
    crumbs = err.count("[llm-externalizer statusline] cannot rotate error log")
    assert crumbs == 1, f"expected 1 dedup'd breadcrumb, got {crumbs}; stderr={err!r}"
    assert "errno 28" in err
    # The message must not claim the cap is disabled: the cap is still
    # enforced on the next call, which retries the rotation.
    assert "may regrow unbounded" in err


# ---------------------------------------------------------------------------
# get_git_info — GH #14: a killed `git status` must never leave a stale
# .git/index.lock. `status` refreshes the on-disk index, so the call needs
# `--no-optional-locks` (before the subcommand) so a timeout kill mid-refresh
# takes no lock in the first place.
# ---------------------------------------------------------------------------


def _build_stale_mtime_repo(repo: Path) -> None:
    """Init a repo, commit one tracked file, then pin its mtime to a FIXED
    PAST value (not "current + N"): an mtime at/after the index's own mtime
    is "racily clean" per git's own staleness rule and would NOT reliably
    trigger a refresh on filesystems with 1s timestamp resolution."""
    repo.mkdir()
    git_env = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"]
    subprocess.run(["git", *git_env, "init", "-q", str(repo)], check=True)
    tracked = repo / "f.txt"
    tracked.write_text("hello\n")
    subprocess.run(["git", "-C", str(repo), *git_env, "add", "f.txt"], check=True)
    subprocess.run(["git", "-C", str(repo), *git_env, "commit", "-q", "-m", "init"], check=True)
    os.utime(tracked, (1_000_000_000, 1_000_000_000))


def test_get_git_info_never_rewrites_the_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real repo with a stale-but-unchanged file mtime makes plain `git
    status` refresh (and rewrite) `.git/index` — that's what `stat` caching
    is for. `get_git_info` must use `--no-optional-locks` so it never takes
    that write, because a 1 s timeout kill mid-refresh would otherwise leave
    a stale `.git/index.lock` behind (GH #14).

    The byte-identity comparison of `.git/index` before/after the call is
    the real evidence here; the "no index.lock left behind" assert below it
    is only a secondary sanity check, since a normal (non-killed) exit
    removes the lock either way and would not by itself catch a rewrite
    that completed cleanly.

    A second, identical repo proves the PREMISE in-test (never skipped):
    that on this git version/filesystem a plain `status` (no
    --no-optional-locks) actually does rewrite `.git/index` for a
    stale-mtime file. Without that premise holding, the real-repo
    assertion above could pass vacuously (e.g. if this git build never
    rewrites the index for any reason) without proving anything about
    get_git_info's own behaviour."""
    # Isolate every git call below (both the test's own and get_git_info's)
    # from the machine's ambient git config: a user core.fsmonitor /
    # core.untrackedCache / index.skipHash, or an inherited
    # GIT_OPTIONAL_LOCKS=0, would change whether `status` rewrites the
    # index at all, making this test flaky or silently vacuous depending
    # on which machine runs it.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.delenv("GIT_OPTIONAL_LOCKS", raising=False)

    mod = _load_statusline_module()

    # Premise repo: same construction, but the status call is PLAIN (no
    # --no-optional-locks) so it exercises the write path we assert the
    # real repo below never takes.
    premise_repo = tmp_path / "premise-repo"
    _build_stale_mtime_repo(premise_repo)
    premise_index = premise_repo / ".git" / "index"
    premise_before = premise_index.read_bytes()
    subprocess.run(
        ["git", "-C", str(premise_repo), "status", "--porcelain=v1"],
        check=True,
        capture_output=True,
    )
    assert premise_index.read_bytes() != premise_before, (
        "premise failed: a plain `git status` did not rewrite .git/index "
        "on this git version/filesystem, so this test cannot discriminate "
        "get_git_info's --no-optional-locks fix from a regression"
    )

    repo = tmp_path / "repo"
    _build_stale_mtime_repo(repo)

    index_path = repo / ".git" / "index"
    before_bytes = index_path.read_bytes()

    branch, _ = mod.get_git_info(str(repo))

    # Rule out a vacuous pass: if get_git_info bailed early (e.g. rev-parse
    # failed) it would never reach the `status` call, and the index would
    # trivially be untouched for the wrong reason.
    assert branch, f"get_git_info returned no branch name ({branch!r}); it may not have reached `status`"
    assert index_path.read_bytes() == before_bytes, ".git/index was rewritten by get_git_info"
    assert not (repo / ".git" / "index.lock").exists(), "get_git_info left a stale .git/index.lock behind"



# ---------------------------------------------------------------------------
# TRDD-6AAKQYH9 — spend_limit (CC 2.1.284) and prompt_cache (CC 2.1.265)
# statusline rows. Both fields are NEW in the input JSON: guarded rendering
# means older CC envelopes (no such keys) render byte-identically to before,
# and newer envelopes surface the row. E2E through main() subprocess — same
# hermetic pattern as the smoke tests above (redirected HOME, no network:
# rate_limits in the envelope preempts fetch_usage_from_api).
# ---------------------------------------------------------------------------


def _run_statusline(envelope: dict, tmp_path: Path) -> str:
    """Pipe an envelope through the statusline subprocess and return stdout."""
    payload = json.dumps(envelope).encode("utf-8")
    venv_python = PROJECT_ROOT / ".venv" / "bin" / "python"
    python_bin = str(venv_python) if venv_python.exists() else sys.executable
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "LANG": "C.UTF-8",
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
    return r.stdout.decode("utf-8")


def test_statusline_renders_spend_limit_row_when_present(tmp_path: Path) -> None:
    """rate_limits.spend_limit (used_usd/limit_usd/period, CC 2.1.284+) must
    render as a 💳 $used/$limit segment (+ short period); exit 0, no blank
    bar, and the breadcrumb-free stderr a healthy run has."""
    envelope = {
        "cwd": "/tmp",
        "model": {"display_name": "opus"},
        "session_id": "x",
        "rate_limits": {
            "five_hour": {"used_percentage": 10.0},
            "seven_day": {"used_percentage": 5.0},
            "spend_limit": {"used_usd": 12.5, "limit_usd": 100.0, "period": "monthly"},
        },
    }
    out = _run_statusline(envelope, tmp_path)
    assert "💳" in out, f"spend-limit segment missing from: {out!r}"
    assert "$12.50/$100.00" in out, f"spend-limit amounts wrong in: {out!r}"
    # Short period strings ride along; the guard drops anything > 8 chars.
    assert "monthly" in out, f"period missing from: {out!r}"


def test_statusline_renders_prompt_cache_row_when_present(tmp_path: Path) -> None:
    """A top-level prompt_cache cause string (CC 2.1.265+) must render dim,
    truncated to 60 chars, without breaking the bar."""
    long_cause = "x" * 200  # longer than the 60-char truncation
    envelope = {
        "cwd": "/tmp",
        "model": {"display_name": "opus"},
        "session_id": "x",
        "prompt_cache": long_cause,
    }
    out = _run_statusline(envelope, tmp_path)
    assert "🧩" in out, f"prompt-cache segment missing from: {out!r}"
    # Exactly 60 x's survive the truncation, none of the rest.
    assert "x" * 60 in out and "x" * 61 not in out, (
        f"60-char truncation violated in: {out!r}"
    )


def test_statusline_omits_new_rows_on_legacy_envelope(tmp_path: Path) -> None:
    """Older CC envelope without either key renders NEITHER new row — the
    guarded pattern must stay inert on versions that never send the fields."""
    envelope = {
        "cwd": "/tmp",
        "model": {"display_name": "opus"},
        "session_id": "x",
        "rate_limits": {"five_hour": {"used_percentage": 10.0}},
    }
    out = _run_statusline(envelope, tmp_path)
    assert "💳" not in out and "🧩" not in out, f"rows leaked on legacy envelope: {out!r}"



def _render_bar(mod, monkeypatch, envelope: dict) -> str:
    """Run the statusline's real main() with a scripted stdin, and return
    what it printed.

    In-process (not a subprocess) so the test can redirect the module's
    _CACHE_DIR to a tmp_path — a spawned process cannot be monkeypatched,
    and reading the REAL /tmp/claude would make the assertion depend on
    whatever happens to be there.
    """
    import io

    payload = json.dumps(envelope)
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    try:
        mod.main()
    finally:
        monkeypatch.undo()
    return out.getvalue()



def test_statusline_still_renders_when_its_folder_is_unusable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unusable cache folder must degrade the bar, never blank it.

    /tmp/claude is a predictable, shared path. On a multi-user host a second
    local user can create it first; the statusline's uid guard then refuses
    it. The bar MUST still render (the optional rows are skipped) and the
    refusal MUST be visible on stderr — a silent degradation is how the
    "blank the bar" failure the dae5150d hardening was written to prevent
    comes back.

    SCOPE, stated plainly: this test exercises the UNUSABLE-folder path (a
    parent that is a file, so mkdir fails), NOT the foreign-uid branch. The
    uid branch cannot be exercised here — the test user owns everything it
    can create, and chowning to another uid is not portable. So the uid case
    is covered by the guard's own code path, not by a test.

    It asserts the two properties the guard exists for: the bar renders, and
    a refusal is reported rather than swallowed.
    """
    mod = _load_statusline_module()

    # A folder that cannot be opened: make the PARENT a file, so mkdir fails.
    blocked = tmp_path / "blocked"
    blocked.write_text("not a directory")
    monkeypatch.setattr(mod, "_CACHE_DIR", blocked / "claude")

    envelope = {"cwd": "/tmp", "model": {"display_name": "opus"}, "session_id": "x"}
    rendered = _render_bar(mod, monkeypatch, envelope)

    assert rendered, "the bar went blank when the cache folder was unusable"
    assert "opus" in rendered, f"the bar lost its model row; bar={rendered!r}"



def test_only_ensure_cache_dir_reads_the_cache_constant() -> None:
    """The production writers must go through ensure_cache_dir(), not read
    _CACHE_DIR themselves.

    The seam test redirects `_CACHE_DIR` and checks the writer follows. That
    only proves anything if the writer reads the module attribute AT CALL
    TIME. A future "optimisation" that memoises the resolved path into a
    second module global would leave the seam test passing while the writer
    no longer consults the constant at all — the seam would be bypassed one
    level up, and nothing would notice.

    So assert the structure: `_CACHE_DIR` appears in exactly two places —
    its definition, and ensure_cache_dir(). Every other writer goes through
    that function, so redirecting the constant moves all of them.
    """
    source = STATUSLINE_PATH.read_text(encoding="utf-8")
    occurrences = [
        (i + 1, line)
        for i, line in enumerate(source.splitlines())
        if "_CACHE_DIR" in line and not line.lstrip().startswith("#")
    ]
    assert len(occurrences) == 2, (
        f"_CACHE_DIR must be read in exactly one place (ensure_cache_dir), "
        f"found {len(occurrences)}: {[n for n, _ in occurrences]}"
    )

    # The definition, and the read inside ensure_cache_dir.
    assert occurrences[0][1].startswith("_CACHE_DIR = "), (
        f"line {occurrences[0][0]} is not the definition: {occurrences[0][1]!r}"
    )
    assert "cache_dir = _CACHE_DIR" in occurrences[1][1], (
        f"line {occurrences[1][0]} is not ensure_cache_dir's read: "
        f"{occurrences[1][1]!r}"
    )

def test_cache_dir_seam_is_load_bearing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The production writers must read the module attribute, not a literal.

    The tests above redirect the writers with
    `monkeypatch.setattr(mod, "_CACHE_DIR", …)`. That redirection only proves
    anything if the PRODUCTION code reads `_CACHE_DIR` at call time. If a
    future refactor inlines `Path("/tmp/claude")` back into a writer, those
    tests would keep passing while testing nothing — the redirect would land
    in a directory the code never writes to.

    So assert the seam itself:
      1. the default is the real path the CLI uses, and
      2. redirecting the module attribute actually moves where the production
         writer writes.
    """
    mod = _load_statusline_module()

    assert mod._CACHE_DIR == Path("/tmp/claude"), (
        f"the default cache dir moved: {mod._CACHE_DIR} — the CLI writes "
        f"/tmp/claude/llm-externalizer-stats.json, so the two must agree"
    )

    own = tmp_path / "claude"
    own.mkdir()
    monkeypatch.setattr(mod, "_CACHE_DIR", own)
    monkeypatch.setenv("CLAUDE_STATUSLINE_DEBUG", "1")

    mod._log_tier_debug(120, 80, 2)
    assert (own / "statusline-debug.log").is_file(), (
        "the production writer did not follow the redirected _CACHE_DIR — "
        "it is reading a literal, so the seam is not load-bearing"
    )


def test_statusline_reads_the_cli_stats_file_from_the_same_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The CLI-stats link must be LIVE: the TypeScript CLI writes
    /tmp/claude/llm-externalizer-stats.json, and the statusline must read it
    from the SAME folder. The link was dead when the statusline cached under
    ~/.llm-externalizer/statusline/ while the CLI wrote /tmp/claude.

    The CLI's STATS_FILE constant is read from the source so the test fails
    if the CLI ever moves the file again.
    """
    mod = _load_statusline_module()

    cli_src = PROJECT_ROOT / "scripts" / "llm-ext" / "src" / "index.ts"
    assert cli_src.is_file(), f"the CLI source moved: {cli_src}"
    cli_text = cli_src.read_text(encoding="utf-8")
    assert '"/tmp/claude/llm-externalizer-stats.json"' in cli_text, (
        "the CLI's stats path changed — the statusline's folder must follow it"
    )

    # The link is a PATH AGREEMENT between two independent programs: the CLI
    # writes /tmp/claude/llm-externalizer-stats.json, and the statusline must
    # read the stats from the SAME folder. Assert the agreement directly —
    # the statusline's resolved cache dir and the CLI's STATS_FILE constant
    # must name the same directory. (A test that renders the bar would read
    # whatever file happens to sit in the REAL /tmp/claude, so it would pass
    # for the wrong reason and fail for an unrelated one.)
    cli_stats = Path("/tmp/claude/llm-externalizer-stats.json")
    statusline_dir = mod._CACHE_DIR.resolve()
    assert cli_stats.parent.resolve() == statusline_dir, (
        f"the CLI writes {cli_stats} but the statusline reads from "
        f"{statusline_dir} — the CLI-stats link is DEAD"
    )

    # And BEHAVIOURALLY: run the real statusline against a real stats file in
    # the folder it reads from, and assert the CLI-stats segment reaches the
    # rendered bar. This is the link itself, not an agreement between two
    # literals — the statusline's code path decides where it looks.
    own = tmp_path / "claude"
    own.mkdir()
    monkeypatch.setattr(mod, "_CACHE_DIR", own)
    (own / cli_stats.name).write_text(
        json.dumps({"total_tokens": 4242, "total_cost": 1.25})
    )

    envelope = {
        "cwd": "/tmp",
        "model": {"display_name": "opus"},
        "session_id": "x",
    }
    rendered = _render_bar(mod, monkeypatch, envelope)

    assert "\U0001f50c" in rendered, (
        "the CLI-stats segment did not render — the statusline did not read "
        f"the CLI's stats file from its own folder; bar={rendered!r}"
    )
    # The token count is formatted (4242 -> "4k") — assert the FORMATTED
    # value, so the assertion survives a formatting change but still fails if
    # the number never arrives.
    assert mod.format_tokens(4242) in rendered, (
        f"the CLI's token count did not reach the bar; bar={rendered!r}"
    )
    assert "$1.2500" in rendered, (
        f"the CLI's cost did not reach the bar; bar={rendered!r}"
    )
