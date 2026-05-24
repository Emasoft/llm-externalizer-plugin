# LLM Externalizer — Setup & Configuration

**The setup wizard is meant to do all of this for you automatically.** Run
`/llm-externalizer:llm-externalizer-setup` and it detects your platform, finds or
installs a runner, downloads a model, tests it, and hands you a ready-to-paste
profile. This doc exists for the cases where the wizard can't finish — no agent
available, a headless/CI environment, an exotic machine, or you simply want to
configure by hand. **The knowledge is here so you never get stuck.**

> Configuration is **user-only by design**: there is no `set_settings` /
> `change_model` MCP tool and the CLI `profile add/select/edit/remove/rename`
> subcommands are disabled. You edit `~/.llm-externalizer/settings.yaml` by hand
> and call `reset`. The wizard generates a snippet for you to paste — it never
> writes the file itself.

---

## The automatic path (try this first)

| Command | What it does |
|---|---|
| `/llm-externalizer:llm-externalizer-setup` | **Local-model wizard.** Detects OS/arch/RAM/GPU → finds runners (Ollama, LM Studio, vLLM, llama.cpp, Jan) → installs one if needed → downloads a HF model → runs 5 compatibility tests → prints a profile snippet → verifies. 2–10 min. |
| `/llm-externalizer:llm-externalizer-configure` | **Read-only inspector.** Shows the active profile + all profiles + health. For OpenRouter-only setup it's a ~30 s API-key paste. Never mutates anything. |
| `/llm-externalizer:llm-externalizer-discover` | Quick health/auth/profile check. |

The wizard (`llm-externalizer-setup-agent`) walks 7 steps: (0) back up + inspect
existing config, (1) detect platform, (2) detect runners, (3) install assistance
if none, (4) model selection / HF download, (5) the 5-test compatibility check,
(6) generate the snippet via `scripts/setup/build-snippet.py`, (7) verify with
`discover`. State is cached under `$CLAUDE_PLUGIN_DATA/setup/` so a re-invocation
resumes. It never auto-installs without confirmation, never downloads >30 GB
without consent, and never edits your shell rc or settings.yaml.

---

## Hard requirements (every backend must meet these)

The plugin tests for these; a model that fails #1 or #2 is unusable:

1. **OpenAI-compatible** `POST <base>/v1/chat/completions` — or the LM Studio
   native API for the `lmstudio-local` preset.
2. **Structured output** via `response_format: { type: "json_schema", … }` —
   non-negotiable. Models that ignore it and return freeform text break the plugin.
3. **Context window ≥ 32K** real tokens (the wizard tests the true ceiling, not
   the advertised one).
4. **Output cap ≥ 4096 tokens** (reports run 2K–6K). Failures on #3/#4 are
   tolerable for short scans — but you'll be warned.

The 5 wizard tests map to these: `smoke`, `structured_output` (must pass),
`code_understanding`, `long_context`, `output_length`.

---

## Choosing a backend by platform & GPU

First decision — **local or remote?**

- **Remote (OpenRouter)** — no hardware needed, best quality (ensemble = 3 models
  in parallel), ~$0.50/M tokens. Pick this if you have no GPU, want zero setup, or
  want the highest accuracy. Also has a **free** Nemotron tier (logs prompts — open
  source only).
- **Local** — free, offline, private. Needs a capable GPU/enough RAM and one of
  the runners below.

### Platform → recommended local runner

| Platform | Default runner | Alternatives | Notes |
|---|---|---|---|
| **macOS Apple Silicon (arm64)** | LM Studio | Ollama, vllm-metal, vMLX | MLX-native options (vllm-metal / vMLX) are community-maintained — see below. |
| **macOS Intel (x86_64)** | LM Studio | Ollama | No GPU path (no CUDA, MLX is arm64-only) — expect CPU speeds. |
| **Linux + NVIDIA GPU** | vLLM | Ollama | vLLM = highest throughput (CUDA). |
| **Linux + AMD GPU (ROCm)** | Ollama | llama.cpp | Recommender budgets ROCm VRAM; vLLM ROCm is advanced. |
| **Linux, no GPU** | Ollama | llama.cpp | CPU inference — use small quantized models. |
| **WSL2** | Ollama (Linux side) | — | **Avoid** the Windows-host LM Studio bridge (fragile; Hyper-V net resets break it). |
| **Windows native** | LM Studio | Ollama (Windows) | vLLM / llama.cpp → use WSL2. |

### Local runners — install, port, preset

| Runner | Default port | settings.yaml `api` preset | Install |
|---|---|---|---|
| **Ollama** | 11434 | `ollama-local` | macOS `brew install ollama`; Linux/WSL2 `curl -fsSL https://ollama.com/install.sh \| sh`; Windows installer. Then `ollama serve &`. |
| **LM Studio** | 1234 | `lmstudio-local` | GUI from <https://lmstudio.ai/download>; load a model; Developer → Start Server. |
| **vLLM** (NVIDIA) | 8000 | `vllm-local` | `uv pip install vllm` then `vllm serve <model> --port 8000 --max-model-len 32768`. |
| **vLLM-metal** (Apple Silicon) | 8000 | `vllm-local` | Community plugin — use the `vllm-metal-setup` skill (venv, serve, env tuning). |
| **vMLX** (Apple Silicon) | 8000 | `vllm-local` / `generic-local` | PyPI `vmlx` — use the `vmlx-setup` skill; ships `vmlx doctor` + `vmlx bench`. |
| **llama.cpp** | 8080 | `llamacpp-local` | macOS `brew install llama.cpp`; Linux build from source. Serve `llama-server -m <gguf> --port 8080 -c 32768`. |
| **Jan** | 1337 | `generic-local` (set `url`) | GUI; enable its local API server, then point a `generic-local` profile at `http://localhost:1337`. |

**Apple Silicon note:** LM Studio / Ollama are the battle-tested defaults. Choose
`vllm-metal` if you want vLLM's serving semantics (continuous batching) on Mac, or
`vMLX` for a lighter MLX-native server with built-in `doctor`/`bench`. Both are
text-only and community-maintained — alternatives, not defaults.

### Model sizing by memory

Local models must fit your RAM (unified memory on Apple Silicon) or VRAM, with
headroom. Rough guide for a coding-capable model at Q4 quantization:

| Memory budget | Practical model size |
|---|---|
| 8 GB | 3B–7B (Q4) |
| 16 GB | 7B–14B (Q4) |
| 24–32 GB | 14B–32B (Q4) |
| 48 GB+ | 32B–70B (Q4) |

The wizard's `recommend-models.py` does this math for you (NVIDIA / AMD ROCm /
Apple Metal / CPU) and lists only models that fit. Manually: prefer a smaller
quant (Q4_K_M) over a bigger one if you're tight; drop a size tier if generation
is too slow (>60 s on the long-context test).

---

## Remote setup (OpenRouter)

Set your key one of three ways (precedence: shell env → settings.yaml literal →
keychain). **Shell env is strongly recommended** — every consumer (MCP server,
statusline credit panel, CLI, subprocesses) picks it up automatically.

```bash
# ~/.zshrc / ~/.bashrc / ~/.config/fish/config.fish
export OPENROUTER_API_KEY="sk-or-v1-..."
```

```powershell
# Windows PowerShell (persistent)
[Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", "sk-or-v1-...", "User")
```

Alternatives (both leave the statusline credit panel blank, so not recommended):
a literal `api_key:` in a profile, or the Claude Code keychain via
`claude plugin configure llm-externalizer`. The default profile works out of the
box once any one source is set.

---

## Manual local setup (when the wizard can't)

1. **Install + start a runner** (table above). Confirm it listens:
   `curl -s http://localhost:<port>/v1/models`.
2. **Get a model** — `ollama pull qwen2.5-coder:7b`, or load a GGUF in LM Studio,
   or `hf download <repo> --local-dir ~/models/<name>` for vLLM/llama.cpp. For
   gated repos (Llama / Gemma / Mistral) run `hf auth login` first (free token).
3. **Write a profile** in `~/.llm-externalizer/settings.yaml` (templates below),
   matching the preset + port to your runner.
4. **Set `active:`** to your new profile name.
5. **Reload** — call the `reset` MCP tool (or restart Claude Code).
6. **Verify** — `discover` should show the profile with `service_health: ok`.

---

## settings.yaml — file schema

Path: `~/.llm-externalizer/settings.yaml` (override the directory with
`$LLM_EXT_CONFIG_DIR`). YAML, **not** JSON. Two top-level keys:

```yaml
active: <profile-name>     # must match a key under profiles:
profiles:
  <profile-name>: { … }    # one block per profile
```

### Modes
| Mode | Behavior |
|---|---|
| `local` | Sequential requests to a local server |
| `remote` | Parallel requests, single model via OpenRouter |
| `remote-ensemble` | Parallel requests, 3 models in parallel, combined report |

### API presets
| Preset | Protocol | Default URL | Default auth env |
|---|---|---|---|
| `lmstudio-local` | LM Studio native | `http://localhost:1234` | `$LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | (none) |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `$VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | (none) |
| `generic-local` | OpenAI-compatible | (set `url`) | `$LM_API_TOKEN` |
| `openrouter-remote` | OpenRouter | `https://openrouter.ai/api` | `$OPENROUTER_API_KEY` |

Local presets require `mode: local`; `openrouter-remote` requires `remote` or
`remote-ensemble`. All local backends must support `response_format: json_schema`.

### Profile fields
| Field | Required | Description |
|---|---|---|
| `mode` | yes | `local` / `remote` / `remote-ensemble` |
| `api` | yes | preset name from the table above |
| `model` | yes | model identifier (e.g. `qwen2.5-coder:7b`, `google/gemini-2.5-flash`) |
| `url` | no | override the preset's default URL |
| `api_key` | no | remote auth — `$ENV_VAR` ref or literal |
| `api_token` | no | local auth — `$ENV_VAR` ref or literal |
| `second_model` | only `remote-ensemble` | 2nd ensemble model |
| `third_model` | optional `remote-ensemble` | 3rd ensemble model |
| `timeout` | no | request timeout (seconds) |
| `context_window` | no | override; `0` = auto-detect |
| `tool_models` | no | per-tool model routing map, e.g. `{ security_scan: "qwen/qwen-2.5-7b-instruct" }` |

### Auth resolution
`api_key` / `api_token` accept `$ENV_VAR_NAME` (resolved from the server's
process env at runtime) or a literal value. If `discover` shows the token
resolved, auth works; `(NOT SET)` means the env var is missing from the MCP
server's environment.

### Validation (checked at load / `reset`; a bad profile becomes unusable)
- `active` references an existing profile key
- `mode` ∈ {local, remote, remote-ensemble}
- `api` is a valid preset; mode/preset must agree (local↔`-local`, remote↔openrouter)
- `remote-ensemble` requires `second_model`
- remote presets require a resolvable `api_key`
- numeric fields are non-negative finite numbers

The file on disk **is** the config — a profile you remove from the file is gone
after reload. Back up before editing; one indent typo breaks every profile.

### Relevant environment variables
| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter auth (openrouter-remote) |
| `LM_API_TOKEN` | LM Studio / generic-local auth |
| `VLLM_API_KEY` | vLLM auth |
| `LLM_EXT_CONFIG_DIR` | Override settings dir (default `~/.llm-externalizer`) |
| `LLM_OUTPUT_DIR` | Override report output dir (default `<main-project-dir>/reports/llm-externalizer/`, anchored on `$CLAUDE_PROJECT_DIR` verbatim) |

---

## Profile templates

```yaml
active: remote-ensemble-geminigrok

profiles:
  # Local — Ollama
  ollama-qwen-coder:
    mode: local
    api: ollama-local
    model: "qwen2.5-coder:7b"

  # Local — LM Studio
  lmstudio-qwen:
    mode: local
    api: lmstudio-local
    model: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"

  # Local — vLLM / vllm-metal / vMLX (port 8000)
  vllm-qwen:
    mode: local
    api: vllm-local
    model: "Qwen/Qwen2.5-Coder-7B-Instruct"

  # Local — llama.cpp
  llamacpp-qwen:
    mode: local
    api: llamacpp-local
    model: "qwen2.5-coder-7b-instruct-q4_k_m"

  # Local — Jan (generic-local + url)
  jan-local:
    mode: local
    api: generic-local
    url: "http://localhost:1337"
    model: "qwen2.5-coder-7b"

  # Remote — single model
  remote-sonnet:
    mode: remote
    api: openrouter-remote
    model: "anthropic/claude-sonnet-4"
    api_key: $OPENROUTER_API_KEY

  # Remote — free Nemotron (logs prompts; open-source code only)
  remote-free:
    mode: remote
    api: openrouter-remote
    model: "nvidia/nemotron-3-super-120b-a12b:free"
    api_key: $OPENROUTER_API_KEY

  # Remote — ensemble (3 models in parallel)
  remote-ensemble-geminigrok:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    third_model: "qwen/qwen3.6-plus"
    api_key: $OPENROUTER_API_KEY
```

---

## Manual fallback / troubleshooting

| Symptom | Fix |
|---|---|
| Wizard reports `RAM: 0 GB` (Win11 24H2+ `wmic` removed) | Tell it your RAM, or set `context_window` manually; don't trust auto-detect. |
| `discover` shows auth `(NOT SET)` | Env var missing from the MCP server process — export it in your shell rc / `.mcp.json`, restart Claude Code. |
| Connection refused | Runner not started or wrong port — start it, `curl /v1/models`, fix `url`. |
| `structured_output` test fails | Model can't do `response_format: json_schema` — pick a JSON-capable model; it's a hard requirement. |
| Passes but `output_length` low | Raise the runner's max tokens (`-n` llama.cpp, `num_predict` Ollama, `--max-model-len`/`--max-num-tokens` vLLM) or pick a higher-cap model. |
| Gated HF repo (Llama/Gemma/Mistral) 401 | `hf auth login` with a free token from <https://huggingface.co/settings/tokens>. |
| Model too slow (long_context > 60 s) | Smaller quant (Q4), drop a size tier, or switch to OpenRouter. |
| Two Ollama instances fighting for `:11434` | Stop one (`ollama serve` vs Ollama Desktop). |
| WSL2 → Windows LM Studio bridge flaky | Use Ollama on the Linux side instead. |
| Validation error after edit | Re-check the validation rules above; fix YAML, `reset`. |

For the in-Claude inspection workflow and profile templates as a skill, see
`skills/llm-externalizer-config/`. For MLX-native serving on Apple Silicon see the
`vllm-metal-setup` and `vmlx-setup` skills.
