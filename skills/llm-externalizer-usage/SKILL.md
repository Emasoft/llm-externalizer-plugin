---
name: LLM Externalizer Usage
description: >-
  Teaches Claude how to use the LLM Externalizer MCP tools for offloading bounded
  tasks to cheaper external LLMs. Activates when the agent needs to analyze files,
  scan codebases, compare files, check imports/references, generate boilerplate,
  or perform any bounded text task that does not require real-time tool access.
  Also activates when the agent considers using Haiku subagents for read-only work,
  since LLM Externalizer is more capable and cheaper.
version: 1.0.0
---

# LLM Externalizer — Tool Usage

Prefer LLM Externalizer MCP tools (`mcp__llm-externalizer__*`) over Haiku subagents for bounded tasks. The external LLM is more capable and cheaper.

## When to Use

Use LLM Externalizer instead of subagents when:
- Reading, summarizing, or analyzing files (especially large ones or 3+ files)
- Scanning codebases for patterns, bugs, security issues, dead code
- Processing tool output (linter logs, test logs, big JSON)
- Generating boilerplate, stubs, type definitions, draft text
- Comparing files without flooding your context with diffs
- Checking for broken imports or code references after refactoring
- Getting a second opinion on code or a problem
- Any bounded text task that does not need tool access

## When NOT to Use

- Precise surgical edits (use Read+Edit directly)
- Cross-file logic requiring multiple tool calls in sequence
- Subtle reasoning only Opus can handle
- Tasks needing real-time tool access (git, filesystem, web)
- Applying code fixes (write tools are disabled — use Read+Edit)

## Tool Selection Guide

### Read-only analysis tools

| Tool | Use When | Default answer_mode |
|------|----------|-------------------|
| `chat` | General-purpose: summarize, compare, translate, generate text. Also handles custom_prompt calls. | 2 (merged) |
| `code_task` | Code-optimized analysis with code-review system prompt. Use for audits, reviews. | 2 (merged) |
| `batch_check` | Apply the SAME instructions to EACH file separately — one report per file. | 0 (per-file) |
| `scan_folder` | Auto-discover files in a directory tree and check each. Good for codebase-wide scans. | 2 (merged) |
| `compare_files` | Auto-compute unified diff between 2 files, LLM summarizes changes. | N/A |
| `check_references` | Auto-resolve local imports, send source+dependencies to LLM to validate symbol references. | 2 (merged) |
| `check_imports` | Two-phase: LLM extracts all import paths, server validates each exists on disk. | 2 (merged) |

### Utility tools

| Tool | Purpose |
|------|---------|
| `discover` | Check service health, auth token status, context window, concurrency mode, profiles |
| `reset` | Full soft-restart. Waits for running requests (up to 120s), then reloads settings and clears caches. |
| `change_model` | Switch model in active profile |
| `get_settings` | Copy settings.yaml to output dir, return file path |
| `set_settings` | Read YAML from file_path, validate, backup old, write new settings |

## Standard Input Fields

All content tools share these 4 input fields:

```
instructions          — Task text (unfenced, placed before files)
instructions_files_paths — Path(s) to instruction files (appended to instructions)
input_files_paths     — Path(s) to content files (code-fenced by the server)
input_files_content   — Inline content (DISCOURAGED — wastes your tokens)
```

**ALWAYS** use `input_files_paths` instead of reading files into your context. The server reads files from disk directly.

**NOTE**: `batch_check` does NOT support `input_files_content`.

## Advanced Parameters

| Parameter | Tools | Values | Notes |
|-----------|-------|--------|-------|
| `max_tokens` | All content tools | number | Override max response tokens (default: model max ~65,535). Set lower to save cost or avoid 120s timeout. |
| `temperature` | `chat` only | 0.1 factual, 0.3 analysis, 0.7 creative | Stay under 0.5 for code tasks. |
| `system` | `chat` only | string | Persona override. Be specific: `"Senior TypeScript dev"`. |
| `language` | `code_task` only | string | Programming language hint. Auto-detected from file extension. |
| `exclude_dirs` | `scan_folder` only | string array | Additional dirs to skip beyond built-in exclusions. |
| `ensemble` | All content tools | boolean (default: true on OpenRouter) | Run both models in parallel. Set `false` for simple tasks to save tokens. |
| `answer_mode` | Multi-file tools | 0, 1, or 2 | 0=per-file reports, 1=per-request sections, 2=merged into one file. |

## Critical Constraints

- **120s timeout**: MCP spec hard limit per call. Long outputs may truncate.
- **No project context**: The remote LLM knows NOTHING about your project. ALWAYS include brief context in instructions.
- **File paths only**: ALWAYS pass file paths in `input_files_paths`, NEVER paste contents into `instructions`.
- **Output location**: All responses saved to `llm_externalizer_output/`. Tool returns ONLY the file path. Read it when needed.
- **Auto-batching**: If input files exceed context window, they are automatically split into batches.
- **Concurrency**: Up to 5 parallel calls on OpenRouter, 1 on local. Check with `discover`.

## Safety Features

- `scan_secrets` (boolean): Scans input files for secrets and aborts if found.
- `redact_secrets` (boolean): Replaces secrets with `[REDACTED:LABEL]`. Prefer moving secrets to `.env` instead.
- `use_gitignore` (boolean, `scan_folder` only): Respects `.gitignore` rules.

## Usage Patterns

See `references/usage-patterns.md` for concrete examples of every tool with recommended parameters.
