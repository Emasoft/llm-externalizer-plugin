---
name: llm-externalizer-discover-new-models
description: |-
  Autodiscover models that newly appeared in the OpenRouter catalog since the
  last run (TRDD-828238b5) — free: makes NO LLM call (no token cost), only a
  public model-catalog fetch (no API key). Diffs the live catalog against a
  seeded snapshot and, for each NEW model id, assesses it against every LLM
  tool's per-tool requirements so you can see at a glance which arrivals are
  worth adopting. Advisory only — never changes settings (the server is
  read-only). Trigger with "any new models", "discover new models", "what new
  models are available", "check for newer/cheaper models".
allowed-tools:
  - mcp__llm-externalizer__discover_new_models
argument-hint: "[qualifying-only]"
effort: low
---

# discover_new_models — new OpenRouter arrivals self-check

This command answers "**are there new models I should consider?**" without you
having to eyeball the OpenRouter catalog by hand. ([[TRDD-828238b5]])

It is **free** — no LLM call, no token cost; it makes a single public OpenRouter
model-catalog fetch (no API key) and diffs it against a seeded snapshot at
`~/.llm-externalizer/catalog-snapshot.json`. It is **advisory only**: it writes a
report and prints a summary, and NEVER changes your settings (the MCP server is
read-only by design — model/profile changes are user-only, see
`/llm-externalizer:llm-externalizer-change-model`).

## What it does

1. **Fetches** the live OpenRouter catalog (public, no key).
2. **Diffs** it against the on-disk snapshot — any id NOT in the snapshot is a
   **new arrival**. The first run seeds the snapshot and reports zero arrivals
   (every id is trivially "new" the first time).
3. **Assesses** each new arrival against every LLM tool's per-tool requirements
   (`assessModelAcrossTools`), so the report shows, per arrival, how many tools
   it qualifies for and which of those also carry a benchmark gate.
4. **Refreshes** the snapshot so the next run only shows what is new since now.

The same public catalog fetch also exposes two credit-free quality indexes — the
**codex index score** (`benchmarks.artificial_analysis.coding_index`, 0–100) and the
**design arena code-categories ELO** (the `benchmarks.design_arena[]` entry where
`arena=="models"` and `category=="codecategories"`, field `.elo`). The benchmark
commands (`/llm-externalizer-benchmark` and the ensemble autoselect) use these to
pre-rank candidates and cap paid runs via `--qualifying-top-n`; coverage is partial
(~60/339 carry a codex score, ~94/339 an ELO) and a missing index is UNKNOWN, never a
disqualifier. A model OpenRouter prices at exactly `$0` with no `:free` suffix (e.g.
`openrouter/owl-alpha`, an open-beta "free for now" model) is recognized as free — it
competes as a `$0` candidate, and `/llm-externalizer-bench-free-pool` auto-discovers it
into the free benchmark after the catalog confirms the price is `$0`.

## Inputs

- `qualifying-only` (optional) — when present, report only arrivals that meet at
  least one tool's requirements (hide the noise of models that fit nothing).

## Output

A human-readable summary plus a Markdown report path under
`<project>/reports/model-arrivals/`:

```
New model arrivals — 2026-05-25T03:40:00+0200
4 new since last snapshot (2 qualify for ≥1 tool); catalog size 318.
  2026-05-22  vendor/new-flash  — qualifies 9/12 (benchmark: security_scan)
  2026-05-20  vendor/new-mini   — qualifies 3/12
  2026-05-19  vendor/audio-x    — no fit
  2026-05-18  vendor/img-gen    — no fit

Report: /path/to/project/reports/model-arrivals/20260525_034000+0200-new-arrivals.md
```

## How to act on the result

Acting on an arrival is **user-only**:

1. Vet it with `/llm-externalizer:llm-externalizer-assess-model <id>`
   (requirements) and, for benchmark-gated tools, the tool's benchmark
   (`security_scan` → `/llm-externalizer:llm-externalizer-security-triage-benchmark`).
2. If it wins, edit `~/.llm-externalizer/settings.yaml` (the profile `model` /
   `second_model` / `third_model` or a `tool_models.<tool>` entry) by hand, then
   reload with `reset`.

The standing rule holds: model changes are user-only and never auto-applied.

## CLI equivalent

```
llm-ext-benchmark --new-arrivals [--qualifying-only]
```

## Environment

No API key required — the OpenRouter model catalog is public.
