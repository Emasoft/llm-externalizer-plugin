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

1. [ ] Parse the user's prompt for the **exact OpenRouter model id** (first arg) —
       case-sensitive, vendor-prefixed, with any `:free` / `:thinking` / `:beta`
       suffix. Also scan the args for optional format flags:
       - `--no-color` / `--nocolor` / `--bw` / `--mono` → forward `--no-color` (b/w terminals)
       - `--markdown` / `--plain` → forward `--markdown` (pipe-delimited markdown table)
       - `--json` / `--raw` → forward `--json` (raw OpenRouter JSON for scripts/jq)
2. [ ] If the user gave only a partial name, ask for the full id.
3. [ ] Run: `npx llm-externalizer model-info "<exact-id>" [flags]`
       Default (no flags) keeps colors ON — Claude Code renders ANSI codes so bright
       cyan borders, green capability flags, and yellow/red latency percentiles all
       display correctly. Pass `--no-color` only when the user's terminal is
       monochrome or they explicitly asked for it.
4. [ ] **Copy the entire CLI stdout verbatim into your response as a fenced code
       block.** Claude Code collapses long Bash tool output behind a "+N lines" fold,
       so reprint it. Do NOT paraphrase or summarize. Only add commentary on an
       explicit follow-up question.
5. [ ] On error, see [references/errors.md](references/errors.md).

## Output

Per endpoint: context, max_completion, quantization, capability flags (reasoning,
tools, structured output, caching), pricing ($/M tokens), uptime (5m/30m/1d),
latency + throughput percentiles, supported_parameters. Live data, no cache.

## Examples

```bash
# Default colored table
npx llm-externalizer model-info "nvidia/nemotron-3-super-120b-a12b:free"

# Compare providers (Llama 3.3 has 17 endpoints)
npx llm-externalizer model-info "meta-llama/llama-3.3-70b-instruct"

# Markdown table — renders in any markdown viewer
npx llm-externalizer model-info "google/gemini-2.5-flash" --markdown

# Raw JSON to stdout (for jq / scripts)
npx llm-externalizer model-info "anthropic/claude-sonnet-4.5" --json

# Raw JSON written to a file
npx llm-externalizer model-info "x-ai/grok-4.1-fast" --json grok-info.json
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
