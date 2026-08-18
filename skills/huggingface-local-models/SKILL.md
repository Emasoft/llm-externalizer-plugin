---
name: huggingface-local-models
description: "llm-externalizer's bundled copy, adapted for its setup wizard (distinct from the huggingface-skills plugin's skill of the same name). Select GGUF artifacts and quantizations for llama.cpp on CPU, Mac Metal, CUDA, or ROCm runtimes. Covers Q4_K_M vs Q5_K_M vs Q6_K trade-offs, llama-server launch flags, --hf-repo/--hf-file fallback for non-standard naming, and conversion from Transformers weights when no GGUF exists. Use when the user picks llama.cpp / LM Studio / Ollama on non-Apple-Silicon platforms. Loaded by llm-externalizer-setup-agent."
user-invocable: false
---

## Overview

Search the Hugging Face Hub for llama.cpp-compatible GGUF repos, choose the right quant for the target hardware, and launch the model with `llama-cli` or `llama-server`. For MLX on Apple Silicon, see `huggingface-mlx-models` instead.

## Prerequisites

The setup wizard's `scripts/setup/recommend-models.py` emits, for every recommended model, the list of GGUF artifacts on HF (whatcani.run runtime=llama.cpp filter) with pre-built `download_command` lines. The wizard runs that command verbatim. This skill is consulted for:

- Quantization-quality trade-offs (multiple compatible quants for the same model)
- `llama-server` launch flags (context size, threading, KV-cache offload, flash-attention)
- `--hf-repo` / `--hf-file` fallback for non-standard naming
- Converting from Transformers weights when no GGUF exists
- `apps=llama.cpp` HF Hub filters for obscure repos

The wizard does NOT call this skill on Apple Silicon arm64 when the user picked MLX as the runtime — `huggingface-mlx-models` handles that path.

External requirements:
- `llama.cpp` installed (`brew install llama.cpp`, `winget install llama.cpp`, or build from source)
- `hf` CLI authenticated for gated repos (`hf auth login`)

## Instructions

1. Search the Hub with `apps=llama.cpp`.
2. Open `https://huggingface.co/<repo>?local-app=llama.cpp`.
3. Prefer the exact HF local-app snippet and quant recommendation when visible.
4. Confirm exact `.gguf` filenames with `https://huggingface.co/api/models/<repo>/tree/main?recursive=true`.
5. Launch with `llama-cli -hf <repo>:<QUANT>` or `llama-server -hf <repo>:<QUANT>`.
6. Fall back to `--hf-repo` plus `--hf-file` when the repo uses custom file naming.
7. Convert from Transformers weights only if the repo does not already expose GGUF files.

## Output

Return the recommended GGUF artifact + launch command + verified smoke-test result to the user.

## Error Handling

See [launch-recipes.md §Failure modes](references/launch-recipes.md): custom file naming, no GGUF artifact, gated repo, smoke-test fails.

## Examples

```bash
# Install + auth + serve
brew install llama.cpp
hf auth login
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
# Run an exact GGUF file with explicit context size
llama-server --hf-repo unsloth/Qwen3.6-35B-A3B-GGUF --hf-file Qwen3.6-35B-A3B-UD-Q4_K_M.gguf -c 4096
```

## Resources

- [launch-recipes](references/launch-recipes.md)
  > Install llama.cpp · Authenticate for gated repos · Search the Hub · Run directly from the Hub · Run an exact GGUF file · Convert only when no GGUF is available · Smoke test a local server · Quant Choice · Failure modes
- [hub-discovery](references/hub-discovery.md)
  > Core URLs · Search for llama.cpp-compatible models · Use the local-app page for the recommended quant · Confirm exact files from the tree API · Build the command · Example: `unsloth/Qwen3.6-35B-A3B-GGUF` · Notes
- [quantization](references/quantization.md)
  > Hub-first quant selection · Quantization Formats · Converting Models · K-Quantization Methods · Quality Testing · Use Case Guide · Model Size Scaling · Finding Pre-Quantized Models · Importance Matrices (`imatrix`) · Troubleshooting
- [hardware](references/hardware.md)
  > Apple Silicon (Metal) · NVIDIA (CUDA) · AMD (ROCm) · CPU
- llama.cpp: `https://github.com/ggml-org/llama.cpp`
- HF GGUF + llama.cpp docs: `https://huggingface.co/docs/hub/gguf-llamacpp`
- HF Local Apps docs: `https://huggingface.co/docs/hub/main/local-apps`
- GGUF converter Space: `https://huggingface.co/spaces/ggml-org/gguf-my-repo`
