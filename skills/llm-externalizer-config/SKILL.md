---
name: LLM Externalizer Configuration
description: >-
  Teaches Claude how to configure and manage LLM Externalizer profiles, settings,
  and backend connections. Activates when the agent needs to switch models, add
  profiles, configure local or remote LLM backends, manage ensemble mode, troubleshoot
  auth or connectivity issues, or modify settings.yaml. Also activates when the user
  asks about LLM Externalizer setup, profiles, or backend configuration.
version: 1.0.0
---

# LLM Externalizer — Configuration

Profile-based configuration for local and remote LLM backends. Settings stored at `~/.llm-externalizer/settings.yaml`.

## Modes

| Mode | Behavior |
|------|----------|
| `local` | Sequential requests to a local server |
| `remote` | Parallel requests, single model via OpenRouter |
| `remote-ensemble` | Parallel requests, two models in parallel, combined report |

## API Presets

Each profile uses an `api` preset that bundles protocol + default connection settings.

### Local presets (mode: local)

| Preset | Protocol | Default URL | Auth |
|--------|----------|-------------|------|
| `lmstudio-local` | LM Studio native API | `http://localhost:1234` | `$LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | (none) |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `$VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | (none) |
| `generic-local` | OpenAI-compatible | (url required) | `$LM_API_TOKEN` |

### Remote presets (mode: remote / remote-ensemble)

| Preset | Protocol | Default URL | Auth |
|--------|----------|-------------|------|
| `openrouter-remote` | OpenRouter API | `https://openrouter.ai/api` | `$OPENROUTER_API_KEY` |

## Profile Fields

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | Yes | `local`, `remote`, or `remote-ensemble` |
| `api` | Yes | API preset name from the presets table |
| `model` | Yes | Model identifier (e.g. `thecluster/qwen3.5-27b-mlx`) |
| `url` | No | Override preset default URL |
| `api_key` | No | API key for remote presets (env var ref or direct value) |
| `api_token` | No | Auth token for local presets (env var ref or direct value) |
| `second_model` | Only for `remote-ensemble` | Second model identifier |
| `timeout` | No | Request timeout in seconds |
| `context_window` | No | Context window override (0 = auto-detect) |
| `max_concurrent` | No | Max parallel requests (0 = auto) |

## Auth Resolution

Auth fields accept either:
- **`$ENV_VAR_NAME`** — resolved from process environment at runtime
- **`"direct-value"`** — used as-is

Default env vars are set by the API preset. Do NOT report auth errors if `discover` shows the token is resolved. If `discover` shows `(NOT SET)`, the env var is missing from the MCP server's process environment.

## Managing Profiles via MCP

The settings file is `~/.llm-externalizer/settings.yaml` (YAML format, NOT JSON).

### Step-by-step workflow

**Step 1**: Call `get_settings` (no parameters) to get an editable copy. Returns a file path.

**Step 2**: Read and edit the file using Read and Edit tools. The YAML structure:

```yaml
active: my-profile-name       # must match a key under profiles:

profiles:
  my-profile-name:
    mode: local                # REQUIRED: local | remote | remote-ensemble
    api: lmstudio-local        # REQUIRED: preset name
    model: "model-name-or-id"  # REQUIRED: model identifier
```

**Step 3**: Call `set_settings` with `file_path` pointing to the edited file. Validates before writing. Old settings never overwritten if new content is invalid.

**Step 4**: Call `discover` to verify.

**CRITICAL**: `set_settings` replaces the entire settings.yaml. The edited file must include ALL profiles, not just the one you changed.

## Validation Rules

- `active` must reference an existing profile key
- `mode` must be `local`, `remote`, or `remote-ensemble`
- `api` must be a valid preset name
- `local` mode requires a `-local` preset; `remote`/`remote-ensemble` requires `openrouter-remote`
- `remote-ensemble` requires `second_model`
- Remote presets require a resolvable `api_key`

## Ensemble Mode

On OpenRouter with `remote-ensemble` mode, read-only content tools run on both models in parallel. Results are combined in one report with per-model sections.

- Set `ensemble: false` on individual tool calls for simple tasks to save tokens
- Per-model file size limits: grok skipped >20,000 lines, gemini skipped >50,000 lines
- On local backends, ensemble is a no-op

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (default for openrouter-remote preset) |
| `LM_API_TOKEN` | LM Studio / generic-local auth token |
| `VLLM_API_KEY` | vLLM auth token |
| `LLM_EXT_CONFIG_DIR` | Override settings directory (default: `~/.llm-externalizer`) |
| `LLM_OUTPUT_DIR` | Override output directory (default: `./llm_externalizer_output`) |

## Profile Templates

See `references/profile-templates.md` for ready-to-use profile YAML blocks.
