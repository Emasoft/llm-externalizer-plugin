#!/usr/bin/env python3
"""Install the LLM Externalizer multi-tier Claude Code statusline.

Cross-platform Python equivalent of ``scripts/statusline/install.sh``.

Behaviour mirrors install.sh exactly:
- Source: ``scripts/statusline/statusline.py`` (the rich, width-tiered version
  with OpenRouter credit tracking, CLI token/cost panel, 5h/7d limits, etc.).
- Destination: ``~/.claude/statusline.py`` (chmod 0o755).
- Backups (only when content actually differs): ``.bak.<YYYYMMDD_HHMMSS±HHMM>`` (local time + GMT offset, e.g. ``.bak.20260524_223512+0200``).
- Patches ``~/.claude/settings.json`` with::

      {
        "statusLine": {
          "type": "command",
          "command": "python3 ~/.claude/statusline.py",
          "refreshInterval": 3
        }
      }

- Writes our command PLAIN. If an agentlenspro capture wrap was already present
  and ``agentlenspro`` is on PATH, it is re-applied by invoking that tool's own
  ``--install-statusline`` (it wraps whatever command is there), then the wrap is
  verified in settings.json. Never composes ``--inner`` by hand — that is
  agentlenspro-internal, and pre-wrapping makes it wrap the wrap.
- Atomic settings.json write (tmp file in same dir + os.replace).
- Idempotent: re-running is safe.
- ``REFRESH_INTERVAL`` env var overrides the 3-second default.

Usage:
    python3 scripts/install_statusline.py            # install (takes NO arguments)
    python3 scripts/install_statusline.py --help     # print help, change nothing

Or via the bundled slash command:
    /llm-externalizer:llm-externalizer-install-statusline
"""

from __future__ import annotations

import filecmp
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# WHY a named constant: the wrapper hang path (review m5) must be testable with a short timeout.
WRAPPER_TIMEOUT_S = 120


def _timestamp() -> str:
    """Local time with GMT offset, filesystem-safe — matches install.sh."""
    return datetime.now(timezone.utc).astimezone().strftime("%Y%m%d_%H%M%S%z")


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write JSON to ``path`` atomically (tmp file + os.replace)."""
    fd, tmp = tempfile.mkstemp(prefix=".settings.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


_USAGE = """\
Usage: install_statusline.py            install the statusline (takes NO arguments)
       install_statusline.py --help     show this help and exit (no side effects)
Env:   REFRESH_INTERVAL=<seconds>       statusline refresh interval (default 3)"""


def main() -> None:
    # Argv guard: this installer takes NO arguments. Anything unexpected must
    # exit BEFORE any side effect — without this guard, probing the script with
    # any flag (even --bogus) copied files and patched ~/.claude/settings.json.
    args = sys.argv[1:]
    if args:
        if args[0] in ("-h", "--help"):
            print(_USAGE)
            sys.exit(0)
        print(
            f"Error: unknown argument: {args[0]} (this installer takes none).",
            file=sys.stderr,
        )
        print(_USAGE, file=sys.stderr)
        sys.exit(2)

    plugin_root = Path(__file__).resolve().parent.parent
    src = plugin_root / "scripts" / "statusline" / "statusline.py"
    claude_dir = Path.home() / ".claude"
    dest = claude_dir / "statusline.py"
    settings_path = claude_dir / "settings.json"

    refresh_raw = os.environ.get("REFRESH_INTERVAL", "3")
    try:
        refresh_interval = int(refresh_raw)
    except ValueError:
        print(
            f"Error: REFRESH_INTERVAL must be an integer (got {refresh_raw!r}).",
            file=sys.stderr,
        )
        sys.exit(2)

    print("==> Installer: Claude Code multi-tier statusline")
    print(f"    src      : {src}")
    print(f"    dest     : {dest}")
    print(f"    settings : {settings_path}")
    print(f"    refresh  : {refresh_interval}s")
    print()

    if not src.is_file():
        print(f"Error: statusline source not found at {src}", file=sys.stderr)
        print(
            "Run scripts/setup.py first, or reinstall the plugin to restore the bundled files.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not claude_dir.is_dir():
        print(
            f"Error: {claude_dir} does not exist.\n"
            "       Run Claude Code at least once before installing.",
            file=sys.stderr,
        )
        sys.exit(1)

    ts = _timestamp()

    # 1. Backup + copy the script. Only back up when content actually differs.
    if dest.is_file():
        if filecmp.cmp(str(src), str(dest), shallow=False):
            print(f"==> {dest} already up to date — skipping copy.")
        else:
            backup = dest.with_name(f"{dest.name}.bak.{ts}")
            shutil.copy2(str(dest), str(backup))
            print(f"==> backed up old {dest} → {backup}")
            shutil.copy2(str(src), str(dest))
            dest.chmod(0o755)
            print(f"==> installed {dest}")
    else:
        shutil.copy2(str(src), str(dest))
        dest.chmod(0o755)
        print(f"==> installed {dest}")

    # 2. Patch settings.json. Refuse to overwrite an unreadable / non-object file.
    if not settings_path.is_file():
        print(f"==> creating new {settings_path}")
        settings_path.write_text("{}\n", encoding="utf-8")

    backup_settings = settings_path.with_name(f"{settings_path.name}.bak.{ts}")
    shutil.copy2(str(settings_path), str(backup_settings))
    print(f"==> backed up old {settings_path} → {backup_settings}")

    raw = settings_path.read_text(encoding="utf-8")
    if raw.strip():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(
                f"Error: {settings_path} is not valid JSON ({exc}). "
                "Refusing to overwrite — fix or remove the file manually, then re-run.",
                file=sys.stderr,
            )
            sys.exit(2)
    else:
        data = {}

    if not isinstance(data, dict):
        print(
            f"Error: {settings_path} contains valid JSON but is not a JSON object "
            f"(got {type(data).__name__}). "
            "Refusing to overwrite — fix or remove the file manually, then re-run.",
            file=sys.stderr,
        )
        sys.exit(2)

    # Pick a usable Python interpreter at install time, NOT at every refresh.
    # `python3` is unreliable: it doesn't exist on native Windows (where the
    # canonical name is `py` or `python`), on NixOS (no /usr/bin/python3
    # without an explicit nix-shell), or on PEP-668 systems where the bare
    # `python3` symlink may point at Apple's CLT-stub that pops a Xcode prompt.
    # shutil.which() returns an absolute path; fall back to sys.executable
    # which is always the interpreter currently running this installer.
    interp = shutil.which("python3") or shutil.which("python") or sys.executable
    if not interp:
        print("Error: cannot locate a Python interpreter for the statusline.", file=sys.stderr)
        sys.exit(2)
    # shlex.join handles paths containing spaces (~/Test User/.claude/statusline.py)
    # which the old `python3 {dest}` interpolation broke into two arguments.
    statusline_cmd = shlex.join([interp, str(dest)])

    # statusLine holds exactly ONE command: Claude Code keeps element [0] of an
    # array, silently discards the rest, AND rewrites settings.json back to the
    # object form (measured 2026-08-29 — 196 hits on element 0, 0 on element 1).
    # So our bar and agentlenspro's capture cannot be sibling entries: one must
    # wrap the other, and agentlenspro is the wrapper (its --install-statusline
    # "WRAPS the command already there ... passes its stdout + exit code through
    # byte-for-byte"). We therefore write our command PLAIN and let agentlenspro
    # re-apply its own wrap below. Do NOT compose `agentlenspro statusline
    # --inner ...` here: --inner is undocumented and internal, and pre-wrapping
    # made agentlenspro wrap the wrap (verified: --inner count 2).
    wrapper = shutil.which("agentlenspro")
    restored = False
    # statusLine may legitimately be a LIST here: Claude Code accepts an array,
    # keeps element [0] and rewrites the file — so a settings.json written by
    # hand between CC restarts can still hold one. A dict-only read crashes on it.
    _old = data.get("statusLine")
    if isinstance(_old, list):
        _old = _old[0] if _old and isinstance(_old[0], dict) else {}
    if not isinstance(_old, dict):
        _old = {}
    was_wrapped = "agentlenspro" in str(_old.get("command") or "")

    # Replace the statusLine block (rewrite, not merge) so stale fields can't survive.
    data["statusLine"] = {
        "type": "command",
        "command": statusline_cmd,
        "refreshInterval": refresh_interval,
    }
    _atomic_write_json(settings_path, data)

    # Re-apply agentlenspro's capture wrap through ITS OWN installer, which is
    # documented idempotent and transactional (backup + post-verify). Writing the
    # plain command first is what keeps this to exactly one wrap. Only re-wrap
    # when a wrap was already there — installing capture the user never asked for
    # is not this installer's call.
    if wrapper and was_wrapped:
        # WHY try/except: a hung wrapper raised TimeoutExpired AFTER the plain command was
        # already written, skipping the "capture wrap LOST" warning and leaving a traceback
        # (review m5). A timeout is handled exactly like a non-zero exit: the post-condition
        # check below reports the lost wrap.
        try:
            code = subprocess.run(
                # timeout: agentlenspro's installer is a local backup+rewrite of settings.json; a hang must not block this installer forever.
                [wrapper, "--install-statusline"], capture_output=True, text=True, timeout=WRAPPER_TIMEOUT_S
            ).returncode
            outcome = f"exited {code}"
        except subprocess.TimeoutExpired:
            outcome = f"timed out after {WRAPPER_TIMEOUT_S}s"
        # Fail fast naming the file: the wrapper rewrites settings.json, so a bare
        # JSONDecodeError here would not say which file it left corrupt.
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"Error: {settings_path} is not valid JSON after the agentlenspro re-wrap ({exc}).", file=sys.stderr)
            sys.exit(2)
        # Assert the POST-CONDITION, not the exit code: exit 0 does not prove the
        # wrap is back. Read what actually landed in settings.json.
        restored = "agentlenspro" in str(
            (data.get("statusLine") or {}).get("command") or ""
        )
        if not restored:
            print(
                f"Warning: `{wrapper} --install-statusline` {outcome} and the "
                "agentlenspro capture wrap is NOT in settings.json. Your bar still "
                "works (plain command); re-run that command to restore capture.",
                file=sys.stderr,
            )

    print(f"==> patched {settings_path}")
    if wrapper and was_wrapped:
        # Report what settings.json ACTUALLY holds, never the exit code. Printing
        # "re-applied" next to a stderr warning saying it wasn't is how a lost
        # wrap gets read as success.
        state = "capture wrap re-applied" if restored else "capture wrap LOST — see warning"
        print(f"    agentlenspro               = {wrapper} ({state})")
    elif wrapper:
        print(f"    agentlenspro               = {wrapper} on PATH, no wrap was present")
        print("                                 run `agentlenspro --install-statusline` to add capture")
    else:
        print("    agentlenspro               = not on PATH (standalone install)")
    print(f"    statusLine.command         = {data['statusLine']['command']}")
    print(f"    statusLine.refreshInterval = {data['statusLine']['refreshInterval']}")
    print()
    print(
        f"Done. The statusline updates within {refresh_interval}s of a terminal resize."
    )
    print("If it doesn't appear immediately, exit and relaunch Claude Code once —")
    print("settings changes can require a session restart to register.")


if __name__ == "__main__":
    main()
