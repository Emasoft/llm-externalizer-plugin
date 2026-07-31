---
name: llm-externalizer-high-quality-scan
description: Folder scan driven by ONE strong remote model (default z-ai/glm-5.2) at max reasoning effort + prompt cache, NOT the cheap 3-model ensemble. Thin wrapper over the high-quality-scan CLI command. Paid and OpenRouter-only — fails fast (never silently downgrades) on a local backend, free_only mode, or exhausted credit. Use when review quality matters more than cost.
allowed-tools:
  - Bash
argument-hint: '<folder> --instructions "<task>" [scan flags]'
effort: medium
---

Thin wrapper over `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext high-quality-scan`. Same recursive folder scan as `scan-folder`, but every file is reviewed by ONE strong remote model (default `z-ai/glm-5.2`) at **maximum reasoning effort** with **prompt caching** — not the cheap 3-model ensemble. All heavy lifting (folder walking, FFD bin-packing, the single high-quality model call, provider routing, caching) happens inside the CLI process.

**Paid + OpenRouter-only by design.** The high-quality model costs money, so the tool **fails fast** rather than silently downgrading: it refuses on a local backend, in `free_only` mode, or when OpenRouter credit is exhausted. For those cases use `/llm-externalizer:llm-externalizer-scan-and-fix` (cheap ensemble / free pool). Configure the model via the `high_quality_model` block in `~/.llm-externalizer/settings.yaml` (`id`, `reasoning_effort`, `cache`, `min_quantization`, `provider`).

**How the LLM sees the codebase**: the server packs files into batches up to `max_payload_kb` (default 400 KB) each — **typically 1–5 files per batch**. Each batch is ONE call to the high-quality model. The LLM never sees the whole codebase at once. `answer_mode` controls only how reports are written to disk (0 = one report per file, 1 = one per group, 2 = single merged), NOT how many files the model sees per call.

## Step 1 — Parse `$ARGUMENTS`

- **`<folder>`** (MANDATORY): the first positional argument — an absolute path to a directory. Relative paths resolve against `$CLAUDE_PROJECT_DIR`.
- **`--instructions "<task>"`** (MANDATORY unless `--instructions-file` is given): what to look for or do with each file.
- **`--instructions-file <path>`**: file(s) containing the instructions (repeatable or comma-separated). Replaces `--instructions`.
- **Forwarded flags**: `--extensions <a,b>`, `--exclude-dirs <a,b>`, `--max-files <n>`, `--max-payload-kb <n>`, `--answer-mode <n>`, `--redact-regex <pat>`, `--scan-secrets`, `--redact-secrets`, `--no-gitignore`, `--output-dir <path>`.

Abort with `[FAILED] llm-externalizer-high-quality-scan — <reason>` on any validation failure (missing folder, missing instructions, folder not a directory).

## Step 2 — Verify service is online

Run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext discover`. Abort with `[FAILED] — service offline` if OFFLINE. The `discover` output also shows the active backend and whether `free_only` is on — if the backend is NOT OpenRouter or `free_only` is active, warn the user that `high-quality-scan` will fail fast, and suggest `/llm-externalizer:llm-externalizer-scan-and-fix` instead.

## Step 3 — Call the CLI directly

```bash
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext high-quality-scan \
  --folder_path "<absolute folder from step 1>" \
  --instructions "<task from --instructions, if given>" \
  [--instructions_files_paths <path,path,...> if --instructions-file was given]
```

Forward the optional flags the user supplied:

- `--extensions` → `--extensions .py,.ts`
- `--exclude-dirs` → `--exclude_dirs a,b`
- `--max-files` → `--max_files N` (default: 2500)
- `--max-payload-kb` → `--max_payload_kb N` (default: 400)
- `--answer-mode` → `--answer_mode N`
- `--redact-regex` → `--redact_regex "<pat>"`
- `--scan-secrets` → `--scan_secrets`
- `--redact-secrets` → `--redact_secrets`
- `--no-gitignore` → `--use_gitignore false`
- `--output-dir` → `--output_dir "<path>"`

This can take several minutes on a large folder — run it with an explicit
long `timeout` or `run_in_background: true`.

## Step 4 — Return the result

The tool returns a text body with the per-file report paths (or a merged-report path). Forward that text to the user verbatim — do NOT read any report, do NOT summarize. If the result is an error (paid-model gate refusal), surface the one-line reason so the user can switch backends or top up credit.

## When NOT to use this command

- The backend is local or `free_only`, or you have no OpenRouter credit → it will fail fast; use `/llm-externalizer:llm-externalizer-scan-and-fix` (cheap/free) instead.
- You want the findings AUTO-FIXED in the same run → use `/llm-externalizer:llm-externalizer-high-quality-scan-and-fix` (scan + Opus verify-then-fix).
- You need cross-file reference validation → use the `check-against-specs` or `search-existing-implementations` commands (the LLM sees only 1–5 files per batch and cannot validate references against files outside the batch).

## Constraints

- You MUST NOT read any report contents.
- You MUST NOT modify any files (this command only SCANS; the `_and_fix` variant fixes).
- This is a thin wrapper over the `high-quality-scan` CLI command — the CLI is the only surface.
