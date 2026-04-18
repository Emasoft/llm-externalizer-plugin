---
name: llm-externalizer-scan-and-fix-serially
description: Scan a codebase, aggregate findings into one canonical bug list, then fix each bug serially with `llm-externalizer-serial-fixer-agent`. Use when fixes mutate shared state or bug order matters.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__scan_folder
  - mcp__llm-externalizer__code_task
  - Bash
  - Task
argument-hint: "[target] [--file-list path] [--instructions path] [--specs path] [--free]"
---

Scan → aggregate → serial fix loop. Every Task call dispatches **one** `llm-externalizer-serial-fixer-agent`. No parallel fanout, no nested command chain.

**HARDCODED (not overridable):**

- `answer_mode: 0` — ONE REPORT PER FILE.
- `output_dir: $CLAUDE_PROJECT_DIR/reports/llm-externalizer/` — required so the aggregator finds every scan report.
- Never more than 1 concurrent Task call. Bug order matters here.

**Picking between this and `scan-and-fix`:** parallel fixers race on shared state (shared imports, types, schemas, mocks) and fix bugs in an arbitrary order. This command is for audits where later fixes depend on earlier ones. For independent per-file fixes, use `/llm-externalizer:llm-externalizer-scan-and-fix` — faster wall-clock.

**Cross-file limitation (same as `scan-and-fix`):** the LLM sees only 1–5 files per request. It cannot verify cross-file references with the default rubric. For that, use `mcp__llm-externalizer__check_against_specs` or `mcp__llm-externalizer__search_existing_implementations`.

## Arguments

Parse `$ARGUMENTS`:

- `[target-path]` (positional, optional): absolute folder to scan. Relative paths resolve against `$CLAUDE_PROJECT_DIR`. If omitted AND `--file-list` is also omitted, **auto-discover** (see Step 0).
- `--text-files`: include `.md .txt .json .yml .yaml .toml .ini .cfg .conf .xml .html .rst .csv`.
- `--file-list <path>`: `.txt` with one absolute path per line. When present, routes through `code_task` and ignores `[target-path]`.
- `--instructions <path>`: replaces the default audit rubric.
- `--specs <path>`: appended to `instructions_files_paths`.
- `--no-scan-secrets`: disables the pre-scan secret detector.
- `--free`: uses the Nemotron free tier. Warn once about provider prompt logging before running on proprietary code.

Abort with `[FAILED] llm-externalizer-scan-and-fix-serially — <reason>` on any validation failure.

## Step 0 — Auto-discover (only when no target-path AND no --file-list)

1. **Find the real codebase root.** Try `git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null`. If that fails, search nested git repos up to depth 3: `find "$CLAUDE_PROJECT_DIR" -maxdepth 3 -type d -name '.git' -not -path '*/node_modules/*' -not -path '*/.claude/*' 2>/dev/null`. Exactly one → parent is root. More than one → STOP, list candidates, ask. Zero → STOP, ask for explicit target.

2. **Enumerate tracked files.** `git -C <root> ls-files`. Respects `.gitignore`, skips untracked/ignored.

3. **Filter with judgment.** Drop: `docs/`, `CHANGELOG.md`, `LICENSE*`, `CONTRIBUTING.md`, `SECURITY.md`, `README.md`, **ALL `.md` files** (unless `--instructions` says what to check for), `examples/`, `samples/`, `fixtures/`, `templates/`, `__snapshots__/`, `*.snap`, lock files, binary/asset files, `vendor/`, `third_party/`, `*/node_modules/`, `*_dev/`, `reports/`, pre-compiled bundles. Keep: real source code (`.py .ts .tsx .js .go .rs .java .rb .php .c .cc .cpp .cs .swift .dart .ex .lua .sh`, etc.) plus structured configs shipped with the product (`plugin.json`, `.mcp.json`, `pyproject.toml`, `tsconfig.json`, `package.json`).

4. **Write the curated list to a tmp file.**
   ```bash
   RUN_TS=$(date +%Y%m%dT%H%M%S%z)
   AUTO_LIST="/tmp/llm-externalizer-scan-and-fix-serially.$RUN_TS.auto-filelist.txt"
   : > "$AUTO_LIST"
   # printf '%s\n' <each path> >> "$AUTO_LIST"
   ```

5. **Confirm with the user.** Show codebase root, total count + breakdown by top-level directory, 3–5 included examples, 3–5 excluded examples, then ask: "Proceed with these N files? [y / edit list / cancel]".

6. On `y`: treat as if the user had passed `--file-list $AUTO_LIST`. On `cancel`: abort. On `edit list`: surface the tmp path.

> `.md` files are excluded by default because the default rubric is source-code-oriented (logic bugs, crashes, security) with no useful application to prose. Include them only with an explicit `--instructions <path>` that tells the LLM concretely what to look for.

## Step 1 — Validate inputs

```bash
REPORTS_DIR="$CLAUDE_PROJECT_DIR/reports/llm-externalizer"
mkdir -p "$REPORTS_DIR"
```

- `--file-list`: `test -f`; abort if missing/empty.
- `--instructions`: `test -f`; abort if missing.
- `--specs`: `test -f`; abort if missing.
- target-path (user-supplied, not auto-discovered): resolve to absolute, `test -d`; abort `[FAILED] llm-externalizer-scan-and-fix-serially — target path not found: <path>`.

Then `mcp__llm-externalizer__discover`. Abort `[FAILED] llm-externalizer-scan-and-fix-serially — service offline` if offline.

## Step 2 — Build + run the scan call

Build `instructions_files_paths`:
- BOTH `--instructions` and `--specs`: `[instructionsPath, specsPath]`.
- only `--instructions`: `[instructionsPath]`.
- only `--specs`: `[specsPath]`.
- neither: omit.

Build `instructions`:
- `--specs` only: `"Audit each file for compliance against the specification in instructions_files_paths. Report deviations with file paths and line numbers. Be terse."`
- `--instructions` (with or without `--specs`): `"Follow the instructions in instructions_files_paths. Reference function names and line numbers. Be terse."`
- neither (default rubric — REAL BUGS ONLY):

```
Audit each file for REAL DEFECTS only. A real defect is:
  1) Logic bug — wrong conditional, off-by-one, unreachable code, typo in expression, incorrect default, broken state transition.
  2) Crash / unintended exception on documented inputs.
  3) Security vulnerability with a concrete exploit path — shell injection, path traversal, unsafe deserialization, secret exposure, auth bypass, SSRF.
  4) Resource leak causing unbounded growth, deadlock, or starvation (NOT "file not closed in a short-lived script").
  5) Data corruption — a write producing malformed state.
  6) Functionality mismatch with its contract.
  7) Broken reference within this file — function called but not defined here, attribute accessed that the class does not declare.

DO NOT REPORT (coding-style choices, not bugs):
  * Missing try/except. Fail-fast is valid.
  * Missing null / None / undefined checks.
  * Missing input validation on internal-only functions.
  * "Could be more robust" / "consider using". Suggestions ≠ defects.
  * "Should add logging / comments / type hints / docstrings".
  * Refactoring suggestions.
  * Hypothetical future scenarios.
  * Performance micro-optimizations off the hot path.

Before reporting, ask: "Does this claim describe code that actually misbehaves on documented inputs?" If only under attacker input → security finding (report with exploit path). If only if the author had coded defensively against themselves → DO NOT REPORT.

Respect the file's coding style. Reference function names and line numbers. Be terse. One line per finding. No preamble.
```

Flags:
- `--free` → `"free": true`
- `--no-scan-secrets` → `"scan_secrets": false`

### Branch A — `--file-list` supplied → `mcp__llm-externalizer__code_task`

```json
{
  "answer_mode": 0,
  "max_retries": 3,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer",
  "input_files_paths": ["<each path from the list>"],
  "instructions": "<see above>",
  "instructions_files_paths": ["<if applicable>"],
  "free": <if applicable>,
  "scan_secrets": <if --no-scan-secrets: false>
}
```

### Branch B — folder scan → `mcp__llm-externalizer__scan_folder`

```json
{
  "folder_path": "<absolute target-path>",
  "answer_mode": 0,
  "use_gitignore": true,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer",
  "extensions": ["<only if --text-files>"],
  "exclude_dirs": [
    "docs_dev","reports_dev","scripts_dev","tests_dev",
    "samples_dev","examples_dev","downloads_dev","libs_dev","builds_dev",
    "reports","llm_externalizer_output",
    ".rechecker",".mypy_cache",".ruff_cache",".serena",".claude",".venv","__pycache__"
  ],
  "instructions": "<see above>",
  "instructions_files_paths": ["<if applicable>"],
  "free": <if applicable>,
  "scan_secrets": <if --no-scan-secrets: false>
}
```

With `--text-files`: `extensions: [".md",".txt",".json",".yml",".yaml",".toml",".ini",".cfg",".conf",".xml",".html",".rst",".csv"]`. Otherwise omit.

## Step 3 — Extract + validate report paths

The MCP response contains every `<source> -> <report>` pair (mode 0). Parse, persist to a tmp file:

```bash
RUN_TS=$(date +%Y%m%dT%H%M%S%z)
EXTRACTED="/tmp/llm-externalizer-scan-and-fix-serially.$RUN_TS.extracted.txt"
VALIDATED="/tmp/llm-externalizer-scan-and-fix-serially.$RUN_TS.validated.txt"
REJECTED="/tmp/llm-externalizer-scan-and-fix-serially.$RUN_TS.rejected.txt"
: > "$EXTRACTED"; : > "$VALIDATED"; : > "$REJECTED"
# printf '%s\n' <each report path> >> "$EXTRACTED"  (exclude any containing .fixer.)
```

Abort `[FAILED] llm-externalizer-scan-and-fix-serially — scan produced 0 reports` if `wc -l "$EXTRACTED"` is 0.

Script-validate each line:

```bash
while IFS= read -r REPORT; do
  [ -z "$REPORT" ] && continue
  if python3 "${CLAUDE_PLUGIN_ROOT}/scripts/validate_report.py" \
        --report "$REPORT" --project-dir "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1; then
    printf '%s\n' "$REPORT" >> "$VALIDATED"
  else
    printf '%s\n' "$REPORT" >> "$REJECTED"
  fi
done < "$EXTRACTED"
wc -l "$EXTRACTED" "$VALIDATED" "$REJECTED"
```

Abort `[FAILED] llm-externalizer-scan-and-fix-serially — all N reports failed validate_report.py` if `wc -l "$VALIDATED"` is 0.

Do NOT `Read` any report content. The `Read` tool is not in `allowed-tools` for this command — report content stays out of the orchestrator.

## Step 4 — Init run + aggregate reports into one bug list

```bash
H='python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fix_found_bugs_helper.py"'
eval "$H init-run" | while IFS='=' read -r k v; do export "$k=$v"; done
# Exports: RUN_TS (reused), OUTDIR, BUGS_TO_FIX, INITIAL_STATE, SNAPSHOT, SUMMARY, PROGRESS_LOG

eval "$H aggregate-reports \
  --reports-dir \"$REPORTS_DIR\" \
  --output \"$BUGS_TO_FIX\""
```

The aggregator handles per-file, ensemble (3 `## Response (Model: X)` sections), and merged report shapes transparently. Severity is assigned by keyword (security/crash/race/data-corruption → High; style/naming/readability/docstring → Low; else Medium).

If the aggregator writes a file with 0 `### ` entries, stop with `Nothing to do — scan produced reports but no aggregatable findings.` and jump to Step 7.

## Step 5 — Canonicalise + snapshot

```bash
eval "$H is-canonical --file \"$BUGS_TO_FIX\""
# exit 0 = canonical; exit 1 = normalise in place (see rules below), then continue
eval "$H count --file \"$BUGS_TO_FIX\""              # parse TOTAL, UNFIXED, MAX_ITER
eval "$H fixed-titles --file \"$BUGS_TO_FIX\" > \"$INITIAL_STATE\""
cp "$INITIAL_STATE" "$SNAPSHOT"
```

**Normalisation** (only when `is-canonical` exits 1): rewrite so every bug is a `### N. Title` heading under one of `## High severity`, `## Medium severity`, `## Low severity`. Promote bullet-item bugs to `### N.` headings; reparent sub-severity labels (`### Critical` → High, `### Minor` → Low); move non-canonical `## ` sections under the right severity. Renumber sequentially. Never rephrase or drop bug bodies or FIXED postmortems.

## Step 6 — Serial fix loop

Pick subagent:

```bash
if test -f "${CLAUDE_PLUGIN_ROOT}/agents/llm-externalizer-serial-fixer-agent.md" \
   || test -f "$HOME/.claude/agents/llm-externalizer-serial-fixer-agent.md"; then
  USE_CUSTOM=1
else
  USE_CUSTOM=0
fi
```

- `USE_CUSTOM=1` → `subagent_type: "llm-externalizer-serial-fixer-agent"`, `prompt: "$BUGS_TO_FIX"` (bare absolute path).
- `USE_CUSTOM=0` → `subagent_type: "general-purpose"`, `prompt: $($H print-fallback-prompt --file "$BUGS_TO_FIX")`.

Model defaults to `opus`; honour user override for sonnet/haiku via `model:` on the Task call.

For `i = 1 .. MAX_ITER`, maintain `stuck_streak = 0`, `prev_unfixed`, `prev_total`:

1. `$H count --file "$BUGS_TO_FIX"`. If `UNFIXED=0`, break.
2. Dispatch ONE `Task` call. If return starts with `[FAILED]`, break and surface reason.
3. `printf '%s\n' "$TASK_RETURN_LINE" >> "$PROGRESS_LOG"`.
4. `$H diff-fixed --file "$BUGS_TO_FIX" --previous "$SNAPSHOT"` — emit each line to the user verbatim.
5. `$H fixed-titles --file "$BUGS_TO_FIX" > "$SNAPSHOT"`.
6. Re-run `$H count`. If `cur_unfixed >= prev_unfixed` AND `cur_total <= prev_total`, `stuck_streak += 1`. If `stuck_streak >= 2`, break.
7. Update `prev_unfixed`, `prev_total`.

**Never exceed 1 concurrent Task call.** Do not parallelise.

## Step 7 — Final summary

```bash
eval "$H save-summary \
  --file \"$BUGS_TO_FIX\" \
  --output \"$SUMMARY\" \
  --run-start-ts \"$RUN_TS\""
```

Print the summary's absolute path. Also mention: bugs fixed this run, bugs still unfixed, any new `### N.` entries the serial-fixer-agent appended during the loop.

**Do NOT commit.** User reviews diffs and commits themselves.

## Safety rails

- `MAX_ITER = max(UNFIXED_START * 2 + 5, 5)` (from `$H count`).
- Stuck detection: 2 consecutive no-progress iterations → break.
- Hard stop on `[FAILED] ...` from a subagent.
- Zero parent-conversation inheritance (each Task is a fresh spawn; user/project CLAUDE.md load the same as under `claude -p`).
- No background processes. Ending the parent session stops the loop cleanly between iterations.
- No commits.
- All output files under `./reports/llm-externalizer/` with `<RUN_TS>.fix-found-bugs.*` prefixes.

## Error handling

| Error | Resolution |
|---|---|
| MCP service offline | `[FAILED] — service offline`. Ask user to restart Claude Code. |
| Target / file-list / instructions / specs missing | `[FAILED] — <which> not found: <path>`. |
| Scan returns 0 reports | `[FAILED] — scan produced 0 reports`. Widen target. |
| All reports fail `validate_report.py` | `[FAILED] — all N reports failed validate_report.py`. |
| Aggregator produces 0 findings | Stop with `Nothing to do — no aggregatable findings.` (not a failure). |
| Serial-fixer-agent missing | Fall back to `general-purpose` with `print-fallback-prompt`. |
| Subagent returns `[FAILED] …` | Relay verbatim and stop. |
| `--free` + proprietary code implied | Warn ONCE about provider prompt logging, then proceed on user confirmation. |
