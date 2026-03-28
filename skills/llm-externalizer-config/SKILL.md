---
name: llm-externalizer-config
description: |-
  Use when managing LLM Externalizer profiles in settings.yaml.
  Trigger with "switch LLM profile", "add profile", "change active model", "edit settings.yaml".
version: 1.0.0
---

# LLM Externalizer — Configuration

## Overview

Profile-based configuration for local and remote LLM backends. Settings stored at `~/.llm-externalizer/settings.yaml`. Three modes: `local` (sequential), `remote` (parallel via OpenRouter), `remote-ensemble` (two models in parallel).

## Prerequisites

- LLM Externalizer MCP server running (auto-started by Claude Code plugin)
- For local backends: LM Studio, Ollama, vLLM, or llama.cpp running locally
- For remote backends: `OPENROUTER_API_KEY` environment variable set

## Instructions

Copy this checklist and track your progress:

1. [ ] Call `mcp__llm-externalizer__discover` to check the current active profile and service health
2. [ ] Call `mcp__llm-externalizer__get_settings` to get an editable copy of `settings.yaml`
3. [ ] Read the returned file path with the Read tool
4. [ ] Use Edit to modify profiles (add, switch active, change model, etc.)
5. [ ] Call `mcp__llm-externalizer__set_settings` with the edited file path to apply changes
6. [ ] Call `mcp__llm-externalizer__discover` again to verify the changes took effect

**CRITICAL**: `set_settings` replaces the entire settings.yaml. The edited file must include ALL profiles, not just the one you changed.

## Context

Use this skill when the user wants to switch the active LLM Externalizer profile, add/edit/remove profiles in settings.yaml, fix auth token issues shown by `discover`, enable ensemble mode, or asks about supported API presets and profile fields.

## Output

- `discover` returns active profile name, mode, model, auth status, context window, concurrency limits
- `get_settings` returns a file path to the editable settings copy
- `set_settings` returns success confirmation or validation error details

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| Validation error | Invalid YAML or profile config | Check mode/api preset compatibility in the [configuration guide](references/configuration-guide.md) |
| Auth token `(NOT SET)` | Env var missing from MCP process | Add the env var to `.mcp.json` env block or export in shell |
| Connection refused | Local LLM server not running | Start LM Studio/Ollama/vLLM, verify URL and port |

## Examples

### Switch active profile

```
1. get_settings → /path/to/settings_edit.yaml
2. Read, then Edit: change `active: old-profile` to `active: new-profile`
3. set_settings with file_path → discover to verify
```

### Add a new profile

```yaml
  my-local:
    mode: local
    api: lmstudio-local
    model: "bartowski/Llama-3.3-70B-Instruct-GGUF"
```

## Resources

- [Configuration guide](references/configuration-guide.md)
  - Modes, API Presets, Profile Fields, Auth Resolution
  - Managing Profiles via MCP, Validation Rules
  - Ensemble Mode, Environment Variables
  - CLI Profile Management, Troubleshooting
- [Profile templates](references/profile-templates.md)
  - Local LM Studio, Local Ollama, Local vLLM, Local llama.cpp
  - Local generic, Remote single model (OpenRouter)
  - Remote single model (Claude), Remote ensemble
  - Complete settings.yaml example
- `/configure` command — Interactive profile management
- `/discover` command — Quick health check
