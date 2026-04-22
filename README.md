<p align="center">
  <img src="docs/banner.png" alt="LLM-Externalizer — Expand Your Reach" width="860">
</p>

<h1 align="center">llm-externalizer</h1>

<!--BADGES-START-->
<p align="center">
<a href="#"><img alt="version" src="https://img.shields.io/badge/version-9.1.0-blue"></a>
<a href="#"><img alt="build" src="https://img.shields.io/badge/build-passing-brightgreen"></a>
<a href="#"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.x-blue"></a>
<a href="#"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen"></a>
<a href="#"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
<a href="https://github.com/Emasoft/emasoft-plugins"><img alt="marketplace" src="https://img.shields.io/badge/marketplace-emasoft--plugins-purple"></a>
<a href="#"><img alt="platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey"></a>
</p>
<!--BADGES-END-->

<p align="center">
<b>Offload expensive code-scan work to cheap LLMs. Keep the fix loop local in Claude Code.</b>
</p>

---

## What it does

This plugin helps you review a codebase with a cheap model, and then fix the findings with your normal Claude Code session.

The work splits in two halves:

- **The scan** — reading your files and listing what looks wrong (bugs, spec violations, duplicate code, broken imports). This half is sent to an inexpensive model of your choice: a free remote one, a paid remote ensemble of three models, or a local model running on your own machine.
- **The fix** — actually editing the code to resolve each finding. This half stays inside Claude Code and is done by Claude Sonnet or Opus, so you keep the same review-and-approve flow you already use for any edit.

Keeping the fix half local means the expensive model only touches code when it actually needs to. The scan half does all the slow reading work on the cheap side.

<p align="center">
  <img src="docs/cost_comparison.png" alt="Cost comparison per scan: Opus $0.84 — Sonnet $0.51 — Ensemble $0.08" width="720">
</p>

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Plugin commands](#plugin-commands) (`/llm-externalizer:*` — what you type in Claude Code)
- [MCP tools](#mcp-tools) (direct tool calls — for skills, custom agents, scripts)
- [Agents](#agents) (internal, dispatched by commands)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Plugin structure](#plugin-structure)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

```
┌─────────────────────────────────────────────────────────────────────────┐
│  YOUR CLAUDE CODE SESSION (local — Sonnet / Opus / Haiku)               │
│                                                                         │
│   /llm-externalizer:llm-externalizer-scan-and-fix                       │
│        │                                                                │
│        │  1. auto-discover codebase via git ls-files                    │
│        │  2. call MCP tool "scan_folder" or "code_task"  ───────┐       │
│        │                                                        │       │
│        │                                                        ▼       │
│        │           ┌─────────────────────────────────────────────────┐  │
│        │           │  MCP SERVER (bundled with plugin)               │  │
│        │           │                                                 │  │
│        │           │  FFD-batches files into ~400 KB payloads        │  │
│        │           │  Streams each batch to the configured backend:  │  │
│        │           │    • OpenRouter ensemble (3 models in parallel) │  │
│        │           │    • OpenRouter single model                    │  │
│        │           │    • LM Studio / Ollama / vLLM / llama.cpp      │  │
│        │           │    • Nemotron free tier                         │  │
│        │           │                                                 │  │
│        │           │  Writes per-file / per-group / merged reports   │  │
│        │           │  to ./reports/llm-externalizer/*.md             │  │
│        │           └─────────────────────────────────────────────────┘  │
│        │                                                        │       │
│        │  3. receive report paths (only paths — never bodies)   │       │
│        │  4. dispatch FIXER SUBAGENTS (local Claude Sonnet/Opus)        │
│        │       • parallel: up to 15 concurrent, one per report          │
│        │       • serial:   one bug at a time from an aggregated list    │
│        │                                                                │
│        │     EACH FIXER subagent:                                       │
│        │       a. reads ONE report from disk                            │
│        │       b. verifies every finding against the real source        │
│        │       c. rejects false positives / hallucinations              │
│        │       d. applies a minimal Edit only on REAL defects           │
│        │       e. runs the language linter, re-verifies                 │
│        │       f. writes a .fixer.*.md summary                          │
│        │                                                                │
│        │  5. join-script merges all fixer summaries into one report     │
└─────────────────────────────────────────────────────────────────────────┘
```

**One-line summary.** The MCP server is the scan engine; your Claude Code session is the fix engine. Only file paths cross the boundary — the orchestrator context never reads a report body.

---

## Features

- **Scan externalization** — 15 MCP tools for code review, duplicate hunting, import/reference validation, and spec-compliance checks, all backed by a local or remote LLM you choose.
- **Fix loop stays local** — fixes are applied by your Claude Code Sonnet / Opus session, NOT by the external LLM. You get the ensemble's second opinion without giving up editorial control.
- **False-positive-aware fixers** — every fixer subagent runs a verification pass (file-read + flow-trace) before editing. Empirically ~15–30% of ensemble findings are false positives; the fixer rejects them with a typed reason.
- **7 plugin commands** — `/llm-externalizer:llm-externalizer-{discover, configure, search-existing-implementations, scan-and-fix, scan-and-fix-serially, fix-report, fix-found-bugs}`. Full list in [Plugin commands](#plugin-commands).
- **15 MCP tools** — `chat`, `code_task`, `scan_folder`, `compare_files`, `check_references`, `check_imports`, `check_against_specs`, `search_existing_implementations`, `batch_check`, `discover`, `reset`, `get_settings`, `or_model_info{,_table,_json}`. Full list in [MCP tools](#mcp-tools).
- **5 internal agents** — reviewer + 4 fixer variants (parallel/serial × Sonnet/Opus). Dispatched by commands, never invoked directly. See [Agents](#agents).
- **3 backend modes** — `local` (sequential), `remote` (parallel, single model), `remote-ensemble` (parallel, three models → combined report).
- **6 backend presets** — LM Studio, Ollama, vLLM, llama.cpp, generic local, OpenRouter.
- **Auto-batching** — First-Fit-Decreasing bin-packing packs 1–5 files per LLM request (~400 KB per batch). The LLM never sees the whole codebase at once.
- **File grouping** — `---GROUP:<id>---` markers in a file list pack related files into one request and produce one report per group.
- **Secret handling** — `scan_secrets: true + redact_secrets: true` is the default on fix runs. Any detected key / token / password is replaced by `[REDACTED:LABEL]` and the scan continues. Opt-out with `--no-secrets`.
- **File-based output** — every report lands in `./reports/llm-externalizer/`. Only paths flow through the orchestrator context (≤ 200 bytes per report).
- **Cross-platform** — macOS, Linux, Windows. The MCP server is a bundled Node executable; the helper scripts are pure Python 3.12+.

---

## Requirements

> These are the **user** requirements for installing from the marketplace.
> Additional tools for building from source are listed under [Contributing → Developer requirements](#developer-requirements).

| Tool | Minimum | Why |
|---|---|---|
| **Claude Code** | 2.0+ | Host for the plugin |
| **Node.js + npm** | Node ≥ 18 | The install hook rebuilds the bundled MCP server |
| **Python** | ≥ 3.12 | Install hook runs `scripts/setup.py`; statusline is Python |
| **git** | any recent | `git ls-files` / `git rev-parse` drive codebase auto-discovery |
| **ONE backend** | — | Either an OpenRouter API key **or** a local model server (LM Studio, Ollama, vLLM, llama.cpp) |

---

## Install

Every step below is a **single pasteable block**. Run them in your terminal — not inside a Claude Code session.

### 1 · Add the marketplace

<details open>
<summary><b>macOS / Linux</b> (bash / zsh)</summary>

```bash
# Add the marketplace that hosts this plugin
claude plugin marketplace add Emasoft/emasoft-plugins
```
</details>

<details>
<summary><b>Windows</b> (PowerShell)</summary>

```powershell
# Add the marketplace that hosts this plugin
claude plugin marketplace add Emasoft/emasoft-plugins
```
</details>

### 2 · Install the plugin

```bash
# Install llm-externalizer from the Emasoft marketplace
claude plugin install llm-externalizer@emasoft-plugins
```

Then restart Claude Code (or `/reload-plugins` inside a running session).

### 3 · (Later) Update the plugin

```bash
# Pull the newest version published in the marketplace
claude plugin update llm-externalizer@emasoft-plugins
```

### 4 · (Optional) Uninstall

```bash
# Remove the plugin
claude plugin uninstall llm-externalizer@emasoft-plugins
```

### Install from inside Claude Code

If you prefer conversational install, paste this repo URL in Claude and ask it to install the plugin:

```
https://github.com/Emasoft/llm-externalizer-plugin
```

---

## First run

### 1 · Configure a backend

Pick **one** of the following four options.

<details open>
<summary><b>A. OpenRouter (ensemble — recommended for best quality, paid)</b></summary>

Set your OpenRouter key as an environment variable so the MCP server can read it.

<details open>
<summary>macOS / Linux (bash / zsh)</summary>

```bash
# Put this in ~/.zshrc or ~/.bashrc so it persists across sessions
export OPENROUTER_API_KEY="sk-or-v1-..."
```
</details>

<details>
<summary>Windows (PowerShell — persistent)</summary>

```powershell
# Persist for your user account (survives reboot and new terminals)
[Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", "sk-or-v1-...", "User")
```
</details>

<details>
<summary>Windows (cmd.exe — persistent)</summary>

```bat
setx OPENROUTER_API_KEY "sk-or-v1-..."
```
</details>

Alternatively, store it in the Claude Code keychain so it's managed per-plugin:

```bash
# Opens an interactive TUI; paste the key when prompted
claude plugin configure llm-externalizer
```

The default profile `remote-ensemble` works out of the box once the key is set.
</details>

<details>
<summary><b>B. OpenRouter free tier (Nemotron — free, single model)</b></summary>

Same OpenRouter key as option A (any free account works). Switch the active profile to the free one in `~/.llm-externalizer/settings.yaml`:

```yaml
active: remote-free
```

See [Configuration → B. Remote free (Nemotron)](#b-remote-free-nemotron) for the full profile block.

> [!WARNING]
> The free provider logs your prompts. Use only on open-source code.
</details>

<details>
<summary><b>C. LM Studio (local — free, offline)</b></summary>

1. Install LM Studio from <https://lmstudio.ai>, launch it, and load a model.
2. Start the local server: **Developer** → **Server** → **Start Server**.
3. Switch the plugin to the LM Studio profile by editing `settings.yaml` — see [Configuration](#configuration).
</details>

<details>
<summary><b>D. Ollama (local — free, offline)</b></summary>

Pull a model and start the daemon:

```bash
# One-time: pull the model weights (~17 GB for Qwen3.5 27B)
ollama pull qwen3.5:27b

# Start Ollama (or launch the tray app)
ollama serve
```

Then switch the plugin profile to `local-ollama` — see [Configuration](#configuration).
</details>

### 2 · Verify health

Inside Claude Code:

```
/llm-externalizer:llm-externalizer-discover
```

You should see your active profile, model ID, auth status, and `ONLINE`.

### 3 · Run your first scan + fix

```
/llm-externalizer:llm-externalizer-scan-and-fix
```

The command will auto-discover your codebase, present the file list for confirmation, run the scan, then dispatch local Claude fixer subagents that verify each finding before editing.

---

## Plugin commands

Commands are slash-invoked inside Claude Code. The format is `/llm-externalizer:llm-externalizer-<name>`.

| Command | Purpose | Produces |
|---|---|---|
| `/llm-externalizer:llm-externalizer-discover` | Print active profile, model, auth, context window, health | Text summary |
| `/llm-externalizer:llm-externalizer-configure` | Read-only profile inspector (edit `settings.yaml` to change) | Profile table |
| `/llm-externalizer:llm-externalizer-search-existing-implementations` | PR duplicate-check — "is this feature already implemented anywhere?" | Exhaustive `NO` / `YES symbol=<name> lines=<a-b>` per file |
| `/llm-externalizer:llm-externalizer-scan-and-fix` | Scan whole codebase → per-file reports → parallel fixer subagents (≤15 concurrent) → joined report | Per-file scan reports + fixer summaries + joined report |
| `/llm-externalizer:llm-externalizer-scan-and-fix-serially` | Same scan; fixes bugs one at a time in a serial loop (safer when fixes touch shared state) | Per-file reports + canonical bug list + serial fixer summary |
| `/llm-externalizer:llm-externalizer-fix-report` | Dispatch ONE fixer subagent on an already-generated scan report | One `.fixer.`-tagged summary |
| `/llm-externalizer:llm-externalizer-fix-found-bugs` | Aggregate unfixed findings from all reports in `./reports/llm-externalizer/` and fix serially | Canonical bug list + serial summary |

<details>
<summary><b>Parameter reference — click to expand</b></summary>

### `/llm-externalizer:llm-externalizer-discover`
No parameters.

### `/llm-externalizer:llm-externalizer-configure`
No parameters. Read-only; edit `~/.llm-externalizer/settings.yaml` directly then call MCP `reset` or restart.

### `/llm-externalizer:llm-externalizer-search-existing-implementations`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `<feature-description>` | positional string | yes | — | Natural-language description of the feature to search for |
| `<codebase-path>` | positional path | yes | — | Root folder to scan (respects `.gitignore` in git repos). Accepts multiple roots |
| `--source-files <path>...` | repeated | no | — | Reference source files showing the feature. Passed as context per batch; auto-excluded from the scan |
| `--diff <path>` | file path | no | — | Unified-diff file to narrow scope. Mutually exclusive with `--base` |
| `--base <ref>` | git ref | no | auto-detect `origin/HEAD` → `main` → `master` | Auto-generate diff via `git diff <ref>...HEAD` |
| `--max-files <N>` | integer | no | `10000` | File cap — higher than `scan_folder`'s 2500 because duplicate hunts scan the whole codebase |
| `--free` | flag | no | off | Use the free Nemotron model. Provider logs prompts — avoid on proprietary code |

### `/llm-externalizer:llm-externalizer-scan-and-fix`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `[target]` | positional path | no | **auto-discover whole codebase** | If both `[target]` and `--file-list` are omitted: `git rev-parse --show-toplevel` → `git ls-files` → filters docs/examples/fixtures/binaries/lock-files → presents the curated list for confirmation |
| `--file-list <path>` | file path | no | — | `.txt` with ONE absolute path per line, or `---GROUP:<id>---` / `---/GROUP:<id>---` marker lines. `[target]` is ignored when set |
| `--instructions <path>` | `.md` path | no | built-in REAL-BUGS-ONLY rubric | Replaces the default audit rubric |
| `--specs <path>` | `.md` path | no | — | Spec file. Each batch sees source + spec, so refs are validated against the authoritative list |
| `--free` | flag | no | off | Free Nemotron model (provider logs prompts) |
| `--no-secrets` | flag | no | off | **Default is scan+redact.** This flag turns OFF both (no detection, no redaction). Use only after moving secrets to `.env` |
| `--text` | flag | no | off | Include `.md .txt .json .yml .yaml .toml .ini .cfg .conf .xml .html .rst .csv`. Pair with `--instructions` |

### `/llm-externalizer:llm-externalizer-scan-and-fix-serially`
Same parameters as `scan-and-fix`. Fix phase differs: one fixer subagent at a time, one bug at a time.

### `/llm-externalizer:llm-externalizer-fix-report`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `@<scan-report.md>` or bare path | positional path | yes | — | Path to ONE scan report. `@` prefix is stripped. Paths containing `.fixer.` or `.final-report.` are rejected |

### `/llm-externalizer:llm-externalizer-fix-found-bugs`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `@<merged-report.md>` or bare path | positional path | no | aggregate ALL reports in `./reports/llm-externalizer/` | If omitted, every report without a `.fixer.` sibling is aggregated into one canonical bug list |

</details>

---

## MCP tools

These are **direct MCP tool calls** — addressable by skills, custom agents, or scripts as `mcp__plugin_llm-externalizer_llm-externalizer__<tool>`. End users typically don't call these directly; they use the slash commands above. Tools are listed here for advanced users writing custom workflows.

### Analysis tools

| Tool | Purpose |
|---|---|
| `chat` | General-purpose: summarize, compare, translate, generate |
| `code_task` | Code-optimized analysis with code-review system prompt |
| `scan_folder` | Recursive directory scan; auto-discover files by extension |
| `compare_files` | Pair / batch / git-diff comparison; LLM summarizes differences |
| `check_references` | Auto-resolve local imports, validate symbol references |
| `check_imports` | LLM extracts imports; server verifies each exists on disk |
| `check_against_specs` | Compare sources against a spec file; report deviations |
| `search_existing_implementations` | FFD-batched duplicate hunt; exhaustive `NO` / `YES symbol=<name> lines=<a-b>` per file |
| `batch_check` | Multi-file sanity check wrapper |

### Utility tools

| Tool | Purpose |
|---|---|
| `discover` | Health, profile, model, auth-token status, context window, concurrency |
| `reset` | Soft-restart — waits for running requests, reloads `settings.yaml`, clears caches |
| `get_settings` | Copy `settings.yaml` to the output dir for read-only inspection |
| `or_model_info` / `or_model_info_table` / `or_model_info_json` | OpenRouter model params / pricing / latency / uptime — three formats |

### `answer_mode` (every multi-file analysis tool)

| Mode | Name | Output |
|---|---|---|
| `0` | ONE REPORT PER FILE | One `.md` per input file |
| `1` | ONE REPORT PER GROUP | One `.md` per group (explicit `---GROUP:id---` or auto-grouped) |
| `2` | SINGLE REPORT | One merged `.md` |

**Defaults.** `scan_folder` → 0. `chat` / `code_task` / `check_*` / `search_existing_implementations` → 2.

> [!IMPORTANT]
> **Batching.** Every multi-file tool packs files into LLM requests of 1–5 files each (~400 KB per batch). The LLM **never** sees the whole codebase at once — `answer_mode` controls only how reports are organised on disk. For cross-file analysis, use `search_existing_implementations` or `check_against_specs` — their per-batch design actually validates against an authoritative reference.

### Advanced parameters (most tools)

| Parameter | Default | Description |
|---|---|---|
| `output_dir` | `./reports/llm-externalizer/` | Absolute path for reports |
| `max_retries` | `1` | Per-file retries in mode 0. Set `3` for parallel + retry + circuit breaker |
| `redact_regex` | — | JavaScript regex — matches become `[REDACTED:USER_PATTERN]` |
| `scan_secrets` | `true` | Run the secret detector on every input file before sending to the LLM |
| `redact_secrets` | `true` | Replace detected secrets with `[REDACTED:LABEL]` instead of aborting (paired with `scan_secrets`) |
| `free` | `false` | Use the free Nemotron model |
| `max_payload_kb` | `400` | Max payload per LLM request |

---

## Agents

All five agents are **internal** — users dispatch them via slash commands, not directly. Each Task spawn is fresh (zero parent-conversation context); user / project `CLAUDE.md` load the same way they do under `claude -p`. The fixer commands show a two-option menu (**Sonnet default**, **Opus optional**) before dispatching; the four fixer variants below exist so the selected model is pre-baked and callable without a `model:` override.

| Agent | Model | Role | Dispatched by |
|---|---|---|---|
| `llm-externalizer-reviewer-agent` | sonnet | Read-only code reviewer. Inherits full tool surface (SERENA, TLDR, Grepika, LSP). Returns only report paths | The `llm-externalizer-scan` skill |
| `llm-externalizer-parallel-fixer-sonnet-agent` | sonnet | Verifies and fixes ALL findings in ONE scan report. Stateless; writes a `.fixer.`-tagged summary; up to 15 dispatched in parallel | `scan-and-fix`, `fix-report` — when the user picks **Sonnet** on the menu |
| `llm-externalizer-parallel-fixer-opus-agent` | opus | Same role on Opus | `scan-and-fix`, `fix-report` — when the user picks **Opus** |
| `llm-externalizer-serial-fixer-sonnet-agent` | sonnet | Fixes exactly ONE bug per invocation from an aggregated list. Stateful on disk (mutates the list). One at a time | `scan-and-fix-serially`, `fix-found-bugs` — when the user picks **Sonnet** |
| `llm-externalizer-serial-fixer-opus-agent` | opus | Same role on Opus | `scan-and-fix-serially`, `fix-found-bugs` — when the user picks **Opus** |

> [!NOTE]
> **Every fixer agent runs a MANDATORY verification pass** before editing any source file: open the cited line, trace the flow, reject hallucinations / style suggestions / redaction artifacts / already-fixed claims. A no-edit "false-positive" verdict is treated as a SUCCESSFUL outcome.

---

## Configuration

The settings file lives at:

- **macOS / Linux:** `~/.llm-externalizer/settings.yaml`
- **Windows:** `%USERPROFILE%\.llm-externalizer\settings.yaml`

The plugin creates it on first install with four starter profiles. Edit it with any text editor, save, then restart Claude Code — or call the MCP `reset` tool to reload without a restart.

### Profile modes

| Mode | Concurrency | Output |
|---|---|---|
| `local` | sequential | one model |
| `remote` | parallel | one model |
| `remote-ensemble` | parallel | three models, combined report |

### A. Remote ensemble (recommended)

```yaml
# ~/.llm-externalizer/settings.yaml   (or %USERPROFILE%\.llm-externalizer\settings.yaml)
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

Every file is reviewed by all three models in parallel; the report combines their responses. Swap any line to try a different model — see <https://openrouter.ai/models>.

### B. Remote free (Nemotron)

A single call to NVIDIA's free Nemotron tier on OpenRouter. One model, no ensemble, no cost.

```yaml
active: remote-free

profiles:
  remote-free:
    mode: remote
    api: openrouter-remote
    model: "nvidia/nemotron-3-super-120b-a12b:free"
    api_key: $OPENROUTER_API_KEY
```

> [!WARNING]
> **The free tier logs your prompts on the provider side.** Use this only on open-source code or code you don't mind being logged. For proprietary code, use the ensemble (option A) or a local model (options C / D / E).

### C. Local — LM Studio (Qwen 3.5 27B)

```yaml
active: local-lmstudio

profiles:
  local-lmstudio:
    mode: local
    api: lmstudio-local
    # Apple Silicon → use the MLX build (much faster than GGUF):
    model: "mlx-community/Qwen3.5-27B-Instruct-4bit"
    # Windows / Linux → use the GGUF build:
    # model: "bartowski/Qwen3.5-27B-Instruct-GGUF"
```

### D. Local — Ollama

```yaml
active: local-ollama

profiles:
  local-ollama:
    mode: local
    api: ollama-local
    model: "qwen3.5:27b"
    # Default URL is http://localhost:11434 — override only for remote/custom hosts:
    # url: "http://192.168.1.42:11434"
    # Ollama needs no auth, so api_token is omitted.
```

Before first use, pull the model:

```bash
# One-time — downloads ~17 GB of model weights
ollama pull qwen3.5:27b
```

### E. Local — vLLM or llama.cpp

Same shape as the Ollama block; change the `api:` preset:

```yaml
profiles:
  local-vllm:
    mode: local
    api: vllm-local         # default URL: http://localhost:8000 — auth: $VLLM_API_KEY
    model: "Qwen/Qwen3.5-27B-Instruct"

  local-llamacpp:
    mode: local
    api: llamacpp-local     # default URL: http://localhost:8080 — no auth
    model: "Qwen3.5-27B-Instruct"
```

Set `model:` to whatever ID your server advertises at its `/v1/models` endpoint.

### Backend presets

| Preset | Protocol | Default URL | Auth env var |
|---|---|---|---|
| `openrouter-remote` | OpenRouter | `https://openrouter.ai/api` | `OPENROUTER_API_KEY` |
| `lmstudio-local` | LM Studio native | `http://localhost:1234` | `LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | — |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | — |
| `generic-local` | OpenAI-compatible | (url required) | `LM_API_TOKEN` |

### Environment variables

| Variable | Used by |
|---|---|
| `OPENROUTER_API_KEY` | `openrouter-remote` preset |
| `LM_API_TOKEN` | `lmstudio-local`, `generic-local` presets |
| `VLLM_API_KEY` | `vllm-local` preset |

> [!NOTE]
> Auth is auto-detected from shell env at MCP-server startup. Profile fields `api_key` / `api_token` can override with `$OTHER_VAR` or a literal string. The plugin's `userConfig.openrouter_api_key` (set via `claude plugin configure llm-externalizer`) stores the key in the system keychain and transparently exports it as `OPENROUTER_API_KEY`.

### Optional: statusline

Adds model name, context usage, and cost to the Claude Code status bar.

<details>
<summary>macOS / Linux</summary>

```bash
# Install the statusline integration
python3 "$CLAUDE_PLUGIN_ROOT/scripts/install_statusline.py"
```
</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
# Install the statusline integration
python3 "$env:CLAUDE_PLUGIN_ROOT\scripts\install_statusline.py"
```
</details>

---

## Troubleshooting

Run `/llm-externalizer:llm-externalizer-discover` first — the output identifies most problems immediately.

### OpenRouter

| Symptom | Cause / fix |
|---|---|
| `discover` shows `$OPENROUTER_API_KEY (NOT SET)` | Env var missing from the MCP-server process env. Set it in your shell rc and restart Claude Code — OR store it via `claude plugin configure llm-externalizer` |
| Token resolved but scans return 401 | Key revoked or scoped incorrectly. Check <https://openrouter.ai/keys> and regenerate |
| Token resolved but scans return 429 | Out of credits or hit RPS ceiling. Check <https://openrouter.ai/activity>. AIMD back-off recovers automatically — just wait |
| `model not found` | Model ID in `settings.yaml` was renamed / deprecated upstream. Look it up at <https://openrouter.ai/models> |
| Ensemble report shows only 1-2 models | One model exceeded its per-file size limit or was temporarily removed. The report still lands, just with fewer sections |

### LM Studio

| Symptom | Cause / fix |
|---|---|
| `discover` shows `service offline` | LM Studio not running, or its server tab isn't started. **Developer** → **Server** → **Start Server** (default port 1234) |
| Scan times out on every file | Model too big for RAM → swapping. Switch to a smaller quant (e.g. `-4bit` instead of `-8bit`) |
| `model not loaded` / wrong output | `model:` in `settings.yaml` doesn't match the ID LM Studio advertises in its **Server** tab |
| Structured-output errors | Update LM Studio — older versions don't support `response_format: json_schema` |

### Ollama

| Symptom | Cause / fix |
|---|---|
| `discover` shows `service offline` | Ollama daemon not running. Start with `ollama serve` or launch the tray app |
| `model not found` | Model not pulled. Run `ollama pull <model-id>` (the exact ID in `settings.yaml`) |
| Very slow first request | Ollama is loading weights. Subsequent requests hit the cache |
| Wrong host / port | Add `url: "http://..."` to the profile (default is `localhost:11434`) |

### General

| Symptom | Cause / fix |
|---|---|
| `/llm-externalizer:...` commands don't autocomplete | Plugin not installed or not loaded. `claude plugin list` to verify; `/reload-plugins` to re-scan |
| `discover` works but scans produce no reports | Look at the last assistant message for a `[FAILED]` reason — the scan aborted before writing |
| Pre-scan secret detector aborts the run | On current versions (9.0.1+) default is **redact**, not abort. If you see an abort, run `claude plugin update llm-externalizer@emasoft-plugins` |

---

## Plugin structure

<details>
<summary>Expand tree</summary>

```
llm-externalizer-plugin/
├── .claude-plugin/plugin.json     # Plugin manifest
├── .mcp.json                      # MCP server launcher
├── bin/                           # MCP launcher + CLI wrapper
├── commands/                      # 7 slash commands
├── agents/                        # 5 internal agents (reviewer + fixers)
├── skills/                        # 5 auto-discovered skills
├── rules/                         # Canonical usage rules bundled for users
├── mcp-server/                    # Bundled TypeScript MCP server
├── scripts/                       # Python: setup, publish, validators, helpers
└── docs/                          # Banner, cost-comparison image, OpenRouter refs
```

</details>

---

## Contributing

> [!IMPORTANT]
> **The owner-only boundary.** Three things are reserved for the upstream repo owner and **must not** be run by contributors:
> 1. **`scripts/publish.py`** — bumps the plugin version, regenerates `CHANGELOG.md`, tags, and pushes. Version bumps belong to the release manager, not to individual PRs.
> 2. **The `.githooks/pre-push` hook** — this hook exists to force the owner through `publish.py` when pushing to upstream. On a fork, it blocks every normal `git push` and is useless.
> 3. **The `.github/workflows/notify-marketplace.yml` CI** — this workflow notifies the `emasoft-plugins` marketplace that a new release is available. On a fork it would either fail (no `MARKETPLACE_PAT` secret) or try to notify the marketplace about your fork — neither is wanted.
>
> The setup below disables all three on your fork so you can push PRs cleanly.

### Developer requirements

Beyond the user requirements above, you need:

- **`uv`** — Python dependency management (`uv venv --python 3.12`, `uv run ...`)
- **`gh`** (GitHub CLI) — for opening the PR and managing workflows on your fork

### 1 · Fork on GitHub, then clone YOUR fork

```bash
# Fork at https://github.com/Emasoft/llm-externalizer-plugin/fork
# Then clone — replace <your-username>
git clone https://github.com/<your-username>/llm-externalizer-plugin.git
cd llm-externalizer-plugin
```

```bash
# Track upstream so you can pull in new releases later
git remote add upstream https://github.com/Emasoft/llm-externalizer-plugin.git
```

### 2 · Disable owner-only automation on your fork

Do this ONCE, right after cloning, BEFORE your first push. Skipping this step will make your pushes refuse or trigger broken CI runs.

#### 2a · Disable the pre-push hook locally

The repo ships with `core.hooksPath = .githooks` in its committed config. On a fork you need to undo that.

<details open>
<summary><b>macOS / Linux</b> (bash / zsh)</summary>

```bash
# Unset the repo's hooksPath so git uses the default .git/hooks/ (which is empty)
git config --local --unset core.hooksPath
```

```bash
# Verify — should print nothing (no active hooks path)
git config --local --get core.hooksPath
```
</details>

<details>
<summary><b>Windows</b> (PowerShell)</summary>

```powershell
# Unset the repo's hooksPath so git uses the default .git\hooks\ (empty)
git config --local --unset core.hooksPath
```

```powershell
# Verify — should print nothing
git config --local --get core.hooksPath
```
</details>

> The `pre-push` script itself is unchanged on disk (it's tracked in `.githooks/`). You're only telling *your* git not to run it.

#### 2b · Disable GitHub Actions workflows on your fork

The `notify-marketplace.yml` workflow triggers on every push to `main` and needs a `MARKETPLACE_PAT` secret that only the owner has. The `ci.yml` workflow also runs owner-expected gates. Disable both on your fork so PRs don't spam red CI runs.

**Option A — via the `gh` CLI (fastest):**

```bash
# Disable the workflow that notifies the marketplace (owner-only)
gh workflow disable "Notify Marketplace" --repo <your-username>/llm-externalizer-plugin
```

```bash
# (optional) Also disable CI on your fork — the upstream PR will run CI instead
gh workflow disable "CI" --repo <your-username>/llm-externalizer-plugin
```

**Option B — via the GitHub web UI:**

Go to `https://github.com/<your-username>/llm-externalizer-plugin/actions`, click each workflow listed in the left sidebar → **`...`** menu → **Disable workflow**.

**Option C — delete the workflow files on your fork branch (nuclear):**

If you never want these workflows to run anywhere on your fork, commit a deletion to your branch. Don't do this on `main` — it would show up in your PR diff.

```bash
# Only if you really want to remove the workflows from your fork's main.
# This changes the diff — don't include in a PR.
git checkout -b chore/disable-fork-ci
git rm .github/workflows/notify-marketplace.yml .github/workflows/ci.yml
git commit -m "chore: disable owner-only workflows on fork"
```

### 3 · Build the bundled MCP server

```bash
# Installs npm deps and compiles TypeScript
python3 scripts/setup.py
```

### 4 · Install your working copy for local testing

```bash
# Point Claude Code at your cloned checkout
claude plugin install "$PWD"
```

### 5 · Create a feature branch

```bash
git checkout -b feat/<short-description>
```

### 6 · Validate before committing

```bash
# Fast local validation
claude plugin validate .
```

```bash
# (optional) deeper CPV remote validator
uvx --from git+https://github.com/Emasoft/claude-plugins-validation --with pyyaml \
    cpv-remote-validate plugin "$PWD"
```

### 7 · Commit with a Conventional Commit prefix

```bash
# The maintainer's release pipeline uses the prefix to classify changes.
#   feat:  — new feature (minor bump)
#   fix:   — bug fix      (patch bump)
#   docs:  — documentation
#   refactor: / chore:    — other housekeeping
#   BREAKING CHANGE: …    — major bump (body or footer)
git commit -m "feat: <what it does>"
```

> [!CAUTION]
> **Do NOT bump `version` in `plugin.json`, `mcp-server/package.json`, or `pyproject.toml`** in your PR. Do NOT edit `CHANGELOG.md`. Do NOT run `scripts/publish.py`. All version work is done by the maintainer after merge.

### 8 · Push to YOUR fork and open a PR

```bash
# Push the feature branch to your fork
git push origin feat/<short-description>
```

```bash
# Open PR against Emasoft/llm-externalizer-plugin main
gh pr create --repo Emasoft/llm-externalizer-plugin --base main
```

---

### Release pipeline (maintainer only — DO NOT RUN AS A CONTRIBUTOR)

This section documents the commands the upstream maintainer runs after merging PRs. Contributors should ignore it. The pre-push hook on the upstream clone (which contributors disable via step 2a) exists specifically to force these scripts to be used.

Additional maintainer-only tooling:

- **`git-cliff`** — auto-computes the next version and regenerates `CHANGELOG.md` from Conventional Commits (pulled in by `publish.py`)

```bash
# Auto-bump version from Conventional Commits, run all gates, push tag + release
python3 scripts/publish.py
```

```bash
# Force a specific bump
python3 scripts/publish.py --patch
python3 scripts/publish.py --minor
python3 scripts/publish.py --major
```

```bash
# Dry-run preview (still runs all checks)
python3 scripts/publish.py --dry-run
```

```bash
# Used by the pre-push hook — runs checks, exits, no mutations
python3 scripts/publish.py --check-only
```

`publish.py` runs **9 mandatory validation gates** before any tag or push: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `ruff check`, `shellcheck`, `plugin.json` schema, `claude plugin validate`. All must pass with zero errors.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Links

- **Marketplace:** <https://github.com/Emasoft/emasoft-plugins>
- **Source:** <https://github.com/Emasoft/llm-externalizer-plugin>
- **Issues:** <https://github.com/Emasoft/llm-externalizer-plugin/issues>
