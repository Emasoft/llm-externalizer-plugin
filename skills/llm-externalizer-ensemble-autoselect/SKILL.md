---
name: llm-externalizer-ensemble-autoselect
description: |-
  Reference for rotating the OpenRouter ensemble when a model has 404'd / been
  deprecated / is misbehaving. The persistence decision is CODE, not judgment: the
  CLI reads the durable model-health ledger and rotates only on ≥3 consecutive
  same-status 400/404/410/422 failures within 24h. Real invocation path is one CLI
  call — `llm-ext-benchmark --auto-replace --apply` (ledger-gated) or
  `--pick-top-n 3 --apply-profile <name>` (unconditional re-pick). Loaded as
  background reference, not a standalone slash command.
argument-hint: ""
effort: low
user-invocable: false
---

# LLM Externalizer — Ensemble Auto-Selection

## The one rule

**Never judge whether a failure is "persistent". The ledger does it.**

A model rotates iff `assessModelPersistence` (`mcp-server/src/model-events.ts`) says
so: **≥3 consecutive `non_retryable_failure` events carrying the SAME rotate-worthy
HTTP status (400 / 404 / 410 / 422) within a rolling 24h window.** That threshold is
the code spelling of "same error class, 3+ times, still current":

- 429s and 5xx bursts never rotate — a swap cannot fix a rate limit or a provider outage.
- 401/403 never rotate — that is a wrong API key; rotating would destroy a working ensemble.
- A run broken by a *different* status is a wobble, not a retirement.
- An old, since-healed break ages out of the 24h window.

Do not read retry histories. Do not count 404s in the transcript. Do not decide.

## What to run

Every trigger below — reactive ("the ensemble is broken", "swap the broken model",
"rotate the ensemble", a call returning `API error 404 … "deprecated"`) and proactive
("rescan models", "refresh the ensemble", "find better or cheaper models") — maps to
ONE background CLI call:

```bash
# Ledger-gated: rotates ONLY if the threshold is met; free + no-op on a healthy ledger.
llm-ext-benchmark --auto-replace --apply

# Unconditional re-pick (the user asked for a rescan, not a repair):
llm-ext-benchmark --pick-top-n 3 --apply-profile <profile>

# Re-pick from the last sweep's cache, no new API calls:
llm-ext-benchmark --from-cache --pick-top-n 3 --apply-profile <profile>
```

Then print the CLI's final `[OK] …` / `[FAILED] …` line verbatim. It already carries
the picks, the write, and the report path.

NEVER hand-roll a per-model loop over `chat` / `code_task` / `or_model_info` — that is
the 30-40M-token failure mode these commands exist to prevent.

## What the CLI decides, so you don't

- **The paid-candidate cap.** `--qualifying-top-n` defaults to **15** in code.
- **The selection.** Survivors must clear `meanF1 ≥ 0.95` (`--min-f1`) AND
  `schemaCompliant`; sorted by meanF1 desc, then cost asc, then latency asc; top N.
- **The shortage.** Fewer than N survivors ⇒ `[FAILED]`, exit 2, **settings unchanged**.
  There is no silent fallback and nothing for you to decide — relay the line; the user
  can lower `--min-f1` or broaden the sweep.
- **The write.** Atomic (tmp + rename); every other profile and key preserved.
- **The cost rule.** Input AND output both strictly `< $1/M`; a model priced at exactly
  `$0` with no `:free` suffix (open-beta, e.g. `openrouter/owl-alpha`) qualifies. Free
  eligibility is semantic: id ends `:free` OR the catalog prices it at exactly $0.

## Credit-free pre-ranking (why the cap is safe)

Before any paid run, candidates are ranked by two indexes on the public catalog
endpoint ($0, no key): the codex index (`benchmarks.artificial_analysis.coding_index`)
and the design-arena code-categories ELO. Coverage is partial; a missing index is
UNKNOWN and never a disqualifier. Scored models rank above unscored; cheapest breaks
ties. So the top-15 cap spends the budget on the most promising candidates first.

## After a write

The CLI's line ends with "run `reset` to reload". Relay it. Do not elaborate.

## Resources

- [selection-algorithm](references/selection-algorithm.md) — hard filters, ranking
  rules, anti-patterns.
- Code SoT (authoritative — edit code first, mirror here second):
  `mcp-server/src/model-events.ts` (`assessModelPersistence`, `ROTATE_WORTHY_STATUSES`),
  `mcp-server/src/model-qualification/auto-replace.ts` (`planEnsembleRotation`),
  `mcp-server/src/benchmark/discover.ts` (`DEFAULT_CRITERIA`, `qualify()`),
  `mcp-server/src/benchmark/pick.ts` (`pickTopN`, `applyPicksToSettings`).
