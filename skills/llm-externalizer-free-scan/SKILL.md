---
name: llm-externalizer-free-scan
description: |-
  Use when scanning a project for free using the Nemotron model (no cost, lower quality).
  Trigger with "free scan", "free-scan", "scan for free", "quick scan", "cheap scan",
  "scan without cost", "nemotron scan".
argument-hint: "[folder-path | .]"
effort: medium
---

# LLM Externalizer — Free Project Scan

## Overview

Run a project scan using the **free** NVIDIA Nemotron 3 Super model (`nvidia/nemotron-3-super-120b-a12b:free`). No cost, single model, 262K context.

**LOW QUALITY**: This model has significantly lower intelligence than the 3-model ensemble. Expect more false positives, missed bugs, and shallow analysis. Use only for quick rough checks on non-critical code.

**WARNING**: Prompts are logged by the provider — do not use with sensitive or proprietary code.

## Prerequisites

- LLM Externalizer MCP server running (auto-started by Claude Code plugin)
- OpenRouter API key set (`$OPENROUTER_API_KEY`)

## Instructions

1. Call `mcp__plugin_llm-externalizer_llm-externalizer__discover` to verify service online.
2. Parse prompt for **folder_path** (default cwd), **extensions**, **exclude_dirs**, **instructions** (default: report real bugs only — logic, crashes, security exploits, data corruption, functionality mismatch; not missing error handling/null checks/validation/logging; cite functions + lines; terse).
3. Call `mcp__plugin_llm-externalizer_llm-externalizer__scan_folder` with `free: true`, `use_gitignore: true`, plus parsed fields.
4. Tool returns one report path per file. List them for the user.
5. Remind user this is low-quality — suggest ensemble for thorough audit. Do NOT read/summarise reports.

Limitations: `.md` files EXCLUDED by default (pass `instructions` for semantic search). LLM sees only 1–5 files/request — no cross-file refs (`check_against_specs` or `search_existing_implementations`).

## Output

One `.md` report per source file. The plugin's policy is to write under `<main-repo-root>/reports/llm-externalizer/` (the canonical path used by every other component); always pass an explicit `output_dir` matching that location on the tool call. The MCP server's compiled-in default `reports_dev/llm_externalizer/` is **developer scratch**, not the home for findings. Report filenames include the source filename for easy identification.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| Service offline | MCP server not running | Restart Claude Code or run `/llm-externalizer:llm-externalizer-discover` |
| Auth error | `$OPENROUTER_API_KEY` not set | Set the env var in `.claude/settings.json` or shell profile |
| Empty response | Model timed out | May need simpler instructions or smaller files |
| No files found | Wrong path or all files gitignored | Check `folder_path` is correct and `use_gitignore` setting |

## Examples

```json
{"tool": "scan_folder", "folder_path": "/path/to/project/src",
 "free": true, "instructions": "Find security issues.",
 "use_gitignore": true}
```

```json
{"tool": "scan_folder", "folder_path": "/path/to/project",
 "free": true, "extensions": [".py"],
 "instructions": "Find TODO comments and classify by urgency."}
```

## Resources

- [Tool reference](references/tool-reference.md)
  - Read-only analysis tools, Utility tools, Standard Input Fields
  - Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md)
  - Scan a codebase for issues, Analyze multiple files in parallel
  - Apply same check to each file independently
  - Compare two file versions (pair mode), Compare files in batch mode
  - Compare files via git diff
  - Check for broken code references after refactoring, Check for broken file imports
  - Reuse instructions across operations, Simple task with ensemble off (save tokens)
  - Quick factual answer with low max_tokens, Code review with persona
  - Scan folder with gitignore + excluded dirs, Use folder_path on any tool
  - Redact custom patterns, Check source against specification
  - Check entire folder against specification
  - Grouped file processing (isolated reports), Code-optimized analysis
