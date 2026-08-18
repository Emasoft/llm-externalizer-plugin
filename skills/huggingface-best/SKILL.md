---
name: huggingface-best
description: "llm-externalizer's bundled copy, adapted for its setup wizard (distinct from the huggingface-skills plugin's skill of the same name). Find the highest-scoring models for a coding task by querying the official Hugging Face benchmark leaderboards, with memory-budget filtering and per-device fit. Use when the recommender script returns no compatible row and the user has explicitly widened the search. Loaded by llm-externalizer-setup-agent."
user-invocable: false
---

## Overview

Finds best models for a task by querying official HF benchmark leaderboards, enriching with model size data, filtering for device fit, and returning a comparison table with benchmark scores. Secondary widening path beyond `scripts/setup/recommend-models.py`.

## Prerequisites

The setup wizard's primary model-selection source is `scripts/setup/recommend-models.py`. That script:

- Scrapes the Onyx self-hosted-LLM coding leaderboard on every invocation
- Joins it with whatcani.run's featured-artifact API for live quantization evidence
- Filters by detected RAM/VRAM (memory-budget aware)
- Returns one JSON row per compatible model with `final_score`, `headroom_gb`, and pre-built `download_command` lines

**The wizard MUST try the recommender first.** This skill is consulted ONLY when both:
- The recommender returned no `compatible: true` row at the user's RAM tier
- The user has explicitly asked to widen the search beyond Onyx, OR has rejected the recommender's conservative output

When invoked, this skill reads HF leaderboards directly — slower than the recommender and without RAM-aware filtering. After returning a candidate, the wizard MUST re-apply the memory-budget check from `recommend-models.py` before recommending.

External requirements:
- `hf` CLI authenticated (`hf auth login`)
- `curl` and `jq` on PATH

## Instructions

Follow six steps documented in [leaderboard-workflow.md](references/leaderboard-workflow.md):

1. Parse the request (task + device → max parameter budget).
2. Find relevant benchmark datasets via `/api/datasets?filter=benchmark:official`.
3. Fetch top models from each leaderboard.
4. Enrich with model metadata (`safetensors.total`, license).
5. Filter by device budget and rank by benchmark score.
6. Render comparison table + ask follow-up.

## Output

Return the comparison table to the user with recommended pick starred and per-device fit annotated. See [leaderboard-workflow.md §Step 6](references/leaderboard-workflow.md) for the exact format.

## Error Handling

- **Leaderboard not found**: skip, note "leaderboard unavailable" in output
- **Model missing from hub_repo_details**: fall back to parsing size from model name
- **No benchmarks found for task**: try `hub_repo_search` with `filters=["<task>"]` sorted by `trendingScore`
- **All leaderboards fail**: fall back to `hub_repo_search` for popular task-tagged models, flag results as popularity-ranked

## Examples

**Input:** "best coding model for my M2 16 GB MacBook"

```bash
curl -s "https://huggingface.co/api/datasets?filter=benchmark:official&limit=500" | jq '...'
curl -s "https://huggingface.co/api/datasets/openai/humaneval/leaderboard" | jq '.[:15]'
hf models info qwen/Qwen2.5-Coder-7B --json
```

**Output:**

```markdown
| # | Model | Params | HumanEval | MBPP | License | On device |
|---|-------|--------|-----------|------|---------|-----------|
| ⭐1 | [qwen/Qwen2.5-Coder-7B](https://huggingface.co/qwen/Qwen2.5-Coder-7B) | 7B | 85.2% | 79.1% | Apache 2.0 | Yes (fp16) |
| 2 | [deepseek-ai/deepseek-coder-13b](https://huggingface.co/deepseek-ai/deepseek-coder-13b) | 13B | 83.1% | 71.5% | MIT | Q4 only |
```

## Resources

- [leaderboard-workflow](references/leaderboard-workflow.md)
  > Step 1: Parse the request · Step 2: Find relevant benchmark datasets · Step 3: Fetch top models from leaderboards · Step 4: Enrich with model metadata · Step 5: Filter and rank · Step 6: Output · Examples
- HF benchmark datasets API: `https://huggingface.co/api/datasets?filter=benchmark:official`
- HF model info API: `https://huggingface.co/api/models/<repo_id>`
- HF Jobs guide: `https://huggingface.co/docs/huggingface_hub/en/guides/jobs`
- Recommender script: `scripts/setup/recommend-models.py` (primary path)
