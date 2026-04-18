---
name: llm-externalizer-configure
description: Inspect LLM Externalizer profile configuration. Read-only — model & profile changes are user-only via manual YAML editing.
allowed-tools:
  - mcp__llm-externalizer__get_settings
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__reset
  - Read
argument-hint: "[list]"
effort: low
---

Inspect LLM Externalizer configuration. **This command never mutates settings** — model & profile changes are user-only.

## Configuration policy

Model and profile configuration is **user-only**. The MCP `set_settings` and `change_model` tools, and the CLI `profile add | select | edit | remove | rename` subcommands, are **disabled by design** so agents cannot silently swap models or leak configuration to the wrong backend.

To change anything (active profile, model, second_model, api preset, URL, api_key, timeouts):

1. Open `~/.llm-externalizer/settings.yaml` in your editor and save your edits.
2. Either restart Claude Code, or call the `reset` MCP tool to reload without restarting.

## Subcommands

### `list` (or no argument)

1. Call `mcp__llm-externalizer__discover` and report: active profile name, mode, api preset, model, auth status, service health.
2. Call `mcp__llm-externalizer__get_settings` — it returns an **editable copy** of `settings.yaml` (not the original). Read that file and show a formatted table of ALL profiles: name, mode, api preset, model, second_model (if any), and whether it is the active one.
3. Append a one-line reminder: `To edit: open ~/.llm-externalizer/settings.yaml manually, save, then call the 'reset' tool or restart Claude Code.`

### Any other argument

Decline politely and explain the policy: configuration is user-only. Point the user to `~/.llm-externalizer/settings.yaml`, the `reset` tool, and the `llm-externalizer-config` skill for profile templates.

## What this command will NOT do

- Write to `settings.yaml` in any way.
- Call `set_settings` or `change_model` (both are disabled MCP-side; calls return a refusal).
- Invoke `npx llm-externalizer profile add | select | edit | remove | rename` (those CLI subcommands are also disabled).
