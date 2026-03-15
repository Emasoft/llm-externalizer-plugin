---
name: discover
description: Check LLM Externalizer health, active profile, model, auth status, and context window
allowed-tools:
  - mcp__llm-externalizer__discover
argument-hint: ""
---

Run the LLM Externalizer `discover` tool and present the results to the user in a clear summary.

Show:
1. Service health (reachable or not)
2. Active profile name and mode
3. Model name and context window size
4. Auth token status (resolved or NOT SET)
5. Concurrency mode and max parallel calls
6. Available profiles list

If the service is unreachable, suggest running `bash $CLAUDE_PLUGIN_ROOT/scripts/setup.sh` to build the MCP server.
