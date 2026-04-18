---
name: llm-externalizer-scan-and-fix-serially
description: Like `scan-and-fix` but drives the SERIAL fixer. Scan → aggregate into one bug list → one `llm-externalizer-serial-fixer-agent` per bug in a loop. Use when bug order matters or fixes mutate shared state.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__scan_folder
  - mcp__llm-externalizer__code_task
  - Bash
  - Task
argument-hint: "[target] [--file-list path] [--instructions path] [--specs path] [--free] [--no-scan-secrets] [--text-files]"
---

Composition of two existing commands — scan phase from `scan-and-fix`, serial loop from `fix-found-bugs`. Read those command files for the full detail; this file only states the delta.

## Shape

```
[scan: from scan-and-fix Steps 0–3b]  →  [aggregate]  →  [serial fix loop: from fix-found-bugs Steps 4–8]
```

- Arguments, MCP dispatch, secret-scan, auto-curation, `validate_report.py` gate, output_dir, `answer_mode: 0` — **same as `scan-and-fix`**.
- Bug-list canonicalisation, `init-run`, snapshot/diff logic, stuck-streak break, final `save-summary`, `<RUN_TS>.fix-found-bugs.*` filenames — **same as `fix-found-bugs`**.

## Deltas from `scan-and-fix`

1. After Step 3b (validated reports in `$VALIDATED`), **skip the parallel Task fan-out (scan-and-fix Step 4).** No `llm-externalizer-parallel-fixer-agent` is dispatched.
2. Abort with `[FAILED] llm-externalizer-scan-and-fix-serially — scan produced 0 reports` if `wc -l "$VALIDATED"` is 0.

## Deltas from `fix-found-bugs`

1. Skip that command's `resolve-path` argument parsing — there is no `@merged-report` argument here; the bug list is always produced locally from the fresh scan.
2. Step 2 becomes a single call with `--reports-dir` (the fresh scan output), NOT `--skip-if-fixer-exists` (the just-finished scan has no sibling `.fixer.` files):
   ```bash
   H='python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fix_found_bugs_helper.py"'
   eval "$H aggregate-reports \
     --reports-dir \"$CLAUDE_PROJECT_DIR/reports/llm-externalizer\" \
     --output \"$BUGS_TO_FIX\""
   ```
3. If the aggregator writes a file with 0 `### ` entries, stop with `Nothing to do — scan produced reports but no aggregatable findings.` and jump to `save-summary`.

## Why pick this over `scan-and-fix`

- Fixes mutate shared state (imports, types, schemas, shared mocks) and running 15 fixers in parallel would race.
- Bug order matters — an earlier fix may supersede or unblock a later one, and you want the later bug re-evaluated against the already-fixed code.
- You want the "1 bug in, 1 fix out, fresh spawn, re-read the bug file every time" discipline of the serial-fixer-agent.

For independent per-file fixes (most audits), `scan-and-fix` is faster on wall-clock time — use that instead.

## Hardcoded (not overridable)

- `answer_mode: 0` and `output_dir: $CLAUDE_PROJECT_DIR/reports/llm-externalizer/` — same reasons as `scan-and-fix`.
- Never exceed 1 concurrent Task call in the fix loop. Do not parallelise — `scan-and-fix` is the parallel command.
- No commits.

## Error handling

Inherits from `scan-and-fix` (scan-phase errors) and `fix-found-bugs` (loop-phase errors). Only new failure-string differences:

| Error | Resolution |
|---|---|
| Scan returns 0 reports | `[FAILED] llm-externalizer-scan-and-fix-serially — scan produced 0 reports` |
| Aggregator produces 0 findings | Stop with `Nothing to do — no aggregatable findings.` (not a failure) |
| Everything else | Replace `llm-externalizer-scan-and-fix` / `llm-externalizer-fix-found-bugs` with `llm-externalizer-scan-and-fix-serially` in the parent command's failure strings. |
