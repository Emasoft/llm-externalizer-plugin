---
name: llm-externalizer-configure
description: Inspect LLM Externalizer profile configuration. Read-only — model & profile changes are user-only via manual YAML editing.
allowed-tools:
  - Bash
  - Read
argument-hint: "[list]"
effort: low
---

Inspect LLM Externalizer configuration. **This command never mutates settings** — model & profile changes are user-only.

## Configuration policy

Model and profile configuration is **user-only**. There is no `set-settings`,
`change-model`, or `profile` command in the CLI at all — configuration is
edited by hand in `settings.yaml`, by design, so agents cannot silently swap
models or leak configuration to the wrong backend.

To change anything (active profile, model, second_model, api preset, URL, api_key, timeouts):

1. Open `~/.llm-externalizer/settings.yaml` in your editor and save your edits.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext reset` to reload.

## Subcommands

### `list` (or no argument)

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext discover` and report: active profile name, mode, api preset, model, auth status, service health.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext get-settings` — it copies `settings.yaml` to the output directory and returns the copy's path (not the original). Read that file and show a formatted table of ALL profiles: name, mode, api preset, model, second_model (if any), and whether it is the active one.
3. Append a one-line reminder: `To edit: open ~/.llm-externalizer/settings.yaml manually, save, then run llm-ext reset.`

### Any other argument

Decline politely and explain the policy: configuration is user-only. Point the user to `~/.llm-externalizer/settings.yaml`, the `reset` command, and the `llm-externalizer-config` skill for profile templates.

## What this command will NOT do

- Write to `settings.yaml` in any way.
- Run a `set-settings`, `change-model`, or `profile` command (none of them exist in the CLI).
