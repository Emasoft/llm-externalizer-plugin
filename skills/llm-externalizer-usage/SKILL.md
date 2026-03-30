---
name: llm-externalizer-usage
description: |-
  Use when offloading file analysis to external LLMs.
  Trigger with "analyze files", "scan folder", "check imports", "compare files", "batch check".
version: 1.0.0
---

# LLM Externalizer — Tool Usage

## Overview

Offload bounded analysis tasks to cheaper external LLMs via MCP tools (`mcp__llm-externalizer__*`). Supports local backends (LM Studio, Ollama) and remote (OpenRouter with ensemble mode).

## Prerequisites

- LLM Externalizer MCP server running (auto-started by Claude Code plugin)
- At least one profile configured (see `llm-externalizer-config` skill)

## Instructions

Copy this checklist and track your progress:

1. [ ] Choose the right tool based on your task (see [tool reference](references/tool-reference.md))
2. [ ] Pass file paths via `input_files_paths` or `folder_path` — never paste content
3. [ ] Include brief project context in `instructions`
4. [ ] Call the tool and receive the output file path
5. [ ] Read the output file with the Read tool
6. [ ] Act on the results (apply fixes with Edit, create issues)

## Context

Use when you need to analyze files without consuming orchestrator context, scan a codebase, compare files, or check imports. Do NOT use for surgical edits or tasks needing real-time tool access.

## Output

All responses saved as `.md` files in `llm_externalizer_output/`. Output depends on `answer_mode`: `0` (per-file), `1` (per-request), `2` (merged, default).

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| 120s timeout | Response too large | Lower `max_tokens` or split calls |
| Auth error | API key not set | Run `discover`; set env var |
| Empty response | File exceeds model limit | Split files or change model |

## Examples

```json
{"tool": "code_task", "folder_path": "/path/to/src", "extensions": [".ts"],
 "instructions": "Find bugs. Node.js Express API."}
```

```json
{"tool": "compare_files", "git_repo": "/path/to/repo",
 "from_ref": "v1.0.0", "to_ref": "HEAD"}
```

## Resources

- [Tool reference](references/tool-reference.md)
  - Read-only analysis tools, Utility tools, Standard Input Fields
  - Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md)
  - Scan a codebase for issues, Analyze multiple files together
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
- [End-to-end workflow](examples/end-to-end-workflow.md)
  - Scenario: Security audit of a TypeScript project, Quick Decision Tree
