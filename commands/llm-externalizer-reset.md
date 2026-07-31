---
name: llm-externalizer-reset
description: |-
  Reload settings.yaml, clear caches, and zero the on-disk session
  counters. Use after editing settings or when the backend misbehaves.
allowed-tools:
  - Bash
argument-hint: "(no arguments)"
effort: low
---

# LLM Externalizer — reset

Run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext reset`.

There is no long-running MCP server any more — every `llm-ext` command is
its own fresh process, so most in-memory state is already rebuilt on
every invocation. `reset` exists for the state that DOES persist across
invocations: it reloads `settings.yaml` from disk (validating it),
clears the on-disk caches (OpenRouter model list, per-model param
support, LM Studio detection, the pricing/context-window cache), and
zeroes the on-disk session-stats file (`token_total`, `cost_usd_total`,
call counts). Use it whenever:

- You edited `~/.llm-externalizer/settings.yaml` and want to confirm it
  parses cleanly and the new profile resolves correctly.
- The backend started misbehaving (rate-limit oscillation, stale model
  list, drifting concurrency) and you want a clean cache slate.
- You want the session-stats ledger (tokens / cost / calls) back to
  zero.
- The `change-model` command guided you to edit `settings.yaml` by hand
  — `reset` is step 2 of that flow.

## Inputs

This command takes no arguments.

## Output

A confirmation line including the active profile name, the resolved
primary model, and whether `free_only` is now active.

## Example

```bash
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext reset
```

After editing `~/.llm-externalizer/settings.yaml` (e.g. switching the
active profile from `remote-ensemble-geminigrok` to `free-only`), run
this to confirm the new settings are valid and the caches are clean
before the next command reads them.

## When NOT to use this

- If `discover` already shows the expected profile / model, `reset` is
  a no-op — skip it.
- `reset` does not need to "wait" for anything — there is no persistent
  server to drain; each `llm-ext` invocation is independent.
