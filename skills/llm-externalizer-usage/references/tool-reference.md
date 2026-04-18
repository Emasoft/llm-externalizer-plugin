# Tool Reference

## Table of Contents

- [How batching works](#how-batching-works)
- [Read-only analysis tools](#read-only-analysis-tools)
- [Utility tools](#utility-tools)
- [Standard Input Fields](#standard-input-fields)
- [Advanced Parameters](#advanced-parameters)
- [File Grouping](#file-grouping)
- [Critical Constraints](#critical-constraints)
- [Safety Features](#safety-features)

## How batching works

⚠️ **Read this before choosing `answer_mode`.** The LLM **never** sees your whole set of input files at once. All multi-file tools pack files into LLM requests of **typically 1–5 files each** — First-Fit Decreasing bin packing into ~400 KB batches, or **one group per request** when `---GROUP:id---` markers are supplied. The LLM only ever sees the files in a single batch and cannot cross-reference against files in other batches.

**Ensemble vs free/local**: in **ensemble mode** (`remote-ensemble`) each file is reviewed by **3 different LLMs** in parallel, so every file receives **3 distinct responses**. In **free mode** (`free: true`, Nemotron 120B free tier) and **local mode** (LM Studio, Ollama, …) each file receives **1 response**.

**`answer_mode` controls only how reports are written to disk, NOT how files are grouped into LLM requests.** Avoiding `answer_mode: 0` does NOT give the LLM wider visibility.

**answer_mode : 0**
- **NAME**: ONE REPORT PER FILE
- **DESCRIPTION**: One `.md` per input file. MCP parses the LLM's batch response by `## File: <path>` markers and saves one report per file.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: You want fine-grained, per-file output — each downstream consumer reads only its own file's report.
- **ADVANTAGES**: Trivially routed. Supports `max_retries` parallel + retry + circuit breaker.
- **DISADVANTAGES**: N files → N reports on disk.

**answer_mode : 1**
- **NAME**: ONE REPORT PER GROUP
- **DESCRIPTION**: One `.md` per group. Groups are either explicit (`---GROUP:id---` markers) or auto-generated when no markers are supplied. Auto-grouping priorities: (1) parent subfolder, (2) language/extension, (3) namespace/package, (4) shared basename prefix, (5) shared imports. Max 1 MB per group; oversized buckets split via bin packing.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: You want one report per logical chunk of the codebase (feature folder, module).
- **ADVANTAGES**: Fewer files than mode 0, more granular than mode 2. Group boundaries match natural project structure.
- **DISADVANTAGES**: Heuristic grouping when markers are not supplied — pass explicit markers for exact control.

**answer_mode : 2**
- **NAME**: SINGLE REPORT
- **DESCRIPTION**: Exactly one `.md` for the whole operation, all batches merged.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: A single summary across all scanned files; easy to hand off.
- **ADVANTAGES**: Simplest output. One path returned.
- **DISADVANTAGES**: Large scans produce long reports; downstream per-file routing requires re-parsing sections.

If you need cross-file analysis across the whole codebase (e.g. "find duplicates" or "is this already implemented?"), use `search_existing_implementations` — each file is compared against a REFERENCE, no global visibility needed.

## Read-only analysis tools

| Tool | Use When | Default answer_mode |
|------|----------|-------------------|
| `chat` | General-purpose: summarize, compare, translate, generate text. Also handles custom_prompt calls. Accepts `folder_path`. | 2 (merged) |
| `code_task` | Code-optimized analysis with code-review system prompt. Use for audits, reviews. Accepts `folder_path`. | 2 (merged) |
| `scan_folder` | Auto-discover files in a directory tree and check each. Good for codebase-wide scans. Per-file LLM calls (no batching — one call per file). | 0 (per-file) |
| `compare_files` | 3 modes: pair (2 files), batch (`file_pairs` array), git diff (`git_repo` + `from_ref` + `to_ref`). LLM summarizes differences. | N/A |
| `check_references` | Auto-resolve local imports, send source+dependencies to LLM to validate symbol references. Accepts `folder_path`. | 2 (merged) |
| `check_imports` | Two-phase: LLM extracts all import paths, server validates each exists on disk. Accepts `folder_path`. | 2 (merged) |
| `check_against_specs` | Compare source files against a specification file. Reports violations only (not missing features). Accepts `folder_path`, `input_files_paths`, or both combined. | 2 (merged) |
| `search_existing_implementations` | Scan a codebase for existing implementations of a described feature. FFD-batched (~500 calls for a 10k-file codebase), ensemble-backed, exhaustive per-file `NO` / `YES symbol=<name> lines=<a-b>` output. Optional `source_files` and `diff_path` for PR duplicate-check. Default `max_files: 10000`. Mode 1 emits one merged report per auto-group; mode 0 splits each batch response by `## File:` markers into per-file reports. Batching (1-5 files per LLM call) is always active. | 2 (merged) |

## Utility tools

| Tool | Purpose |
|------|---------|
| `discover` | Check service health, auth token status, context window, concurrency mode, profiles |
| `reset` | Full soft-restart. Waits for running requests, then reloads settings (picks up manual edits to `settings.yaml`) and clears caches. |
| `get_settings` | Copy `settings.yaml` to output dir and return the path. Read-only view — edit the REAL file at `~/.llm-externalizer/settings.yaml` manually, then call `reset`. |
| `or_model_info` / `or_model_info_table` / `or_model_info_json` | Query OpenRouter for a model's supported params, pricing, latency, uptime. Three output formats (pipe-delimited markdown, ANSI-colored terminal table, raw JSON). |

### Disabled tools (by design)

The LLM Externalizer MCP is read-only by design. The following tools exist but are disabled — calling them returns a refusal message:

| Tool | Why disabled |
|------|--------------|
| `fix_code`, `batch_fix`, `merge_files`, `split_file`, `revert_file` | File edits are applied exclusively by the `llm-externalizer-scan-and-fix` plugin command, which spawns local agents that use Read+Edit directly. |
| `set_settings`, `change_model` | Model & profile configuration is user-only. Edit `~/.llm-externalizer/settings.yaml` manually in your editor, then call `reset` or restart Claude Code. |

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

**NOTE**: `check_against_specs` uses `spec_file_path` (required) plus `input_files_paths`, `folder_path`, or both combined for source files.

## Advanced Parameters

| Parameter | Tools | Values | Notes |
|-----------|-------|--------|-------|
| `max_tokens` | All content tools | number | Override max response tokens (default: model max ~65,535). |
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
| `ensemble` | All content tools | boolean (default: true on OpenRouter) | Run all ensemble models in parallel. Set `false` for simple tasks to save tokens. |
| `answer_mode` | Multi-file tools | 0, 1, or 2 | 0 = ONE REPORT PER FILE (parallel+retry when `max_retries>1`). 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/basename if no `---GROUP:id---` markers, max 1 MB per group). 2 = SINGLE REPORT (merged). See "How batching works" above. |
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

- **600s base timeout** per LLM request. Extended automatically when reasoning models are actively thinking.
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
