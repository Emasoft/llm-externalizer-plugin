---
name: llm-externalizer-mass-scout-estimate
description: |-
  Predict the cost / time / cap-skipped numbers for a fieldset against the
  registered files. Honors --budget-usd as a hard gate. Phase 3 of the
  pipeline.
allowed-tools:
  - mcp__llm-externalizer__mass_scout_estimate
argument-hint: "--db <path> --fields-file <json> [--budget-usd N] [--bucket <name>] [--workers N]"
effort: low
---

# Mass-scout — estimate

Pure cost / time / eligibility estimator. Walks the registry, counts
files that fit under the scout cap (default 40% of context), sums input
+ output token counts at the model's per-million prices, and computes a
wall-clock ETA at the worker count.

The output is small enough to return inline — no file is written.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db <path>` | yes | The registry from `mass-scout-register` |
| `--fields-file <json>` | yes | JSON fieldset describing what to extract (see skill) |
| `--budget-usd <usd>` | no | Refuses to schedule if `est_cost_usd > budget_usd` |
| `--bucket <name>` | no | Only count files in this preclassifier bucket |
| `--workers <n>` | no | Worker count for ETA math (default: 256) |
| `--per-call-seconds <s>` | no | Avg per-call wall time for ETA (default: 1.0) |
| `--expected-output-bytes <n>` | no | Predicted output JSON size per file (default: 200) |
| `--max-context-pct-scout <0..1>` | no | Override the default 40% scout cap |
| `--max-context-pct-register <0..1>` | no | Override the default 50% register cap |
| `--input-price-per-m <usd>` | no | USD per 1M input tokens (overrides KNOWN_PRICING) |
| `--output-price-per-m <usd>` | no | USD per 1M output tokens (overrides KNOWN_PRICING) |
| `--context-window <tokens>` | no | Tokens (overrides KNOWN_PRICING) |

If `--input-price-per-m` is set, all three pricing flags
(`--input-price-per-m`, `--output-price-per-m`, `--context-window`) must
be supplied together.

## Output

```
model=qwen/qwen-2.5-7b-instruct  context_window=32768
files_eligible=<N>
files_skipped_too_big=<K>
files_over_register_cap=<R>
total_input_tokens=<I>
total_output_tokens=<O>
est_cost_usd=$<X>
est_seconds=<S>
budget_usd=<usd>|(none)
budget_allowed=true|false
reason=<msg>          # only when allowed=false
```

## Budget gate

If you pass `--budget-usd 1.00` and the estimate is `$1.20`, the gate
flips to `budget_allowed=false` with a reason. The downstream `scout`
sub-command does NOT itself enforce the budget — it's the caller's
responsibility to check the estimate first. The slash command for
`mass-scout` always runs estimate beforehand.
