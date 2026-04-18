#!/usr/bin/env python3
"""Install the LLM Externalizer statusline for Claude Code.

Shows model, context usage, MCP token/cost stats, and OpenRouter budget
in the Claude Code status bar.
"""

import json
import shutil
import sys
from pathlib import Path


def main() -> None:
    plugin_root = Path(__file__).resolve().parent.parent
    src = plugin_root / "mcp-server" / "statusline.py"
    claude_dir = Path.home() / ".claude"
    dest = claude_dir / "statusline.py"
    settings_path = claude_dir / "settings.json"

    if not src.is_file():
        print(f"Error: statusline.py not found at {src}", file=sys.stderr)
        print("Run scripts/setup.py first to ensure all files are in place.", file=sys.stderr)
        sys.exit(1)

    claude_dir.mkdir(parents=True, exist_ok=True)

    # Backup existing statusline
    if dest.is_file():
        backup = dest.with_suffix(".py.bak")
        shutil.copy2(str(dest), str(backup))
        print(f"Backed up existing statusline to {backup}")

    shutil.copy2(str(src), str(dest))
    dest.chmod(0o755)
    print(f"Installed statusline.py to {dest}")

    # Update or create settings.json with statusLine configuration
    command = f'python3 "{dest}"'
    if settings_path.is_file():
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(
                f"Error: {settings_path} is not valid JSON ({exc}). "
                "Refusing to overwrite — fix or remove the file manually, then re-run.",
                file=sys.stderr,
            )
            sys.exit(1)
        settings["statusLine"] = {"type": "command", "command": command}
        settings_path.write_text(
            json.dumps(settings, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Updated {settings_path} with statusLine configuration")
    else:
        settings = {"statusLine": {"type": "command", "command": command}}
        settings_path.write_text(
            json.dumps(settings, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Created {settings_path} with statusLine configuration")

    print()
    print("Done! Restart Claude Code to see the new status line.")


if __name__ == "__main__":
    main()
