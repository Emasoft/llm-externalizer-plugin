---
name: llm-externalizer-or-model-info
description: |-
  Use when asking for OpenRouter model details — supported params, pricing, latency,
  uptime, quantization. Trigger with "openrouter model info", "or-model-info",
  "what params does X support", "show pricing for", "check model support".
version: 1.0.0
---

# LLM Externalizer — OpenRouter Model Info

## Overview

Query OpenRouter's `/v1/models/{exact_id}/endpoints` for a specific model. Returns
per-endpoint provider metadata: context length, pricing, **supported request-body
parameters**, quantization, uptime, latency, throughput. Requires the active LLM
Externalizer profile to be an OpenRouter profile.

## Prerequisites

- Active profile uses OpenRouter (not local LM Studio / Ollama / vLLM / llama.cpp)
- `$OPENROUTER_API_KEY` set in the MCP server's environment

## Instructions

Copy this checklist and track your progress:

1. [ ] Parse the user's prompt for the **exact OpenRouter model id**. The id is case-sensitive,
       includes the vendor prefix, and includes any `:free` / `:thinking` / `:beta` suffix.
2. [ ] If the user gave only a partial name (e.g. "nemotron", "claude"), ask for the full
       id or list likely candidates and pick one with the user.
3. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__or_model_info` with
       `{ "model": "<exact-id>" }`.
4. [ ] Present the returned markdown to the user. Highlight the field the user asked
       about (e.g. supported_parameters for "does X support reasoning", pricing for
       cost questions).

## Output

One markdown block with: model header, architecture line, short description, and
one section per endpoint containing context_length, max_completion_tokens,
max_prompt_tokens, quantization, pricing ($/M tokens), **supported_parameters**
(sorted list), uptime (30m / 1d), latency percentiles (ms), throughput percentiles
(tok/s). Live data — not cached. Safe to call repeatedly. Not an LLM call; does
not count toward session usage.

## Examples

Verify Nemotron's supported parameters:

```json
{ "tool": "or_model_info", "model": "nvidia/nemotron-3-super-120b-a12b:free" }
```

Compare providers hosting Llama 3.3:

```json
{ "tool": "or_model_info", "model": "meta-llama/llama-3.3-70b-instruct" }
```

Check reasoning support on Claude:

```json
{ "tool": "or_model_info", "model": "anthropic/claude-sonnet-4.5" }
```

For a full sample response see [references/example-output.md](references/example-output.md):
  - Sample response
  - Reading the output
  - Comparing multiple endpoints

For more scenarios see [references/use-cases.md](references/use-cases.md):
  - Verify supported parameters before integrating a model
  - Compare pricing across providers hosting the same model
  - Debug slow or failing calls
  - Check quantization for quality trade-offs
  - Confirm context length and max tokens
  - Check reasoning support

## Error Handling

| Error | Resolution |
|-|-|
| `only works with OpenRouter backends` | Switch to a remote profile via `/llm-externalizer:configure` |
| `OpenRouter returned 404` | Wrong model id — check case, vendor prefix, `:free` / `:thinking` suffix |
| `OpenRouter returned 401` | `$OPENROUTER_API_KEY` missing or invalid |
| `No endpoints found` | Model deprecated or all providers offline — suggest an alternative |

Full table in [references/errors.md](references/errors.md):
  - Error table
  - Debugging tips

## Resources

- [references/errors.md](references/errors.md) — all error cases and resolutions
  - Error table
  - Debugging tips
- [references/example-output.md](references/example-output.md) — full sample output
  - Sample response
  - Reading the output
  - Comparing multiple endpoints
- [references/use-cases.md](references/use-cases.md) — six common scenarios
  - Verify supported parameters before integrating a model
  - Compare pricing across providers hosting the same model
  - Debug slow or failing calls
  - Check quantization for quality trade-offs
  - Confirm context length and max tokens
  - Check reasoning support
