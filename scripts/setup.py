#!/usr/bin/env python3
"""Build the LLM Externalizer MCP server. Run after cloning the plugin repository."""

import subprocess
import sys
from pathlib import Path


def main() -> None:
    plugin_root = Path(__file__).resolve().parent.parent
    mcp_dir = plugin_root / "mcp-server"

    if not (mcp_dir / "package.json").is_file():
        print(f"Error: mcp-server/package.json not found at {mcp_dir}", file=sys.stderr)
        sys.exit(1)

    print("Installing dependencies...")
    subprocess.run(["npm", "install", "--ignore-scripts"], cwd=str(mcp_dir), check=True)

    print("Building TypeScript...")
    subprocess.run(["npm", "run", "build"], cwd=str(mcp_dir), check=True)

    print()
    print("LLM Externalizer MCP server built successfully.")
    print(f"Output: {mcp_dir / 'dist'}/")
    print()
    print("The plugin is now ready to use in Claude Code.")


if __name__ == "__main__":
    main()
