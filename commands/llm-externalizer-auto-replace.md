---
name: llm-externalizer-auto-replace
description: |-
  Check every model this plugin runs on — each benchmarked tool's model AND the
  three ensemble slots — against the durable model-health ledger, and surface (or,
  with --apply, adopt) the best replacement. Tool models are judged by their own
  same-or-cheaper benchmark; ensemble slots are judged by a CODE persistence
  threshold (3 consecutive same-status 400/404/410/422 failures inside 24h — no
  agent judgment anywhere). A pricier model is NEVER recommended. READ-ONLY unless
  --apply. Trigger with "check tool replacements", "is any model degraded", "audit
  my models", "rotate the ensemble", "a model is 404ing", "auto-replace my models".
allowed-tools:
  - Bash
argument-hint: "[--apply] [--force]"
effort: low
---

Run the command below. Print its final line. Nothing else.

## Run

ONE Bash call, with `run_in_background: true` (a benchmark may run — 10-30 min):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --auto-replace $ARGUMENTS
```

Forward `$ARGUMENTS` verbatim. Add `--apply` **only** if the user asked to actually
change the configuration.

## What the CLI decides (so you don't)

1. **Ledger** — every per-call mitigation event (param-drop, reasoning-downgrade,
   429, schema-heal, truncation-retry, empty-response, non-retryable-failure) is
   recorded per model id.
2. **Per benchmarked tool** — is the incumbent degraded? If yes (or `--force`), the
   tool's own benchmark runs and the best same-or-cheaper passer is surfaced.
3. **Per ensemble slot** — is the model PERSISTENTLY BROKEN? The rule is code, not
   judgment: **≥3 consecutive `non_retryable_failure` events carrying the SAME
   rotate-worthy HTTP status (400/404/410/422) within the last 24h.** 429s, 5xx
   bursts, and 401/403 never rotate anything — a swap cannot fix them.
4. **On a healthy ledger nothing runs**: zero benchmarks, zero spend, zero changes.

With `--apply`: each changed tool recommendation is written to `tool_models`, and a
broken ensemble triggers a fresh sweep + re-pick + atomic ensemble write. Never a
stale-cache re-pick — that would re-select the model the ledger just condemned.

## Report

The CLI's last stdout line is exactly one of:

```
[OK] <summary>. Report: <absolute path>
[FAILED] <reason>
```

Print that line **verbatim** and stop. Do NOT read the ledger, do NOT judge whether
a failure "looks persistent" (that is what the threshold is for), do NOT read the
report, and do NOT tell the user to hand-edit `settings.yaml`.

After a successful `--apply`, the line says to run `reset` — relay it, do not
elaborate.

## Environment

On a healthy ledger this runs no LLM call and needs no key. When a benchmark DOES
run, `$OPENROUTER_API_KEY` (or the plugin's `userConfig.openrouter_api_key`) must be
set — the CLI says so itself, in one `[FAILED]` line. On a `free_only` profile the
benchmarks run on the free pool at $0.

The read-only MCP tool `check_tool_replacements` still exposes the advisory half for
programmatic callers; the CLI is the only surface that can WRITE.
