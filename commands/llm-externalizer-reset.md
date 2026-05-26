---
name: llm-externalizer-reset
description: |-
  Soft-restart the LLM Externalizer MCP server. Reloads settings.yaml,
  clears caches, resets session counters, re-resolves the active
  profile. Use after editing settings or when the backend misbehaves.
allowed-tools:
  - mcp__llm-externalizer__reset
argument-hint: "(no arguments)"
effort: low
---

# LLM Externalizer — reset

Full soft-restart of the running MCP server. Use this whenever:

- You edited `~/.llm-externalizer/settings.yaml` and want the new values
  to take effect without restarting Claude Code itself.
- The backend started misbehaving (rate-limit oscillation, stale model
  list, drifting concurrency).
- You want a clean slate for session counters (tokens / cost / calls
  ledgered against the active profile).
- The `change-model` command guided you to edit `settings.yaml` by hand
  — `reset` is step 2 of that flow.

`reset` is **NOT immediate**: it waits for every in-flight LLM request
to finish before acting, so a long-running scan won't be torn down
mid-call. While `reset` is pending, new tool calls queue up; once the
restart completes, they resume against the refreshed config.

## What gets reset

- Settings reloaded from `~/.llm-externalizer/settings.yaml`.
- All caches cleared: OpenRouter model list (`/models`), per-model
  param-support cache, LM Studio detection, the 1h-TTL pricing /
  context-window cache.
- Session counters zeroed (`token_total`, `cost_usd_total`, call counts
  per tool).
- The active profile is re-resolved (free-only flag, default model,
  per-tool overrides).
- The client is notified to refresh its tool list so any toggled-by-
  config tools become visible / hidden as the new settings dictate.

## Inputs

This command takes no arguments.

## Output

A confirmation line including the active profile name, the resolved
primary model, and whether `free_only` is now active. If the server
was idle when `reset` fired, the operation completes near-instantly;
otherwise the response is sent once every in-flight call has
finished.

## Example

```
/llm-externalizer:llm-externalizer-reset
```

After editing `~/.llm-externalizer/settings.yaml` (e.g. switching the
active profile from `remote-ensemble-geminigrok` to `free-only`),
issue this command to make the new settings live.

## When NOT to use this

- If `discover` already shows the expected profile / model, `reset` is
  a no-op. Skip it to avoid pausing in-flight work for no benefit.
- If the goal is to KILL the server (not soft-restart), `reset` is the
  wrong tool — use Claude Code's own restart flow.
