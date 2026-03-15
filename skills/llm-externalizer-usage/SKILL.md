---
name: llm-externalizer-usage
description: >-
  Use when offloading analysis or scanning to external LLMs.
  Trigger with: "analyze files", "scan folder", "check imports",
  "compare files", "use LLM Externalizer".
version: 1.0.0
---

# LLM Externalizer — Tool Usage

## Overview

Offload bounded analysis tasks to cheaper external LLMs via MCP tools (`mcp__llm-externalizer__*`). More capable than Haiku subagents and cheaper. Supports local backends (LM Studio, Ollama) and remote (OpenRouter with optional ensemble mode).

## Prerequisites

- LLM Externalizer MCP server running (auto-started by Claude Code plugin)
- At least one profile configured (see `llm-externalizer-config` skill)

## Instructions

1. Choose the right tool based on your task (see [tool reference](references/tool-reference.md))
2. Always pass file paths via `input_files_paths` — never paste content into `instructions`
3. Include brief project context in `instructions` (the remote LLM has zero knowledge of your project)
4. Call the tool and receive the output file path
5. Read the output file with the Read tool to access the LLM's response
6. Act on the results (apply fixes with Edit, create issues, report findings)

## Context

Use this skill when you need to analyze/summarize files without consuming orchestrator context, scan a codebase for patterns or bugs, compare files, check imports after refactoring, or generate boilerplate. Do NOT use for precise surgical edits, cross-file logic requiring tool chains, or tasks needing real-time tool access.

## Output

All responses saved as `.md` files in `llm_externalizer_output/`. The tool returns only the file path — use Read to access the content. Output organization depends on `answer_mode`: `0` (per-file), `1` (per-request), `2` (merged, default).

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| 120s timeout | Response too large | Lower `max_tokens` or split into smaller calls |
| Auth error | API key not set | Run `discover` to check; set the env var |
| Empty response | File exceeds model limit | Split large files or use a different model |

## Examples

### Scan a folder for security issues

```json
{"tool": "scan_folder", "folder_path": "/path/to/src",
 "extensions": [".ts"], "instructions": "Find security vulns. Node.js Express API."}
```

### Compare two files

```json
{"tool": "compare_files", "input_files_paths": ["/path/old.ts", "/path/new.ts"],
 "instructions": "Focus on API breaking changes"}
```

### Quick analysis (ensemble off)

```json
{"tool": "chat", "instructions": "What is the main export?",
 "input_files_paths": "/path/to/file.ts", "ensemble": false, "max_tokens": 500}
```

## Resources

- [Tool reference](references/tool-reference.md)
  - Read-only analysis tools, Utility tools
  - Standard Input Fields, Advanced Parameters
  - Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md)
  - Scan a codebase, Analyze multiple files, Batch check
  - Compare two files, Check broken references, Check imports
  - Reuse instructions, Ensemble off, Low max_tokens
  - Code review with persona, Scan with gitignore, Code-optimized analysis
- [End-to-end workflow](examples/end-to-end-workflow.md)
  - Scenario: Security audit of a TypeScript project
  - Quick Decision Tree
