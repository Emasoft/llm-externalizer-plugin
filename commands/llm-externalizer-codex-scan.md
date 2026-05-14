---
name: llm-externalizer-codex-scan
description: Externalize a per-file code scan to OpenAI GPT-5.5 via the Codex CLI. Falls back to Opus subagents on rate-limit or token-limit. Per-batch reports under $MAIN_ROOT/reports/llm-externalizer/, consumable by the existing parallel-fixer / serial-fixer agents.
allowed-tools:
  - Bash
  - Read
  - Task
argument-hint: "[folder] [--files f1 f2 ...] [--ext .py,.ts] [--out-dir path] [--max-bytes N] [--no-gitignore] [--no-fallback]"
---

Externalizes a per-file scan to **OpenAI GPT-5.5 via the Codex CLI** instead of using the MCP server's OpenRouter / local backends. The Codex CLI is OpenAI's terminal client for GPT-5.5; this command wraps it with bin-packed batching, rate-limit detection, and an Opus fallback so the user gets a full scan even when their Codex quota runs out mid-run.

## When to use this vs. `/llm-externalizer-scan-and-fix`

| Situation | Use |
|-----------|-----|
| User has Codex installed and an active OpenAI subscription | This command — GPT-5.5 is often the most capable per-token, and the Codex CLI handles auth + streaming for you |
| User wants the OpenRouter ensemble or a local model | `/llm-externalizer-scan-and-fix` (existing) |
| User wants the cheapest possible (free) scan | `/llm-externalizer-scan-and-fix --free` (existing) |
| User wants loop-until-fixed (phase 2 — not yet shipped) | Track TRDD-807c1e2d; will be `--fix-loop N` on this command |

## What this command does NOT do (yet)

- **No loop-until-fixed** (phase 2). The MVP scans once and writes
  per-batch reports. To then fix the findings, dispatch the existing
  `/llm-externalizer-fix-report` or `/llm-externalizer-fix-found-bugs`
  command on each report path.
- **No MCP integration.** This wraps `codex exec` from the shell;
  it doesn't go through `mcp__llm-externalizer__*` tools. The output
  format is compatible, so downstream agents work, but the scan
  itself is a separate code path.
- **No prompt customization.** The GPT-5.5 prompts are pinned to
  `scripts/codex/codex-scan-prompts.md` and are calibrated for
  OpenAI's response style. **Do NOT edit them in place** — see the
  notes in that file.

## Arguments

Parse `$ARGUMENTS` into:

- `[folder]` (positional, optional) — folder to scan. Mutually exclusive with `--files`.
- `--files <path1> <path2> ...` — explicit file list. Mutually exclusive with `[folder]`.
- `--ext <.py,.ts>` — comma-separated extension filter (only applies to `[folder]` mode). Default: source-code extensions (matching `scan_folder`).
- `--out-dir <path>` — where to write reports. Default: `$MAIN_ROOT/reports/llm-externalizer/` (auto-resolved via `git worktree list`).
- `--max-bytes <N>` — per-batch payload cap. Default: 200000 (200 KB).
- `--no-gitignore` — walk all files, don't honor `.gitignore`.
- `--no-fallback` — abort with non-zero exit if Codex isn't on PATH OR if Codex hits a rate-limit. Default: fall back to Opus.

Abort with `[FAILED] llm-externalizer-codex-scan — <one-line reason>` on any validation failure.

## Step 1 — Check prerequisites

```bash
# Resolve MAIN_ROOT (per agent-reports-location.md)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  MAIN_ROOT="$(git worktree list | head -n1 | awk '{print $1}')"
else
  MAIN_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
fi
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"
WRAPPER="$PLUGIN_ROOT/scripts/codex/run-codex-scan.py"

# Verify the wrapper exists
[[ -f "$WRAPPER" ]] || { echo "[FAILED] llm-externalizer-codex-scan — wrapper script missing at $WRAPPER" >&2; exit 1; }

# Check for codex on PATH (informational; the wrapper handles fallback)
command -v codex >/dev/null 2>&1 && CODEX_AVAILABLE=true || CODEX_AVAILABLE=false
echo "[codex-scan] codex on PATH: $CODEX_AVAILABLE"
```

If `codex` is NOT on PATH AND `--no-fallback` is set, abort with installation instructions:

```
[FAILED] llm-externalizer-codex-scan — Codex CLI is not installed and --no-fallback was passed.
Install Codex: npm install -g @openai/codex
Authenticate:  codex login
Re-run this command, or drop --no-fallback to use Opus instead.
```

## Step 2 — Invoke the wrapper

```bash
# Pass through user arguments verbatim. The wrapper handles file discovery,
# bin-packing, codex invocation, rate-limit detection, and Opus fallback.
uv run "$WRAPPER" $WRAPPER_ARGS
```

The wrapper writes report file paths to stdout (one per line). Capture them and report them back to the user.

## Step 3 — Handle Opus fallback markers (if any)

The wrapper writes Opus fallback markers under `.claude/llm-externalizer-codex-fallback/` when Codex hits a rate-limit. For each marker, spawn an Opus subagent to produce the actual review:

```bash
FALLBACK_DIR=".claude/llm-externalizer-codex-fallback"
if [[ -d "$FALLBACK_DIR" ]]; then
  for marker in "$FALLBACK_DIR"/opus-marker-*.txt; do
    [[ -f "$marker" ]] || continue
    OUT_PATH=$(grep -m1 '^out: ' "$marker" | sed 's/^out: //')
    PROMPT_PATH=$(grep -m1 '^prompt: ' "$marker" | sed 's/^prompt: //')
    echo "[codex-scan] Dispatching Opus fallback: marker=$marker out=$OUT_PATH"
    # Orchestrator: spawn an Opus agent to read $PROMPT_PATH and write the review to $OUT_PATH
    # Marker file is left in place; the agent or the orchestrator should remove it on success.
  done
fi
```

For each marker, dispatch ONE Opus subagent via the Task tool:

- subagent_type: `general-purpose`
- model: `opus`
- run_in_background: `true`
- prompt: Read the prompt file at $PROMPT_PATH and produce the review at $OUT_PATH following the format in the prompt's instructions. Then remove the marker file at $marker.

## Step 4 — Report report paths to the user

Print a summary table:

```
Codex/GPT-5.5 scan complete.

Reports written:
- <path1>  (codex backend, N findings)
- <path2>  (codex backend, M findings)
- <path3>  (opus-fallback, pending agent dispatch)

To fix the findings, run:
  /llm-externalizer:llm-externalizer-fix-report <path1>
  /llm-externalizer:llm-externalizer-fix-report <path2>
  ...
```

The fix-report command will dispatch a parallel fixer agent on each report.

## Phase 2 — `--fix-loop N` (NOT IMPLEMENTED YET)

Tracked in TRDD-807c1e2d-9457-4afb-b7a5-1e6099a17c28. When this flag lands:

- Run the scan as above
- For each report, dispatch the existing parallel-fixer agent
- Wait for all fixers to complete
- Re-run the scan on the same target
- If 0 findings → stop, report success
- If findings unchanged from previous iteration → stop, report "stuck"
- Else → loop, max N iterations

Until phase 2 ships, the user can run the loop manually:
1. `/llm-externalizer:llm-externalizer-codex-scan <target>`
2. For each report path: `/llm-externalizer:llm-externalizer-fix-report <path>`
3. Re-run step 1
4. Stop when reports show "(no findings)" for every file
