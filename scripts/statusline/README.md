# Multi-tier Claude Code statusline

Single-file Python statusline with width-aware tiering, per-section error
isolation, and full v2.1.138 spec coverage. No external dependencies — pure
stdlib.

## Install

```bash
./install.sh
```

Copies `statusline.py` to `~/.claude/statusline.py` and patches
`~/.claude/settings.json::statusLine` to invoke it with `refreshInterval: 3`
(so resize → tier-reselect within 3 seconds).

Existing files are backed up with `.bak.<YYYYMMDD_HHMMSS±HHMM>` suffixes.
Re-running is idempotent.

Override the refresh cadence:

```bash
REFRESH_INTERVAL=5 ./install.sh
```

After install, exit and relaunch Claude Code once if the new bar doesn't
appear immediately — settings changes can require a session restart to
register.

## What it shows

| Section | Source | Notes |
|---|---|---|
| 🤖 model | `model.display_name` | "Opus 4.7 (1M context)" → "Opus 4.7 (1M)" |
| `v2.1.138` | `claude --version` | cached 1h on disk |
| `·max` | `effort.level` | only when model supports the param |
| 🧠 | `thinking.enabled` | only when extended thinking on |
| 📁 dir | `workspace.current_dir` (preferred) → `cwd` | basename only |
| 🌳 worktree | `workspace.git_worktree` → `worktree.name` | only inside a worktree |
| 🌿 branch | `git branch --show-current` | red `*` if dirty |
| 📊 token bar | `context_window.used_percentage` (preferred) → manual sum | `current/size %` + 8-char bar |
| 🔌 MCP | `~/.cache/claude/llm-externalizer-stats.json` | tokens + cost |
| 🏦 OpenRouter | OpenRouter `/credits` API | cached 5min |
| ⏱️ 5h | `rate_limits.five_hour.used_percentage` (spec) → `utilization` (legacy) | bar + % + reset time |
| 📅 7d | `rate_limits.seven_day.used_percentage` (spec) → `utilization` (legacy) | bar + % + reset date+time |
| 💰 extra | `rate_limits.extra_usage` (when enabled) | bar + $used/$limit |

## Width tiering

| Tier | Range | Lines | Layout |
|---|---|---|---|
| 1 | ≥ 184 cols | 1 | full single line |
| 2 | 95–183 cols | 2 | header / everything else |
| 3 | 65–94 cols | 3 | header / 📊+🔌+🏦 / ⏱️+📅 (full @resets) |
| 4 | < 65 cols | 6 | model / dir / 📊 / 🔌+🏦 / ⏱️ 5h / 📅 7d |

**Nothing dropped, nothing compacted** at any tier — just split across more
rows. Floor of usable width is ~33 cols (the model header line).

Width detection precedence:

1. `STATUSLINE_COLS` env var (manual override — useful for forcing one-line)
2. `/dev/tty` terminal size (works even when stdin is a pipe)
3. `$COLUMNS` env var (rarely set on macOS zsh by default)
4. Fallback `999` (assume wide; let CC's own truncation handle narrow)

## Resilience

- **Per-section error isolation**: every optional section (cwd-git, ctx bar,
  MCP, OpenRouter, 5h, 7d, extra) is wrapped in its own `try/except` and
  builds into a local string before committing to the bar — a partial
  mutation can never leave a dangling separator.
- **Top-level guard**: prints `"Claude"` if even the model header throws,
  so the bar can never be fully blank.
- **Error log**: `/tmp/claude/statusline-error.log` — labelled tracebacks
  per failure (per-section + main).
- **Debug log**: `/tmp/claude/statusline-debug.log` — one line per
  invocation showing detected `cols`, visible `width`, and `tier` chosen.
  Useful when diagnosing why a particular layout was picked.
- **Type-tolerant ISO/epoch parsing**: `iso_to_local()` accepts both ISO
  string and Unix-epoch int/float for `resets_at` (CC switched between
  them in v2.1.x).
- **Spec field-name fallbacks**: `used_percentage` → `utilization`,
  `total_input_tokens` → manual `current_usage` sum, etc.

## Manual tweaks

Edit `~/.claude/statusline.py` directly. Changes take effect on the next
`refreshInterval` tick (3s default). The cache files
(`/tmp/claude/openrouter-budget-cache.json`, `statusline-usage-cache.json`)
will rebuild automatically.

## Uninstall

Manually delete `~/.claude/statusline.py` and remove the `statusLine`
block from `~/.claude/settings.json`. The installer leaves backups
(`.bak.<timestamp>`) you can restore from if needed.
