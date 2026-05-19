---
name: huggingface-local-models
description: "Select GGUF artifacts and quantizations for llama.cpp on CPU, Mac Metal, CUDA, or ROCm runtimes. Covers Q4_K_M vs Q5_K_M vs Q6_K trade-offs, llama-server launch flags, --hf-repo/--hf-file fallback for non-standard naming, and conversion from Transformers weights when no GGUF exists. Use when the user picks llama.cpp / LM Studio / Ollama on non-Apple-Silicon platforms. Loaded by llm-externalizer-setup-agent."
user-invocable: false
---

## Overview

Search the Hugging Face Hub for llama.cpp-compatible GGUF repos, choose the right quant for the target hardware, and launch the model with `llama-cli` or `llama-server`. For MLX on Apple Silicon, see `huggingface-mlx-models` instead.

## Prerequisites

The setup wizard's `scripts/setup/recommend-models.py` already emits, for every
recommended model, the list of GGUF artifacts available on Hugging Face (via
the whatcani.run runtime=llama.cpp filter). Each artifact comes with a
pre-built `download_command` of the form:

    hf download <hf_repo_id> <gguf_file> --local-dir ~/models/<short-name>

The wizard runs that command verbatim. This skill is consulted for:

- Quantization-quality trade-offs (when the recommender lists multiple
  compatible quants for the same model — e.g. Q4_K_M vs Q5_K_M vs Q6_K)
- `llama-server` launch flags (context size, threading, KV-cache offload,
  flash-attention)
- `--hf-repo` / `--hf-file` fallback when a repo uses non-standard file
  naming the recommender's parser does not handle
- Converting from Transformers weights when no GGUF exists yet (the
  recommender will not surface such models — this skill bridges that gap)
- Choosing `apps=llama.cpp` HF Hub filters when the recommender's
  whatcani.run feed has no entry for an obscure repo

The wizard does NOT call this skill on Apple Silicon arm64 when the user
picked MLX as the runtime — `huggingface-mlx-models` handles that path.

External requirements:

- `llama.cpp` installed (`brew install llama.cpp`, `winget install llama.cpp`, or build from source)
- `hf` CLI authenticated for gated repos (`hf auth login`)

## Instructions

### Default Workflow

1. Search the Hub with `apps=llama.cpp`.
2. Open `https://huggingface.co/<repo>?local-app=llama.cpp`.
3. Prefer the exact HF local-app snippet and quant recommendation when it is visible.
4. Confirm exact `.gguf` filenames with `https://huggingface.co/api/models/<repo>/tree/main?recursive=true`.
5. Launch with `llama-cli -hf <repo>:<QUANT>` or `llama-server -hf <repo>:<QUANT>`.
6. Fall back to `--hf-repo` plus `--hf-file` when the repo uses custom file naming.
7. Convert from Transformers weights only if the repo does not already expose GGUF files.

## Examples

### Install llama.cpp

```bash
brew install llama.cpp
winget install llama.cpp
```

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
make
```

### Authenticate for gated repos

```bash
hf auth login
```

### Search the Hub

```text
https://huggingface.co/models?apps=llama.cpp&sort=trending
https://huggingface.co/models?search=Qwen3.6&apps=llama.cpp&sort=trending
https://huggingface.co/models?search=<term>&apps=llama.cpp&num_parameters=min:0,max:24B&sort=trending
```

### Run directly from the Hub

```bash
llama-cli -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
```

### Run an exact GGUF file

```bash
llama-server \
    --hf-repo unsloth/Qwen3.6-35B-A3B-GGUF \
    --hf-file Qwen3.6-35B-A3B-UD-Q4_K_M.gguf \
    -c 4096
```

### Convert only when no GGUF is available

```bash
hf download <repo-without-gguf> --local-dir ./model-src
python convert_hf_to_gguf.py ./model-src \
    --outfile model-f16.gguf \
    --outtype f16
llama-quantize model-f16.gguf model-q4_k_m.gguf Q4_K_M
```

### Smoke test a local server

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
```

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer no-key" \
  -d '{
    "messages": [
      {"role": "user", "content": "Write a limerick about exception handling"}
    ]
  }'
```

## Output

Return the recommended GGUF artifact + launch command + verified smoke-test result to the user.

## Quant Choice

- Prefer the exact quant that HF marks as compatible on the `?local-app=llama.cpp` page.
- Keep repo-native labels such as `UD-Q4_K_M` instead of normalizing them.
- Default to `Q4_K_M` unless the repo page or hardware profile suggests otherwise.
- Prefer `Q5_K_M` or `Q6_K` for code or technical workloads when memory allows.
- Consider `Q3_K_M`, `Q4_K_S`, or repo-specific `IQ` / `UD-*` variants for tighter RAM or VRAM budgets.
- Treat `mmproj-*.gguf` files as projector weights, not the main checkpoint.

## Error Handling

- **Custom file naming in repo**: use `--hf-repo` + `--hf-file` form to bypass the default `repo:QUANT` shortcut.
- **No GGUF artifact exists**: convert from Transformers weights via `convert_hf_to_gguf.py`, then quantize with `llama-quantize`.
- **Gated repo (Llama, Gemma)**: run `hf auth login` first; the token must be tied to a license-accepted account.
- **Smoke-test fails**: re-check the launch flags (`-c` for context size, `-ngl` for Metal offload, etc.) — see [hardware](references/hardware.md).

## Resources

- Read [hub-discovery](references/hub-discovery.md) — URL-first workflows for finding llama.cpp-compatible models on the Hub.
  - Core URLs
  - Search for llama.cpp-compatible models
  - Use the local-app page for the recommended quant
  - Confirm exact files from the tree API
  - Build the command
  - Example: `unsloth/Qwen3.6-35B-A3B-GGUF`
  - Notes
- Read [quantization](references/quantization.md) — GGUF quant format tables and conversion details.
  - Hub-first quant selection
  - Quantization Formats
  - Converting Models
  - K-Quantization Methods
  - Quality Testing
  - Use Case Guide
  - Model Size Scaling
  - Finding Pre-Quantized Models
  - Importance Matrices (`imatrix`)
  - Troubleshooting
- Read [hardware](references/hardware.md) — Metal, CUDA, ROCm, or CPU build and acceleration details.
  - Apple Silicon (Metal)
  - NVIDIA (CUDA)
  - AMD (ROCm)
  - CPU
- llama.cpp: `https://github.com/ggml-org/llama.cpp`
- Hugging Face GGUF + llama.cpp docs: `https://huggingface.co/docs/hub/gguf-llamacpp`
- Hugging Face Local Apps docs: `https://huggingface.co/docs/hub/main/local-apps`
- Hugging Face Local Agents docs: `https://huggingface.co/docs/hub/agents-local`
- GGUF converter Space: `https://huggingface.co/spaces/ggml-org/gguf-my-repo`
