---
name: search-existing-implementations
description: Given a PR's new implementation, scan the target codebase (same language) to find any existing similar feature, function, or helper that already solves the problem. Each file is reviewed independently by the LLM Externalizer ensemble (so disagreements between models flag false positives). The LLM's answer per file is just NO, or YES with the offending symbol and line range — keeping reports tiny. The command generates the PR diff itself via git (auto-detected base branch), so users only pass the feature description, source files, and codebase path.
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__code_task
  - Read
  - Glob
  - Bash
argument-hint: '"<description>" <src-file> [more-srcs...] --in <path> [--in <path>...] [--base <ref>] [--diff <pre-made-path>] [--free] [--output-dir <path>] [--exclude-dirs <list>]'
effort: medium
---

Search for duplicate implementations of a PR's new feature. All file-to-file comparison is delegated to the LLM Externalizer MCP server. The orchestrator never reads source content and returns only report paths.

## Step 1 — Parse `$ARGUMENTS`

Three inputs are MANDATORY (description, source files, `--in`). The diff is either generated automatically via `git` or supplied manually via `--diff`. Abort with `[FAILED] search-existing-implementations — <reason>` on any validation failure.

1. **`description`** (MANDATORY): the first quoted string in `$ARGUMENTS`. Non-empty. One concise sentence describing the PR feature (e.g. `"async retry with exponential backoff and jitter"`). The source files may contain many unrelated functions — this string is what tells the LLM which one matters.
2. **`source_files`** (MANDATORY, 1+): the PR's new/modified files, given as positional absolute paths after the quoted description. These are the **reference** — their contents are shipped to the LLM as instruction context, never scanned as targets.
3. **`--in <path>`** (MANDATORY, repeatable or comma-separated): one or more paths describing the codebase receiving the PR. Each entry may be an absolute path to a directory (walked recursively) or an absolute path to a specific file. Repeat the flag to add more paths: `--in /proj/src --in /proj/tests`, or use commas: `--in /proj/src,/proj/tests`. At least one is required.
4. **`--base <ref>`** (OPTIONAL): git ref to diff against. When provided, the command runs `git diff <ref>...HEAD -- <source-files>` internally and uses that as the PR diff. Default: auto-detect from `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`, then `master`.
5. **`--diff <path>`** (OPTIONAL, escape hatch): absolute path to a pre-made unified-diff file. Overrides `--base` completely — useful when the user has curated a specific patch or when the command isn't being run inside a git checkout. Takes precedence over `--base` if both are given.

Forwarded optional flags (same semantics as all other LLM Externalizer commands):

- `--free` → pass `"free": true` to the tool (Nemotron free mode, single model, lower quality, prompts logged by provider)
- `--output-dir <abs-path>` → pass `"output_dir": "<path>"` (custom reports directory)
- `--exclude-dirs <a,b,c>` → applied during target filtering (see Step 3)
- `--redact-regex <pattern>` → pass `"redact_regex": "<pattern>"` (custom redaction)

Validation checklist:
- `description` non-empty
- every `source_files` path exists and is a file
- every `--in` path exists (directory or file)
- if `--diff` is given, the file exists and is readable
- all paths are absolute
- if neither `--diff` nor a git repo context is available (see Step 2.5), abort with a clear message

## Step 2 — Verify the service is online

Call `mcp__llm-externalizer__discover`. Abort with `[FAILED] — service offline` if it reports OFFLINE.

## Step 2.5 — Resolve the PR diff

The goal is to end up with a single absolute path to a unified-diff file that you can pass in `instructions_files_paths` alongside the source files. Three resolution paths, checked in this order:

### Path A — user supplied `--diff <path>`

Validate the path exists and is readable, then use it as-is. Skip paths B and C. This is the escape hatch: useful when the user has curated a specific patch or when the command is running outside a git checkout.

### Path B — user supplied `--base <ref>`

The command generates the diff itself via `git`. Use `Bash` to run:

```bash
cd "<git repo root containing the first source file>"
git rev-parse --is-inside-work-tree   # sanity check
git diff "<ref>...HEAD" -- <source-file-1> <source-file-2> ... > "<temp-diff-path>"
```

Use the `<ref>...HEAD` (three-dot) form so the diff is taken from the merge-base — this matches what a PR actually shows on GitHub/GitLab, not the full divergence. Restrict the diff to the source files only (`-- <src1> <src2> ...`) so the LLM sees only the changes relevant to this review, not every file touched by the PR.

The `<temp-diff-path>` should be a fresh file under the system temp dir: `/tmp/llm-ext-search-existing-diff-<unix-timestamp>.patch` on macOS/Linux. Do not reuse a fixed filename — use a timestamp suffix to avoid collisions between concurrent runs.

If `git diff` fails (ref doesn't exist, not a git repo, working tree in a bad state), abort with `[FAILED] — git diff <ref>...HEAD failed: <stderr>`.

If `git diff` succeeds but produces an EMPTY file (no changes between the base and HEAD for any of the source files), abort with `[FAILED] — diff vs <ref> is empty for the provided source files; nothing to review`.

### Path C — neither flag given (default)

Auto-detect the base branch, then proceed as in Path B with the detected ref.

Detection order, using `Bash`:

1. Try `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` — gives e.g. `origin/main`. Use that directly. This is the authoritative signal for "the default branch on the remote".
2. If step 1 fails, try `git show-ref --verify --quiet refs/heads/main` and use `main` if present.
3. If step 2 fails, try `git show-ref --verify --quiet refs/heads/master` and use `master` if present.
4. If none of the above resolves, abort with `[FAILED] — cannot auto-detect base branch; pass --base <ref> or --diff <path>`.

If the command is NOT running inside a git working tree (`git rev-parse --is-inside-work-tree` fails), abort with `[FAILED] — cwd is not a git repository; pass --diff <path> to supply a pre-made patch`.

### Result

At the end of step 2.5, one of:

- `resolved_diff_path` is set to an absolute path to a readable unified-diff file (either `--diff`, a newly-generated temp file, or the result of auto-detection), OR
- the command has already aborted with a clear `[FAILED]` message

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
  "instructions_files_paths": ["<src-file-1>", "<src-file-2>", "...", "<resolved_diff_path from step 2.5>"],
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

- **`instructions_files_paths`** carries the reference content (sources + the diff resolved in step 2.5 — either user-supplied or git-generated). The MCP server reads these files once and appends their contents to every per-file prompt, so you never load file contents into your own context.
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
