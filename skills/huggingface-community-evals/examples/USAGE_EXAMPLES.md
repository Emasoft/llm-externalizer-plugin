# Usage Examples

This document provides practical examples for **running evaluations locally** against Hugging Face Hub models.

## Table of Contents

- [What this skill covers](#what-this-skill-covers)
- [What this skill does NOT cover](#what-this-skill-does-not-cover)
- [Setup](#setup)
- [inspect-ai examples](#inspect-ai-examples)
- [lighteval examples](#lighteval-examples)
- [Hand-off to Hugging Face Jobs](#hand-off-to-hugging-face-jobs)

## What this skill covers

- `inspect-ai` local runs
- `inspect-ai` with `vllm` or Transformers backends
- `lighteval` local runs with `vllm` or `accelerate`
- smoke tests and backend fallback patterns

## What this skill does NOT cover

- `model-index`
- `.eval_results`
- community eval publication workflows
- model-card PR creation
- Hugging Face Jobs orchestration

If you want to run these same scripts remotely, submit one of the scripts in `scripts/` to HF Jobs via the `hf jobs` CLI (see the `hf-cli` skill).

## Setup

```bash
cd skills/huggingface-community-evals
export HF_TOKEN=hf_xxx
uv --version
```

For local GPU runs:

```bash
nvidia-smi
```

## inspect-ai examples

### Quick smoke test

```bash
uv run scripts/inspect_eval_uv.py \
  --model meta-llama/Llama-3.2-1B \
  --task mmlu \
  --limit 10
```

### Local GPU with vLLM

```bash
uv run scripts/inspect_vllm_uv.py \
  --model meta-llama/Llama-3.2-8B-Instruct \
  --task gsm8k \
  --limit 20
```

### Transformers fallback

```bash
uv run scripts/inspect_vllm_uv.py \
  --model microsoft/phi-2 \
  --task mmlu \
  --backend hf \
  --trust-remote-code \
  --limit 20
```

## lighteval examples

### Single task

```bash
uv run scripts/lighteval_vllm_uv.py \
  --model meta-llama/Llama-3.2-3B-Instruct \
  --tasks "leaderboard|mmlu|5" \
  --max-samples 20
```

### Multiple tasks

```bash
uv run scripts/lighteval_vllm_uv.py \
  --model meta-llama/Llama-3.2-3B-Instruct \
  --tasks "leaderboard|mmlu|5,leaderboard|gsm8k|5" \
  --max-samples 20 \
  --use-chat-template
```

### accelerate fallback

```bash
uv run scripts/lighteval_vllm_uv.py \
  --model microsoft/phi-2 \
  --tasks "leaderboard|mmlu|5" \
  --backend accelerate \
  --trust-remote-code \
  --max-samples 20
```

## Hand-off to Hugging Face Jobs

When local hardware is not enough, submit one of these scripts to HF Jobs via the `hf jobs` CLI (see the `hf-cli` skill) — e.g. `hf jobs uv run <script-url-or-path>`. Keep the script path and args; move the orchestration to HF Jobs. Guide: https://huggingface.co/docs/huggingface_hub/en/guides/jobs
