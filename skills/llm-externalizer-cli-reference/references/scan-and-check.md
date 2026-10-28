# llm-ext reference: scan and check groups

Flags are written `--name value`; booleans take `true`/`false`. Every action also accepts the global flags (`--quiet`, `--profile <name>`, `--command_timeout <s>`, `--queue_timeout <s>`; see SKILL.md). All text below comes from `llm-ext <group> <action> --help`.

## Contents

- `llm-ext scan folder`
- `llm-ext scan security`
- `llm-ext scan quality`
- `llm-ext scan impl`
- `llm-ext check imports`
- `llm-ext check refs`
- `llm-ext check specs`
- `llm-ext check rules`
- `llm-ext check plan`
- `llm-ext check diff`

## `scan` group


### `llm-ext scan folder`

- Usage: `llm-ext scan folder [folder_path] [--flag value ...]`
- Bare argument: `--folder_path`
- Accepted profile types: local, free, paid

Auto-discover files from a directory tree and run the given instructions against each. Filters by extension, skips hidden dirs/node_modules/.git/dist/build.

CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.

BATCHING (READ THIS): The LLM never sees your whole set of input files at once. Files are packed into LLM requests of typically 1-5 files each — by default via First-Fit Decreasing bin packing into ~400 KB batches (sized to fit the context window), or one group per request when ---GROUP:id--- markers are used. In ensemble mode each file is reviewed by up to 3 different LLMs in parallel so every file receives that many distinct responses; under the free profile each file gets one response until the free pool has enough benchmark-ranked models to run as an ensemble, after which it gets up to 3. answer_mode controls ONLY how reports are written to disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/namespace/basename/imports if no ---GROUP:id--- markers are supplied, max 1 MB per group), 2 = SINGLE REPORT (everything merged). If you need cross-file analysis across the whole codebase, use search_existing_implementations — it is purpose-built for it.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches.
• 600s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--diff_commit` | string | Diff mode: review one commit's changes (vs its parent). |
| `--diff_from` | string | Diff mode: base ref of a range (merge-base '...' semantics with diff_to). Requires diff_to. |
| `--diff_to` | string | Diff mode: head ref of the range. Requires diff_from. |
| `--diff_workspace` | boolean | Diff mode: review only files changed in the workspace (staged + unstaged + untracked vs... |
| `--exclude_dirs` | array | Additional directory names to skip (hidden dirs, node_modules, .git are always skipped). |
| `--extensions` | array | File extensions to include (e.g. [".ts", ".py"]). If omitted, includes all files. |
| `--folder_path` | string | (required) Absolute path to the folder to scan recursively. |
| `--instructions` | string | What to look for or do with each file. |
| `--instructions_files_paths` | oneOf | File(s) containing instructions. |
| `--max_files` | number | Maximum number of files to process (default: 2500). Safety limit to prevent runaway scans. |
| `--max_payload_kb` | number | Max file size in KB per file. Default: 400. Files exceeding this are skipped and reported. |
| `--output_dir` | string | Absolute path to a custom output directory for reports. Default:... |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files... |
| `--rules` | string | Explicit per-path rules-file path (highest layer; see rules_check). Omitted:... |
| `--scan_secrets` | boolean | Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env... |
| `--use_gitignore` | boolean | Use .gitignore rules to filter files (via git ls-files). When true, only files not ignored... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext scan folder ./src --instructions "list the exported symbols"
```

### `llm-ext scan security`

- Usage: `llm-ext scan security [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: paid

Dedicated, INJECTION-HARDENED security triage for suspected-malicious code. NOT the mass_scout pipeline — a bespoke judge with a nonce-delimited untrusted-data envelope, a hardened system prompt, strict json_schema output, an in-band injection pre-scan, and fail-safe-to-'uncertain' on EVERY error/deviation (never a silent not_threat). Adjudicates a batch of targets (inline snippet | file_path+line+context_lines window | path_glob) and emits per-item verdicts {verdict: threat|not_threat|uncertain, confidence, reason, injection_observed}. RETURNS: counts + JSON/markdown report paths. ENV: $OPENROUTER_API_KEY (absent ⇒ all verdicts 'uncertain').

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--budget_usd` | number | Whole-job hard pre-flight gate (all-or-nothing). Refuses the entire job if the estimate... |
| `--category_rubrics` | object | Per-category adjudication rubric, placed in the SYSTEM prompt (snippet content can never... |
| `--default_verdict_on_error` | string | Verdict on any error/deviation. Default 'uncertain'. May be 'uncertain' or 'threat' only —... |
| `--folder_root` | string | Root for relative path_glob / git_diff_ref. Default cwd. |
| `--git_diff_ref` | string | Incremental: for path_glob targets, only files changed since this git ref. Shape-validated... |
| `--max_retries` | number | Per-call validation retries. Default 1. |
| `--model` | string | OpenRouter model id. Default qwen/qwen-2.5-7b-instruct. |
| `--output_dir` | string | Report/export dir; defaults to <main-root>/reports/llm-externalizer/security_scan/. |
| `--targets` | array | (required) Work items. Each has id + category + EXACTLY ONE payload of: snippet (inline code) \|... |
| `--workers` | number | Concurrent judge calls. Default 8. |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext scan security --targets '[{"id":"t1","category":"<category>","snippet":"<inline code>"}]' --profile paid
```

### `llm-ext scan quality`

- Usage: `llm-ext scan quality [folder_path] [--flag value ...]`
- Bare argument: `--folder_path`
- Accepted profile types: paid

HIGH-QUALITY single-model variant of scan_folder. Runs the given instructions against each discovered file using ONE strong remote model (default z-ai/glm-5.2) at maximum reasoning effort with prompt caching — NOT the 3-model cheap ensemble. Use when review QUALITY matters more than cost: deep audits, security review, subtle-bug hunts.

Requires the OpenRouter backend with available credit: the high-quality model is PAID by design, so this tool FAIL-FASTS (it does NOT silently downgrade) under a local backend, free_only mode, or exhausted credit — use scan_folder for those. Configure the model via `high_quality_model` in settings.yaml (id, reasoning_effort, cache, min_quantization, provider).

CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.

BATCHING (READ THIS): The LLM never sees your whole set of input files at once. Files are packed into LLM requests of typically 1-5 files each — by default via First-Fit Decreasing bin packing into ~400 KB batches (sized to fit the context window), or one group per request when ---GROUP:id--- markers are used. In ensemble mode each file is reviewed by up to 3 different LLMs in parallel so every file receives that many distinct responses; under the free profile each file gets one response until the free pool has enough benchmark-ranked models to run as an ensemble, after which it gets up to 3. answer_mode controls ONLY how reports are written to disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/namespace/basename/imports if no ---GROUP:id--- markers are supplied, max 1 MB per group), 2 = SINGLE REPORT (everything merged). If you need cross-file analysis across the whole codebase, use search_existing_implementations — ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--diff_commit` | string | Diff mode: review one commit's changes (vs its parent). |
| `--diff_from` | string | Diff mode: base ref of a range (merge-base '...' semantics with diff_to). Requires diff_to. |
| `--diff_to` | string | Diff mode: head ref of the range. Requires diff_from. |
| `--diff_workspace` | boolean | Diff mode: review only files changed in the workspace (staged + unstaged + untracked vs... |
| `--exclude_dirs` | array | Additional directory names to skip (hidden dirs, node_modules, .git are always skipped). |
| `--extensions` | array | File extensions to include (e.g. [".ts", ".py"]). If omitted, includes all files. |
| `--folder_path` | string | (required) Absolute path to the folder to scan recursively. |
| `--instructions` | string | What to look for or do with each file. |
| `--instructions_files_paths` | oneOf | File(s) containing instructions. |
| `--max_files` | number | Maximum number of files to process (default: 2500). Safety limit to prevent runaway scans. |
| `--max_payload_kb` | number | Max file size in KB per file. Default: 400. Files exceeding this are skipped and reported. |
| `--output_dir` | string | Absolute path to a custom output directory for reports. Default:... |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files... |
| `--rules` | string | Explicit per-path rules-file path (highest layer; see rules_check). Omitted:... |
| `--scan_secrets` | boolean | Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env... |
| `--use_gitignore` | boolean | Use .gitignore rules to filter files (via git ls-files). When true, only files not ignored... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext scan quality ./src --instructions "find real bugs"
```

### `llm-ext scan impl`

- Usage: `llm-ext scan impl [folder_path] [--flag value ...]`
- Bare argument: `--folder_path`
- Accepted profile types: local, free, paid

Search a codebase for an existing implementation of a specified feature. THE CANONICAL WAY to answer 'does this already exist in the codebase?' or 'does this PR duplicate existing code?'. Works even though the LLM never sees the whole codebase at once — see the batching note below.

The server walks the target folder(s), filters by language extension, FFD-packs all matching files into batches up to max_payload_kb per LLM request (typically 1–5 files per batch, depending on file sizes), and asks the LLM (ensemble by default) to emit per-file YES/NO answers for every file in the batch. Each batch is ONE LLM call — for a 10k-file codebase this is typically ~500 calls instead of 10k. The LLM never needs global codebase visibility because every file is checked against a REFERENCE (feature_description + optional source_files + optional diff_path), not against other files in the codebase.

BATCHING vs ANSWER_MODE (important): batching behavior is the same in all modes. The LLM always sees 1–5 files per request. answer_mode only controls how the per-file output is persisted to disk:
  - answer_mode 0: one .md per input file (MCP splits each batch response by per-file section markers and saves one report per original file; returns a list of (input_file -> report_file) pairs).
  - answer_mode 1: one .md per batch (per LLM request).
  - answer_mode 2 (default): one .md for the whole operation, merged.

The feature_description is the primary signal. Optionally pass PR source files (shipped as reference context and automatically excluded from the scan to avoid self-match) and/or a unified diff (to focus the LLM on the new lines). Both are optional — the tool also works as a pure description-based scan.

Per-file answer is terse — either 'NO' or one-or-more 'YES symbol=<name> ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--diff_path` | string | Optional absolute path to a unified-diff file showing the exact PR changes. The server ships... |
| `--exclude_dirs` | array | Additional directory names to skip when scanning folder_path. Hidden dirs, node_modules,... |
| `--extensions` | array | File extensions to include when using folder_path. E.g., [".ts", ".py"]. If not set, all... |
| `--feature_description` | string | (required) Concise one-sentence description of the feature to look for. The source files (if any) may... |
| `--folder_path` | oneOf | (required) Absolute path(s) to the codebase folder(s) to scan. Single folder or list of folders; each... |
| `--follow_symlinks` | boolean | Follow symbolic links to files and directories. Default: true. Circular symlinks are... |
| `--free` | boolean | Use the selected profile's own first ':free' model in its chain, instead of the ensemble. No... |
| `--max_files` | number | Maximum number of files to walk (default: 10000 for this tool, higher than scan_folder's... |
| `--max_payload_kb` | number | Max batch payload size in KB (default: 400). Controls FFD bin packing: larger values pack... |
| `--output_dir` | string | Absolute path to a custom output directory for reports. Default:... |
| `--recursive` | boolean | Recurse into subdirectories when scanning folder_path. Default: true. |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. DISCOURAGED: prefer .env. |
| `--scan_secrets` | boolean | Scan input files for secrets and ABORT if any are found. |
| `--source_files` | oneOf | Optional absolute path(s) to the PR's new/modified files. Their contents are shipped to the... |
| `--use_gitignore` | boolean | Use .gitignore rules to filter files (via git ls-files). Default: true. Set false to include... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext scan impl ./src --feature_description "retry a failed HTTP request with backoff"
```

## `check` group


### `llm-ext check imports`

- Usage: `llm-ext check imports [input_files_paths] [--flag value ...]`
- Bare argument: `--input_files_paths`
- Accepted profile types: local, free, paid

Two-phase import checker: (1) LLM extracts import paths, (2) server validates each exists on disk. Detects broken imports after file moves/renames.

FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename (max 1 MB per group) so every answer_mode=1 run emits one merged report per group. WHY: downstream agents only read their own group's report, saving context tokens.

CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.

BATCHING (READ THIS): The LLM never sees your whole set of input files at once. Files are packed into LLM requests of typically 1-5 files each — by default via First-Fit Decreasing bin packing into ~400 KB batches (sized to fit the context window), or one group per request when ---GROUP:id--- markers are used. In ensemble mode each file is reviewed by up to 3 different LLMs in parallel so every file receives that many distinct responses; under the free profile each file gets one response until the free pool has enough benchmark-ranked models to run as an ensemble, after which it gets up to 3. answer_mode controls ONLY how reports are written to disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/namespace/basename/imports if no ---GROUP:id--- markers are supplied, max 1 MB per group), 2 = SINGLE REPORT (everything merged). If you need cross-file analysis across the whole codebase, use search_existing_implementations — it is purpose-built for it.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--exclude_dirs` | array | Additional directory names to skip when scanning folder_path. Hidden dirs, node_modules,... |
| `--extensions` | array | File extensions to include when using folder_path. E.g., [".ts", ".py"]. If not set, all... |
| `--folder_path` | string | Absolute path to a folder to scan. All matching files are processed. Can be combined with... |
| `--follow_symlinks` | boolean | Follow symbolic links to files and directories. Default: true. Circular symlinks are... |
| `--free` | boolean | Use the selected profile's own first ':free' model in its chain, instead of the ensemble. No... |
| `--input_files_paths` | oneOf | Source file(s) to check for broken imports. |
| `--instructions` | string | Optional additional context. |
| `--instructions_files_paths` | oneOf | File(s) containing additional instructions. |
| `--max_files` | number | Maximum number of files to discover from folder_path. Default: 2500. |
| `--max_payload_kb` | number | Max payload in KB (prompt + files). Default: 400. Lower if you see hallucinations. |
| `--max_retries` | number | Max retries per file when answer_mode=0 (per-file processing). Default: 1 (no retry). Set to... |
| `--output_dir` | string | Absolute path to a custom output directory for reports. Default:... |
| `--project_root` | string | Project root for resolving relative imports. Defaults to the source file's directory. |
| `--recursive` | boolean | Recurse into subdirectories when scanning folder_path. Default: true. |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files... |
| `--scan_secrets` | boolean | Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env... |
| `--use_gitignore` | boolean | Use .gitignore rules to filter files (via git ls-files). Default: true. Set false to include... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext check imports ./src/api.ts
```

### `llm-ext check refs`

- Usage: `llm-ext check refs [input_files_paths] [--flag value ...]`
- Bare argument: `--input_files_paths`
- Accepted profile types: local, free, paid

Check source file for broken symbol references. Auto-resolves local imports, reads dependencies, LLM validates all symbols exist.

FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename (max 1 MB per group) so every answer_mode=1 run emits one merged report per group. WHY: downstream agents only read their own group's report, saving context tokens.

CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.

BATCHING (READ THIS): The LLM never sees your whole set of input files at once. Files are packed into LLM requests of typically 1-5 files each — by default via First-Fit Decreasing bin packing into ~400 KB batches (sized to fit the context window), or one group per request when ---GROUP:id--- markers are used. In ensemble mode each file is reviewed by up to 3 different LLMs in parallel so every file receives that many distinct responses; under the free profile each file gets one response until the free pool has enough benchmark-ranked models to run as an ensemble, after which it gets up to 3. answer_mode controls ONLY how reports are written to disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/namespace/basename/imports if no ---GROUP:id--- markers are supplied, max 1 MB per group), 2 = SINGLE REPORT (everything merged). If you need cross-file analysis across the whole codebase, use search_existing_implementations — it is purpose-built for it.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--exclude_dirs` | array | Additional directory names to skip when scanning folder_path. Hidden dirs, node_modules,... |
| `--extensions` | array | File extensions to include when using folder_path. E.g., [".ts", ".py"]. If not set, all... |
| `--folder_path` | string | Absolute path to a folder to scan. All matching files are processed. Can be combined with... |
| `--follow_symlinks` | boolean | Follow symbolic links to files and directories. Default: true. Circular symlinks are... |
| `--free` | boolean | Use the selected profile's own first ':free' model in its chain, instead of the ensemble. No... |
| `--input_files_paths` | oneOf | Source file(s) to check for broken references. |
| `--instructions` | string | Optional additional context or focus areas. |
| `--instructions_files_paths` | oneOf | File(s) containing additional instructions. |
| `--max_files` | number | Maximum number of files to discover from folder_path. Default: 2500. |
| `--max_payload_kb` | number | Max payload in KB (prompt + files). Default: 400. Lower if you see hallucinations. |
| `--max_retries` | number | Max retries per file when answer_mode=0 (per-file processing). Default: 1 (no retry). Set to... |
| `--output_dir` | string | Absolute path to a custom output directory for reports. Default:... |
| `--recursive` | boolean | Recurse into subdirectories when scanning folder_path. Default: true. |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files... |
| `--scan_secrets` | boolean | Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env... |
| `--use_gitignore` | boolean | Use .gitignore rules to filter files (via git ls-files). Default: true. Set false to include... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext check refs ./src/api.ts
```

### `llm-ext check specs`

- Usage: `llm-ext check specs [spec_file_path] [--flag value ...]`
- Bare argument: `--spec_file_path`
- Accepted profile types: local, free, paid

Compare source files against a specification file. The spec file defines requirements, rules, API parameters, output formats, restrictions, forbidden patterns, forbidden endpoints/services/tools, etc. Each source file is strictly examined for spec violations: wrong implementations, missed rules, forbidden patterns used, incorrect API contracts, wrong output formats, etc.

Accepts individual files via input_files_paths OR an entire folder via folder_path (recursive). Files are auto-batched using FFD bin packing — the spec file is included in EVERY batch.

FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename (max 1 MB per group) so every answer_mode=1 run emits one merged report per group. WHY: downstream agents only read their own group's report, saving context tokens.

NOTE: The LLM does NOT have the full project — some requirements may be implemented elsewhere. Therefore only VIOLATIONS of the spec are reported (things done wrong), not MISSING features (things not yet implemented). Everything that IS implemented must follow the spec exactly.

CONTEXT WARNING: Remote LLM has ZERO project context — include brief context in instructions.

OUTPUT: Violation report saved to .md file, returns only the file path.

BATCHING (READ THIS): The LLM never sees your whole set of input files at once. Files are packed into LLM requests of typically 1-5 files each — by default via First-Fit Decreasing bin packing into ~400 KB batches (sized to fit the context window), or one group per request when ---GROUP:id--- markers are used. In ensemble mode each file is reviewed by up ... [full text: run the action with --help]

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--answer_mode` | number | Output file organization. Does NOT change how many files the LLM sees per request — that is... |
| `--exclude_dirs` | array | Additional directory names to skip when scanning folder_path. Hidden dirs, node_modules,... |
| `--extensions` | array | File extensions to include when using folder_path. E.g., [".ts", ".py"]. If not set, all... |
| `--folder_path` | string | Absolute path to a folder to scan recursively. All matching files are checked against the... |
| `--input_files_paths` | oneOf | Source file(s) to check against the spec. Use this OR folder_path (not both). |
| `--instructions` | string | Optional additional context or focus areas. E.g., 'Focus on API response format violations'... |
| `--instructions_files_paths` | oneOf | File(s) containing additional instructions. |
| `--max_files` | number | Maximum number of files to process when using folder_path. Default: 2500. Safety limit to... |
| `--max_payload_kb` | number | Max payload in KB (prompt + spec + source files) per batch. Default: 400. The spec file is... |
| `--max_retries` | number | Max retries per file when answer_mode=0 (per-file processing). Default: 1 (no retry). Set to... |
| `--output_dir` | string | Absolute path to a custom output directory for the violation report. Default:... |
| `--redact_regex` | string | JavaScript regex pattern to redact matching strings from file content before sending to LLM.... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. |
| `--scan_secrets` | boolean | Scan input files for secrets and ABORT if any are found. |
| `--spec_file_path` | string | (required) Absolute path to the specification file (requirements, rules, API contracts, restrictions).... |
| `--use_gitignore` | boolean | Use git ls-files to respect .gitignore rules when scanning folders. Default: true. Set false... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext check specs ./docs/spec.md --folder_path ./src
```

### `llm-ext check rules`

- Usage: `llm-ext check rules [file_path] [--flag value ...]`
- Bare argument: `--file_path`
- Accepted profile types: any

Show which per-path review rule applies to a file, and from which layer (--rules explicit > <repo>/.llm-ext/rules.yaml > ~/.llm-externalizer/rules.yaml > none). Pure lookup, no LLM call — the debug surface of the layered rules engine that augments scan_folder / code_task / review_plan instructions per matching path glob (first entry wins, declaration order, case-insensitive globs with **, *, ?, {a,b}, [abc]).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--file_path` | string | (required) The file path to look up (absolute or repo-relative). |
| `--rules` | string | Explicit rules-file path overriding the layered lookup. |

Example:
```bash
llm-ext check rules ./src/api.ts
```

### `llm-ext check plan`

- Usage: `llm-ext check plan [input_files_paths] [--flag value ...]`
- Bare argument: `--input_files_paths`
- Accepted profile types: any

Delegate-mode code review: emit the deterministic review scaffolding — resolved file set (same walker as scan_folder), the review rubric, and a per-file protocol — WITHOUT calling any LLM ($0, no API key, ~1s). The HOST agent then performs the actual review with its own model. Use when the caller (e.g. Claude Code on a subscription) should do the reviewing itself instead of spending external tokens. Accepts the same file inputs as scan_folder: input_files_paths OR folder_path (+ extensions, exclude_dirs, use_gitignore).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--diff_commit` | string | Diff mode: one commit's changes (vs its parent). |
| `--diff_from` | string | Diff mode: base ref (merge-base '...' semantics; requires diff_to). |
| `--diff_to` | string | Diff mode: head ref (requires diff_from). |
| `--diff_workspace` | boolean | Diff mode: plan covers workspace-changed files and EMBEDS their hunks. |
| `--exclude_dirs` | array | Directory names to exclude from folder_path expansion. |
| `--extensions` | array | Optional extension filter for folder_path expansion. |
| `--folder_path` | string | Folder to expand via the standard walker (gitignore-aware). |
| `--input_files_paths` | array | Explicit absolute file paths to review (wins over folder_path). |
| `--instructions` | string | Extra review instructions APPENDED to the built-in real-defects-only rubric. |
| `--rules` | string | Explicit rules-file path (highest layer). Omitted: <repo>/.llm-ext/rules.yaml, then... |
| `--use_gitignore` | boolean | Respect .gitignore during folder expansion (default true). |

Example:
```bash
llm-ext check plan --folder_path ./src
```

### `llm-ext check diff`

- Usage: `llm-ext check diff [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: local, free, paid

Compare files — auto-computes unified diff, LLM summarises differences. Three modes:

1. PAIR MODE: input_files_paths with exactly 2 paths (before, after).
2. BATCH MODE: file_pairs array of [fileA, fileB] pairs for batch comparison.
3. GIT DIFF MODE: git_repo + from_ref + to_ref to compare files between two commits/tags. Diffs computed via git, LLM summarises each.

FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in file_pairs to produce separate reports per group. WHY: downstream agents only read their own group's report, saving context tokens.

CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.

LIMITS:
• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches.
• 600s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--file_pairs` | array | Array of [fileA, fileB] pairs for batch comparison. Supports ---GROUP:id--- markers: use... |
| `--from_ref` | string | Git ref (commit hash, tag, branch) for the 'before' version. Used with git_repo. |
| `--git_repo` | string | Absolute path to a git repository. Used with from_ref and to_ref for git diff mode. |
| `--input_files_paths` | array | Two absolute file paths: [before, after]. For batch comparisons, use file_pairs instead. |
| `--instructions` | string | Optional focus area (e.g. "focus on API changes", "check for regressions"). |
| `--instructions_files_paths` | oneOf | File(s) containing comparison instructions. |
| `--max_payload_kb` | number | Max file size in KB per file. Default: 400. Files exceeding this are skipped. |
| `--output_dir` | string | Absolute path to a custom output directory for the report. Default:... |
| `--redact_secrets` | boolean | Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files... |
| `--scan_secrets` | boolean | Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env... |
| `--to_ref` | string | Git ref (commit hash, tag, branch) for the 'after' version. Used with git_repo. Defaults to... |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext check diff --input_files_paths ./old.ts --input_files_paths ./new.ts --instructions "focus on API changes"
```
