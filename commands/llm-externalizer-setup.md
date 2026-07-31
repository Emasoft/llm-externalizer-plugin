---
name: llm-externalizer-setup
description: Interactive setup wizard for the llm-externalizer plugin's local-model backends. Detects platform (OS, arch, RAM, GPU), finds installed runners (Ollama, LM Studio, vLLM, llama.cpp, Jan), assists with installation if none are present, helps download Hugging Face models, runs five calibrated compatibility tests, and generates a ready-to-paste settings.yaml profile snippet.
allowed-tools:
  - Agent
argument-hint: ""
effort: medium
---

**Quick redirect — if you just want OpenRouter (no local model), STOP and use `/llm-externalizer:llm-externalizer-configure` instead.** That command is a single-prompt API-key paste and takes ~30 seconds. This wizard is for LOCAL-backend setup (Ollama / LM Studio / vLLM / llama.cpp / Jan) and takes 2-10 minutes.

Spawn the `llm-externalizer-setup-agent` via the Agent tool using `subagent_type: "llm-externalizer-setup-agent"`. The wizard walks the user through the following steps:

1. **Platform detection** — OS family (macOS / Linux / WSL2 / Windows), architecture, RAM, GPU.
2. **Runner detection** — scan for Ollama, LM Studio, vLLM, llama.cpp, Jan (CLI presence + listening port).
3. **Install assistance** — if zero runners found, suggest the best one for the user's platform and show the install command (the wizard never auto-installs without explicit confirmation).
4. **Model selection** — list currently installed models, or help download a recommended one from Hugging Face (installs the `hf` CLI if missing).
5. **Compatibility test** — five calibrated checks (smoke, structured output, code understanding, long context, output length) scored 0.0-1.0 each, with a hard pass/fail verdict.
6. **Profile snippet** — generate a `settings.yaml` profile block with the tested context window, ready to paste.
7. **Verification** — run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext discover` after the user pastes and saves, to confirm the profile is active and the backend responds.

**User-only configuration policy.** Per `skills/llm-externalizer-config/SKILL.md`, the wizard **never writes** to `~/.llm-externalizer/settings.yaml` directly — it generates the YAML snippet, shows the user where to paste it, and instructs them to run `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext reset` to reload. The tool is read-only by design: there is NO `set-settings` (or `change-model`) command — configuration is user-only, edited by hand then reloaded with `reset`.

**State persistence.** Wizard state lives under `$CLAUDE_PLUGIN_DATA/setup/` (env.json, runners.json, selected.json, test-results.json, profile.yaml), so re-invoking the command resumes where it left off.

**When to invoke instead of `/llm-externalizer:llm-externalizer-configure`.** This setup wizard is for first-time **local-model** setup (Ollama / LM Studio / vLLM / llama.cpp / Jan) or when a local model is failing compatibility tests. For OpenRouter-only setup or to inspect an existing config, use `llm-externalizer-configure` instead — it is read-only and lighter weight. (Repeated here in case you scrolled past the top-of-doc redirect.)

## Three-surface compliance: by-design slash-only (GAP-13)

This command is an interactive wizard: it detects OS/arch/RAM/GPU, prompts the user through model selection (multiple multi-choice menus), helps download a Hugging Face model, runs five calibrated compatibility tests, and generates a paste-ready `settings.yaml` snippet. It is stateful (resumable via `$CLAUDE_PLUGIN_DATA/setup/`) and conversational — not a one-shot tool call.

Per TRDD-a24b213c §C, this is a documented exemption from the "every capability has a CLI command + slash command" invariant — not a gap waiting to be filled. The tool is read-only by design (no `set-settings`), so a programmatic surface cannot write the user's config; a CLI verb would have to re-implement the interactive menus and loses the value of conversational state, which the slash command's subagent already handles.
