---
name: llm-externalizer-ensemble-autoselect
description: |-
  Use when an ensemble model has 404'd / been deprecated / is misbehaving,
  when the user asks "rotate the ensemble", "swap a broken model",
  "pick a better ensemble", "auto-pick models", or when LLM Externalizer
  request errors show consistent failures on one of the three configured
  models. Encodes the cost rule (input AND output both strictly < $1/M)
  and the F1-then-cost selection algorithm.
argument-hint: "[--apply | --dry-run] [--profile <name>]"
effort: medium
---

# LLM Externalizer — Ensemble Auto-Selection

## Overview

Picks three OpenRouter models for the active `remote-ensemble` profile **without
asking the user which specific models** — choose by yourself from the qualifying
candidates. The user has delegated this decision; do not prompt them for the picks.

The benchmark is the **same TypeScript-AST keyword-classification task** the
`llm-ext-benchmark` CLI already runs (`mcp-server/src/benchmark/`). It scores
every qualifying model with a `meanF1` between 0 and 1; selection then sorts
the survivors and takes the top three.

## When to use

Auto-trigger when **any** of the following surfaces:

- An ensemble call returns `API error 404 (openrouter): {... "deprecated" ...}`.
  This is the exact signature seen for `x-ai/grok-4.1-fast` on 2026-05-23 —
  OpenRouter retires models without a settings.yaml-side warning.
- A model returns a 4xx/5xx **consistently** (3+ retries fail with the same
  error class) — drift, deprovisioning, or upstream provider downtime.
- The user types any of: "rotate ensemble", "swap broken model",
  "auto-pick models", "pick a better ensemble", "the ensemble is broken".
- The user explicitly invokes `/llm-externalizer-ensemble-autoselect` or asks
  for ensemble selection without naming specific models.

Do **not** auto-rotate on transient 5xx-bursts that recover on retry; the
existing retry layer handles that. Rotation is for permanent drift.

## Selection rules (the lessons we learned)

These rules are the single source of truth for picking. Edit the CLI / this
skill if the rules change; do not encode them anywhere else.

### Hard filters (qualifier pool)

A model is **eligible** only if every one of these holds:

1. `pricing.prompt`     **strictly less than** `$1.00 / 1M tokens`
2. `pricing.completion` **strictly less than** `$1.00 / 1M tokens`
3. `context_length` ≥ 128,000 tokens
4. `top_provider.max_completion_tokens` ≥ 64,000 tokens (or unlimited)
5. `supported_parameters` includes `structured_outputs` OR `response_format`
6. `supported_parameters` includes `reasoning` OR `include_reasoning`
7. ID does not end in `:free` (free-tier models log prompts upstream)

The cost ceiling is intentionally aggressive — an ensemble call hits all three
models, so a $2/M model triples the per-call cost. Models like
`gemini-3.1-flash-lite-preview` (output $1.50/M) and `openai/gpt-5.4-nano`
(output $1.25/M) **do not qualify** under this filter. To use them anyway,
the operator must `--include` them as baselines (skipping the filter) or set
them manually in `settings.yaml`.

These filters live in `DEFAULT_CRITERIA` in
[mcp-server/src/benchmark/discover.ts](../../mcp-server/src/benchmark/discover.ts).
Edit there if the user changes the policy.

### Ranking (after the hard filters)

Among the survivors of the benchmark:

1. Sort by `meanF1` **descending**.
2. Tie-break by `actualCost` **ascending** (in-batch USD, not $/M).
3. Final tie-break by `latencyMs` **ascending**.

Then take the **top three**.

A surviving model must also:

- Have `meanF1 >= 0.95` (`--min-f1`, override only with strong reason).
- Have `schemaCompliant === true` (otherwise downstream JSON parsers break).

If fewer than three survive, **do not silently fall back** — surface the
shortage and let the user decide whether to lower `--min-f1`, broaden the
search, or accept fewer than three models.

### What the rule is NOT

- It is **not** "always pick the cheapest model" — F1 wins ties go to cost,
  but the F1 floor still applies first.
- It is **not** "always pick the fastest" — latency is the final tie-break.
- It is **not** "always pick `:free`" — free models log prompts to the
  provider, which is unacceptable for proprietary code.
- It is **not** "ask the user" — the user has delegated this decision.

## How to run it

Three modes, in increasing automation:

### Manual: benchmark + show picks (no settings.yaml change)

```bash
llm-ext-benchmark --pick-top-n 3
```

Prints the top-3 settings.yaml block to stdout. Operator pastes it manually.

### Semi-auto: benchmark + apply to a named profile

```bash
llm-ext-benchmark --pick-top-n 3 --apply-profile remote-ensemble-geminigrok
```

Runs the benchmark, picks top 3, mutates
`~/.llm-externalizer/settings.yaml` so the named profile's `model` /
`second_model` / `third_model` are the new picks. Atomic (tmp + rename).
Other profiles, `active:`, comments preserved.

After the apply, call the `reset` MCP tool (or restart Claude Code) so the
running server picks up the new ensemble.

### Cache: re-pick without burning more API calls

```bash
llm-ext-benchmark --from-cache --pick-top-n 3 --apply-profile <name>
```

Skips the benchmark entirely; picks straight from
`~/.llm-externalizer/benchmark-results.json` (the JSON sidecar always written
by a fresh benchmark run). Useful when you've just benchmarked and want to
try a different `--min-f1` or `--profile` without paying again.

## Workflow when a model 404s

1. Confirm the 404 is **persistent**, not transient (one model, 3+ retries
   all hit the same `400|404|410` with "deprecated" / "removed" / "not
   available" in the body). If the error self-recovers, skip rotation.
2. Read `~/.llm-externalizer/benchmark-results.json` — if it's fresher than
   24 hours and contains ≥ 3 qualifying survivors, jump to step 4.
3. Run `llm-ext-benchmark` (no flags) to refresh the cache. The roster comes
   from OpenRouter's `programming` category + any `--include` baselines.
4. Run `llm-ext-benchmark --from-cache --pick-top-n 3 --apply-profile <active>`.
5. Tell the user what changed (old → new model IDs, F1, cost, latency) and
   that they should call the `reset` MCP tool to reload.
6. Do **not** ask the user to pick — the lesson here is "the user has
   delegated this decision."

## Where the rules live (single source of truth)

| What | Where |
|------|-------|
| The cost ceiling (< $1/M in & out) | `DEFAULT_CRITERIA` in `mcp-server/src/benchmark/discover.ts` |
| The qualifier filter | `qualify()` in same file |
| The picker (F1 → cost → latency) | `pickTopN()` in `mcp-server/src/benchmark/pick.ts` |
| The min-F1 threshold (default 0.95) | `DEFAULT_PICK_OPTIONS` in same file |
| The settings.yaml mutator | `applyPicksToSettings()` in same file |
| The CLI surface | `mcp-server/src/benchmark/index.ts` (`--pick-top-n`, `--apply-profile`, `--from-cache`, `--min-f1`) |

If a user asks to change the rule, edit the relevant SoT and add a unit test
to `pick.test.ts` covering the change. The skill body is the human-readable
mirror; the code is authoritative.

## Anti-patterns

- **Do not** prompt the user "which 3 models should I pick?" — that's the
  whole point of automation.
- **Do not** silently apply `--include` overrides — `--include` is for
  benchmarking the current ensemble *for comparison*, not for selection.
- **Do not** lower `--min-f1` automatically to make a pick succeed — surface
  the shortage and wait.
- **Do not** rotate on a single 5xx — only on persistent 4xx with a
  deprecation signal.
- **Do not** edit settings.yaml outside `applyPicksToSettings()` — the
  atomic mutator is the only safe path.
- **Do not** write the report anywhere other than the user-configured
  `output_dir` (see the report-output-folder rule).

## Output

When invoked:

- Print the resolved picks (one line per pick: id, meanF1, cost, latency).
- Print the proposed settings.yaml block.
- If `--apply-profile` was given, print the old → new diff.
- One sentence: "Run the `reset` MCP tool or restart Claude Code to reload."
- Do not paste long benchmark reports into chat — those live at
  `$MAIN_ROOT/reports/llm-externalizer/`.
