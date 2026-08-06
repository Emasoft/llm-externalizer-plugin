# Ensemble Auto-Selection — full algorithm & rules

The single source of truth for *picking* lives in code (see "Where the rules
live" below). This document is the human-readable mirror of that logic; the
code is authoritative. Edit the code SoT, then update this file to match.

## Hard filters (qualifier pool)

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

## Ranking (after the hard filters)

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

## What the rule is NOT

- It is **not** "always pick the cheapest model" — F1 wins; ties go to cost,
  but the F1 floor still applies first.
- It is **not** "always pick the fastest" — latency is the final tie-break.
- It is **not** "always pick `:free`" — free models log prompts to the
  provider, which is unacceptable for proprietary code.
- It is **not** "ask the user" — the user has delegated this decision.

## Workflow when a model 404s

1. Confirm the 404 is **persistent**, not transient (one model, 3+ retries
   all hit the same `400|404|410` with "deprecated" / "removed" / "not
   available" in the body — OpenRouter retires models silently, so the
   model that 404s today may be one of the current defaults). If the error
   self-recovers, skip rotation.
2. Read `~/.llm-externalizer/benchmark-results.json` — if it is fresher than
   24 hours and contains ≥ 3 qualifying survivors, jump to step 4.
3. Run `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext-benchmark"` (no flags) to refresh the
   cache. The roster comes from OpenRouter's `programming` category + any
   `--include` baselines.
4. Run `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext-benchmark" --from-cache --pick-top-n 3 --apply-profile <active>`.
5. Tell the user what changed (old → new model IDs, F1, cost, latency) and
   that they should run `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" reset` to reload.
6. Do **not** ask the user to pick — the user has delegated this decision.

## Where the rules live (single source of truth)

All paths are repo-relative from the plugin root:

| What | Where |
|------|-------|
| The cost ceiling (< $1/M in & out) | `DEFAULT_CRITERIA` in `scripts/llm-ext/src/benchmark/discover.ts` |
| The qualifier filter | `qualify()` in `scripts/llm-ext/src/benchmark/discover.ts` |
| The picker (F1 → cost → latency) | `pickTopN()` in `scripts/llm-ext/src/benchmark/pick.ts` |
| The min-F1 threshold (default 0.95) | `DEFAULT_PICK_OPTIONS` in `scripts/llm-ext/src/benchmark/pick.ts` |
| The settings.yaml mutator | `applyPicksToSettings()` in `scripts/llm-ext/src/benchmark/pick.ts` |
| The CLI surface | `scripts/llm-ext/src/benchmark/index.ts` (`--pick-top-n`, `--apply-profile`, `--from-cache`, `--min-f1`) |

If a user asks to change a rule, edit the relevant SoT and add a unit test to
`pick.test.ts` covering the change. The skill body is the human-readable
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
