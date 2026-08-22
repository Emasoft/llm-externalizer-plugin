# LLM Externalizer — Usage Patterns

## Table of Contents

- [Scan a codebase for issues](#scan-a-codebase-for-issues)
- [Analyze multiple files in parallel](#analyze-multiple-files-in-parallel)
- [Apply same check to each file independently](#apply-same-check-to-each-file-independently)
- [Compare two file versions (pair mode)](#compare-two-file-versions-pair-mode)
- [Compare files in batch mode](#compare-files-in-batch-mode)
- [Compare files via git diff](#compare-files-via-git-diff)
- [Check for broken code references](#check-for-broken-code-references-after-refactoring)
- [Check for broken file imports](#check-for-broken-file-imports)
- [Reuse instructions across operations](#reuse-instructions-across-operations)
- [Simple task with ensemble off](#simple-task-with-ensemble-off-save-tokens)
- [Quick factual answer](#quick-factual-answer-with-low-max_tokens)
- [Code review with persona](#code-review-with-persona)
- [Scan folder with gitignore](#scan-folder-with-gitignore--excluded-dirs)
- [Use folder_path on any tool](#use-folder_path-on-any-tool)
- [Redact custom patterns](#redact-custom-patterns)
- [Check source against specification](#check-source-against-specification)
- [Check entire folder against specification](#check-entire-folder-against-specification)
- [Grouped file processing](#grouped-file-processing-isolated-reports)
- [Code-optimized analysis](#code-optimized-analysis)
- [Compact a Claude Code session for $0](#compact-a-claude-code-session-for-0)

Concrete examples for every command with recommended flags. There is no MCP server — `llm-ext`
(shipped at `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext`) is the only runtime surface. Array-valued flags
accept a comma-separated list, a repeated flag, or a JSON array — a JSON array is required when a
value itself contains a comma (e.g. `file_pairs`, or `---GROUP:id---` markers). On a **paid**
profile, prepend `--estimate` to any command below for a $0 dry-run that prints the predicted
cost before you send anything real; skip it on a free profile (everything is $0).

## Scan a codebase for issues

```bash
# $0 dry-run first on a paid profile — prints the predicted cost, sends nothing.
llm-ext scan-folder --estimate \
  --folder_path /path/to/src \
  --extensions .ts,.py \
  --instructions "Find security vulnerabilities. This is a Node.js REST API using Express."

# Once the ceiling fits the budget, drop --estimate to run for real.
llm-ext scan-folder \
  --folder_path /path/to/src \
  --extensions .ts,.py \
  --instructions "Find security vulnerabilities. This is a Node.js REST API using Express."
```

## Analyze multiple files in parallel

```bash
llm-ext chat \
  --instructions "Compare these configs and list differences" \
  --input_files_paths /path/a.yaml,/path/b.yaml
```

## Apply same check to each file independently

> **Note**: the `batch-check` command is **deprecated**. Use any content command with
> `--answer_mode 0 --max_retries 3` instead.

```bash
llm-ext code-task \
  --answer_mode 0 \
  --max_retries 3 \
  --instructions "Find all TODO comments and classify by urgency" \
  --input_files_paths /path/a.ts,/path/b.ts,/path/c.ts
```

## Compare two file versions (pair mode)

```bash
llm-ext compare-files \
  --input_files_paths /path/old.ts,/path/new.ts \
  --instructions "Focus on API breaking changes"
```

## Compare files in batch mode

Compare multiple file pairs at once using the `--file_pairs` flag (JSON array of `[fileA, fileB]` pairs):

```bash
llm-ext compare-files \
  --file_pairs '[["/path/old/auth.ts","/path/new/auth.ts"],["/path/old/routes.ts","/path/new/routes.ts"],["/path/old/middleware.ts","/path/new/middleware.ts"]]' \
  --instructions "Summarize changes in each pair. This is a Node.js Express API."
```

Supports `---GROUP:id---` markers as single-element entries in `--file_pairs` for grouped reports:

```bash
llm-ext compare-files \
  --file_pairs '[["---GROUP:auth---"],["/path/old/auth.ts","/path/new/auth.ts"],["---/GROUP:auth---"],["---GROUP:api---"],["/path/old/routes.ts","/path/new/routes.ts"],["---/GROUP:api---"]]' \
  --instructions "Summarize changes per group"
```

## Compare files via git diff

Compare files between two git refs (commits, tags, branches):

```bash
llm-ext compare-files \
  --git_repo /path/to/repo \
  --from_ref v1.0.0 \
  --to_ref v2.0.0 \
  --instructions "Focus on API breaking changes and security implications"
```

`--to_ref` defaults to `HEAD` if omitted.

## Check for broken code references after refactoring

```bash
llm-ext check-references \
  --input_files_paths /path/to/file.ts \
  --instructions "This is a TypeScript MCP server. Check all symbol references are valid."
```

## Check for broken file imports

```bash
llm-ext check-imports --input_files_paths /path/to/file.ts
```

## Reuse instructions across operations

```bash
llm-ext code-task \
  --answer_mode 0 \
  --max_retries 3 \
  --instructions_files_paths /path/to/review-rules.md \
  --input_files_paths /path/a.ts,/path/b.ts
```

## Simple task with ensemble off (save tokens)

```bash
llm-ext chat \
  --instructions "What is the main export of this module?" \
  --input_files_paths /path/to/file.ts
```

(`ensemble: false` has no CLI flag — `chat` always uses the active profile's configured
ensemble. The closest lever is `--free`, which routes the call to a single free model instead
of the 3-model ensemble.)

## Quick factual answer with low max_tokens

```bash
llm-ext chat \
  --instructions "List the function names exported from this module. One per line." \
  --input_files_paths /path/to/file.ts
```

(`max_tokens` and `temperature` have no CLI flag equivalent — omitted. Output length and
sampling are controlled by the active profile's model configuration, not per-call.)

## Code review with persona

```bash
llm-ext chat \
  --instructions "Review this Python CLI script for error handling gaps." \
  --input_files_paths /path/to/cli.py \
  --system "Senior Python CLI developer"
```

## Scan folder with gitignore + excluded dirs

```bash
llm-ext scan-folder \
  --folder_path /path/to/project \
  --extensions .py \
  --use_gitignore true \
  --exclude_dirs migrations,fixtures \
  --instructions "Find security vulnerabilities. This is a Django REST API."
```

## Use folder_path on any tool

All content commands (except `scan-folder`, which requires it, and `compare-files`, which has
its own modes) accept `--folder_path` to auto-discover files from a directory. Can be combined
with `--input_files_paths`:

```bash
llm-ext code-task \
  --folder_path /path/to/src \
  --extensions .ts \
  --recursive true \
  --follow_symlinks true \
  --use_gitignore true \
  --max_files 2500 \
  --instructions "Find potential null pointer exceptions. TypeScript Node.js project."
```

Combining `--folder_path` with explicit files:

```bash
llm-ext chat \
  --folder_path /path/to/src/utils \
  --extensions .ts \
  --input_files_paths /path/to/src/index.ts \
  --instructions "Summarize what this module does. All utils + the entry point."
```

## Redact custom patterns

Use `--redact_regex` to redact matching strings before they reach the LLM:

```bash
llm-ext chat \
  --instructions "Review this configuration for best practices" \
  --input_files_paths /path/to/config.ts \
  --redact_regex "https?://[a-zA-Z0-9._:/-]+"
```

Alphanumeric matches become `[REDACTED:USER_PATTERN]`, numeric-only matches become zero-padded placeholders. Works on all content commands alongside `--scan_secrets` and `--redact_secrets`.

## Check source against specification

```bash
llm-ext check-against-specs \
  --spec_file_path /path/to/api-spec.md \
  --input_files_paths /path/to/impl.ts \
  --instructions "Check compliance with the API contract"
```

## Check entire folder against specification

```bash
llm-ext check-against-specs \
  --spec_file_path /path/to/rules.md \
  --folder_path /path/to/src \
  --extensions .ts \
  --use_gitignore true \
  --instructions "Check if forbidden endpoints are used"
```

## Grouped file processing (isolated reports)

```bash
llm-ext code-task \
  --instructions "Find bugs and security issues. This is a Node.js API." \
  --input_files_paths '["---GROUP:auth---","/path/to/auth.ts","/path/to/auth.test.ts","---/GROUP:auth---","---GROUP:api---","/path/to/routes.ts","/path/to/middleware.ts","---/GROUP:api---"]'
```

Returns one report per group:
```
[group:auth] /path/to/reports/llm-externalizer/code_task_group-auth_...md
[group:api] /path/to/reports/llm-externalizer/code_task_group-api_...md
```

## Code-optimized analysis

```bash
llm-ext code-task \
  --instructions "Audit for security vulnerabilities" \
  --input_files_paths /path/to/file.ts
```

(`ensemble: true` has no CLI flag — `code-task` always uses the active profile's configured
ensemble unless `--free` is passed, which routes to a single free model instead.)

## Compact a Claude Code session for $0

Summarize a whole session's `.jsonl` transcript — the same nine sections Claude Code's own
`/compact` produces (Primary Request and Intent, Key Technical Concepts, Files and Code
Sections, Errors and Fixes, Problem Solving, All User Messages verbatim, Pending Tasks, Current
Work, Next Step) — but on **free** OpenRouter models only, so it always costs $0.

```bash
# Current project's most recent session, no flags needed.
llm-ext session-summary

# A specific transcript, printing the summary text directly (no report file).
llm-ext session-summary --transcript /path/to/session.jsonl --stdout
```

Every chunk is checkpointed, so a run interrupted by a free-model daily-quota hit resumes
automatically on re-run; `--resume` fails fast instead of silently starting over if no matching
checkpoint exists yet. See `tool-reference.md` → "`session_summary`" and `README.md` →
"session_summary — session compaction, $0 by construction" for the full flag table.
