---
name: llm-externalizer-change-model
description: Redirect to user-only manual model/ensemble configuration. There is NO change-model command — the tool is read-only by design. This command explains how to edit ~/.llm-externalizer/settings.yaml by hand and reload with reset, and points you at the optional benchmark / assess-model helpers for picking which models to use.
allowed-tools:
  - Read
  - Bash
argument-hint: "(no arguments)"
effort: low
---

# llm-externalizer-change-model — user-only model configuration

**There is NO `change-model` command.** LLM Externalizer is **read-only by
design**, so no agent (including this command) silently swaps the model or
ensemble on the active profile. Model and profile configuration is
**user-only**: you edit `~/.llm-externalizer/settings.yaml` by hand and reload it.

This command does NOT mutate `settings.yaml`. It shows the current configuration
and walks you through the manual change.

## How to change the model / ensemble (manual, user-only)

1. **See what is active now.** Run
   `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext discover` (or
   `/llm-externalizer:llm-externalizer-discover`) to print the active profile,
   its `mode`, `api` preset, and current model(s).
2. **Open the settings file in your editor:** `~/.llm-externalizer/settings.yaml`
   (or `$LLM_EXT_CONFIG_DIR/settings.yaml` if you set `LLM_EXT_CONFIG_DIR`).
3. **Edit the model field(s) of the active profile:**
   - `mode: remote` or `mode: local` → set `model:` (single model).
   - `mode: remote-ensemble` → set `model:`, `second_model:`, and
     `third_model:` (three models run in parallel). `second_model` is required
     for `remote-ensemble`; `third_model` is optional.
   - Leave `mode`, `api`, `url`, `api_key`, `api_token`, `timeout`, and
     `context_window` untouched unless you also mean to change those.
4. **Reload:** run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext reset`. It re-reads
   `settings.yaml` and clears caches.
5. **Verify:** run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext discover` again and
   confirm the new model(s) are shown.

## Picking which models to put in (optional helpers)

These helpers only *inform* your choice — they never write `settings.yaml`:

- `/llm-externalizer:llm-externalizer-benchmark` — score OpenRouter
  programming-category models against a real classification workload and get a
  ranked, cost-annotated comparison report. Use it to find the cheapest model
  that still passes.
- `/llm-externalizer:llm-externalizer-assess-model model=<id>` — check, for free
  (no LLM call), whether one specific model meets every tool's requirements.
- `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext or-model-info --model <id>` — look up a
  model's context window, max output, pricing, and supported params before
  you paste its id in.

After you decide, do the manual edit in the section above.

## Current ensemble default

For reference, the current `remote-ensemble` default models are
`google/gemini-2.5-flash`, `x-ai/grok-4.1-fast`, and `qwen/qwen3.6-plus`; the
free model is `nvidia/nemotron-3-super-120b-a12b:free`.

## What this command will NOT do

- Run a `change-model` command — it does not exist (the tool is read-only).
- Write to `~/.llm-externalizer/settings.yaml` in any way.
- Invoke `npx llm-externalizer profile add | select | edit | remove | rename`
  — those CLI subcommands are disabled (only `profile list` is read-only).

See also the `llm-externalizer-config` skill for full profile templates and the
`/llm-externalizer:llm-externalizer-configure` command for a read-only view of
all profiles.
