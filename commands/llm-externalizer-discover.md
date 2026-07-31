---
name: llm-externalizer-discover
description: Check LLM Externalizer health, active profile, model, auth status, and context window
argument-hint: ""
allowed-tools:
  - Bash
effort: low
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext discover` and present the results to the user in a clear summary.

Show:
1. Service health (reachable or not)
2. Active profile name and mode
3. Model name and context window size
4. Auth token status (resolved or NOT SET)
5. Concurrency mode and max parallel calls
6. Available profiles list

If the command fails, the error is printed on stderr — read it directly:

1. Check that `$OPENROUTER_API_KEY` is set (or the plugin `userConfig.openrouter_api_key` is populated) if you're using a remote profile
2. Re-run with the raw stderr output visible for the exact failure reason
