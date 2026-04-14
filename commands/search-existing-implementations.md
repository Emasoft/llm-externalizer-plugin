---
name: search-existing-implementations
description: Scan the codebase (same language as the input files) for existing implementations that duplicate or overlap a PR's new feature. Delegates per-file comparison to the LLM Externalizer MCP server to keep orchestrator tokens low. Takes a mandatory feature description and one or more source files, optionally a diff.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__code_task
  - Read
  - Glob
  - Bash
argument-hint: '"<description>" <src-file> [more-files...] [--folder <path>] [--diff <path>]'
effort: medium
---

Search the codebase for existing implementations that already solve the feature the PR is introducing. Per-file comparison is delegated to the LLM Externalizer MCP server so that verbose output never touches the orchestrator's context window — you return only report file paths.

## Step 1 — Parse `$ARGUMENTS`

Extract these fields from the user's arguments. Fail fast if validation fails.

1. **`feature_description`** (MANDATORY): the first quoted string in `$ARGUMENTS`. Must be non-empty. This is the concise, human-written description of the PR's feature (e.g. `"async retry with exponential backoff and jitter"`). It will be injected into the per-file LLM prompt so the model knows what to look for even when the source files contain many unrelated functions.
2. **`source_files`** (MANDATORY, one or more): absolute paths to the PR's new/modified file(s), given as positional arguments after the quoted description. These are the **reference** — their contents are shipped to the LLM as context but they are NOT scanned as targets.
3. **`--folder <path>`** (OPTIONAL): subtree to search. Default: the current working directory (project root).
4. **`--diff <path>`** (OPTIONAL): absolute path to a unified-diff file showing the exact PR changes. When present, the diff is also shipped to the LLM as extra context so it can pinpoint the NEW lines (prefixed with `+`) inside the source files.

Validation (abort with `[FAILED] search-existing-implementations — <reason>` if any fails):
- `feature_description` must be non-empty
- At least one `source_files` path must be provided and each file MUST exist
- `--folder` (if provided) MUST exist and be a directory
- `--diff` (if provided) MUST exist and be a readable file
- All paths MUST be absolute

## Step 2 — Verify the service is online

Call `mcp__llm-externalizer__discover`. If it reports OFFLINE, abort with `[FAILED] search-existing-implementations — service offline`.

## Step 3 — Detect language and build the target file list

Inspect each source file's extension to build the language-extension filter set. Common mappings:

| Extension | Filter set |
|-----------|-----------|
| `.py` | `{.py}` |
| `.ts`, `.tsx` | `{.ts, .tsx}` |
| `.js`, `.jsx` | `{.js, .jsx}` |
| `.go` | `{.go}` |
| `.rs` | `{.rs}` |
| `.java` | `{.java}` |
| `.rb` | `{.rb}` |
| `.php` | `{.php}` |
| `.c`, `.h` | `{.c, .h}` |
| `.cpp`, `.cc`, `.cxx`, `.hpp` | `{.cpp, .cc, .cxx, .hpp, .h}` |
| `.swift` | `{.swift}` |
| `.kt` | `{.kt}` |

If the source files span multiple languages, union their filter sets.

Use `Glob` to list every file under the target folder (default: cwd) matching the filter set, then strip:

- Any non-code directories: `node_modules/**`, `.git/**`, `dist/**`, `build/**`, `.venv/**`, `__pycache__/**`, `vendor/**`, `reports_dev/**`, `docs_dev/**`, `scripts_dev/**`, `.claude/**`, `target/**`, `out/**`
- Every path in `source_files` — the reference files must NOT be scanned against themselves (they'd trivially match)

If the filtered list is empty, abort with `[FAILED] search-existing-implementations — no matching files found in <folder>`.

## Step 4 — Build the specialized instructions string

Construct the `instructions` payload below, substituting `{DESCRIPTION}` with the user's feature description. Include the `{DIFF_NOTE}` block only if `--diff` was provided.

```
You are helping a code reviewer check for duplicate implementations. A pull request
proposes adding the following feature:

    {DESCRIPTION}

The reference implementation from the PR is appended to these instructions (one or
more source files). {DIFF_NOTE}

For the current file you are reviewing, answer ONE question: does this file already
implement — or contain helpers that could be trivially composed to implement — the
feature described above?

Focus on SEMANTIC equivalence, not line-by-line match. Different code achieving the
same goal still counts. The source files the PR adds may contain many functions and
features — only the one matching the feature description above is relevant; ignore
the rest.

Output format per finding (sorted by strength, most overlapping first):

  STATUS:     EXISTS | SIMILAR | HELPER | NONE
  SYMBOL:     <function / class / module name>
  LINES:      <start-end>
  RATIONALE:  <1-2 sentences on what already exists and how it relates>
  REUSE_PATH: <how the PR code could reuse or refactor to share with this symbol;
               only when STATUS != NONE>

Status meanings:
  EXISTS  — the same feature is already implemented in this file
  SIMILAR — a close variant exists; the PR could refactor to share code
  HELPER  — a utility exists that the PR could compose
  NONE    — no overlap in this file

If nothing matches, output exactly one line:
    NONE — no existing implementation in this file

Do NOT rewrite the PR code. Do NOT echo the reference back. Be terse and actionable.
```

`{DIFF_NOTE}` (insert only when `--diff` was provided):

```
A unified diff showing the EXACT PR changes is also appended — focus on lines
prefixed with "+" when reasoning about what's being added, since the source files
may contain other unchanged code.
```

## Step 5 — Call `mcp__llm-externalizer__code_task`

Pass exactly:

```json
{
  "instructions": "<the string built in step 4>",
  "instructions_files_paths": ["<each source file>", "<--diff path if provided>"],
  "input_files_paths": ["<filtered codebase list from step 3>"],
  "answer_mode": 0,
  "max_retries": 3
}
```

Field-by-field:

- **`instructions_files_paths`**: source files + diff (if given). The server reads each file once and appends its content to the per-file LLM prompt. This is the key trick that keeps the orchestrator's token budget low — you never read the source file contents into your own context, the server does it.
- **`input_files_paths`**: the filtered codebase list from step 3 — each one becomes its own scan target.
- **`answer_mode: 0`**: one `.md` report per input file.
- **`max_retries: 3`**: per-file retry with circuit breaker.
- The server auto-batches if the payload exceeds its budget (400 KB default).

## Step 6 — Return the report paths

The tool returns a list of absolute `.md` report file paths. Report them to the user verbatim using this exact format — do NOT read the reports, do NOT summarize, do NOT add commentary:

```
[DONE] search-existing-implementations — <N> reports
<absolute-path-1>
<absolute-path-2>
...
```

On any failure during the workflow:

```
[FAILED] search-existing-implementations — <one-line reason>
```

## Constraints

- You MUST NOT read any report contents. The whole point of this command is to keep verbose comparison output out of the orchestrator — return only paths.
- You MUST NOT include the source files in `input_files_paths`. They go into `instructions_files_paths` only, otherwise they will self-match.
- You MUST NOT modify any files. This command is strictly read-only.
- If the filtered codebase exceeds ~2500 files (the MCP server's safety cap), ask the user to narrow with `--folder <subpath>` before re-running. Do not attempt to work around the cap.
- If the user did not quote the feature description or passed it without quotes, try to reconstruct it from the first contiguous non-flag, non-file argument. If that's ambiguous, abort and ask the user to wrap the description in quotes.
