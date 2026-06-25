---
name: llm-externalizer-high-quality-scan
description: Folder scan driven by ONE strong remote model (default z-ai/glm-5.2) at max reasoning effort + prompt cache, NOT the cheap 3-model ensemble. Thin wrapper over the high_quality_scan MCP tool. Paid and OpenRouter-only — fails fast (never silently downgrades) on a local backend, free_only mode, or exhausted credit. Use when review quality matters more than cost.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__high_quality_scan
  - Bash
argument-hint: '<folder> --instructions "<task>" [scan flags]'
effort: medium
---

Thin wrapper over `mcp__llm-externalizer__high_quality_scan`. Same recursive folder scan as `scan_folder`, but every file is reviewed by ONE strong remote model (default `z-ai/glm-5.2`) at **maximum reasoning effort** with **prompt caching** — not the cheap 3-model ensemble. All heavy lifting (folder walking, FFD bin-packing, the single high-quality model call, provider routing, caching) happens server-side.

**Paid + OpenRouter-only by design.** The high-quality model costs money, so the tool **fails fast** rather than silently downgrading: it refuses on a local backend, in `free_only` mode, or when OpenRouter credit is exhausted. For those cases use `/llm-externalizer:llm-externalizer-scan-and-fix` (cheap ensemble / free pool). Configure the model via the `high_quality_model` block in `~/.llm-externalizer/settings.yaml` (`id`, `reasoning_effort`, `cache`, `min_quantization`, `provider`).

**How the LLM sees the codebase**: the server packs files into batches up to `max_payload_kb` (default 400 KB) each — **typically 1–5 files per batch**. Each batch is ONE call to the high-quality model. The LLM never sees the whole codebase at once. `answer_mode` controls only how reports are written to disk (0 = one report per file, 1 = one per group, 2 = single merged), NOT how many files the model sees per call.

## Step 1 — Parse `$ARGUMENTS`

- **`<folder>`** (MANDATORY): the first positional argument — an absolute path to a directory. Relative paths resolve against `$CLAUDE_PROJECT_DIR`.
- **`--instructions "<task>"`** (MANDATORY unless `--instructions-file` is given): what to look for or do with each file.
- **`--instructions-file <path>`**: file(s) containing the instructions (repeatable or comma-separated). Replaces `--instructions`.
- **Forwarded flags**: `--extensions <a,b>`, `--exclude-dirs <a,b>`, `--max-files <n>`, `--max-payload-kb <n>`, `--answer-mode <n>`, `--redact-regex <pat>`, `--scan-secrets`, `--redact-secrets`, `--no-gitignore`, `--output-dir <path>`.

Abort with `[FAILED] llm-externalizer-high-quality-scan — <reason>` on any validation failure (missing folder, missing instructions, folder not a directory).

## Step 2 — Verify service is online

Call `mcp__llm-externalizer__discover`. Abort with `[FAILED] — service offline` if OFFLINE. The `discover` output also shows the active backend and whether `free_only` is on — if the backend is NOT OpenRouter or `free_only` is active, warn the user that `high_quality_scan` will fail fast, and suggest `/llm-externalizer:llm-externalizer-scan-and-fix` instead.

## Step 3 — Call the MCP tool directly

Prefer calling `mcp__llm-externalizer__high_quality_scan` directly:

```json
{
  "folder_path": "<absolute folder from step 1>",
  "instructions": "<task from --instructions, if given>",
  "instructions_files_paths": "<array from --instructions-file, if given>"
}
```

Forward the optional flags the user supplied:

- `--extensions` → `"extensions": [".py", ".ts"]`
- `--exclude-dirs` → `"exclude_dirs": ["a","b"]`
- `--max-files` → `"max_files": N` (server default: 2500)
- `--max-payload-kb` → `"max_payload_kb": N` (server default: 400)
- `--answer-mode` → `"answer_mode": N` (server default for this tool: per-file)
- `--redact-regex` → `"redact_regex": "<pat>"`
- `--scan-secrets` → `"scan_secrets": true`
- `--redact-secrets` → `"redact_secrets": true`
- `--no-gitignore` → `"use_gitignore": false`
- `--output-dir` → `"output_dir": "<path>"`

**Alternative — shell out to the CLI**: `llm-externalizer high-quality-scan --folder <path> --instructions "<task>" [scan flags]` implements the same call (spawns the server, calls the tool, prints the report paths). Prefer this for non-interactive workflows.

## Step 4 — Return the result

The tool returns a text body with the per-file report paths (or a merged-report path). Forward that text to the user verbatim — do NOT read any report, do NOT summarize. If the result is an error (paid-model gate refusal), surface the one-line reason so the user can switch backends or top up credit.

## When NOT to use this command

- The backend is local or `free_only`, or you have no OpenRouter credit → it will fail fast; use `/llm-externalizer:llm-externalizer-scan-and-fix` (cheap/free) instead.
- You want the findings AUTO-FIXED in the same run → use `/llm-externalizer:llm-externalizer-high-quality-scan-and-fix` (scan + Opus verify-then-fix).
- You need cross-file reference validation → use the `check_against_specs` or `search_existing_implementations` tools (the LLM sees only 1–5 files per batch and cannot validate references against files outside the batch).

## Constraints

- You MUST NOT read any report contents.
- You MUST NOT modify any files (this command only SCANS; the `_and_fix` variant fixes).
- This is the third surface of the high_quality_scan capability (MCP tool + CLI command + this slash command).
