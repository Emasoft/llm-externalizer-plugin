---
name: llm-externalizer-discover-new-models
description: |-
  Autodiscover models that newly appeared in the OpenRouter catalog since the
  last run — free: makes NO LLM call (no token cost), only a public model-catalog
  fetch (no API key). Diffs the live catalog against a seeded snapshot and, for
  each NEW model id, assesses it against every LLM tool's per-tool requirements
  so you can see at a glance which arrivals are worth adopting. Adopting one is a
  single scripted command (`--adopt`) — no hand-editing. Trigger with "any new
  models", "discover new models", "what new models are available", "check for
  newer/cheaper models".
allowed-tools:
  - Bash
argument-hint: "[qualifying-only]"
effort: low
---

Run the command below. Print its final line. Nothing else.

## Run

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --new-arrivals $ARGUMENTS
```

Pass `--qualifying-only` **only** if the user asked to hide arrivals that fit no
tool. Free: one public catalog fetch, no API key, no LLM call, $0.

## Report

The CLI's last stdout line is exactly one of:

```
[OK] <N> new arrival(s), <M> qualify for ≥1 tool …. Report: <absolute path>
[FAILED] <reason>
```

Print that line **verbatim** and stop. Do not read the report, do not list the
arrivals in chat, and do NOT tell the user to edit `settings.yaml` — adoption is
scripted (below).

## Adopting an arrival (scripted — never a hand edit)

Only when the user names a model to adopt, run ONE of:

```bash
# Into an ensemble slot (model | second_model | third_model):
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --adopt <MODEL_ID> --adopt-into model

# Into one tool's per-tool override:
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --adopt <MODEL_ID> --adopt-into tool:security_scan
```

The CLI gates the id against the per-tool requirements registry (a free catalog
fetch) and refuses — `[FAILED]`, exit 2 — if it fits nothing, then writes the
setting atomically. Add `--adopt-profile P` to target a profile other than the
active one. Print its final line verbatim; it ends with "run `reset` to reload".

A tool with a benchmark gate (e.g. `security_scan`) says so in that line — surface
it, do not act on it.
