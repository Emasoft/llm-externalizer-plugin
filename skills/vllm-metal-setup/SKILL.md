---
name: vllm-metal-setup
description: |-
  Install, set up, and configure the vllm-metal backend — the community vLLM
  hardware plugin that runs vLLM on Apple Silicon Macs via MLX. Use when the
  user wants vLLM on an Apple Silicon Mac, says "set up vllm-metal", "run vllm
  on my mac", "vllm on apple silicon", "install vllm-metal", or the
  llm-externalizer setup wizard picks vLLM as the macOS backend. Trigger with
  /vllm-metal-setup or "set up vllm-metal". Apple Silicon (arm64) ONLY — not
  Intel Macs, not Linux/Windows (use stock vLLM there).
argument-hint: "[model-id] [--with-vllm-rs]"
effort: medium
---

## Overview

vllm-metal — Apple Silicon vLLM backend setup.
`vllm-project/vllm-metal` is a **community-maintained** hardware plugin that
makes vLLM run on Apple Silicon Macs using MLX as the compute backend. Stock
vLLM is a CUDA project — on Apple Silicon `uv pip install vllm` fails to build
the GPU path or silently installs an unaccelerated CPU wheel. vllm-metal is the
fix.

Once installed and serving, it exposes the **standard OpenAI-compatible API on
`http://localhost:8000`**, so the llm-externalizer `vllm-local` profile preset
works against it unchanged — no new preset needed.

## Prerequisites

### Scope and limits — read first

- **Apple Silicon (arm64) only.** M1/M2/M3/M4. Do NOT use on Intel Macs
  (no Metal GPU path) or on Linux/Windows (use stock vLLM: `uv pip install vllm`).
- **Community-maintained, text-only models.** Newer and less battle-tested
  than LM Studio or Ollama. Treat it as an *alternative*, not the default
  macOS backend.
- **Structured output is NOT assumed.** The llm-externalizer requires
  `response_format: { type: "json_schema" }`. Whether a given model under
  vllm-metal honors it must be verified empirically — run the setup wizard's
  Step 5 compatibility test (or `/llm-externalizer-setup`) before trusting it.

### Tools required

- Apple Silicon Mac (`uname -m` returns `arm64`)
- `curl` on PATH for the installer
- `hf` CLI authenticated for gated repos
- Optional: Rust toolchain (`rustup`) for `--with-vllm-rs`

## Instructions

Follow these six steps in order.

1. Run Step 1 (Preflight) — abort if not on Apple Silicon.
2. Run Step 2 (Install) — let the user execute the piped-curl installer.
3. Serve a model via Step 3.
4. Tune env vars per Step 4 only if needed.
5. Verify with Step 5.
6. Wire into the llm-externalizer settings.yaml in Step 6.

### Step 1 — Preflight

```bash
# Must be Apple Silicon.
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] \
  || { echo "vllm-metal requires Apple Silicon (arm64). Aborting."; exit 1; }
```

If this fails, stop and tell the user to use stock vLLM (Linux/NVIDIA),
LM Studio, or Ollama instead.

### Step 2 — Install

The official installer creates a venv at `~/.venv-vllm-metal` containing the
vllm-metal plugin, vLLM core, and dependencies. Show the command, let the user
run it (do NOT auto-execute a piped-curl installer):

```bash
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash
```

Optional — also install the experimental Rust serving frontend (`vllm-rs`).
Requires the Rust toolchain (https://rustup.rs):

```bash
# only if the user passed --with-vllm-rs
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash -s -- --with-vllm-rs
```

The installer bootstraps `uv` if missing and pins specific versions
(vLLM core + plugin wheel). Expect a multi-minute first run.

### Step 3 — Serve a model

```bash
source ~/.venv-vllm-metal/bin/activate
vllm serve <model-id> --port 8000 --max-model-len 32768
```

- `<model-id>` is a full Hugging Face repo id (vLLM serves HF repos, not
  single GGUF files). Pre-download large models with `hf download` if the
  user wants progress visibility.
- `--max-model-len 32768` — the llm-externalizer needs a ≥32K context
  window. Lower it only if the user's RAM cannot hold the KV cache.
- Leave the terminal running, or background it; the server holds the model
  in unified memory.

### Step 4 — Configure (env vars, optional)

vllm-metal is tuned entirely through `VLLM_METAL_*` environment variables set
*before* `vllm serve`. The ones worth surfacing:

| Variable | Default | When to change |
|---|---|---|
| `VLLM_METAL_MEMORY_FRACTION` | `auto` | Low-RAM Macs: set a fraction like `0.7` (only valid with paged attention on). `auto` picks ~0.9 on the paged path. |
| `VLLM_METAL_USE_PAGED_ATTENTION` | `1` | Leave on. Required for an explicit `MEMORY_FRACTION`. |
| `VLLM_MLX_DEVICE` | `gpu` | `cpu` only for debugging — far slower. |
| `VLLM_METAL_PREFIX_CACHE` | unset | Set to enable prefix caching when many scans share a prompt prefix. |
| `VLLM_METAL_DEBUG` | `0` | `1` to debug a startup/inference failure. |

Example for a 16 GB Mac that struggles to load a 7B model:

```bash
VLLM_METAL_MEMORY_FRACTION=0.7 vllm serve <model-id> --port 8000 --max-model-len 16384
```

### Step 5 — Verify

```bash
curl -s http://localhost:8000/v1/models | jq '.data[].id'
```

A model id in the output means the server is up. Then run a real chat
completion (or let the setup wizard's Step 5 do the five calibrated
compatibility tests — smoke, structured output, code understanding, long
context, output length).

### Step 6 — Wire into llm-externalizer

vllm-metal's server is wire-compatible with the **`vllm-local`** preset
(OpenAI-compatible, default `http://localhost:8000`). No new preset:

```yaml
profiles:
  vllm-metal-local:
    mode: local
    api: vllm-local
    model: "<model-id>"          # same id you passed to `vllm serve`
    # url defaults to http://localhost:8000 — override only on a custom port
```

Hand this snippet to the user to paste into `~/.llm-externalizer/settings.yaml`
(the wizard / `build-snippet.py` does the safe YAML quoting). NEVER write that
file directly — profile changes are user-only.

## Output

A running `vllm serve` process on `http://localhost:8000` plus a ready-to-paste settings.yaml profile fragment for the `vllm-local` preset.

## Error Handling

### Maintenance

- **Upgrade / repair:** `rm -rf ~/.venv-vllm-metal` then re-run the installer.
- **Uninstall:** just delete `~/.venv-vllm-metal`.
- **Custom install dir:** the installer supports a non-default venv path —
  substitute it everywhere `~/.venv-vllm-metal` appears above.

### Failure modes

- **`uv pip install vllm` was run instead** → that's stock vLLM and it does
  not work on Apple Silicon. Remove that environment and use this skill's
  installer.
- **Out-of-memory on load** → lower `--max-model-len`, set
  `VLLM_METAL_MEMORY_FRACTION` to a smaller value, or pick a smaller model /
  quant.
- **`vllm` not found after install** → the venv was not activated; run
  `source ~/.venv-vllm-metal/bin/activate` first, or add
  `~/.venv-vllm-metal/bin` to `PATH`.
- **Symlink / Rust frontend fails** → `--with-vllm-rs` needs `cargo` +
  `rustup` on PATH; install Rust first or drop the flag.

## Examples

```bash
# Full happy-path install + serve on M2 Pro 32 GB
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash
source ~/.venv-vllm-metal/bin/activate
vllm serve mlx-community/Qwen3.6-32B-Instruct-4bit --port 8000 --max-model-len 32768

# Tight-memory variant on M2 16 GB
VLLM_METAL_MEMORY_FRACTION=0.7 vllm serve mlx-community/Llama-3.2-3B-Instruct --port 8000 --max-model-len 16384
```

## Resources

- vllm-metal repo: `https://github.com/vllm-project/vllm-metal`
- vLLM upstream: `https://github.com/vllm-project/vllm`
- MLX: `https://github.com/ml-explore/mlx`
- Related: `vmlx-setup` skill — the MLX-native alternative (vMLX). If the user wants MLX inference rather than vLLM-on-MLX, that backend is lighter-weight and ships built-in `doctor` + `bench` commands.
- Related: `huggingface-mlx-models` skill — selecting MLX-quantized models.
