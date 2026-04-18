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

- `@path/to/report.md` or `path/to/report.md` — absolute or relative path to a per-file LLM Externalizer scan report (typically `<CLAUDE_PROJECT_DIR>/reports/llm-externalizer/<RUN_TS>.<stem>.md`).

**Abort rules** (`[FAILED] llm-externalizer-fix-report — <reason>`):

- Empty `$ARGUMENTS`.
- File does not exist, is empty, or is not readable.
- File is already a `.fixer.` summary (basename contains `.fixer.`) — nothing to do; point user at the existing summary.
- File is the final joined report (basename contains `.final-report.`) — not a per-file report; suggest `scan-and-fix` instead.

## Workflow

### Step 1 — Resolve and validate the report path

```bash
RAW="${ARGUMENTS#@}"                      # strip leading @
case "$RAW" in
  /*) REPORT_PATH="$RAW" ;;               # already absolute
  *)  REPORT_PATH="$CLAUDE_PROJECT_DIR/$RAW" ;;
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
    git add -A \
      && git commit -m "chore(checkpoint): pre-fix-report $STAMP" \
      && echo "Checkpoint commit created. Revert with: git reset --soft HEAD~1"
  else
    echo "Working tree clean — no checkpoint needed."
  fi
else
  echo "Not a git repo — the user is responsible for backups."
fi
```

### Step 2b — Pick the fixer model (menu)

Call `AskUserQuestion`. Default (first option) `Sonnet`:

```
question: "Which model should the fixer use?"
options:
  - label: "Sonnet"
    description: "Faster, cheaper. Recommended default."
  - label: "Opus"
    description: "Slower, more thorough."
```

Map:
- `Sonnet` → `FIXER_AGENT="llm-externalizer-parallel-fixer-sonnet-agent"`
- `Opus`   → `FIXER_AGENT="llm-externalizer-parallel-fixer-opus-agent"`

### Step 2c — Verify the fixer agent exists

```bash
test -f "${CLAUDE_PLUGIN_ROOT}/agents/${FIXER_AGENT}.md" \
  || test -f "$HOME/.claude/agents/${FIXER_AGENT}.md" \
  || { echo "[FAILED] llm-externalizer-fix-report — $FIXER_AGENT not installed"; exit 1; }
```

### Step 3 — Dispatch ONE Task call

Exactly one `Task` call:

- `subagent_type: "$FIXER_AGENT"` (either `…-sonnet-agent` or `…-opus-agent`, per Step 2b)
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

## Error handling

| Error | Resolution |
|---|---|
| Empty `$ARGUMENTS` | `[FAILED] llm-externalizer-fix-report — no report path supplied (pass @path/to/report.md)` |
| Report path missing / empty / unreadable | `[FAILED] llm-externalizer-fix-report — report not found / empty / unreadable: <path>` |
| Basename contains `.fixer.` | `[FAILED] llm-externalizer-fix-report — already a fixer summary: <path>` |
| Basename contains `.final-report.` | `[FAILED] llm-externalizer-fix-report — joined final-report, not a per-file scan: <path>. Use scan-and-fix for folder audits.` |
| Picked fixer variant missing | `[FAILED] llm-externalizer-fix-report — <agent-name> not installed` (either `llm-externalizer-parallel-fixer-sonnet-agent` or `…-opus-agent`) |
| Fixer returns `[FAILED] …` | Relay verbatim to the user. |
