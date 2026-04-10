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

Query OpenRouter's `/v1/models/{exact_id}/endpoints` for a specific model and display
context length, pricing, **supported request-body parameters**, quantization, uptime,
latency, and throughput. Uses the LLM Externalizer CLI (not the MCP tool) so it works
from subagents — MCP tools from plugins are not available in subagent contexts.

## Prerequisites

- `llm-externalizer` CLI on PATH (bundled with the plugin)
- `$OPENROUTER_API_KEY` set, OR active profile is OpenRouter-backed

## Instructions

Copy this checklist and track your progress:

1. [ ] Parse the user's prompt for the **exact OpenRouter model id** — case-sensitive,
       with vendor prefix and any `:free` / `:thinking` / `:beta` suffix.
2. [ ] If the user gave only a partial name, ask for the full id.
3. [ ] Run: `npx llm-externalizer model-info "<exact-id>" --no-color`
       Use `--no-color` because ANSI codes are stripped in the rendered transcript
       and just add noise. The rich border / row separators / column alignment all
       survive without color.
4. [ ] **Copy the entire CLI stdout verbatim into your response as a fenced code
       block.** Claude Code collapses long Bash tool output behind a "+N lines" fold,
       so the user cannot see the table unless you reprint it. Do NOT paraphrase,
       summarize, or rewrite it — the CLI already produces the final format with
       borders, row separators, capability flags, percentiles, and a footer legend.
       Your response must contain the raw output, nothing more unless the user
       asked a follow-up question.
5. [ ] On error, see [references/errors.md](references/errors.md).

## Output

An ANSI-colored Unicode-bordered table with one section per endpoint (provider):
context_length, max_completion_tokens, max_prompt_tokens, quantization, pricing
(converted to $/M tokens), uptime (30m + 1d), latency percentiles, throughput
percentiles — followed by a grid of supported_parameters with green checkmarks.
Color key: green = good values, yellow = borderline, red = poor.

Pass `--markdown` for plain markdown instead (useful when piping to another tool).
Pass `--no-color` to suppress ANSI codes for log capture. Results are live — no
caching. Safe to call repeatedly.

## Examples

Verify Nemotron's supported parameters:

```bash
npx llm-externalizer model-info "nvidia/nemotron-3-super-120b-a12b:free"
```

Compare providers hosting Llama 3.3:

```bash
npx llm-externalizer model-info "meta-llama/llama-3.3-70b-instruct"
```

Check reasoning support on Claude, capture to a file without colors:

```bash
npx llm-externalizer model-info "anthropic/claude-sonnet-4.5" --no-color > claude-info.txt
```

Get plain markdown for further processing:

```bash
npx llm-externalizer model-info "google/gemini-2.5-flash" --markdown
```

See [references/example-output.md](references/example-output.md) for a full sample:
  - Sample response
  - Reading the output
  - Percentiles explained
  - Comparing multiple endpoints

And [references/use-cases.md](references/use-cases.md) for more scenarios:
  - Verify supported parameters before integrating a model
  - Compare pricing across providers hosting the same model
  - Debug slow or failing calls
  - Check quantization for quality trade-offs
  - Confirm context length and max tokens
  - Check reasoning support

## Error Handling

| Error | Resolution |
|-|-|
| `OpenRouter returned 404` | Wrong model id — check case, vendor prefix, `:free` / `:thinking` suffix |
| `No OpenRouter auth token available` | Set `$OPENROUTER_API_KEY` or switch to an openrouter-remote profile |
| `Network error` | Retry once; check `/llm-externalizer:discover` for service status |
| `OpenRouter returned no endpoints` | Model deprecated — suggest alternative |

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
  - Percentiles explained
  - Comparing multiple endpoints
- [references/use-cases.md](references/use-cases.md) — six common scenarios
  - Verify supported parameters before integrating a model
  - Compare pricing across providers hosting the same model
  - Debug slow or failing calls
  - Check quantization for quality trade-offs
  - Confirm context length and max tokens
  - Check reasoning support
