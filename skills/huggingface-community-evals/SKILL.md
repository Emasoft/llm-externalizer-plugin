---
name: huggingface-community-evals
description: "llm-externalizer's bundled copy, adapted for its setup wizard (distinct from the huggingface-skills plugin's skill of the same name). Run rigorous evaluations against Hugging Face Hub models using inspect-ai or lighteval on local hardware. Covers backend selection (vLLM / Transformers / accelerate), local GPU evals, smoke tests, and task selection. Use when the user wants a deeper benchmark than the wizard's 5-test compatibility check. Loaded by llm-externalizer-setup-agent."
user-invocable: false
---

## Overview

Run rigorous evaluations against Hugging Face Hub models on local hardware via `inspect-ai` or `lighteval`. Use AFTER the model has passed the wizard's compatibility check, when the user explicitly asks for a deeper benchmark (MMLU, HumanEval, etc.). NOT for HF Jobs orchestration, model-card PRs, `.eval_results` publication, or community-evals automation.

## Prerequisites

The setup wizard's `scripts/setup/test-model.py` runs 5 fast calibrated tests:

1. `smoke` — basic completion
2. `structured_output` — JSON-schema `response_format` (the plugin's hard compatibility requirement)
3. `code_understanding` — find an off-by-one bug in 4 lines of Python, return strict JSON
4. `long_context` — ~30K-token input, return a one-sentence summary
5. `output_length` — emit ≥4K tokens before stopping

This is sufficient for confirming a model can run llm-externalizer scans, code reviews, and reports.

Consult this skill ONLY when:
- The user explicitly asks for a deeper benchmark (e.g. "MMLU score", "HumanEval pass-rate"), AND
- The model has already passed the wizard's 5-test check, AND
- The user has the time/disk to run inspect-ai or lighteval (minutes-to-hours)

The skill's output is INFORMATIONAL. The wizard's pass/fail verdict comes from `test-model.py`, not this skill.

External: `uv run`, `HF_TOKEN` for gated models, GPU for local runs (`nvidia-smi`).

## Instructions

Follow the workflow in [evaluation-recipes.md](references/evaluation-recipes.md):

1. Choose framework (inspect-ai for task control; lighteval for leaderboard-style strings).
2. Choose backend (vllm > hf > accelerate).
3. Start with a smoke test (`--limit 10` or `--max-samples 10`).
4. Scale up after smoke passes.
5. For remote execution, run the same script + args on HF Jobs via the `hf jobs` CLI (see the `hf-cli` skill and https://huggingface.co/docs/huggingface_hub/en/guides/jobs).

## Output

Return the evaluation results table (scored metric per task per model), with smoke-test pass/fail clearly indicated, and the next-step recommendation (scale up locally / hand off to HF Jobs / try a different backend).

## Error Handling

See [evaluation-recipes.md §Error Handling](references/evaluation-recipes.md): CUDA/vLLM OOM, model unsupported by vllm (switch backend), gated repo (verify HF_TOKEN), custom model code (`--trust-remote-code`).

## Examples

```bash
# Smoke test on a tiny model with mmlu via providers
uv run scripts/inspect_eval_uv.py --model meta-llama/Llama-3.2-1B --task mmlu --limit 20
# Local GPU vLLM run on gsm8k
uv run scripts/inspect_vllm_uv.py --model meta-llama/Llama-3.2-1B --task gsm8k --limit 20
# lighteval with accelerate fallback
uv run scripts/lighteval_vllm_uv.py --model microsoft/phi-2 --tasks "leaderboard|mmlu|5" --backend accelerate --max-samples 20
```

## Resources

- [evaluation-recipes](references/evaluation-recipes.md)
  > Detailed scope · When To Use Which Script · Tools required · Core Workflow · Quick Start · Remote Execution Boundary · Task Selection · Backend Selection · Hardware Guidance · Error Handling · Examples
- [USAGE_EXAMPLES](examples/USAGE_EXAMPLES.md)
  > What this skill covers · What this skill does NOT cover · Setup · inspect-ai examples · lighteval examples · Hand-off to Hugging Face Jobs
- `scripts/inspect_eval_uv.py` — inspect-ai eval via Inference Providers
- `scripts/inspect_vllm_uv.py` — inspect-ai with local vLLM / HF backend
- `scripts/lighteval_vllm_uv.py` — lighteval with vLLM / accelerate backend
- inspect-ai: `https://github.com/UKGovernmentBEIS/inspect_ai`
- lighteval: `https://github.com/huggingface/lighteval`
- HF Inference Providers: `https://huggingface.co/docs/inference-providers`
