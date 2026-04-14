---
name: search-existing-implementations
description: Given a PR's new implementation, scan the target codebase (same language) to find any existing similar feature, function, or helper that already solves the problem. Each file is reviewed independently by the LLM Externalizer ensemble (so disagreements between models flag false positives). The LLM's answer per file is just NO, or YES with the offending symbol and line range — keeping reports tiny. Takes a quoted feature description, source files, a diff, and one or more codebase paths.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__code_task
  - Read
  - Glob
  - Bash
argument-hint: '"<description>" <src-file> [more-srcs...] --in <path> [--in <path>...] --diff <diff-path> [--free] [--output-dir <path>] [--exclude-dirs <list>]'
effort: medium
---

Search for duplicate implementations of a PR's new feature. All file-to-file comparison is delegated to the LLM Externalizer MCP server. The orchestrator never reads source content and returns only report paths.

## Step 1 — Parse `$ARGUMENTS`

All four inputs are MANDATORY. Abort with `[FAILED] search-existing-implementations — <reason>` on any validation failure.

1. **`description`** (MANDATORY): the first quoted string in `$ARGUMENTS`. Non-empty. One concise sentence describing the PR feature (e.g. `"async retry with exponential backoff and jitter"`). The source files may contain many unrelated functions — this string is what tells the LLM which one matters.
2. **`source_files`** (MANDATORY, 1+): the PR's new/modified files, given as positional absolute paths after the quoted description. These are the **reference** — their contents are shipped to the LLM as instruction context, never scanned as targets.
3. **`--diff <path>`** (MANDATORY, exactly one): absolute path to a unified-diff file showing the exact PR changes. Used by the LLM to focus on the NEW lines (prefixed with `+`) rather than the whole reference file.
4. **`--in <path>`** (MANDATORY, repeatable or comma-separated): one or more paths describing the codebase receiving the PR. Each entry may be an absolute path to a directory (walked recursively) or an absolute path to a specific file. Repeat the flag to add more paths: `--in /proj/src --in /proj/tests`, or use commas: `--in /proj/src,/proj/tests`. At least one is required.

Forwarded optional flags (same semantics as all other LLM Externalizer commands):

- `--free` → pass `"free": true` to the tool (Nemotron free mode, single model, lower quality, prompts logged by provider)
- `--output-dir <abs-path>` → pass `"output_dir": "<path>"` (custom reports directory)
- `--exclude-dirs <a,b,c>` → pass `"exclude_dirs": ["a","b","c"]` (extra dirs to skip on top of the built-in defaults)
- `--redact-regex <pattern>` → pass `"redact_regex": "<pattern>"` (custom redaction)

Validation checklist:
- `description` non-empty
- every `source_files` path exists and is a file
- `--diff` path exists and is a file
- every `--in` path exists (directory or file)
- all paths are absolute

## Step 2 — Verify the service is online

Call `mcp__llm-externalizer__discover`. Abort with `[FAILED] — service offline` if it reports OFFLINE.

## Step 3 — Detect language and collect target files

Detect the language-extension set from the source files' extensions. Union across all source files. Common mappings:

| Extensions | Filter set |
|------------|-----------|
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

For each `--in` entry, build the target list:

- If the entry is a directory → use `Glob` recursively with the language extensions
- If the entry is a file → add directly (only if its extension is in the filter set)

Then apply these filters:

- **Drop** anything under the default excluded directories: `node_modules`, `.git`, `dist`, `build`, `.venv`, `__pycache__`, `vendor`, `reports_dev`, `docs_dev`, `scripts_dev`, `.claude`, `target`, `out` — plus any extra dirs supplied via `--exclude-dirs`
- **Drop** every path listed in `source_files` — the reference files must NOT be scanned against themselves (trivial self-match)
- **Dedupe** across all `--in` paths

If the final list is empty, abort with `[FAILED] — no matching files found across --in paths`.

If the final list exceeds 2500 files, abort with `[FAILED] — codebase too large (<N> files); narrow --in or add --exclude-dirs`. The LLM Externalizer server has a 2500-file safety cap on scan_folder; the same cap applies here for consistency.

## Step 4 — Build the specialized instructions string

The LLM's job is to give a one-line answer per file. Build exactly this `instructions` string, substituting `{DESCRIPTION}`:

```
You are checking whether the file below already contains an implementation of this
feature, or a helper that could be trivially composed to achieve it:

    {DESCRIPTION}

The reference implementation from the PR is appended to these instructions as one or
more source files, followed by a unified diff showing the EXACT new lines (prefixed
with "+"). Focus on the new lines when reasoning about what the PR adds. The source
files may contain many unrelated functions — only the one matching the description
above is relevant.

For the current file, answer SEMANTIC equivalence: the same goal achieved by
different code still counts. Ignore naming differences and surface-level style.

Output format: EXACTLY ONE LINE per finding, no other text, no preamble, no
explanation.

On no match:
    NO

On one match:
    YES symbol=<function-or-class-name> lines=<start-end>

On multiple matches in the same file, output multiple lines, one per match, most
relevant first (max 5 lines).

Special case: if the file appears to BE the reference (you recognize the PR code
itself), output:
    NO (self-reference)

Do NOT write rationale. Do NOT quote code. Do NOT explain. Do NOT rewrite the PR.
One line per match. Nothing else.
```

Note that ensemble mode runs this prompt on every configured model in parallel. Each per-file report will contain one section per model. Disagreements between models on the same file are a strong signal for false positives and give the reviewer a cheap way to spot them.

## Step 5 — Call `mcp__llm-externalizer__code_task`

Build the payload:

```json
{
  "instructions": "<specialized prompt from step 4>",
  "instructions_files_paths": ["<src-file-1>", "<src-file-2>", "...", "<diff-path>"],
  "input_files_paths": ["<filtered target list from step 3>"],
  "answer_mode": 0,
  "max_retries": 3
}
```

Then add the forwarded optional fields if the user supplied them:

- If `--free` was set → add `"free": true`
- If `--output-dir` was set → add `"output_dir": "<abs-path>"`
- If `--exclude-dirs` was set → already applied in step 3 filtering (no need to forward to the server since we control the target list directly)
- If `--redact-regex` was set → add `"redact_regex": "<pattern>"`

Key points:

- **`instructions_files_paths`** carries the reference content (sources + diff). The MCP server reads these files once and appends their contents to every per-file prompt — you never read them into your own context.
- **`input_files_paths`** is the filtered codebase list from step 3 — the source files have already been removed.
- **`answer_mode: 0`** produces one `.md` report per input file. When ensemble mode is active in the profile (default: `remote-ensemble`), each report contains one section per model.
- **Auto-batching**: the server packs multiple target files into each LLM request up to the 400 KB payload budget (`max_payload_kb`), keeping the request count low while respecting size limits.
- **`max_retries: 3`**: per-file retry with a circuit breaker after 3 consecutive failures.

## Step 6 — Return the report paths

The tool returns a list of absolute `.md` report file paths. Report them verbatim in this exact format — do NOT read the reports, do NOT summarize, do NOT add commentary:

```
[DONE] search-existing-implementations — <N> reports
<abs-path-1>
<abs-path-2>
...
```

On any failure in the workflow:

```
[FAILED] search-existing-implementations — <one-line reason>
```

## Constraints

- You MUST NOT read any report contents. The entire point of this command is to keep verbose per-file analysis out of the orchestrator. Return only paths.
- You MUST NOT include the source files in `input_files_paths`. They go into `instructions_files_paths` only, or they will self-match.
- You MUST NOT modify any files. This command is strictly read-only.
- You MUST NOT pre-filter the reports or try to synthesize a summary. Each report is one file's verdict; the reviewer reads the ones they care about.
- If the user did not quote the feature description, abort and ask them to wrap it in quotes — there's no safe way to guess where the description ends and the file list begins.
- Ensemble vs free trade-off: by default the active profile's ensemble runs all models in parallel, which gives the reviewer a built-in voting signal for false positives. Only use `--free` when the user explicitly asks for a fast rough check and accepts lower quality + prompt logging by the provider.
