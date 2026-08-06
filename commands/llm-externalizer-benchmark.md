---
name: llm-externalizer-benchmark
description: Benchmark OpenRouter programming-category models against a TypeScript classification task, then pick/apply the best ensemble. Filters by cost + capability, scores each candidate against 71 fixture functions + 3 literal keywords, writes a markdown comparison report. Use this to pick the cheapest model that still passes the real workload. Trigger with "rescan models", "update the models", "update/refresh the model ensemble", "find better or cheaper models", "run a full model rescan", "auto-pick the ensemble", "is there a better model now". This ONE command IS the whole rescan/benchmark/pick procedure — route here instead of hand-rolling a per-model loop.
allowed-tools:
  - Bash
argument-hint: "[--pick-top-n N] [--apply-profile NAME] [--include MODEL_ID]... [--dry-run] [--no-qualifying-cap] [--reasoning low|medium|high] [--seed N]"
effort: low
---

Run the command below. Print its final line. Nothing else.

## Run

ONE Bash call, with `run_in_background: true` (always — a sweep takes 10-30 min):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" $ARGUMENTS
```

The CLI does everything itself — prerequisite checks, discovery, cost/capability
filter, credit-free quality pre-ranking, the paid-candidate cap (`--qualifying-top-n`
defaults to **15** in code), the runs, the scoring, the report, the JSON cache, and —
with `--pick-top-n N --apply-profile P` — the atomic settings.yaml write.

You choose NOTHING. Add no flags of your own; forward `$ARGUMENTS` verbatim.

## Report

The CLI's last stdout line is exactly one of:

```
[OK] <summary>. Report: <absolute path>
[FAILED] <reason>
```

Print that line **verbatim** and stop. Do not read the report. Do not summarize,
re-word, or append next steps — the line already carries the counts and the path,
and the exit code already carries success/failure.

## Never

- Never re-implement the sweep as a per-model loop over `chat` / `code_task` /
  `or_model_info`: it costs real OpenRouter $ per call AND re-sends the whole
  transcript every turn — the 30-40M-token failure mode this command exists to prevent.
- Never retry a `[FAILED]` run. Never edit `settings.yaml` by hand; the CLI writes it.

## Flags the user may ask for (pass through; do not add unprompted)

| Goal | Flag |
|---|---|
| Preview the roster, $0, no API call | `--dry-run` |
| Pick the top 3 and write them to a profile | `--pick-top-n 3 --apply-profile remote-ensemble` |
| Exhaustive sweep (slow, costs more) | `--no-qualifying-cap` |
| Re-pick from the last run's cache, no new calls | `--from-cache --pick-top-n 3` |
| Include a specific model as a baseline | `--include vendor/model-id` |

Full flag list: `llm-ext-benchmark --help`.

## Why this stays a manual slash command (by design, TRDD-f1510055)

A sweep is a 10-30 minute, money-spending, cache-writing build step, not a
one-shot call an agent should trigger unattended. There is no automatic
trigger for it: it must be explicitly invoked, either via this slash command
or directly as `llm-ext-benchmark`. For a zero-cost variant scoped to the
free-model pool, see
`/llm-externalizer:llm-externalizer-bench-free-pool`.
