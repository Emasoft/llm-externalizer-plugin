---
name: llm-externalizer-fix-found-bugs
description: Aggregate unfixed findings across every report in `./reports/llm-externalizer/` and fix each via a fresh serial-fixer subagent (sonnet/opus menu). Optional `@merged-report.md` scopes the loop to one report.
allowed-tools:
  - Task
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
argument-hint: "[@merged-report.md]"
---

# llm-externalizer-fix-found-bugs — headless bug-fix loop

Aggregate every unfixed finding from LLM Externalizer reports into one canonical bug list, then dispatch one serial-fixer subagent (sonnet or opus — picked via menu) per bug until none remain. Each subagent spawn is fresh (zero parent-conversation context). You never read scan-report or fixer-summary content — only paths.

All mechanical work (report parsing, severity classification, path resolution, canonical-format check, state counting, snapshot diffing, fallback-prompt templating, run-directory setup, timestamp generation, summary writing) lives in `scripts/fix_found_bugs_helper.py`. You call it via `Bash` and read its stdout. Your job is orchestration plus judgment (normalisation of edge cases, model selection, progress reporting).

## Helper script

```
$H := python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fix_found_bugs_helper.py"
```

Subcommands (run `$H --help` for the full tree, or `$H <sub> --help` for per-flag docs):

| Subcommand | Purpose | Output |
|---|---|---|
| `aggregate-reports --reports-dir DIR [--skip-if-fixer-exists] --output PATH` | Scan an `llm-externalizer` reports folder, merge the 3 per-model auditor responses when present, classify severity, emit a canonical fix-bugs list | Absolute path of the written bug-list |
| `aggregate-reports --merged-report PATH --output PATH` | Parse ONE merged (`answer_mode=2`) report and emit the same bug-list format | Absolute path of the written bug-list |
| `resolve-path --arg ARG` | Strip leading `@`, resolve to absolute path, verify file exists | Absolute path; exit 1 on missing/invalid |
| `is-canonical --file PATH` | Check canonical format | Exit 0 = canonical, 1 = needs normalisation (reasons on stderr) |
| `count --file PATH` | Current state | One line: `TOTAL=N FIXED=N UNFIXED=N MAX_ITER=N` |
| `fixed-titles --file PATH` | Snapshot FIXED titles | One title per line, sorted |
| `diff-fixed --file PATH --previous SNAP` | User-facing progress updates | `Fixed: <title> — N unfixed remaining` per newly-FIXED bug |
| `print-fallback-prompt --file PATH` | Prompt for general-purpose Task dispatch (when the selected serial-fixer variant isn't installed) | Full prompt text |
| `timestamp` | Fresh sortable local-TZ ISO-8601 prefix | `20260418T153045+0200` |
| `init-run [--base DIR]` | Create `./reports/llm-externalizer/` + emit all TS-prefixed output paths | Shell-parseable: `RUN_TS=...`, `OUTDIR=...`, `BUGS_TO_FIX=...`, `INITIAL_STATE=...`, `SNAPSHOT=...`, `SUMMARY=...`, `PROGRESS_LOG=...` |
| `save-summary --file PATH --output PATH [--run-start-ts TS]` | Write final markdown summary (counts + FIXED/unfixed title lists) | Absolute path of the written file |

## Output location

All persistent artifacts land in **`./reports/llm-externalizer/`** (relative to the current working directory; the helper creates the dir). Every saved file has a **sortable local-timezone ISO-8601 prefix** so `ls -1` orders them chronologically. Filename shape (all run-scoped files share the same `<RUN_TS>`):

```
<RUN_TS>.fix-found-bugs.bugs-to-fix.md       # aggregated canonical bug list (input to the loop)
<RUN_TS>.fix-found-bugs.initial-state.txt    # initial FIXED-titles snapshot
<RUN_TS>.fix-found-bugs.snapshot.txt         # per-iteration snapshot (overwritten each loop)
<RUN_TS>.fix-found-bugs.summary.md           # final markdown summary
<RUN_TS>.fix-found-bugs.progress.log         # per-iteration Task return line (append)
```

Example: `20260418T153045+0200.fix-found-bugs.summary.md`.

## ⚠️ What this command is NOT

- It does not re-scan source code. The only LLM it invokes is the per-bug fixer subagent. If no LLM Externalizer reports exist yet, run `/llm-externalizer:llm-externalizer-scan-and-fix` first.
- It does not read scan-report or fixer-summary content into the orchestrator context. The helper parses reports on disk; the fixer subagent reads the bug file on disk; nothing from those flows through the orchestrator.
- It does not commit. The user reviews diffs and commits themselves.
- It does not replace `/llm-externalizer:llm-externalizer-scan-and-fix`. scan-and-fix dispatches one fixer PER REPORT (whether or not the report contains real bugs); this command dispatches one fixer PER BUG after aggregating across all reports.

## Arguments

Parse `$ARGUMENTS` into:

- **(empty)** — default mode. Aggregate every report in `$CLAUDE_PROJECT_DIR/reports/llm-externalizer/` and fix every finding. Skip reports that have a `.fixer.` sibling (those were already processed by `llm-externalizer-scan-and-fix`).
- **`@path/to/merged-report.md`** or **`path/to/merged-report.md`** — scoped mode. Aggregate ONLY this file's findings (must be a merged `answer_mode=2` report). All other reports in the directory are ignored.

Abort with `[FAILED] llm-externalizer-fix-found-bugs — <one-line reason>` on any validation failure.

## Workflow (you drive this)

### Step 1 — Init run

Call the helper once and parse the shell-style key=value output into local variables (`RUN_TS`, `OUTDIR`, `BUGS_TO_FIX`, `INITIAL_STATE`, `SNAPSHOT`, `SUMMARY`, `PROGRESS_LOG`):

```bash
$H init-run
```

Every filename this run produces uses `$RUN_TS` as its prefix. Every orchestrator path lives under `$OUTDIR`.

### Step 2 — Aggregate reports into the canonical bug list

**Default mode (no arg given):**

```bash
$H aggregate-reports \
  --reports-dir "$CLAUDE_PROJECT_DIR/reports/llm-externalizer" \
  --skip-if-fixer-exists \
  --output "$BUGS_TO_FIX"
```

**Scoped mode (merged-report argument):**

```bash
MERGED_REPORT=$($H resolve-path --arg "$ARGUMENTS")  # strips @ and validates existence
$H aggregate-reports \
  --merged-report "$MERGED_REPORT" \
  --output "$BUGS_TO_FIX"
```

If `aggregate-reports` emits `No findings produced` on stderr or writes a file with 0 `### ` entries, stop with a friendly one-line message (e.g. `Nothing to do — no unfixed findings in <reports-dir>.`) and skip to Step 7.

The aggregator handles the three LLM Externalizer report shapes transparently:

- **Per-file** — one `## Findings` (or equivalent) section per source file.
- **Ensemble** — up to three `## Response (Model: X)` sections per file; every finding from each auditor becomes its own `### N.` entry, tagged with the auditor's model ID in the body so duplicates can be spotted by eye.
- **Merged (`answer_mode=2`)** — multiple `## File: <path>` sections inside one `.md`. Parsed the same way, per-file.

Severity is inferred from keywords (security/crash/race/data-corruption/infinite-loop → High; style/naming/readability/comment → Low; everything else → Medium) — good enough to order the loop; the fixer subagent re-classifies per finding.

### Step 3 — Canonical-format check

```bash
$H is-canonical --file "$BUGS_TO_FIX"
```

Exit 0 → skip to Step 4. Exit 1 → normalise the file per the rules at the bottom of this doc (judgment work; not something the script does), then continue. Tell the user in one sentence what you changed.

### Step 4 — Initial counts + snapshot

```bash
$H count --file "$BUGS_TO_FIX"             # parse TOTAL, UNFIXED, MAX_ITER
$H fixed-titles --file "$BUGS_TO_FIX" > "$INITIAL_STATE"
cp "$INITIAL_STATE" "$SNAPSHOT"
```

`$INITIAL_STATE` is a permanent record; `$SNAPSHOT` is the rolling "previous" used by `diff-fixed` each iteration.

### Step 4b — Pre-fix checkpoint

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    STAMP=$(date +%Y%m%dT%H%M%S%z)
    git add -A \
      && git commit -m "chore(checkpoint): pre-fix-found-bugs $STAMP" \
      && echo "Checkpoint commit created. Revert with: git reset --soft HEAD~1"
  else
    echo "Working tree clean — no checkpoint needed."
  fi
else
  echo "Not a git repo — the user is responsible for backups."
fi
```

### Step 4c — Pick the fixer model (menu)

Call `AskUserQuestion`. Default (first option) `Sonnet`:

```
question: "Which model should the serial fixer use?"
options:
  - label: "Sonnet"
    description: "Faster, cheaper. Recommended default."
  - label: "Opus"
    description: "Slower, more thorough."
```

Map:
- `Sonnet` → `FIXER_AGENT="llm-externalizer-serial-fixer-sonnet-agent"`
- `Opus`   → `FIXER_AGENT="llm-externalizer-serial-fixer-opus-agent"`

### Step 5 — Pick subagent_type

```bash
if test -f "${CLAUDE_PLUGIN_ROOT}/agents/${FIXER_AGENT}.md" \
   || test -f "$HOME/.claude/agents/${FIXER_AGENT}.md"; then
  USE_CUSTOM=1
else
  USE_CUSTOM=0
fi
```

- `USE_CUSTOM=1` → `subagent_type: "$FIXER_AGENT"`, `prompt: "$BUGS_TO_FIX"` (bare absolute path, nothing else).
- `USE_CUSTOM=0` → `subagent_type: "general-purpose"`, `prompt: $($H print-fallback-prompt --file "$BUGS_TO_FIX")`.

### Step 6 — Loop for `i = 1 .. MAX_ITER`

Maintain `stuck_streak = 0`, `prev_unfixed`, `prev_total`.

1. Re-run `$H count --file "$BUGS_TO_FIX"`. If `UNFIXED=0`, break — all done.
2. Dispatch ONE `Task` call. Read its return line. If it starts with `[FAILED]`, break and surface the reason.
3. Append the return line to `$PROGRESS_LOG`:
   ```bash
   printf '%s\n' "$TASK_RETURN_LINE" >> "$PROGRESS_LOG"
   ```
4. Surface progress to the user:
   ```bash
   $H diff-fixed --file "$BUGS_TO_FIX" --previous "$SNAPSHOT"
   ```
   Emit each output line as-is — they are `Fixed: <title> — N unfixed remaining` (plus similar lines for False-positive and CANTFIX closures).
5. Refresh the snapshot:
   ```bash
   $H fixed-titles --file "$BUGS_TO_FIX" > "$SNAPSHOT"
   ```
6. Re-run `$H count`. If `cur_unfixed >= prev_unfixed` AND `cur_total <= prev_total`, `stuck_streak += 1`. If `stuck_streak >= 2`, break ("No progress for 2 iterations, stopping.").
7. Update `prev_unfixed`, `prev_total` and continue.

### Step 7 — Final summary

Write the end-of-run markdown:

```bash
$H save-summary \
  --file "$BUGS_TO_FIX" \
  --output "$SUMMARY" \
  --run-start-ts "$RUN_TS"
```

Print the summary's absolute path to the user. Also mention: bugs fixed this run, bugs still unfixed, any new `### N.` entries added during the run (the fixer agent appends newly-discovered bugs per rule 7 of its system prompt).

**Do NOT commit.** The user reviews diffs and commits themselves.

## Normalisation rules (only when `is-canonical` exits 1)

Rewrite the file in place so every bug is a `### N. Title` heading under one of `## High severity`, `## Medium severity`, `## Low severity`. Three patterns the script flags:

- **Bullet-item bugs** (`- **Title** — body…`) → promote each bullet to a `### N. Title` heading with the bullet body verbatim. Preserve any existing `— FIXED` marker.
- **Sub-severity `### ` labels** (e.g. `### Critical`, `### Medium`, `### Minor`) → delete the label and reparent its children under the mapped canonical severity (Critical → High, Medium → Medium, Minor → Low).
- **Non-canonical `## ` sections** (e.g. `## Findings` left by the aggregator) → keep the section's prose as context, move its bug entries under the appropriate canonical severity section. If severity is genuinely ambiguous, ask the user once.

Then renumber `### N.` entries sequentially across the file. Never rephrase, summarise, or drop bug bodies or FIXED postmortems — only restructure headings and severity grouping.

## Safety rails

- Iteration cap: `MAX_ITER = max(UNFIXED_START * 2 + 5, 5)` (computed by `$H count`).
- Stuck detection: 2 consecutive iterations with no progress → break.
- Hard stop on `[FAILED] ...` return from a subagent.
- Zero parent-conversation inheritance (each Task spawn is fresh — `~/.claude/CLAUDE.md`, project `CLAUDE.md`, and auto-memory still load the same way they did for `claude -p`).
- No background processes. Ending the parent session stops the loop cleanly between iterations.
- No commits.
- All output files live under `./reports/llm-externalizer/` with a `<RUN_TS>.` prefix — add that directory to `.gitignore` if you don't want it committed. (The plugin's own `.gitignore` already excludes the dir at the plugin-repo level; each consuming project manages its own ignore rules.)
- **Never exceed 15 concurrent Task calls.** This command dispatches serially (one at a time) because bug order matters — later bugs may be superseded by fixes in earlier ones. Do not rewrite the loop to parallelise.
