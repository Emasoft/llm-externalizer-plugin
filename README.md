# llm-externalizer

A Claude Code plugin that offloads bounded LLM tasks to cheaper local or remote models via MCP. Supports local backends (LM Studio, Ollama, vLLM, llama.cpp) and remote backends (OpenRouter) with profile-based configuration and ensemble mode.

## What it does

Provides MCP tools for sending analysis, scanning, comparison, and generation tasks to external LLMs instead of using expensive Claude subagents. All results are saved to files — the tools return only file paths, keeping the orchestrator's context clean.

**Read-only analysis tools:**

| Tool | Purpose |
|------|---------|
| `chat` | General-purpose: summarize, compare, translate, generate text |
| `code_task` | Code-optimized analysis with code-review system prompt |
| `batch_check` | Same instructions applied to each file separately |
| `scan_folder` | Auto-discover files in a directory tree and check each |
| `compare_files` | Compute diff between 2 files, LLM summarizes changes |
| `check_references` | Resolve imports, send source+deps to LLM for validation |
| `check_imports` | LLM extracts imports, server validates each path exists |

**Utility tools:**

| Tool | Purpose |
|------|---------|
| `discover` | Service health, context window, profiles, auth status |
| `reset` | Full soft-restart (reloads settings, clears caches) |
| `change_model` | Switch model in active profile |
| `get_settings` | Copy settings file to output dir for editing |
| `set_settings` | Validate and apply edited settings (with backup) |

### Ensemble mode

On OpenRouter, requests can run on **two models in parallel** (default: grok-4.1-fast + gemini-2.5-flash) with results combined in one report. Set `ensemble: false` for simple tasks to save tokens.

### Auto-batching

When input files exceed the model's context window, tools automatically split them into batches, repeating instructions for each batch.

## Prerequisites

- **Node.js >= 18** and **npm** — to build the bundled MCP server
- For local backends: a running LM Studio, Ollama, vLLM, or llama.cpp server
- For remote backends: an OpenRouter API key (`OPENROUTER_API_KEY` environment variable)

## Naming

- **Plugin name**: `llm-externalizer` — this is the name in `plugin.json` and what you use with `claude plugin install`
- **GitHub repo**: [`Emasoft/llm-externalizer-plugin`](https://github.com/Emasoft/llm-externalizer-plugin) — where the source code lives

The plugin name and repo name are intentionally different. When installing or referencing the plugin, always use `llm-externalizer` (the plugin name), not `llm-externalizer-plugin` (the repo name).

## Installation

### From the emasoft-plugins marketplace (recommended)

```bash
claude plugin install llm-externalizer@emasoft-plugins
```

If you haven't added the marketplace yet:

```bash
claude plugin marketplace add Emasoft/emasoft-plugins
```

Then install:

```bash
claude plugin install llm-externalizer@emasoft-plugins
```

Restart Claude Code to activate.

### Alternative: manual settings.json

Add the marketplace and enable the plugin in `~/.claude/settings.json`:

```json
{
  "pluginMarketplaces": [
    "Emasoft/emasoft-plugins"
  ],
  "enabledPlugins": {
    "llm-externalizer@emasoft-plugins": true
  }
}
```

Restart Claude Code or run `/reload-plugins` to activate.

### Manual installation (development)

```bash
# Clone the plugin repo directly
git clone https://github.com/Emasoft/llm-externalizer-plugin.git /tmp/llm-externalizer-plugin

# Build the MCP server
cd /tmp/llm-externalizer-plugin
bash scripts/setup.sh

# Install from local path
claude plugin install /tmp/llm-externalizer-plugin
```

### Plugin directory structure

```
llm-externalizer-plugin/
  .claude-plugin/
    plugin.json               # Plugin manifest
  .github/
    workflows/
      notify-marketplace.yml  # Auto-notify emasoft-plugins on version bump
  .mcp.json                   # MCP server configuration
  commands/
    configure.md              # /llm-externalizer:configure command
    discover.md               # /llm-externalizer:discover command
  mcp-server/                 # Bundled TypeScript MCP server source
    src/
    package.json
    tsconfig.json
  scripts/
    setup.sh                  # Build script (npm install + npm run build)
    install-statusline.sh     # Optional statusline installer
    bump_version.py           # Semver bumper for plugin.json
    publish.py                # Full release pipeline
    pre-push                  # Git pre-push quality gate hook
  skills/
    llm-externalizer-usage/   # Tool selection, input fields, usage patterns
      SKILL.md
      references/
      examples/
    llm-externalizer-config/  # Profile management, settings, ensemble config
      SKILL.md
      references/
```

## Setup

After installation, the MCP server needs to be built (the marketplace install handles this automatically via `scripts/setup.sh`):

```bash
cd mcp-server && npm install && npm run build
```

On first run, the server creates a settings template at `~/.llm-externalizer/settings.yaml` with 4 predefined profiles.

### Optional: statusline

```bash
bash $CLAUDE_PLUGIN_ROOT/scripts/install-statusline.sh
```

Shows model, context usage, and cost stats in the Claude Code status bar.

## Configuration

Settings at `~/.llm-externalizer/settings.yaml`. Use `/llm-externalizer:configure` to manage profiles interactively, or edit the YAML directly.

Quick start with OpenRouter:

```yaml
active: remote-ensemble

profiles:
  remote-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    api_key: $OPENROUTER_API_KEY
```

### Supported backends

| Preset | Protocol | Default URL |
|--------|----------|-------------|
| `lmstudio-local` | LM Studio native API | `http://localhost:1234` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` |
| `generic-local` | OpenAI-compatible | (url required) |
| `openrouter-remote` | OpenRouter API | `https://openrouter.ai/api` |

## Skills (auto-discovered)

- **llm-externalizer-usage** — When and how to use the MCP tools, input fields, usage patterns, constraints, output handling
- **llm-externalizer-config** — Profile management, settings workflow, validation rules, ensemble configuration, troubleshooting

## Commands

- `/llm-externalizer:discover` — Check health, active profile, auth status
- `/llm-externalizer:configure` — List, switch, or add profiles

## Publishing

```bash
# Bump patch version, tag, push, create GitHub release
uv run scripts/publish.py

# Or specify bump level
uv run scripts/publish.py --minor
uv run scripts/publish.py --major
uv run scripts/publish.py --set 4.0.0

# Preview without changes
uv run scripts/publish.py --dry-run
```

The pre-push hook runs TypeScript compilation checks before allowing pushes to main. Install it with:

```bash
ln -sf ../../scripts/pre-push .git/hooks/pre-push
```

## Links

- **Marketplace**: [Emasoft/emasoft-plugins](https://github.com/Emasoft/emasoft-plugins)
- **Repository**: [Emasoft/llm-externalizer-plugin](https://github.com/Emasoft/llm-externalizer-plugin)

## License

MIT
