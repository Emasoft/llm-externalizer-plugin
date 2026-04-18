# Use LLM Externalizer MCP

**IMPORTANT**: Prefer LLM Externalizer over Haiku subagents for bounded tasks. It's more capable and cheaper.

## ⚠️ Read before using any multi-file tool: how batching actually works

**The LLM never sees your whole set of input files at once.** Every multi-file tool (`chat`, `code_task`, `scan_folder`, `check_*`, `search_existing_implementations`) packs files into LLM requests of **typically 1–5 files each** — First-Fit Decreasing bin packing into ~400 KB batches, or **one group per request** when `---GROUP:id---` markers are supplied. The LLM sees only the files in a single batch and cannot cross-reference against files in other batches.

**Ensemble vs free/local**:
- **Ensemble mode** (`remote-ensemble`) — each file is reviewed by **3 different LLMs** in parallel, so every file receives **3 distinct responses**.
- **Free mode** (`free: true`, Nemotron 120B free tier) and **local mode** (LM Studio, Ollama, etc.) — each file receives **1 response** from a single model.

**If you need cross-file analysis across the whole codebase** (e.g. "find duplicate function declarations", "does this feature exist anywhere in the project?"), choosing a different `answer_mode` will NOT help — the LLM's per-request visibility is identical in all modes. Use `search_existing_implementations` instead — it's designed for exactly this: each file is compared against a REFERENCE (feature description + optional source files + optional diff), so no LLM call ever needs global codebase visibility.

**`answer_mode` controls ONLY how reports are organized on disk**, not how files are grouped into LLM requests. See the `answer_mode` section below for the full explanation.

## When to Use

Use `mcp__plugin_llm-externalizer_llm-externalizer__*` tools instead of subagents when:
- Reading/summarizing/analyzing files (especially large ones or 3+)
- Scanning codebases for patterns, bugs, security issues, dead code
- Processing tool output (linter logs, test logs, big JSON)
- Generating boilerplate, stubs, type definitions, draft text
- Comparing files without flooding your context with diffs
- Checking for broken imports or code references after refactoring
- Getting a second opinion on code or a problem
- Any bounded text task that doesn't need tool access

## When NOT to Use

- Precise surgical edits (use Read+Edit directly)
- Cross-file logic requiring multiple tool calls in sequence
- Subtle reasoning only Opus can handle
- Tasks needing real-time tool access (git, filesystem, web)
- Applying code fixes via LLM (write tools are not active — use Read+Edit instead)

## Tools Reference

### Analysis tools
| Tool | Purpose | Default answer_mode |
|------|---------|-------------------|
| `chat` | General-purpose: summarize, compare, translate, generate (also handles custom_prompt calls) | 2 (merged) |
| `code_task` | Code-optimized analysis with code-review system prompt | 2 (merged) |
| `scan_folder` | Auto-discover files in a directory tree, process each with LLM | 0 (per-file) |
| `compare_files` | Auto-compute diff between 2 files, LLM summarizes changes | N/A |
| `check_references` | Auto-resolve imports, send source+deps to LLM for validation | 2 (merged) |
| `check_imports` | LLM extracts imports → server checks each path exists on disk | 2 (merged) |
| `check_against_specs` | Compare source files against specification files | 2 (merged) |
| `search_existing_implementations` | Scan codebase (same language) for existing implementations of a described feature. FFD-batched, ensemble-backed, exhaustive per-file YES/NO output with symbol + lines. Use for PR duplicate-check reviews and "is this already done?" audits. | 2 (merged) |

### Utility tools
| Tool | Purpose |
|------|---------|
| `discover` | Check service health, auth token status, context window, concurrency mode, profiles |
| `reset` | Full soft-restart — waits for running requests, reloads settings, clears caches, resets counters |
| `change_model` | Switch model in active profile |
| `get_settings` | Copy settings.yaml to output dir, return file path (edit with Read/Edit tools) |
| `set_settings` | Read YAML from `file_path`, validate, backup old, write new settings |
| `or_model_info` / `or_model_info_table` / `or_model_info_json` | Query OpenRouter for a model's supported params, pricing, latency, uptime — three output formats |

### `search_existing_implementations` specifics

Required: `feature_description` (non-empty), `folder_path` (string or array).
Optional: `source_files` (reference context, auto-excluded from scan), `diff_path` (PR unified diff to narrow focus).

The server walks the codebase, FFD-packs matching files up to `max_payload_kb` per batch (default 400 KB), and makes ONE LLM call per batch. For a 10k-file codebase that typically means ~500 LLM calls instead of 10k — the tool was designed for massive-codebase PR reviews.

Output per file: one line of `NO` or `YES symbol=<name> lines=<a-b>`. EXHAUSTIVE — every occurrence is reported, no cap, so a reviewer can delete every duplicate and keep only the PR's new one. Default `max_files` is 10000 (higher than `scan_folder`'s 2500).

```json
{"tool": "search_existing_implementations",
 "feature_description": "async retry with exponential backoff and jitter",
 "folder_path": "/path/to/codebase/src",
 "source_files": ["/path/to/pr/retry.py"],
 "diff_path": "/tmp/pr.patch"}
```

### Plugin-shipped agents (as of v8.0.0)

Three agents ship with the plugin — all are **internal**; users dispatch them via slash commands, not directly:

| Agent | Model | Purpose | Dispatched by |
|---|---|---|---|
| `llm-externalizer-reviewer-agent` | sonnet | Read-only code reviewer; inherits full tool surface (SERENA, TLDR, Grepika, LSP). Returns only report paths — never reads or summarizes report contents. | The `llm-externalizer-scan` skill (`context: fork`). |
| `llm-externalizer-parallel-fixer-agent` | opus | Verifies and fixes ALL findings in ONE per-file LLM Externalizer scan report. Stateless; writes a `.fixer.`-tagged summary file; returns the summary path. Dispatched up to 15 in parallel. | `/llm-externalizer:llm-externalizer-scan-and-fix` (folder scan) and `/llm-externalizer:llm-externalizer-fix-report` (one report). |
| `llm-externalizer-serial-fixer-agent` | opus | Fixes exactly ONE bug per invocation from an aggregated bug list. Stateful on disk (mutates the list with ` — FIXED` markers). Dispatched one at a time in a loop. | `/llm-externalizer:llm-externalizer-fix-found-bugs` (aggregate + loop) and `/llm-externalizer:llm-externalizer-scan-and-fix-serially` (scan + aggregate + loop). |

All three agents are fresh-spawn (zero parent-conversation context) and load CLAUDE.md the same way `claude -p` does.

### CLI — `llm-externalizer search-existing`
Shell entry point for the `search_existing_implementations` tool. Use for scripting, CI, or quick terminal checks without spawning a subagent. Supports `--base <ref>` to auto-generate the PR diff via `git diff <ref>...HEAD` (with auto-detection of origin/HEAD → main → master when omitted), and `--diff <path>` as an escape hatch for pre-made patches.

```bash
llm-externalizer search-existing "async retry with exponential backoff" \
  /path/to/pr/retry.py --in /path/to/codebase
```

## Profile-Based Configuration

Settings file: `~/.llm-externalizer/settings.yaml`. Named profiles, each defining a complete LLM backend setup.

### Modes
| Mode | Behavior |
|------|----------|
| `local` | Sequential requests to a local server |
| `remote` | Parallel requests, single model via OpenRouter |
| `remote-ensemble` | Parallel requests, three models in parallel, combined report |

### API Presets
| Preset | Protocol | Default URL | Auth |
|--------|----------|-------------|------|
| `lmstudio-local` | LM Studio native API | `http://localhost:1234` | `$LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | (none) |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `$VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | (none) |
| `generic-local` | OpenAI-compatible | (url required) | `$LM_API_TOKEN` |
| `openrouter-remote` | OpenRouter API | `https://openrouter.ai/api` | `$OPENROUTER_API_KEY` |

All local backends must support structured output (`response_format: json_schema`). Only OpenRouter is supported for remote.

### Auth — auto-detected from environment
Auth is **automatic** when env vars are set. The server resolves `$ENV_VAR_NAME` references at startup and logs whether the token was found. **Do NOT report auth errors if `discover` shows the token is resolved.** If `discover` shows `$LM_API_TOKEN (NOT SET)`, the env var is missing from the MCP server's process environment — check `server.json` env configuration.

| Env var | Used by |
|---------|---------|
| `LM_API_TOKEN` | `lmstudio-local`, `generic-local` presets |
| `OPENROUTER_API_KEY` | `openrouter-remote` preset |
| `VLLM_API_KEY` | `vllm-local` preset |

Profile fields `api_key` / `api_token` can override the default env var with `$OTHER_VAR` or a direct value.

### Auth — plugin `userConfig` (keychain)
The plugin declares `userConfig.openrouter_api_key` with `sensitive: true`. When set via `/plugin configure llm-externalizer` or the plugin install prompt, Claude Code stores the value in the system keychain and exports it to the MCP server as `CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY`. The server's `resolveEnvValue()` transparently maps this into the canonical `OPENROUTER_API_KEY` name, so all existing profile refs (`$OPENROUTER_API_KEY`) work unchanged. userConfig wins over shell env when both are set; if only the shell env is set, the plugin still works (backwards compatible).

### CLI profile management
```bash
npx llm-externalizer profile list|add|select|edit|remove|rename
```

### Managing profiles via MCP (get_settings / set_settings)

The settings file is `~/.llm-externalizer/settings.yaml` (YAML format, NOT JSON).

#### How it works — file-based workflow (saves context tokens)

- `get_settings` copies `settings.yaml` to the output directory as `settings_edit.yaml` and returns **only the file path**. No YAML content in the response.
- `set_settings` accepts `file_path` — reads YAML from that file, validates, backs up the old settings, then writes. **The old settings are NEVER overwritten if the new content is invalid.**

#### Step-by-step workflow

**Step 1: Get the editable file**
```
Call mcp__plugin_llm-externalizer_llm-externalizer__get_settings (no parameters)
→ Returns a file path like: /path/to/reports_dev/llm_externalizer/settings_edit.yaml
```

**Step 2: Read and edit the file** using your Read and Edit tools.

The YAML has two top-level keys: `active` (string) and `profiles` (map). Each profile needs 3 required fields:

```yaml
active: my-profile-name       # must match a key under profiles:

profiles:
  my-profile-name:
    mode: local                # REQUIRED: local | remote | remote-ensemble
    api: lmstudio-local        # REQUIRED: preset name (see API Presets table)
    model: "model-name-or-id"  # REQUIRED: model identifier
    # OPTIONAL (presets provide defaults):
    # url: "http://localhost:1234"
    # api_token: $LM_API_TOKEN         # local auth (env var ref or direct)
    # api_key: $OPENROUTER_API_KEY     # remote auth (env var ref or direct)
    # second_model: "model-id"         # required for remote-ensemble only
    # timeout: 300
    # context_window: 100000
```

**Step 3: Apply the modified file**
```
Call mcp__plugin_llm-externalizer_llm-externalizer__set_settings with:
  file_path: "/path/to/reports_dev/llm_externalizer/settings_edit.yaml"
```
If validation fails, you get an error listing what's wrong — the old settings remain intact. Fix the file and call again.

**Step 4: Verify**
```
Call mcp__plugin_llm-externalizer_llm-externalizer__discover
```

#### Examples

**Switch active profile:**
1. `get_settings` → get file path
2. Read the file, use Edit to change `active: other-profile-name`
3. `set_settings` with `file_path`

**Add a new profile and activate it:**
1. `get_settings` → get file path
2. Read the file, use Edit to add a new profile block and change `active:`
3. `set_settings` with `file_path`
4. `discover` to verify

Profile templates to add:
```yaml
  # Local LM Studio (auth auto-detected from $LM_API_TOKEN)
  my-local:
    mode: local
    api: lmstudio-local
    model: "bartowski/Llama-3.3-70B-Instruct-GGUF"

  # Remote single model
  my-remote:
    mode: remote
    api: openrouter-remote
    model: "anthropic/claude-sonnet-4"
    api_key: $OPENROUTER_API_KEY

  # Remote ensemble (three models in parallel)
  my-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    third_model: "qwen/qwen3.6-plus"
    api_key: $OPENROUTER_API_KEY
```

**Change model** — Edit the `model:` field in the target profile.
**Remove profile** — Delete its block. Cannot remove the `active:` profile.

#### Validation rules (what set_settings rejects)

- `active` must reference an existing profile key
- `mode` must be `local`, `remote`, or `remote-ensemble`
- `api` must be a valid preset name
- `local` mode requires a `-local` preset; `remote`/`remote-ensemble` requires `openrouter-remote`
- `remote-ensemble` requires `second_model`
- Remote presets require `api_key` (or default env var) to be resolvable
- Numeric fields must be non-negative finite numbers

#### CRITICAL: The file must contain ALL profiles

`set_settings` **replaces** the entire settings.yaml. The edited file must include ALL profiles, not just the one you changed. If you delete other profiles from the file, they are permanently removed (backup exists).

## Ensemble Mode

Ensemble mode is configured at the **profile level** (mode: `remote-ensemble` in settings.yaml), not as a per-call parameter. When enabled, the request runs on all configured models in parallel, and results are combined in one report with per-model sections. If 1-2 models fail (removed, rate-limited, timed out), the report includes results from surviving models — only errors if all fail.

### Default ensemble models
| Model | Pricing (per 1M tokens) | File size limit |
|-------|------------------------|-----------------|
| `google/gemini-2.5-flash` | $0.15 input / $0.60 output | ≤50K lines |
| `x-ai/grok-4.1-fast` | $0.30 input / $0.50 output | ≤20K lines |
| `qwen/qwen3.6-plus` | $0.33 input / $1.95 output | ≤40K lines |

- If a file exceeds a model's limit, that model is excluded and the others run
- On local backends (LM Studio, Ollama), ensemble is not available (single model only)

## Standard Input Fields (all content tools)

```
instructions          — Task text (unfenced, placed before files)
instructions_files_paths — Path(s) to instruction files (appended to instructions)
input_files_paths     — Path(s) to content files (code-fenced by the server)
input_files_content   — Inline content (DISCOURAGED — wastes your tokens)
```

**ALWAYS** use `input_files_paths` instead of reading files into your context. The server reads files from disk directly.

## File Grouping

Use `---GROUP:id---` / `---/GROUP:id---` markers in `input_files_paths` to process groups in complete isolation. Each group produces its own separate report file with the group ID in the filename.

```json
{"tool": "code_task", "answer_mode": 0, "max_retries": 3,
 "instructions": "Find bugs in this auth module",
 "input_files_paths": ["---GROUP:auth---", "/path/auth.ts", "/path/auth-utils.ts", "---/GROUP:auth---",
                        "---GROUP:api---", "/path/api.ts", "/path/routes.ts", "---/GROUP:api---"]}
```

Output: one line per group — `[group:auth] /path/to/report_group-auth_....md`. Each downstream agent only reads its own group's report, saving context tokens.

## Advanced Parameters

### `system` (string, `chat` only)
Persona override. Be specific: `"Senior TypeScript dev"` not `"helpful assistant"`.

### `language` (string, `code_task` only)
Programming language hint. Auto-detected from `input_files_paths` extension if not set.

### `max_retries` (number, `chat`/`code_task`/`check_against_specs`/`check_imports`/`check_references`)
Max retries per file when `answer_mode=0`. Default: 1 (no retry). Set to 3 for robust per-file processing with parallel execution, exponential backoff, and circuit breaker (aborts after 3 consecutive failures). **This replaces `batch_check`.**

### `redact_regex` (string, all content tools)
JavaScript regex pattern to redact matching strings from file content before sending to LLM. Applied after secret redaction. Alphanumeric matches become `[REDACTED:USER_PATTERN]`.

### `exclude_dirs` (string array, `scan_folder` only)
Additional directory names to skip. Hidden dirs, `node_modules`, `.git`, `dist`, `build`, `.venv`, `.idea`, `tmp`, `vendor` are always skipped.

### `output_dir` (string, all content tools)
Custom output directory for reports. Default: `<project>/reports_dev/llm_externalizer/`. Must be an absolute path.

### `free` (boolean, all content tools)
Use the free Nemotron 3 Super model (`nvidia/nemotron-3-super-120b-a12b:free`) instead of the ensemble. No cost, single model, 262K context. **LOW QUALITY**: this model has significantly lower intelligence than the ensemble models — expect more false positives, missed bugs, and shallow analysis. Use only for quick rough checks on non-critical code. **WARNING**: prompts are logged by the provider — do not use with sensitive/proprietary code.

### `temperature`
Fixed at 0.1 for all models. Not configurable.

## answer_mode

**READ THIS FIRST — the most common misconception**: `answer_mode` controls HOW REPORTS ARE ORGANIZED ON DISK, nothing else. It does NOT control how many files the LLM sees per request. The LLM **never** sees your whole set of input files at once — regardless of which mode you pick.

### The real batching model (true for every multi-file tool)

- Files are packed into LLM requests of typically **1–5 files each** — First-Fit Decreasing bin packing into ~400 KB batches, or **one group per request** when `---GROUP:id---` markers are supplied.
- In **ensemble mode** (`remote-ensemble`), each file is reviewed by **3 different LLMs** in parallel, so every file receives **3 distinct responses**. In **free mode** (`free: true`) and **local mode** (LM Studio / Ollama / etc.), each file receives **1 response**.
- The LLM only ever sees the files in a single batch. It cannot cross-reference against files in other batches. It cannot "see the whole codebase".
- **If you need cross-file analysis across the whole codebase** (like "find duplicate function declarations" or "is this feature already implemented anywhere?"), avoiding `answer_mode: 0` will NOT help. Use `search_existing_implementations` instead — it's purpose-built for that use case. Each file is compared against a REFERENCE (feature description + optional source files + optional diff), so the LLM never needs global visibility.

### The modes (what actually differs between them)

Each mode writes `.md` files to `reports_dev/llm_externalizer/`.

**answer_mode : 0**
- **NAME**: ONE REPORT PER FILE
- **DESCRIPTION**: One `.md` report is saved for every input file. Files are still batched into LLM requests of typically 1–5 files each; each LLM response contains structured per-file sections that the MCP server splits apart and persists as individual reports. Output is a list of `<input_file_path> -> <report_path>` pairs.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: Downstream consumers (agents, tools, CI) pick up one file's review without scanning an aggregate. Typical for per-file lint/audit pipelines and fan-out workflows.
- **ADVANTAGES**: Trivially routed — one file in, one report out. Supports parallel execution with retry and circuit breaker via `max_retries`.
- **DISADVANTAGES**: N files → N report files on disk.

**answer_mode : 1**
- **NAME**: ONE REPORT PER GROUP
- **DESCRIPTION**: One `.md` report is saved per **group of files**. Groups are either explicit (`---GROUP:id---` / `---/GROUP:id---` markers in `input_files_paths`) or auto-generated. When no markers are supplied, the MCP server auto-groups files intelligently using these priorities, in order: (1) parent **subfolder**, (2) **language/format** (file extension), (3) **namespace/package** inferred from the directory hierarchy, (4) shared **filename prefix** (e.g. `user.ts` + `user.test.ts`), (5) shared **imports/libraries**. Each auto-group contains at most **1 MB** of source; oversized buckets are split into sub-groups via bin packing.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: You want one report per logical chunk of the codebase (e.g. one report per feature folder, one per module). Keeps related-file context together while still producing separate files for independent groups.
- **ADVANTAGES**: Balanced output — fewer files than mode 0, more granular than mode 2. Group boundaries match natural project structure, easy to route and review.
- **DISADVANTAGES**: Group composition is heuristic when markers are not supplied; callers who need exact control must pass explicit `---GROUP:id---` markers.

**answer_mode : 2**
- **NAME**: SINGLE REPORT
- **DESCRIPTION**: Exactly one `.md` report is saved, merging the responses from every LLM batch into a single document with per-batch and per-file sections.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: You want one top-level summary across all scanned files — e.g. a single audit report to share with a reviewer or attach to a PR.
- **ADVANTAGES**: Simplest output. One file path returned.
- **DISADVANTAGES**: For very large scans the merged file can be long. Downstream per-file routing requires re-parsing sections out of the single report.

### Tool-specific defaults

- `scan_folder` = 0 (per-file reports)
- `chat` / `code_task` / `check_references` / `check_imports` / `check_against_specs` = 2 (single merged report)
- `search_existing_implementations` = 2 (single merged report); mode 1 emits one merged report per auto-group, and mode 0 splits each batch's LLM response by `## File:` markers and saves one report per input file

## Usage Patterns

### Scan a codebase for issues
```json
{"tool": "scan_folder", "folder_path": "/path/to/src", "extensions": [".ts", ".py"],
 "instructions": "Find security vulnerabilities. This is a Node.js REST API using Express."}
```

### Analyze multiple files together
```json
{"tool": "chat", "instructions": "Compare these configs and list differences",
 "input_files_paths": ["/path/a.yaml", "/path/b.yaml"]}
```

### Apply same check to each file independently
```json
{"tool": "code_task", "answer_mode": 0, "max_retries": 3,
 "instructions": "Find all TODO comments and classify by urgency",
 "input_files_paths": ["/path/a.ts", "/path/b.ts", "/path/c.ts"]}
```

### Search codebase for existing implementations of a feature
```json
{"tool": "search_existing_implementations",
 "feature_description": "rate-limited HTTP client with retry backoff",
 "folder_path": "/path/to/codebase",
 "source_files": ["/path/to/pr/http_client.py"]}
```

### Compare two file versions
```json
{"tool": "compare_files", "input_files_paths": ["/path/old.ts", "/path/new.ts"],
 "instructions": "Focus on API breaking changes"}
```

### Check for broken code references after refactoring
```json
{"tool": "check_references", "input_files_paths": "/path/to/file.ts",
 "instructions": "This is a TypeScript MCP server. Check all symbol references are valid."}
```

### Check for broken file imports
```json
{"tool": "check_imports", "input_files_paths": "/path/to/file.ts"}
```

### Reuse instructions across operations
```json
{"tool": "code_task", "answer_mode": 0, "max_retries": 3,
 "instructions_files_paths": "/path/to/review-rules.md",
 "input_files_paths": ["/path/a.ts", "/path/b.ts"]}
```

### Simple task
```json
{"tool": "chat", "instructions": "What is the main export of this module?",
 "input_files_paths": "/path/to/file.ts"}
```

### Quick factual answer
```json
{"tool": "chat", "instructions": "List the function names exported from this module. One per line.",
 "input_files_paths": "/path/to/file.ts"}
```

### Compare source against specification
```json
{"tool": "check_against_specs", "instructions": "Check compliance with the API contract",
 "input_files_paths": "/path/to/impl.ts", "instructions_files_paths": "/path/to/spec.md"}
```

### Code review with persona
```json
{"tool": "chat", "instructions": "Review this Python CLI script for error handling gaps.",
 "input_files_paths": "/path/to/cli.py", "system": "Senior Python CLI developer"}
```

### Scan folder with gitignore + excluded dirs
```json
{"tool": "scan_folder", "folder_path": "/path/to/project",
 "extensions": [".py"], "use_gitignore": true, "exclude_dirs": ["migrations", "fixtures"],
 "instructions": "Find security vulnerabilities. This is a Django REST API."}
```

## Safety Features

- **`scan_secrets`** (boolean): Available on all content tools. Scans input files **and** `input_files_content` for secrets (API keys, tokens, passwords) and **aborts** the operation if any are found. Use to enforce clean code before processing.
- **`redact_secrets`** (boolean): Available on all content tools. **DISCOURAGED** — prefer moving secrets to `.env` files (gitignored). Replaces secrets with `[REDACTED:LABEL]` for read-only tools.
- **`use_gitignore`** (boolean): Available on `scan_folder`. Uses `git ls-files` to respect `.gitignore` rules instead of manual directory walk.
- **Binary detection**: Both extension-based and null-byte content checks.
- **Empty files**: Zero-byte files are passed to the LLM with an `(empty file — 0 bytes)` marker.

## Output Location

**ALL files generated by LLM Externalizer are saved in `<project folder>/reports_dev/llm_externalizer/`** — the project folder where Claude Code is running. This includes:
- LLM response reports (`.md` files from chat, code_task, batch_check, etc.)
- Settings edit copy (`settings_edit.yaml` from get_settings)
- Merged/comparison reports

Every tool returns **only the file path** — never inline content. Use Read to access the output when needed. The folder is inside the project sandbox so all files are accessible to Claude Code's Read/Edit tools.

## Key Constraints

- **600s base timeout**: Per LLM request. Extended automatically when reasoning models (Qwen, etc.) are actively thinking — no hard cap during reasoning.
- **Max output tokens**: Defaults to model maximum (65,535).
- **No project context**: The remote LLM knows nothing about your project. ALWAYS include brief context in instructions.
- **Rate limiting**: Adaptive RPS auto-detected from OpenRouter balance ($1 ≈ 1 RPS, max 500). AIMD adjusts on 429 errors. Up to 200 in-flight. Local = sequential. Check with `discover`.
- **Output**: All responses are saved to `reports_dev/llm_externalizer/`. The tool returns ONLY the file path. Read it when needed.
- **Auto-batching**: If input files exceed context window, they're automatically split into batches (FFD bin packing, 400 KB budget).
- **File paths only**: ALWAYS pass file paths, NEVER paste file contents into instructions.
- **No write tools active**: Write tools exist but are not active. Use `code_task` for analysis, then apply fixes manually with Read+Edit.
- **Auto-retry**: Truncated responses are automatically retried (up to 3 times). Reasoning model timeouts are not retried (retrying restarts thinking from scratch).
- **`scan_folder.max_files`**: Default 2500. Safety limit to prevent runaway scans.
- **`search_existing_implementations.max_files`**: Default 10000 (higher than scan_folder because the tool is designed for massive PR-review scans). Configurable up to any practical limit via the `max_files` parameter.
- **`scan_folder.use_gitignore`**: Default true. Uses `git ls-files` to respect all `.gitignore` rules, submodules, and nested git repos.
- **`scan_folder.exclude_dirs`**: Additional dirs to skip beyond built-in exclusions (node_modules, .git, dist, build, .venv, __pycache__, .idea, .vscode, tmp, vendor, etc.).
- **`max_payload_kb`**: Configurable per tool (default: 400 KB). Controls maximum payload size for batching.
- **File grouping**: Use `---GROUP:id---` markers for isolated per-group reports. See [File Grouping](#file-grouping) section.
