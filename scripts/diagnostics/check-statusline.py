#!/usr/bin/env python3
"""check-statusline.py — Verify the llm-externalizer statusline is wired up.

Reads ~/.claude/settings.json, locates the statusLine block, resolves the
configured interpreter, pipes a minimal Claude Code JSON envelope to the
statusline command, and reports the exit code + stdout sample.

Usage:
  scripts/diagnostics/check-statusline.py             # report-only
  scripts/diagnostics/check-statusline.py --fix       # re-run install_statusline.py if broken

Exit codes:
  0 — statusline runs and produces non-empty output
  1 — statusline is misconfigured or crashes
  2 — diagnostic could not run (no ~/.claude/settings.json, bad args)
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

SAMPLE_INPUT = json.dumps({
    "session_id": "00000000-0000-0000-0000-000000000000",
    "transcript_path": "",
    "cwd": str(Path.cwd()),
    "model": {"id": "claude-sonnet-4-6", "display_name": "Sonnet"},
    "workspace": {"current_dir": str(Path.cwd()), "project_dir": str(Path.cwd())},
    "version": "2.1.141",
    "output_style": {"name": "default"},
})


def find_settings() -> Path:
    return Path.home() / ".claude" / "settings.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the statusline command runs.")
    parser.add_argument("--fix", action="store_true",
                        help="Re-run scripts/install_statusline.py if the check fails.")
    args = parser.parse_args()

    settings_path = find_settings()
    if not settings_path.is_file():
        print(f"FAIL: {settings_path} does not exist.", file=sys.stderr)
        return 2

    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"FAIL: {settings_path} is not valid JSON: {e}", file=sys.stderr)
        return 2

    sl = data.get("statusLine")
    if not isinstance(sl, dict):
        print("FAIL: no statusLine block in ~/.claude/settings.json. "
              "Run: claude /llm-externalizer-install-statusline", file=sys.stderr)
        return 1
    cmd = sl.get("command")
    if not isinstance(cmd, str) or not cmd.strip():
        print("FAIL: statusLine.command is missing or empty.", file=sys.stderr)
        return 1
    print(f"statusLine.command = {cmd}")
    print(f"statusLine.refreshInterval = {sl.get('refreshInterval', 'unset')}")

    # Resolve interpreter / arg-split. The installer now writes the command
    # as shlex.join([interp, path]) so split shlex it the other way around.
    try:
        argv = shlex.split(cmd)
    except ValueError as e:
        print(f"FAIL: statusLine.command is not parseable as a shell command: {e}",
              file=sys.stderr)
        return 1
    if not argv:
        print("FAIL: statusLine.command is empty after parse.", file=sys.stderr)
        return 1
    interp_path = argv[0]
    if not os.path.isabs(interp_path):
        resolved = shutil.which(interp_path)
        if resolved is None:
            print(f"FAIL: interpreter {interp_path!r} not on PATH.", file=sys.stderr)
            return 1
        argv[0] = resolved
        print(f"resolved interpreter: {resolved}")
    elif not os.path.isfile(argv[0]):
        print(f"FAIL: interpreter {argv[0]} does not exist.", file=sys.stderr)
        return 1

    # Pipe the sample JSON and check the exit + non-empty stdout.
    try:
        proc = subprocess.run(
            argv, input=SAMPLE_INPUT, capture_output=True,
            text=True, timeout=10, check=False,
        )
    except subprocess.SubprocessError as e:
        print(f"FAIL: statusline crashed: {e}", file=sys.stderr)
        return 1
    if proc.returncode != 0:
        print(f"FAIL: statusline exited {proc.returncode}.", file=sys.stderr)
        if proc.stderr:
            print(f"stderr: {proc.stderr[:500]}", file=sys.stderr)
        if args.fix:
            print("Re-running install_statusline.py per --fix ...", file=sys.stderr)
            installer = Path(__file__).resolve().parent.parent / "install_statusline.py"
            subprocess.run([sys.executable, str(installer)], check=False)
        return 1
    out = proc.stdout.strip()
    if not out:
        print("FAIL: statusline produced empty stdout.", file=sys.stderr)
        return 1
    sample = out.splitlines()[0]
    if len(sample) > 200:
        sample = sample[:197] + "..."
    print(f"PASS: statusline produced {len(out)} bytes; first line: {sample!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
