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

## Scanning `.md` files — special rules

`.md` files (agent / command / skill definitions, docs, README) are **excluded by default** from scans. The default audit rubric is a source-code audit; handing a .md file to it produces hallucinated findings or empty reports — wasted tokens either way.

To scan `.md` files, pass explicit `instructions` describing what to look for: stale references to renamed symbols/commands, hardcoded values that should be placeholders, TODO/FIXME triage, outdated API snippets, coverage of specific caveats — things only a semantic reader can do.

**Do NOT use this skill for structural validation of plugin files** — frontmatter schema, argument-hint consistency, skill description coverage, plugin.json conformance. Those are deterministic checks that belong to:

- `claude-plugin-validation` (CPV) — `cpv-validate-plugin`, `cpv-validate-skill`, `cpv-semantic-validation`
- `claude plugin validate .` — the authoritative Claude Code CLI validator
- Project-local validation scripts (AST / schema parsers)

A validator runs these in milliseconds and is reproducible. An LLM doing the same work is orders of magnitude more expensive, non-reproducible, and prone to hallucinated findings.

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
