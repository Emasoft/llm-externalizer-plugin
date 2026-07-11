---
name: llm-externalizer-check-model-health
description: |-
  Self-check the configured model(s) of the active profile — free: NO LLM call,
  only a public model-catalog fetch (no API key). For the main/second/third model
  and every tool_models entry it reports PRESENCE (still in the OpenRouter catalog
  vs deprecated/removed), COST DRIFT (price moved vs a seeded baseline), and
  REQUIREMENTS REGRESSION (still meets every tool it serves). Exits non-zero when
  any configured model is CRITICAL. Trigger with "check model health", "is my model
  outdated", "did the price change", "are my configured models still valid".
allowed-tools:
  - Bash
argument-hint: ""
effort: low
---

Run the command below. Print its final line. Nothing else.

## Run

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --check-health
```

No arguments, ever. Free: one public catalog fetch, no API key, no LLM call, $0.
It always inspects the *active* profile.

## Report

The CLI's last stdout line is exactly one of:

```
[OK] configured models: <N> ok, <M> warn, 0 critical. Report: <absolute path>
[FAILED] <N> configured model(s) are CRITICAL (deprecated/removed), … . Report: <absolute path>
```

Print that line **verbatim** and stop. Do not read the report, do not restate the
per-model detail, and do NOT tell the user to hand-edit `settings.yaml`.

A `[FAILED]` here is a finding, not a broken command — the exit code is how a cron
notices a dead model. The fix is scripted:

| Finding | The one command that fixes it |
|---|---|
| CRITICAL — a model was removed / deprecated | `/llm-externalizer:llm-externalizer-benchmark --pick-top-n 3 --apply-profile <profile>` (re-picks and writes the ensemble) |
| CRITICAL — a per-tool model was removed | `llm-ext-benchmark --adopt <NEW_ID> --adopt-into tool:<tool>` |
| WARN — cost drift / requirements regression | Surface it. It is the user's call whether the new price or capability is acceptable. |

Offer the fix command; run it only if the user asks.
