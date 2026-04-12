---
name: llm-externalizer-scan
description: |-
  Use when scanning an entire project or codebase for bugs, security issues, or code quality problems.
  Trigger with "scan project", "audit codebase", "scan codebase", "full scan",
  "run project scan", "check whole project", "scan all files".
argument-hint: "[folder-path | .]"
effort: medium
---

# LLM Externalizer — Full Project Scan

## Overview

Run a comprehensive codebase scan using 3 ensemble models (Gemini 2.5 Flash + Grok 4.1 Fast + Qwen 3.6 Plus) in parallel. Each file is analyzed independently by all 3 models, and results are combined into a single report.

## Prerequisites

- LLM Externalizer MCP server running (auto-started by Claude Code plugin)
- Active `remote-ensemble` profile configured (see `llm-externalizer-config` skill)
- OpenRouter API key set (`$OPENROUTER_API_KEY`)

## Instructions

Copy this checklist and track your progress:

1. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__discover` to verify service is online
2. [ ] Identify the project root directory (the folder containing the main source code)
3. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__scan_folder` with:

```json
{
  "folder_path": "<absolute path to project root>",
  "instructions": "<brief project description>. Audit for: 1) Logic bugs 2) Error handling gaps 3) Security issues 4) Resource leaks 5) Broken references. Reference function names.",
  "use_gitignore": true,
  "answer_mode": 0
}
```

4. [ ] Read the output report file path returned by the tool
5. [ ] Read the report with the Read tool
6. [ ] Summarize findings to the user, grouped by severity

## Output

One `.md` report per source file, saved in `reports_dev/llm_externalizer/`. Each report contains findings from all 3 ensemble models combined. Report filenames include the source filename for easy identification (e.g., `code_task_index-ts_2026-04-07T19-43-26_a1b2c3.md`). Use the Read tool to access them.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| Service offline | MCP server not running | Restart Claude Code or run `/llm-externalizer:discover` |
| Auth error | `$OPENROUTER_API_KEY` not set | Set the env var in `.claude/settings.json` or shell profile |
| Empty response | Model timed out during reasoning | Automatic — reasoning timeout is detected and skipped |
| Model unavailable | Model removed from OpenRouter | Automatic — ensemble returns results from surviving models |
| No files found | Wrong path or all files gitignored | Check `folder_path` is correct and `use_gitignore` setting |

## Examples

```json
{"tool": "scan_folder", "folder_path": "/path/to/project/src",
 "instructions": "Node.js Express API. Find bugs, security issues, error handling gaps.",
 "use_gitignore": true}
```

```json
{"tool": "scan_folder", "folder_path": "/path/to/project",
 "extensions": [".py"], "exclude_dirs": ["migrations", "fixtures"],
 "instructions": "Django REST API. Find security vulnerabilities and logic bugs.",
 "answer_mode": 2}
```

## Resources

- [Tool reference](references/tool-reference.md)
  - Read-only analysis tools, Utility tools, Standard Input Fields
  - Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md)
  - Scan a codebase for issues, Analyze multiple files together
  - Apply same check to each file independently
  - Compare two file versions, Compare files in batch mode, Compare files via git diff
  - Check for broken code references, Check for broken file imports
  - Reuse instructions across operations, Simple task with ensemble off
  - Quick factual answer, Code review with persona
  - Scan folder with gitignore + excluded dirs, Use folder_path on any tool
  - Redact custom patterns, Check source against specification
  - Check entire folder against specification, Grouped file processing, Code-optimized analysis
