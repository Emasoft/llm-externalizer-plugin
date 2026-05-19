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

vllm-metal — Apple Silicon vLLM backend setup. `vllm-project/vllm-metal` is a community-maintained hardware plugin that runs vLLM on Apple Silicon Macs using MLX as compute backend. Stock vLLM is CUDA-only — on Apple Silicon `uv pip install vllm` fails to build the GPU path or installs an unaccelerated CPU wheel. vllm-metal is the fix.

Once serving, exposes the **standard OpenAI-compatible API on `http://localhost:8000`** — the llm-externalizer `vllm-local` profile preset works unchanged.

## Prerequisites

**Scope and limits**:
- **Apple Silicon (arm64) only.** M1/M2/M3/M4. NOT Intel Macs. NOT Linux/Windows (use stock vLLM: `uv pip install vllm`).
- **Community-maintained, text-only models.** Newer/less battle-tested than LM Studio or Ollama. Treat as alternative, not default.
- **Structured output NOT assumed.** llm-externalizer requires `response_format: { type: "json_schema" }`. Verify empirically via setup wizard's Step 5.

**Tools**:
- Apple Silicon Mac (`uname -m` returns `arm64`)
- `curl` on PATH for the installer
- `hf` CLI authenticated for gated repos
- Optional: Rust toolchain (`rustup`) for `--with-vllm-rs`

## Instructions

Follow six steps in [install-and-serve.md](references/install-and-serve.md):

1. **Preflight** — abort if not Apple Silicon.
2. **Install** — let the user execute the piped-curl installer.
3. **Serve** a model with `vllm serve <model-id> --port 8000 --max-model-len 32768`.
4. **Tune** env vars (`VLLM_METAL_*`) only if needed.
5. **Verify** with `curl /v1/models`.
6. **Wire** into settings.yaml using `vllm-local` preset.

## Output

A running `vllm serve` process on `http://localhost:8000` plus a ready-to-paste settings.yaml profile fragment for the `vllm-local` preset.

## Error Handling

Maintenance + failure modes documented in [install-and-serve.md §Failure modes](references/install-and-serve.md). Key items: stock vLLM accidentally installed, OOM on load, `vllm` not found (venv not activated), Rust frontend fails.

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

- [install-and-serve](references/install-and-serve.md)
  > Step 1 — Preflight · Step 2 — Install · Step 3 — Serve a model · Step 4 — Configure env vars (optional) · Step 5 — Verify · Step 6 — Wire into llm-externalizer · Maintenance · Failure modes · Examples
- vllm-metal repo: `https://github.com/vllm-project/vllm-metal`
- vLLM upstream: `https://github.com/vllm-project/vllm`
- MLX: `https://github.com/ml-explore/mlx`
- Related: `vmlx-setup` skill — MLX-native alternative (lighter, built-in `doctor`/`bench`).
- Related: `huggingface-mlx-models` skill — selecting MLX-quantized models.
