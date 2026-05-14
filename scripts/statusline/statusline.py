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
    """Return (branch_name, has_changes). Empty branch = not a git repo.

    Per audit SR-P1-005 / SC-P1-005: this runs every 3 s refresh, so we
    keep timeouts TIGHT (1 s each instead of the previous 3 s × 3 = up
    to 9 s worst case). On slow filesystems / SSHFS / WSL2 Windows-network
    mounts the bar would otherwise visibly stutter and lock CPU. With
    1 s × 3 the worst-case stall is 3 s — still bounded by the refresh
    cadence itself, so the user sees at most one slow frame.
    """
    GIT_TIMEOUT = 1.0
    try:
        branch = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
        )
        if branch.returncode != 0:
            return "", False
        branch_name = branch.stdout.strip()
        # Use `git status --porcelain=v1` (one call) instead of `git diff
        # --quiet` + `git ls-files --others` — half the subprocess overhead,
        # AND honours submodule .gitignore correctly (audit SR-P1-013 /
        # SC-P1-013: ls-files --others ignored submodule .gitignore, so
        # the bar showed `branch*` when `git status` showed nothing dirty).
        status = subprocess.run(
            ["git", "-C", cwd, "status", "--porcelain=v1"],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
        )
        has_changes = bool(status.stdout.strip())
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
            # 0o600 restrict mode — the response is derived from the
            # user's OAuth bearer token and includes rate-limit /
            # subscription-tier info that should not be world-readable
            # on multi-tenant Linux hosts. The parent /tmp/claude dir is
            # 0o700 but Path.write_text uses the process umask (typically
            # 0o022 -> 0644), so we tighten explicitly.
            try:
                cache_file.chmod(0o600)
            except OSError:
                pass
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
                    try:
                        cache_file.chmod(0o600)  # see Authorization-token
                                                 # cache rationale above.
                    except OSError:
                        pass
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


def _format_12h_ampm(local_dt: datetime) -> str:
    """Format the hour/minute + am/pm portion of a datetime without relying
    on the C library's %p, which is locale-dependent and emits the empty
    string under e.g. German `de_DE.UTF-8`. v9.9.0 audit T2.25.
    """
    hour24 = local_dt.hour
    hour12 = hour24 % 12
    if hour12 == 0:
        hour12 = 12
    suffix = "am" if hour24 < 12 else "pm"
    return f"{hour12}:{local_dt.minute:02d}{suffix}"


def iso_to_local(iso_val: Any, style: str = "time") -> str:
    """Convert ISO 8601 string OR Unix-epoch int/float to compact local time string.

    CC v2.1.138 changed rate_limits.{five_hour,seven_day}.resets_at from an ISO
    string to a Unix-epoch integer. Accept both shapes.
    """
    if iso_val is None or iso_val == "" or iso_val == "null":
        return ""
    try:
        if isinstance(iso_val, (int, float)):
            dt = datetime.fromtimestamp(float(iso_val))
            local_dt = dt.astimezone()
        else:
            # Parse ISO 8601 (handles Z, +00:00, fractional seconds)
            dt = datetime.fromisoformat(str(iso_val).replace("Z", "+00:00"))
            local_dt = dt.astimezone()
        # _format_12h_ampm is locale-independent; the month-name portion
        # (%b) and the day portion (%-d) use strftime. %b is locale-aware
        # too but every Latin-script locale ships a 3-char abbreviation,
        # so this is acceptable — it's am/pm that fails empty on de_DE.
        ampm = _format_12h_ampm(local_dt)
        if style == "time":
            return ampm
        elif style == "datetime":
            return local_dt.strftime(_strftime_nopad("%b %-d, ")).lower() + ampm
        else:
            return local_dt.strftime(_strftime_nopad("%b %-d")).lower()
    except (ValueError, OSError):
        return ""


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[mGKH]|\x1b\][^\x07]*\x07")


def _visible_width(s: str) -> int:
    """Approximate visible terminal width of an ANSI-colored string.

    Strips CSI/OSC sequences, then counts most emoji as width 2 (the convention
    for monospace terminals). Good enough for choosing between one-line and
    two-line statusline layouts.
    """
    stripped = _ANSI_RE.sub("", s)
    width = 0
    for ch in stripped:
        cp = ord(ch)
        # Common emoji ranges: misc symbols + dingbats (U+2600-27BF) and the
        # supplementary symbols/pictographs blocks (U+1F300+).
        if 0x2600 <= cp <= 0x27BF or cp >= 0x1F000:
            width += 2
        elif cp == 0xFE0F:
            # Variation selector-16 ("emoji style") — already counted as part
            # of the preceding code point; skip.
            continue
        else:
            width += 1
    return width


def _log_exception(label: str, exc: BaseException) -> None:
    """Append a labelled traceback to /tmp/claude/statusline-error.log.

    Per-section guard: when an upstream schema change or transient failure
    breaks a single section, we record it for diagnosis and continue
    rendering the rest of the bar. Logging itself must never raise.

    v9.9.0 audit T2.21: secondary errors (ENOSPC, /tmp read-only on a
    sandboxed container, hardened-write hook denying append) are now
    surfaced once via stderr instead of being swallowed silently. Claude
    Code merges statusline stderr into its main error log, so the user
    has a path to discover that logging itself is broken.
    """
    import traceback
    try:
        log_path = Path("/tmp/claude/statusline-error.log")
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a") as f:
            f.write(f"\n=== {datetime.now().isoformat()} [{label}] ===\n")
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=f)
    except OSError as log_err:
        # Disk full, perms revoked, mount switched read-only — emit a
        # one-line breadcrumb to stderr so the failure is visible. We
        # use a module-level dedup set so repeated failures during a
        # single render don't flood stderr.
        global _LOG_EXCEPTION_WARN_SEEN
        if log_err.errno not in _LOG_EXCEPTION_WARN_SEEN:
            _LOG_EXCEPTION_WARN_SEEN.add(log_err.errno)
            sys.stderr.write(
                f"[llm-externalizer statusline] cannot write error log "
                f"(errno {log_err.errno}: {log_err.strerror}); "
                f"primary error was [{label}]: {type(exc).__name__}\n"
            )
    except Exception:
        # Truly unexpected — we have nothing useful to say without
        # risking another raise during the breadcrumb, so swallow.
        pass


_LOG_EXCEPTION_WARN_SEEN: set[int | None] = set()


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

    # ── Extract data (spec: code.claude.com/docs/en/statusline.md) ──
    model_name = safe_jq(data, "model", "display_name", default="Claude")
    # Compact display: "Opus 4.7 (1M context)" → "Opus 4.7 (1M)"
    # Same for "(200K context)" → "(200K)". Saves ~8 chars in the header.
    model_name = re.sub(r"\s+context\)", ")", str(model_name))
    size = safe_jq(data, "context_window", "context_window_size", default=200000)
    if not size:
        size = 200000

    # Spec: prefer pre-calculated total_input_tokens (v2.1.132+) and used_percentage
    # over manual computation; fall back to current_usage sum when null (before
    # first API response, or right after /compact).
    total_input = safe_jq(data, "context_window", "total_input_tokens")
    if total_input is None:
        input_tokens = safe_jq(data, "context_window", "current_usage", "input_tokens", default=0) or 0
        cache_create = safe_jq(data, "context_window", "current_usage", "cache_creation_input_tokens", default=0) or 0
        cache_read = safe_jq(data, "context_window", "current_usage", "cache_read_input_tokens", default=0) or 0
        current = int(input_tokens) + int(cache_create) + int(cache_read)
    else:
        current = int(total_input)

    pct_pre = safe_jq(data, "context_window", "used_percentage")
    if pct_pre is not None:
        try:
            pct_used = int(float(pct_pre))
        except (TypeError, ValueError):
            pct_used = current * 100 // size if size > 0 else 0
    else:
        pct_used = current * 100 // size if size > 0 else 0

    claude_version = get_claude_version()
    sep = f" {DIM}|{RESET} "

    # ── Build output ──
    out = f"🤖 {BLUE}{model_name}{RESET}"
    if claude_version:
        out += f" {DIM}v{claude_version}{RESET}"

    # Effort level (low/medium/high/xhigh/max). Absent when model doesn't support it.
    try:
        effort = safe_jq(data, "effort", "level")
        if effort:
            out += f" {DIM}·{RESET}{YELLOW}{effort}{RESET}"
    except Exception as e:
        _log_exception("effort", e)

    # Extended thinking indicator (v2.1.x). Boolean field; render only when true.
    try:
        if safe_jq(data, "thinking", "enabled"):
            out += " 🧠"
    except Exception as e:
        _log_exception("thinking", e)

    # Current working directory + git info (spec: workspace.current_dir is
    # preferred over cwd because it's the same value but consistent with
    # workspace.project_dir). Worktree is flagged via workspace.git_worktree
    # (populated for any git worktree, unlike worktree.* which is --worktree only).
    try:
        cwd = safe_jq(data, "workspace", "current_dir") or safe_jq(data, "cwd", default="")
        if cwd:
            cwd_normalized = str(cwd).replace("\\", "/")
            display_dir = cwd_normalized.rstrip("/").rsplit("/", 1)[-1] or cwd_normalized
            section = f"{sep}📁 {CYAN}{display_dir}{RESET}"
            wt = safe_jq(data, "workspace", "git_worktree") or safe_jq(data, "worktree", "name")
            if wt:
                section += f" {DIM}🌳{wt}{RESET}"
            branch, has_changes = get_git_info(cwd_normalized)
            if branch:
                section += f"{DIM}@{RESET}🌿 {GREEN}{branch}{RESET}"
                if has_changes:
                    section += f"{RED}*{RESET}"
            out += section
    except Exception as e:
        _log_exception("cwd-git", e)

    # Context usage bar
    try:
        ctx_bar = build_bar(pct_used, 8)
        out += f"{sep}📊 {ORANGE}{format_tokens(current)}/{format_tokens(size)}{RESET} {ctx_bar} {CYAN}{pct_used}%{RESET}"
    except Exception as e:
        _log_exception("context-bar", e)

    try:
        cache_dir = ensure_cache_dir()
    except Exception:
        # Cache dir unavailable (symlink attack guard, wrong owner, etc.) — skip optional sections
        print(out, end="")
        return

    # Track optional segments so tier-3 narrow split can drop them by
    # string-replace without re-running their (potentially slow) fetches.
    mcp_seg = ""
    or_seg = ""

    # ── LLM Externalizer MCP stats ──
    try:
        mcp_stats_file = cache_dir / "llm-externalizer-stats.json"
        mcp_data = read_json_file(mcp_stats_file)
        if mcp_data and isinstance(mcp_data, dict):
            mcp_tokens = mcp_data.get("total_tokens") or 0
            mcp_cost = mcp_data.get("total_cost") or 0
            mcp_seg = f"{sep}🔌 {WHITE}{format_tokens(mcp_tokens)}{RESET} 💰 {GREEN}${float(mcp_cost):.4f}{RESET}"
            out += mcp_seg
    except Exception as e:
        _log_exception("mcp-stats", e)

    # ── OpenRouter budget ──
    try:
        or_remain = fetch_openrouter_budget(cache_dir)
        if or_remain is not None:
            or_seg = f"{sep}🏦 {CYAN}${float(or_remain):.2f}{RESET}"
            out += or_seg
    except Exception as e:
        _log_exception("openrouter-budget", e)

    # ── Usage limits: prefer rate_limits from input JSON (v2.1.80+) ──
    try:
        usage_data = safe_jq(data, "rate_limits")
        if not usage_data:
            usage_data = fetch_usage_from_api(cache_dir, claude_version)
    except Exception as e:
        _log_exception("usage-fetch", e)
        usage_data = None

    if usage_data and isinstance(usage_data, dict):
        bar_width = 6

        def _pct_field(window: dict[str, Any]) -> int:
            """Read percentage from spec field `used_percentage`, fall back to
            `utilization` (legacy CC API). Both are 0-100 floats per spec.
            """
            raw = window.get("used_percentage")
            if raw is None:
                raw = window.get("utilization", 0)
            try:
                return int(float(raw or 0))
            except (TypeError, ValueError):
                return 0

        # 5-hour
        try:
            five = safe_jq(usage_data, "five_hour") or {}
            five_pct = _pct_field(five) if isinstance(five, dict) else 0
            five_reset = iso_to_local(five.get("resets_at") if isinstance(five, dict) else "", "time")
            section = f"{sep}⏱️ {WHITE}5h{RESET} {build_bar(five_pct, bar_width)} {CYAN}{five_pct}%{RESET}"
            if five_reset:
                section += f" {DIM}@{five_reset}{RESET}"
            out += section
        except Exception as e:
            _log_exception("rate-limit-5h", e)

        # 7-day
        try:
            seven = safe_jq(usage_data, "seven_day") or {}
            seven_pct = _pct_field(seven) if isinstance(seven, dict) else 0
            seven_reset = iso_to_local(seven.get("resets_at") if isinstance(seven, dict) else "", "datetime")
            section = f"{sep}📅 {WHITE}7d{RESET} {build_bar(seven_pct, bar_width)} {CYAN}{seven_pct}%{RESET}"
            if seven_reset:
                section += f" {DIM}@{seven_reset}{RESET}"
            out += section
        except Exception as e:
            _log_exception("rate-limit-7d", e)

        # Extra usage
        try:
            extra_enabled = safe_jq(usage_data, "extra_usage", "is_enabled", default=False)
            if extra_enabled:
                extra_pct = int(safe_jq(usage_data, "extra_usage", "utilization", default=0) or 0)
                extra_used = float(safe_jq(usage_data, "extra_usage", "used_credits", default=0) or 0) / 100
                extra_limit = float(safe_jq(usage_data, "extra_usage", "monthly_limit", default=0) or 0) / 100
                out += f"{sep}💰 {WHITE}extra{RESET} {build_bar(extra_pct, bar_width)} {CYAN}${extra_used:.2f}/${extra_limit:.2f}{RESET}"
        except Exception as e:
            _log_exception("extra-usage", e)

    # ── Width-aware tiered layout ──
    # Tier 1 (≥ width):        single line — full bar
    # Tier 2 (95 ≤ w < width): split at 📊 — header on line 1, bars on line 2
    # Tier 3 (65 ≤ w < 95):    3 lines: header / 📊+🔌+🏦 / ⏱️+📅 (full @resets)
    # Tier 4 (w < 65):         6 lines, one section per row (mobile/very narrow)
    #
    # Width detection precedence (CC pipes JSON via stdin so isatty() is false):
    #   1. STATUSLINE_COLS env var (manual override)
    #   2. /dev/tty terminal size (works even when stdin is a pipe — most reliable)
    #   3. $COLUMNS env var (shell-exported; rarely set on macOS zsh by default)
    #   4. fallback = 999 (assume wide; let CC's own truncation handle narrow)
    try:
        cols = 0
        # 1) Explicit override
        try:
            cols = int(os.environ.get("STATUSLINE_COLS", "0") or "0")
        except (TypeError, ValueError):
            cols = 0
        # 2) /dev/tty — bypasses the stdin-pipe limitation.
        # Per-refresh latency budget: opening /dev/tty on detached / orphaned /
        # nohup'd sessions can stall 3-5 s while the kernel walks the IPC
        # chain (audit SR-P1-005 + SC-P1-005). To keep the statusline snappy
        # we short-circuit when:
        #   (a) $TTY env var is unset AND
        #   (b) sys.stdin.isatty() is False AND
        #   (c) /dev/tty doesn't exist as a regular path
        # Any of (a)+(b)+(c) being false still permits the open, but the
        # combined-false case is exactly "no controlling terminal" — the
        # open would block on most modern Unixes regardless.
        if cols <= 0:
            try_tty = True
            try:
                if not os.environ.get("TTY") and not sys.stdin.isatty() and not os.path.exists("/dev/tty"):
                    try_tty = False
            except OSError:
                try_tty = False
            if try_tty:
                try:
                    # `O_NONBLOCK` lets the open fail fast on hung devices
                    # without waiting for the kernel timeout. Path.open() does
                    # not expose flags; use os.open() and wrap in os.fdopen.
                    fd = os.open("/dev/tty", os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
                    try:
                        cols = os.get_terminal_size(fd).columns
                    finally:
                        os.close(fd)
                except Exception:
                    pass
        # 3) Shell-exported COLUMNS
        if cols <= 0:
            try:
                cols = int(os.environ.get("COLUMNS", "0") or "0")
            except (TypeError, ValueError):
                cols = 0
        # 4) Last resort
        if cols <= 0:
            cols = 999

        split_marker = f"{sep}📊"
        visible = _visible_width(out)

        tier_chosen = 1
        if visible > cols and split_marker in out:
            if cols < 65:
                # Tier 4: mobile / very narrow. Split at every section marker
                # so each gets its own row. Nothing dropped, nothing compacted.
                # MCP+OpenRouter share a row (combined ~27 chars at typical
                # values, fits 40-col phones). Same for the rate-limit @resets.
                tier_chosen = 4
                markers = [
                    f"{sep}📁",  # cwd + git/worktree
                    f"{sep}📊",  # token bar
                    f"{sep}🔌",  # MCP (with 🏦 OpenRouter staying on same row)
                    f"{sep}⏱️",  # 5-hour rate limit
                    f"{sep}📅",  # 7-day rate limit
                ]
                segments: list[str] = []
                rest_t4 = out
                for marker in markers:
                    if marker in rest_t4:
                        pre, after = rest_t4.split(marker, 1)
                        segments.append(pre)
                        # Restore the leading emoji (drop the sep prefix) so
                        # each row starts cleanly with its own section emoji.
                        emoji = marker[len(sep):]
                        rest_t4 = emoji + after
                segments.append(rest_t4)
                for seg in segments[:-1]:
                    print(seg)
                print(segments[-1], end="")
            else:
                head, rest = out.split(split_marker, 1)
                rl_marker = f"{sep}⏱️"
                if cols < 95 and rl_marker in rest:
                    # Tier 3: 3 lines.
                    #   Line 1: header (model + version + effort + thinking + dir)
                    #   Line 2: 📊 token bar + 🔌 MCP + 🏦 OpenRouter
                    #   Line 3: ⏱️ 5h (full @reset) + 📅 7d (full @reset)
                    tier_chosen = 3
                    middle, tail = rest.split(rl_marker, 1)
                    print(head)
                    print(f"📊{middle}")
                    print(f"⏱️{tail}", end="")
                else:
                    # Tier 2: 2 lines. Header on line 1, everything else on line 2.
                    tier_chosen = 2
                    print(head)
                    print(f"📊{rest}", end="")

            try:
                dbg = Path("/tmp/claude/statusline-debug.log")
                dbg.parent.mkdir(parents=True, exist_ok=True)
                with dbg.open("a") as f:
                    f.write(f"{datetime.now().isoformat()} cols={cols} width={visible} tier={tier_chosen}\n")
            except Exception:
                pass
            return

        # Single-line path (tier 1).
        try:
            dbg = Path("/tmp/claude/statusline-debug.log")
            dbg.parent.mkdir(parents=True, exist_ok=True)
            with dbg.open("a") as f:
                f.write(f"{datetime.now().isoformat()} cols={cols} width={visible} tier={tier_chosen}\n")
        except Exception:
            pass
    except Exception as e:
        _log_exception("width-split", e)

    print(out, end="")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        _log_exception("main", e)
        print("Claude", end="")
