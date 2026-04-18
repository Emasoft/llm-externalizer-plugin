# llm-externalizer

<!--BADGES-START-->
![version](https://img.shields.io/badge/version-9.0.0-blue)
![build](https://img.shields.io/badge/build-passing-brightgreen)
![typescript](https://img.shields.io/badge/typescript-5.x-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)
![marketplace](https://img.shields.io/badge/marketplace-emasoft--plugins-purple)
<!--BADGES-END-->

A Claude Code plugin that offloads bounded LLM tasks (code review, bug fixing, duplicate hunting) to cheaper local or remote models via MCP. Profile-based configuration, ensemble mode, and a serial/parallel fixer pair that keep every report out of the orchestrator context.

> [!NOTE]
> **Marketplace:** this plugin ships in **[`Emasoft/emasoft-plugins`](https://github.com/Emasoft/emasoft-plugins)**. You must add that marketplace to Claude Code before you can install the plugin.

![Cost comparison: Opus $0.84, Sonnet $0.51, Ensemble $0.08](docs/cost_comparison.png)

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Agents](#agents)
- [Configuration](#configuration)
- [MCP tools reference](#mcp-tools-reference)
- [Skills](#skills)
- [Troubleshooting](#troubleshooting)
- [Plugin structure](#plugin-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **7 slash commands** — scan, fix, audit, discover, configure (full list in [Commands](#commands))
- **3 internal agents** — one reviewer + two fixers, dispatched by commands, never invoked directly ([Agents](#agents))
- **Ensemble mode** — three OpenRouter models in parallel, combined report ([Configuration](#configuration))
- **17 MCP tools** — `chat`, `code_task`, `scan_folder`, `compare_files`, `check_references`, `check_imports`, `check_against_specs`, `search_existing_implementations`, `discover`, `reset`, `get_settings`, and OpenRouter model-info helpers ([MCP tools reference](#mcp-tools-reference))
- **Auto-batching** — FFD bin-packing by payload size on every multi-file tool
- **File grouping** — `---GROUP:id---` markers in a file list auto-switch output to one report per group
- **Secret scanning + regex redaction** — abort on leaked credentials; custom `redact_regex` for project-specific patterns
- **File-based output** — results land in `./reports/llm-externalizer/`; only paths flow through the orchestrator context
- **6 backend presets** — LM Studio, Ollama, vLLM, llama.cpp, generic local, OpenRouter

> [!TIP]
> **Why this plugin exists.** Haiku-class subagents cost more and are less capable than routing the same bounded task to Nemotron free tier, a local model, or an OpenRouter ensemble. This plugin is the routing layer.

---

## Requirements

For regular users installing from the marketplace:

- **Claude Code** 2.0+
- **Node.js** ≥ 18 + **npm** — the marketplace install hook rebuilds the bundled MCP server
- **Python** ≥ 3.12 — the install hook runs `scripts/setup.py`; the statusline installer is also Python
- **git** — the scan commands use `git ls-files` + `git rev-parse` for auto-discovery
- **ONE backend** — either:
  - **OpenRouter API key** for remote / ensemble modes, **OR**
  - a **local model server**: LM Studio, Ollama, vLLM, or llama.cpp

> [!NOTE]
> Building from source or opening a PR requires additional tools (`uv`, `gh`, `git-cliff`). See [Contributing → Developer requirements](#developer-requirements) at the bottom of this page.

---

## Quick start

All commands below are **Claude Code CLI** commands — run them in your shell, not inside a Claude Code session. Run `claude plugins --help` for the complete reference of plugin subcommands and options.

### 1. Add the marketplace

```bash
claude plugin marketplace add Emasoft/emasoft-plugins
```

### 2. (optional) Update the marketplace index

```bash
claude plugin marketplace update emasoft-plugins
```

> [!TIP]
> Run this if `claude plugin install` later says *not found* — it refreshes the local marketplace cache.

### 3. Install the plugin

```bash
claude plugin install llm-externalizer@emasoft-plugins
```

Restart Claude Code (or run `/reload-plugins` inside a session) to activate.

### 4. Update the plugin (later)

```bash
claude plugin update llm-externalizer
```

### 5. (optional) Uninstall

```bash
claude plugin uninstall llm-externalizer
```

### How to install from inside Claude Code

Paste the URL of this repository (`https://github.com/Emasoft/llm-externalizer-plugin`) in the prompt and ask Claude to install it for you as a **project**, **local**, or **user** scope plugin.

### Post-install: configure + verify

1. **Configure a backend.** Edit `~/.llm-externalizer/settings.yaml` (created on first install with 4 templates). The fastest path:
   - **Remote ensemble** — set `$OPENROUTER_API_KEY` in your shell (or store it via `/plugin configure llm-externalizer`). The default `remote-ensemble` profile works out of the box.
   - **Local LM Studio** — start LM Studio with a model loaded, then set `active: local` in `settings.yaml`.
   - Full reference: [Configuration](#configuration).

2. **Verify + run** (inside a Claude Code session):
   ```
   /llm-externalizer:llm-externalizer-discover     # prints profile, model, auth, health
   /llm-externalizer:llm-externalizer-scan-and-fix # audit the whole codebase in parallel
   ```

---

## Commands

Overview:

| Command | Purpose |
|---|---|
| `/llm-externalizer:llm-externalizer-discover` | Check service health, active profile, model, auth, context window |
| `/llm-externalizer:llm-externalizer-configure` | Read-only profile inspector |
| `/llm-externalizer:llm-externalizer-search-existing-implementations` | FFD-batched PR duplicate-check |
| `/llm-externalizer:llm-externalizer-scan-and-fix` | Folder scan → per-file reports → parallel fixers (≤15 concurrent) → joined report |
| `/llm-externalizer:llm-externalizer-scan-and-fix-serially` | Same scan phase, but fixes bugs one at a time in a serial loop |
| `/llm-externalizer:llm-externalizer-fix-report` | Fix findings in ONE already-generated scan report |
| `/llm-externalizer:llm-externalizer-fix-found-bugs` | Aggregate unfixed findings across every report and fix them serially |

### `/llm-externalizer:llm-externalizer-discover`

No parameters. Prints active profile, model IDs, API URL, auth-token status, context-window size, concurrency mode, RPS ceiling, service health.

### `/llm-externalizer:llm-externalizer-configure`

No parameters. Read-only — shows the current profile table. To change settings, edit `~/.llm-externalizer/settings.yaml` directly, then call `reset` or restart.

### `/llm-externalizer:llm-externalizer-search-existing-implementations`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `<feature-description>` | positional string | yes | — | Natural-language description of the feature to search for |
| `<codebase-path>` | positional path | yes | — | Root folder to scan (respects `.gitignore` in git repos). Accepts multiple roots |
| `--source-files PATH ...` | repeated | no | — | Reference source files showing what the feature looks like in code. Passed as context per batch; auto-excluded from the scan |
| `--diff PATH` | file path | no | — | Unified-diff file to narrow the scan to changed files. Mutually exclusive with `--base` |
| `--base REF` | git ref | no | auto-detect `origin/HEAD` → `main` → `master` | Auto-generate diff via `git diff <ref>...HEAD`. Mutually exclusive with `--diff` |
| `--max-files N` | integer | no | `10000` | Cap on files scanned — much higher than `scan_folder`'s 2500 (designed for PR-review scans) |
| `--free` | flag | no | off | Use the free Nemotron model. **Warning:** provider logs prompts |

**Output.** One line per file — `NO` or `YES symbol=<name> lines=<a-b>`. Exhaustive, no cap on occurrences.

### `/llm-externalizer:llm-externalizer-scan-and-fix`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `[target]` | positional path | no | **auto-discover whole codebase** | Folder to scan. **If both `[target]` and `--file-list` are omitted, scans the WHOLE codebase**: runs `git rev-parse --show-toplevel` → `git ls-files` → filters docs/examples/fixtures/binaries/lock-files, presents the curated list for confirmation, then treats it as an implicit `--file-list`. Never silently hands a folder to `scan_folder` (would dilute the audit with docs and generated output). On 0 or >1 nested git repos, stops and asks |
| `--file-list PATH` | file path | no | — | `.txt` with ONE absolute path per line, or `---GROUP:<id>---` marker lines. Routes through `code_task`; `[target]` is ignored when set. **Group markers auto-switch `answer_mode` from 0 (per-file) to 1 (per-group)** — lines between `---GROUP:<id>---` and `---/GROUP:<id>---` pack into one LLM request and produce one report per group |
| `--instructions PATH` | `.md` path | no | built-in REAL-BUGS-ONLY rubric | Replaces the default audit rubric. Default rubric forbids flagging missing try/except, null checks, docstrings, or style suggestions — only REAL bugs (logic errors, crashes, security w/ exploit path, resource leaks, data corruption, contract mismatch, local broken refs) |
| `--specs PATH` | `.md` path | no | — | Spec file. Each batch sees source + spec, so references are validated against the authoritative spec. Combinable with `--instructions` |
| `--free` | flag | no | off | Use the free Nemotron model. Lower quality than ensemble; provider logs prompts |
| `--no-secrets` | flag | no | off | **Default: `scan_secrets: true` + `redact_secrets: true`** — any detected API key / token / password is replaced with `[REDACTED:LABEL]` and the scan continues. Opt-out turns off BOTH (skips detection AND redaction); use only after moving secrets to `.env` |
| `--text` | flag | no | off | Include `.md .txt .json .yml .yaml .toml .ini .cfg .conf .xml .html .rst .csv` in the scan. Pair with `--instructions` |

**Behaviour.** Scan → N per-file (or per-group) reports in `./reports/llm-externalizer/` → parallel dispatch (≤15 concurrent) of `llm-externalizer-parallel-fixer-agent` → each writes a `.fixer.`-tagged summary → join script merges into one final report.

### `/llm-externalizer:llm-externalizer-scan-and-fix-serially`

Same parameter set as `scan-and-fix` (scan phase is byte-identical — see that table). The fix phase differs: findings are aggregated into one canonical bug list and fixed one at a time by `llm-externalizer-serial-fixer-agent` (never >1 concurrent Task call).

> [!TIP]
> Use this when fixes mutate shared state (imports, types, schemas, shared mocks) or when bug order matters. For independent per-file fixes, `scan-and-fix` is faster on wall-clock time.

### `/llm-externalizer:llm-externalizer-fix-report`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `@scan-report.md` (or bare path) | positional path | yes | — | Path to ONE already-generated per-file scan report. `@` is stripped; relative paths resolve against `$CLAUDE_PROJECT_DIR`. Paths containing `.fixer.` or `.final-report.` are rejected |

**Behaviour.** Dispatches exactly ONE `llm-externalizer-parallel-fixer-agent` and returns the `.fixer.`-summary path. Use when you already have a report and don't need to re-scan.

### `/llm-externalizer:llm-externalizer-fix-found-bugs`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `@merged-report.md` (or bare path) | positional path | no | aggregate EVERY report under `./reports/llm-externalizer/` | If supplied, scopes aggregation to one merged (`answer_mode=2`) report. If omitted, aggregates every scan report in the reports dir, skipping any with a `.fixer.` sibling (already processed) |

**Behaviour.** Loop until done — fresh `llm-externalizer-serial-fixer-agent` per iteration, each fixing exactly one bug, until none remain or the safety rail trips (`MAX_ITER = max(UNFIXED_START * 2 + 5, 5)` or 2 consecutive no-progress iterations).

---

## Agents

All five agents are **internal** — users dispatch them via slash commands, not directly. Each Task spawn is fresh (zero parent-conversation context); user/project `CLAUDE.md` load the same way they do under `claude -p`. The fixer commands show a two-option menu (Sonnet default, Opus optional) before dispatching; the two fixer variants below exist so the right model is pre-baked and pickable without a `model:` override at call time.

| Agent | Model | Role | Dispatched by |
|---|---|---|---|
| `llm-externalizer-reviewer-agent` | sonnet | Read-only code reviewer. Inherits full tool surface (SERENA, TLDR, Grepika, LSP). Returns only report paths | The `llm-externalizer-scan` skill (`context: fork`) |
| `llm-externalizer-parallel-fixer-sonnet-agent` | sonnet | Verifies and fixes ALL findings in ONE scan report. Stateless; writes a `.fixer.`-tagged summary; dispatched ≤15 in parallel | `scan-and-fix`, `fix-report` — picked when the user chooses **Sonnet** on the menu |
| `llm-externalizer-parallel-fixer-opus-agent` | opus | Same role as the sonnet variant but on Opus | `scan-and-fix`, `fix-report` — picked when the user chooses **Opus** on the menu |
| `llm-externalizer-serial-fixer-sonnet-agent` | sonnet | Fixes exactly ONE bug per invocation from an aggregated bug list. Stateful on disk (mutates the list). Dispatched one at a time | `scan-and-fix-serially`, `fix-found-bugs` — picked when the user chooses **Sonnet** |
| `llm-externalizer-serial-fixer-opus-agent` | opus | Same role as the sonnet variant but on Opus | `scan-and-fix-serially`, `fix-found-bugs` — picked when the user chooses **Opus** |

---

## Configuration

Settings file: `~/.llm-externalizer/settings.yaml`. The `/configure` command is a **read-only inspector** — to change anything, edit the file, save, then restart Claude Code or call the MCP `reset` tool.

> [!NOTE]
> The model IDs shown below are our **recommended defaults** — wise picks for the common cases. You can change any of them in `~/.llm-externalizer/settings.yaml` (model, second_model, third_model, url, api_token). Just restart Claude Code or call the MCP `reset` tool after editing.

### Remote (OpenRouter ensemble — three models)

```yaml
active: remote-ensemble

profiles:
  remote-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model:        "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    third_model:  "qwen/qwen3.6-plus"
    api_key: $OPENROUTER_API_KEY
```

`mode: remote-ensemble` requires **three** model IDs. Every file is reviewed by all three in parallel; you get three independent responses combined into one report. The three defaults above are our recommendation — swap any line to try a different model.

### Remote (OpenRouter single model)

```yaml
active: remote

profiles:
  remote:
    mode: remote
    api: openrouter-remote
    model: "anthropic/claude-sonnet-4"
    api_key: $OPENROUTER_API_KEY
```

### Local (LM Studio — Qwen 3.5 27B)

```yaml
active: local-lmstudio

profiles:
  local-lmstudio:
    mode: local
    api: lmstudio-local
    # macOS (Apple Silicon) — MLX build, much faster than GGUF:
    model: "mlx-community/Qwen3.5-27B-Instruct-4bit"
    # Windows / Linux — GGUF build:
    # model: "bartowski/Qwen3.5-27B-Instruct-GGUF"
```

Start LM Studio, load the model above into the server tab, and `llm-externalizer-discover` will pick it up.

### Local (Ollama)

```yaml
active: local-ollama

profiles:
  local-ollama:
    mode: local
    api: ollama-local
    model: "qwen3.5:27b"
    # url defaults to http://localhost:11434 — override only if Ollama runs on a different host/port:
    # url: "http://192.168.1.42:11434"
    # Ollama normally needs no auth, so api_token is omitted.
```

Pull the model first: `ollama pull qwen3.5:27b`. Then start the Ollama daemon (`ollama serve` or the tray app) and `llm-externalizer-discover` will list it.

### Local (vLLM / llama.cpp)

Same shape as the Ollama block; change `api: ollama-local` to `api: vllm-local` (port 8000, `$VLLM_API_KEY`) or `api: llamacpp-local` (port 8080, no auth). Set the `model:` to whatever model ID your server advertises at its `/v1/models` endpoint.

### Backend presets

| Preset | Protocol | Default URL | Auth |
|---|---|---|---|
| `lmstudio-local` | LM Studio native | `http://localhost:1234` | `$LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | — |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `$VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | — |
| `generic-local` | OpenAI-compatible | (url required) | `$LM_API_TOKEN` |
| `openrouter-remote` | OpenRouter | `https://openrouter.ai/api` | `$OPENROUTER_API_KEY` |

### Profile modes

| Mode | Concurrency | Output |
|---|---|---|
| `local` | sequential | one model |
| `remote` | parallel | one model |
| `remote-ensemble` | parallel | three models, combined report |

### Environment variables

| Variable | Used by |
|---|---|
| `OPENROUTER_API_KEY` | `openrouter-remote` |
| `LM_API_TOKEN` | `lmstudio-local`, `generic-local` |
| `VLLM_API_KEY` | `vllm-local` |

> [!NOTE]
> Auth is auto-detected from shell env. Profile fields `api_key` / `api_token` can override with `$OTHER_VAR` or a direct string. The plugin's `userConfig.openrouter_api_key` stores the key in the system keychain and transparently exports it as `OPENROUTER_API_KEY` — use `/plugin configure llm-externalizer` to set it.

### Optional: statusline

```bash
python3 $CLAUDE_PLUGIN_ROOT/scripts/install_statusline.py
```

Adds model, context usage, and cost stats to the Claude Code status bar.

---

## MCP tools reference

> [!IMPORTANT]
> **Batching** — every multi-file tool packs files into LLM requests of typically **1–5 files each** (FFD bin-packing into ~400 KB batches, or one group per `---GROUP:id---`). The LLM **never** sees the whole set at once; `answer_mode` controls only how reports are organised on disk. If you need cross-file analysis, use `search_existing_implementations` or `check_against_specs` — their per-batch design actually validates against an authoritative reference.

### Analysis tools

| Tool | Purpose |
|---|---|
| `chat` | General-purpose: summarize, compare, translate, generate. `system` persona supported |
| `code_task` | Code-optimized analysis with code-review system prompt. `language` hint supported |
| `scan_folder` | Recursive directory scan, auto-discover files by extension |
| `compare_files` | Pair / batch / git-diff comparison; LLM summarizes differences |
| `check_references` | Auto-resolve local imports, validate symbol references |
| `check_imports` | Two-phase — LLM extracts imports, server verifies each exists |
| `check_against_specs` | Compare sources against a spec file; reports deviations |
| `search_existing_implementations` | FFD-batched duplicate hunt; exhaustive per-file `NO` / `YES symbol=<name> lines=<a-b>` |

### Utility tools

| Tool | Purpose |
|---|---|
| `discover` | Health, profile, model, auth-token status, context window, concurrency |
| `reset` | Soft-restart — waits for running requests, reloads `settings.yaml`, clears caches |
| `get_settings` | Copy `settings.yaml` to output dir for reading (read-only) |
| `or_model_info` / `or_model_info_table` / `or_model_info_json` | OpenRouter model params / pricing / latency / uptime — three output formats |

### answer_mode

| Mode | Name | Output |
|---|---|---|
| `0` | ONE REPORT PER FILE | One `.md` per input file |
| `1` | ONE REPORT PER GROUP | One `.md` per group (explicit `---GROUP:id---` or auto-grouped by folder/language/namespace) |
| `2` | SINGLE REPORT | One merged `.md` |

**Defaults.** `scan_folder` → 0. `chat` / `code_task` / `check_*` / `search_existing_implementations` → 2.

### Ensemble mode (default models)

| Model | Pricing (per 1M tokens) | File-size limit |
|---|---|---|
| `google/gemini-2.5-flash` | $0.15 in / $0.60 out | ≤ 50K lines |
| `x-ai/grok-4.1-fast` | $0.30 in / $0.50 out | ≤ 20K lines |
| `qwen/qwen3.6-plus` | $0.33 in / $1.95 out | ≤ 40K lines |

If a file exceeds a model's limit, that model is excluded and the others run. Local backends run a single model; ensemble is OpenRouter-only.

### Free mode (`free: true`)

Uses `nvidia/nemotron-3-super-120b-a12b:free`. No cost, single model, 262K context.

> [!WARNING]
> **Provider logs prompts on the free tier.** Don't use on proprietary code.

### Rate limiting

Adaptive RPS auto-detected from OpenRouter balance ($1 ≈ 1 RPS, max 500). AIMD adjusts on 429 errors. Up to 200 in-flight. Local backends run sequentially. Check with `discover`.

### Advanced parameters (all content tools)

| Parameter | Default | Description |
|---|---|---|
| `answer_mode` | tool-dependent | Output organisation (table above) |
| `output_dir` | `reports_dev/llm_externalizer/` | Absolute path for reports |
| `max_retries` | 1 | Per-file retries in mode 0. Set 3 for parallel + retry + circuit breaker |
| `redact_regex` | — | JavaScript regex — matches become `[REDACTED:USER_PATTERN]` |
| `scan_secrets` | true | Run the secret detector on every input file before sending to the LLM |
| `redact_secrets` | true | Replace any detected secret with `[REDACTED:LABEL]` instead of aborting. **Paired with `scan_secrets: true` by default** — the slash commands always send both together so the run keeps going. Set both to `false` with `--no-secrets` on the slash-command flags |
| `free` | false | Free Nemotron model |
| `max_payload_kb` | 400 | Max payload per LLM request |

---

## Skills

Two skills activate automatically when Claude Code sees matching triggers:

| Skill | When it fires |
|---|---|
| `llm-externalizer-usage` | Tool reference, usage patterns, file grouping, advanced parameters, end-to-end workflows |
| `llm-externalizer-config` | Profile management, settings workflow, validation rules, ensemble configuration, troubleshooting |

Plus three more skills that drive specific workflows (`llm-externalizer-scan`, `llm-externalizer-free-scan`, `llm-externalizer-or-model-info`).

---

## Troubleshooting

Run `/llm-externalizer:llm-externalizer-discover` first — it prints active profile, model, auth-token status, API URL, and service health. Most problems show up there.

### OpenRouter

| Symptom | Cause / fix |
|---|---|
| `discover` shows `$OPENROUTER_API_KEY (NOT SET)` | The env var is missing from the MCP server's process environment. Set it in your shell (`export OPENROUTER_API_KEY=sk-or-...`) then restart Claude Code, OR set it via `/plugin configure llm-externalizer` (stores in keychain) |
| `discover` shows the token resolved but scans 401 | Key revoked or wrong project. Confirm at <https://openrouter.ai/keys>. Regenerate and re-set |
| `discover` shows the token resolved but all scans 429 | You're out of credits or hit the per-minute RPS ceiling. Check balance at <https://openrouter.ai/activity>. AIMD back-off will recover automatically — just wait |
| Scan fails with `model not found` | The model ID in `settings.yaml` was renamed or deprecated upstream. Look up the current ID at <https://openrouter.ai/models> and update `model:` / `second_model:` / `third_model:` |
| Ensemble report shows only 1-2 models | One of the three exceeded its file-size limit (see [Ensemble mode](#ensemble-mode-default-models)) or the model was temporarily removed. The report still lands — just with fewer sections |
| `plugin configure` asks for the key every time | You're on a system without a usable keychain. Use the shell env var instead: `export OPENROUTER_API_KEY=...` in your shell rc |

### LM Studio

| Symptom | Cause / fix |
|---|---|
| `discover` shows `service offline` | LM Studio isn't running, or its server tab isn't started. Open LM Studio → **Developer** / **Server** tab → **Start Server**. Default port is 1234 |
| Scan times out on every file | The loaded model is too big for your RAM and is swapping. Switch to a smaller quant (`Qwen3.5-27B-Instruct-4bit` instead of `Qwen3.5-27B-Instruct-8bit`), or close other apps |
| `model not loaded` or wrong output | The `model:` string in `settings.yaml` doesn't match the loaded model ID. Check LM Studio's **Server** tab — the model ID it advertises is what you put in `settings.yaml` |
| Structured output errors (`response_format`) | LM Studio older than v0.3.x doesn't support structured output. Update LM Studio to the latest version |
| Wrong default: on Mac you got the GGUF | Use the MLX build for Apple Silicon — much faster. Set `model: "mlx-community/Qwen3.5-27B-Instruct-4bit"`. GGUF is for Windows / Linux |

### Ollama

| Symptom | Cause / fix |
|---|---|
| `discover` shows `service offline` | Ollama daemon isn't running. Start with `ollama serve` (CLI) or launch the Ollama tray app |
| `model not found` | You haven't pulled the model locally. Run `ollama pull qwen3.5:27b` (substitute whatever `model:` you set in `settings.yaml`) |
| Very slow first request | Ollama is loading the model weights. First scan after a cold start is always slower; subsequent requests hit the cache |
| Wrong host / port | Default is `http://localhost:11434`. If Ollama runs elsewhere (remote box, different port), add `url: "http://..."` to the profile |
| Structured output flaky | Ollama's structured-output support varies by model. If JSON-schema calls fail, try a different model that advertises `tools: true` in `ollama list` |

### General

| Symptom | Cause / fix |
|---|---|
| `/llm-externalizer:...` commands don't autocomplete | Plugin not installed or not loaded. Run `claude plugin list` — if `llm-externalizer` is missing, install per [Quick start](#quick-start). If installed, restart Claude Code or `/reload-plugins` |
| `discover` works but scans never produce reports | Check `$CLAUDE_PROJECT_DIR/reports/llm-externalizer/` — reports always land there. If the dir is empty, the scan aborted; look at the last assistant message for the `[FAILED]` reason |
| Pre-scan secret-scan aborts the run | Default is redact-not-abort (secrets are replaced with `[REDACTED:LABEL]` and the scan continues). If you're seeing an abort, you may be on an older plugin version — run `claude plugin update llm-externalizer` |

---

## Plugin structure

<details>
<summary>Expand tree</summary>

```
llm-externalizer-plugin/
├── .claude-plugin/plugin.json     # Plugin manifest
├── .mcp.json                      # MCP server configuration
├── bin/                           # MCP launcher + CLI wrapper
├── commands/                      # 7 slash commands
├── agents/                        # 3 plugin-shipped agents
├── skills/                        # 5 auto-discovered skills
├── rules/                         # Canonical usage rules (bundled for users)
├── mcp-server/                    # Bundled TypeScript MCP server
├── scripts/                       # Python: setup, publish, validators, helpers
└── docs/                          # Cost-comparison image, OpenRouter refs
```

</details>

---

## Contributing

### Developer install (build from source + open a PR)

```bash
# 1. Fork the repo on GitHub: https://github.com/Emasoft/llm-externalizer-plugin/fork
#    Then clone YOUR fork (replace <your-username>):
git clone https://github.com/<your-username>/llm-externalizer-plugin.git
cd llm-externalizer-plugin

# 2. Add the upstream remote so you can pull in new releases:
git remote add upstream https://github.com/Emasoft/llm-externalizer-plugin.git

# 3. Build the bundled MCP server (installs npm deps + compiles TypeScript):
python3 scripts/setup.py

# 4. (optional) Install the plugin locally to test your changes before pushing.
#    Either point Claude Code at your working copy:
claude plugin install "$PWD"
#    …or, if you prefer marketplace flow, install via the marketplace using
#    the CLI commands shown in Quick start above.

# 5. Create a feature branch:
git checkout -b feat/<short-description>

# 6. Hack. Run validation before committing — every PR must pass these gates:
claude plugin validate .
# (optional) also run the CPV remote validator for deeper checks:
uvx --from git+https://github.com/Emasoft/claude-plugins-validation \
    --with pyyaml cpv-remote-validate plugin "$PWD"

# 7. Commit with a Conventional Commit prefix so git-cliff can classify it
#    (feat: / fix: / docs: / refactor: / chore: / BREAKING CHANGE: …).
#    Use `git commit` — NEVER `git push` directly (pre-push hook will refuse).
git commit -m "feat: <what it does>"

# 8. Push YOUR fork and open a PR against Emasoft/llm-externalizer-plugin main:
git push origin feat/<short-description>
gh pr create --repo Emasoft/llm-externalizer-plugin --base main
```

> [!IMPORTANT]
> Direct `git push` is blocked by a process-ancestry pre-push hook. The only path from local commits to the upstream remote is `scripts/publish.py`, which runs **9 mandatory validation gates** before pushing: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `ruff check`, `shellcheck`, `plugin.json` schema, `claude plugin validate`, and the CPV remote validator. All must pass with 0 errors. `publish.py` also uses `git-cliff` to auto-compute the next version from your Conventional Commits and regenerate `CHANGELOG.md`. **For contributors, you only push to YOUR fork — the upstream release is cut by the maintainer via `publish.py`.**

### Developer requirements

Beyond the user requirements above, you'll also need:

- **`uv`** — Python dependency management for plugin scripts (`uv venv --python 3.12`, `uv run …`)
- **`gh`** (GitHub CLI) — for `gh pr create` and the maintainer's `gh release create`
- **`git-cliff`** — used by `scripts/publish.py` to compute the next version and regenerate `CHANGELOG.md` from Conventional Commits

### Release pipeline (maintainer only)

`scripts/publish.py` is the only path from `main` to an upstream tag + GitHub release:

```bash
python3 scripts/publish.py              # auto-bump via git-cliff
python3 scripts/publish.py --patch      # force patch bump
python3 scripts/publish.py --minor      # force minor bump
python3 scripts/publish.py --major      # force major bump
python3 scripts/publish.py --dry-run    # preview (still runs all checks)
python3 scripts/publish.py --check-only # run checks only, no mutations (used by pre-push hook)
```

---

## License

MIT — see [LICENSE](LICENSE).

---

## Links

- Marketplace: [`Emasoft/emasoft-plugins`](https://github.com/Emasoft/emasoft-plugins)
- Source: [`Emasoft/llm-externalizer-plugin`](https://github.com/Emasoft/llm-externalizer-plugin)
- Issues: [github.com/Emasoft/llm-externalizer-plugin/issues](https://github.com/Emasoft/llm-externalizer-plugin/issues)
