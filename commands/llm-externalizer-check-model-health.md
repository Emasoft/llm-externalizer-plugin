---
name: llm-externalizer-check-model-health
description: |-
  Self-check the CONFIGURED model(s) of the active profile (TRDD-828238b5) —
  free: makes NO LLM call (no token cost), only a public model-catalog fetch (no
  API key). For the main / second / third model and every tool_models entry it
  reports: (1) PRESENCE — is the id still in the OpenRouter catalog or
  deprecated/removed; (2) COST DRIFT — has the price moved vs a seeded baseline;
  (3) REQUIREMENTS REGRESSION — does it still meet the requirements of every tool
  it serves. Advisory only — never changes settings (the server is read-only).
  Trigger with "check model health", "is my model outdated", "did the price
  change", "are my configured models still valid".
allowed-tools:
  - mcp__llm-externalizer__check_model_health
argument-hint: ""
effort: low
---

# check_model_health — configured-model self-check

This command answers the questions you would otherwise check by hand for the
model(s) your active profile is configured to use: **is each still available,
has its price moved, and does it still meet the requirements of the tools it
serves?** ([[TRDD-828238b5]])

It is **free** — no LLM call, no token cost; it makes a single public OpenRouter
model-catalog fetch (no API key) and diffs it against a seeded baseline. It is
**advisory only**: it writes a report and prints a summary, and NEVER changes
your settings (the MCP server is read-only by design — model/profile changes are
user-only, see `/llm-externalizer:llm-externalizer-change-model`).

## What it checks (for main / second / third model + every `tool_models` entry)

1. **Presence** — is the model id still in the OpenRouter catalog? An absent id
   is **CRITICAL**: it has been deprecated/removed and calls will fail.
2. **Cost drift** — compares the live price against a baseline snapshot at
   `~/.llm-externalizer/model-baseline.json`. The first run seeds the baseline
   (no drift reported); later runs flag a meaningful price increase as **WARN**
   (and note decreases). The baseline refreshes on every run.
3. **Requirements regression** — re-runs each served tool's hard-requirements
   gate (`qualifyModelForTool`). A model that no longer meets a served tool's
   requirements is **WARN**.

## Inputs

None — it always inspects the *active* profile from `~/.llm-externalizer/settings.yaml`.

## Output

A human-readable summary plus a Markdown report path under
`<project>/reports/model-health/`:

```
Model health — profile 'remote-ensemble-geminigrok' — 2026-05-25T03:10:00+0200
3 configured model(s): 2 ok, 1 warn, 0 critical

✓ google/gemini-2.5-flash  [model]
    - healthy
! x-ai/grok-4.1-fast  [second_model]
    - input price up 33.3% ($0.300→$0.400/M)
✓ qwen/qwen3.6-plus  [third_model]
    - healthy

Report: /path/to/project/reports/model-health/20260525_031000+0200-model-health-<profile>.md
```

## How to act on the result

- **CRITICAL** (removed/deprecated) — pick a replacement and update
  `~/.llm-externalizer/settings.yaml` by hand (then `reset`). To vet candidates,
  use `/llm-externalizer:llm-externalizer-assess-model` (requirements) and, for
  benchmarked tools, the tool's benchmark.
- **WARN — cost drift** — decide whether the new price is acceptable; switch
  model in settings.yaml if not.
- **WARN — requirements regression** — the model lost a capability a served tool
  needs (e.g. structured output); replace it for that tool via
  `tool_models.<tool>`.

The standing rule holds: model changes are user-only and never auto-applied.

## CLI equivalent

```
llm-ext-benchmark --check-health
```

## Environment

No API key required — the OpenRouter model catalog is public.
