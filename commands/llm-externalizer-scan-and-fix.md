---
name: llm-externalizer-scan-and-fix
description: Two-stage codebase audit — LLM Externalizer scan with ONE report per file (answer_mode hardcoded to 0), then parallel `llm-externalizer-fixer` agents (max 15 concurrent) verify and fix each finding. All outputs land in `./reports/llm-externalizer/`. Final output is a single joined report path — the orchestrator never reads any scan or fixer content.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__scan_folder
  - mcp__llm-externalizer__code_task
  - Bash
  - Task
argument-hint: "[target-path] [--text-files] [--file-list <path>] [--instructions <path>] [--specs <path>] [--no-scan-secrets] [--free]"
effort: high
---

Orchestrates a full **scan → per-file report → parallel fix → join** pass.

**HARDCODED (not overridable):**

- `answer_mode: 0` — ONE REPORT PER FILE. Required so each fixer agent can be dispatched with exactly one report path and zero orchestrator-side consolidation.
- `output_dir: $CLAUDE_PROJECT_DIR/reports/llm-externalizer/` — required so the join script can find every `.fixer.`-tagged summary.

**Why answer_mode is forced to 0 (do NOT change this):** Modes 1 and 2 produce merged reports, which would force the orchestrator to read and split the merged file to build per-file tasks — that burns exactly the tokens this command is designed to save. With mode 0, the orchestrator only ever touches file paths (scan report paths → fixer prompts → fixer summary paths → join script input). No report content ever enters the orchestrator context.

## Arguments

Parse `$ARGUMENTS` into:

- `[target-path]` (positional, **required unless `--file-list` is supplied**): absolute folder to scan. Relative paths resolve against `$CLAUDE_PROJECT_DIR`.

  > **If the user invokes the command WITHOUT a target-path and WITHOUT `--file-list`, the orchestrator MUST stop and ask the user for a target.** Do NOT silently default to `.` or `$CLAUDE_PROJECT_DIR` — those often contain non-codebase folders (`*_dev/`, generated reports, caches, sibling projects) and the fixers WRITE to source files, so the blast radius is real.
  >
  > Offer these defaults when asking:
  >   - **"the actual codebase"** → auto-detect via `git rev-parse --show-toplevel` inside `$CLAUDE_PROJECT_DIR` if it is a git repo, otherwise fall back to `$CLAUDE_PROJECT_DIR` itself. Combined with the standard exclude-dirs below this gives a safe whole-codebase scan.
  >   - A specific subdirectory the user names (e.g. `src/`, `mcp-server/src/`).
  >   - A `--file-list <path>` for a precise, user-curated set.
- `--text-files`: include plain-text formats (`.md .txt .json .yml .yaml .toml .ini .cfg .conf .xml .html .rst .csv`) in the scan. Without this flag, `scan_folder` uses its default source-code extensions.
- `--file-list <path>`: absolute path to a `.txt` file with ONE absolute file path per line. When present, the command routes through `code_task` and scans exactly those files (positional target-path is ignored).
- `--instructions <path>`: absolute path to an `.md` file whose contents become the scan instructions. Replaces the default audit rubric.
- `--specs <path>`: absolute path to an `.md` specification file. Appended to `instructions_files_paths`; the scan checks each file against the spec.
- `--no-scan-secrets`: disables the pre-scan secret detector (`scan_secrets: false`).
- `--free`: use the free Nemotron model (`free: true`). Warn once about provider prompt logging before running on proprietary code; proceed only after user confirms or when the argument was explicit.

Abort with `[FAILED] llm-externalizer-scan-and-fix — <one-line reason>` on any validation failure.

## Step 1 — Validate inputs

Using `Bash`:

1. Resolve the reports directory:
   ```bash
   REPORTS_DIR="$CLAUDE_PROJECT_DIR/reports/llm-externalizer"
   mkdir -p "$REPORTS_DIR"
   ```
2. If `--file-list <path>` is set: `test -f <path>` and read it with `cat` → build an array of non-empty, non-comment lines. Abort if the file is empty.
3. If `--instructions <path>` is set: `test -f <path>`. Abort if missing.
4. If `--specs <path>` is set: `test -f <path>`. Abort if missing.
5. If no `--file-list`:
   - **If the user did not supply a target-path**, STOP and ask them for one. Do NOT silently pick a default. See the "ask-first" note under Arguments above. Only proceed when the user has named a target (or explicitly said "the actual codebase", in which case use the auto-detected codebase root).
   - Once a target is chosen, resolve it to an absolute path and `test -d` it. Abort with `[FAILED] llm-externalizer-scan-and-fix — target path not found: <path>` if missing.

Then call `mcp__llm-externalizer__discover`. Abort with `[FAILED] llm-externalizer-scan-and-fix — service offline` if the service is offline.

## Step 2 — Build and run the scan call

Build `instructions_files_paths` from the union of `--instructions` and `--specs`:

- If BOTH set: `[instructionsPath, specsPath]` (instructions first — they override the generic rubric).
- If only `--instructions`: `[instructionsPath]`.
- If only `--specs`: `[specsPath]`.
- If neither: omit the field.

Build the `instructions` string:

- If `--specs` but no `--instructions`: `"Audit each file for compliance against the specification provided in instructions_files_paths. Report deviations, missing features, or incorrect implementations with file paths and line numbers. Be terse."`
- If `--instructions` (with or without `--specs`): `"Follow the instructions provided in instructions_files_paths. Reference function names and line numbers. Be terse."`
- Neither: `"Audit for: 1) Logic bugs, 2) Error handling gaps, 3) Security issues, 4) Resource leaks, 5) Broken references. Reference function names and line numbers. Be terse."`

Add the flags:

- `--free` → `"free": true`
- `--no-scan-secrets` → `"scan_secrets": false`

Common tool arguments (ALWAYS present, NOT overridable):

```json
{
  "answer_mode": 0,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer"
}
```

### Branch A — `--file-list` supplied

Call `mcp__llm-externalizer__code_task`:

```json
{
  "answer_mode": 0,
  "max_retries": 3,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer",
  "input_files_paths": ["<each absolute path from the list file>"],
  "instructions": "<see above>",
  "instructions_files_paths": ["<if applicable>"],
  "free": <if applicable>,
  "scan_secrets": <if --no-scan-secrets: false>
}
```

### Branch B — folder scan (default)

Call `mcp__llm-externalizer__scan_folder`:

```json
{
  "folder_path": "<absolute target-path>",
  "answer_mode": 0,
  "use_gitignore": true,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer",
  "extensions": ["<only if --text-files>"],
  "exclude_dirs": [
    "docs_dev", "reports_dev", "scripts_dev", "tests_dev",
    "samples_dev", "examples_dev", "downloads_dev",
    "libs_dev", "builds_dev",
    "reports", "llm_externalizer_output",
    ".rechecker", ".mypy_cache", ".ruff_cache",
    ".serena", ".claude", ".venv", "__pycache__"
  ],
  "instructions": "<see above>",
  "instructions_files_paths": ["<if applicable>"],
  "free": <if applicable>,
  "scan_secrets": <if --no-scan-secrets: false>
}
```

With `--text-files`, set `extensions: [".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".html", ".rst", ".csv"]`. Without it, OMIT the `extensions` field.

> The `exclude_dirs` list above is **always sent**, on top of the server's own built-in ignores (`node_modules`, `.git`, `dist`, `build`, etc.). It covers the `*_dev/` convention from the project-level rules (cache/tmp/runtime directories that must never be committed or scanned) plus other recurrent runtime/artifact folders. `use_gitignore: true` handles anything listed in `.gitignore` when the target is a git repo; `exclude_dirs` catches the rest for non-git trees.

## Step 3 — Extract report paths and persist them to a file

The MCP response from Step 2 already contains every `<source> -> <report>` pair (mode 0). Parse that response text and write ONE absolute report path per line to a shared temp file. Files persist across `Bash` tool calls (each Bash invocation is a separate subshell — env vars DO NOT persist, but `/tmp` files DO). Every later step reads from this file rather than re-parsing the MCP response.

```bash
RUN_TS=$(date +%Y%m%dT%H%M%S%z)
EXTRACTED="/tmp/llm-externalizer-scan-and-fix.$RUN_TS.extracted.txt"
VALIDATED="/tmp/llm-externalizer-scan-and-fix.$RUN_TS.validated.txt"
REJECTED="/tmp/llm-externalizer-scan-and-fix.$RUN_TS.rejected.txt"
REPORTS_DIR="$CLAUDE_PROJECT_DIR/reports/llm-externalizer"
: > "$EXTRACTED"
: > "$VALIDATED"
: > "$REJECTED"
```

Then emit one `printf '%s\n' "<absolute-path>" >> "$EXTRACTED"` command per report path you parsed from the MCP response (or build the list inline with a heredoc). Exclude any line already containing `.fixer.`. Pass the same `$RUN_TS` through subsequent Bash steps so the filenames stay consistent (or capture them into your conversation state).

Abort with `[FAILED] llm-externalizer-scan-and-fix — scan produced 0 reports` if `wc -l "$EXTRACTED"` shows zero.

### Step 3b — Script-validate every extracted report before dispatching fixers

Walk `$EXTRACTED` and run `validate_report.py` per line. Validated paths land in `$VALIDATED`; failures land in `$REJECTED`:

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

Dispatch fixers (Step 4) ONLY against `$VALIDATED`. If `wc -l "$VALIDATED"` is 0, abort with `[FAILED] llm-externalizer-scan-and-fix — all N reports failed validate_report.py`.

> Under the hood `validate_report.py` checks: report file exists / source file referenced inside it exists / source is inside `--project-dir` / every `lines N-M` range fits the source's line count. Delegating to the script makes every reference **script-enforced, not agent-trusted**.

**Do NOT `Read` any of these report files.** The `Read` tool is not even in the command's `allowed-tools` — this is enforced, not advisory. Report contents belong to the fixer agents.

### Token-budget note for very large scans

For scans producing more than ~200 reports, write the extracted path list to a tmp file with `Bash` and iterate it in batches of 15 via `sed -n "N,Mp"` rather than keeping the full list in a single assistant message. Peak context per batch stays at ~1.8 KB regardless of N. If `--file-list` is used with more than 200 paths, stop and suggest the user switch to a folder scan — `code_task`'s `input_files_paths` array forces the orchestrator to JSON-serialize every path once.

## Step 4 — Dispatch fixer agents (max 15 concurrent, sourced from `$VALIDATED`)

Read the validated path list from `$VALIDATED` in batches of 15 using `sed -n "START,ENDp"`:

```bash
TOTAL=$(wc -l < "$VALIDATED")
# First batch (lines 1-15):
sed -n '1,15p' "$VALIDATED"
# Next batch (lines 16-30):
sed -n '16,30p' "$VALIDATED"
# … and so on until TOTAL
```

For every path that batch returns, spawn one `llm-externalizer-fixer` subagent via the `Task` tool. The prompt is EXACTLY the absolute report path (one line, nothing else).

Batch rule:

- **Up to 15 Task calls in a single assistant message** → they run concurrently.
- If the batch size is > 15, emit 15 per message and wait for the batch to finish before sending the next. NEVER exceed 15 in flight at once.
- Each `Task` call:
  - `subagent_type: "llm-externalizer-fixer"`
  - `description: "Fix report: <basename>"` (≤5 words)
  - `prompt: "<absolute report path>"` (nothing else)

### IGNORE fixer return text — tokens saved by design

Each fixer returns one line (its `.fixer.`-summary path). **Discard that text.** The join script in Step 5 globs `$REPORTS_DIR` directly — it does NOT need the orchestrator to hand it the paths. Treating the fixer returns as informational-only saves ~100 chars × N orchestrator tokens (~25 KB for a 250-file scan).

The only reason to *look* at a fixer's return line is to check whether it starts with `[FAILED] `. For completed batches, you can count successes cheaply with `ls -1 "$REPORTS_DIR" | grep -cF '.fixer.'` (use `-F` for fixed-string, no regex needed — `.fixer.` contains only dots and lowercase letters so escaping is trivial, but fixed-string is faster and safer).

**Do NOT `Read` any fixer summary.** The content belongs to the join script alone.

## Step 5 — Count fixers + join reports

A single `Bash` step: detect the Python runner, count the `.fixer.` files, and call the join script. The final-report filename is **prefixed** with a sortable local-timezone ISO-8601 basic timestamp so `ls -1` in the reports dir sorts chronologically.

```bash
TS=$(date +%Y%m%dT%H%M%S%z)   # local time with UTC offset — sortable, unambiguous
REPORTS_DIR="$CLAUDE_PROJECT_DIR/reports/llm-externalizer"
FINAL="$REPORTS_DIR/${TS}.final-report.md"

# Runner detection — abort if neither python3 nor uv is available.
if command -v python3 >/dev/null 2>&1; then
    JOIN_RUNNER=(python3)
elif command -v uv >/dev/null 2>&1; then
    JOIN_RUNNER=(uv run --no-project)
else
    echo "[FAILED] llm-externalizer-scan-and-fix — no python3 or uv on PATH" >&2
    exit 1
fi

FIXED_COUNT=$(ls -1 "$REPORTS_DIR" 2>/dev/null | grep -cF '.fixer.')
"${JOIN_RUNNER[@]}" "${CLAUDE_PLUGIN_ROOT}/scripts/join_fixer_reports.py" \
  --input-dir "$REPORTS_DIR" \
  --output "$FINAL"
echo "M-FIXED=$FIXED_COUNT"
```

The join script runs the same validation internally (`validate_fixer_summary.py`'s checks inlined) and rejects malformed summaries — rejected files are recorded in the final-report header, not in the joined body.

The script prints one line — the `$FINAL` absolute path — on success. On exit code ≠ 0 it prints an error on stderr; surface it in the `[FAILED]` message.

**Do NOT `Read` `$FINAL`.** Its contents are the user's output, not the orchestrator's business.

## Step 6 — Return

Emit exactly ONE line to the user:

```
[DONE] llm-externalizer-scan-and-fix — <N-scanned> reports / <M-fixed> summaries → <FINAL-absolute-path>
```

On any error: `[FAILED] llm-externalizer-scan-and-fix — <one-line reason>`.

## Constraints

- `answer_mode` is hardcoded to `0`. Do NOT accept overrides from `$ARGUMENTS`.
- `output_dir` is hardcoded to `$CLAUDE_PROJECT_DIR/reports/llm-externalizer`. Do NOT accept overrides from `$ARGUMENTS`.
- You MUST NOT `Read` any scan report, fixer summary, or the final joined report.
- You MUST NOT summarize any report content. Only file paths flow through the orchestrator.
- Fixer dispatch MUST be parallel (batches of ≤15). Sequential dispatch defeats the whole design.
- The fixer agent (`llm-externalizer-fixer`) must exist in the plugin. If it is missing, abort with `[FAILED] llm-externalizer-scan-and-fix — llm-externalizer-fixer agent not installed`.
- Flags `--file-list` and the positional `[target-path]` are mutually exclusive in effect (the target-path is silently ignored when `--file-list` is set). Flags `--instructions` and `--specs` are NOT mutually exclusive — both can be supplied and are unioned into `instructions_files_paths`.

## Error handling

| Error                                | Resolution                                                                 |
|--------------------------------------|----------------------------------------------------------------------------|
| MCP service offline                  | Abort `[FAILED] — service offline`. Tell user to restart Claude Code.      |
| Target path / file-list / instructions / specs missing | Abort `[FAILED] — <which> not found: <path>`.                    |
| Scan returns 0 reports               | Abort `[FAILED] — scan produced 0 reports`. User should widen target.      |
| Fixer agent missing                  | Abort `[FAILED] — llm-externalizer-fixer agent not installed`.                      |
| Join script exits non-zero           | Abort `[FAILED] — join script failed: <stderr first line>`.                |
| `--free` + proprietary code implied  | Warn ONCE about provider prompt logging, then proceed on user confirmation.|
