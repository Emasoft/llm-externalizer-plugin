---
name: llm-externalizer-scan-and-fix-serially
description: Scan a codebase, aggregate findings into one canonical bug list, then fix each bug serially with `llm-externalizer-serial-fixer-agent`. Use when fixes mutate shared state or bug order matters.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__scan_folder
  - mcp__llm-externalizer__code_task
  - Bash
  - Task
argument-hint: "[target] [--file-list path] [--instructions path] [--specs path] [--free] [--no-secrets] [--text]"
---

Two-phase audit that mirrors `/llm-externalizer:llm-externalizer-scan-and-fix` exactly through the scan phase, then diverges at the fix step: instead of dispatching up to 15 parallel `llm-externalizer-parallel-fixer-agent` subagents (one per report), it aggregates every finding into one canonical bug list and dispatches one `llm-externalizer-serial-fixer-agent` **per bug, in a serial loop**, until none remain.

**HARDCODED (not overridable):**

- `answer_mode: auto` — `0` (ONE REPORT PER FILE) by default, **automatically upgraded to `1` (ONE REPORT PER GROUP) if the `--file-list` contains `---GROUP:id---` markers**. The aggregator walks every `.md` in the reports dir regardless of mode, so both work; mode 1 is more efficient when logically related files share an audit (the LLM sees them together in one request).
- `output_dir: $CLAUDE_PROJECT_DIR/reports/llm-externalizer/` — required so the aggregator finds every scan report and the bug list shares a directory with them.
- Never more than **1** concurrent Task call in the fix loop. Bug order matters here — do not parallelise.

**Picking this vs `scan-and-fix`:** parallel fixers race on shared state (imports, types, schemas, shared mocks) and fix bugs in an arbitrary per-file order. This command is for audits where later fixes depend on earlier ones, or where the same shared file is edited by multiple findings. For independent per-file fixes, `/llm-externalizer:llm-externalizer-scan-and-fix` is faster on wall-clock time.

## ⚠️ Cross-file / cross-reference limitation — MUST READ

The LLM used by this command sees only **1–5 files per request** (FFD bin-packed into ~400 KB batches, or one group per request when `---GROUP:id---` markers are supplied). It **cannot see the whole codebase at once**, period. That has a hard consequence:

- The LLM **cannot reliably verify that a reference in file A exists in file B** (or anywhere else). When you ask the default rubric to "find broken references", "check if this API call is valid", "verify symbol reachability", or anything that needs to cross-check against files NOT in the current 1–5-file batch, the LLM **hallucinates** — it guesses based on what "looks plausible", not on what actually exists.
- The default scan rubric's "5) Broken references" line is a best-effort heuristic for obvious local breakage (e.g. a function called in the same file that doesn't exist in that file). It does NOT mean the LLM has validated every imported symbol across the codebase — it hasn't.

**If you need cross-file reference validation, DO NOT use the default rubric. Use one of these two tools instead:**

1. **`mcp__llm-externalizer__check_against_specs`** — provide an explicit API surface / spec file; the tool compares each source file against the spec. Every batch sees its source + the spec, so each reference is validated against an authoritative list instead of against "whatever the LLM thinks might exist". Pass the spec to this command via `--specs <path>` for the same effect.
2. **`mcp__llm-externalizer__search_existing_implementations`** (exposed as `/llm-externalizer:llm-externalizer-search-existing-implementations`) — for semantic duplicate hunts ("is feature X already implemented somewhere?"). Each file is compared against a REFERENCE (description + optional source files + optional diff), NOT against every other file. Purpose-built for cross-codebase questions that an AST / schema check cannot answer.

For everything else — logic bugs, error handling, security, resource leaks in the local function — the 1–5-file batch is enough and this command is the right tool. Just don't ask it questions that require global visibility.

## Arguments

Parse `$ARGUMENTS` into:

- `[target-path]` (positional, optional): absolute folder to scan. Relative paths resolve against `$CLAUDE_PROJECT_DIR`. **If omitted (and `--file-list` is also omitted), the orchestrator runs an auto-discovery pass (Step 0 below) that builds a curated file list and presents it for confirmation. It does NOT silently default to `.` or `$CLAUDE_PROJECT_DIR` and does NOT just hand a folder to `scan_folder` — silent defaults + blind folder scans dilute the audit with docs, examples, samples, and generated output while exposing fixers to non-source content.**
- `--text`: include plain-text formats (`.md .txt .json .yml .yaml .toml .ini .cfg .conf .xml .html .rst .csv`) in the scan. Without this flag, `scan_folder` uses its default source-code extensions.
- `--file-list <path>`: absolute path to a `.txt` file with ONE absolute file path per line. When present, the command routes through `code_task` and scans exactly those files (positional target-path is ignored).
- `--instructions <path>`: absolute path to an `.md` file whose contents become the scan instructions. Replaces the default audit rubric.
- `--specs <path>`: absolute path to an `.md` specification file. Appended to `instructions_files_paths`; the scan checks each file against the spec.
- `--no-secrets`: disables the pre-scan secret detector (`scan_secrets: false`).
- `--free`: use the free Nemotron model (`free: true`). Warn once about provider prompt logging before running on proprietary code; proceed only after user confirms or when the argument was explicit.

Abort with `[FAILED] llm-externalizer-scan-and-fix-serially — <one-line reason>` on any validation failure.

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

5. **Show the user the curated list before committing.** Print ONLY:
   - Codebase root (`git rev-parse --show-toplevel` result).
   - Total file count, breakdown by top-level directory (e.g. `mcp-server/src: 18, scripts: 6, agents: 2, commands: 4, skills: 11`).
   - 3–5 representative included paths.
   - 3–5 representative EXCLUDED paths (so the user can sanity-check the filter).
   - Ask one question: "Proceed with these N files? [y / edit list / cancel]". Do NOT auto-run.

6. On confirm, treat the tmp file as if the user had supplied `--file-list $AUTO_LIST` and continue from Step 1 in Branch-A mode. On "cancel", abort cleanly. On "edit list", surface the tmp path so the user can prune it and re-invoke with `--file-list <that-path>`.

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
5. If the user supplied a target-path (not auto-discovered in Step 0): resolve it to an absolute path and `test -d` it. Abort with `[FAILED] llm-externalizer-scan-and-fix-serially — target path not found: <path>` if missing.

Then call `mcp__llm-externalizer__discover`. Abort with `[FAILED] llm-externalizer-scan-and-fix-serially — service offline` if the service is offline.

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
- `--no-secrets` → `"scan_secrets": false`

**Auto-detect answer_mode** — compute BEFORE building the scan JSON:

```bash
ANSWER_MODE=0
if [ -n "$FILE_LIST_PATH" ] && grep -Eq '^---GROUP:[A-Za-z0-9_.-]+---[[:space:]]*$' "$FILE_LIST_PATH"; then
    ANSWER_MODE=1
fi
echo "ANSWER_MODE=$ANSWER_MODE"
```

If `ANSWER_MODE=1`, log `File list contains group markers — using answer_mode=1 (one report per group)` to the user.

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
  "input_files_paths": ["<each absolute path from the list file — pass ---GROUP:id--- markers through verbatim>"],
  "instructions": "<see above>",
  "instructions_files_paths": ["<if applicable>"],
  "free": <if applicable>,
  "scan_secrets": <if --no-secrets: false>
}
```

### Branch B — folder scan (default)

`scan_folder` does not accept group markers — always use `answer_mode: 0` on this branch.

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
  "scan_secrets": <if --no-secrets: false>
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

Abort with `[FAILED] llm-externalizer-scan-and-fix-serially — scan produced 0 reports` if `wc -l "$EXTRACTED"` shows zero.

### Step 3b — Script-validate every extracted report before the aggregator

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

If `wc -l "$VALIDATED"` is 0, abort with `[FAILED] llm-externalizer-scan-and-fix-serially — all N reports failed validate_report.py`.

> Under the hood `validate_report.py` checks: report file exists / source file referenced inside it exists / source is inside `--project-dir` / every `lines N-M` range fits the source's line count. Delegating to the script makes every reference **script-enforced, not agent-trusted**.

**Do NOT `Read` any of these report files.** The `Read` tool is not even in the command's `allowed-tools` — this is enforced, not advisory. Report contents belong to the aggregator / serial fixer agents.

> **The entire scan phase above (Step 0 through Step 3b) is IDENTICAL to `/llm-externalizer:llm-externalizer-scan-and-fix`.** The only per-command difference is the `[FAILED] …` prefix string. If the scan rubric, flag semantics, or validation logic changes in one command, update the other too.

## Step 4 — Init run + aggregate validated reports into one canonical bug list

Phase 2. The scan produced N per-file reports under `./reports/llm-externalizer/`. Now collapse their findings into one canonical bug list so the serial loop can fix them one at a time.

```bash
H='python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fix_found_bugs_helper.py"'
eval "$H init-run" | while IFS='=' read -r k v; do export "$k=$v"; done
# Exports: RUN_TS (run-scoped, may differ from the scan's $RUN_TS — both are sortable), OUTDIR, BUGS_TO_FIX, INITIAL_STATE, SNAPSHOT, SUMMARY, PROGRESS_LOG

eval "$H aggregate-reports \
  --reports-dir \"$REPORTS_DIR\" \
  --output \"$BUGS_TO_FIX\""
```

The aggregator handles per-file, ensemble (3 `## Response (Model: X)` sections per file), and merged report shapes transparently. Severity is assigned by keyword (security/crash/race/data-corruption → High; style/naming/readability/docstring → Low; everything else → Medium) — good enough to order the loop; the serial-fixer-agent re-classifies per finding.

Do NOT pass `--skip-if-fixer-exists` here — the scan we just ran has no sibling `.fixer.` files (no parallel-fixer-agent was dispatched), so the flag is a no-op. Keep it out of the call to avoid misleading future readers.

If the aggregator writes a file with 0 `### ` entries, stop with `Nothing to do — scan produced reports but no aggregatable findings.` and jump to Step 7.

## Step 5 — Canonicalise + initial snapshot

```bash
eval "$H is-canonical --file \"$BUGS_TO_FIX\""
# exit 0 = canonical; exit 1 = needs normalisation (see rules below), then continue
eval "$H count --file \"$BUGS_TO_FIX\""              # parse TOTAL, UNFIXED, MAX_ITER
eval "$H fixed-titles --file \"$BUGS_TO_FIX\" > \"$INITIAL_STATE\""
cp "$INITIAL_STATE" "$SNAPSHOT"
```

**Normalisation** (only when `is-canonical` exits 1): rewrite the bug list in place so every bug is a `### N. Title` heading under one of `## High severity`, `## Medium severity`, `## Low severity`. Promote bullet-item bugs to `### N.` headings; reparent sub-severity labels (`### Critical` → High, `### Medium` → Medium, `### Minor` → Low); move non-canonical `## ` sections under the right severity. Renumber `### N.` entries sequentially across the file. Never rephrase, summarise, or drop bug bodies or FIXED postmortems.

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

- `USE_CUSTOM=1` → `subagent_type: "llm-externalizer-serial-fixer-agent"`, `prompt: "$BUGS_TO_FIX"` (bare absolute path, nothing else).
- `USE_CUSTOM=0` → `subagent_type: "general-purpose"`, `prompt: $($H print-fallback-prompt --file "$BUGS_TO_FIX")`.

Model defaults to `opus`; honour any user request for sonnet/haiku by passing `model:` on the Task call.

For `i = 1 .. MAX_ITER`, maintain `stuck_streak = 0`, `prev_unfixed`, `prev_total`:

1. `$H count --file "$BUGS_TO_FIX"`. If `UNFIXED=0`, break — all done.
2. Dispatch ONE `Task` call. Read its return line. If it starts with `[FAILED]`, break and surface the reason.
3. Append the return line to `$PROGRESS_LOG`:
   ```bash
   printf '%s\n' "$TASK_RETURN_LINE" >> "$PROGRESS_LOG"
   ```
4. Surface progress to the user:
   ```bash
   $H diff-fixed --file "$BUGS_TO_FIX" --previous "$SNAPSHOT"
   ```
   Emit each output line verbatim — they are `Fixed: <title> — N unfixed remaining` (plus similar lines for False-positive and CANTFIX closures).
5. Refresh the snapshot:
   ```bash
   $H fixed-titles --file "$BUGS_TO_FIX" > "$SNAPSHOT"
   ```
6. Re-run `$H count`. If `cur_unfixed >= prev_unfixed` AND `cur_total <= prev_total`, `stuck_streak += 1`. If `stuck_streak >= 2`, break ("No progress for 2 iterations, stopping.").
7. Update `prev_unfixed`, `prev_total` and continue.

**Never exceed 1 concurrent Task call.** Do not rewrite this step to parallelise.

## Step 7 — Final summary

```bash
eval "$H save-summary \
  --file \"$BUGS_TO_FIX\" \
  --output \"$SUMMARY\" \
  --run-start-ts \"$RUN_TS\""
```

Print the summary's absolute path to the user. Also mention: bugs fixed this run, bugs still unfixed, any new `### N.` entries the serial-fixer-agent appended during the loop (per its rule 7 — newly-discovered bugs are queued for the next iteration).

**Do NOT commit.** The user reviews diffs and commits themselves.

## Safety rails

- Iteration cap: `MAX_ITER = max(UNFIXED_START * 2 + 5, 5)` (computed by `$H count`).
- Stuck detection: 2 consecutive iterations with no progress → break.
- Hard stop on `[FAILED] ...` return from a subagent.
- Zero parent-conversation inheritance (each Task spawn is fresh; user/project CLAUDE.md load the same way they did under `claude -p`).
- No background processes. Ending the parent session stops the loop cleanly between iterations.
- No commits.
- All output files live under `./reports/llm-externalizer/` with a `<RUN_TS>.fix-found-bugs.*` prefix.

## Error handling

| Error | Resolution |
|---|---|
| MCP service offline | `[FAILED] — service offline`. Ask user to restart Claude Code. |
| Target / file-list / instructions / specs missing | `[FAILED] — <which> not found: <path>`. |
| Scan returns 0 reports | `[FAILED] — scan produced 0 reports`. User should widen target. |
| All reports fail `validate_report.py` | `[FAILED] — all N reports failed validate_report.py`. |
| Aggregator produces 0 findings | Stop with `Nothing to do — no aggregatable findings.` (not a failure). |
| Serial-fixer-agent missing | Fall back to `general-purpose` with `print-fallback-prompt`. |
| Subagent returns `[FAILED] …` | Relay verbatim and stop. |
| `--free` + proprietary code implied | Warn ONCE about provider prompt logging, then proceed on user confirmation. |
