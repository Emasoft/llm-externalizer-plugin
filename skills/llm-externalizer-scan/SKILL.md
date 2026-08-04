---
name: llm-externalizer-scan
description: |-
  Use when scanning an entire project or codebase for bugs, security issues, or code quality problems.
  Trigger with "scan project", "audit codebase", "scan codebase", "full scan",
  "run project scan", "check whole project", "scan all files".
argument-hint: "[folder-path | . | glob-pattern] [focus: bugs|security|all]"
effort: medium
context: fork
# Claude Code 2.1.218 made `context: fork` skills run in the BACKGROUND by
# default. That would silently change this skill's contract: it promises to
# RETURN the report file paths, and a background skill returns an agent name
# instead, with the paths arriving later as a task notification. Pin it off so
# upgrading Claude Code does not change what `/llm-externalizer-scan` hands
# back. Remove this line only together with the body's "returns report paths"
# wording — the two must agree.
background: false
agent: llm-externalizer-reviewer-agent
---

# LLM Externalizer — Full Project Scan

Scan `$ARGUMENTS` with the LLM Externalizer ensemble and return only report file paths. Runs in the `llm-externalizer-reviewer-agent` forked subagent — verbose scan output stays out of the orchestrator.

## Overview

Codebase scan via the `llm-ext` CLI, active profile (default: `remote-ensemble`, parallel). One report per file. `context: fork` runs work in the `llm-externalizer-reviewer-agent` subagent (Sonnet, no Write/Edit); only report paths come back.

## Prerequisites

- `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext` CLI available (no server process to start)
- Active profile in `~/.llm-externalizer/settings.yaml`
- For remote profiles: OpenRouter key — set via plugin `userConfig.openrouter_api_key` (keychain) OR `$OPENROUTER_API_KEY` shell env

## Instructions

1. Parse `$ARGUMENTS` for **target** (default `.`), **focus**, `free` flag.
2. `llm-ext discover`. Abort `[FAILED] — offline` if offline.
3. Pick the command: duplicate-check → `search-existing-implementations`; folder audit → `scan-folder` (`--use_gitignore`, `--answer_mode 0`); ≤5 files → `code-task` (`--answer_mode 0`, `--max_retries 3`); glob → expand, then `code-task`. Folder/large scans can run long — use an extended Bash timeout or `run_in_background: true`.
4. **Paid profile? Estimate first.** If `discover` shows free mode OFF, run the exact
   command with `--estimate` prepended to its flags — a ~3s dry-run (zero LLM sends) that
   prints `expected` and `ceiling` USD. Proceed only when the ceiling is acceptable; report
   the estimate in the reply. Free mode: skip, everything is $0.
5. Run the command. `--free` only if asked (warn about prompt logging).
6. Default rubric: bugs/crashes/security exploits/data corruption/local broken refs only. NOT missing error handling, null checks, validation, logging, style. Respect source style. Cite function names + lines.
7. Collect report paths. Do NOT read/summarize.
8. Return paths using Output format.

Limitations: `.md` files EXCLUDED by default (pass `--instructions` for semantic search; structural validation → CPV). LLM sees only 1–5 files/request — no cross-file refs (use `check-against-specs` or `search-existing-implementations`).

## Output

Reports default to `<main-project-dir>/reports/llm-externalizer/` (the main project dir Claude Code is in); pass `--output_dir` only for a custom location. Filenames embed the source filename or group id.

**answer_mode**: `0`=per-file (`scan-folder` default), `1`=per-group (subfolder/extension/basename, 1 MB cap), `2`=merged. Controls disk output only, not LLM visibility.

Reply format (exact, no preamble):
```
[DONE] scan-<label> — <N> reports
<absolute-path-1>
<absolute-path-2>
```
On failure: `[FAILED] scan-<label> — <one-line reason>`

## Error Handling

| Error | Fix |
|-------|-----|
| Service offline | Check network/API status; abort |
| Auth 401 | Set `userConfig.openrouter_api_key` or `$OPENROUTER_API_KEY` |
| Credit 402 | Server auto-falls back to free Nemotron |
| Empty response | Server auto-retries up to 15× (2s backoff) |
| No files found | Verify target path and `--use_gitignore` |

## Examples

See [Usage patterns](references/usage-patterns.md) for representative tool calls — scan folder with gitignore, filter by extensions, exclude dirs, custom rubrics, grouped processing, etc.

## Resources

- [Tool reference](references/tool-reference.md) — Read-only analysis tools, Utility tools, Standard Input Fields, Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md) — Scan a codebase for issues, Analyze multiple files in parallel, Apply same check to each file independently, Compare two file versions (pair mode), Compare files in batch mode, Compare files via git diff, Check for broken code references after refactoring, Check for broken file imports, Reuse instructions across operations, Simple task with ensemble off (save tokens), Quick factual answer with low max_tokens, Code review with persona, Scan folder with gitignore + excluded dirs, Use folder_path on any tool, Redact custom patterns, Check source against specification, Check entire folder against specification, Grouped file processing (isolated reports), Code-optimized analysis
