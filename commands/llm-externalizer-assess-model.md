---
name: llm-externalizer-assess-model
description: |-
  Assess ONE OpenRouter model against EVERY LLM tool's per-tool REQUIREMENTS
  (TRDD-f45eeaa0) — free: makes NO LLM call (no token cost), only a public
  model-catalog fetch (no API key). Reports, per tool, whether the model meets
  that tool's hard requirements (cost / context / output / params) and which of
  the qualifying tools ALSO have a benchmark gate to run before assignment. Does
  NOT run any benchmark. Use to vet a candidate model across the whole tool
  surface at a glance. Trigger with "assess model X", "which tools can model X
  serve", "does model X meet the requirements".
allowed-tools:
  - Bash
argument-hint: "<openrouter-model-id>"
effort: low
---

Run the command below. Print its final line. Nothing else.

## Run

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --assess-model $ARGUMENTS
```

`$ARGUMENTS` is the model id (e.g. `google/gemini-2.5-flash`). Free: one public
catalog fetch, no API key, no LLM call, $0. It runs NO benchmark — the per-tool
benchmark gate is each tool's own command.

## Report

The CLI prints the full per-tool table, then a final stdout line:

```
[OK] <id> meets the requirements of <N>/<M> LLM tool(s)
[FAILED] <reason>            # e.g. the id is not in the OpenRouter catalog
```

Print that final line **verbatim** and stop. The table above it is the user's
output, not yours to re-format.

## Adopting the model (scripted — never a hand edit)

Only when the user asks to adopt it:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --adopt <MODEL_ID> --adopt-into model
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --adopt <MODEL_ID> --adopt-into tool:<tool>
```

The CLI re-checks the requirements gate and refuses to write a model that fits
nothing. Print its final line verbatim.
