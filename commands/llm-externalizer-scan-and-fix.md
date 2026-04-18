---
name: llm-externalizer-scan-and-fix
description: Two-stage codebase audit. LLM Externalizer scan produces one report per file; parallel sonnet- or opus-model fixer subagents (≤15 concurrent) verify and fix each finding. Orchestrator never reads scan or fixer content — only report paths.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__scan_folder
  - mcp__llm-externalizer__code_task
  - Bash
  - Task
argument-hint: "[target] [--file-list path] [--instructions path] [--specs path] [--free] [--no-secrets] [--text]"
---

Orchestrates a full **scan → per-file report → parallel fix → join** pass.

**HARDCODED (not overridable):**

- `answer_mode: auto` — `0` (ONE REPORT PER FILE) by default, **automatically upgraded to `1` (ONE REPORT PER GROUP) if the `--file-list` contains `---GROUP:id---` markers**. Either way, each report is dispatched to exactly one fixer agent with zero orchestrator-side consolidation — the fixer doesn't care whether a report covers one file or a whole group; it just verifies and fixes the findings inside.
- `output_dir: $CLAUDE_PROJECT_DIR/reports/llm-externalizer/` — required so the join script can find every `.fixer.`-tagged summary.

## ⚠️ Cross-file / cross-reference limitation — MUST READ

The LLM used by this command sees only **1–5 files per request** (FFD bin-packed into ~400 KB batches, or one group per request when `---GROUP:id---` markers are supplied). It **cannot see the whole codebase at once**, period. That has a hard consequence:

- The LLM **cannot reliably verify that a reference in file A exists in file B** (or anywhere else). When you ask the default rubric to "find broken references", "check if this API call is valid", "verify symbol reachability", or anything that needs to cross-check against files NOT in the current 1–5-file batch, the LLM **hallucinates** — it guesses based on what "looks plausible", not on what actually exists.
- The default scan rubric's "5) Broken references" line is a best-effort heuristic for obvious local breakage (e.g. a function called in the same file that doesn't exist in that file). It does NOT mean the LLM has validated every imported symbol across the codebase — it hasn't.

**If you need cross-file reference validation, DO NOT use the default rubric. Use one of these two tools instead:**

1. **`mcp__llm-externalizer__check_against_specs`** (the equivalent of a `validate-against-specs` command) — you provide the explicit API surface / spec file, the tool compares each source file against the spec. Every batch sees its source + the spec, so each reference is validated against an authoritative list instead of against "whatever the LLM thinks might exist". Pass the spec to this command via `--specs <path>` for the same effect.
2. **`mcp__llm-externalizer__search_existing_implementations`** (exposed as `/llm-externalizer:llm-externalizer-search-existing-implementations`) — for semantic duplicate hunts ("is feature X already implemented somewhere?"). Each file is compared against a REFERENCE (description + optional source files + optional diff), NOT against every other file. Purpose-built for cross-codebase questions that an AST / schema check cannot answer.

For everything else — logic bugs, error handling, security, resource leaks in the local function — the 1–5-file batch is enough and this command is the right tool. Just don't ask it questions that require global visibility.

**Why answer_mode is fixed at 0 or 1 (never 2):** Mode 2 produces one merged report covering every scanned file, which would force the orchestrator to read and split that file to build per-fixer tasks — burning exactly the tokens this command is designed to save. Mode 0 (per-file) and mode 1 (per-group) both emit multiple report FILES — the orchestrator only ever touches file paths (scan report paths → fixer prompts → fixer summary paths → join script input). No report content ever enters the orchestrator context. The auto-switch between 0 and 1 is safe: a group report is dispatched to exactly one fixer agent the same way a per-file report is, so the rest of the pipeline doesn't need to know.

## Arguments

Parse `$ARGUMENTS` into:

- `[target-path]` (positional, optional): absolute folder to scan. Relative paths resolve against `$CLAUDE_PROJECT_DIR`. **If omitted (and `--file-list` is also omitted), the orchestrator runs an auto-discovery pass (Step 0 below) that builds a curated file list and presents it for confirmation. It does NOT silently default to `.` or `$CLAUDE_PROJECT_DIR` and does NOT just hand a folder to `scan_folder` — silent defaults + blind folder scans dilute the audit with docs, examples, samples, and generated output while exposing fixers to non-source content.**
- `--text`: include plain-text formats (`.md .txt .json .yml .yaml .toml .ini .cfg .conf .xml .html .rst .csv`) in the scan. Without this flag, `scan_folder` uses its default source-code extensions.
- `--file-list <path>`: absolute path to a `.txt` file with ONE absolute file path per line. When present, the command routes through `code_task` and scans exactly those files (positional target-path is ignored).
- `--instructions <path>`: absolute path to an `.md` file whose contents become the scan instructions. Replaces the default audit rubric.
- `--specs <path>`: absolute path to an `.md` specification file. Appended to `instructions_files_paths`; the scan checks each file against the spec.
- `--no-secrets`: disables the pre-scan secret detector (`scan_secrets: false`, `redact_secrets: false`). Default behaviour is `scan_secrets: true` + `redact_secrets: true` — secrets are detected and REDACTED (replaced by `[REDACTED:LABEL]`) before the files reach the LLM, so the scan keeps running. Use this flag only when you've already moved secrets to `.env` (gitignored) and want to skip the redaction pass.
- `--free`: use the free Nemotron model (`free: true`). Warn once about provider prompt logging before running on proprietary code; proceed only after user confirms or when the argument was explicit.

Abort with `[FAILED] llm-externalizer-scan-and-fix — <one-line reason>` on any validation failure.

## Step 0 — Auto-discover the codebase (only when the user supplied NO target-path AND NO --file-list)

The agent — not a blind glob — curates the scan target. Humans cannot reliably name every codebase folder and a folder glob cannot tell documentation from source. Only an agent can judge what is *really* part of the codebase.

1. **Find the real codebase root.** `scan_folder` on `$CLAUDE_PROJECT_DIR` is the wrong default when the project dir is a workspace / parent containing multiple repos, sibling projects, or runtime output.
   - Try `git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null`. If that succeeds, the stdout IS the codebase root.
   - Otherwise search for git repos nested up to 3 levels deep: `find "$CLAUDE_PROJECT_DIR" -maxdepth 3 -type d -name '.git' -not -path '*/node_modules/*' -not -path '*/.claude/*' 2>/dev/null`.
     - Exactly one match → use its parent directory as the root.
     - More than one match → STOP, list the candidates, ask the user which repo to target.
     - Zero matches → STOP, ask the user for an explicit target path.

2. **Enumerate tracked files inside the root.** `git -C <root> ls-files` respects `.gitignore`, skips untracked/ignored content, and gives a clean baseline. Never scan anything git doesn't track.

3. **Filter with agent judgment.** The list from `git ls-files` still includes non-source entries — the orchestrator (the agent) uses project conventions to drop them. Typical exclusions:
   - Documentation directories: `docs/`, `doc/`, `documentation/`, external-API reference dumps like `docs/openrouter/`
   - Project-level meta: `CHANGELOG.md`, `LICENSE`, `LICENSE.*`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `README.md` (judgment call — include only when the scan's purpose covers docs AND `--instructions` says what to check for)
   - **ALL `.md` files** including agent / command / skill definitions (`agents/*.md`, `commands/*.md`, `skills/**/*.md`). See the dedicated rule below.
   - Examples, samples, fixtures, templates, snapshots: `examples/`, `samples/`, `fixtures/`, `templates/`, `__snapshots__/`, `.snap` files
   - Build / bundled output: `dist/`, `build/`, pre-compiled bundles (even if committed)
   - Lock files: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Cargo.lock`, `Pipfile.lock`
   - Binary / asset files: `*.{png,jpg,jpeg,gif,svg,webp,ico,pdf,zip,tar,tar.gz,mp4,mov,bin,wasm,woff,woff2,ttf,otf,eot}`
   - Vendored deps: `vendor/`, `third_party/`, anything under `*/node_modules/`
   - Runtime artifacts even if tracked by accident: `*_dev/`, `reports/`, generated output

   What to KEEP is everything that is real source: source code in the project's primary languages (`.py`, `.ts`, `.tsx`, `.js`, `.go`, `.rs`, `.java`, `.rb`, `.php`, `.c`, `.cc`, `.cpp`, `.cs`, `.swift`, `.dart`, `.ex`, `.lua`, `.sh`, etc.) plus structured configs that ship as part of the product (`plugin.json`, `.mcp.json`, `pyproject.toml`, `tsconfig.json`, `package.json`). Use the user's project conventions — when in doubt, prefer excluding over including.

   ### Rule: `.md` files are EXCLUDED by default — even plugin-authored ones

   The default scan rubric ("logic bugs, error handling gaps, security issues, resource leaks, broken references") is a source-code audit. It has **no meaningful application to prose**: there's no control flow in an agent definition, no null-pointer risk in a SKILL.md, no resource leak in a command description. If the orchestrator feeds a .md file to the default rubric, the LLM has no idea what to check for and will either hallucinate findings or produce empty reports — both wasteful.

   Therefore: auto-curation ALWAYS drops every `.md` file from the list. The only way to include .md files in a scan is for the user to pass an explicit `--instructions <path>` flag whose content tells the LLM concretely what to search for — the kind of thing only a human reader / semantic match can do. Good examples:

   - *"Find every reference to the old command names `/llm-externalizer:discover`, `/llm-externalizer:configure`, `/llm-externalizer:scan-and-fix`, `/llm-externalizer:search-existing-implementations` and replace with the prefixed names `/llm-externalizer:llm-externalizer-*`."*
   - *"Find every reference to the agent names `llm-ext-fixer` or `llm-ext-reviewer` (old) and update to `llm-externalizer-fixer` / `llm-externalizer-reviewer`."*
   - *"Find every hardcoded OpenRouter model id in the examples and replace it with `{model-id}` placeholders."*
   - *"List every TODO / FIXME / XXX comment and categorize by urgency (blocking, nice-to-have, stale)."*
   - *"Find every code snippet that still shows the pre-v4 API surface (e.g. old `answer_mode: 1` defaults, old response shapes) and flag them for update."*
   - *"Locate every explanation of the `--free` flag and confirm it mentions the provider prompt-logging caveat."*

   > **Do NOT use this command to do structural validation of plugin files** — frontmatter schema, argument-hint consistency with the command body, skill description / tool coverage, plugin.json conformance, skill directory layout, agent.tools allowlist correctness, etc. Those checks are deterministic, cheap, and belong to dedicated validators:
   >
   >   - **`claude-plugin-validation`** (CPV) — `cpv-validate-plugin`, `cpv-validate-skill`, `cpv-semantic-validation`, etc. — run thousands of rules in milliseconds, return reproducible errors.
   >   - **`claude plugin validate .`** — the authoritative Claude Code CLI validator for plugin schema.
   >   - **Project-local validation scripts** — AST / schema parsers give you O(file-size) deterministic answers.
   >
   > An LLM doing the same work is orders of magnitude more expensive, non-reproducible, and prone to hallucinated findings. Reserve LLM .md scans for things a validator literally cannot do: fuzzy reference hunting, semantic consistency checks, stale-snippet detection, and user-authored instruction sets.

   When the user provides such `--instructions`, auto-curation INCLUDES `.md` files in the relevant subtrees (agent/command/skill definitions, docs the user pointed at) and lets the scan run. Without explicit instructions, they stay excluded.

4. **Write the curated list to a tmp file.**
   ```bash
   RUN_TS=$(date +%Y%m%dT%H%M%S%z)
   AUTO_LIST="/tmp/llm-externalizer-scan-and-fix.$RUN_TS.auto-filelist.txt"
   : > "$AUTO_LIST"
   # emit one absolute path per line via printf or a heredoc
   ```

5. **Show a terse summary, then ask via `AskUserQuestion`.** Print only:
   - `Codebase root: <path>` (one line)
   - `Files: N (<dir1>: n, <dir2>: n, …)` (one line)
   - `Included e.g.: <3-5 paths>` (one line)
   - `Excluded e.g.: <3-5 paths>` (one line)

   Then call **`AskUserQuestion`** with a multiple-choice menu. Default (first option) is `Proceed` so the user can just press Enter:

   ```
   question: "Proceed with the scan?"
   options:
     - label: "Proceed"
       description: "Scan the N curated files and continue."
     - label: "Edit list"
       description: "Pause so I can prune the tmp file list, then re-invoke with --file-list."
     - label: "Cancel"
       description: "Abort cleanly — no scan."
   ```

6. Map the user's answer:
   - `Proceed` → treat the tmp file as an implicit `--file-list $AUTO_LIST` and continue from Step 1 in Branch-A mode.
   - `Edit list` → print the tmp path and stop.
   - `Cancel` → abort cleanly.

## Step 1 — Validate inputs

Using `Bash`:

1. Resolve the reports directory:
   ```bash
   REPORTS_DIR="$CLAUDE_PROJECT_DIR/reports/llm-externalizer"
   mkdir -p "$REPORTS_DIR"
   ```
2. If `--file-list <path>` is set (either user-provided or produced by Step 0): `test -f <path>` and read it with `cat` → build an array of non-empty, non-comment lines. Abort if the file is empty.
3. If `--instructions <path>` is set: `test -f <path>`. Abort if missing.
4. If `--specs <path>` is set: `test -f <path>`. Abort if missing.
5. If the user supplied a target-path (not auto-discovered in Step 0): resolve it to an absolute path and `test -d` it. Abort with `[FAILED] llm-externalizer-scan-and-fix — target path not found: <path>` if missing.

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
- Neither (default rubric — REPORT ONLY REAL BUGS, RESPECT CODING STYLE):

```
Audit each file for REAL DEFECTS only. A real defect is:
  1) Logic bug — code does not do what its name, docstring, or the surrounding context says it should; wrong conditionals, off-by-one, unreachable code, typos in expressions, incorrect default values, broken state transitions.
  2) Crash / unintended exception — code path that will throw or segfault under documented inputs and is not meant to.
  3) Security vulnerability with a concrete exploit path — shell injection (unquoted "$VAR" interpolation), path traversal, unsafe deserialization, secret exposure, auth bypass, SSRF.
  4) Resource leak that actually causes unbounded growth, deadlock, or starvation — NOT "file not closed in a short-lived script that exits anyway".
  5) Data corruption — a write that produces malformed state.
  6) Functionality not matching its contract — documented input-output mismatch, missing branch for a documented case.
  7) Broken reference visible WITHIN this file — function called but not defined in this file, attribute accessed that the class does not declare, import referencing a non-existent symbol.

DO NOT REPORT (these are coding-style choices, not bugs — respect the author's style):
  * Missing try/except or error handling. Fail-fast is a valid, deliberate choice. Do NOT recommend adding defensive wrappers.
  * Missing null / None / undefined checks. Type-checker / upstream contract handles this.
  * Missing input validation for internal-only functions. Boundaries already validate.
  * "Could be more robust" / "consider using". Suggestions ≠ defects.
  * "Should add logging / comments / type hints / docstrings". Documentation preferences are not bugs.
  * Refactoring suggestions (split this function, rename this variable, use comprehension here). Style, not bugs.
  * Warnings about hypothetical future scenarios. Report only what is actually broken today.
  * Assertions / invariants the author removed on purpose.
  * Performance micro-optimizations when the code is not on a hot path.

VERIFICATION RULE FOR EACH FINDING:
  Before reporting, ask: "Does this claim describe code that actually misbehaves on documented inputs?" If the answer is "only under attacker-controlled input" → security finding (OK to report with the exploit path). If the answer is "only if the author had coded defensively against themselves" → coding-style, DO NOT REPORT.

Respect the coding style of the source file. Fail-fast code, no backwards-compat, no defensive checks, minimal docstrings, compact expressions — these are style choices. Do NOT push a different style onto the author.

Reference function names and line numbers. Be terse. One line per finding. No preamble.
```

Add the flags:

- `--free` → `"free": true`
- `--no-secrets` → `"scan_secrets": false, "redact_secrets": false`
- **Default (no `--no-secrets`)** → `"scan_secrets": true, "redact_secrets": true` — ALWAYS pair these. Scan ON + redact ON means secrets are replaced with `[REDACTED:LABEL]` and the run continues; scan ON + redact OFF would abort on any finding, which is more disruptive than the redacting default.

**Auto-detect answer_mode** — compute BEFORE building the scan JSON:

```bash
# Default: per-file reports
ANSWER_MODE=0
# If --file-list is set and contains at least one ---GROUP:<id>--- marker,
# upgrade to per-group reports. Grep is lenient about trailing whitespace.
if [ -n "$FILE_LIST_PATH" ] && grep -Eq '^---GROUP:[A-Za-z0-9_.-]+---[[:space:]]*$' "$FILE_LIST_PATH"; then
    ANSWER_MODE=1
fi
echo "ANSWER_MODE=$ANSWER_MODE"
```

If `ANSWER_MODE=1`, log a one-line notice to the user (`File list contains group markers — using answer_mode=1 (one report per group)`) so they know why the output shape differs from the default.

Common tool arguments (ALWAYS present, NOT overridable):

```json
{
  "answer_mode": <ANSWER_MODE>,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer"
}
```

### Branch A — `--file-list` supplied

Call `mcp__llm-externalizer__code_task`:

```json
{
  "answer_mode": <ANSWER_MODE>,
  "max_retries": 3,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer",
  "input_files_paths": ["<each absolute path from the list file — PASS THROUGH the ---GROUP:id--- markers verbatim if present; the MCP server parses them>"],
  "instructions": "<see above>",
  "instructions_files_paths": ["<if applicable>"],
  "free": <if applicable>,
  "scan_secrets": <default true; --no-secrets: false>,
  "redact_secrets": <default true; --no-secrets: false>
}
```

### Branch B — folder scan (default)

`scan_folder` does not accept group markers (it auto-discovers paths). Always use `ANSWER_MODE=0` on this branch — if the user wanted grouping, they'd pass an explicit `--file-list`.

Call `mcp__llm-externalizer__scan_folder`:

```json
{
  "folder_path": "<absolute target-path>",
  "answer_mode": 0,
  "use_gitignore": true,
  "output_dir": "<CLAUDE_PROJECT_DIR>/reports/llm-externalizer",
  "extensions": ["<only if --text>"],
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
  "scan_secrets": <default true; --no-secrets: false>,
  "redact_secrets": <default true; --no-secrets: false>
}
```

With `--text`, set `extensions: [".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".html", ".rst", ".csv"]`. Without it, OMIT the `extensions` field.

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

## Step 4a — Pre-fix checkpoint (mandatory)

Before any fixer touches source, the working tree must be clean enough to revert. Call `Bash` from the codebase root:

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    # Uncommitted work exists — create a checkpoint the user can diff against.
    STAMP=$(date +%Y%m%dT%H%M%S%z)
    git add -A \
      && git commit -m "chore(checkpoint): pre-scan-and-fix $STAMP" \
      && echo "Checkpoint commit created. Revert with: git reset --soft HEAD~1"
  else
    echo "Working tree clean — no checkpoint needed."
  fi
else
  echo "Not a git repo — the user is responsible for backups."
fi
```

Do NOT use `AskUserQuestion` here — checkpointing is always cheap and always safe; a menu would add a prompt for nothing. Just print the one-line result and move on.

## Step 4b — Pick the fixer model

Ask via `AskUserQuestion`. Default (first option) is `Sonnet` so the user can press Enter:

```
question: "Which model should the fixers use?"
options:
  - label: "Sonnet"
    description: "Faster, cheaper. Recommended default."
  - label: "Opus"
    description: "Slower, more thorough. Pick for high-stakes or subtle bugs."
```

Map the answer to the agent name:

- `Sonnet` → `FIXER_AGENT="llm-externalizer-parallel-fixer-sonnet-agent"`
- `Opus`   → `FIXER_AGENT="llm-externalizer-parallel-fixer-opus-agent"`

## Step 4c — Dispatch fixer agents (max 15 concurrent, sourced from `$VALIDATED`)

Read the validated path list from `$VALIDATED` in batches of 15 using `sed -n "START,ENDp"`:

```bash
TOTAL=$(wc -l < "$VALIDATED")
# First batch (lines 1-15):
sed -n '1,15p' "$VALIDATED"
# Next batch (lines 16-30):
sed -n '16,30p' "$VALIDATED"
# … and so on until TOTAL
```

For every path that batch returns, spawn one `$FIXER_AGENT` subagent via the `Task` tool. The prompt is EXACTLY the absolute report path (one line, nothing else).

Batch rule:

- **Up to 15 Task calls in a single assistant message** → they run concurrently.
- If the batch size is > 15, emit 15 per message and wait for the batch to finish before sending the next. NEVER exceed 15 in flight at once.
- Each `Task` call:
  - `subagent_type: "$FIXER_AGENT"` (either `…-sonnet-agent` or `…-opus-agent`, depending on Step 4b)
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

- `answer_mode` is chosen by the command itself: `0` (per-file) by default, `1` (per-group) when `--file-list` contains `---GROUP:id---` markers, on `scan_folder` always `0`. Never `2`. Do NOT accept overrides from `$ARGUMENTS`.
- `output_dir` is hardcoded to `$CLAUDE_PROJECT_DIR/reports/llm-externalizer`. Do NOT accept overrides from `$ARGUMENTS`.
- You MUST NOT `Read` any scan report, fixer summary, or the final joined report.
- You MUST NOT summarize any report content. Only file paths flow through the orchestrator.
- Fixer dispatch MUST be parallel (batches of ≤15). Sequential dispatch defeats the whole design.
- Both fixer-agent variants (`llm-externalizer-parallel-fixer-sonnet-agent` and `…-opus-agent`) must exist in the plugin. If the variant the user picked in Step 4b is missing, abort with `[FAILED] llm-externalizer-scan-and-fix — <agent-name> not installed`.
- Flags `--file-list` and the positional `[target-path]` are mutually exclusive in effect (the target-path is silently ignored when `--file-list` is set). Flags `--instructions` and `--specs` are NOT mutually exclusive — both can be supplied and are unioned into `instructions_files_paths`.

## Error handling

| Error                                | Resolution                                                                 |
|--------------------------------------|----------------------------------------------------------------------------|
| MCP service offline                  | Abort `[FAILED] — service offline`. Tell user to restart Claude Code.      |
| Target path / file-list / instructions / specs missing | Abort `[FAILED] — <which> not found: <path>`.                    |
| Scan returns 0 reports               | Abort `[FAILED] — scan produced 0 reports`. User should widen target.      |
| Selected fixer variant missing       | Abort `[FAILED] — <agent-name> not installed` (where `<agent-name>` is the variant picked in Step 4b). |
| Join script exits non-zero           | Abort `[FAILED] — join script failed: <stderr first line>`.                |
| `--free` + proprietary code implied  | Warn ONCE about provider prompt logging, then proceed on user confirmation.|
