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
- **Forwarded flags**: `--free`, `--output-dir <path>`, `--exclude-dirs <a,b,c>`, `--extensions <a,b>`, `--max-files <n>`, `--max-payload-kb <n>`, `--answer-mode <n>`.

Abort with `[FAILED] search-existing-implementations — <reason>` on any validation failure.

## Step 2 — Verify service is online

Call `mcp__llm-externalizer__discover`. Abort with `[FAILED] — service offline` if OFFLINE.

## Step 3 — Call the MCP tool directly

Prefer calling `mcp__llm-externalizer__search_existing_implementations` directly. All diff generation, batching, and file filtering happens server-side:

```json
{
  "feature_description": "<description from step 1>",
  "folder_path": "<single path or array from --in>",
  "source_files": "<array from step 1 if non-empty, else omit>",
  "diff_path": "<pre-made --diff path if given, else omit>"
}
```

Forward optional flags the user supplied:

- `--free` → `"free": true`
- `--output-dir` → `"output_dir": "<path>"`
- `--exclude-dirs` → `"exclude_dirs": ["a","b","c"]`
- `--extensions` → `"extensions": [".py", ".ts"]`
- `--max-files` → `"max_files": N`  (server default: 10000 — higher than scan_folder's 2500)
- `--max-payload-kb` → `"max_payload_kb": N`
- `--answer-mode` → `"answer_mode": N`  (server default: 2 = single merged report; mode 0 falls back to mode 1 per-batch reports since per-file calls defeat the batching)

**If the user passed `--base <ref>` (no `--diff`)**, you need to generate the diff yourself. Use `Bash` to run `git diff <ref>...HEAD -- <source-files> > /tmp/llm-ext-diff-<timestamp>.patch` from the git root, then pass the temp path as `diff_path`. Auto-detect the base if missing: try `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, fall back to `main`, then `master`. Abort with a clear `[FAILED]` if cwd is not a git repo, if the diff is empty, or if auto-detection fails.

**Alternative — shell out to the CLI**: `llm-externalizer search-existing` implements all of the above natively (including `--base` auto-generation and 4-hour timeout) and can be invoked via `Bash` as a single command. Prefer this for non-interactive workflows.

## Step 4 — Return the result

The MCP tool returns a text body with the `SEARCH COMPLETE` summary, a `MERGED REPORT:` path (mode 2) or a list of `REPORTS:` paths (mode 1), and any failed/skipped batches. Forward that text to the user verbatim — do NOT read any report, do NOT summarize. The reviewer opens the reports they care about.

## Constraints

- You MUST NOT read any report contents.
- You MUST NOT include source files in `folder_path` — they go in `source_files` only.
- You MUST NOT modify any files.
- If the filtered codebase exceeds `max_files` (default 10000), ask the user to narrow `--in` or raise `--max-files`; do not attempt workarounds.
- If source files are given but the user passed neither `--base` nor `--diff`, and cwd is not a git repo, omit `diff_path` entirely and run a pure description-based scan (do not abort).
