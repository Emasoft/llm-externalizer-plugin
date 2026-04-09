# Tool Reference

## Table of Contents

- [Read-only analysis tools](#read-only-analysis-tools)
- [Utility tools](#utility-tools)
- [Standard Input Fields](#standard-input-fields)
- [Advanced Parameters](#advanced-parameters)
- [File Grouping](#file-grouping)
- [Critical Constraints](#critical-constraints)
- [Safety Features](#safety-features)

## Read-only analysis tools

| Tool | Use When | Default answer_mode |
|------|----------|-------------------|
| `chat` | General-purpose: summarize, compare, translate, generate text. Also handles custom_prompt calls. Accepts `folder_path`. | 2 (merged) |
| `code_task` | Code-optimized analysis with code-review system prompt. Use for audits, reviews. Accepts `folder_path`. | 2 (merged) |
| `batch_check` | **DEPRECATED** — use any tool with `answer_mode: 0, max_retries: 3`. Per-file processing with retry. | 0 (per-file) |
| `scan_folder` | Auto-discover files in a directory tree and check each. Good for codebase-wide scans. | 2 (merged) |
| `compare_files` | 3 modes: pair (2 files), batch (`file_pairs` array), git diff (`git_repo` + `from_ref` + `to_ref`). LLM summarizes differences. | N/A |
| `check_references` | Auto-resolve local imports, send source+dependencies to LLM to validate symbol references. Accepts `folder_path`. | 2 (merged) |
| `check_imports` | Two-phase: LLM extracts all import paths, server validates each exists on disk. Accepts `folder_path`. | 2 (merged) |
| `check_against_specs` | Compare source files against a specification file. Reports violations only (not missing features). Accepts `folder_path`, `input_files_paths`, or both combined. | 2 (merged) |

## Utility tools

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

Use `instructions_files_paths` to share reusable review rules, coding standards, or large instruction sets across multiple operations.

**NOTE**: `batch_check` does NOT support `input_files_content`.

**NOTE**: `check_against_specs` uses `spec_file_path` (required) plus `input_files_paths`, `folder_path`, or both combined for source files.

## Advanced Parameters

| Parameter | Tools | Values | Notes |
|-----------|-------|--------|-------|
| `max_tokens` | All content tools | number | Override max response tokens (default: model max ~65,535). Set lower to save cost or avoid 120s timeout. |
| `temperature` | Fixed | 0.1 | Not configurable. Optimized for factual/code analysis. |
| `output_dir` | All content tools | string | Custom output directory for reports (default: `reports_dev/llm_externalizer/`). |
| `system` | `chat` only | string | Persona override. Be specific: `"Senior TypeScript dev"`. |
| `language` | `code_task` only | string | Programming language hint. Auto-detected from file extension. |
| `folder_path` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs` | string | Absolute path to a folder to scan. Can be combined with `input_files_paths`. |
| `recursive` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs` | boolean (default: true) | Recurse into subdirectories when scanning `folder_path`. |
| `follow_symlinks` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs` | boolean (default: true) | Follow symbolic links. Circular symlinks auto-detected and skipped. |
| `max_files` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs`, `scan_folder` | number (default: 2500) | Maximum files to discover from `folder_path`. Safety limit for large trees. |
| `extensions` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs`, `scan_folder` | string array | File extensions to include when using `folder_path`. |
| `exclude_dirs` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs`, `scan_folder` | string array | Additional dirs to skip beyond built-in exclusions (hidden dirs, node_modules, .git, dist, build). |
| `use_gitignore` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs`, `scan_folder` | boolean (default: true) | Use `.gitignore` rules via `git ls-files`. Handles submodules and nested git repos. Set `false` to include gitignored files. |
| `ensemble` | All content tools | boolean (default: true on OpenRouter) | Run both models in parallel. Set `false` for simple tasks to save tokens. |
| `answer_mode` | Multi-file tools | 0, 1, or 2 | 0=per-file reports (parallel+retry when max_retries>1), 1=per-request sections, 2=merged. |
| `max_retries` | `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs` | number (default: 1) | Max retries per file in mode 0. Set 3 for robust batch processing with exponential backoff and circuit breaker (aborts after 3 consecutive failures). |
| `redact_regex` | All content tools | string | JavaScript regex pattern to redact matching strings before sending to LLM. Applied after secret redaction. Alphanumeric matches become `[REDACTED:USER_PATTERN]`, numeric-only matches become zero-padded placeholders. |

## File Grouping

Files in `input_files_paths` can be organized into named groups for isolated processing.
Each group produces its own report file — n groups in, n reports out.

### Syntax

```json
{
  "input_files_paths": [
    "---GROUP:auth---",
    "/path/to/auth.ts",
    "/path/to/auth.test.ts",
    "---/GROUP:auth---",
    "---GROUP:api---",
    "/path/to/api.ts",
    "/path/to/routes.ts",
    "---/GROUP:api---"
  ]
}
```

- `---GROUP:<id>---` starts a named group
- `---/GROUP:<id>---` ends a group (optional — next header or end of array also closes)
- Files outside markers go into a default unnamed group
- No markers = backward compatible (single unnamed group)
- Groups apply to `input_files_paths` only, not `instructions_files_paths` or `spec_file_path`

### Output

Each group produces one report file with the group ID in the filename:
```
[group:auth] /path/to/reports_dev/llm_externalizer/chat_group-auth_2026-03-28T...md
[group:api] /path/to/reports_dev/llm_externalizer/chat_group-api_2026-03-28T...md
```

### Supported tools

`chat`, `code_task`, `batch_check`, `check_references`, `check_imports`, `check_against_specs`

For `compare_files`, grouping uses `---GROUP:id---` markers as single-element entries in the `file_pairs` array.

## Critical Constraints

- **120s timeout**: MCP spec hard limit per call. Long outputs may truncate.
- **No project context**: The remote LLM knows NOTHING about your project. ALWAYS include brief context in instructions.
- **File paths only**: ALWAYS pass file paths in `input_files_paths`, NEVER paste contents into `instructions`.
- **Output location**: All responses saved to `reports_dev/llm_externalizer/`. Tool returns ONLY the file path — never inline content.
- **Auto-batching**: If input files exceed context window, they are automatically split into batches.
- **Rate limiting**: Adaptive RPS auto-detected from OpenRouter balance ($1 ≈ 1 RPS, max 500). Self-adjusts on 429 errors. Up to 200 in-flight. Local = sequential.

## Safety Features

- `scan_secrets` (boolean): Scans input files for secrets and aborts if found.
- `redact_secrets` (boolean): Replaces secrets with `[REDACTED:LABEL]`. Prefer moving secrets to `.env` instead.
- `redact_regex` (string): JavaScript regex pattern to redact custom strings from file content before sending to LLM. Applied after secret redaction. Invalid regex returns an error with details.
- `use_gitignore` (boolean, default: true): Respects `.gitignore` rules via `git ls-files`. Available on all tools with `folder_path` and on `scan_folder`. Handles submodules and nested git repos.
