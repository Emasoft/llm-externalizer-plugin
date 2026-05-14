---
name: llm-externalizer-setup
description: Interactive setup wizard for the llm-externalizer plugin's local-model backends. Detects platform (OS, arch, RAM, GPU), finds installed runners (Ollama, LM Studio, vLLM, llama.cpp, Jan), assists with installation if none are present, helps download Hugging Face models, runs five calibrated compatibility tests, and generates a ready-to-paste settings.yaml profile snippet.
allowed-tools:
  - Agent
argument-hint: ""
effort: medium
---

Spawn the `llm-externalizer-setup-agent` via the Agent tool using `subagent_type: "llm-externalizer-setup-agent"`. The wizard walks the user through seven steps:

1. **Platform detection** — OS family (macOS / Linux / WSL2 / Windows), architecture, RAM, GPU.
2. **Runner detection** — scan for Ollama, LM Studio, vLLM, llama.cpp, Jan (CLI presence + listening port).
3. **Install assistance** — if zero runners found, suggest the best one for the user's platform and show the install command (the wizard never auto-installs without explicit confirmation).
4. **Model selection** — list currently installed models, or help download a recommended one from Hugging Face (installs the `hf` CLI if missing).
5. **Compatibility test** — five calibrated checks (smoke, structured output, code understanding, long context, output length) scored 0.0-1.0 each, with a hard pass/fail verdict.
6. **Profile snippet** — generate a `settings.yaml` profile block with the tested context window, ready to paste.
7. **Verification** — call `mcp__llm-externalizer__discover` after the user pastes and saves, to confirm the profile is active and the backend responds.

**User-only configuration policy.** Per `skills/llm-externalizer-config/SKILL.md`, the wizard **never writes** to `~/.llm-externalizer/settings.yaml` directly — it generates the YAML snippet, shows the user where to paste it, and instructs them to call `mcp__llm-externalizer__reset` to reload. The `set_settings` MCP tool is disabled by design.

**State persistence.** Wizard state lives under `$CLAUDE_PLUGIN_DATA/setup/` (env.json, runners.json, selected.json, test-results.json, profile.yaml), so re-invoking the command resumes where it left off.

**When to invoke instead of `/llm-externalizer:llm-externalizer-configure`.** This setup wizard is for first-time local-model setup or when a model is failing compatibility tests. For OpenRouter-only setup or to inspect an existing config, use `llm-externalizer-configure` instead — it is read-only and lighter weight.
