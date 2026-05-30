---
name: vmlx-setup
description: |-
  Install, set up, and configure the vMLX backend — an MLX-native inference
  server for Apple Silicon (jjang-ai/vmlx) exposing an OpenAI/Anthropic/Ollama
  compatible API. Loaded by the llm-externalizer setup wizard when it picks vMLX
  as the macOS backend, or when the user wants MLX-native serving on an Apple
  Silicon Mac. Apple Silicon (M1/M2/M3/M4) ONLY.
argument-hint: "[model-id] [--port N] [--api-key KEY]"
effort: medium
user-invocable: false
---

## Overview

vMLX — MLX-native inference server setup. `jjang-ai/vmlx` is an **MLX-native inference server for Apple Silicon**. Serves LLMs/VLMs from the `mlx-community` HF org and exposes an **OpenAI + Anthropic + Ollama compatible HTTP API on `http://localhost:8000`**. Self-hosted — no third-party API keys.

Compared with `vllm-metal` (vLLM core + MLX backend plugin), vMLX is MLX-native end-to-end: lighter-weight, ships built-in `doctor` (diagnostics) and `bench` (performance) subcommands.

## Prerequisites

**Scope and limits**:
- **Apple Silicon only.** M1/M2/M3/M4, Python 3.10+. NOT Intel Macs, NOT Linux/Windows.
- **`mlx-community` models.** Thousands of pre-quantized MLX models work out of the box; vMLX can also `convert` others to MLX/JANG quant.
- **Structured output NOT assumed.** llm-externalizer requires `response_format: { type: "json_schema" }`. vMLX is OpenAI-compatible but per-model honoring must be verified empirically.
- **Community-maintained**, Apache-2.0. Alternative backend, not default macOS choice.

**Tools**:
- Apple Silicon Mac (`uname -m` returns `arm64`), Python 3.10+
- One of: `uv` (preferred), `pipx`, or a venv on PATH
- `hf` CLI authenticated for gated repos

## Instructions

Follow six steps in [install-and-serve.md](references/install-and-serve.md):

1. **Preflight** — abort if not Apple Silicon.
2. **Install** via `uv tool install vmlx` (preferred), `pipx`, or venv.
3. **Serve** with `vmlx serve <model-id> --port 8000` plus scan-workload flags.
4. **Diagnostics** via `vmlx doctor` + `vmlx bench` (built-in).
5. **Verify** with `curl /v1/models`.
6. **Wire** into settings.yaml using `vllm-local` preset. The `vllm-local`
   preset is correct even though vMLX is MLX-native, not vLLM — the preset name
   only encodes the transport (an OpenAI-compatible API on `:8000`), which vMLX
   serves; product ≠ preset name. Use `generic-local` instead if you ran vMLX on
   a custom port.

## Output

A running `vmlx serve` process on `http://localhost:8000`, plus a ready-to-paste settings.yaml profile fragment for the `vllm-local` preset (or `generic-local` if a custom port is in use).

## Error Handling

Maintenance + failure modes documented in [install-and-serve.md §Failure modes](references/install-and-serve.md). Key items: externally-managed-environment, `vmlx` not found, OOM on load, `vmlx doctor` failures.

## Examples

```bash
# Happy-path install + serve on M2 Pro 32 GB
uv tool install vmlx
vmlx serve mlx-community/Qwen3-8B-4bit --port 8000 \
  --max-model-len 32768 --continuous-batching --enable-prefix-cache \
  --enable-pld --kv-cache-quantization q8

# Built-in diagnostics
vmlx doctor mlx-community/Qwen3-8B-4bit
vmlx bench  mlx-community/Qwen3-8B-4bit
```

## Resources

- [install-and-serve](references/install-and-serve.md)
  > Step 1 — Preflight · Step 2 — Install · Step 3 — Serve a model · Step 4 — Reliability + benchmark (built-in) · Step 5 — Verify · Step 6 — Wire into llm-externalizer · Maintenance · Failure modes · Examples
- vMLX repo: `https://github.com/jjang-ai/vmlx`
- MLX: `https://github.com/ml-explore/mlx`
- mlx-community HF org: `https://huggingface.co/mlx-community`
- Related: `vllm-metal-setup` skill — vLLM-on-MLX alternative.
- Related: `huggingface-mlx-models` skill — selecting MLX-quantized models.
