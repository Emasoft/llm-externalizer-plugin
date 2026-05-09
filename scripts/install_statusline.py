#!/usr/bin/env python3
"""Install the LLM Externalizer multi-tier Claude Code statusline.

Cross-platform Python equivalent of ``scripts/statusline/install.sh``.

Behaviour mirrors install.sh exactly:
- Source: ``scripts/statusline/statusline.py`` (the rich, width-tiered version
  with OpenRouter credit tracking, MCP token/cost panel, 5h/7d limits, etc.).
- Destination: ``~/.claude/statusline.py`` (chmod 0o755).
- Backups (only when content actually differs): ``.bak.<YYYYMMDD_HHMMSS+0000>``.
- Patches ``~/.claude/settings.json`` with::

      {
        "statusLine": {
          "type": "command",
          "command": "python3 ~/.claude/statusline.py",
          "refreshInterval": 3
        }
      }

- Atomic settings.json write (tmp file in same dir + os.replace).
- Idempotent: re-running is safe.
- ``REFRESH_INTERVAL`` env var overrides the 3-second default.

Usage:
    python3 scripts/install_statusline.py

Or via the bundled slash command:
    /llm-externalizer:llm-externalizer-install-statusline
"""

from __future__ import annotations

import filecmp
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


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


def main() -> None:
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

    # Replace the statusLine block (rewrite, not merge) so stale fields can't survive.
    data["statusLine"] = {
        "type": "command",
        "command": f"python3 {dest}",
        "refreshInterval": refresh_interval,
    }
    _atomic_write_json(settings_path, data)

    print(f"==> patched {settings_path}")
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
