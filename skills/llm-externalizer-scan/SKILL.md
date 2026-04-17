---
name: llm-externalizer-scan
description: |-
  Use when scanning an entire project or codebase for bugs, security issues, or code quality problems.
  Trigger with "scan project", "audit codebase", "scan codebase", "full scan",
  "run project scan", "check whole project", "scan all files".
argument-hint: "[folder-path | . | glob-pattern] [focus: bugs|security|all]"
effort: medium
context: fork
agent: llm-externalizer-reviewer
---

Scan the target in `$ARGUMENTS` with the LLM Externalizer ensemble and return only report file paths. Runs in the `llm-externalizer-reviewer` forked subagent — verbose scan output stays out of the orchestrator window.

# LLM Externalizer — Full Project Scan

## Overview

Run a codebase scan via the LLM Externalizer MCP server using the active profile (default: `remote-ensemble`, parallel). One report is written per file. Uses `context: fork` — work runs in the restricted `llm-externalizer-reviewer` subagent (Haiku, no Write/Edit) and only final report paths come back.

## Prerequisites

- LLM Externalizer MCP server running (auto-started by the plugin)
- Active profile in `~/.llm-externalizer/settings.yaml`
- For remote profiles: OpenRouter key — set via plugin `userConfig.openrouter_api_key` (keychain) OR `$OPENROUTER_API_KEY` shell env

## Instructions

Copy this checklist and track your progress:

1. [ ] Parse `$ARGUMENTS` for **target** (folder/file/glob, default `.`), **focus** (bugs/security/duplicate-check/etc.), **budget** (`free` flag if user asked).
2. [ ] `mcp__llm-externalizer__discover`. Abort `[FAILED] — service offline` if offline.
3. [ ] Pick the tool:
   - **Duplicate check / "already implemented?"** → `search_existing_implementations` with `feature_description`, `folder_path`, and optional `source_files` / `diff_path`.
   - **General audit on a folder** → `scan_folder` with `use_gitignore: true`, `answer_mode: 0`.
   - **≤5 files** → `code_task` with `answer_mode: 0`, `max_retries: 3`.
   - **Glob** → `Glob` to expand, then `code_task`.
4. [ ] Call the tool. Pass `free: true` only if asked (warn about prompt logging first).
5. [ ] Default rubric for `instructions` unless overridden: *"Audit for: 1) Logic bugs, 2) Error handling gaps, 3) Security issues, 4) Resource leaks, 5) Broken references. Reference function names. Be terse."*
6. [ ] Collect report paths. Do NOT read or summarize report contents.
7. [ ] Return paths using the Output format below.

## Scanning `.md` files

`.md` files are EXCLUDED by default — the source-code rubric is wrong for prose. To include them, pass explicit `instructions` for a semantic search (stale references, outdated API snippets, TODO triage). For structural validation (frontmatter / schema / argument-hint / plugin.json) use **CPV** (`cpv-validate-plugin`, etc.) or `claude plugin validate .`, not the LLM.

## Output

Reports under `<project>/reports_dev/llm_externalizer/`. Filenames embed the source filename or group id.

**Batching**: LLM never sees the whole codebase at once. Files are FFD-packed into ~400 KB batches (1–5 files each) or one group per request with `---GROUP:id---` markers. In ensemble mode each file gets 3 responses; in free/local mode each file gets 1.

**answer_mode**: `0` = ONE REPORT PER FILE (default for scan_folder). `1` = ONE REPORT PER GROUP — auto-groups files by subfolder/extension/basename (1 MB per group) if no `---GROUP:id---` markers. `2` = SINGLE REPORT (merged). `answer_mode` controls disk output only, not LLM visibility. For cross-file analysis use `search_existing_implementations`.

Reply format (exact, no preamble):
```
[DONE] scan-<label> — <N> reports
<absolute-path-1>
<absolute-path-2>
```
On failure: `[FAILED] scan-<label> — <one-line reason>`

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| Service offline | MCP server not running | Restart Claude Code; abort |
| Auth 401 | OpenRouter key missing | Set `userConfig.openrouter_api_key` or `$OPENROUTER_API_KEY` |
| Credit 402 | Balance < $0.05 | Server auto-falls back to free Nemotron |
| Empty response | Cold start / timeout | Server retries up to 15× with 2s backoff |
| No files found | Wrong path or all gitignored | Verify target and `use_gitignore` setting |

## Examples

See [Usage patterns](references/usage-patterns.md) for representative tool calls — scan folder with gitignore, filter by extensions, exclude dirs, custom rubrics, grouped processing, etc.

## Resources

- [Tool reference](references/tool-reference.md) — read-only analysis tools, utility tools, standard input fields, advanced parameters, file grouping, constraints, safety features.
- [Usage patterns](references/usage-patterns.md) — scan codebase, per-file checks, compare versions, check broken references, check broken imports, reuse instructions, scan with gitignore, redact patterns, specs checks, grouped processing.
