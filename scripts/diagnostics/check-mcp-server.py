#!/usr/bin/env python3
"""check-mcp-server.py — Diagnose the llm-externalizer MCP server from the CLI.

Independent of Claude Code. Walks the same prerequisites the launcher.mjs
checks, plus probes the user's active settings.yaml profile and (optionally)
OpenRouter reachability. Returns a markdown-formatted PASS/FAIL table.

Exit codes:
  0 — all checks pass
  1 — one or more required checks failed
  2 — diagnostic could not run (bad invocation, missing CLAUDE_PLUGIN_ROOT)

Usage:
  scripts/diagnostics/check-mcp-server.py            # local mode (uses
                                                     # CLAUDE_PLUGIN_ROOT)
  scripts/diagnostics/check-mcp-server.py --no-net   # skip OpenRouter probe
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


def status(name: str, ok: bool, detail: str = "") -> tuple[str, bool, str]:
    return (name, ok, detail)


def find_plugin_root() -> Path | None:
    """Locate the plugin root. Prefer $CLAUDE_PLUGIN_ROOT; fall back to walking
    parents from this script's directory until we find a `.claude-plugin/`
    sibling."""
    env_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env_root:
        p = Path(env_root)
        if (p / ".claude-plugin" / "plugin.json").is_file():
            return p.resolve()
    here = Path(__file__).resolve().parent
    for parent in [here, *here.parents]:
        if (parent / ".claude-plugin" / "plugin.json").is_file():
            return parent
    return None


def check_plugin_root(root: Path | None) -> tuple[str, bool, str]:
    if root is None:
        return status("plugin root resolves", False,
                      "CLAUDE_PLUGIN_ROOT unset and no parent dir contains "
                      ".claude-plugin/plugin.json")
    return status("plugin root resolves", True, str(root))


def check_node_present() -> tuple[str, bool, str]:
    node = shutil.which("node")
    if not node:
        return status("node on PATH", False, "node not found")
    try:
        out = subprocess.run([node, "--version"], capture_output=True,
                             text=True, timeout=5, check=False)
    except (subprocess.SubprocessError, OSError) as e:
        return status("node on PATH", False, f"node --version failed: {e}")
    version = out.stdout.strip() or out.stderr.strip()
    # Reject < 20 (the plugin manifest pins >=20).
    if version.startswith("v"):
        try:
            major = int(version.lstrip("v").split(".", 1)[0])
            if major < 20:
                return status("node >= 20", False, f"got {version}; plugin requires >=20")
        except ValueError:
            pass
    return status("node >= 20", True, version)


def check_better_sqlite3(root: Path) -> tuple[str, bool, str]:
    """Verify better-sqlite3 can be imported from the MCP server's resolved
    node_modules. Equivalent to the launcher's pre-flight check."""
    mcp_server = root / "mcp-server"
    if not mcp_server.is_dir():
        return status("better-sqlite3 resolves", False, "mcp-server/ missing")
    probe_js = mcp_server / "launcher.mjs"
    if not probe_js.is_file():
        return status("better-sqlite3 resolves", False, "launcher.mjs missing")
    try:
        out = subprocess.run(
            ["node", "-e",
             f"require('node:module').createRequire('{mcp_server}/').resolve('better-sqlite3')"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (subprocess.SubprocessError, OSError) as e:
        return status("better-sqlite3 resolves", False, str(e))
    if out.returncode == 0:
        return status("better-sqlite3 resolves", True,
                      "via mcp-server/node_modules")
    return status("better-sqlite3 resolves", False,
                  out.stderr.strip().splitlines()[-1] if out.stderr else "unknown")


def check_settings_yaml() -> tuple[str, bool, str]:
    """Verify ~/.llm-externalizer/settings.yaml exists and parses as YAML.

    We DO NOT inspect the active profile's secrets — only structural validity.
    """
    path = Path.home() / ".llm-externalizer" / "settings.yaml"
    if not path.is_file():
        return status("~/.llm-externalizer/settings.yaml exists", False,
                      f"{path} not found — run /llm-externalizer-setup")
    # Try parsing without depending on PyYAML being installed.
    try:
        import yaml  # type: ignore
    except ImportError:
        # Best-effort line-based sanity check.
        text = path.read_text(encoding="utf-8", errors="replace")
        if "profiles:" not in text or "active:" not in text:
            return status("settings.yaml structurally valid", False,
                          "missing `profiles:` or `active:` key")
        return status("settings.yaml structurally valid", True,
                      "skipped YAML parse (pyyaml not installed)")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        return status("settings.yaml structurally valid", False, str(e))
    if not isinstance(data, dict):
        return status("settings.yaml structurally valid", False,
                      "top-level is not a mapping")
    active = data.get("active")
    profiles = data.get("profiles") or {}
    if not isinstance(active, str) or active not in profiles:
        return status("settings.yaml structurally valid", False,
                      f"active='{active}' not found in profiles {list(profiles)}")
    return status("settings.yaml structurally valid", True,
                  f"active={active}, {len(profiles)} profile(s)")


def check_openrouter() -> tuple[str, bool, str]:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        return status("OpenRouter reachable", True,
                      "skipped — OPENROUTER_API_KEY not set")
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/models",
            headers={"Authorization": f"Bearer {key}",
                     "User-Agent": "llm-externalizer-diagnostic/1"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = 200 <= resp.status < 300
            return status("OpenRouter reachable", ok,
                          f"HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        return status("OpenRouter reachable", False, f"HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return status("OpenRouter reachable", False, f"{type(e).__name__}: {e}")


def format_table(rows: list[tuple[str, bool, str]]) -> str:
    lines = ["| Check | Status | Detail |", "|---|---|---|"]
    for name, ok, detail in rows:
        mark = "PASS" if ok else "FAIL"
        # Truncate long detail for table readability.
        d = detail if len(detail) <= 60 else detail[:57] + "..."
        lines.append(f"| {name} | {mark} | {d} |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose the llm-externalizer MCP server.")
    parser.add_argument("--no-net", action="store_true",
                        help="Skip the OpenRouter reachability probe.")
    args = parser.parse_args()

    rows: list[tuple[str, bool, str]] = []
    root = find_plugin_root()
    rows.append(check_plugin_root(root))
    rows.append(check_node_present())
    if root is not None:
        rows.append(check_better_sqlite3(root))
    rows.append(check_settings_yaml())
    if not args.no_net:
        rows.append(check_openrouter())

    print(format_table(rows))
    all_ok = all(ok for _, ok, _ in rows)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
