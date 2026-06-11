---
name: llm-externalizer-auto-replace
description: |-
  Check, for every LLM tool that has a per-tool benchmark (security_scan,
  search_existing_implementations), whether its configured model has DEGRADED
  (per the durable model-health ledger) and, when so, run that tool's ADVISORY
  benchmark to surface the best SAME-OR-CHEAPER replacement. READ-ONLY by default
  — it writes a report and recommends, it never rewrites your settings. A pricier
  model is NEVER recommended. Trigger with "check tool replacements", "is any tool
  model degraded", "audit my per-tool models", or "auto-replace my LLM tool
  models". To actually adopt a recommendation, run the CLI `--apply` (below).
allowed-tools:
  - mcp__llm-externalizer__check_tool_replacements
argument-hint: "[models=<id,[id...]>] [force] [output_dir=<abs path>]"
effort: high
---

# check_tool_replacements — advisory auto-replacement planner

Each per-tool benchmark (`security_triage_benchmark`,
`search_existing_benchmark`) can qualify a model for ONE tool. This command joins
them to the durable **model-health ledger**: for every tool that HAS a benchmark,
it asks "is that tool's configured model degraded?" and, only when it is (or when
you force an explicit audit), runs that tool's benchmark to recommend the best
same-or-cheaper replacement.

It is the **ADVISORY** half of the auto-replacement loop. This slash command wraps
the **read-only** `check_tool_replacements` MCP tool — it reports and recommends;
it **never** rewrites your `settings.yaml`. The MCP server is read-only by design
and cannot mutate its own config. To actually adopt a recommendation you run the
CLI writer (`llm-ext-benchmark --auto-replace --apply`, see below) — a deliberate,
human-run step.

## What it does

1. **Aggregates the model-health ledger** — every per-call mitigation event
   (param-drop, reasoning-downgrade, rate-limit, schema-heal, truncation-retry,
   empty-response, non-retryable-failure) is recorded per model id. A window of
   those events rolls up into a per-model `degraded` verdict.
2. **Resolves each benchmarked tool's incumbent** — the model the tool currently
   runs on (its `tool_models` override, or the profile default).
3. **Decides per tool** — if the incumbent is healthy AND you did not pass
   `force`, no benchmark runs and the recommendation is "keep the incumbent"
   (zero false positives on a healthy/empty ledger). If the incumbent is degraded
   (or `force` is set), the tool's own benchmark runs over the candidate pool and
   the best same-or-cheaper passer is surfaced.
4. **Writes a markdown report** to `<main-project-dir>/reports/auto-replace/` and
   returns its path plus a one-line summary
   (`N tool(s) checked, M degraded, K replacement(s) recommended`).

## Inputs

| Field | Required | Description |
|---|---|---|
| `models` | no | Explicit candidate model id(s) forwarded to each benchmark that runs. When omitted, each benchmark auto-discovers the same-or-cheaper candidate pool. |
| `force` | no | Run every benchmarked tool's benchmark even when its incumbent is NOT degraded — an explicit operator audit. |
| `output_dir` | no | Report directory. Default `<main-project-dir>/reports/auto-replace/`. |

## The recommendation gate (how a replacement is chosen)

A replacement is recommended for a tool ONLY when that tool's own benchmark says
so: the candidate must meet the tool's per-tool requirements AND pass the tool's
benchmark AND be **not pricier than the incumbent** on either cost axis. If no
eligible same-or-cheaper model passes, the incumbent is kept — the planner never
leaves a tool without a model and never recommends a pricier one.

## Output

```
N tool(s) checked, M degraded, K replacement(s) recommended (advisory — apply via the CLI `llm-ext-benchmark --auto-replace --apply`).

Report: <absolute path to .md report>
```

The report's per-tool sections show the incumbent, its degradation reasons (if
any), the benchmark verdict, and the recommendation. The recommendation is
**ADVISORY** — adopt it deliberately via the CLI below.

## Adopting a recommendation (the WRITER path — CLI only)

This command is read-only. To actually write the recommended per-tool model into
`~/.llm-externalizer/settings.yaml`, use the benchmark CLI — the **sole** writer
path (the MCP tool never writes):

```
llm-ext-benchmark --auto-replace            # advisory: report only (same as this command)
llm-ext-benchmark --auto-replace --apply    # adopt each changed recommendation (writes tool_models)
llm-ext-benchmark --auto-replace --apply --force   # re-run benchmarks even on a healthy ledger, then adopt
```

`--apply` requires `--auto-replace`. It writes one `tool_models.<tool>` entry per
changed recommendation (atomic write; other keys preserved), then prints
`old → new` per tool. After applying, run the `reset` MCP tool (or restart Claude
Code) to pick up the new model(s). `--apply` honors `free_only` — on a free-only
profile every benchmark runs on the free pool at zero spend.

## Environment

The advisory check itself runs no LLM call on a healthy ledger. When a benchmark
DOES run (a degraded incumbent, or `force`), set `$OPENROUTER_API_KEY` (or the
plugin's `userConfig.openrouter_api_key`) — a benchmark you cannot run is useless.
On a `free_only` profile the benchmarks run on the free pool ($0).
