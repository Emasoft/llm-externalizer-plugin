---
name: configure
description: Manage LLM Externalizer profiles — switch, add, edit, or list profiles
allowed-tools:
  - mcp__llm-externalizer__get_settings
  - mcp__llm-externalizer__set_settings
  - mcp__llm-externalizer__discover
  - Read
  - Edit
argument-hint: "[list | switch <profile> | add <name> --mode <mode> --api <api> --model <model>]"
effort: medium
---

Manage LLM Externalizer profile configuration.

## Subcommands

Based on the user's argument:

### `list` (or no argument)
1. Call `get_settings` to get the settings file path
2. Read the file and present a formatted table of all profiles with: name, mode, api preset, model, and whether it is the active profile

### `switch <profile-name>`
1. Call `get_settings` to get the settings file path
2. Read the file
3. Use Edit to change the `active:` field to the requested profile name
4. Call `set_settings` with the edited file path
5. Call `discover` to verify the switch
6. Report the result to the user

### `add <name> --mode <mode> --api <api> --model <model> [--second_model <model>] [--url <url>] [--api_key <key>]`
1. Call `get_settings` to get the settings file path
2. Read the file
3. Use Edit to add a new profile block under `profiles:` with the provided fields
4. Optionally set it as active if the user requests
5. Call `set_settings` with the edited file path
6. Report the result

### Error handling
- If `set_settings` returns validation errors, show them clearly and suggest fixes
- Refer the user to the `llm-externalizer-config` skill's profile templates for valid configurations
