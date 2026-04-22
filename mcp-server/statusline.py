#!/usr/bin/env python3
"""Claude Code statusline: Model | tokens | %used | cwd | MCP stats | usage limits.

Reads JSON from stdin (piped by Claude Code), outputs a single ANSI-colored line.
No external dependencies — uses only Python stdlib.
"""

import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

# ── ANSI colors matching oh-my-posh theme ──
BLUE = "\033[38;2;0;153;255m"
ORANGE = "\033[38;2;255;176;85m"
GREEN = "\033[38;2;0;160;0m"
CYAN = "\033[38;2;46;149;153m"
RED = "\033[38;2;255;85;85m"
YELLOW = "\033[38;2;230;200;0m"
WHITE = "\033[38;2;220;220;220m"
DIM = "\033[2m"
RESET = "\033[0m"

# Dim bar colors by usage level
BAR_COLORS = {
    90: (RED, "\033[38;2;235;180;180m"),
    70: (YELLOW, "\033[38;2;230;225;180m"),
    50: (ORANGE, "\033[38;2;235;215;185m"),
    0: (GREEN, "\033[38;2;180;225;180m"),
}


def format_tokens(num: int) -> str:
    if num >= 1_000_000:
        return f"{num / 1_000_000:.1f}m"
    if num >= 1_000:
        return f"{num / 1_000:.0f}k"
    return str(num)


def build_bar(pct: int, width: int) -> str:
    pct = max(0, min(100, pct))
    filled = pct * width // 100
    empty = width - filled
    # Pick color based on usage level
    bar_color, bar_dim = BAR_COLORS[0]
    for threshold in sorted(BAR_COLORS.keys(), reverse=True):
        if pct >= threshold:
            bar_color, bar_dim = BAR_COLORS[threshold]
            break
    return f"{bar_color}{'█' * filled}{bar_dim}{'░' * empty}{RESET}"


def safe_jq(data: dict, *keys: str, default: Any = None) -> Any:
    """Navigate nested dict safely, like jq's .a.b.c // default."""
    val: Any = data
    for k in keys:
        if isinstance(val, dict):
            val = val.get(k)
        else:
            return default
    return val if val is not None else default


def get_claude_version() -> str:
    try:
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            # Extract version number from output
            m = re.search(r"[\d.]+", result.stdout.strip())
            return m.group(0) if m else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


def get_git_info(cwd: str) -> tuple[str, bool]:
    """Return (branch_name, has_changes). Empty branch = not a git repo."""
    try:
        branch = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if branch.returncode != 0:
            return "", False
        branch_name = branch.stdout.strip()
        # Check for changes
        diff = subprocess.run(
            ["git", "-C", cwd, "diff", "--quiet", "HEAD"],
            capture_output=True,
            timeout=3,
        )
        untracked = subprocess.run(
            ["git", "-C", cwd, "ls-files", "--others", "--exclude-standard"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        has_changes = diff.returncode != 0 or bool(untracked.stdout.strip())
        return branch_name, has_changes
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return "", False


def ensure_cache_dir() -> Path:
    """Create and return the cache directory for statusline data."""
    if sys.platform == "win32":
        cache_dir = Path(tempfile.gettempdir()) / "claude"
        cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        return cache_dir

    cache_dir = Path("/tmp/claude")
    # Refuse symlinks: lstat (no follow) before touching the path. A world-writable
    # /tmp means any local user can plant /tmp/claude as a symlink to a victim-owned
    # file/dir and trick us into chmod'ing it. See CWE-59.
    try:
        lst = os.lstat(cache_dir)
    except FileNotFoundError:
        lst = None
    if lst is not None and stat.S_ISLNK(lst.st_mode):
        raise RuntimeError(
            f"Cache directory path {cache_dir} is a symlink; refusing to follow."
        )
    cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Open with O_NOFOLLOW so a symlink swapped in after mkdir still cannot divert
    # the fchmod() to a target the attacker chose.
    fd = os.open(cache_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if st.st_uid != os.getuid():
            raise RuntimeError(
                f"Cache directory {cache_dir} is owned by uid {st.st_uid}, "
                f"not the current user (uid {os.getuid()}). "
                "Refusing to use an untrusted directory."
            )
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)
    return cache_dir


def read_json_file(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def get_oauth_token() -> str:
    """Cross-platform OAuth token resolution."""
    # 1. Explicit env var override
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    if token:
        return token

    # 2. macOS Keychain
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            blob = json.loads(result.stdout.strip())
            token = blob.get("claudeAiOauth", {}).get("accessToken", "")
            if token:
                return token
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass

    # 3. Linux credentials file
    creds_file = Path.home() / ".claude" / ".credentials.json"
    creds = read_json_file(creds_file)
    if creds:
        token = creds.get("claudeAiOauth", {}).get("accessToken", "")
        if token:
            return token

    # 4. GNOME Keyring via secret-tool
    try:
        result = subprocess.run(
            ["secret-tool", "lookup", "service", "Claude Code-credentials"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode == 0 and result.stdout.strip():
            blob = json.loads(result.stdout.strip())
            token = blob.get("claudeAiOauth", {}).get("accessToken", "")
            if token:
                return token
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass

    return ""


def fetch_usage_from_api(cache_dir: Path, claude_version: str) -> dict | None:
    """Fetch usage data from Anthropic API with caching."""
    cache_file = cache_dir / "statusline-usage-cache.json"
    cache_max_age = 300  # 5 minutes

    # Check cache
    if cache_file.is_file():
        try:
            age = time.time() - cache_file.stat().st_mtime
        except OSError:
            age = cache_max_age
        if age < cache_max_age:
            return read_json_file(cache_file)

    # Fetch fresh data
    token = get_oauth_token()
    if not token:
        # Fall back to stale cache
        return read_json_file(cache_file) if cache_file.is_file() else None

    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": f"claude-code/{claude_version or '0.0.0'}",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            cache_file.write_text(json.dumps(data), encoding="utf-8")
            return data
    except Exception:
        # Fall back to stale cache
        return read_json_file(cache_file) if cache_file.is_file() else None


def fetch_openrouter_budget(cache_dir: Path) -> float | None:
    """Fetch remaining OpenRouter budget with 60s cache."""
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    cache_file = cache_dir / "openrouter-budget-cache.json"

    # Check cache
    if cache_file.is_file():
        try:
            age = time.time() - cache_file.stat().st_mtime
        except OSError:
            age = 60
        if age < 60:
            data = read_json_file(cache_file)
            if data and "data" in data:
                total = data["data"].get("total_credits", 0)
                used = data["data"].get("total_usage", 0)
                return total - used

    # Fetch fresh
    if api_key:
        try:
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/credits",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if "data" in data:
                    cache_file.write_text(json.dumps(data), encoding="utf-8")
                    total = data["data"].get("total_credits", 0)
                    used = data["data"].get("total_usage", 0)
                    return total - used
        except Exception:
            pass

    # Fall back to stale cache
    if cache_file.is_file():
        data = read_json_file(cache_file)
        if data and "data" in data:
            total = data["data"].get("total_credits", 0)
            used = data["data"].get("total_usage", 0)
            return total - used

    return None


def _strftime_nopad(fmt: str) -> str:
    """Replace %-X with %#X on Windows (platform-portable no-padding)."""
    if sys.platform == "win32":
        return fmt.replace("%-", "%#")
    return fmt


def iso_to_local(iso_str: str, style: str = "time") -> str:
    """Convert ISO 8601 timestamp to compact local time string."""
    if not iso_str or iso_str == "null":
        return ""
    try:
        # Parse ISO 8601 (handles Z, +00:00, fractional seconds)
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        local_dt = dt.astimezone()
        if style == "time":
            return local_dt.strftime(_strftime_nopad("%-I:%M%p")).lower()
        elif style == "datetime":
            return local_dt.strftime(_strftime_nopad("%b %-d, %-I:%M%p")).lower()
        else:
            return local_dt.strftime(_strftime_nopad("%b %-d")).lower()
    except (ValueError, OSError):
        return ""


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        print("Claude", end="")
        return

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print("Claude", end="")
        return

    # ── Extract data ──
    model_name = safe_jq(data, "model", "display_name", default="Claude")
    size = safe_jq(data, "context_window", "context_window_size", default=200000)
    if not size:
        size = 200000
    input_tokens = safe_jq(data, "context_window", "current_usage", "input_tokens", default=0)
    cache_create = safe_jq(data, "context_window", "current_usage", "cache_creation_input_tokens", default=0)
    cache_read = safe_jq(data, "context_window", "current_usage", "cache_read_input_tokens", default=0)
    current = input_tokens + cache_create + cache_read
    pct_used = current * 100 // size if size > 0 else 0

    claude_version = get_claude_version()
    sep = f" {DIM}|{RESET} "

    # ── Build output ──
    out = f"🤖 {BLUE}{model_name}{RESET}"
    if claude_version:
        out += f" {DIM}v{claude_version}{RESET}"

    # Current working directory
    cwd = safe_jq(data, "cwd", default="")
    if cwd:
        cwd_normalized = cwd.replace("\\", "/")
        display_dir = cwd_normalized.rstrip("/").rsplit("/", 1)[-1] or cwd_normalized
        out += sep
        out += f"📁 {CYAN}{display_dir}{RESET}"
        branch, has_changes = get_git_info(cwd)
        if branch:
            out += f"{DIM}@{RESET}🌿 {GREEN}{branch}{RESET}"
            if has_changes:
                out += f"{RED}*{RESET}"

    # Context usage bar
    ctx_bar = build_bar(pct_used, 8)
    out += sep
    out += f"📊 {ORANGE}{format_tokens(current)}/{format_tokens(size)}{RESET} {ctx_bar} {CYAN}{pct_used}%{RESET}"

    cache_dir = ensure_cache_dir()

    # ── LLM Externalizer MCP stats ──
    mcp_stats_file = cache_dir / "llm-externalizer-stats.json"
    mcp_data = read_json_file(mcp_stats_file)
    if mcp_data:
        mcp_tokens = mcp_data.get("total_tokens") or 0
        mcp_cost = mcp_data.get("total_cost") or 0
        out += sep
        out += f"🔌 {WHITE}{format_tokens(mcp_tokens)}{RESET}"
        out += f" 💰 {GREEN}${mcp_cost:.4f}{RESET}"

    # ── OpenRouter budget ──
    or_remain = fetch_openrouter_budget(cache_dir)
    if or_remain is not None:
        if not mcp_data:
            out += sep
        out += f" 🏦 {CYAN}${or_remain:.2f}{RESET}"

    # ── Usage limits: prefer rate_limits from input JSON (v2.1.80+) ──
    usage_data = safe_jq(data, "rate_limits")
    if not usage_data:
        usage_data = fetch_usage_from_api(cache_dir, claude_version)

    if usage_data and isinstance(usage_data, dict):
        bar_width = 6

        # 5-hour
        five_pct = int(safe_jq(usage_data, "five_hour", "utilization", default=0) or 0)
        five_reset = iso_to_local(safe_jq(usage_data, "five_hour", "resets_at", default=""), "time")
        out += f"{sep}⏱️ {WHITE}5h{RESET} {build_bar(five_pct, bar_width)} {CYAN}{five_pct}%{RESET}"
        if five_reset:
            out += f" {DIM}@{five_reset}{RESET}"

        # 7-day
        seven_pct = int(safe_jq(usage_data, "seven_day", "utilization", default=0) or 0)
        seven_reset = iso_to_local(safe_jq(usage_data, "seven_day", "resets_at", default=""), "datetime")
        out += f"{sep}📅 {WHITE}7d{RESET} {build_bar(seven_pct, bar_width)} {CYAN}{seven_pct}%{RESET}"
        if seven_reset:
            out += f" {DIM}@{seven_reset}{RESET}"

        # Extra usage
        extra_enabled = safe_jq(usage_data, "extra_usage", "is_enabled", default=False)
        if extra_enabled:
            extra_pct = int(safe_jq(usage_data, "extra_usage", "utilization", default=0) or 0)
            extra_used = (safe_jq(usage_data, "extra_usage", "used_credits", default=0) or 0) / 100
            extra_limit = (safe_jq(usage_data, "extra_usage", "monthly_limit", default=0) or 0) / 100
            out += f"{sep}💰 {WHITE}extra{RESET} {build_bar(extra_pct, bar_width)} {CYAN}${extra_used:.2f}/${extra_limit:.2f}{RESET}"

    print(out, end="")


if __name__ == "__main__":
    main()
