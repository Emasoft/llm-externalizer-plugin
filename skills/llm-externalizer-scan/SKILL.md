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

## Limitations

- `.md` files EXCLUDED by default. Pass `instructions` describing a semantic search to include them. Use CPV or `claude plugin validate .` for structural validation — not the LLM.
- LLM sees only 1–5 files per request — CANNOT cross-check a ref in file A against file B. For cross-file API validation use `check_against_specs` with an explicit spec. For "already implemented?" hunts use `search_existing_implementations`.

## Output

Reports under `<project>/reports_dev/llm_externalizer/`. Filenames embed the source filename or group id.

**answer_mode**: `0`=per-file (scan_folder default), `1`=per-group (subfolder/extension/basename, 1 MB cap), `2`=merged. Controls disk output only, not LLM visibility.

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

- [Tool reference](references/tool-reference.md) — Read-only analysis tools, Utility tools, Standard Input Fields, Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md) — Scan a codebase for issues, Analyze multiple files in parallel, Apply same check to each file independently, Compare two file versions (pair mode), Compare files in batch mode, Compare files via git diff, Check for broken code references after refactoring, Check for broken file imports, Reuse instructions across operations, Simple task with ensemble off (save tokens), Quick factual answer with low max_tokens, Code review with persona, Scan folder with gitignore + excluded dirs, Use folder_path on any tool, Redact custom patterns, Check source against specification, Check entire folder against specification, Grouped file processing (isolated reports), Code-optimized analysis
