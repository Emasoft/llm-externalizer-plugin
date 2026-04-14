---
name: discover
description: Check LLM Externalizer health, active profile, model, auth status, and context window
allowed-tools:
  - mcp__llm-externalizer__discover
argument-hint: ""
effort: low
---

Run the LLM Externalizer `discover` tool and present the results to the user in a clear summary.

Show:
1. Service health (reachable or not)
2. Active profile name and mode
3. Model name and context window size
4. Auth token status (resolved or NOT SET)
5. Concurrency mode and max parallel calls
6. Available profiles list

If the service is unreachable, the plugin's MCP server failed to start. The server is spawned automatically by Claude Code from `.mcp.json` — recovery steps:

1. Restart Claude Code to retry the MCP server spawn
2. Check that `$OPENROUTER_API_KEY` is set (or the plugin `userConfig.openrouter_api_key` is populated) if you're using a remote profile
3. Inspect the Claude Code MCP server logs for stderr output from the llm-externalizer process
4. As a last resort, run `npm run build` in `mcp-server/` to rebuild `dist/index.js`
