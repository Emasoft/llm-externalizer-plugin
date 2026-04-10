---
name: llm-externalizer-or-model-info
description: |-
  Use when the user asks for detailed information about an OpenRouter model — context length,
  pricing, supported parameters, quantization, uptime, latency, or throughput. Triggers:
  "openrouter model info", "or-model-info", "model info", "what params does X support",
  "check model support", "show pricing for model", "look up openrouter model".
version: 1.0.0
---

# LLM Externalizer — OpenRouter Model Info

## Overview

Query OpenRouter's `/v1/models/{exact_id}/endpoints` for a specific model and return formatted
metadata: per-endpoint provider info, context length, pricing, **supported request-body
parameters**, quantization, uptime, latency percentiles, and throughput.

Primary use cases:
- Verify which parameters a model accepts before integrating it (e.g. does it support
  `reasoning`, `top_k`, `structured_outputs`?)
- Compare pricing across providers hosting the same model
- Check current latency / uptime when debugging slow or failing calls
- Look up quantization and max token limits for a specific endpoint

## Prerequisites

- Active profile must be an OpenRouter profile (not local). The tool returns an error
  otherwise and suggests switching profiles.
- `OPENROUTER_API_KEY` env var must be set.

## Instructions

1. [ ] Parse the user's prompt for the **exact OpenRouter model id**. Examples:
       - `nvidia/nemotron-3-super-120b-a12b:free`
       - `anthropic/claude-sonnet-4`
       - `google/gemini-2.5-flash`
       - `x-ai/grok-4.1-fast`
       - `qwen/qwen3.6-plus`

       The id is **case-sensitive**, includes the vendor prefix, and must include any
       `:free` / `:thinking` / `:beta` suffix.

2. [ ] If the user only gave a partial name (e.g. "nemotron" or "claude"), ask them to
       provide the full id, OR list likely candidates and ask which one.

3. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__or_model_info` with:
   ```json
   { "model": "<exact-model-id>" }
   ```

4. [ ] Present the returned markdown block to the user. It includes:
   - Model name + id
   - Architecture (input/output modalities, tokenizer)
   - Short description
   - One section per endpoint (provider) with:
     - context_length, max_completion_tokens, max_prompt_tokens
     - quantization
     - pricing (prompt / completion / cache-read, converted to $/M tokens)
     - **supported_parameters** (the list of request-body fields accepted)
     - uptime (last 30m + last 24h)
     - latency p50/p75/p90/p99 (ms)
     - throughput p50/p75/p90/p99 (tok/s)

5. [ ] If the user asked a specific question ("does Nemotron support reasoning?",
       "how much does Claude cost?"), highlight the relevant field in your response.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `only works with OpenRouter backends` | Active profile is local (LM Studio / Ollama / vLLM / llama.cpp) | Switch to a remote profile via `/llm-externalizer:configure` |
| `OpenRouter returned 404` | Model id is wrong (typo, missing prefix, wrong suffix) | Ask the user to double-check the exact id — OpenRouter is case-sensitive |
| `No endpoints found` | Model exists but has no active endpoints | Model may be deprecated; suggest an alternative |
| `could not reach OpenRouter` | Network issue | Retry or check `/llm-externalizer:discover` for service status |

## Examples

### Check supported parameters for a model

```json
{ "tool": "or_model_info", "model": "nvidia/nemotron-3-super-120b-a12b:free" }
```

Returns:
```
# NVIDIA: Nemotron 3 Super (free)
**id**: `nvidia/nemotron-3-super-120b-a12b:free`
**architecture**: in: text · out: text

## Endpoints (1)

### Nvidia
- **context_length**: 262,144 tokens
- **max_completion_tokens**: 262,144
- **quantization**: unknown
- **pricing**: prompt free, completion free
- **supported_parameters** (10): include_reasoning, max_tokens, reasoning, response_format,
  seed, structured_outputs, temperature, tool_choice, tools, top_p
- **uptime**: 97.1% (30m) · 97.6% (1d)
- **latency** (30m): p50 12166ms · p75 26795ms · p90 52621ms · p99 106950ms
- **throughput** (30m): p50 15 tok/s · p75 23 tok/s · p90 31 tok/s · p99 49 tok/s
```

### Compare pricing across providers

```json
{ "tool": "or_model_info", "model": "meta-llama/llama-3.3-70b-instruct" }
```

Returns one section per endpoint (provider) with pricing, so you can pick the cheapest.

### Verify a reasoning-capable model

```json
{ "tool": "or_model_info", "model": "anthropic/claude-sonnet-4.5" }
```

Check the `supported_parameters` list for `reasoning` to confirm the model accepts it.

## Notes

- The tool returns **ONLY** data from `/v1/models/{id}/endpoints`. If you need model
  *pricing* aggregated across the whole catalog, use the top-level `/v1/models` endpoint
  (not currently wrapped by this plugin).
- Results are **live** — not cached in the MCP server side. Every call hits OpenRouter.
  Safe to call repeatedly.
- The `:free` tier of a model often has FEWER supported parameters than the paid tier.
  For example, `nvidia/nemotron-3-super-120b-a12b:free` does NOT support `frequency_penalty`,
  `presence_penalty`, `top_k`, `min_p`, `stop`, or `repetition_penalty` — while the paid
  `nvidia/nemotron-3-super-120b-a12b` does support all of them.
