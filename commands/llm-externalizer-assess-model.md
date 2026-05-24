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
  - mcp__llm-externalizer__assess_model
argument-hint: "model=<openrouter-model-id>"
effort: low
---

# assess_model — cross-tool requirements assessment

Each LLM-using tool in this plugin declares its own model REQUIREMENTS (cost
ceiling, minimum context, minimum output, structured-output / reasoning support)
and, when one exists, a model-judgment BENCHMARK that gates selection
([[TRDD-f45eeaa0]]). This command answers a single question for one candidate
model: **which tools can it serve?**

It is the REQUIREMENTS half of the per-tool gate, and it is **free** — no LLM
call and no token cost; it makes a single public OpenRouter model-catalog fetch
(no API key). It does NOT run any benchmark; for the tools that carry a benchmark
gate it tells you to run that benchmark separately.

## What it does

1. **Fetches** the OpenRouter model catalog and finds the model id.
2. **Checks the requirements** of every registered LLM tool against the model's
   advertised capabilities + pricing (the single-sourced `qualify` predicate).
3. **Reports** a per-tool `OK` / `NO` table: for a passing tool, whether it ALSO
   needs a benchmark pass; for a failing tool, the first failing requirement.

## Inputs

| Field | Required | Description |
|---|---|---|
| `model` | yes | OpenRouter model id, e.g. `google/gemini-2.5-flash`. |

## Output

A human-readable block:

```
Model: <id> (<name>)
Meets requirements for <K>/<N> LLM tools.

  security_scan    OK  benchmark: security-triage (run before assigning)
  mass_scout       OK  benchmark: keyword-classification (run before assigning)
  code_task        OK  requirements-only
  chat             OK  requirements-only
  ...
  <tool>           NO  <first failing requirement, e.g. "context 32000 < required 128000">

Note: security_scan, mass_scout ALSO require a benchmark pass before assignment —
run that tool's benchmark (security_scan → /llm-externalizer-security-triage-benchmark).
```

`OK` means the model meets that tool's hard requirements. A tool tagged
`benchmark: <id>` additionally requires a benchmark PASS before the model should
be assigned to it — assessment alone is necessary but not sufficient for the
benchmarked tools. `NO` rows carry the specific reason (cost over the ceiling,
context too small, missing structured-output or reasoning support, …).

## How to act on the result

- A tool shown `OK` with `requirements-only` can take the model via the
  settings `tool_models.<tool>` override (or the tool's `model` parameter).
- A tool shown `OK` with a `benchmark:` tag — run that benchmark first
  (`security_scan` → `/llm-externalizer-security-triage-benchmark`), and only
  assign the model if it PASSES. The standing rule still holds: never auto-bump
  to a pricier model.
- A tool shown `NO` cannot take the model; the reason tells you why.

## CLI equivalent

```
llm-ext-benchmark --assess-model google/gemini-2.5-flash
```

## Environment

No API key required — the OpenRouter model catalog is public. (Running a tool's
benchmark afterwards does need `$OPENROUTER_API_KEY`.)
