---
name: llm-externalizer-search-existing-benchmark
description: |-
  Qualify OpenRouter model(s) for the search_existing_implementations task
  (duplicate-implementation match / "does this already exist?") against a labeled
  GOLDEN FIXTURE codebase, scored DETERMINISTICALLY by driving the REAL
  search-existing pipeline — precision/recall/F1 over the known duplicate
  locations, NO LLM judge. Recommends the best SAME-OR-CHEAPER model that PASSES
  (micro-F1 + micro-recall + coverage floors). A pricier model is NEVER
  auto-selected. Trigger with "benchmark the search-existing model", "qualify a
  model for search_existing_implementations", or "is model X good enough for
  duplicate detection".
allowed-tools:
  - mcp__llm-externalizer__search_existing_benchmark
argument-hint: "[models=<id,[id...]>] [qualifying_top_n=<N>] [force] [output_dir=<abs path>]"
effort: high
---

# search_existing_benchmark — model qualification for search_existing_implementations

The `search_existing_implementations` tool answers "is this feature already
implemented somewhere in the codebase?" — the core of PR-dedup review. Its
judgment quality depends on the model behind it. Because OpenRouter models change
often, this benchmark **formalizes the duplicate-detection task into a
re-runnable model-qualification gate** so a new model can only become the
`search_existing_implementations` model if it actually passes.

This is the second instance of the per-tool model-qualification framework (after
`security_triage_benchmark`): each tool defines its own requirements + benchmark,
and a model may serve a tool only if it meets the requirements AND passes that
tool's benchmark.

## What it does

1. **Loads the golden fixture dataset** — a real, hand-authored mini-codebase
   under `mcp-server/benchmark-fixtures/search-existing/` where every feature
   location is KNOWN (retry-with-backoff, LRU cache, memoization, slugify,
   debounce, HMAC tokens, leveled logger, plus an absent-feature case that
   measures hallucination resistance). Each case states the exact files a correct
   run must answer YES for; every other discovered file must be NO. Because the
   truths are unambiguous, scoring is purely MECHANICAL (no LLM judge).
2. **Builds the candidate pool** — either the explicit `models` you pass, or an
   auto-discovered set of OpenRouter models that (a) meet this tool's per-tool
   requirements (structured output + reasoning + a 128K context) and (b) are
   **not pricier than the incumbent default** (no budget is spent benchmarking a
   model the cost gate would reject).
3. **Scores each model via the REAL pipeline** — drives
   `runSearchExistingImplementations` in-process (same FFD bin-packed batching,
   same per-file-section prompt contract, same merged-report assembly), so the
   benchmark measures the model as the tool will actually use it. The pipeline's
   own per-file `## File:` sections are extracted and classified, then pooled
   into precision/recall/F1. Cached per-model-per-day.
4. **Applies the selection gate** and recommends the best eligible model.
5. **Writes a JSON + markdown report** to
   `<main-project-dir>/reports/search-existing-benchmark/` (anchored on
   `$CLAUDE_PROJECT_DIR`, then cwd — never git) and returns the
   recommendation + paths.

## Inputs

| Field | Required | Description |
|---|---|---|
| `models` | no | Explicit OpenRouter model id(s) to assess. When omitted, auto-discover the same-or-cheaper candidate pool. |
| `qualifying_top_n` | no | Cap the auto-discovered candidate pool (cheapest-first). Default 16. |
| `force` | no | Ignore the per-model-per-day cache and re-run every model. |
| `output_dir` | no | Report directory. Default `<main-project-dir>/reports/search-existing-benchmark/` (anchored on `$CLAUDE_PROJECT_DIR`, then cwd — never git). |

## The pass gate (how a model qualifies)

A model is recommended as the `search_existing_implementations` model ONLY if it
clears all three gates:

1. **Requirements** — meets the per-tool criteria (structured output + reasoning
   + a 128K context window; this is a cross-codebase reasoning task, so the bar
   is higher than security triage's).
2. **Benchmark PASS** — three deterministic floors ALL hold over the pooled
   confusion counts:
   - **micro-F1 ≥ 0.85** — overall precision/recall balance.
   - **micro-recall ≥ 0.85** — a missed duplicate (the reviewer deletes nothing)
     costs more than a spurious one, so recall has its own floor.
   - **coverage ≥ 0.90** — at least 90% of scanned files received a parseable
     verdict (a model that emits malformed sections is penalized).
3. **Cost** — not pricier than the incumbent on EITHER the input or output axis.
   We never auto-bump to a pricier model. Among eligible same-or-cheaper passers,
   the best micro-F1 wins (ties → lower cost → lower latency).

If no eligible same-or-cheaper model passes, the incumbent is kept — the
benchmark never leaves the tool without a model and never recommends a pricier
one.

## Output

```
<summary line: KEEP <model> | RECOMMEND switch: <old> -> <new>>
recommended_model=<id>
changed=<true|false>
spend=$<X>
report=<absolute path to .md report>
json=<absolute path to .json report>
```

The recommended model is **surfaced for the operator to adopt** — either per
call via the `search_existing_implementations` `model` parameter, or persistently
via the `tool_models.search_existing_implementations` field on a settings.yaml
profile ([[TRDD-f45eeaa0]]; see README → Configuration § F. Per-tool model
overrides). The benchmark is **ADVISORY only** — it does not auto-edit source or
config.

## How to assess a new model

```
/llm-externalizer:llm-externalizer-search-existing-benchmark models=vendor/new-model
```

Read the report's per-case breakdown to see exactly which fixture cases the model
got right, where it under-flagged (missed a real duplicate → false negative), and
where it over-flagged (claimed a non-duplicate → false positive). To re-qualify
the whole pool after a model shake-up, run with no arguments.

## CLI equivalent

```
llm-ext-benchmark --search-existing                 # auto-discover + recommend
llm-ext-benchmark --search-existing <id> [<id>...]  # assess specific models
llm-ext-benchmark --search-existing --force         # ignore the per-day cache
```

## Environment

Set `$OPENROUTER_API_KEY` (or the plugin's `userConfig.openrouter_api_key`).
Unlike `search_existing_implementations` (which runs on your configured model),
this is an explicit assessment action and requires a key — a benchmark you cannot
run is useless.
