---
name: huggingface-mlx-models
description: "Select MLX-quantized models from the Hugging Face Hub and serve them on Apple Silicon (arm64) via mlx_lm.server, vMLX, or LM Studio's MLX runtime. Covers mxfp4 / OptiQ-4bit / DQ3_K_M quant interpretation and unified-memory quant-budget guidance. Use when the setup wizard picks MLX on arm64. Loaded by llm-externalizer-setup-agent."
user-invocable: false
---

## Overview

Select MLX-quantized models from the Hugging Face Hub and serve them on Apple Silicon (arm64). Three first-class runtimes (mlx_lm.server, vMLX, LM Studio MLX), quant label interpretation, unified-memory budgeting, preset wiring. NOT for Intel Macs (use `huggingface-local-models`).

## Prerequisites

The setup wizard's `scripts/setup/recommend-models.py` emits MLX artifacts on Apple Silicon (whatcani.run runtime=mlx_lm filter) with pre-built `download_command`:

    hf download <hf_repo_id> --local-dir ~/models/<short-name>

(MLX repos are directory-shaped — no per-file arg.) The wizard runs it verbatim. This skill is consulted for:

- Picking which MLX runtime (mlx_lm.server / vMLX / LM Studio) — see [runtime-comparison.md](references/runtime-comparison.md)
- MLX-specific quant labels (mxfp4/nvfp4/OptiQ-4bit/DQ3_K_M/DQ4plus/mixed_3_4/4bit-DWQ/GPTQ-Int4)
- Unified-memory quant-budget guidance — see [quant-budget.md](references/quant-budget.md)
- Per-runtime launch flags + matching `generic-local`/`vllm-local`/`lmstudio-local` preset wiring
- Converting a non-quantized HF repo to MLX with `mlx_lm.convert`

The wizard does NOT call this on Intel Macs — redirect to `huggingface-local-models`.

External: Apple Silicon Mac (M1/M2/M3/M4, `uname -m`=`arm64`); Python 3.10+ for `mlx_lm.server`; `hf` CLI authenticated for gated repos; one of `pip install mlx-lm`, `brew install vmlx`, or LM Studio installed (`lms` on PATH).

## Instructions

1. Decide MLX vs llama.cpp Metal — see [runtime-comparison.md](references/runtime-comparison.md).
2. Pick runtime (mlx_lm.server / vMLX / LM Studio MLX) — see [runtime-comparison.md](references/runtime-comparison.md).
3. Compute unified-memory quant budget (RAM − 4 GB headroom) — see [quant-budget.md](references/quant-budget.md).
4. Run default workflow to locate, download, serve — see [runtime-recipes.md §Default workflow](references/runtime-recipes.md).
5. Apply runtime-specific launch flags — see [runtime-recipes.md §Runtime 1/2/3](references/runtime-recipes.md).
6. Verify with `/v1/models` endpoint and wire into matching settings.yaml preset.

## Output

Return: chosen runtime, downloaded MLX repo + quant, launch command, `/v1/models` model-id verified, and settings.yaml profile fragment ready for paste.

## Error Handling

See [runtime-recipes.md §Common gotchas](references/runtime-recipes.md). Key items: Intel Mac (refuse/redirect), unified-memory pressure (close apps, lower context), unsupported tokenizer (upgrade mlx-lm), port collisions (set distinct ports), 8 GB Macs (recommend `remote-ensemble` instead).

## Examples

```bash
# M2 Pro 32 GB, vMLX runtime, 13B Q4
hf download mlx-community/Qwen3.6-32B-Instruct-4bit --local-dir ~/models/qwen3.6-32b-4bit
vmlx serve ~/models/qwen3.6-32b-4bit --port 8000

# M3 Max 64 GB, mlx_lm.server, 70B 4bit
hf download mlx-community/Llama-3.3-70B-Instruct-4bit --local-dir ~/models/l3-70b-4bit
mlx_lm.server --model ~/models/l3-70b-4bit --host 127.0.0.1 --port 8082
```

## Resources

- [runtime-comparison](references/runtime-comparison.md)
  > When to prefer MLX over llama.cpp Metal on a Mac · The three first-class MLX runtimes (pick one)
- [quant-budget](references/quant-budget.md)
  > Quant selection table · Beyond plain bit-quants
- [runtime-recipes](references/runtime-recipes.md)
  > Default workflow (runtime-agnostic) · Runtime 1 — `mlx_lm.server` (official, Python-native) · Runtime 2 — vMLX (`vmlx serve`, MLX-native, built-in doctor/bench) · Runtime 3 — LM Studio MLX runtime (GUI / `lms` CLI) · Listing & comparing MLX models · Converting a non-MLX HF repo to MLX · Common gotchas · Examples
- Related: `Skill(skill: "vmlx-setup")` — full vMLX install/serve guide.
- Related: `Skill(skill: "vllm-metal-setup")` — vLLM-on-Apple-Silicon path.
- Related: `Skill(skill: "huggingface-local-models")` — GGUF/llama.cpp path for Intel Mac/Linux/Windows.
- Related: `Skill(skill: "hf-cli")` — `hf` command reference.
- Related: `Skill(skill: "huggingface-best")` — best-model-for-task across HF leaderboards.
- Related: `Skill(skill: "huggingface-community-evals")` — benchmark evaluation post-download.
- MLX: `https://github.com/ml-explore/mlx`
- mlx-lm: `https://github.com/ml-explore/mlx-lm`
- vMLX: `https://github.com/jjang-ai/vmlx`
- LM Studio: `https://lmstudio.ai`
- mlx-community HF org: `https://huggingface.co/mlx-community`
