---
name: llm-externalizer-high-quality-scan-and-fix
description: High-quality two-stage audit. ONE strong remote model (default z-ai/glm-5.2, max reasoning + cache) scans each file via high_quality_scan; then parallel Opus fixer subagents (≤15) verify and fix each finding in the same run. Paid + OpenRouter-only — fails fast on a local backend, free_only, or no credit. Orchestrator never reads scan or fixer content, only report paths.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__high_quality_scan
  - Bash
  - Task
argument-hint: '<folder> [--instructions path] [--specs path] [--text] [--no-secrets]'
---

The **high-quality** twin of `/llm-externalizer:llm-externalizer-scan-and-fix`. Two differences, everything else is the same scan → per-file report → parallel fix → join pipeline:

1. **Scan** uses `mcp__llm-externalizer__high_quality_scan` — ONE strong remote model (default `z-ai/glm-5.2`) at max reasoning effort + prompt cache, NOT the cheap 3-model ensemble.
2. **Fix** always runs on **Opus** (the `llm-externalizer-parallel-fixer-opus-agent`) — every report, regardless of size — because a high-quality scan deserves a high-quality fix.

**Paid + OpenRouter-only by design.** `high_quality_scan` fails fast (never silently downgrades) on a local backend, in `free_only` mode, or when credit is exhausted. For cheap/free fixing use `/llm-externalizer:llm-externalizer-scan-and-fix` instead. Configure the model via the `high_quality_model` block in `~/.llm-externalizer/settings.yaml`.

**HARDCODED (not overridable):** `answer_mode: 0` (one report per file → one fixer agent per file, zero orchestrator-side consolidation); `output_dir: $MAIN_ROOT/reports/llm-externalizer/` (so the join script finds every `.fixer.`-tagged summary).

## Step 1 — Parse `$ARGUMENTS` and validate

- **`<folder>`** (MANDATORY): absolute path to the directory to scan. Relative paths resolve against `$CLAUDE_PROJECT_DIR`. `test -d` it; abort with `[FAILED] llm-externalizer-high-quality-scan-and-fix — target path not found: <path>` if missing.
- **`--instructions <path>`**: `.md` file whose contents become the scan instructions (replaces the default rubric). `test -f`; abort if missing.
- **`--specs <path>`**: `.md` spec file; appended to `instructions_files_paths` (each file is checked against the spec). `test -f`; abort if missing.
- **`--text`**: include plain-text extensions (`.md .txt .json .yml .yaml .toml .ini .cfg .conf .xml .html .rst .csv`). Without it, the tool uses its default source-code extensions.
- **`--no-secrets`**: disable the secret detector (`scan_secrets: false, redact_secrets: false`). Default is `scan_secrets: true, redact_secrets: true` (secrets detected and REDACTED before reaching the LLM, scan continues).

Resolve the reports dir the SAME way the MCP server does (no git — mirror `mcp-server/src/project-root.ts`): `MAIN_ROOT="$CLAUDE_PROJECT_DIR"` when that dir exists on disk, else `$(pwd)`. `REPORTS_DIR="$MAIN_ROOT/reports/llm-externalizer"`; `mkdir -p` it. Recompute it in every `Bash` step (env vars do not persist across tool calls).

## Step 2 — Verify service + backend

Call `mcp__llm-externalizer__discover`. Abort with `[FAILED] — service offline` if OFFLINE. The output shows the active backend and `free_only`: if the backend is NOT OpenRouter or `free_only` is on, STOP and tell the user `high_quality_scan` will fail fast — suggest `/llm-externalizer:llm-externalizer-scan-and-fix` instead. Do not start a scan that the gate will refuse.

## Step 3 — Run the high-quality scan

Build the `instructions` / `instructions_files_paths`:

- `--instructions` and/or `--specs` set → `instructions_files_paths` = their union (instructions first); `instructions` = `"Follow the instructions provided in instructions_files_paths. Reference function names and line numbers. Be terse."` (or, with only `--specs`: `"Audit each file for compliance against the specification in instructions_files_paths. Report deviations with file paths and line numbers. Be terse."`).
- Neither → use the default audit rubric below (REAL DEFECTS ONLY, respect coding style). The `[[FINDING]]` output format is the CONTRACT the join script and the Opus fixer agent both parse — emit it exactly:

```
Audit each file for REAL DEFECTS only: (1) logic bug — code does not do what its name/docstring/context says; (2) crash / unintended exception on documented inputs; (3) security vuln with a concrete exploit path (shell injection, path traversal, unsafe deserialization, secret exposure, auth bypass, SSRF); (4) resource leak causing unbounded growth/deadlock/starvation; (5) data corruption; (6) functionality not matching its contract; (7) broken reference visible WITHIN this file.

DO NOT REPORT (these are style choices, not bugs): missing try/except or error handling (fail-fast is valid); missing null/undefined checks; missing input validation for internal-only functions; "could be more robust" / "consider using"; "should add logging/comments/type hints/docstrings"; refactoring suggestions; hypothetical future scenarios; deliberately removed assertions; performance micro-optimizations off the hot path. Respect the author's style (fail-fast, no backwards-compat, minimal docstrings, compact expressions).

VERIFICATION: before reporting, ask "does this describe code that actually misbehaves on documented inputs?" If only under attacker input → security finding (report with the exploit path). If only "had the author coded defensively against themselves" → style, DO NOT REPORT.

OUTPUT FORMAT (STRICT — the aggregator parses this). For each real defect emit ONE block:
[[FINDING]]
Title: <specific one-line title>
File: <absolute path to the source file>
Source: <function name or file:line>
Severity: <High|Medium|Low>
Description: <1–3 sentences; reference the exact function/line/symbol>
[[/FINDING]]
If NO real defects: emit the single line `No real defects.` Do NOT echo these instructions, add preamble, use ### or numbered lists for findings, or treat [REDACTED:...] placeholders as defects.
```

Call `mcp__llm-externalizer__high_quality_scan`:

```json
{
  "folder_path": "<absolute folder>",
  "answer_mode": 0,
  "use_gitignore": true,
  "output_dir": "<MAIN_ROOT>/reports/llm-externalizer",
  "extensions": ["<only if --text: .md,.txt,.json,.yml,.yaml,.toml,.ini,.cfg,.conf,.xml,.html,.rst,.csv>"],
  "exclude_dirs": ["docs_dev","reports_dev","scripts_dev","tests_dev","samples_dev","examples_dev","downloads_dev","libs_dev","builds_dev","reports","llm_externalizer_output",".rechecker",".mypy_cache",".ruff_cache",".serena",".claude",".venv","__pycache__"],
  "instructions": "<see above>",
  "instructions_files_paths": ["<if applicable>"],
  "scan_secrets": <default true; --no-secrets: false>,
  "redact_secrets": <default true; --no-secrets: false>
}
```

Omit `extensions` unless `--text` is set. If the tool returns an error (paid-model gate refusal), abort and surface its one-line reason.

## Step 4 — Extract + script-validate report paths (no Read)

Parse the tool's `<source> -> <report>` pairs and write ONE absolute report path per line to a temp file (do NOT `Read` any report — `Read` is not in this command's allowed-tools by design):

```bash
RUN_TS=$(date +%Y%m%dT%H%M%S%z)
EXTRACTED="/tmp/llm-externalizer-hq-scan-and-fix.$RUN_TS.extracted.txt"
VALIDATED="/tmp/llm-externalizer-hq-scan-and-fix.$RUN_TS.validated.txt"
: > "$EXTRACTED"; : > "$VALIDATED"
# emit one `printf '%s\n' "<abs report path>" >> "$EXTRACTED"` per parsed path; exclude any line containing `.fixer.`
```

Abort with `[FAILED] — scan produced 0 reports` if `$EXTRACTED` is empty. Then validate each report with the shared script (same one `/llm-externalizer:llm-externalizer-scan-and-fix` uses) — it checks the report exists, the referenced source exists inside the project, and every `lines N-M` range fits the source:

```bash
while IFS= read -r REPORT; do
  [ -z "$REPORT" ] && continue
  python3 "${CLAUDE_PLUGIN_ROOT}/scripts/validate_report.py" --report "$REPORT" --project-dir "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 \
    && printf '%s\n' "$REPORT" >> "$VALIDATED"
done < "$EXTRACTED"
```

Abort with `[FAILED] — all reports failed validate_report.py` if `$VALIDATED` is empty.

## Step 5 — Pre-fix checkpoint (mandatory)

Before any fixer touches source, checkpoint the working tree (stash, NOT commit — `git add -A` could stage untracked `.env`/`reports/`):

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(git status --porcelain)" ]; then
  git stash push --include-untracked -m "pre-hq-scan-and-fix $(date +%Y%m%dT%H%M%S%z)" && echo "Checkpoint stash created. Restore with: git stash pop"
else
  echo "Working tree clean or not a git repo — no checkpoint."
fi
```

## Step 6 — Dispatch Opus fixers (always Opus, ≤15 concurrent)

Read `$VALIDATED` in batches of 15 (`sed -n 'START,ENDp'`). For each path, spawn ONE subagent via `Task` — **always `subagent_type: "llm-externalizer-parallel-fixer-opus-agent"`** (high-quality scan → high-quality fix; no Sonnet downgrade). Each `Task` carries `description: "Fix report: <basename>"` and `prompt: "<absolute report path>"` (the path, nothing else). **One agent = one report = one source file.** Up to 15 `Task` calls per assistant message (they run concurrently); never exceed 15 in flight; wait for a batch before sending the next.

The Opus fixer agent already VERIFIES each finding (file-read + flow-trace) before editing and rejects false positives — this is the "verify then fix in the same turn" the high-quality mode promises. **IGNORE the fixers' return text** (each returns its `.fixer.`-summary path; the join script globs `$REPORTS_DIR` directly). Do NOT `Read` any fixer summary. Abort with `[FAILED] — llm-externalizer-parallel-fixer-opus-agent not installed` if the agent is missing.

## Step 7 — Join + return

```bash
TS=$(date +%Y%m%dT%H%M%S%z); REPORTS_DIR="$MAIN_ROOT/reports/llm-externalizer"; FINAL="$REPORTS_DIR/${TS}.final-report.md"
if command -v python3 >/dev/null 2>&1; then JOIN=(python3); elif command -v uv >/dev/null 2>&1; then JOIN=(uv run --no-project); else echo "[FAILED] no python3 or uv on PATH" >&2; exit 1; fi
FIXED_COUNT=$(ls -1 "$REPORTS_DIR" 2>/dev/null | grep -cF '.fixer.')
"${JOIN[@]}" "${CLAUDE_PLUGIN_ROOT}/scripts/join_fixer_reports.py" --input-dir "$REPORTS_DIR" --output "$FINAL"
echo "M-FIXED=$FIXED_COUNT"
```

Do NOT `Read` `$FINAL`. Emit exactly ONE line:

```
[DONE] llm-externalizer-high-quality-scan-and-fix — <N-scanned> reports / <M-fixed> summaries → <FINAL-absolute-path>
```

On any error: `[FAILED] llm-externalizer-high-quality-scan-and-fix — <one-line reason>`.

## Constraints

- `answer_mode` is hardcoded `0`; `output_dir` is hardcoded `$MAIN_ROOT/reports/llm-externalizer`. Do NOT accept overrides.
- Fixers are ALWAYS Opus — never Sonnet. Do NOT route by file size.
- You MUST NOT `Read` any scan report, fixer summary, or the final joined report; only file paths flow through the orchestrator.
- Fixer dispatch MUST be parallel (batches of ≤15). Sequential dispatch defeats the design.
- For cross-file reference validation, use `mcp__llm-externalizer__check_against_specs` (pass `--specs`) — the LLM sees only 1–5 files per batch and cannot validate references against files outside the batch.

## Three-surface compliance: by-design slash-only (GAP-11)

This command is multi-agent orchestration — a high_quality_scan MCP batch, then up to 15 parallel Opus fixer subagents (one per report) via the Task tool, then a Python join script across multiple turns of orchestrator control flow. Per TRDD-a24b213c §C, that is a documented exemption from the "every capability has MCP tool + CLI command + slash command" invariant: a single MCP or CLI surface cannot spawn subagents (only the orchestrator can, via Task), so the `_and_fix` capability is inherently slash-only. The pure scan IS three-surfaced (the `high_quality_scan` MCP tool + the `high-quality-scan` CLI command + `/llm-externalizer:llm-externalizer-high-quality-scan`).

## Error handling

| Error | Resolution |
|---|---|
| MCP service offline | `[FAILED] — service offline`. Restart Claude Code. |
| Backend not OpenRouter / free_only / no credit | STOP before scanning; suggest `/llm-externalizer:llm-externalizer-scan-and-fix`. |
| Target path / instructions / specs missing | `[FAILED] — <which> not found: <path>`. |
| Scan returns 0 reports | `[FAILED] — scan produced 0 reports`. Widen target. |
| All reports fail validation | `[FAILED] — all reports failed validate_report.py`. |
| Opus fixer agent missing | `[FAILED] — llm-externalizer-parallel-fixer-opus-agent not installed`. |
| Join script exits non-zero | `[FAILED] — join script failed: <stderr first line>`. |
