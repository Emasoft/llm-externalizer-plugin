---
name: llm-externalizer-usage
description: |-
  Use when offloading bulk file analysis to external LLMs to save main-context tokens.
  Trigger with "externalize this analysis", "offload to a cheap model", "run scan_folder on", "use llm-externalizer", "externalize file comparison", "check_imports via externalizer".
argument-hint: "[task-description] [<file-or-folder-paths>...]"
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

## Limitations

- `.md` files EXCLUDED by default. Pass `instructions` for a semantic search to include them. Structural validation → CPV / `claude plugin validate .`, not LLM.
- LLM sees only 1–5 files per request — cannot cross-check a ref in file A against file B. Cross-file API validation → `check_against_specs` with an explicit spec. "Already implemented?" → `search_existing_implementations`.

## Output

`answer_mode` controls how reports are written to disk, NOT how many files the LLM sees. Files are batched 1–5 per request (FFD ~400 KB, or one group per request with `---GROUP:id---`). Ensemble = 3 responses/file; free + local = 1 response/file. Cross-file analysis across a whole codebase → `search_existing_implementations`.

Reports go under `<main-repo-root>/reports/llm-externalizer/` (always pass `output_dir`). Modes: `0`=per-file, `1`=per-group, `2`=merged. Defaults: `scan_folder`=0, others=2.

See [tool-reference.md](references/tool-reference.md) for the full answer_mode breakdown.

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
  - How batching works, Read-only analysis tools, Utility tools
  - Standard Input Fields, Advanced Parameters, File Grouping
  - Critical Constraints, Safety Features
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
- [End-to-end workflow](examples/end-to-end-workflow.md)
  - Scenario: Security audit of a TypeScript project, Quick Decision Tree
