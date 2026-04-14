---
name: search-existing-implementations
description: Scan a codebase (same language as the input files) for an existing implementation of the described feature. Wraps the llm-externalizer search_existing_implementations MCP tool. Takes a mandatory feature description, one or more codebase paths, and OPTIONAL PR source files and diff. When source files are given, the command auto-generates a PR diff via `git diff <base>...HEAD` unless one is supplied. Files are FFD-batched into ~400KB LLM requests (configurable), so 10k-file codebases typically need ~500 LLM calls instead of 10k. Exhaustive per-file output — every occurrence is reported, no cap. Works both for PR duplicate-check reviews and for greenfield "is this already done?" audits.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__search_existing_implementations
  - Bash
argument-hint: '"<description>" [<src-files>...] --in <path> [--base <ref>] [--diff <path>] [--free] [--output-dir <path>]'
effort: medium
---

Thin wrapper over `mcp__llm-externalizer__search_existing_implementations`. All heavy lifting (folder walking, FFD bin-packing, batched ensemble LLM calls, source-file exclusion) happens server-side.

The server packs files into batches up to `max_payload_kb` (default 400 KB) each, so one LLM call processes many files at once. For a 10k-file codebase this typically means ~500 LLM calls instead of 10k. Default `answer_mode` is 2 (single merged report with per-batch sections and per-file `NO` / `YES symbol=... lines=...` entries). EXHAUSTIVE: every occurrence in every file is reported — no 5-match cap — so a reviewer can delete every duplicate and keep only the PR's new implementation.

## Step 1 — Parse `$ARGUMENTS`

- **`description`** (MANDATORY): the first quoted string. Non-empty.
- **`source_files`** (OPTIONAL, 0+): positional absolute paths after the description. The PR's new/modified files. If omitted, runs as a pure description-based scan.
- **`--in <path>`** (MANDATORY, repeatable or comma-separated): codebase path(s) to scan. Each entry must be an absolute path to a directory.
- **`--base <ref>`** (OPTIONAL): git ref to diff source files against. Default auto-detection order: `origin/HEAD` → `main` → `master`. Only used when source files are given.
- **`--diff <path>`** (OPTIONAL escape hatch): pre-made unified-diff file. Overrides `--base`.
- **Forwarded flags**: `--free`, `--output-dir <path>`, `--exclude-dirs <a,b,c>`, `--extensions <a,b>`, `--max-files <n>`, `--redact-regex <pattern>`, `--answer-mode <n>`.

Abort with `[FAILED] search-existing-implementations — <reason>` on any validation failure.

## Step 2 — Verify service is online

Call `mcp__llm-externalizer__discover`. Abort with `[FAILED] — service offline` if OFFLINE.

## Step 3 — Resolve the PR diff (only if source files were given)

- **If `--diff <path>` was given** → use that path as-is.
- **Else if source files were given and `--base <ref>` was given** → run via `Bash`:
  ```
  cd <git repo root of the first source file>
  git diff "<ref>...HEAD" -- <src-file-1> <src-file-2> ... > /tmp/llm-ext-search-existing-diff-<timestamp>.patch
  ```
- **Else if source files were given and no `--base`** → auto-detect the base branch:
  1. `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` → use that
  2. If it fails, check `git show-ref --verify --quiet refs/heads/main` → use `main`
  3. If that fails, check `refs/heads/master` → use `master`
  4. If none resolve OR cwd is not a git repo → abort with `[FAILED] — cannot auto-detect base branch; pass --base <ref> or --diff <path>`
- **Else (no source files)** → skip this step; `diff_path` stays undefined and the server runs a pure description-based scan.

If git diff fails or produces an empty diff, abort with a clear `[FAILED]` message.

## Step 4 — Call the MCP tool

Call `mcp__llm-externalizer__search_existing_implementations` with:

```json
{
  "feature_description": "<description from step 1>",
  "folder_path": "<single path or array from --in>",
  "source_files": "<array from step 1 if non-empty, else omit>",
  "diff_path": "<resolved path from step 3 if any, else omit>"
}
```

`answer_mode` defaults to 2 (single merged report). Set it explicitly only if the user asked for per-batch reports (`1`).

Forward the optional flags if the user supplied them:

- `--free` → `"free": true`
- `--output-dir` → `"output_dir": "<path>"`
- `--exclude-dirs` → `"exclude_dirs": ["a","b","c"]`
- `--extensions` → `"extensions": [".py", ".ts"]`
- `--max-files` → `"max_files": N`
- `--redact-regex` → `"redact_regex": "<pattern>"`
- `--answer-mode` → `"answer_mode": N`

The server handles everything: walks the folder(s), filters by extensions (auto-detected from source files if not supplied), excludes source files from the scan, builds the specialized yes/no prompt internally, runs each file through the ensemble with auto-batching up to `max_payload_kb`, and returns one report per file.

## Step 5 — Return the result

The MCP tool returns a text body with the `SEARCH COMPLETE` summary and a list of `REPORTS:` paths. Forward that text to the user verbatim — do NOT read any report, do NOT summarize. The reviewer opens the reports they care about.

## Constraints

- You MUST NOT read any report contents.
- You MUST NOT include source files in `folder_path` — they go in `source_files` only.
- You MUST NOT modify any files.
- If the filtered codebase exceeds `max_files` (default 2500), ask the user to narrow `--in` or raise `--max-files`; do not attempt workarounds.
