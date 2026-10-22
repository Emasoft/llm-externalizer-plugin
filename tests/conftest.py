import hashlib
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"

# Make every scripts/<subpkg>/ importable so individual test files can do
# `import statusline` / `import migrate` / `import benchmark_models` without
# package-shenanigans. Each scripts/<subpkg>/ is a flat dir of .py files.
for subdir in ("statusline", "setup", "diagnostics"):
    p = SCRIPTS_DIR / subdir
    if p.is_dir():
        sys.path.insert(0, str(p))

os.environ.setdefault("LLM_EXT_TEST_MODE", "1")

# --- Real-HOME write-roots tripwire (USER rule 2026-09-18) -----------------
#
# WHY this must NOT override HOME globally: subprocess tools this suite
# shells out to (uv, npm, gh) keep caches/config under the real HOME; forcing
# HOME elsewhere for the whole session would make those calls slow or
# networked, or break them outright. Every individual test is responsible
# for sandboxing its own home-path writes (tmp_path / a scoped env var); this
# is a session-wide TRIPWIRE that catches the next test that forgets to, by
# comparing these real files' identity before and after the whole run. It is
# not a sandbox: a test that changes one of these files still runs for real,
# this only makes the session fail loudly afterward instead of silently
# corrupting the developer's real home.
# ponytail: fixed ceiling of 4 known real-write targets, not a diff of the
# whole HOME tree. If a write outside this list is ever suspected, upgrade
# by snapshotting a directory listing (names + sizes) of ~/.claude and
# ~/.llm-externalizer instead of adding paths here one at a time.
_WATCHED_PATHS: list[Path] = [
    Path.home() / ".claude" / "settings.json",
    Path.home() / ".llm-externalizer" / "settings.yaml",
    Path.home() / ".claude" / "rules" / "use-llm-externalizer.md",
    Path.home() / ".local" / "bin" / "llm-ext",
]


def _snapshot(paths: list[Path]) -> dict[str, tuple[bool, str | None]]:
    """(exists, sha256-or-None) per watched path.

    mtime is deliberately excluded: another process (a live Claude Code
    session rewriting ~/.claude/settings.json, a detached llm-ext updater
    touching ~/.llm-externalizer/settings.yaml) can rewrite a file with
    identical content, or a bare `touch`, without a real content change.
    Only a content diff proves a test actually wrote to the file.
    """
    snap: dict[str, tuple[bool, str | None]] = {}
    for p in paths:
        if not p.exists():
            snap[str(p)] = (False, None)
            continue
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        snap[str(p)] = (True, digest)
    return snap


def pytest_sessionstart(session) -> None:  # noqa: ANN001
    session.config._real_home_snapshot = _snapshot(_WATCHED_PATHS)  # noqa: SLF001


def pytest_sessionfinish(session) -> None:  # noqa: ANN001
    before = getattr(session.config, "_real_home_snapshot", None)
    if before is None:
        return
    after = _snapshot(_WATCHED_PATHS)
    changed = [path for path, state in before.items() if after.get(path) != state]
    if changed:
        session.config._real_home_write_violation = changed  # noqa: SLF001
        # Non-zero exit even if every individual test reported passed: a
        # real-home write is a rule violation independent of test outcomes.
        # Only override a clean (0) exitstatus — a more specific non-zero
        # code (2 = interrupted, 3 = internal error) is more informative
        # than this tripwire's generic 1 and must not be clobbered.
        if session.exitstatus == 0:
            session.exitstatus = 1


def pytest_terminal_summary(terminalreporter, config) -> None:  # noqa: ANN001
    changed = getattr(config, "_real_home_write_violation", None)
    if not changed:
        return
    terminalreporter.write_sep("=", "REAL-HOME WRITE-ROOTS VIOLATION", red=True, bold=True)
    for path in changed:
        terminalreporter.write_line(
            f"CHANGED: {path} — its content changed during the test "
            "session: a test, or another process on this machine, wrote "
            "it. Re-run the suite; if it trips again, a test is not "
            "sandboxing its home-path writes (tmp_path / an env override)."
        )
