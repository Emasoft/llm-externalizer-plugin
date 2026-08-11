---
name: llm-externalizer-or-model-info
description: |-
  Reference for querying OpenRouter model details — supported params, pricing,
  latency, uptime, quantization. Real invocation path is the
  `llm-ext or-model-info --model <id>` CLI (also `or-model-info-table` for a
  colored table, `or-model-info-json` for raw JSON); this skill is loaded as
  background reference for those, not a standalone slash command.
argument-hint: "--model <model-id>"
effort: low
user-invocable: false
---

# LLM Externalizer — OpenRouter Model Info

## Overview

Query OpenRouter's `/v1/models/{exact_id}/endpoints` for a specific model and display
context length, pricing, **supported request-body parameters**, quantization, uptime,
latency, and throughput. Uses the LLM Externalizer CLI (not the MCP tool) so it works
from subagents — MCP tools from plugins are not available in subagent contexts.

## Prerequisites

- `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext"` (bundled with the plugin). An `npm i -g`
  install also provides `llm-ext` / `llm-externalizer` on PATH; the plugin itself
  does NOT put `llm-externalizer` on PATH, so prefer the explicit path above.
- `$OPENROUTER_API_KEY` set, OR active profile is OpenRouter-backed

## Instructions

Copy this checklist and track your progress:

1. [ ] Parse the user's prompt for the **exact OpenRouter model id** —
       case-sensitive, vendor-prefixed, with any `:free` / `:thinking` / `:beta`
       suffix. Then pick the command by desired output format:
       - Colored terminal table → `or-model-info-table`
       - Markdown report (default text) → `or-model-info`
       - Raw JSON → `or-model-info-json` (optional `--file_path` to write to a file
         instead of stdout)
2. [ ] If the user gave only a partial name, ask for the full id.
3. [ ] Run: `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" <or-model-info|or-model-info-table|or-model-info-json> --model "<exact-id>"`
4. [ ] **Stop. Do not reprint, paraphrase, summarize, or add commentary.** The Bash
       tool output pane renders the ANSI-colored table natively. If Claude Code
       collapses it behind a "+N lines" fold the user will expand it with ctrl+o
       themselves. Your response should contain nothing beyond what's necessary to
       confirm the command ran — ideally just acknowledge completion in a single
       short sentence.
5. [ ] Only add a textual summary if the user explicitly asks a follow-up question
       beyond "show me the info" (e.g. "which provider is cheapest?",
       "does it support reasoning?"). Otherwise the table speaks for itself.
6. [ ] On error, see [references/errors.md](references/errors.md).

## Output

Per endpoint: context, max_completion, quantization, capability flags (reasoning,
tools, structured output, caching), pricing ($/M tokens), uptime (5m/30m/1d),
latency + throughput percentiles, supported_parameters. Live data, no cache.

## Examples

```bash
# Colored terminal table
"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" or-model-info-table --model "nvidia/nemotron-3-super-120b-a12b:free"

# Compare providers (Llama 3.3 has 17 endpoints) — markdown report
"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" or-model-info --model "meta-llama/llama-3.3-70b-instruct"

# Markdown report — renders in any markdown viewer
"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" or-model-info --model "google/gemini-2.5-flash"

# Raw JSON to stdout (for jq / scripts)
"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" or-model-info-json --model "anthropic/claude-sonnet-4.5"

# Raw JSON written to a file
"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" or-model-info-json --model "x-ai/grok-4.1-fast" --file_path grok-info.json
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
| `Network error` | Retry once; check `/llm-externalizer:llm-externalizer-discover` for service status |
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
