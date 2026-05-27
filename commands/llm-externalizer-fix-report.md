---
name: llm-externalizer-fix-report
description: Fix findings in ONE existing per-file scan report. Pick sonnet or opus via menu, dispatches a single parallel-fixer subagent, returns its `.fixer.`-summary path. For whole-folder audits use `/llm-externalizer:llm-externalizer-scan-and-fix`.
allowed-tools:
  - Task
  - Bash
argument-hint: "@scan-report.md"
---

# llm-externalizer-fix-report — single-report fixer wrapper

Dispatch one parallel-fixer-agent subagent (sonnet or opus — picked via menu) against one scan report. The agent reads the report, classifies each finding (REAL BUG / FALSE-POSITIVE / HALLUCINATION / CANTFIX), applies surgical edits for real bugs, runs per-language linters, writes a `.fixer.`-tagged summary beside the report, and returns the summary path.

You (the orchestrator) never read the report, the source, or the summary. You just validate the argument, dispatch the Task, and surface the result.

## When to use this command vs `scan-and-fix`

| Situation | Command |
|---|---|
| You already have a per-file scan report (`answer_mode=0`) and want to fix its findings | **this command** |
| You want to audit a whole folder (scan + fix in one pass, up to 15 fixers in parallel) | `/llm-externalizer:llm-externalizer-scan-and-fix` |
| You want to aggregate findings across many reports and fix bugs one at a time | `/llm-externalizer:llm-externalizer-fix-found-bugs` |

This command is deliberately minimal — no scan, no batching, no joining. It's the single-file counterpart to `scan-and-fix`'s parallel fixer step.

## Arguments

Parse `$ARGUMENTS`:

- `@path/to/report.md` or `path/to/report.md` — absolute or relative path to a per-file LLM Externalizer scan report (typically `<main-project-dir>/reports/llm-externalizer/<RUN_TS>.<stem>.md`, where the main project dir is `$CLAUDE_PROJECT_DIR`).

**Abort rules** (`[FAILED] llm-externalizer-fix-report — <reason>`):

- Empty `$ARGUMENTS`.
- File does not exist, is empty, or is not readable.
- File is already a `.fixer.` summary (basename contains `.fixer.`) — nothing to do; point user at the existing summary.
- File is the final joined report (basename contains `.final-report.`) — not a per-file report; suggest `scan-and-fix` instead.

## Workflow

### Step 1 — Resolve and validate the report path

Relative paths resolve against the main project dir, which is `$CLAUDE_PROJECT_DIR` used verbatim (process cwd as fallback) — the SAME no-git resolver the MCP server uses to write reports under `<main-project-dir>/reports/llm-externalizer/`. Do NOT derive this from git: linked worktrees, monorepos whose subfolders each have their own git, and git-less roots would all resolve to the wrong directory.

```bash
# No-git: anchor relative report paths exactly where the MCP server wrote
# them — $CLAUDE_PROJECT_DIR verbatim, else the process cwd. NEVER git.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
RAW="${ARGUMENTS#@}"                      # strip leading @
case "$RAW" in
  /*) REPORT_PATH="$RAW" ;;               # already absolute
  *)  REPORT_PATH="$PROJECT_DIR/$RAW" ;;
esac
test -f "$REPORT_PATH" || { echo "[FAILED] llm-externalizer-fix-report — report not found: $REPORT_PATH"; exit 1; }
test -s "$REPORT_PATH" || { echo "[FAILED] llm-externalizer-fix-report — report is empty: $REPORT_PATH"; exit 1; }
BASENAME=$(basename -- "$REPORT_PATH")
case "$BASENAME" in
  *.fixer.*)        echo "[FAILED] llm-externalizer-fix-report — already a fixer summary: $REPORT_PATH"; exit 1 ;;
  *.final-report.*) echo "[FAILED] llm-externalizer-fix-report — joined final-report, not a per-file scan: $REPORT_PATH"; exit 1 ;;
esac
echo "$REPORT_PATH"
```

Capture stdout as `$REPORT_PATH`.

### Step 2a — Pre-fix checkpoint

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    STAMP=$(date +%Y%m%dT%H%M%S%z)
    # `git stash --include-untracked` instead of `git add -A && git commit`:
    # the latter would stage every untracked file (incl. .env, reports/,
    # local scratch) into a commit; if the user later pushed that commit,
    # secrets would leak. The stash keeps everything off-history.
    git stash push --include-untracked -m "pre-fix-report $STAMP" \
      && echo "Checkpoint stash created. Restore with: git stash pop"
  else
    echo "Working tree clean — no checkpoint needed."
  fi
else
  echo "Not a git repo — the user is responsible for backups."
fi
```

### Step 2b — Pick the fixer model (auto-route)

Route automatically per-report. Promote to Opus when EITHER (a) the report's source file is large (>1000 lines or >50 KB) or (b) the report carries many findings (>5 `[[FINDING]]` blocks).

```bash
# Source-file extraction — matches all three MCP report header shapes
# (## File: / **File:** / - **Input file**: `…`). Paths containing
# spaces are preserved. Audit references: SR-P1-001, SR-P1-003, SR-P1-004.
SRC=$(grep -m1 -E '^(## File:|\*\*File:\*\*|- \*\*Input file\*\*:)' "$REPORT_PATH" 2>/dev/null \
      | sed -E 's/^(## File:|\*\*File:\*\*|- \*\*Input file\*\*:)[[:space:]]*`?([^`]*)`?[[:space:]]*$/\2/' \
      | sed -E 's/[[:space:]]+$//' || true)
BIG_SOURCE=0
if [[ -n "${SRC:-}" && -f "$SRC" ]]; then
  LINES=$(wc -l < "$SRC" | tr -d '[:space:]')
  BYTES=$(wc -c < "$SRC" | tr -d '[:space:]')
  if (( LINES > 1000 || BYTES > 50000 )); then BIG_SOURCE=1; fi
fi
FINDINGS=$(grep -cF '[[FINDING]]' "$REPORT_PATH" 2>/dev/null || echo 0)
if [[ "${LLM_EXT_FORCE_OPUS:-0}" == "1" ]] || (( BIG_SOURCE == 1 || FINDINGS > 5 )); then
  FIXER_AGENT="llm-externalizer-parallel-fixer-opus-agent"
else
  FIXER_AGENT="llm-externalizer-parallel-fixer-sonnet-agent"
fi
```

One report = one agent. Never pass multiple reports to the same agent — if the user wants to fix several reports, dispatch this command once per report (or use `/llm-externalizer:llm-externalizer-scan-and-fix` for batched runs).

### Step 2c — Verify the fixer agent exists

```bash
test -f "${CLAUDE_PLUGIN_ROOT}/agents/${FIXER_AGENT}.md" \
  || test -f "$HOME/.claude/agents/${FIXER_AGENT}.md" \
  || { echo "[FAILED] llm-externalizer-fix-report — $FIXER_AGENT not installed"; exit 1; }
```

### Step 3 — Dispatch ONE Task call

Exactly one `Task` call. The `subagent_type` value comes from `$FIXER_AGENT` (Step 2b) and is exactly one of these two literal strings:

- `subagent_type: "llm-externalizer-parallel-fixer-sonnet-agent"` (when Step 2b picked sonnet — the default)
- `subagent_type: "llm-externalizer-parallel-fixer-opus-agent"` (when Step 2b promoted the call to opus)

Plus the other fields:

- `description: "Fix report: <basename>"` (≤5 words)
- `prompt: "<REPORT_PATH>"` (bare absolute path, nothing else)

Do NOT pass the user's conversation context, do NOT paraphrase the report, do NOT attach instructions. The agent's system prompt covers everything — the prompt is just the path.

### Step 4 — Surface the result

The agent returns ONE line — its `.fixer.`-summary path, or `[FAILED] <agent-name> — <reason>`.

- On success, emit to the user: `Fixed report: <summary-path>`. Do NOT `Read` the summary content; the user reviews it directly.
- On `[FAILED]` return, relay the failure line verbatim and stop.

## Hardcoded constraints (do not override)

- Exactly ONE fixer dispatch per invocation. No parallel fanout (`scan-and-fix` is for that).
- The orchestrator MUST NOT `Read` the report, the source files, or the fixer summary. Only `Bash` validation + one `Task` call + one user-facing line.
- No commits, no pushes. The user reviews the diff and commits themselves.

## Three-surface compliance: by-design slash-only (GAP-9)

This command dispatches a subagent that APPLIES fixes to source files (Edit / Write). The MCP server's file-write tools (`fix_code`, `batch_fix`, `merge_files`, `split_file`, `revert_file`) were deliberately removed because the server is read-only by design — only the orchestrator and its subagents may mutate the user's working tree.

Per TRDD-a24b213c §C, this is a documented exemption from the "every capability has MCP tool + CLI command + slash command" invariant — not a gap waiting to be filled. Re-enabling MCP file-write tools would close GAP-9 but violate the read-only-server design.

## Error handling

| Error | Resolution |
|---|---|
| Empty `$ARGUMENTS` | `[FAILED] llm-externalizer-fix-report — no report path supplied (pass @path/to/report.md)` |
| Report path missing / empty / unreadable | `[FAILED] llm-externalizer-fix-report — report not found / empty / unreadable: <path>` |
| Basename contains `.fixer.` | `[FAILED] llm-externalizer-fix-report — already a fixer summary: <path>` |
| Basename contains `.final-report.` | `[FAILED] llm-externalizer-fix-report — joined final-report, not a per-file scan: <path>. Use scan-and-fix for folder audits.` |
| Picked fixer variant missing | `[FAILED] llm-externalizer-fix-report — <agent-name> not installed` (either `llm-externalizer-parallel-fixer-sonnet-agent` or `…-opus-agent`) |
| Fixer returns `[FAILED] …` | Relay verbatim to the user. |
