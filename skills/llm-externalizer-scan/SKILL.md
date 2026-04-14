---
name: llm-externalizer-scan
description: |-
  Use when scanning an entire project or codebase for bugs, security issues, or code quality problems.
  Trigger with "scan project", "audit codebase", "scan codebase", "full scan",
  "run project scan", "check whole project", "scan all files".
argument-hint: "[folder-path | . | glob-pattern] [focus: bugs|security|all]"
effort: medium
context: fork
agent: llm-ext-reviewer
---

Scan the target in `$ARGUMENTS` with the LLM Externalizer ensemble and return only report file paths. Runs in the `llm-ext-reviewer` forked subagent — verbose scan output stays out of the orchestrator window.

# LLM Externalizer — Full Project Scan

## Overview

Run a codebase scan via the LLM Externalizer MCP server using the active profile (default: `remote-ensemble` — Gemini 2.5 Flash + Grok 4.1 Fast + Qwen 3.6 Plus, parallel). One report is written per file. Because this skill uses `context: fork`, work runs in the restricted `llm-ext-reviewer` subagent (Haiku-class, no Write/Edit) and only the final report paths come back.

## Prerequisites

- LLM Externalizer MCP server running (auto-started by the plugin)
- Active profile in `~/.llm-externalizer/settings.yaml`
- For remote profiles: OpenRouter key — set via plugin `userConfig.openrouter_api_key` (keychain) OR `$OPENROUTER_API_KEY` shell env

## Instructions

Copy this checklist and track your progress:

1. [ ] Parse `$ARGUMENTS` for **target** (folder/file/glob, default `.`), **focus** (bugs/security/all/"duplicate check"/"already done?"), and **budget** (free if "free"/"cheap"/"quick" present).
2. [ ] Call `mcp__llm-externalizer__discover` to verify service is online. Abort with `[FAILED] — service offline` if not.
3. [ ] Pick the right tool for the intent:
   - **Duplicate check / "is this already implemented?"** → `mcp__llm-externalizer__search_existing_implementations` with `feature_description`, `folder_path`, and optionally `source_files` / `diff_path`. Exhaustive per-file YES/NO, FFD-batched for 10k-file codebases.
   - **General audit (bugs / security / leaks)** on a folder → `mcp__llm-externalizer__scan_folder` with `use_gitignore: true`, `answer_mode: 0`.
   - **Small batch (≤5 files)** → `mcp__llm-externalizer__code_task` with `answer_mode: 0`, `max_retries: 3`.
   - **Glob → file list** → use `Glob` to expand, then `code_task`.
4. [ ] Call the chosen tool. Pass `free: true` only if the user asked for it (warn about prompt logging first).
5. [ ] Use the default rubric in `instructions` unless the user supplied a focus override: *"Audit for: 1) Logic bugs, 2) Error handling gaps, 3) Security issues, 4) Resource leaks, 5) Broken references. Reference function names. Be terse."*
6. [ ] Collect report paths from the tool result. Do NOT read or summarize report contents.
7. [ ] Return paths to the orchestrator using the Output format below.

## Output

One `.md` report per source file under `<project>/reports_dev/llm_externalizer/`. Filenames embed the source filename.

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

Scan a folder with the default rubric:
```json
{"tool": "scan_folder", "folder_path": "/path/to/src",
 "instructions": "Node.js Express API. Audit for bugs, security, error handling.",
 "use_gitignore": true, "answer_mode": 0}
```

Scan only Python files, excluding migrations:
```json
{"tool": "scan_folder", "folder_path": "/path/to/django-app",
 "extensions": [".py"], "exclude_dirs": ["migrations"],
 "instructions": "Django REST API. Find security vulnerabilities."}
```

## Resources

- [Tool reference](references/tool-reference.md) — Read-only analysis tools, Utility tools, Standard Input Fields, Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md) — Scan codebase, Analyze multiple files, Per-file checks, Compare versions, Compare via git diff, Check broken references, Check broken imports, Reuse instructions, Simple task, Quick factual answer, Code review with persona, Scan with gitignore, folder_path on any tool, Redact patterns, Check against specs, Folder vs specs, Grouped processing, Code-optimized analysis, Free quick scan
