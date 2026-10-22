# llm-ext reference: session and llm groups

Flags are written `--name value`; booleans take `true`/`false`. Every action also accepts the global flags (`--quiet`, `--profile <name>`). All text below comes from `llm-ext <group> <action> --help`.

## Contents

- `llm-ext session compact`
- `llm-ext llm ask`
- `llm-ext llm code`
- `llm-ext llm cluster`
- `llm-ext llm summarize`
- `llm-ext llm topics`
- `llm-ext llm sem-deduplicate`
- `llm-ext llm describe`

## `session` group


### `llm-ext session compact`

- Usage: `llm-ext session compact [transcript] [--flag value ...]`
- Bare argument: `--transcript`
- Accepted profile types: free, paid

Compaction-style summary of a whole Claude Code session, streamed from its JSONL transcript via map-reduce (never loads the file into memory). $0 by construction: always uses the biggest free, text-emitting OpenRouter model available today (no hard context floor unless min_context is given). Falls back down the ranked model list automatically if the active model is delisted, stops being free, or exhausts its daily cap mid-run, re-chunking the remaining work to the new model's context. Checkpoints after every chunk/fold, so an interrupted run resumes instead of restarting: re-run the same command and it picks up where it left off automatically. With neither transcript nor session_id, summarizes the current project's most recent transcript, ranked by its own last recorded event rather than by file mtime.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--checkpoint` | string | Absolute path to the checkpoint file. Default: a path derived deterministically from the... |
| `--chunk_timeout_s` | number | Per-ATTEMPT deadline in seconds. Default: 600 — a BACKSTOP against a stalled generation, not... |
| `--concurrency` | number | How many chunk requests run in flight at once. Default: AUTO — sized to the chunk count... |
| `--max_chunk_tokens` | number | Override the per-chunk token budget. Default: the smaller of 25,000 and the selected model's... |
| `--max_retries_per_chunk` | number | How many times ONE chunk may be re-attempted on the SAME model before the run gives up on... |
| `--min_context` | number | Optional hard floor on context_length. Default: none — the biggest free, text-emitting model... |
| `--output` | string | Absolute path to a custom output directory for the summary report. Default:... |
| `--prune` | string | One of 'aggressive' (default — drops tool-result payloads, pasted file contents, thinking... |
| `--resume` | boolean | Require an existing, matching checkpoint at the checkpoint path — fails fast if none is... |
| `--session_id` | string | A session UUID; resolved to ~/.claude/projects/<project-slug>/<session_id>.jsonl for the... |
| `--stdout` | boolean | Print the summary TEXT directly to stdout instead of writing a report file and returning its... |
| `--transcript` | string | Absolute path to a session's .jsonl transcript. Wins over session_id and the default. |
| `--until_done` | boolean | Keep retrying the WHOLE compaction until it succeeds, instead of failing with a resumable... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext session compact ./session.jsonl -o /tmp
```

## `llm` group


### `llm-ext llm ask`

- Usage: `llm-ext llm ask [input_files_paths] [--flag value ...]`
- Bare argument: `--input_files_paths`
- Accepted profile types: local, free, paid

General-purpose LLM call. More capable than Haiku, costs less. Offloads bounded work (summarise, generate, translate, compare) to a separate LLM.

Files via input_files_paths are read from disk (saves your context).

FILE GROUPING: Organize files into named groups using ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths. Each group is processed in COMPLETE ISOLATION (no cross-group LLM calls) and produces its own SEPARATE report file with the group ID in the filename. Output: one line per group: [group:id] /path/to/report_group-id_....md. WHY: Each downstream agent only reads the report for its own group, saving context tokens by not loading findings about files it is not responsible for. Without markers, all files are processed together (backward compatible).

CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context in instructions.

OUTPUT: Saved to .md file, returns only the file path.

BATCHING (READ THIS): The LLM never sees your whole set of input files at once. Files are packed into LLM requests of typically 1-5 files each — by default via First-Fit Decreasing bin packing into ~400 KB batches (sized to fit the context window), or one group per request when ---GROUP:id--- markers are used. In ensemble mode each file is reviewed by up to 3 different LLMs in parallel so every file receives that many distinct responses; under the free profile each file gets one response until the free pool has enough benchmark-ranked models to run as an ensemble, after which it gets up to 3. answer_mode controls ONLY how reports are written to disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/namespace/basename/imports if no ---GROUP:id--- markers are ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--exclude_dirs` | array | Additional directory names to skip when scanning folder_path. Hidden dirs, node_modules,... |
| `--extensions` | array | File extensions to include when using folder_path. E.g., [".ts", ".py"]. If not set, all... |
| `--folder_path` | string | Absolute path to a folder to scan. All matching files are processed. Can be combined with... |
| `--follow_symlinks` | boolean | Follow symbolic links to files and directories. Default: true. Circular symlinks are... |
| `--free` | boolean | Use the selected profile's own first ':free' model in its chain, instead of the ensemble. No... |
| `--input_files_content` | string | Inline content, code-fenced in the prompt. DISCOURAGED — wastes your context tokens. Use... |
| `--input_files_paths` | oneOf | One or more absolute file paths. Accepts a single string OR an array. Files are read from... |
| `--instructions` | string | Task instructions for the LLM. Placed BEFORE input-files content in the prompt. Be specific... |
| `--instructions_files_paths` | oneOf | Path(s) to file(s) containing instructions (appended to instructions). |
| `--max_files` | number | Maximum number of files to discover from folder_path. Default: 2500. |
| `--max_payload_kb` | number | Max total payload per batch in KB (prompt + instructions + files). Default: 400. Must fit... |
| `--max_retries` | number | Max retries per file when answer_mode=0 (per-file processing). Default: 1 (no retry). Set to... |
| `--output_dir` | string | Absolute path to a custom output directory for reports. Default:... |
| `--recursive` | boolean | Recurse into subdirectories when scanning folder_path. Default: true. |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. Prevents leaking sensitive data to the remote service. |
| `--scan_secrets` | boolean | Scan input files for secrets (API keys, tokens, passwords) and ABORT if any are found. |
| `--system` | string | Persona. Be specific: "Senior TypeScript dev" not "helpful assistant". |
| `--use_gitignore` | boolean | Use .gitignore rules to filter files (via git ls-files). Default: true. Set false to include... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext llm ask ./src/api.ts --instructions "Explain what this file does; the project is a TypeScript CLI."
```

### `llm-ext llm code`

- Usage: `llm-ext llm code [input_files_paths] [--flag value ...]`
- Bare argument: `--input_files_paths`
- Accepted profile types: local, free, paid

Code analysis with optimised code-review system prompt. More capable than Haiku, costs less. Less capable than Sonnet/Opus.

Pass input_files_paths (read from disk, language auto-detected). Be specific in instructions.

FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename (max 1 MB per group) so every answer_mode=1 run emits one merged report per group. WHY: downstream agents only read their own group's report, saving context tokens.

CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context.

OUTPUT: Saved to .md file, returns only the file path.

BATCHING (READ THIS): The LLM never sees your whole set of input files at once. Files are packed into LLM requests of typically 1-5 files each — by default via First-Fit Decreasing bin packing into ~400 KB batches (sized to fit the context window), or one group per request when ---GROUP:id--- markers are used. In ensemble mode each file is reviewed by up to 3 different LLMs in parallel so every file receives that many distinct responses; under the free profile each file gets one response until the free pool has enough benchmark-ranked models to run as an ensemble, after which it gets up to 3. answer_mode controls ONLY how reports are written to disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/namespace/basename/imports if no ---GROUP:id--- markers are supplied, max 1 MB per group), 2 = SINGLE REPORT (everything merged). If you need cross-file analysis across the whole codebase, use ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--diff_commit` | string | Diff mode: one commit's changes (vs its parent). |
| `--diff_from` | string | Diff mode: base ref (merge-base '...' semantics; requires diff_to). |
| `--diff_to` | string | Diff mode: head ref (requires diff_from). |
| `--diff_workspace` | boolean | Diff mode: review only workspace-changed files (staged+unstaged+untracked vs HEAD). |
| `--exclude_dirs` | array | Additional directory names to skip when scanning folder_path. Hidden dirs, node_modules,... |
| `--extensions` | array | File extensions to include when using folder_path. E.g., [".ts", ".py"]. If not set, all... |
| `--folder_path` | string | Absolute path to a folder to scan. All matching files are processed. Can be combined with... |
| `--follow_symlinks` | boolean | Follow symbolic links to files and directories. Default: true. Circular symlinks are... |
| `--free` | boolean | Use the selected profile's own first ':free' model in its chain, instead of the ensemble. No... |
| `--input_files_content` | string | Inline source code, code-fenced. DISCOURAGED — wastes your context tokens. Use... |
| `--input_files_paths` | oneOf | One or more absolute paths to source files. Read from disk, code-fenced, language... |
| `--instructions` | string | (required) Your instructions/notes for the LLM — placed BEFORE input-files content so the LLM reads... |
| `--instructions_files_paths` | oneOf | Path(s) to file(s) containing instructions (appended to instructions). |
| `--language` | string | Programming language (auto-detected from input_files_paths extension if not set). |
| `--max_files` | number | Maximum number of files to discover from folder_path. Default: 2500. |
| `--max_payload_kb` | number | Max total payload per batch in KB (prompt + instructions + files). Default: 400. Must fit... |
| `--max_retries` | number | Max retries per file when answer_mode=0 (per-file processing). Default: 1 (no retry). Set to... |
| `--output_dir` | string | Absolute path to a custom output directory for reports. Default:... |
| `--recursive` | boolean | Recurse into subdirectories when scanning folder_path. Default: true. |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. Prevents leaking sensitive data to the remote service. |
| `--rules` | string | Explicit per-path rules-file path (highest layer; see rules_check). Omitted:... |
| `--scan_secrets` | boolean | Scan input files for secrets (API keys, tokens, passwords) and ABORT if any are found. |
| `--use_gitignore` | boolean | Use .gitignore rules to filter files (via git ls-files). Default: true. Set false to include... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext llm code ./src/api.ts --instructions "Find real bugs; the project is a TypeScript CLI."
```

### `llm-ext llm cluster`

- Usage: `llm-ext llm cluster [input_file] [--flag value ...]`
- Bare argument: `--input_file`
- Accepted profile types: local, free, paid

Cluster SENTENCES (or short labels treated as sentences) by full-sentence meaning equivalence. ZERO orchestrator tokens — file-in, file-out. The whole batch+verify+canonicalise loop runs inside the MCP server; you get only output paths back.

PURPOSE: aggregate synonymous / equivalent-meaning items across a large term set. Designed for taxonomy work, ontology cleanup, label canonicalisation. NOT a word-level synonym lookup — the unit of comparison is the full sentence/label.

SCALE: the whole corpus and its embeddings are held in memory, so the practical ceiling is heap-bound — tens-of-thousands to low-hundreds-of- thousands of items on a typical Node heap with the default 384-dim embeddings, more with policy.compute_embeddings=false. A pre-flight guard estimates the footprint and FAILS FAST with guidance (raise --max-old-space-size, disable embeddings, split the corpus, or set policy.skip_memory_guard) instead of OOM-ing mid-run.

PIPELINE: Pre-flight model benchmark → Phase 0 setup (load JSONL, embeddings) → Phase 1 embedding-clustered batching + per-batch grouping → Phase 2 cross- cluster verification with transitive-closure merge (>=3 distinct items from each cluster must co-occur in the same response) → Phase 3 canonical-label selection → Phase 4 emit clusters.jsonl + clusters_summary.json + stats.json + checkpoint.sqlite.

RESUMABLE: pass resume_from to a prior checkpoint.sqlite to continue.
BUDGET-CAPPED: policy.budget_max_llm_calls aborts cleanly when hit.
FAILURE-RECOVERY: each failed batch retries 3x, then splits in half and recurses (max depth 3 → 8 leaf sub-batches, 45-call hard cap per source batch).
BACKEND-AGNOSTIC: uses the active profile's model selection.

STATUS: all phases live — embedding-clustered batching + recursive-split- and-retry ladder ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--embeddings_file` | string | Optional. Absolute path to a precomputed float32 memmap file (one row per input item,... |
| `--input_file` | string | (required) Absolute path to a JSONL file. Each line is a JSON object with an 'id' (string) and a... |
| `--output_dir` | string | (required) Absolute path to the output directory. Will be created if missing. Contains clusters.jsonl,... |
| `--policy_file` | string | Optional. Absolute path to a JSON file with policy knobs. See the TRDD for the full list —... |
| `--resume_from` | string | Optional. Absolute path to a prior checkpoint.sqlite from this tool. When set, the run... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext llm cluster ./items.jsonl --output_dir /tmp/clusters
```

### `llm-ext llm summarize`

- Usage: `llm-ext llm summarize [input_file] [--flag value ...]`
- Bare argument: `--input_file`
- Accepted profile types: local, free, paid

Summarize the input text with a hard size budget (TRDD-VFXS2ZYY). One LLM call plus at most one corrective retry when the summary exceeds max_chars; still over ⇒ FAILED (never silent truncation).

OUTPUT: Saved to .md file, returns only the file path.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches.
• 600s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--input_content` | string | Inline text to summarize (alternative to input_file). |
| `--input_file` | string | Path to the text file to summarize. |
| `--language` | string | Output language for the summary. Default: same language as the input. |
| `--max_chars` | number | Hard maximum size of the summary in characters (default 1000, min 20). |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext llm summarize ./notes.md --max_chars 500
```

### `llm-ext llm topics`

- Usage: `llm-ext llm topics [input_file] [--flag value ...]`
- Bare argument: `--input_file`
- Accepted profile types: local, free, paid

Extract keywords, keyphrases and the language from the input text (TRDD-9XOHSYFV): the topics, themes and arguments found in it. Strict-JSON output contract with one corrective retry.

OUTPUT: Saved to .md file (readable list + JSON), returns only the file path.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches.
• 600s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--input_content` | string | Inline text to analyze (alternative to input_file). |
| `--input_file` | string | Path to the text file to analyze. |
| `--max_keyphrases` | number | Maximum number of keyphrases to return (default 10). |
| `--max_keywords` | number | Maximum number of keywords to return (default 15). |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext llm topics ./notes.md --max_keywords 10
```

### `llm-ext llm sem-deduplicate`

- Usage: `llm-ext llm sem-deduplicate [input_file] [--flag value ...]`
- Bare argument: `--input_file`
- Accepted profile types: local, free, paid

Semantically deduplicate a list of phrases (TRDD-SYEH38AV): phrases that mean the same thing with different words ('computer programming' vs 'coding', 'rasterize' vs 'render to image') are collapsed to the single best phrase. Exact duplicates are removed in code first (no LLM tokens); every survivor is mechanically verified to be a verbatim input phrase — an invented/reworded entry fails the call.

INPUT: one phrase per line, a JSON string array, or a comma-separated line — via input_file or input_content.

For 10k+ item corpora use cluster_synonyms instead (checkpointed 3-phase pipeline); this is the light single-call path for bounded lists.

OUTPUT: Saved to .md file (survivors + removed audit), returns only the file path.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches.
• 600s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--input_content` | string | Inline phrase list (alternative to input_file). |
| `--input_file` | string | Path to the phrase list (one per line, JSON array, or comma-separated). |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext llm sem-deduplicate ./phrases.txt
```

### `llm-ext llm describe`

- Usage: `llm-ext llm describe [input_file] [--flag value ...]`
- Bare argument: `--input_file`
- Accepted profile types: local, free, paid

Describe concisely a file's nature, intent, likely usage and scope (TRDD-Q3ERXAAO) — code or prose. A prompt .md ⇒ what the prompt aims at; a .csv ⇒ what the list is made of and for what context; a JSON config ⇒ configuration of what, with what intent; a CSS file ⇒ the visual intent and effect; code ⇒ what it does and why. Hard max_chars budget with one corrective retry; still over ⇒ FAILED.

OUTPUT: Saved to .md file, returns only the file path.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches.
• 600s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--input_file` | string | (required) Path to the file to describe (required). |
| `--max_chars` | number | Hard maximum size of the description in characters (default 500, min 50). |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext llm describe ./src/api.ts --max_chars 300
```
