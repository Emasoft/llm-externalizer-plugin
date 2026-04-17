---
name: llm-externalizer-search-existing-implementations
description: Scan a codebase (same language as the input files) for an existing implementation of the described feature. Wraps the llm-externalizer search_existing_implementations MCP tool. Takes a mandatory feature description, one or more codebase paths, and OPTIONAL PR source files and diff. When source files are given, the command auto-generates a PR diff via `git diff <base>...HEAD` unless one is supplied. Files are FFD-batched into ~400KB LLM requests (configurable), so 10k-file codebases typically need ~500 LLM calls instead of 10k. Exhaustive per-file output — every occurrence is reported, no cap. Works both for PR duplicate-check reviews and for greenfield "is this already done?" audits.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__search_existing_implementations
  - Bash
argument-hint: '"<description>" [<src-files>...] --in <path> [--base <ref>] [--diff <path>] [--free] [--output-dir <path>]'
effort: medium
---

Thin wrapper over `mcp__llm-externalizer__search_existing_implementations`. All heavy lifting (folder walking, FFD bin-packing, batched ensemble LLM calls, source-file exclusion) happens server-side.

**How the LLM sees the codebase**: The server packs files into batches up to `max_payload_kb` (default 400 KB) each — **typically 1–5 files per batch**. Each batch is ONE LLM call. The LLM never sees the whole codebase at once and doesn't need to: each file is compared against the reference (feature description + optional source files + optional diff), not against other files. In **ensemble mode** each file receives 3 responses from 3 LLMs running in parallel; in `--free` mode each file receives 1 response. For a 10k-file codebase this is typically ~500 LLM calls instead of 10k.

**Output** (default `answer_mode` is 2):

- **answer_mode : 0 — ONE REPORT PER FILE.** MCP splits each batch response by `## File:` markers and writes one `.md` per input file. Output: `<input_file> -> <report_file>` pairs.
- **answer_mode : 1 — ONE REPORT PER GROUP.** MCP auto-groups scanned files by subfolder/extension/basename (max 1 MB per group) and writes one merged `.md` per group. Output: `[group:id] <report>` lines.
- **answer_mode : 2 — SINGLE REPORT (default).** One merged `.md` with per-batch sections and per-file `NO` / `YES symbol=... lines=...` entries.

Batching is identical across all three modes — only the persistence differs. EXHAUSTIVE: every occurrence in every file is reported (no cap) so a reviewer can delete every duplicate and keep only the PR's new implementation.

## Step 1 — Parse `$ARGUMENTS`

- **`description`** (MANDATORY): the first quoted string. Non-empty.
- **`source_files`** (OPTIONAL, 0+): positional absolute paths after the description. The PR's new/modified files. If omitted, runs as a pure description-based scan.
- **`--in <path>`** (MANDATORY, repeatable or comma-separated): codebase path(s) to scan. Each entry must be an absolute path to a directory.
- **`--base <ref>`** (OPTIONAL): git ref to diff source files against. Default auto-detection order: `origin/HEAD` → `main` → `master`. Only used when source files are given.
- **`--diff <path>`** (OPTIONAL escape hatch): pre-made unified-diff file. Overrides `--base`.
- **Forwarded flags**: `--free`, `--output-dir <path>`, `--exclude-dirs <a,b,c>`, `--extensions <a,b>`, `--max-files <n>`, `--max-payload-kb <n>`, `--answer-mode <n>`.

Abort with `[FAILED] llm-externalizer-search-existing-implementations — <reason>` on any validation failure.

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

## Scope rules — when NOT to use this command

**Do NOT use this command for structural validation of plugin files** — frontmatter schema, argument-hint consistency, skill description coverage, plugin.json conformance. Those are deterministic checks that belong to:

- `claude-plugin-validation` (CPV) — `cpv-validate-plugin`, `cpv-validate-skill`, `cpv-semantic-validation`
- `claude plugin validate .` — the authoritative Claude Code CLI validator
- Project-local validation scripts (AST / schema parsers)

A validator runs these in milliseconds and is reproducible. An LLM doing the same work is orders of magnitude more expensive, non-reproducible, and prone to hallucinated findings.

This command is a good fit ONLY when the check requires semantic understanding an AST cannot do: "has anyone already implemented retry-with-backoff?", "does the codebase already contain a memoization helper with this exact API shape?", "is this new PR's rate-limit logic a duplicate of an existing module?". For those cases, the `feature_description` IS the instruction the LLM needs — no structural-schema check will ever answer the question.

If the codebase contains `.md` files (agent/command/skill definitions, docs): the `feature_description` must explicitly name what you're hunting for in prose (e.g. "an agent that does X" or "a skill that triggers on Y"). Otherwise `.md` files will produce noise.

## Constraints

- You MUST NOT read any report contents.
- You MUST NOT include source files in `folder_path` — they go in `source_files` only.
- You MUST NOT modify any files.
- If the filtered codebase exceeds `max_files` (default 10000), ask the user to narrow `--in` or raise `--max-files`; do not attempt workarounds.
- If source files are given but the user passed neither `--base` nor `--diff`, and cwd is not a git repo, omit `diff_path` entirely and run a pure description-based scan (do not abort).
