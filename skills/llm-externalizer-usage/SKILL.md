---
name: llm-externalizer-usage
description: |-
  Use when offloading file analysis to external LLMs.
  Trigger with "analyze files", "scan folder", "check imports", "compare files", "batch check".
effort: medium
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

**READ THIS — common misconception**: `answer_mode` controls how reports are written to disk, NOT how many files the LLM sees per request. The LLM **never** sees the whole set at once. Files are batched into requests of typically **1–5 files each** (FFD bin packing into ~400 KB batches, or one group per request when `---GROUP:id---` markers are supplied). In **ensemble** mode each file gets **3 responses** from 3 LLMs; in **free** and **local** mode each file gets **1 response**.

For cross-file analysis across a whole codebase use `search_existing_implementations` — each file is compared against a REFERENCE.

Reports are `.md` files in `reports_dev/llm_externalizer/`.

**answer_mode : 0** — ONE REPORT PER FILE. One `.md` per input file; MCP splits each batch response by `## File:` markers. Best for per-file fan-out.

**answer_mode : 1** — ONE REPORT PER GROUP. One `.md` per group. Without `---GROUP:id---` markers MCP auto-groups by subfolder → extension → namespace → basename → shared imports (max 1 MB per group). Best for per-module review.

**answer_mode : 2** — SINGLE REPORT. Everything merged into one `.md`. Best for a top-level audit summary.

Defaults: `scan_folder`=0, `chat` / `code_task` / `check_*`=2, `search_existing_implementations`=2.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| Timeout | Long reasoning on large file | Automatic — reasoning models get extended time |
| Auth error | API key not set | Run `discover`; set env var |
| Empty response | File exceeds model limit | Split files or change model |

## Examples

```json
{"tool": "code_task", "folder_path": "/path/to/src", "extensions": [".ts"],
 "instructions": "Find bugs. Node.js Express API."}
```

```json
{"tool": "compare_files", "input_files_paths": ["/path/old.ts", "/path/new.ts"],
 "instructions": "Focus on API breaking changes"}
```

```json
{"tool": "search_existing_implementations",
 "feature_description": "rate-limited HTTP client with retry backoff",
 "folder_path": "/path/to/codebase",
 "source_files": ["/path/to/pr/http_client.py"]}
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
