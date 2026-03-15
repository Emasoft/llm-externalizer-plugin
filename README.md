# LLM Externalizer Plugin

Claude Code plugin that offloads bounded LLM tasks to cheaper local or remote models via MCP.

## What it does

Provides MCP tools for sending analysis, scanning, comparison, and generation tasks to external LLMs instead of using expensive Claude subagents. Supports local backends (LM Studio, Ollama, vLLM, llama.cpp) and remote backends (OpenRouter) with profile-based configuration and ensemble mode.

## Prerequisites

- Node.js >= 18
- npm
- For local backends: a running LM Studio, Ollama, vLLM, or llama.cpp server
- For remote backends: an OpenRouter API key (`OPENROUTER_API_KEY` environment variable)

## Installation

### From marketplace

Add the `Emasoft/emasoft-plugins` marketplace to Claude Code, then install `llm-externalizer-plugin`.

### From source

```bash
git clone https://github.com/Emasoft/llm-externalizer-plugin.git
cd llm-externalizer-plugin
bash scripts/setup.sh
```

Then add it to Claude Code:
```bash
claude plugin add ./llm-externalizer-plugin
```

## Setup

After installation, build the MCP server:

```bash
bash $CLAUDE_PLUGIN_ROOT/scripts/setup.sh
```

On first run, the server creates a settings template at `~/.llm-externalizer/settings.yaml` with 4 predefined profiles.

### Optional: statusline

```bash
bash $CLAUDE_PLUGIN_ROOT/scripts/install-statusline.sh
```

Shows model, context usage, and cost stats in the Claude Code status bar.

## Components

### Skills (auto-discovered)

- **llm-externalizer-usage** — When and how to use the MCP tools, input fields, usage patterns, constraints
- **llm-externalizer-config** — Profile management, settings workflow, validation rules, ensemble configuration

### Commands

- `/llm-externalizer-plugin:discover` — Check health, active profile, auth status
- `/llm-externalizer-plugin:configure` — List, switch, or add profiles

### MCP Tools

**Read-only analysis:**
| Tool | Purpose |
|------|---------|
| `chat` | General-purpose: summarize, compare, translate, generate text |
| `code_task` | Code-optimized analysis with code-review system prompt |
| `batch_check` | Same instructions applied to each file separately |
| `scan_folder` | Auto-discover files in a directory tree and check each |
| `compare_files` | Compute diff between 2 files, LLM summarizes changes |
| `check_references` | Resolve imports, send source+deps to LLM for validation |
| `check_imports` | LLM extracts imports, server validates each path exists |

**Utility:**
| Tool | Purpose |
|------|---------|
| `discover` | Service health, context window, profiles |
| `change_model` | Switch model in active profile |
| `get_settings` | Read settings file |
| `set_settings` | Write settings file (with backup + validation) |

## Configuration

Settings at `~/.llm-externalizer/settings.yaml`. See the `llm-externalizer-config` skill for full documentation.

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

## License

MIT
