# llm-externalizer

<!--BADGES-START-->
![version](https://img.shields.io/badge/version-7.1.2-blue)
![build](https://img.shields.io/badge/build-passing-brightgreen)
![typescript](https://img.shields.io/badge/typescript-5.x-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)
![marketplace](https://img.shields.io/badge/marketplace-emasoft--plugins-purple)
<!--BADGES-END-->

A Claude Code plugin that offloads bounded LLM tasks to cheaper local or remote models via MCP. Supports local backends (LM Studio, Ollama, vLLM, llama.cpp) and remote backends (OpenRouter) with profile-based configuration and ensemble mode.

### Cost comparison

![Cost comparison: Opus $0.84, Sonnet $0.51, Ensemble $0.08](docs/cost_comparison.png)

## Features

- **17 MCP tools** — 9 read-only analysis tools + 5 utility tools + 3 OpenRouter model-info formatters
- **`llm-externalizer-reviewer-agent`** — Sonnet-class plugin agent for fast code reviews with restricted tool allowlist (no Write/Edit). Internal — dispatched by the `llm-externalizer-scan` skill
- **`llm-externalizer-parallel-fixer-agent`** — Opus-class agent that verifies and fixes findings from a single per-file scan report. Internal — dispatched by `/llm-externalizer:llm-externalizer-scan-and-fix` (parallel per-report over a whole folder) and `/llm-externalizer:llm-externalizer-fix-report` (single-report wrapper)
- **`llm-externalizer-serial-fixer-agent`** — Opus-class per-bug fixer dispatched serially by `/llm-externalizer:llm-externalizer-fix-found-bugs`; each spawn is fresh (zero parent-conversation context) and fixes exactly one bug from an aggregated bug list. Internal — dispatched by the command, not invoked directly
- **Profile-based configuration** — named profiles in `~/.llm-externalizer/settings.yaml`
- **`userConfig.openrouter_api_key`** — keychain-stored OpenRouter key via plugin configure UI (falls back to shell `$OPENROUTER_API_KEY`)
- **Ensemble mode** — three models in parallel on OpenRouter, combined report
- **Auto-batching** — FFD bin-packing by payload size for all multi-file tools
- **File grouping** — organize files into named groups (`---GROUP:id---`) for isolated per-group reports
- **Secret scanning** — detects API keys and tokens before sending to LLM
- **User-defined regex redaction** — `redact_regex` parameter to redact custom patterns
- **Robust batch processing** — `max_retries` parameter with parallel execution, retry, and circuit breaker on all tools
- **File-based output** — all results saved to files, only paths returned (keeps orchestrator context clean)
- **5 auto-discovered skills** — usage, config, full scan, free scan, OpenRouter model info
- **7 slash commands** — `/llm-externalizer:llm-externalizer-discover`, `/llm-externalizer:llm-externalizer-configure`, `/llm-externalizer:llm-externalizer-search-existing-implementations`, `/llm-externalizer:llm-externalizer-scan-and-fix`, `/llm-externalizer:llm-externalizer-scan-and-fix-serially`, `/llm-externalizer:llm-externalizer-fix-report`, `/llm-externalizer:llm-externalizer-fix-found-bugs`
- **CLI subcommand** — `llm-externalizer search-existing` for shell / CI duplicate-check workflows
- **6 backend presets** — LM Studio, Ollama, vLLM, llama.cpp, generic local, OpenRouter

## MCP Tools

> ⚠️ **How files reach the LLM (read this before picking `answer_mode`)**:
> All multi-file tools pack files into LLM requests of **typically 1–5 files each** — FFD bin packing into ~400 KB batches, or one group per request when `---GROUP:id---` markers are used. The LLM **never** sees your whole set of input files at once, and `answer_mode` does NOT change that — it only controls how reports are persisted to disk.
>
> - **Ensemble mode**: each file is reviewed by **3 different LLMs** in parallel, so every file receives **3 distinct responses**.
> - **Free mode** (`free: true`, Nemotron 120B free tier) and **local mode**: each file receives **1 response** from a single model.
>
> If you need cross-file analysis across the whole codebase (e.g. "find every duplicate implementation of X"), use `search_existing_implementations` — it is the only tool designed for that use case and compares each file against a REFERENCE (description + optional source files + optional diff) rather than against other files.

### Read-only analysis tools

| Tool | Purpose |
|------|---------|
| `chat` | General-purpose: summarize, compare, translate, generate text. Supports `system` persona. Accepts `folder_path` for directory scanning |
| `code_task` | Code-optimized analysis with code-review system prompt. Supports `language` hint. Accepts `folder_path` for directory scanning |
| `scan_folder` | Recursively scan a directory, auto-discover files by extension, process each with LLM |
| `compare_files` | Compare files in 3 modes: pair (2 files), batch (`file_pairs`), or git diff (`git_repo` + refs). LLM summarizes differences |
| `check_references` | Auto-resolve local imports, send source+dependencies to LLM to validate symbol references. Accepts `folder_path` |
| `check_imports` | Two-phase — LLM extracts all import paths, server validates each exists on disk. Accepts `folder_path` |
| `check_against_specs` | Compare source files against a specification file. Reports violations only. Accepts `folder_path`, `input_files_paths`, or both combined |
| `search_existing_implementations` | Scan a codebase (same language) for existing implementations of a described feature. FFD-batched, ensemble-backed, exhaustive per-file `NO` / `YES symbol=<name> lines=<a-b>` output. Optional `source_files` and `diff_path` for PR duplicate-check reviews. Default `max_files: 10000`. |

### Utility tools

| Tool | Purpose |
|------|---------|
| `discover` | Check service health, context window, concurrency mode, profiles, auth status |
| `reset` | Full soft-restart — waits for running requests, reloads settings (picks up manual edits to `~/.llm-externalizer/settings.yaml`), clears caches |
| `get_settings` | Copy `settings.yaml` to output dir for reading (returns the file path only — read-only view; edit the real file manually) |
| `or_model_info` | Query OpenRouter for a model's supported params, pricing, latency, uptime — pipe-delimited markdown table output |
| `or_model_info_table` | Same as `or_model_info` but ANSI-colored Unicode-bordered table for terminal rendering |
| `or_model_info_json` | Raw JSON for programmatic use; optional `file_path` to persist to disk |

### Read-only by design — disabled tools

The MCP is read-only. Two classes of write tools exist in the codebase but are **disabled** — calling them returns a refusal message:

| Disabled tool | Use this instead |
|--------------|------------------|
| `fix_code`, `batch_fix`, `merge_files`, `split_file`, `revert_file` | The `/llm-externalizer:llm-externalizer-scan-and-fix` plugin command — it spawns local agents that use Claude Code's Read+Edit directly. The MCP never writes to user source files. |
| `set_settings`, `change_model` | Model & profile configuration is user-only. Edit `~/.llm-externalizer/settings.yaml` in your editor, then call `reset` or restart Claude Code. |

The CLI mutation subcommands (`npx llm-externalizer profile add | select | edit | remove | rename`) are likewise disabled and refuse to run. Only `npx llm-externalizer profile list` is still available.

### Standard input fields (all content tools)

| Field | Description |
|-------|-------------|
| `instructions` | Task text (unfenced, placed before files) |
| `instructions_files_paths` | Path(s) to instruction files (appended to instructions). Use for reusable prompts |
| `input_files_paths` | Path(s) to content files (code-fenced by server). **Always prefer this over inline content** |
| `input_files_content` | Inline content (DISCOURAGED — wastes orchestrator context tokens) |

### Advanced parameters (all content tools)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `answer_mode` | 0 | Output mode (see [Output modes](#output-modes) below) |
| `output_dir` | `reports_dev/llm_externalizer/` | Custom output directory for reports. Absolute path |
| `max_retries` | 1 | Max retries per file in mode 0. Set 3 for parallel + retry + circuit breaker. Available on `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs` |
| `redact_regex` | (none) | JavaScript regex to redact matching strings before sending to LLM. Alphanumeric matches become `[REDACTED:USER_PATTERN]` |
| `scan_secrets` | false | Abort if API keys/tokens/passwords detected in input files |
| `redact_secrets` | false | Replace detected secrets with `[REDACTED:LABEL]` |
| `max_payload_kb` | 400 | Max payload per batch in KB |
| `folder_path` | (none) | Absolute path to a folder to scan. Can be combined with `input_files_paths`. Available on `chat`, `code_task`, `check_references`, `check_imports`, `check_against_specs` |
| `extensions` | (all) | File extensions filter when using `folder_path`, e.g. `[".ts", ".py"]`. Omit to scan all non-binary files |
| `exclude_dirs` | (none) | Additional directory names to skip beyond defaults (`node_modules`, `.git`, `dist`, `build`, `.venv`, `.idea`, `tmp`, `vendor`, etc.) |
| `recursive` | true | Recurse into subdirectories when scanning `folder_path` |
| `follow_symlinks` | true | Follow symbolic links (circular symlinks auto-detected and skipped) |
| `max_files` | 2500 | Maximum number of files to discover from `folder_path` |
| `use_gitignore` | true | Use `.gitignore` rules to filter files. Handles submodules and nested git repos. Set `false` to include gitignored files |

### Output modes (`answer_mode`)

`answer_mode` controls **only how reports are persisted to disk**. It does NOT change how many files the LLM sees per request — that is governed by the batching algorithm, independently of this field. The LLM always sees **1–5 files per request** (FFD-packed, or one group per request when `---GROUP:id---` markers are supplied). In **ensemble mode** each file receives **3 different responses** from 3 LLMs in parallel; in **free mode** and **local mode** each file receives **1 response**.

---

**answer_mode : 0**
- **NAME**: ONE REPORT PER FILE
- **DESCRIPTION**: One `.md` report is saved for every input file. Files are still batched into LLM requests of typically 1–5 files each; each LLM response contains structured per-file sections that the MCP server splits apart and persists as individual reports. Output is a list of `<input_file_path> -> <report_path>` pairs.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: Downstream consumers (agents, tools, CI) need to pick up one file's review without scanning an aggregate. Typical for per-file lint/audit pipelines and fan-out workflows.
- **ADVANTAGES**: Trivially routed — one file in, one report out. Supports parallel execution with retry and circuit breaker via `max_retries`.
- **DISADVANTAGES**: `N` files → `N` report files on disk. Slightly more overhead when you only want a big-picture summary.

**answer_mode : 1**
- **NAME**: ONE REPORT PER GROUP
- **DESCRIPTION**: One `.md` report is saved per **group of files**. Groups are either explicit (`---GROUP:id---` / `---/GROUP:id---` markers in `input_files_paths`) or auto-generated. When the caller supplies markers, files inside each `---GROUP:id---` block share a report. When no markers are supplied, the MCP server auto-groups files intelligently using these priorities, in order: (1) parent **subfolder**, (2) **language/format** (file extension), (3) **namespace/package** inferred from the directory hierarchy, (4) shared **filename prefix** (e.g. `user.ts` + `user.test.ts`), (5) shared **imports/libraries**. Each auto-group contains at most **1 MB of source**; oversized buckets are split into sub-groups via bin packing. The LLM still processes each group in isolation and cannot cross-reference files across groups.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: You want one report per logical chunk of the codebase (e.g. one report per feature folder, one per module). Keeps related-file context together while still producing separate files for independent groups.
- **ADVANTAGES**: Balanced output — fewer files than mode 0, more granular than mode 2. Group boundaries match natural project structure so reports are easy to route and review.
- **DISADVANTAGES**: Group composition is a heuristic when markers are not supplied; callers who need exact control must pass explicit `---GROUP:id---` markers.

**answer_mode : 2**
- **NAME**: SINGLE REPORT
- **DESCRIPTION**: Exactly one `.md` report is saved, merging the responses from every LLM batch into a single document with per-batch and per-file sections.
- **FORMAT**: markdown (`.md`)
- **WHEN TO USE**: You want one top-level summary across all scanned files — e.g. a single audit report to share with a reviewer or attach to a PR.
- **ADVANTAGES**: Simplest output. One file path returned. Easy to email, attach, or hand off.
- **DISADVANTAGES**: For very large scans the merged file can be long. Downstream per-file routing requires re-parsing sections out of the single report.

---

**Default per tool**: `scan_folder` = 0, `chat` / `code_task` / `check_*` = 2, `search_existing_implementations` = 2.

**Mode 0 response format** — one pair per line, input file → report path:
```
/path/to/src/auth.ts -> /path/to/reports_dev/llm_externalizer/code_task_auth-ts_2026-04-07T19-43-26_a1b2c3.md
/path/to/src/routes.ts -> /path/to/reports_dev/llm_externalizer/code_task_routes-ts_2026-04-07T19-43-28_d4e5f6.md
```

**Mode 1 response format** — one line per group, group id tag → report path:
```
[group:auth-ts] /path/to/reports_dev/llm_externalizer/code_task_group-auth-ts_2026-04-07T19-43-26_a1b2c3.md
[group:routes-ts] /path/to/reports_dev/llm_externalizer/code_task_group-routes-ts_2026-04-07T19-43-28_d4e5f6.md
```

**Mode 2 response format** — one path:
```
/path/to/reports_dev/llm_externalizer/scan_folder_2026-04-07T19-43-26_a1b2c3.md
```

### File grouping

Organize files into named groups for isolated processing — n groups in, n reports out:

```json
{
  "input_files_paths": [
    "---GROUP:auth---",
    "/path/to/auth.ts",
    "/path/to/auth.test.ts",
    "---/GROUP:auth---",
    "---GROUP:api---",
    "/path/to/routes.ts",
    "---/GROUP:api---"
  ]
}
```

Each group produces its own report: `[group:auth] /path/to/report_group-auth_...md`. Groups apply to `input_files_paths` (and `file_pairs` in `compare_files`), not instructions or spec files. No markers = backward compatible.

### Ensemble mode

On OpenRouter (`remote-ensemble` profile), requests run on **three models in parallel** with results combined in one report. If one or two models fail (removed, rate-limited, timed out), the report includes results from the surviving models — only errors if all three fail.

**Default ensemble models:**

| Model | Role | Pricing (per 1M tokens) | File size limit |
|-------|------|------------------------|-----------------|
| `google/gemini-2.5-flash` | Primary | $0.15 input / $0.60 output | ≤50K lines |
| `x-ai/grok-4.1-fast` | Secondary | $0.30 input / $0.50 output | ≤20K lines |
| `qwen/qwen3.6-plus` | Tertiary (reasoning) | $0.33 input / $1.95 output | ≤40K lines |

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ensemble` | `true` (on OpenRouter) | Set `false` for simple tasks to save tokens |
| `free` | `false` | Use the free Nemotron 3 Super model instead of ensemble. No cost, single model, 262K context. **WARNING**: prompts are logged by the provider — do not use with sensitive/proprietary code |
| `max_tokens` | model maximum (65,535) | Auto-managed, not user-configurable |
| `temperature` | 0.1 (fixed) | Optimized for factual/code analysis. Not user-configurable |

### Free mode

Set `free: true` on any tool to use **NVIDIA Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b:free`) — a 120B-parameter MoE model (12B active) available for free on OpenRouter.

| | Ensemble | Free mode |
|---|---|---|
| **Cost** | ~$0.35 per full scan | **$0** |
| **Models** | 3 (Gemini + Grok + Qwen) | 1 (Nemotron 3 Super) |
| **Context** | 1M tokens (Gemini) | 262K tokens |
| **Quality** | 3 independent reviews, high accuracy | **Low** — single weak model, more false positives, shallow analysis |
| **Privacy** | Standard OpenRouter terms | **Prompts are logged** by provider |
| **Use case** | Production code, thorough audit | Quick rough checks on non-critical/open-source code |

### Rate limiting

Rate limiting is **fully automatic** — no configuration needed.

- **RPS auto-detected** from OpenRouter balance ($1 ≈ 1 RPS, max 500)
- **Adaptive AIMD**: halves RPS on 429 errors, increases by 1 after 10 consecutive successes
- **Up to 200 requests in-flight** simultaneously
- **Heartbeat** every 30s keeps MCP connection alive during long batches

### Key constraints

- **600s base timeout** per LLM request. Extended automatically when reasoning models (Qwen, etc.) are actively thinking — no hard cap during reasoning
- **No project context** — the remote LLM knows nothing about your project; always include brief context in instructions
- **File paths only** — always use `input_files_paths`, never paste file contents into instructions
- **Output location** — all responses saved to `reports_dev/llm_externalizer/` in the project directory. Customizable via `output_dir` parameter

### Subagent access

**Regular subagents** (spawned by Claude Code via the Agent tool) can use all LLM Externalizer MCP tools — they inherit the parent session's tool access.

**Plugin-shipped agents** (`.md` files in a plugin's `agents/` directory) **cannot** use MCP servers. Claude Code strips `mcpServers` and `hooks` from plugin agent frontmatter for security. This means a plugin agent cannot start the LLM Externalizer MCP server.

**Solution:** The plugin ships `bin/llm-ext`, a CLI wrapper that any agent can call via the Bash tool. No MCP access needed — it spawns the server, executes one tool call, and returns the result.

To enable LLM Externalizer in your plugin agent, add this snippet to the agent's `.md` file instructions:

```markdown
## LLM Externalizer (external model analysis)

You have access to the LLM Externalizer CLI for offloading analysis tasks to cheaper external LLMs.
The CLI is at: node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext"

FIRST, discover available tools and their parameters:
  node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" --help
  node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" --help <tool_name>

THEN, call the appropriate tool. Examples:
  node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" code_task --instructions "Find bugs" --input_files_paths /path/to/file.ts
  node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" chat --instructions "Summarize" --folder_path /path/to/src --extensions '[".ts"]'
  node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" discover

The output is a file path to the saved report. Read the report with the Read tool.
All parameters use --key value syntax. Arrays use JSON: --extensions '[".ts",".py"]'
Timeout: 10 minutes. Paths: absolute paths recommended.
```

The agent will call `--help` first to learn the available tools and parameters, then select the right command for its task.

## Prerequisites

- **Node.js >= 18** and **npm** — to build the bundled MCP server
- **Python >= 3.12** — build, statusline, and publishing scripts (all scripts are Python, no shell scripts)
- For local backends: a running LM Studio, Ollama, vLLM, or llama.cpp server
- For remote backends: an OpenRouter API key (`OPENROUTER_API_KEY` environment variable)

> **Note**: The `mcp-server/` directory contains the bundled TypeScript MCP server source, build output, and server manifest. It is built during installation via `scripts/setup.py`.

## Naming

- **Plugin name**: `llm-externalizer` — this is the name in `plugin.json` and what you use with `claude plugin install`
- **GitHub repo**: [`Emasoft/llm-externalizer-plugin`](https://github.com/Emasoft/llm-externalizer-plugin) — where the source code lives

The plugin name and repo name are intentionally different. When installing or referencing the plugin, always use `llm-externalizer` (the plugin name), not `llm-externalizer-plugin` (the repo name).

## Installation

### From the emasoft-plugins marketplace (recommended)

```bash
# Add the marketplace (first time only)
claude plugin marketplace add Emasoft/emasoft-plugins

# Update the marketplace index to get the latest plugin list
claude plugin marketplace update emasoft-plugins

# Install the plugin
claude plugin install llm-externalizer@emasoft-plugins
```

Restart Claude Code to activate.

> **Note**: If `claude plugin install` says "not found", run `claude plugin marketplace update emasoft-plugins` first to refresh the local marketplace cache.

### Alternative: manual settings.json

Add the marketplace and enable the plugin in `~/.claude/settings.json`:

```json
{
  "pluginMarketplaces": [
    "Emasoft/emasoft-plugins"
  ],
  "enabledPlugins": {
    "llm-externalizer@emasoft-plugins": true
  }
}
```

Restart Claude Code or run `/reload-plugins` to activate.

### Manual installation (development)

```bash
# Clone the plugin repo directly
git clone https://github.com/Emasoft/llm-externalizer-plugin.git /tmp/llm-externalizer-plugin

# Build the MCP server
cd /tmp/llm-externalizer-plugin
python3 scripts/setup.py

# Install from local path
claude plugin install /tmp/llm-externalizer-plugin
```

## Setup

After installation, the MCP server needs to be built (the marketplace install triggers `scripts/setup.py` automatically):

```bash
python3 scripts/setup.py
```

On first run, the server creates a settings template at `~/.llm-externalizer/settings.yaml` with 4 predefined profiles.

### Optional: statusline

```bash
python3 $CLAUDE_PLUGIN_ROOT/scripts/install_statusline.py
```

Shows model, context usage, and cost stats in the Claude Code status bar.

### Verify

```bash
# Inside Claude Code, run the discover command:
/llm-externalizer:llm-externalizer-discover
```

This shows service health, active profile, model, auth token status, and available profiles.

## Configuration

Settings at `~/.llm-externalizer/settings.yaml`. **Changing models, profiles, API keys, or timeouts is user-only** — edit the file in your editor, save, then either restart Claude Code or call the MCP `reset` tool to reload. The `/llm-externalizer:llm-externalizer-configure` command is a read-only inspector only; it cannot mutate the file.

### Quick start with OpenRouter

```yaml
active: remote-ensemble

profiles:
  remote-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    api_key: $OPENROUTER_API_KEY
```

### Quick start with LM Studio (local)

```yaml
active: local

profiles:
  local:
    mode: local
    api: lmstudio-local
    model: "bartowski/Llama-3.3-70B-Instruct-GGUF"
```

### Supported backends

| Preset | Protocol | Default URL | Auth |
|--------|----------|-------------|------|
| `lmstudio-local` | LM Studio native API | `http://localhost:1234` | `$LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | (none) |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `$VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | (none) |
| `generic-local` | OpenAI-compatible | (url required) | `$LM_API_TOKEN` |
| `openrouter-remote` | OpenRouter API | `https://openrouter.ai/api` | `$OPENROUTER_API_KEY` |

### Profile modes

| Mode | Behavior |
|------|----------|
| `local` | Sequential requests to a local server |
| `remote` | Parallel requests, single model via OpenRouter |
| `remote-ensemble` | Parallel requests, three models in parallel, combined report |

### Environment variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | `openrouter-remote` | OpenRouter API key |
| `LM_API_TOKEN` | `lmstudio-local`, `generic-local` | Local server auth token |
| `VLLM_API_KEY` | `vllm-local` | vLLM server auth key |

Auth is auto-detected from environment. Profile fields `api_key` / `api_token` can override with `$OTHER_VAR` or a direct value.

## Skills (auto-discovered)

| Skill | Description |
|-------|-------------|
| **llm-externalizer-usage** | Tool reference, usage patterns, file grouping, advanced parameters, end-to-end workflows |
| **llm-externalizer-config** | Profile management, settings workflow, validation rules, ensemble configuration, troubleshooting |

Skills activate automatically when Claude Code encounters tasks matching their trigger descriptions.

## Commands

| Command | Description |
|---------|-------------|
| `/llm-externalizer:llm-externalizer-discover` | Check health, active profile, model, auth status, context window |
| `/llm-externalizer:llm-externalizer-configure` | Read-only inspector. Shows the current profile table and reminds you to edit `~/.llm-externalizer/settings.yaml` manually to change anything |
| `/llm-externalizer:llm-externalizer-search-existing-implementations` | Scan a codebase for existing implementations of a described feature (FFD-batched PR duplicate check) |
| `/llm-externalizer:llm-externalizer-scan-and-fix` | Two-stage audit — per-file scan (answer_mode=0) + parallel `llm-externalizer-parallel-fixer-agent` subagents (≤15 concurrent) + joined final report |
| `/llm-externalizer:llm-externalizer-scan-and-fix-serially` | Same scan as `scan-and-fix`, but chains into a serial `llm-externalizer-serial-fixer-agent` loop over one aggregated bug list instead of parallel per-report dispatch. Use when fixes mutate shared state or bug order matters |
| `/llm-externalizer:llm-externalizer-fix-report` | Fix findings in ONE already-generated per-file scan report (dispatches one `llm-externalizer-parallel-fixer-agent`). Use when you already have a report and don't want to re-scan |
| `/llm-externalizer:llm-externalizer-fix-found-bugs` | Aggregate unfixed findings across every report under `./reports/llm-externalizer/` (merging ensemble auditors) and fix each one via a fresh `llm-externalizer-serial-fixer-agent` subagent — serial loop, zero parent-context per bug. Pass `@merged-report.md` to scope the loop to one report |

## Plugin Structure

```
llm-externalizer-plugin/
├── .claude-plugin/
│   └── plugin.json               # Plugin manifest
├── .github/
│   └── workflows/
│       └── notify-marketplace.yml # Auto-notify emasoft-plugins on version bump
├── .mcp.json                     # MCP server configuration
├── bin/
│   ├── llm-externalizer          # Standalone MCP server launcher (stdio)
│   └── llm-ext                   # CLI wrapper for Bash-based tool invocation
├── commands/
│   ├── llm-externalizer-configure.md                       # /llm-externalizer:llm-externalizer-configure
│   ├── llm-externalizer-discover.md                        # /llm-externalizer:llm-externalizer-discover
│   ├── llm-externalizer-fix-found-bugs.md                  # /llm-externalizer:llm-externalizer-fix-found-bugs
│   ├── llm-externalizer-fix-report.md                      # /llm-externalizer:llm-externalizer-fix-report
│   ├── llm-externalizer-scan-and-fix-serially.md           # /llm-externalizer:llm-externalizer-scan-and-fix-serially
│   ├── llm-externalizer-scan-and-fix.md                    # /llm-externalizer:llm-externalizer-scan-and-fix
│   └── llm-externalizer-search-existing-implementations.md # /llm-externalizer:llm-externalizer-search-existing-implementations
├── agents/
│   ├── llm-externalizer-serial-fixer-agent.md                 # Opus-class per-bug fixer (dispatched by fix-found-bugs)
│   ├── llm-externalizer-parallel-fixer-agent.md                     # Opus-class per-report fixer (dispatched by scan-and-fix / fix-report)
│   └── llm-externalizer-reviewer-agent.md                  # Sonnet-class reviewer (read-only MCP tools)
├── mcp-server/                   # Bundled TypeScript MCP server
│   ├── src/
│   │   ├── index.ts              # Main server (tool definitions, request handling)
│   │   ├── config.ts             # Settings management, profile loading
│   │   └── cli.ts                # CLI entry point
│   ├── package.json
│   ├── tsconfig.json
│   ├── server.json               # MCP server manifest
│   └── statusline.py             # Status bar script (cross-platform)
├── scripts/                      # All Python, no shell scripts
│   ├── setup.py                  # Build: npm install + npm run build
│   ├── install_statusline.py     # Statusline installer
│   ├── bump_version.py           # Semver bumper for plugin.json
│   ├── fix_found_bugs_helper.py  # Backend for /llm-externalizer:llm-externalizer-fix-found-bugs
│   ├── join_fixer_reports.py     # Merges .fixer.* summaries into one final report
│   ├── validate_fixer_summary.py # Post-flight validator for fixer summaries
│   ├── validate_report.py        # Pre-flight validator for per-file scan reports
│   └── publish.py                # Release pipeline (bump, changelog, tag, push, gh release)
├── skills/
│   ├── llm-externalizer-usage/
│   │   ├── SKILL.md
│   │   ├── references/
│   │   │   ├── tool-reference.md
│   │   │   └── usage-patterns.md
│   │   └── examples/
│   │       └── end-to-end-workflow.md
│   └── llm-externalizer-config/
│       ├── SKILL.md
│       └── references/
│           ├── configuration-guide.md
│           └── profile-templates.md
├── .gitignore
├── LICENSE
└── README.md
```

## Publishing

Releases are created with the `publish.py` script. A pre-push hook acts as a quality gate on every push to main.

### Publish script

```bash
uv run scripts/publish.py              # bump patch (default)
uv run scripts/publish.py --minor      # minor bump
uv run scripts/publish.py --major      # major bump
uv run scripts/publish.py --set 4.0.0  # explicit version
uv run scripts/publish.py --dry-run    # preview without changes
```

The script performs these steps in order:

1. **Bump version** — always bumps (marketplace needs change to detect updates). Syncs to `plugin.json`, `package.json`, `server.json`, `index.ts`
2. **Rebuild dist** — bundles TypeScript with new version
3. **Validate** — build check + CPV plugin validation (0 issues required)
4. **Badges** — updates `README.md` version/build badges
5. **Changelog** — regenerates `CHANGELOG.md` via `git-cliff`
6. **Commit** — commits all version-bumped files
7. **Tag** — creates annotated git tag (`vX.Y.Z`)
8. **Push** — pushes (pre-push hook skips — publish.py already validated)
9. **GitHub release** — creates release via `gh` CLI

## Requirements

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | >= 18 | Build and run MCP server |
| npm | >= 8 | Install dependencies |
| Python | >= 3.12 | Build, statusline, and publishing scripts |
| `uv`/`uvx` | any | Run publish/bump scripts + CPV validation |
| `gh` | any | GitHub releases (publish.py) |
| `git-cliff` | any | Changelog generation (required for publish) |

## Links

- **Marketplace**: [Emasoft/emasoft-plugins](https://github.com/Emasoft/emasoft-plugins)
- **Repository**: [Emasoft/llm-externalizer-plugin](https://github.com/Emasoft/llm-externalizer-plugin)
- **MCP Server Source**: Bundled in `mcp-server/` directory

## License

MIT
