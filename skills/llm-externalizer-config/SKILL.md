---
name: llm-externalizer-config
description: Use when inspecting LLM Externalizer profile config or explaining the manual-edit policy. Trigger with "show LLM profile", "which model is active", "edit settings.yaml".
argument-hint: "[list]"
effort: low
---

# LLM Externalizer — Configuration

## Overview

Profile-based configuration for local and remote LLM backends. Settings stored at `~/.llm-externalizer/settings.yaml`. Three modes: `local` (sequential), `remote` (parallel via OpenRouter), `remote-ensemble` (three models in parallel).

## Policy — user-only configuration

Changing models, profiles, API keys, URLs, or timeouts is **user-only**. This is a deliberate design choice.

The MCP tools `set_settings` and `change_model` are **disabled**; the CLI subcommands `profile add | select | edit | remove | rename` are **disabled**. Calling any of them returns a refusal pointing here.

The only supported workflow is:

1. Open `~/.llm-externalizer/settings.yaml` in your editor.
2. Edit the file and save.
3. Either restart Claude Code, or call the `mcp__llm-externalizer__reset` tool to reload without restarting.

## Prerequisites

- LLM Externalizer MCP server running (auto-started by Claude Code plugin)
- For local backends: LM Studio, Ollama, vLLM, or llama.cpp running locally
- For remote backends: `OPENROUTER_API_KEY` environment variable set

## Instructions

Copy this checklist and track your progress:

1. [ ] Call `mcp__llm-externalizer__discover` to report active profile, mode, model, auth status, service health, context window, concurrency limits
2. [ ] Call `mcp__llm-externalizer__get_settings` — returns a file path to an editable **copy** of `settings.yaml`
3. [ ] Read the returned file with the Read tool and surface the full profile table to the user
4. [ ] Remind the user that any change must be made by editing `~/.llm-externalizer/settings.yaml` in an editor, then restarting or calling `reset`

Do NOT attempt to call `set_settings` or `change_model` — both are disabled.

## Context

Use this skill when the user wants to see the current LLM Externalizer configuration or asks how to change a profile, a model, an API key, or a timeout. Always route configuration changes back to the user (manual YAML edit).

## Output

- `discover` — active profile name, mode, model, auth status, context window, concurrency limits
- `get_settings` — file path to a read-only editable copy (you still show the user how to apply changes manually)
- `reset` — reloads settings after the user has edited the file

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `discover` shows invalid profile | Settings file malformed | Ask user to open `~/.llm-externalizer/settings.yaml`, fix, save, then call `reset` |
| Auth token `(NOT SET)` | Env var missing | Ask user to add the env var to shell profile or `.mcp.json`, then restart Claude Code |
| Connection refused | Local LLM server not running | Ask user to start LM Studio / Ollama / vLLM; verify URL and port in settings |
| `set_settings` / `change_model` returned DISABLED | Expected — tools are user-only | Direct user to manual edit |

## Examples

### Inspect the current profile

```
1. discover → shows active: remote-ensemble-geminigrok, mode: remote-ensemble
2. get_settings → /path/to/settings_edit.yaml
3. Read the file, surface the profiles table to the user
4. Tell the user: to change, edit ~/.llm-externalizer/settings.yaml, save, then call reset
```

### User asks to switch profiles

```
Do NOT call set_settings. Instead:
  1. Show the current active profile via discover
  2. List available profile names from get_settings
  3. Tell the user: open ~/.llm-externalizer/settings.yaml, change the "active:" line to the desired profile name, save, then call reset
```

## Resources

- [Configuration guide](references/configuration-guide.md)
  - Modes, API Presets, Profile Fields, Auth Resolution
  - Manual Edit Workflow, Validation Rules
  - Ensemble Mode, Environment Variables
  - Troubleshooting
- [Profile templates](references/profile-templates.md)
  - Local LM Studio, Local Ollama, Local vLLM, Local llama.cpp
  - Local generic, Remote single model (OpenRouter)
  - Remote single model (Claude), Remote ensemble
  - Complete settings.yaml example
- `/llm-externalizer:llm-externalizer-configure` — read-only inspector command
- `/llm-externalizer:llm-externalizer-discover` — quick health check
