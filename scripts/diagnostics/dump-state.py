#!/usr/bin/env python3
"""dump-state.py — Collect non-secret llm-externalizer state for bug reports.

Output is a single Markdown report on stdout (no tarball — easier to paste
into GitHub issues). Every value is run through a redaction pass that
matches the plugin's own SECRET_PATTERNS (kept in sync via a comment block;
this script intentionally re-implements a smaller subset rather than
depending on the MCP server's TypeScript regexes).

Usage:
  scripts/diagnostics/dump-state.py           # stdout
  scripts/diagnostics/dump-state.py --out reports/state.md
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

# Redaction patterns. Mirror the MCP server's SECRET_PATTERNS approximately
# (full sync is too brittle — these cover the same OAuth / vendor key shapes
# plus the wildcard *_KEY / *_TOKEN / *_SECRET / *_PASSWORD pattern that
# v9.9.0 added).
_REDACTION_PATTERNS = [
    # API-key-shaped tokens
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"hf_[A-Za-z0-9]{16,}"),
    re.compile(r"sk-or-v1-[A-Za-z0-9_\-]{16,}"),
    # Generic Bearer <token>
    re.compile(r"Bearer\s+[A-Za-z0-9_\-]{8,}"),
    # ENV name = value (mirror of SECRET_PATTERNS in mcp-server/src/index.ts)
    re.compile(
        r"(?im)^\s*((?:[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|"
        r"_APIKEY|_API_KEY|_AUTH)|PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|"
        r"AUTH|AUTH_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|SECRET_KEY|ACCESS_KEY|"
        r"DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|"
        r"HF_TOKEN|LM_API_TOKEN|VLLM_API_KEY|JWT_SECRET))(\s*[=:]\s*['\"]?)"
        r"[^\s'\"#\n]{4,}"
    ),
]


def redact(text: str) -> tuple[str, int]:
    count = 0
    out = text
    for pat in _REDACTION_PATTERNS:
        if pat.groups >= 2:
            new, n = pat.subn(r"\1\2[REDACTED]", out)
        else:
            new, n = pat.subn("[REDACTED]", out)
        out = new
        count += n
    return out, count


def section(title: str) -> str:
    return f"\n## {title}\n"


def cmd_output(args: list[str], timeout: float = 5.0) -> str:
    try:
        result = subprocess.run(args, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except (FileNotFoundError, subprocess.SubprocessError) as e:
        return f"(error: {e})"
    out = result.stdout.strip() or result.stderr.strip()
    return out or "(empty)"


def collect() -> str:
    lines: list[str] = ["# llm-externalizer state dump"]
    lines.append("")
    lines.append(f"Generated: {subprocess.run(['date', '+%Y-%m-%dT%H:%M:%S%z'], capture_output=True, text=True, timeout=5).stdout.strip()}")

    lines.append(section("Platform"))
    lines.append(f"- OS: {platform.system()} {platform.release()}")
    lines.append(f"- Arch: {platform.machine()}")
    lines.append(f"- Python: {sys.version.splitlines()[0]}")
    lines.append(f"- Node: {cmd_output(['node', '--version'])}")
    lines.append(f"- npm:  {cmd_output(['npm', '--version'])}")
    lines.append(f"- Locale: {os.environ.get('LANG', 'unset')}")

    lines.append(section("Plugin paths"))
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT", "(unset)")
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA", "(unset)")
    lines.append(f"- CLAUDE_PLUGIN_ROOT: {plugin_root}")
    lines.append(f"- CLAUDE_PLUGIN_DATA: {plugin_data}")

    if plugin_root not in ("(unset)", ""):
        manifest = Path(plugin_root) / ".claude-plugin" / "plugin.json"
        if manifest.is_file():
            try:
                m = json.loads(manifest.read_text(encoding="utf-8"))
                lines.append(f"- plugin.json version: {m.get('version', '?')}")
                lines.append(f"- plugin.json name:    {m.get('name', '?')}")
            except json.JSONDecodeError:
                lines.append("- plugin.json: PARSE ERROR")

    lines.append(section("MCP server"))
    lines.append(f"- Last git commit: {cmd_output(['git', '-C', plugin_root, 'log', '-1', '--format=%H %s'])}" if plugin_root not in ("(unset)", "") else "- (plugin root unset)")

    lines.append(section("Active profile (settings.yaml)"))
    settings = Path.home() / ".llm-externalizer" / "settings.yaml"
    if settings.is_file():
        try:
            text = settings.read_text(encoding="utf-8")
            redacted, n = redact(text)
            lines.append("```yaml")
            lines.append(redacted.rstrip())
            lines.append("```")
            lines.append(f"(redacted {n} secret-shaped substring(s))")
        except OSError as e:
            lines.append(f"(read error: {e})")
    else:
        lines.append(f"(no settings.yaml at {settings})")

    lines.append(section("~/.claude/settings.json (statusLine block only)"))
    cc_settings = Path.home() / ".claude" / "settings.json"
    if cc_settings.is_file():
        try:
            data = json.loads(cc_settings.read_text(encoding="utf-8"))
            sl = data.get("statusLine", {})
            lines.append("```json")
            lines.append(json.dumps(sl, indent=2))
            lines.append("```")
        except json.JSONDecodeError as e:
            lines.append(f"(parse error: {e})")
    else:
        lines.append(f"(no settings.json at {cc_settings})")

    lines.append(section("Recent errors (statusline log)"))
    err_log = Path("/tmp/claude/statusline-error.log")
    if err_log.is_file():
        try:
            tail = err_log.read_text(encoding="utf-8", errors="replace").splitlines()[-20:]
            redacted_tail = "\n".join(tail)
            redacted_tail, _ = redact(redacted_tail)
            lines.append("```")
            lines.append(redacted_tail)
            lines.append("```")
        except OSError as e:
            lines.append(f"(read error: {e})")
    else:
        lines.append("(no error log)")

    lines.append("\n---\n*All output above passed through the diagnostic's redaction pass. Audit the file before sharing.*\n")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect non-secret state for bug reports.")
    parser.add_argument("--out", type=Path,
                        help="Write to this path instead of stdout.")
    args = parser.parse_args()

    body = collect()
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(body, encoding="utf-8")
        print(f"state dump written to {args.out}")
    else:
        print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
