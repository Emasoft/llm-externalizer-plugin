<p align="center">
  <img src="docs/banner.png" alt="LLM-Externalizer — Expand Your Reach" width="860">
</p>

# llm-externalizer

<!--BADGES-START-->
<p align="center">
<a href="#"><img alt="version" src="https://img.shields.io/badge/version-14.1.2-blue"></a>
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
  <br><sub><em>Scan target: ~38 KLOC TypeScript repo. Per-run cost on OpenRouter — measured 2026-05.</em></sub>
</p>

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Plugin commands](#plugin-commands) (`/llm-externalizer:*` — what you type in Claude Code)
- [CLI commands](#cli-commands) (direct `llm-ext <command>` calls — for skills, custom agents, scripts)
- [Agents](#agents) (internal, dispatched by commands)
- [Breaking changes in 14.1.0](#breaking-changes-in-1410)
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
│        │  2. run "llm-ext scan-folder" or "llm-ext code-task"  ─┐       │
│        │                                                        │       │
│        │                                                        ▼       │
│        │           ┌─────────────────────────────────────────────────┐  │
│        │           │  BUNDLED CLI ENGINE (llm-ext, in the plugin)    │  │
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
│        │       • dispatch returns an agent id, NOT the fixer's answer;  │
│        │         each fixer runs in the background and reports back     │
│        │         in its own completion notification                     │
│        │                                                                │
│        │     EACH FIXER subagent:                                       │
│        │       a. reads ONE report from disk                            │
│        │       b. verifies every finding against the real source        │
│        │       c. rejects false positives / hallucinations              │
│        │       d. applies a minimal Edit only on REAL defects           │
│        │       e. runs the language linter, re-verifies                 │
│        │       f. writes a .fixer.*.md summary                          │
│        │                                                                │
│        │  4b. AWAIT every fixer's completion notification               │
│        │  5. join-script merges all fixer summaries into one report     │
└─────────────────────────────────────────────────────────────────────────┘
```

**One-line summary.** The `llm-ext` CLI is the scan engine; your Claude Code session is the fix engine. Only file paths cross the boundary — the orchestrator context never reads a report body.

---

## Features

- **Interactive setup wizard** (`/llm-externalizer:llm-externalizer-setup`, since v9.6.0) — detects your platform (OS, arch, RAM, GPU), finds installed runners (Ollama, LM Studio, vLLM, llama.cpp, Jan), helps download a Hugging Face model with the `hf` CLI, runs five calibrated compatibility tests on the chosen model, and emits a paste-ready `settings.yaml` profile snippet via a stdlib-only generator (`scripts/setup/build-snippet.py`). The wizard NEVER writes to your `settings.yaml` — user-only-configuration policy.
- **Scan externalization** — 52 CLI commands for code review, duplicate hunting, import/reference validation, spec-compliance checks, bulk LLM-driven structured-output extraction (mass-scouting), full-sentence meaning-equivalence clustering (`cluster-synonyms`), size-bounded summarization (`summarize`), topic/keyword extraction (`topics`), semantic phrase deduplication (`sem-deduplicate`), concise file characterization (`describe`), injection-hardened security triage (`security-scan`), a $0 delegate mode (`review-plan`) where the host agent reviews with its own model, layered per-path review rules (`rules-check` debugs which rule fires), and diff-mode scoping on every review tool (`--diff_workspace`, `--diff_from/--diff_to`, `--diff_commit` — git-delegated, hunks carry enclosing-function context), all backed by a local or remote LLM you choose.
- **Dry-run everything before paying** — `--estimate` predicts a run's cost (expected + hard ceiling, self-calibrating from recorded usage) and `--preview` lists exactly which files would be scanned and WHY each exclusion happened; both compose, both send nothing.
- **Fix loop stays local** — fixes are applied by your Claude Code Sonnet / Opus session, NOT by the external LLM. You get the ensemble's second opinion without giving up editorial control.
- **False-positive-aware fixers** — every fixer subagent runs a verification pass (file-read + flow-trace) before editing. Empirically ~15–30% of ensemble findings are false positives; the fixer rejects them with a typed reason.
- **25 plugin commands** — 23 base (`setup`, `discover`, `reset`, `configure`, `change-model`, `install-statusline`, `update-all`, `benchmark`, `bench-free-pool`, `assess-model`, `check-model-health`, `discover-new-models`, `security-triage-benchmark`, `search-existing-benchmark`, `auto-replace`, `search-existing-implementations`, `cluster-synonyms`, `scan-and-fix`, `scan-and-fix-serially`, `fix-report`, `fix-found-bugs`, `high-quality-scan`, `high-quality-scan-and-fix`) + 1 mass-scout dispatcher (`mass-scout` — all 16 pipeline actions via an action word, e.g. `/llm-externalizer:llm-externalizer-mass-scout search …`; the per-action `mass-scout-*` slash commands were removed in v13.5.9, the `llm-ext mass-scout-*` CLI subcommands are unchanged) + 1 dedicated security tool (`security-scan`). Full list in [Plugin commands](#plugin-commands). Note: `/llm-externalizer:llm-externalizer-change-model` is a *user-only* redirect — it shows your current config (`discover`/`get-settings`) and guides you to edit `~/.llm-externalizer/settings.yaml` by hand, then reload via `reset`. There is no `change-model` or `set-settings` CLI command (the CLI is read-only by design). Model / profile changes always go through editing `~/.llm-externalizer/settings.yaml` (or running the setup wizard above).
- **52 CLI commands** — 27 core/utility (`chat`, `code-task`, `scan-folder`, `high-quality-scan`, `compare-files`, `check-references`, `check-imports`, `check-against-specs`, `search-existing-implementations`, `cluster-synonyms`, `summarize`, `topics`, `sem-deduplicate`, `describe`, `batch-check`, `review-plan`, `rules-check`, `discover`, `reset`, `get-settings`, `profile`, `list-profiles`, `session-summary`, `scan-local-llm-services`, `or-model-info`, `or-model-info-table`, `or-model-info-json`) + 16 mass-scout (`mass-scout-register`, `mass-scout-preclassify`, `mass-scout-estimate`, `mass-scout`, `mass-scout-search`, `mass-scout-search-xjob`, `mass-scout-get`, `mass-scout-export`, `mass-scout-jobs-list`, `mass-scout-audit-sample`, `mass-scout-body-get`, `mass-scout-build-fieldset`, `mass-scout-propose-fieldset`, `mass-scout-list-bundled-fieldsets`, `mass-scout-diff`, `mass-scout-chain`) + 9 security / model-qualification (`security-scan`, `security-triage-benchmark`, `search-existing-benchmark`, `assess-model`, `check-model-health`, `discover-new-models`, `check-tool-replacements`, `calibrate-model`, `calibration-status`). The CLI is **read-only by design** — there are no `set-settings`, `change-model`, `fix-code`, `batch-fix`, `merge-files`, `split-file`, `revert-file`, or `custom-prompt` commands (configuration is user-only; `custom_prompt` was merged into `chat`). The `max_retries: 3` parameter on per-file commands (chat/code-task/scan-folder) replaces the older `batch-check` workflow (parallel execution + exponential backoff + circuit breaker); `batch-check` itself is DEPRECATED.
- **6 internal agents** — setup wizard + reviewer + 4 fixer variants (parallel/serial × Sonnet/Opus). The setup-agent ships with five preloaded Hugging Face helper skills (`huggingface-best`, `huggingface-local-models`, `huggingface-mlx-models`, `hf-cli`, `huggingface-community-evals`) — all marked `user-invocable: false`. See [Agents](#agents).
- **3 backend modes** — `local` (sequential), `remote` (parallel, single model), `remote-ensemble` (parallel, three models → combined report).
- **8 backend presets** — LM Studio, Ollama, vLLM, llama.cpp, Locals (MLX, macOS), generic local, OpenRouter, chat.b.ai.
- **Auto-batching** — First-Fit-Decreasing bin-packing packs 1–5 files per LLM request (~400 KB per batch). The LLM never sees the whole codebase at once.
- **File grouping** — `---GROUP:<id>---` markers in a file list pack related files into one request and produce one report per group.
- **Secret handling** — every file is run through the pre-scan secret detector (`scan_secrets: true`) before it leaves your machine, and any hit is rewritten to `[REDACTED:LABEL]` (`redact_secrets: true`) so the scan still completes on partially-dirty inputs. The detector's `SECRET_PATTERNS` set now includes wildcard variants for the common API-key shapes (`sk-…`, `gho_…`, `aws_…`, etc.) and prefix-bearing tokens, so accidental leaks via `.env`, fixtures, or stale comments are caught and silently masked instead of being shipped to the remote LLM. Opt out per run with `--no-secrets` only after you have moved secrets to a gitignored `.env`.
- **File-based output** — every report lands in `./reports/llm-externalizer/`. Only paths flow through the orchestrator context (≤ 200 bytes per report).
- **Cross-platform** — macOS, Linux, Windows. `llm-ext` is a bundled Node executable; the helper scripts are pure Python 3.12+.

---

## Requirements

> These are the **user** requirements for installing from the marketplace.
> Additional tools for building from source are listed under [Contributing → Developer requirements](#developer-requirements).

| Tool | Minimum | Why |
|---|---|---|
| **Claude Code** | 2.0+ | Host for the plugin |
| **Node.js + npm** | Node ≥ 18 | The install hook rebuilds the bundled `llm-ext` CLI |
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

Claude Code 2.1.221+ activates a newly installed plugin immediately when it is safe to do so, and
2.1.232 refreshes the marketplace as part of the install — so neither a restart nor a manual
marketplace update is normally required. If the commands do not show up, `/reload-plugins`.

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

### Global `llm-ext` command

Claude Code puts a plugin's `bin/` on `PATH` only inside its own sessions, so `llm-ext` in a plain
terminal would otherwise be "command not found". A `SessionStart` hook (matcher `startup|resume`)
installs or refreshes a small POSIX-`sh` wrapper at `~/.local/bin/llm-ext` every time a Claude Code
session starts or resumes. The wrapper resolves the real CLI at run time — first the current
session's own plugin `bin/` if one is on `PATH`, otherwise the user-scope install path Claude Code
recorded in `installed_plugins.json` — so it keeps working across plugin updates without going stale
like a symlink into a version-specific cache dir would.

- **Opt out:** set `LLM_EXT_NO_PATH_SHIM=1` — either in the `env` block of `~/.claude/settings.json`,
  or exported in your shell before starting Claude Code — to turn the hook off entirely.
- **Uninstalling the plugin** does not remove `~/.local/bin/llm-ext`. It fails loudly instead
  rather than silently doing nothing: with no user-scope record left, the wrapper exits with
  `expected exactly one user-scope llm-externalizer install … found 0 (of 0 …)`;
  delete `~/.local/bin/llm-ext` by hand once you've uninstalled.
- **Project-scope-only installs** make the wrapper fail outside a Claude Code session, since there is
  no user-scope record to fall back to (`llm-ext: expected exactly one user-scope llm-externalizer
  install … found 0 (of N …)`).
- **Two plugin versions installed** (e.g. during an upgrade) may each rewrite `~/.local/bin/llm-ext`
  in turn — harmless, since the wrapper always resolves the current install path at run time rather
  than baking one in.
- **Native Windows** (`cmd.exe`/PowerShell) is skipped — an `sh` script in `~/.local/bin` isn't
  runnable there.

---

## First run

### 0 · Run the setup wizard (recommended)

The fastest path is the bundled interactive wizard:

```
/llm-externalizer:llm-externalizer-setup
```

The wizard inspects your platform (OS, arch, RAM, GPU), looks for installed local-model runners (Ollama, LM Studio, vLLM, llama.cpp, Jan), helps you install one if none is present, downloads a Hugging Face model via the `hf` CLI (installing it on demand), runs five calibrated compatibility tests (smoke / structured output / code understanding / long context / output length), and finishes by printing a ready-to-paste `settings.yaml` profile snippet generated by `scripts/setup/build-snippet.py`. The wizard **never** writes to your `settings.yaml` — it stays user-only by policy. On Apple Silicon the wizard cross-links the [`vllm-metal-setup`](skills/vllm-metal-setup/SKILL.md) and [`vmlx-setup`](skills/vmlx-setup/SKILL.md) skills for MLX-native serving paths.

Manual options A–D below remain fully supported for users who want explicit control over which backend, model, and profile structure to use. Pick one of them if you already know your stack, or skip back here for the wizard if anything goes wrong. For the complete manual path — settings.yaml schema, the per-platform / per-GPU backend matrix, model sizing, and troubleshooting — see [`docs/setup-and-configuration.md`](docs/setup-and-configuration.md).

### 1 · Configure a backend

Pick **one** of the following backends. The four most common are below; vLLM and llama.cpp follow the same shape — see [Configuration → E. Local — vLLM or llama.cpp](#configuration).

<details open>
<summary><b>A. OpenRouter (ensemble — recommended for best quality, paid)</b></summary>

You have **three ways** to give the plugin your OpenRouter key. They are listed in order of preference — the first is **strongly recommended**.

#### 1. Shell environment variable (recommended)

Export `OPENROUTER_API_KEY` in your shell rc file. **Every** consumer in this plugin picks it up automatically: the statusline (🏦 remaining-credit panel), the `llm-ext` CLI, and any subprocess Claude Code spawns. Nothing else to configure.

<details open>
<summary>macOS / Linux (bash / zsh / fish)</summary>

```bash
# Put this in ~/.zshrc, ~/.bashrc, or ~/.config/fish/config.fish
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

#### 2. settings.yaml `api_key` field (supported, not recommended)

You can hard-code the key (or a different env-var reference) in a profile inside `~/.llm-externalizer/settings.yaml`:

```yaml
profiles:
  my-paid-profile:
    mode: remote-ensemble
    api: openrouter-remote
    api_key: sk-or-v1-...        # literal — do NOT commit this file
    # api_key: $MY_CUSTOM_VAR    # or a different env-var name
```

Why this is **not** recommended: the statusline and any other subprocess that does not parse settings.yaml (CLI calls, ad-hoc scripts) will not see the key, so the 🏦 remaining-credit panel stays blank. Also: a literal key in a YAML file is one careless `git add` away from a leak.

#### 3. Claude Code plugin keychain (not functional today — see below)

Store the key in the OS keychain via Claude Code:

```bash
# Opens an interactive TUI; paste the key when prompted
claude plugin configure llm-externalizer
```

The CLI still contains a `CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY` → `OPENROUTER_API_KEY` mapping (`resolveEnvValue()` in `scripts/llm-ext/src/config.ts`), left over from when Claude Code spawned the MCP server directly and injected that variable into it. **That injection no longer happens for this plugin.** `llm-ext` now runs the way every other tool call does — as a plain subprocess spawned via `Bash` — and this plugin's `userConfig` value is not among the variables that reach it.

Verified empirically inside a Bash tool call: `CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY` is unset, while `discover` resolves the key whenever `OPENROUTER_API_KEY` is exported in the shell. Note the narrow shape of that result — *other* plugins' `CLAUDE_PLUGIN_OPTION_*` variables **are** visible in the same environment, so the mechanism is not globally absent and it is not worth debugging as if it were. What is missing is specifically this plugin's key.

**So treat the keychain option as non-functional for the CLI today** — exporting `OPENROUTER_API_KEY` in your shell rc (option 1) is the only reliable way to supply it.

#### Auth precedence

When more than one source is set, the resolution order is:

1. Shell env `OPENROUTER_API_KEY` (or any env var the profile's `api_key` points at via `$VAR` syntax)
2. Literal value in `settings.yaml::profiles.<name>.api_key`
3. Claude Code keychain (`userConfig.openrouter_api_key`) — **does not currently reach the CLI**; see above

The built-in `paid` profile self-populates the best model(s) under the price ceiling once `allow_paid_models: true` is set in `settings.yaml` and (1) or (2) above supplies a key, and benchmarks new candidates in the background within `paid_benchmark_daily_cap_usd` (default $0.50/day).
</details>

<details>
<summary><b>B. OpenRouter free tier (Nemotron — free, single model)</b></summary>

Same OpenRouter key as option A (any free account works). Pass `--profile <name>` for a free static profile you defined, or just omit `--profile` — every call already uses the built-in `free` profile by default.

See [Configuration → B. Remote free (Nemotron)](#b-remote-free-nemotron) for a static-profile example.

> [!WARNING]
> The free provider logs your prompts. Use only on open-source code.
</details>

<details open>
<summary><b>B1. Free by default — the <code>allow_paid_models</code> master switch</b></summary>

**By default, the plugin uses only FREE models — everywhere, in every tool.** The
top-level `allow_paid_models` switch in `settings.yaml` governs all paid spend:

```yaml
allow_paid_models: false      # ← DEFAULT (absent ⟺ false). Zero paid spend.
profiles:
  # ... your profiles, paid models and all ...
```

While `allow_paid_models` is **false** (the default):

- Every **remote (OpenRouter)** STATIC profile is forced to its free pool at
  boot, regardless of the `model` / `second_model` / `third_model` it
  configures. A STATIC profile with **no** `free_models` list and no
  free-provider route now **refuses** with a clear error instead of silently
  borrowing a bundled seed — pin `free_models`, or pass `--profile free` for
  the always-on built-in free profile (see "Built-in dynamic profiles" below).
- **Local** profiles are untouched — they are $0/offline, never "paid".
- Even paid **benchmarks** are refused: `--allow-paid-models-tests` cannot
  override the master switch. One switch = zero paid spend of any kind.
- `discover` reports `Free mode: ON (allow_paid_models=false)` and the actual free
  pool, so you always see what is really running.

Set `allow_paid_models: true` to use paid models (and to benchmark them); the
per-profile `free_only` below then remains an opt-in for a specific profile. This
is a behavior-changing default introduced to make free-tier the safe, zero-config
baseline — flip the switch when you deliberately want to spend.

</details>

<details>
<summary><b>B2. OpenRouter free-only ensemble (zero spend, multiple free models)</b></summary>

Set `free_only: true` on a profile to use ONLY a pool of `:free` models — the
configured `model` / `second_model` / `third_model` are ignored. The top free
models that clear the requirements floor form the ensemble; the rest are the
rate-limit fallback pool. **Every `free_models` entry MUST end with `:free`** —
the validator rejects the profile otherwise, so it can never bill.

**Free mode overrides EVERY tool.** Under `free_only`, the free pool wins over
every per-tool choice — `tool_models:` overrides, each tool's own default, the
ensemble, the rotation fallback, and even the credit-exhaustion fallback all use
only `:free` models. As a hard floor, the server **refuses to send any
non-`:free` model to OpenRouter while free mode is on** (it throws before the
request rather than spend), so a misconfiguration fails fast instead of billing.
This makes `free_only` a reliable zero-spend switch for every session that shares
this `settings.yaml`.

```yaml
# pass --profile my-free-only-profile on the call
profiles:
  my-free-only-profile:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    api_key: $OPENROUTER_API_KEY     # free models still need the key (rate-limited, but $0)
    free_models:
      - "deepseek/deepseek-v4-flash:free"
      - "qwen/qwen3-next-80b-a3b-instruct:free"
      - "openai/gpt-oss-120b:free"
      - "z-ai/glm-4.5-air:free"
      - "meta-llama/llama-3.3-70b-instruct:free"
      - "nvidia/nemotron-3-super-120b-a12b:free"
```

Free models are heavily rate-limited; list several so the ensemble has fallbacks.
A context-window requirements floor drops obviously-unusable free models; the
golden-dataset benchmark filter is the deeper quality gate.

**Daily-limit rotation:** every free provider caps requests *per day*, so when an
ensemble slot's model returns a rate-limit / daily-limit / no-endpoints error, the
ensemble automatically rotates that slot to the next unused free model from the
pool (the ones beyond the top-3) and retries. Parallel slots claim distinct
fallbacks, so two slots never burn the same model's daily quota. List more
`free_models` than the 3 ensemble slots to give the rotation room.

**Benchmark-gate your free pool (`$0` — free models cost nothing to benchmark):**
run the security-triage benchmark on your `free_models`, then the ensemble
automatically excludes any that fail it (the pass/fail is cached in
`~/.llm-externalizer/security-triage-results.json`):

```text
security_triage_benchmark   models: ["deepseek/deepseek-v4-flash:free", "openai/gpt-oss-120b:free", ...]
```

Models never benchmarked stay in (unverified, not excluded); only a *recorded
failure* drops a model.

**Exhausted balance on a paid profile.** There is no automatic switch to free
models: a `402` on a paid profile falls back to the next benchmarked model of
that *same* profile. Once every model in it has failed with a `402` (no
credit), the command exits with the credit error and starts no profile update
(a re-benchmark would get the same `402`). If other failures are mixed in, the
command starts the `paid` profile's update in the background and exits at once
with "no model of the 'paid' profile is working right now; the profile update
is underway in the background and will be finished soon — retry later"; no
command ever waits for an update. Free is never engaged
implicitly — choose it explicitly with `--profile free` or `active: free`.
Consequence: with an exhausted balance, `--profile paid` exits with the credit
error rather than silently switching to free.

> [!WARNING]
> Free providers log your prompts. Use only on open-source code.
</details>

<details>
<summary><b>C. LM Studio (local — free, offline)</b></summary>

1. Install LM Studio from <https://lmstudio.ai>, launch it, and load a model.
2. Start the local server: **Developer** → **Server** → **Start Server**.
3. Switch the plugin to the LM Studio profile by editing `settings.yaml` — see [Configuration](#configuration). On Windows the path is `%USERPROFILE%\.llm-externalizer\settings.yaml`; from WSL2 (editing the Linux-side copy) it's `\\wsl$\Ubuntu\home\<user>\.llm-externalizer\settings.yaml`.
</details>

<details>
<summary><b>D. Ollama (local — free, offline)</b></summary>

Pull a model and start the daemon:

```bash
# One-time: pull the model weights (~17 GB for Qwen3.5 27B at Q4_K_M / 4-bit MLX)
ollama pull qwen3.5:27b

# Start Ollama (or launch the tray app)
ollama serve
```

Then switch the plugin profile to `local-ollama` by editing `~/.llm-externalizer/settings.yaml` — see [Configuration](#configuration). On Windows the path is `%USERPROFILE%\.llm-externalizer\settings.yaml`; from WSL2 use `\\wsl$\Ubuntu\home\<user>\.llm-externalizer\settings.yaml`.
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

### Base commands (18)

| Command | Purpose | Produces |
|---|---|---|
| `/llm-externalizer:llm-externalizer-setup` | Interactive setup wizard — detects platform, installs runner if needed, downloads model, runs five compatibility tests, prints paste-ready profile snippet | `settings.yaml` profile snippet (user pastes manually) |
| `/llm-externalizer:llm-externalizer-discover` | Print active profile, model, auth, context window, health | Text summary |
| `/llm-externalizer:llm-externalizer-reset` | Purge the on-disk caches (model list, concurrency, LM Studio detection) and reset session counters. Every `llm-ext` invocation is already a fresh process — there is nothing to restart and no in-flight calls to wait for | Confirmation line (active profile + model) |
| `/llm-externalizer:llm-externalizer-configure` | Read-only profile inspector (edit `settings.yaml` to change) | Profile table |
| `/llm-externalizer:llm-externalizer-change-model` | User-only redirect — shows the current config (`discover`/`get-settings`), then guides you to edit `~/.llm-externalizer/settings.yaml` by hand and reload via `reset`. There is no `change-model` CLI command; the CLI is read-only | `settings.yaml` edit guidance |
| `/llm-externalizer:llm-externalizer-install-statusline` | Install the bundled multi-tier statusline (credit balance, model, context bar, LLM tokens & cost, git, usage limits) | Updated `settings.json` |
| `/llm-externalizer:llm-externalizer-update-all` | **The whole model refresh in ONE command** — discover the live catalog, requirement-gate every tool, run every benchmark, rank, and atomically write the winners (ensemble + each `tool_models.<tool>` + the `free_models` pool). Defaults to a **provably $0** free-model refresh (incl. the free-models search); `--paid` / `--both` spend under a **hard `--budget-usd` cap** (default $2.00) that aborts *before* the first call if the pre-flight estimate exceeds it. `--dry-run` prints the plan + estimate and spends nothing | Update report + updated `settings.yaml` |
| `/llm-externalizer:llm-externalizer-benchmark` | Run the OpenRouter model-selection harness over your sample to compare candidates | Benchmark report |
| `/llm-externalizer:llm-externalizer-bench-free-pool` | Auto-fill the *benchmark candidate set* from the given `--profile`'s `free_models` (or the bundled `FREE_POOL_SEED`) — one flag instead of N `--include`s. This is a benchmark-candidate seed, not the runtime model-selection fallback described in "Breaking changes in 14.1.0" above — a static profile still refuses at call time if it has no `free_models`; this command just needs *something* to benchmark. Resolves the pool against the live catalog: a configured non-`:free` id is admitted only when the catalog prices it at exactly `$0` (fail-fast otherwise), and zero-cost open-beta models without a `:free` suffix (e.g. `openrouter/owl-alpha`) are auto-discovered into the sweep. Composes with `--security-triage`. The same sweep runs automatically when `free_only` flips ON and the cache has no `:free` entries (TRDD-f1510055, TRDD-WJND1N2W) | Benchmark report (zero-cost) |
| `/llm-externalizer:llm-externalizer-assess-model` | Assess one model against every LLM tool's per-tool requirements (free — no LLM call, just a public catalog fetch); shows per-tool `OK`/`NO` + which qualifying tools also need a benchmark pass | Per-tool requirements table |
| `/llm-externalizer:llm-externalizer-check-model-health` | Self-check the CONFIGURED model(s) of the active profile (free — no LLM call, one public catalog fetch): presence (removed/deprecated), cost drift vs a seeded baseline, and requirements regression per served tool. Advisory only — never changes settings | Health summary + `reports/llm-externalizer/model-health/` report |
| `/llm-externalizer:llm-externalizer-discover-new-models` | Autodiscover models that newly appeared in the OpenRouter catalog since the last run (free — no LLM call, one public catalog fetch); each new id assessed against every tool's requirements. `[qualifying-only]` hides arrivals that fit no tool. Advisory only — never changes settings | Arrivals summary + `reports/llm-externalizer/model-arrivals/` report |
| `/llm-externalizer:llm-externalizer-security-triage-benchmark` | Qualify model(s) for `security_scan` against the labeled golden dataset via the real judge pipeline; recommends the best same-or-cheaper passer (never pricier) | Recommendation + JSON/markdown report |
| `/llm-externalizer:llm-externalizer-search-existing-benchmark` | Qualify model(s) for `search_existing_implementations` against a labeled golden-fixture codebase, scored DETERMINISTICALLY (precision/recall/F1 over known duplicate locations, no LLM judge) by driving the real search-existing pipeline; recommends the best same-or-cheaper passer (never pricier) | Recommendation + JSON/markdown report |
| `/llm-externalizer:llm-externalizer-search-existing-implementations` | PR duplicate-check — "is this feature already implemented anywhere?" | Exhaustive `NO` / `YES symbol=<name> lines=<a-b>` per file |
| `/llm-externalizer:llm-externalizer-cluster-synonyms` | Cluster SENTENCES / short labels by full-sentence meaning equivalence (taxonomy / ontology / label canonicalisation, 10k–1M items). File-in, file-out, zero orchestrator tokens; resumable + budget-capped | `clusters.jsonl` + `clusters_summary.json` + `stats.json` + `checkpoint.sqlite` + counter line |
| `/llm-externalizer:llm-externalizer-compact-session` | Compact ANY Claude Code session transcript to a compaction-style summary at $0. Takes `<project-slug>/<session-id>.jsonl` for another project, a bare session id for this one, or nothing for this project's latest. Incremental — a re-run only summarizes new turns | Report path (nine-section summary, user messages verbatim) |
| `/llm-externalizer:llm-externalizer-scan-and-fix` | Scan whole codebase → per-file reports → parallel fixer subagents (≤15 concurrent, awaited by completion notification) → joined report | Per-file scan reports + fixer summaries + joined report |
| `/llm-externalizer:llm-externalizer-scan-and-fix-serially` | Same scan; fixes bugs one at a time in a serial loop (safer when fixes touch shared state) | Per-file reports + canonical bug list + serial fixer summary |
| `/llm-externalizer:llm-externalizer-high-quality-scan` | Folder scan with ONE strong remote model (default `z-ai/glm-5.2`) at max reasoning + prompt cache, NOT the cheap ensemble. Paid + OpenRouter-only — fails fast on a local backend, `free_only`, or no credit | Per-file scan reports (or merged) |
| `/llm-externalizer:llm-externalizer-high-quality-scan-and-fix` | High-quality scan (above) → parallel **Opus** fixer subagents (≤15) verify and fix each finding in the same run | Per-file reports + Opus fixer summaries + joined report |
| `/llm-externalizer:llm-externalizer-fix-report` | Dispatch ONE fixer subagent on an already-generated scan report | One `.fixer.`-tagged summary |
| `/llm-externalizer:llm-externalizer-fix-found-bugs` | Aggregate unfixed findings from all reports in `./reports/llm-externalizer/` and fix serially | Canonical bug list + serial summary |

### Mass-scout (one dispatcher command, 16 actions)

Since v13.5.9 the whole family lives behind ONE slash command:
`/llm-externalizer:llm-externalizer-mass-scout <action> [flags]` (bare =
the end-to-end scout run). The 15 per-action slash commands
(`…-mass-scout-register`, `…-mass-scout-search`, …) were removed to
unclutter the command menu; every `bin/llm-ext mass-scout-<action>` CLI
subcommand is unchanged. Note the hyphen: the CLI takes
`mass-scout-search`, never `mass-scout search` (the spaced form silently
drops the action word).

| Action | Purpose | Produces |
|---|---|---|
| `register` | Walk a folder / take a file list and store every body in the SQLite cache (honors `.gitignore`; `--git-diff <ref>` for incremental) | Counter line `registered=N already=M skipped_too_big=K …` |
| `preclassify` | Script-only bucket tagger | Counter line per bucket |
| `estimate` | Cost / time / cap-skipped numbers for a fieldset; honors `--budget-usd`; `--live-context` queries OpenRouter for the real provider cap | Numbers + per-bucket breakdown |
| *(bare)* | Run the LLM scout end-to-end; emits progress lines to stderr per file | Markdown report under `reports/mass_scouting/` + counter line |
| `search` | Per-job search (regex bypass / FTS5 / structured / combined) | Hit list (text or `--json`) |
| `search-xjob` | Cross-job federated search | Merged hit list |
| `get` | Print one row by `short_id` (with optional per-job result) | JSON row |
| `export` | Dump every result row of a job to JSONL or CSV under `reports/mass_scouting/` | File path |
| `jobs-list` | Enumerate every job in a DB (fieldset, model, ok/total, cost, started_at). Audit "what scouts already ran here?" before starting a new one | Markdown table (or JSON array with `--json`) |
| `audit-sample` | Pull N random results from a finished job alongside the cached file body — human-trust check that the model understood the files | Markdown samples (or `samples[]` JSON envelope) |
| `body-get` | Print the cached file body for a `short_id`. Lets follow-up agents reason about the file without re-reading from disk | Raw file body to stdout |
| `build-fieldset` | Compose a fieldset JSON from `--field` shorthand tokens (e.g. `name:bool=desc`, `name:enum(a,b,c)=desc`) without hand-writing JSON | Validated fieldset JSON (stdout or `--out` path) |
| `propose-fieldset` | Ask the LLM to propose a fieldset JSON for a natural-language `--goal`, optionally seeded with sample files. Resolves the "what fields do I write?" UX cliff | Validated fieldset JSON (stdout or `--out` path) |
| `list-bundled-fieldsets` | Enumerate the plugin-shipped fieldsets accepted as `--fields-file bundled:<name>` (`code-audit`, `skill-audit`, `security-audit`, `pr-review`) | Markdown list (or `[{name, path, fields}]` JSON) |
| `diff` | Compare two jobs row-by-row → `only_from` / `only_to` / `identical` / `changed` (+ changed-key list). Confirms a re-scout actually changed what you expected | Markdown summary (or structured JSON) |
| `chain` | Run a second scout pass on the subset of a prior job's rows that match a `--filter "$.path:OP:value"` expression, using a fresh fieldset. Drills deeper without re-scouting the whole tree | New job's mass-scout markdown report under `reports/mass_scouting/` + counter line |
| `/llm-externalizer:llm-externalizer-security-scan` | **Injection-hardened** security triage (NOT mass_scout). Adjudicates a batch of `targets[]` (snippet \| file_path+line+context_lines \| path_glob) + per-category rubrics into per-item `{verdict, confidence, reason, injection_observed}`; nonce-delimited envelope + strict json_schema + fail-safe-to-`uncertain` | JSON + markdown report under `reports/llm-externalizer/security_scan/` + counter line |

Bundled fieldsets shipped with the plugin: `code-audit`, `skill-audit`, `security-audit`, `pr-review` (pass as `--fields-file bundled:<name>`). The CLI also exposes every tool as `bin/llm-ext mass-scout-<subcommand>` — see `--help` for the full flag list.

<details>
<summary><b>Parameter reference — click to expand</b></summary>

### `/llm-externalizer:llm-externalizer-discover`
No parameters.

### `/llm-externalizer:llm-externalizer-configure`
No parameters. Read-only; edit `~/.llm-externalizer/settings.yaml` directly then run `llm-ext reset` (or restart).

### `/llm-externalizer:llm-externalizer-search-existing-implementations`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `<feature-description>` | positional string | yes | — | Natural-language description of the feature to search for |
| `<codebase-path>` | positional path | yes | — | Root folder to scan (respects `.gitignore` in git repos). Accepts multiple roots |
| `--source-files <path>...` | repeated | no | — | Reference source files showing the feature. Passed as context per batch; auto-excluded from the scan |
| `--diff <path>` | file path | no | — | Unified-diff file to narrow scope. Mutually exclusive with `--base` |
| `--base <ref>` | git ref | no | auto-detect `origin/HEAD` → `main` → `master` | Auto-generate diff via `git diff <ref>...HEAD` |
| `--max-files <N>` | integer | no | `10000` | File cap — higher than `scan_folder`'s 2500 because duplicate hunts scan the whole codebase |
| `--free` | flag | no | off | Use the selected profile's own first `:free` model, or refuse if it has none. Provider logs prompts — avoid on proprietary code |

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

### `/llm-externalizer:llm-externalizer-setup`
No parameters. Interactive wizard. WSL2 users may pass `--include-wsl2-host` to also probe the Windows side for reachable runners.

### `/llm-externalizer:llm-externalizer-change-model`
No parameters. User-only config helper — prints a paste-ready `settings.yaml` edit, then guides you to save and run `llm-ext reset`. There is no `change-model` CLI command.

### `/llm-externalizer:llm-externalizer-install-statusline`
No parameters. Honors the `REFRESH_INTERVAL` env var (seconds; default `3`) when invoking the underlying installer.

### `/llm-externalizer:llm-externalizer-cluster-synonyms`
Wraps the `cluster-synonyms` command (`bin/llm-ext cluster-synonyms`). Inputs: `input_file` (JSONL of `{id, sentence}`), `output_dir`, optional `embeddings_file`, `policy_file`, `resume_from`.

### `/llm-externalizer:llm-externalizer-update-all`
The entire model pipeline as one command: `llm-ext-benchmark --update-all`. It discovers the live OpenRouter catalog, applies each tool's requirements from the model-qualification registry, runs every tool that HAS a benchmark, ranks the survivors, and atomically writes the winners into `settings.yaml` — the ensemble (`model`/`second_model`/`third_model`), each `tool_models.<tool>`, and the `free_models` pool. It ends with one machine-readable `[OK]`/`[FAILED]` line and a report. **Target profile:** `--profile <name>` > `active:` in `settings.yaml` > the built-in `free` profile. **Cost mode:** if the target profile has `free_only: true`, `--paid`/`--both` are refused before anything runs — that profile is a standing zero-spend guarantee, not a per-run override; pass `--update-all` alone (`--free`, the default), or turn off `free_only` for that profile first. Otherwise, `--free`/`--paid`/`--both` decides what each phase (the ensemble re-pick and every per-tool benchmark) is allowed to spend, all capped by `--budget-usd`.

**Honest gating.** The report labels every tool **benchmark-proven** (a model actually ran that tool's golden dataset and passed) or **requirement-gated** (checked only against cost/context/output/params — *no benchmark exists for that tool yet*). An unbenchmarked tool never reads as if it had been tested.

**Cost.** `--update-all` alone is **$0**: it sweeps only zero-cost models, enforced at the HTTP chokepoint (a priced model is refused *before* the request is sent), and it performs the free-models search that rewrites `free_models`. `--paid`/`--both` spend real money under a hard `--budget-usd` cap (default **$2.00**), enforced twice — a worst-case pre-flight estimate aborts the run before the first call (naming the exact `--budget-usd` that would authorize it), and every individual call is reserved against the cap before it is sent. `--dry-run` prints the full plan and the estimate and spends nothing.

### `/llm-externalizer:llm-externalizer-benchmark`
Runs the OpenRouter model-selection harness (`llm-ext-benchmark`) over your sample. Candidates are pre-ranked at `$0` by two catalog quality indexes — the codex `coding_index` and the design-arena code-categories ELO — before any paid run; `--qualifying-top-n N` caps how many top-ranked candidates are benchmarked (spend control; explicit `--include` baselines are never capped). Zero-cost models without a `:free` suffix (e.g. `openrouter/owl-alpha`) are valid candidates. Use `--assess-model <id>` for the free requirements check, or `--security-triage [--model <id>]` for the judged `security_scan` benchmark. With no `--profile`, the run's cost gate follows `active:` in `settings.yaml` (else the built-in `free` profile) — a non-`free` `active:` lets paid models run.

### `/llm-externalizer:llm-externalizer-assess-model`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `<model-id>` | positional string | yes | — | OpenRouter model id to assess against every LLM tool's per-tool requirements (free — no LLM call, no API key) |

### `/llm-externalizer:llm-externalizer-check-model-health`

No parameters — always inspects the **active** profile from `~/.llm-externalizer/settings.yaml`. Free (no LLM call, one public catalog fetch, no API key). For the main / second / third model and every `tool_models` entry it reports presence (removed/deprecated = **CRITICAL**), cost drift vs the seeded baseline at `~/.llm-externalizer/model-baseline.json` (**WARN**), and per-served-tool requirements regression (**WARN**). Writes a Markdown report to `<project>/reports/llm-externalizer/model-health/`. Advisory only — never changes settings. CLI equivalent: `llm-ext-benchmark --check-health`.

### `/llm-externalizer:llm-externalizer-discover-new-models`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `qualifying-only` | positional flag | no | report all | When present, list only arrivals that meet ≥1 tool's requirements |

Free (no LLM call, one public catalog fetch, no API key). Diffs the live OpenRouter catalog against a seeded snapshot at `~/.llm-externalizer/catalog-snapshot.json`; each NEW model id is assessed against every LLM tool's per-tool requirements. Writes a Markdown report to `<project>/reports/llm-externalizer/model-arrivals/`. First run seeds the snapshot and reports zero arrivals. Advisory only — never changes settings. CLI equivalent: `llm-ext-benchmark --new-arrivals [--qualifying-only]`.

### `/llm-externalizer:llm-externalizer-security-triage-benchmark`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `--model <id>` | string | no | benchmark every candidate | Qualify one model for `security_scan` against the labeled golden dataset via the real judge pipeline. Needs `$OPENROUTER_API_KEY` |

### `/llm-externalizer:llm-externalizer-search-existing-benchmark`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `models=<id,[id...]>` | string | no | auto-discover same-or-cheaper pool | Explicit OpenRouter model id(s) to qualify for `search_existing_implementations`. Needs `$OPENROUTER_API_KEY` |
| `qualifying_top_n=<N>` | number | no | 16 | Cap the auto-discovered candidate pool (cheapest-first) |
| `force` | positional flag | no | use cache | Ignore the per-model-per-day cache and re-run every model |
| `output_dir=<abs path>` | string | no | `<main-root>/reports/llm-externalizer/search-existing-benchmark/` | Report directory |

Qualifies a model for the duplicate-detection task by driving the REAL
search-existing pipeline against a labeled golden-fixture codebase and scoring
DETERMINISTICALLY (precision/recall/F1 over the known duplicate locations — no
LLM judge). Recommends the best same-or-cheaper passer (micro-F1 + micro-recall +
coverage floors); a pricier model is NEVER auto-selected. Advisory only — never
edits source or config. CLI equivalent: `llm-ext-benchmark --search-existing [<id>...] [--force]`.

### `/llm-externalizer:llm-externalizer-auto-replace`

| Parameter | Kind | Required | Default | Meaning |
|---|---|---|---|---|
| `models=<id,[id...]>` | string | no | auto-discover same-or-cheaper pool | Explicit candidate model id(s) forwarded to each benchmark that runs |
| `force` | positional flag | no | only run when degraded | Run every benchmarked tool's benchmark even when its incumbent is NOT degraded (operator audit) |
| `output_dir=<abs path>` | string | no | `<main-root>/reports/llm-externalizer/auto-replace/` | Report directory |

READ-ONLY advisory auto-replacement planner: for every tool that HAS a per-tool
benchmark (`security_scan`, `search_existing_implementations`), checks its
configured model's health against the durable ledger and, when degraded (or with
`force`), runs that tool's benchmark to recommend the best same-or-cheaper
replacement. On a healthy ledger no benchmark runs. This command wraps the
**read-only** `check-tool-replacements` CLI command — it writes a report and
recommends, it **never** rewrites settings. To adopt a recommendation, run the
CLI writer (the sole writer path): `llm-ext-benchmark --auto-replace --apply`
(`--apply` requires `--auto-replace`; run `reset` afterwards; honors `free_only`).
**Target profile:** `--profile <name>` > `active:` in `settings.yaml` > the built-in
`free` profile — with a non-`free` `active:`, paid models can be adopted.

### Mass-scouting parameter notes

The `mass-scout` family runs a cheap LLM (default `qwen/qwen-2.5-7b-instruct`) over hundreds-to-millions of files and extracts a SAME-shape structured payload defined per call. Pipeline: **register → preclassify → estimate → scout → search**. See `skills/llm-externalizer-mass-scouting/SKILL.md` (and its `references/`) for the full walkthrough including the troubleshooting flowchart, worked example, fieldset dialect, and glossary.

Common per-command flag highlights:

- `--db <path>` — required on every mass-scout sub-command. The same SQLite registry is shared across phases.
- `--fields-file <path>` — accepts an absolute path OR a `bundled:<name>` shorthand (`code-audit`, `skill-audit`, `security-audit`, `pr-review`).
- `--budget-usd <usd>` on `estimate` — hard gate; refuses to schedule when the projection exceeds the budget.
- `--live-context` on `estimate` and `mass-scout` — queries OpenRouter for the active provider's real `context_length` and overrides KNOWN_PRICING (the architectural ceiling baked into KNOWN_PRICING is the model's MAX, not the provider's actual cap).
- `--no-smoke-test` on `mass-scout` — skips the 5-file sequential pre-flight that aborts the run early on a broken fieldset.
- `--no-resume` on `mass-scout` — re-process files even if they already have a result row for the `--job-id`.
- `--json` on `search`, `search-xjob`, `get`, `jobs-list`, `audit-sample`, `diff`, `list-bundled-fieldsets` — structured output for downstream scripts.
- Filter syntax for `search` / `search-xjob` / `chain`: `'$.path:OP:value'` where `OP ∈ {=, !=, >, >=, <, <=, LIKE}` (e.g. `'$.is_async:=:true'`, `'$.severity:LIKE:critical%'`).

CLI equivalents are exposed as `bin/llm-ext mass-scout-<subcommand>` for every command — run any one with `--help` for the full flag list.

</details>

---

## CLI commands

These are **direct `llm-ext` calls** — run as `llm-ext <command> [--flag value ...]` (or `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" <command> ...` from a skill/agent/script). End users typically don't call these directly; they use the slash commands above. Commands are listed here for advanced users writing custom workflows.

> **In-depth docs** (`docs/`, on-demand companions to the lean always-loaded `rules/use-llm-externalizer.md`):
> - [`agent-usage-reference.md`](docs/agent-usage-reference.md) — full operational reference: per-tool tables, the batching model, the `answer_mode` explanation, the profile/auth/`tool_models` workflow, usage patterns, safety, constraints.
> - [`tool-use-cases.md`](docs/tool-use-cases.md) — "which tool for which goal?" decision guide; when to pick each tool and what to use instead.
> - [`setup-and-configuration.md`](docs/setup-and-configuration.md) — setup wizard + manual config, the settings.yaml schema, and the per-platform / per-GPU backend matrix (local & remote).

### Analysis tools

| Tool | Purpose |
|---|---|
| `chat` | General-purpose: summarize, compare, translate, generate |
| `code_task` | Code-optimized analysis with code-review system prompt |
| `scan_folder` | Recursive directory scan; auto-discover files by extension |
| `high_quality_scan` | Like `scan_folder` but ONE strong remote model (default `z-ai/glm-5.2`) at max reasoning + prompt cache, not the cheap ensemble. OpenRouter-only and paid by design — fail-fasts on a local backend, `free_only`, or exhausted credit |
| `compare_files` | Pair / batch / git-diff comparison; LLM summarizes differences |
| `check_references` | Auto-resolve local imports, validate symbol references |
| `check_imports` | LLM extracts imports; server verifies each exists on disk |
| `check_against_specs` | Compare sources against a spec file; report deviations |
| `search_existing_implementations` | FFD-batched duplicate hunt; exhaustive `NO` / `YES symbol=<name> lines=<a-b>` per file |
| `cluster_synonyms` | Cluster SENTENCES / short labels by full-sentence meaning equivalence (NOT word-level). File-in, file-out, zero orchestrator tokens; the whole batch+verify+canonicalise loop runs in the server. For taxonomy / ontology / label canonicalisation over 10k–1M items. Resumable from a checkpoint; budget-capped. CLI: `bin/llm-ext cluster-synonyms` |
| `batch_check` | Multi-file sanity check wrapper (DEPRECATED — use `chat` / `code_task` with `answer_mode=0`, `max_retries=3`) |

### Mass-scouting tools (16)

The base 8-tool pipeline plus 8 follow-on tools for fieldset authoring, job introspection, and job-to-job operations.

| Tool | Purpose |
|---|---|
| `mass_scout_register` | Walk a folder / take explicit `file_paths`; cache every body in SQLite (idempotent). Honors `.gitignore` by default; `--git-diff <ref>` for incremental |
| `mass_scout_preclassify` | Script-only bucket tagger (binary / sourcecode / config / documentation / log_to_classify / rules_to_eval / has_frontmatter / unknown) |
| `mass_scout_estimate` | Cost / time / cap-skipped numbers for a fieldset; honors `budget_usd`. `live_context` queries OpenRouter for the real provider cap |
| `mass_scout` | Compile fieldset → JSON Schema → call LLM per file → repair + validate → persist; emits progress lines to stderr per file |
| `mass_scout_search` | Per-job search (regex bypass / FTS5 / structured / combined) |
| `mass_scout_search_xjob` | Cross-job federated search; merges per-job hits by bm25 |
| `mass_scout_get` | Print one row by `short_id` (with optional per-job result) |
| `mass_scout_export` | Dump every result row of a job to JSONL or CSV |
| `mass_scout_jobs_list` | List every scout job in the DB |
| `mass_scout_audit_sample` | Random N result rows from a job for spot-check verification |
| `mass_scout_body_get` | Print the cached file body by `short_id` (what the LLM saw) |
| `mass_scout_build_fieldset` | Compose a fieldset JSON from `name:type=desc` shorthand tokens |
| `mass_scout_propose_fieldset` | LLM authors a fieldset JSON for a natural-language goal + optional sample files |
| `mass_scout_list_bundled_fieldsets` | List the 4 plugin-shipped fieldsets accepted as `bundled:<name>`: code-audit, skill-audit, security-audit, pr-review |
| `mass_scout_diff` | Compare two jobs row-by-row; counts only_in_a / only_in_b / changed (with changed_keys) |
| `mass_scout_chain` | Re-scout the SUBSET of an existing job's results matching a JSON-extract filter, with a fresh fieldset |

The CLI exposes every sub-command as its own hyphenated command, `bin/llm-ext mass-scout-<subcommand>` (e.g. `bin/llm-ext mass-scout-register`) — NOT `mass-scout <subcommand>` with a space; the latter fails fast with `unexpected argument '<subcommand>' (all inputs are named flags)` and exits 1. The grouped spelling `bin/llm-ext scout <action>` (e.g. `scout register`) works too. On the slash-command side, the single `/llm-externalizer:llm-externalizer-mass-scout` dispatcher covers all 16 actions (it folds the action word into the hyphenated CLI subcommand for you). The `llm-externalizer-mass-scouting` skill walks through the full pipeline including the bundled fieldsets, troubleshooting flowchart, and worked example.

### Security tools

| Tool | Purpose |
|---|---|
| `security_scan` | **Dedicated, injection-hardened** security triage for suspected-malicious code. NOT the mass_scout pipeline — a bespoke judge with a nonce-delimited untrusted-data envelope, hardened system prompt, strict json_schema output, in-band injection pre-scan, and fail-safe-to-`uncertain` on every error/deviation. Takes a batch of `targets[]` (inline snippet \| file_path+line+context_lines window \| path_glob) + per-category rubrics; emits per-item `{verdict: threat\|not_threat\|uncertain, confidence, reason, injection_observed}` to a JSON + markdown report. CLI: `bin/llm-ext security-scan`. Env: `$OPENROUTER_API_KEY` (absent ⇒ all verdicts `uncertain`) |

### Utility tools

| Tool | Purpose |
|---|---|
| `discover` | Health, profile, model, auth-token status, context window, concurrency |
| `reset` | Soft-restart — waits for running requests, reloads `settings.yaml`, clears caches |
| `get_settings` | Print the ACTIVE profile's resolved settings to stdout, and copy `settings.yaml` to the output dir for read-only inspection |
| `profile` | Read-only view of the profiles in `settings.yaml` — list, or `--show <name>` for full resolved detail |
| `list_profiles` | Read-only list of every profile in `settings.yaml` (built-in and user-added), with a marker on the active one |
| `session_summary` | Compaction-style summary of a whole Claude Code session, streamed from its JSONL transcript (map-reduce, $0-only free models, checkpointed/resumable) |
| `or_model_info` / `or_model_info_table` / `or_model_info_json` | OpenRouter model params / pricing / latency / uptime — three formats |

### `session_summary` — Claude-Code-compaction-equivalent, $0 by construction

**Why it exists:** Claude Code's own `/compact` burns paid-model tokens summarizing a session
and runs only inside that same session. `session_summary` reproduces the same
compaction-equivalent output — for **any** session, from its `.jsonl` transcript, from a fresh
agent that never held that context — and does it entirely on **free** OpenRouter models, so
compacting an arbitrarily long session costs **$0**.

Pipeline: stream the transcript (never loaded fully into memory) → extract real context (user
turns, assistant text/thinking/tool_use, tool results) while dropping JSONL bookkeeping → prune
(`--prune aggressive|moderate|none`, default `aggressive` — drops tool-result payloads, pasted
file contents, thinking blocks; keeps user/assistant prose, tool names + arg summaries, errors)
→ pack into token-budgeted chunks, **splitting only between turns, never mid-turn** (capped at
50,000 tokens by default, regardless of how large the selected model's own context window is —
quality collapses long before the context LIMIT is reached, especially on free models; override
with `--max-chunk-tokens`) → map (summarize each chunk against a fixed nine-section
compaction schema) → reduce (**deterministically join the chunk summaries in code — no second
LLM pass**, so no fact can be dropped in the merge; recurses when a fold itself overflows the
window). Every chunk/fold is checkpointed, so an interrupted run (e.g. a free daily-quota hit)
resumes automatically on re-run.

**What gets captured / dropped from the transcript:**
- Messages sent **mid-turn** (stored by Claude Code as `type: "queue-operation"`, not
  `type: "user"`) are captured as real user content.
- Machine-injected turns are **excluded**: janitor-heartbeat cron fires, no-visible-output
  nudges, system-reminder-only turns, slash-command plumbing, task notifications, skill-doc
  loads.
- Embedded images (base64 / `data:` URIs) are **dropped at every prune level**, leaving an
  `[image omitted]` marker — a text-only model can't read them, and leaving them in would evict
  real content from the chunk budget for nothing.

**The nine-section schema** each chunk is summarized against (verbatim in the merged report):
`Primary Request and Intent` · `Key Technical Concepts` · `Files and Code Sections` ·
`Errors and Fixes` · `Problem Solving` · `All User Messages` (verbatim — the only section that
copies transcript text) · `Pending Tasks` · `Current Work` · `Next Step`.

Cost safety is structural, not a flag: it only ever selects a free OpenRouter model that has
`text` on both sides of its `architecture.modality` (extra modalities on either side — image,
audio, video — are irrelevant and never disqualify). There is no hard context floor by default —
it always picks the BIGGEST such model available today, whatever that is; pass `--min-context` to
require a hard floor instead (fails if nothing clears it). If the picked model is delisted, stops
being free, exhausts its daily cap, returns an empty/no-text response, or echoes its input back
verbatim instead of summarizing it, mid-run, the run falls back automatically to the next-biggest
eligible model and re-chunks the remaining (unsent) work to its context — already-checkpointed
chunk/fold summaries are untouched. If every eligible model is exhausted this way, the command
exits non-zero rather than reporting a false success.
The kebab-case spelling of a catalog command name is supported, not deprecated:
`session-summary` is the supported CLI spelling of `session_summary`.

| Flag | Purpose |
|---|---|
| `--transcript <path>` | Explicit `.jsonl` transcript path. Wins over `--session-id` and the default. |
| `--session-id <id>` | Resolve a transcript within the current project's `~/.claude/projects/<slug>/` dir. |
| (neither given) | Defaults to the current project's most recent transcript, ranked by the transcript's own last recorded event (not file mtime, which a touch or a mere reopen bumps). |
| `--prune aggressive\|moderate\|none` | Default `aggressive` — drops tool-result payloads, pasted file contents, thinking blocks. |
| `--min-context <n>` | Optional hard floor on eligible model `context_length`. Default: none (biggest available is used). |
| `--max-chunk-tokens <n>` | Override the per-chunk/per-fold token budget. Default: `min(25000, model window budget)` — smaller than the window on purpose, since quality collapses well before the context limit and small chunks parallelize better. |
| `--concurrency <n>` | Chunk requests in flight at once. Default: AUTO — `min(chunkCount, 28)`, so the whole map phase runs in one wave. `1` forces the original sequential behaviour. |
| `--chunk-timeout-s <n>` | Per-ATTEMPT deadline. Default: 600. A backstop against a stalled generation, not a tail-cutter — setting it below the free tier's working band multiplies total time instead of bounding it. |
| `--max-retries-per-chunk <n>` | How many times ONE chunk may be re-attempted on the SAME model. Default: 2 (3 attempts). Covers provider hiccups and rate-limit backoff; a delisted or quota-exhausted model is demoted and replaced regardless of this number. |
| `--until-done` | Retry the whole compaction until it succeeds instead of failing with a resumable checkpoint. Each pass resumes, so completed chunks are never recomputed. Backoff 30s doubling to a 15-min cap; an exhausted daily quota waits for the 00:00 UTC reset instead. Argument errors still fail immediately. |
| `--resume` | Require an existing, matching checkpoint — fails fast instead of silently starting fresh. |
| `--checkpoint <path>` | Override the checkpoint file. Default: derived deterministically from the transcript path under `~/.llm-externalizer/session-summary-checkpoints/`. |
| `--output <path>` | Custom output directory for the summary report. Default: `<main-project-dir>/reports/llm-externalizer/`. |
| `--stdout` | Print the summary TEXT directly to stdout (no report file written; banner/progress still go to stderr). |

**Checkpoint durability.** Each checkpoint is written to a sibling temporary file, then
renamed into place. Process termination leaves the previous complete checkpoint or the new
one, possibly with a leftover temporary file; before the first successful checkpoint there
is no previous checkpoint to resume. No `fsync` is performed, so this does not guarantee
durability across a machine crash or power loss.

**Caller time bounds.** `--chunk-timeout-s` (`--chunk_timeout_s`) limits each attempt, not
total runtime. The observed 91–1478 seconds per chunk on v13.5.0 is historical evidence,
not a current latency guarantee. A caller needing a total-time bound must enforce an external
deadline that ends the process, especially with `--until-done` (`--until_done`), which retries
whole compactions. Resuming still requires the checkpoint and transcript to pass the
command’s normal validation; a bound too short to finish a chunk can repeatedly discard its progress.

**What it reports.** Alongside the model, chunk count and prune ratio, the command prints
the outcome — how much smaller the summary is than the transcript it replaces — to stderr
and embeds the same line in the report header:

```
Size: 2.08 MB (2,179,678 B) transcript → 13.9 KB (14,242 B) summary — 99.35% reduction; pruned to 812 KB before summarizing
```

Exact byte counts sit beside the human-readable sizes deliberately: the human form is what
you read, the raw number is what you compare across runs. A summary that came out larger
than its transcript is reported as such rather than rounded to 0%.

**When the summary must exist no matter what.** By default this command is
checkpoint-and-stop: a chunk gets its retry budget, a dead or quota-capped model is demoted
to the next ranked free one, and when those run out the command fails and tells you to
re-run. Use `--until-done` for unattended runs; wrap it in
`until llm-ext session-summary …; do sleep 60; done` as well if the process itself might be
killed. Both converge for the same reason — the checkpoint makes every pass keep the work
that already landed.

**Worked examples:**

```bash
# (a) Summarize the current project's most recent session — no
#     flags needed, resolves the transcript automatically. Writes a report
#     under reports/llm-externalizer/ and prints its path.
llm-ext session-summary

# (b) Summarize one specific transcript and print the summary text directly
#     (e.g. to pipe into another tool), instead of writing a report file.
llm-ext session-summary \
  --transcript ~/.claude/projects/-Users-me-Code-myproj/3f9c1a2b-....jsonl \
  --stdout

# (c) Resume an interrupted run (e.g. hit a free-model daily quota mid-run) —
#     `--resume` fails fast instead of silently starting over if no matching
#     checkpoint exists yet at the default checkpoint path.
llm-ext session-summary --transcript /path/to/session.jsonl --resume

# (d) Unattended: must produce a summary eventually. Retries the whole
#     compaction, resuming from the checkpoint each pass, and waits for the
#     00:00 UTC reset when the failure is an exhausted daily quota.
llm-ext session-summary --until-done --max-retries-per-chunk 10
```

Verified: `llm-ext session-summary --resume` (no transcript, no checkpoint) fails fast with
`FAILED: session-summary: no transcript directory for this project ...`; `llm-ext
session-summary --transcript /tmp/does-not-exist.jsonl --stdout` fails fast with `FAILED:
session-summary: --transcript path does not exist: ...` — both confirm the flags parse and the
fail-fast paths work without spending any free-tier quota.

### Model-qualification tools

Per-tool model selection (TRDD-f45eeaa0): each LLM tool declares its own
requirements + (optionally) a benchmark; a model serves a tool only if it meets
the requirements **and** passes that tool's benchmark. See
[Configuration § F. Per-tool model overrides](#f-per-tool-model-overrides-advanced).

| Tool | Purpose |
|---|---|
| `assess_model` | Assess ONE model against EVERY LLM tool's per-tool requirements — free: no LLM call, no token cost (just a public catalog fetch, no API key). Per-tool `OK` / `NO` + which qualifying tools also need a benchmark pass |
| `check_model_health` | Self-check the CONFIGURED model(s) of the active profile — free: no LLM call, one public catalog fetch (no API key). Reports presence (removed/deprecated = CRITICAL), cost drift vs a seeded baseline (WARN), and per-served-tool requirements regression (WARN). Advisory only — never writes settings. Writes a report to `reports/model-health/` |
| `discover_new_models` | Autodiscover models that newly appeared in the catalog since the last run — free: no LLM call, one public catalog fetch (no API key). Diffs the live catalog against a seeded snapshot and assesses each new id against every tool's requirements. Advisory only — never writes settings. Writes a report to `reports/model-arrivals/` |
| `check_tool_replacements` | READ-ONLY advisory auto-replacement planner — for every benchmarked tool (`security_scan`, `search_existing_implementations`), checks the incumbent model's ledger health and, when degraded (or with `force`), runs that tool's benchmark to recommend the best same-or-cheaper replacement. On a healthy ledger no benchmark runs. Advisory ONLY — writes a report to `reports/llm-externalizer/auto-replace/` + returns its path; **never** writes settings. Adopt via the CLI `llm-ext-benchmark --auto-replace --apply` (the sole writer path) |
| `calibrate_model` | Queue ONE model of a managed local profile (`server: managed`; `llamacpp-local` or `locals-local`) for calibration and start the detached calibration runner. Returns at once; requests for an uncalibrated model wait (held) until its record exists. A model that already has a record is refused unless `force` is set. CLI: `llm-ext models calibrate --model <id> [--force]` |
| `calibration_status` | Show the calibration state of every model of the managed local profiles: calibrated (with the date), failed (with the step and reason), or its progress and queue state; plus whether the runner is running. CLI: `llm-ext models calibration-status` |
| `security_triage_benchmark` | Qualify model(s) for `security_scan` against the labeled golden dataset, scored via the real judge pipeline; recommends the best same-or-cheaper PASSER (never a pricier model). Cached per-model-per-day. Env: `$OPENROUTER_API_KEY` |

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
| `output_dir` | `<project>/reports/llm-externalizer/` | Absolute path for reports. Default is anchored on `$CLAUDE_PROJECT_DIR` (cwd fallback) — never derived from git. Overridable here or via `$LLM_EXT_OUTPUT_DIR` |
| `max_retries` | `1` | Per-file retries in mode 0. Set `3` for parallel + retry + circuit breaker |
| `redact_regex` | — | JavaScript regex — matches become `[REDACTED:USER_PATTERN]` |
| `scan_secrets` | `true` | Run the secret detector on every input file before sending to the LLM |
| `redact_secrets` | `true` | Replace detected secrets with `[REDACTED:LABEL]` instead of aborting (paired with `scan_secrets`) |
| `free` | `false` | Use the selected profile's own first `:free` model, or refuse if it has none |
| `max_payload_kb` | `400` | Max payload per LLM request |

---

## Agents

All six agents are **internal** — users dispatch them via slash commands, not directly. Each `Agent` spawn is fresh (zero parent-conversation context — which is why the commands never use `subagent_type: "fork"`); user / project `CLAUDE.md` load the same way they do under `claude -p`. The fixer commands show a two-option menu (**Sonnet default**, **Opus optional**) before dispatching; the four fixer variants below exist so the selected model is pre-baked and callable without a `model:` override.

| Agent | Model | Role | Dispatched by |
|---|---|---|---|
| `llm-externalizer-setup-agent` | sonnet | Interactive setup wizard. Detects platform, finds/installs a runner, downloads a Hugging Face model, runs five compatibility tests, emits a paste-ready `settings.yaml` snippet. Preloads five HF helper skills (`huggingface-best`, `huggingface-local-models`, `huggingface-mlx-models`, `hf-cli`, `huggingface-community-evals`) | The `/llm-externalizer-setup` command |
| `llm-externalizer-reviewer-agent` | sonnet | Read-only code reviewer. Inherits full tool surface (`tldr` CLI, no MCP). Returns only report paths | The `llm-externalizer-scan` skill |
| `llm-externalizer-parallel-fixer-sonnet-agent` | sonnet | Verifies and fixes ALL findings in ONE scan report. Stateless; writes a `.fixer.`-tagged summary; up to 15 dispatched in parallel | `scan-and-fix`, `fix-report` — when the user picks **Sonnet** on the menu |
| `llm-externalizer-parallel-fixer-opus-agent` | opus | Same role on Opus | `scan-and-fix`, `fix-report` — when the user picks **Opus** |
| `llm-externalizer-serial-fixer-sonnet-agent` | sonnet | Fixes exactly ONE bug per invocation from an aggregated list. Stateful on disk (mutates the list). One at a time | `scan-and-fix-serially`, `fix-found-bugs` — when the user picks **Sonnet** |
| `llm-externalizer-serial-fixer-opus-agent` | opus | Same role on Opus | `scan-and-fix-serially`, `fix-found-bugs` — when the user picks **Opus** |

> [!NOTE]
> **Every fixer agent runs a MANDATORY verification pass** before editing any source file: open the cited line, trace the flow, reject hallucinations / style suggestions / redaction artifacts / already-fixed claims. A no-edit "false-positive" verdict is treated as a SUCCESSFUL outcome.

---

## Breaking changes in 14.1.0

- **`active:` is a real default-profile pointer again.** Precedence is
  `--profile <name>` > `active: <name>` in `settings.yaml` > the built-in
  `free` profile. `active:` may name any profile, dynamic or static. A fresh
  install writes `active: free`. A dangling `active:` value (naming a
  profile that no longer exists) only errors when it would actually be
  selected — info commands and an explicit `--profile` still run.
- **Three built-in dynamic profiles: `free`, `paid`, `local`.** They are
  generated and refreshed automatically — `free` for the latest free
  OpenRouter models, `paid` for the latest paid OpenRouter models, `local`
  for the llama.cpp / OpenAI-compatible / LM Studio / Ollama endpoints
  detected on this machine. All other profile names are STATIC, hand-written
  by the user (see
  ["Built-in dynamic profiles"](#built-in-dynamic-profiles-free-paid-and-local);
  the retired former placeholder names are in `CHANGELOG.md`).
- **No cross-profile fallback.** On a model failure, llm-ext falls back to
  the next model of the SAME profile only — dynamic profiles in
  benchmark-rating order, static profiles in the listed order. It never
  switches to `free`, `local`, or any other profile: "no switching to free
  models (or local models) must exist anymore. llm-ext must stick to the
  selected profile in `--profile <profile name>` (or free profile if
  omitted). no change of profile must be allowed once the command is
  executed."
- **A STATIC profile no longer auto-falls back to bundled free models.** A
  static profile forced to free mode (`allow_paid_models: false`) with no
  `free_models` and no free-provider route now **refuses** with a clear
  error, instead of silently borrowing `FREE_POOL_SEED`.
- **A dynamic profile's ownership boundary is enforced.** Inside `free`/
  `paid`/`local`, `selection` and `high_quality_model` are yours to edit
  (`paid` also owns `providers`) — every other key is now refused instead of
  silently dropped on the next regeneration (see
  ["Built-in dynamic profiles"](#built-in-dynamic-profiles-free-paid-and-local)).
- **The `paid` profile's price ceiling moved.** The top-level
  `ensemble_price_ceiling_usd_per_million` key is retired — set
  `profiles.paid.selection.price_ceiling_usd_per_million` instead (default
  still $1.3/M, input AND output each `<=` the ceiling). On first boot after
  upgrading, llm-ext moves an existing top-level value there for you and
  deletes the old key; if both are set to different values it leaves the
  file untouched and refuses every command until you delete the top-level
  key by hand.

---

## Configuration

The settings file lives at:

- **macOS / Linux:** `~/.llm-externalizer/settings.yaml`
- **Windows:** `%USERPROFILE%\.llm-externalizer\settings.yaml`
- **WSL2** (Linux side, addressed from Windows): `\\wsl$\Ubuntu\home\<user>\.llm-externalizer\settings.yaml`

The plugin creates it on first install with three built-in DYNAMIC profiles —
`free`, `paid`, and `local` — plus a single `active: free` line pointing at
the default one (see ["Built-in dynamic profiles `free`, `paid`, and
`local`"](#built-in-dynamic-profiles-free-paid-and-local) below). `free`
costs nothing and populates on first use; `paid` stays unpopulated until
`allow_paid_models: true`; `local` populates from whatever compatible
endpoint is detected on this machine. Every other profile name is STATIC —
used exactly as written, never modified by llm-ext. Edit the file with any
text editor, save, then run `llm-ext reset` to purge the caches (a restart
is not required — every CLI call re-reads it fresh anyway).

> [!NOTE]
> The setup wizard uses `scripts/setup/build-snippet.py` to safely quote `settings.yaml` values via stdlib-only logic (no PyYAML at this step) so an attacker who controls a model name or env-var reference cannot trigger arbitrary code execution through a malicious YAML constructor. Documented model IDs are also verified against OpenRouter's live `/v1/models` endpoint by `scripts/publish.py` as a CI gate on every release.

### Built-in dynamic profiles `free`, `paid`, and `local`

Three profile names are **DYNAMIC**: llm-ext owns their `settings.yaml` sections (each
marked `# <-- do not touch, generated by llm-ext -->`), re-generates them as soon as a
change is detected (new/removed OpenRouter models or repriced ones for `free`/`paid`,
new or updated local endpoints for `local`), drops dead or repriced models immediately,
benchmarks newcomers in the background, and keeps the best model per command. A
hand-written `free:`/`paid:`/`local:` block is backed up once to `~/.llm-externalizer/backups/`
(as `settings-before-generated-<name>-<ts>.yaml` from the pick CLI, or
`settings-before-regenerate-<name>-<ts>.yaml` from the dynamic maintainer),
then regenerated. Every other profile name is **STATIC** — created by hand by the user,
used exactly as written, never modified by llm-ext; a failing model in a static profile
fails with the provider error and is never silently replaced by a model from outside the
profile.

**The ownership boundary inside a dynamic profile (14.1.0).** llm-ext rewrites only its
own GENERATED keys (`mode`, `api`, `model`, `free_models`, `tool_models`, etc., one at a
time) — it never touches a subsection you add yourself. As of 14.1.0 every dynamic profile's
USER-OWNED set includes `selection` (auto-pick constraints) and `high_quality_model`; `paid`
additionally owns `providers` (llm-ext writes no provider bindings of its own onto `paid`
today, so it is yours to hand-edit there — `free` and `local` still generate their own
`providers` bindings and refuse a hand-written one). Every owned key survives every
regeneration byte for byte, comments and all. Any OTHER key inside a dynamic profile is
now **refused** at load time rather than silently dropped on the next regeneration — rename
your own hand-picked profile instead of using `free`/`paid`/`local` if you want to choose
every model yourself. The `paid` profile's auto-pick price ceiling (see next section) now
lives inside its `selection` subsection for exactly this reason: it is yours to set, and
llm-ext will never overwrite it.

- **`free`** — OpenRouter `:free` models plus chat.b.ai (`glm-5.3-flash`, a soft-pinned
  ensemble slot when `$BAI_API_KEY` is set). All checks and benchmarks run at $0. This
  is the profile used whenever both `--profile` and `active:` are omitted.
- **`paid`** — paid OpenRouter models. Benchmarking new candidates only happens with
  `allow_paid_models: true`, and only within `paid_benchmark_daily_cap_usd` (default
  `0.50` USD/day; `0` disables paid benchmarking).
- **`local`** — the llama.cpp / OpenAI-compatible / LM Studio / Ollama endpoints
  detected on this machine. Regenerated as soon as a new or updated local endpoint is
  detected.

**Fallback and maintenance.** The command's own path never updates or benchmarks: it
runs whichever profile was selected, and a parallel detached process checks in the
background for changes (new/removed models, changed costs, new/updated local endpoints)
and, if any, spawns another detached process to run the update/scan/benchmark so the
*next* command sees the refreshed pool — the current command never waits on it. A
command may spawn one background change check for its profile, at most once per
minute; a detected change starts one background update, which finishes on its own; no
check or update starts without a command. A single lock per profile (free, paid, local) per config directory (the lock file lives under the config directory, so two different LLM_EXT_CONFIG_DIR values get independent singletons)
guards its change check and its update/benchmark together, so however many commands run
at once, at most one background process per profile is ever doing update/benchmark work
(three total, one per profile) — while a profile's benchmark is running, that profile's
own change check does not start a second process; other profiles are
unaffected. On a model failure, llm-ext falls back to the next model
of the SAME profile: for a dynamic
profile, benchmark-rating order over the written validated list; for a static profile,
the order the user listed. A dynamic profile whose whole validated list has failed
starts its update in the background (unless one is already running, or one finished
less than 30 minutes ago and the model catalog has not changed since) and exits
non-zero at once with "no model of the '<profile>' profile is working right now; the
profile update is underway in the background and will be finished soon — retry
later." The command never waits for the update, and while the profile still has a
working model an update runs without any message. When the failure is one an update
cannot fix, that error is shown instead and no update starts: every model of `paid`
answered `402` (no credit), or the API key was rejected (`401`); a failure specific to
one file (for example a `413` for a file too large for every model) fails only that
file. A static profile whose whole list has failed
exits non-zero with "the models in the selected profile are all failing; retry later or
change the profile." There is no cross-profile fallback in either case.

**Selection.** Precedence is `--profile <name>` > `active: <name>` in `settings.yaml` >
the built-in `free` profile. `active:` is a single line and may name any profile,
dynamic or static; a fresh install writes `active: free`. If `active:` is missing, the
default profile is `free`. A dangling `active:` value (naming a profile that does not
exist) errors only when it would actually be selected — info commands (`llm-ext
settings status` / `settings show`) and an explicit `--profile` still run regardless.
`llm-ext settings status` / `settings show` print `Effective profile: <name> (source:
--profile | active | default)`.

**Honest limits — when a dynamic profile cannot serve a call:**

| Case | What happens |
|---|---|
| `free`: every model unusable this run | exits at once with the retry-later message naming the profile; its update runs in the background |
| `free` unpopulated on a fresh machine (empty `free_models` and a provider credential present) | exits at once with the same retry-later message and starts the update in the background, which writes a first pool within seconds (e.g. the b.ai pinned model when `$BAI_API_KEY` is set) and then benchmarks it; re-run the command shortly after. Nothing waits for it |
| `free` unpopulated with no provider credential, maintenance disabled (`LLM_EXT_DISABLE_AUTO_RECONCILE=1`), or the catalog fetch just failed | refuses immediately, naming that cause — an update cannot fix any of the three any faster |
| `paid` with `allow_paid_models: false` | refuses: `paid profile needs allow_paid_models: true in settings.yaml` |
| `paid` unpopulated and today's benchmark budget is used up | refuses, resumes tomorrow (UTC), or raise `paid_benchmark_daily_cap_usd` |
| `paid`: every paid model returns 402 | refuses: the OpenRouter account has no credit |
| `free` + `mass_scout`/`mass_scout_chain`/`mass_scout_propose_fieldset`/`security_scan`/`high_quality_scan` | refuses by profile **name** (`--profile free`), not by mode — the exact text is `no free model is fit for <tool>; use --profile paid`, with ` (paid models are off: set allow_paid_models: true)` appended while `allow_paid_models` is false. `mass_scout_chain`, `mass_scout_propose_fieldset` and `security_scan` have no fitness benchmark and are always refused; `mass_scout` and `high_quality_scan` are FITNESS-GATED (TRDD-HBCCFOUF): the refusal lifts once the tool's own benchmark (`mass-scout-throughput` / `hq-scan-quality`) has recorded a conclusive PASS for some `:free` model — until then it applies. A STATIC `free_only` profile is **not** refused here — it runs them on its own configured `:free` models, at the user's own risk (that profile is the user's explicit configuration, not the built-in default) |

"Never fails" means: never fails because a *configured* model went away, got
repriced, or started rejecting calls. It cannot manufacture a model when the
provider class itself is down — that is reported plainly, never papered over
with a model from outside the profile.

**Spend and write bounds live per config directory, not per machine.** The paid
daily spend cap (`paid_benchmark_daily_cap_usd`, default `0.50`), the 6-hour floor
between successful sweeps, the failure cooldown, and the lock over the generated
sections are all state under `LLM_EXT_CONFIG_DIR` — running two config dirs on one
machine (or one account) doubles the effective cap, by design. With
`allow_paid_models: true`, **any** dispatch — even one made with `--profile free`
— can spawn the paid benchmark in the background, bounded by that same cap, floor
and cooldown; this is new, observable spend beyond what a `--profile paid` call by
itself would cause. `--apply-profile <name>` on a non-`free_only` profile
similarly authorizes spend, but only behind `allow_paid_models: true` and the
benchmark's own `--allow-paid-models-tests`.

`profiles.free` and `profiles.paid` each have exactly one writer, the dynamic
maintainer: `llm-ext-benchmark --apply-free-pool free`/`paid` and `update-all
--profile free`/`paid` now refuse rather than silently overwrite the generated
section — use `--populate-default-profile <name>` to seed a fresh install's
dynamic profile by hand instead. A STATIC `free_only` profile no longer gets
automatic population of `benchmark-results.json` at boot (the retired background
populator used to do that); `--bench-free-pool` remains the manual path.

**Known limitation, not a feature:** on a machine with only a `chat.b.ai`
credential (no OpenRouter key), the provisional `free` pool boots configured
when the OpenRouter catalog snapshot is EMPTY. Once a catalog is cached from an
earlier run, the pool would mix b.ai and OpenRouter `:free` ids, so the write is
skipped on every dispatch and `free` never populates on that machine — the
gate's own message does not yet name this specific cause.

### Profile modes

| Mode | Concurrency | Output |
|---|---|---|
| `local` | sequential | one model |
| `remote` | parallel | one model |
| `remote-ensemble` | parallel | three models, combined report |

### A. Remote ensemble (recommended)

```yaml
# ~/.llm-externalizer/settings.yaml   (or %USERPROFILE%\.llm-externalizer\settings.yaml)
# pass --profile remote-ensemble on the call, or set active: remote-ensemble

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
# pass --profile remote-free on the call

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
# pass --profile local-lmstudio on the call

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
# pass --profile local-ollama on the call

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
# One-time — downloads ~17 GB of model weights (Q4_K_M / 4-bit MLX)
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

### F. Per-tool model overrides (advanced)

Every LLM-using tool normally runs on the active profile's `model`. You can
override the model **per tool** with an optional `tool_models:` map on a profile.
This lets one backend serve, say, `security_scan` with a cheap small model while
`code_task` uses a stronger one — without juggling multiple active profiles.

```yaml
profiles:
  remote-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model:        "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    third_model:  "qwen/qwen3.6-plus"
    api_key: $OPENROUTER_API_KEY
    tool_models:                       # optional — absent ⇒ this profile's `model`
      security_scan: "qwen/qwen-2.5-7b-instruct"
      code_task:     "google/gemini-2.5-flash"
```

**Resolution order** for a given tool (first match wins):

1. an explicit `model` passed in the tool call (e.g. `security_scan`'s `model` arg);
2. `tool_models.<tool>` on the active profile;
3. the tool's own built-in default (e.g. `security_scan` → `qwen/qwen-2.5-7b-instruct`);
4. otherwise the profile's `model`.

So a profile with no `tool_models` behaves exactly as before — this is fully
back-compatible. Keys must be real LLM-tool names (the loader rejects typos like
`securty_scan`); values are model ids your backend advertises.

**Vet a model before you assign it.** Each tool declares its own requirements
(cost ceiling, context, output, structured-output / reasoning support), and some
tools additionally gate selection on a benchmark. Two helpers:

```bash
# Which tools can a model serve (requirements only — free, no LLM call, no API key)?
llm-ext-benchmark --assess-model google/gemini-2.5-flash
#   …or the slash command:  /llm-externalizer:llm-externalizer-assess-model

# For a benchmarked tool (today: security_scan), confirm it actually PASSES:
llm-ext-benchmark --security-triage --model google/gemini-2.5-flash
#   …or:  /llm-externalizer:llm-externalizer-security-triage-benchmark
```

A model you put in `tool_models.<tool>` for a benchmarked tool **should pass that
tool's benchmark first**. The standing rule holds throughout: the auto-selection
gates never bump a tool to a *pricier* model than its incumbent.

> [!NOTE]
> Today exactly one tool (`security_scan`) ships a model-judgment benchmark
> (`security-triage`); `mass_scout` reuses the keyword-classification benchmark.
> The other tools are gated by **requirements only** until their golden dataset
> lands — `--assess-model` shows, per tool, whether a benchmark gate also applies.

#### Request options for a local llama.cpp profile

A local profile may set `request_options:` — a `default` block plus one block per tool name
(same names as `tool_models`). Fields: `thinking` (`true`, `false`, `"on"` or `"off"`; sends
`chat_template_kwargs.enable_thinking` only when set), `max_output_tokens` (required in `default`;
a ceiling: a tool that asks for fewer tokens keeps its smaller cap), `temperature`, `top_k`,
`repeat_penalty`. The profile's values win over the static per-model table. A stop instruction
is appended to the first system message, and a reply cut off by the length limit (partial or
empty) fails with an `OUTPUT LIMIT:` error naming the key to raise. Profiles without the key are
unchanged; the key is refused on free/paid profiles. Applies to the OpenAI-compatible protocol
(llama-server), not to LM Studio's native API.

```yaml
request_options:
  default: { thinking: off, max_output_tokens: 1024, temperature: 0.1, top_k: 50, repeat_penalty: 1.1 }
  code_task: { thinking: on, max_output_tokens: 4096 }
```
### Backend presets

| Preset | Protocol | Default URL | Auth env var |
|---|---|---|---|
| `openrouter-remote` | OpenRouter | `https://openrouter.ai/api` | `OPENROUTER_API_KEY` |
| `lmstudio-local` | LM Studio native | `http://localhost:1234` | `LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | — |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | — |
| `generic-local` | OpenAI-compatible | (url required) | `LM_API_TOKEN` |
| `locals-local` | OpenAI-compatible (Locals, MLX models, macOS on Apple silicon only) | (url required; with `server: managed` llm-ext starts Locals itself) | — |

### Environment variables

| Variable | Used by |
|---|---|
| `OPENROUTER_API_KEY` | `openrouter-remote` preset |
| `LM_API_TOKEN` | `lmstudio-local`, `generic-local` presets |
| `VLLM_API_KEY` | `vllm-local` preset |
| `LLM_EXT_CONFIG_DIR` | Settings + history-log directory (default `~/.llm-externalizer`) |
| `LLM_EXT_OUTPUT_DIR` | Default report directory (overrides the per-call `output_dir` default) |
| `LLM_EXT_INSTALL_RULE` | Set to `0` to opt out of auto-installing `rules/use-llm-externalizer.md` into `~/.claude/rules/` |
| `LLM_EXT_FREE_BELOW_USD` | No longer used — the automatic free mode on low balance is removed (14.1.0). A paid profile falls back only within its own pool; free is used only when explicitly selected with `--profile free` or `active: free`. |
| `LLM_EXT_FREE_MODEL_ID` | No longer used — the `free: true` flag resolves to the selected profile's own first `:free` chain entry now, never a single hard-coded id (14.1.0, fix-queue 98(2)). |
| `LLM_EXT_REASONING_EFFORT` | Reasoning effort sent to OpenRouter reasoning models: `xhigh`\|`high`\|`medium`\|`low`\|`off` (default `high`). **Reasoning tokens are billed even though the trace is discarded** — `xhigh` can be ~10× the per-call cost of no reasoning, so the default is `high`. `off` disables reasoning on every call. `mass_scout` and `cluster_synonyms` never reason regardless of this setting. |
| `LLM_EXT_DUMP_REQUESTS` | Cost-audit hook. Set to a file path to append the **exact wire payload** (model + byte size + full JSON body) of every chat/code_task/ensemble request to that file, so you can verify there is no unexpected prompt/file inflation. Off unless set. The dumped body contains your prompt + file content — treat the file as sensitive. |

> [!NOTE]
> The **shell environment variable is the recommended way** to provide every key listed above. The statusline subprocess and every `llm-ext` invocation inherit it automatically, with no extra plumbing. Profile-level `api_key` / `api_token` fields are a supported fallback (read from `settings.yaml`). The Claude Code keychain (`userConfig.openrouter_api_key`) is **not** a reliable fallback — see [First run § A. OpenRouter](#first-run) for why. See that same section for the full precedence list and the trade-offs.

### Optional: statusline

Adds a multi-tier status bar with: model name, context-window bar, **live OpenRouter credit balance**, LLM tokens & cost, git branch, and Claude Code 5-hour / 7-day usage limits. Width-aware (1 line at ≥ 184 cols → 6 lines under 65 cols), per-section error isolation, no external dependencies.

Easiest way — invoke the bundled slash command from inside Claude Code:

```text
/llm-externalizer:llm-externalizer-install-statusline
```

Manual install (cross-platform Python):

<details>
<summary>macOS / Linux</summary>

```bash
# Default 3-second refresh cadence (re-tiers within 3 s of a terminal resize)
python3 "$CLAUDE_PLUGIN_ROOT/scripts/install_statusline.py"

# Or override the refresh cadence
REFRESH_INTERVAL=5 python3 "$CLAUDE_PLUGIN_ROOT/scripts/install_statusline.py"

# Bash-only equivalent (same behaviour, identical settings.json output)
bash "$CLAUDE_PLUGIN_ROOT/scripts/statusline/install.sh"
```
</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
python3 "$env:CLAUDE_PLUGIN_ROOT\scripts\install_statusline.py"
```
</details>

> [!NOTE]
> The OpenRouter remaining-credit panel (🏦) only renders when `OPENROUTER_API_KEY` is exported in your shell environment. The statusline runs as a fresh subprocess on every refresh, so the plugin's keychain (`userConfig.openrouter_api_key`) and the per-profile `api_key` field in `settings.yaml` are **not visible** to it — see [First run § A. OpenRouter](#first-run) for why the shell env is the only way to get every consumer (statusline, `llm-ext`) to share the same key.

See `scripts/statusline/README.md` for the full feature matrix and width-tiering details.

### Usage history

Every LLM web request the plugin makes — from any `llm-ext` command — appends one flat, human-readable line to `~/.llm-externalizer/history.log` (honors `LLM_EXT_CONFIG_DIR`; the file is created on first write, append-only, never truncated). One line per *web request* — a tool that makes several backend calls writes several lines, and a tool that makes none writes nothing. The log is for eyeballing and `grep`; the plugin ships no query/aggregation command for it.

Each line has 7 ` - `-separated fields:

```
<TIMESTAMP> - <PROJECT-DIR> - <TOOL/COMMAND(params)> - <SUCCESS|FAIL> - <DURATION> - <COST> - <OP-ID>
```

- **TIMESTAMP** — local time + GMT offset, `YYYY-MM-DDTHH:MM:SS±HHMM` (sortable).
- **PROJECT-DIR** — `CLAUDE_PROJECT_DIR` if set, else the git top-level of the working dir, else the working dir.
- **TOOL/COMMAND(params)** — the originating tool/command plus a compact param summary (scalars inline, long strings truncated to ~80 chars, arrays as `name[N]`, **secrets redacted**; never a whole snippet or file body).
- **SUCCESS|FAIL** — whether *that one* web request succeeded.
- **DURATION** — wall-clock of that request, `<N>ms` (or `<N.N>s` once ≥ 1000 ms).
- **COST** — USD of that request, `$0.000000` (6 dp); `$0.000000` for local / free / cached calls.
- **OP-ID** — `op-<8hex>` shared by every request from the same tool/command invocation, so all the lines of one call can be correlated later with `grep <op-id> ~/.llm-externalizer/history.log`.

Example:

```
2026-05-24T05:56:39+0200 - /home/me/proj - chat(instructions=Refactor the auth module…(120), input_files_paths=[2], free=true) - SUCCESS - 1.4s - $0.000007 - op-4047e633
```

Writing the log is strictly best-effort — a history-write failure never breaks or slows the actual tool call. The file lives in your home dir and may contain absolute paths; it is not committed anywhere.

---

## Troubleshooting

Run `/llm-externalizer:llm-externalizer-discover` first — the output identifies most problems immediately.

### OpenRouter

| Symptom | Cause / fix |
|---|---|
| `discover` shows `$OPENROUTER_API_KEY (NOT SET)` | Env var missing from your shell environment. Set it in your shell rc and open a new terminal (the Claude Code keychain does **not** reliably reach the CLI — see [First run § A. OpenRouter](#first-run)) |
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

### Setup wizard

| Symptom | Cause / fix |
|---|---|
| vLLM half-installed — `pip` reports success but `python -c "import vllm"` fails | Stock `pip install vllm` on Apple Silicon installs broken wheels. Re-run the wizard and pick `vllm-metal` (Apple Silicon), or a stock `pip install vllm` on Linux/Windows |
| Jan port collision — Jan won't bind | Jan defaults to port `1337`. Stop the other process (`lsof -i :1337`) or change Jan's port in **Settings → Server** |
| `hf` auth — gated repo returns 401 | `huggingface-cli login` once with a read token from <https://huggingface.co/settings/tokens>. Accept the model's license on the HF page |
| Pasted snippet broke my YAML | Restore from the wizard's automatic backup: `cp ~/.llm-externalizer/settings.yaml.bak ~/.llm-externalizer/settings.yaml` |
| Wizard misses my WSL2 Windows host | Re-run with `--include-wsl2-host` to also probe the Windows side for runners reachable from inside WSL2 |

---

## Plugin structure

<details>
<summary>Expand tree</summary>

```
llm-externalizer-plugin/
├── .claude-plugin/plugin.json     # Plugin manifest
├── bin/                           # llm-ext + llm-ext-benchmark CLI entry points
├── commands/                      # 40 slash commands
├── agents/                        # 6 internal agents (reviewer + 4 fixers + setup-agent)
├── skills/                        # 16 auto-discovered skills
├── rules/                         # Lean always-loaded usage rule (auto-installed to ~/.claude/rules/)
├── scripts/                       # Python: setup, publish, validators, helpers
│   └── llm-ext/                   # Bundled TypeScript CLI engine (all 46 commands; name is historical)
└── docs/                          # Banner, cost image, agent docs (usage-reference, tool-use-cases, setup-and-configuration), OpenRouter refs
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

### 3 · Build the bundled CLI

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
> **Do NOT bump `version` in `plugin.json`, `scripts/llm-ext/package.json`, or `pyproject.toml`** in your PR. Do NOT edit `CHANGELOG.md`. Do NOT run `scripts/publish.py`. All version work is done by the maintainer after merge.

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

`npm test` is **offline and free** — it never makes a real LLM call. Real-LLM (live) tests are opt-in behind `LIVE_TESTS=1` + `OPENROUTER_API_KEY`. See [`scripts/llm-ext/TESTING.md`](scripts/llm-ext/TESTING.md).

---

## License

MIT — see [LICENSE](LICENSE).

---

## Links

- **Marketplace:** <https://github.com/Emasoft/emasoft-plugins>
- **Source:** <https://github.com/Emasoft/llm-externalizer-plugin>
- **Issues:** <https://github.com/Emasoft/llm-externalizer-plugin/issues>
