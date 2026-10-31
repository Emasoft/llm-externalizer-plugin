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

## Where it keeps its files

The statusline is INDEPENDENT of llm-externalizer: it reads no llm-ext config
(no `$LLM_EXT_CONFIG_DIR`, no `~/.llm-externalizer`) and writes only under its
own folder, `/tmp/claude`, which it creates itself.

This is a deliberate exception to the 2026-09-18 write-roots rule, by USER
instruction of 2026-10-20 ("the statusline script file must be independent from
llm-externalizer. it must use its own folders and create them by its own").
The rule bounds where the llm-ext CLI writes; it does not apply to a standalone
script that is not the CLI. `/tmp/claude` is also where the CLI writes its stats
file, so the 🔌 CLI row below works.

Note: `/tmp` may be cleared by the OS (macOS's periodic reaper, Linux's
`systemd-tmpfiles`, a reboot). The two caches there — the usage snapshot and
the OpenRouter budget — are re-fetched when missing; only the display is
affected, not the underlying accounts.

## What it shows

| Section | Source | Notes |
|---|---|---|
| 🤖 model | `model.display_name` | "Opus 4.8 (1M context)" → "Opus 4.8 (1M)" |
| `v2.1.154` | `claude --version` | cached 1h on disk |
| `·max` | `effort.level` | only when model supports the param |
| 🧠 | `thinking.enabled` | only when extended thinking on |
| 📁 dir | `workspace.current_dir` (preferred) → `cwd` | basename only |
| 🌳 worktree | `workspace.git_worktree` → `worktree.name` | only inside a worktree |
| 🌿 branch | `git branch --show-current` | red `*` if dirty |
| 📊 token bar | `context_window.used_percentage` (preferred) → manual sum | `current/size %` + 8-char bar |
| 🔌 CLI | `/tmp/claude/llm-externalizer-stats.json` | tokens + cost |
| 🏦 OpenRouter | OpenRouter `/credits` API | cached 5min |
| ⏱️ 5h | `rate_limits.five_hour.used_percentage` (spec) → `utilization` (legacy) | bar + % + reset time; row appears when the data carries a 5-hour window. Verified Ultra accounts have none; Pro and Max keep the limit, but the row can briefly disappear right after a reset until the next API response, which does not mean the limit is gone |
| 📅 7d | `rate_limits.seven_day.used_percentage` (spec) → `utilization` (legacy) | bar + % + reset date+time; row appears when the data carries a 7-day window |
| 💰 extra | `rate_limits.extra_usage` (when enabled) | bar + $used/$limit |

## Width tiering

| Tier | Range | Lines | Layout |
|---|---|---|---|
| 1 | ≥ 184 cols | 1 | full single line |
| 2 | 95–183 cols | 2 | header / everything else |
| 3 | 65–94 cols | 3 | header / 📊+🔌+🏦 / ⏱️+📅 (full @resets) |
| 4 | < 65 cols | 6 | model / dir / 📊 / 🔌+🏦 / ⏱️ 5h / 📅 7d |

**Nothing dropped, nothing compacted** at any tier (a missing 5h or 7d row is
absent from the data, not dropped) — just split across more
rows. Floor of usable width is ~33 cols (the model header line).

Width detection precedence:

1. `STATUSLINE_COLS` env var (manual override — useful for forcing one-line)
2. `/dev/tty` terminal size (works even when stdin is a pipe)
3. `$COLUMNS` env var (rarely set on macOS zsh by default)
4. Fallback `999` (assume wide; let CC's own truncation handle narrow)

## Resilience

- **Per-section error isolation**: every optional section (cwd-git, ctx bar,
  CLI, OpenRouter, 5h, 7d, extra) is wrapped in its own `try/except` and
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
