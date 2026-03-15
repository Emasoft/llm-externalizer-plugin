# Configuration Guide

## Table of Contents

- [Modes](#modes)
- [API Presets](#api-presets)
- [Profile Fields](#profile-fields)
- [Auth Resolution](#auth-resolution)
- [Managing Profiles via MCP](#managing-profiles-via-mcp)
- [Validation Rules](#validation-rules)
- [Ensemble Mode](#ensemble-mode)
- [Environment Variables](#environment-variables)
- [CLI Profile Management](#cli-profile-management)
- [Troubleshooting](#troubleshooting)

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

Default env vars are set by the API preset. If `discover` shows the token is resolved, auth is working. If it shows `(NOT SET)`, the env var is missing from the MCP server's process environment — check the MCP server env configuration.

## Managing Profiles via MCP

The settings file is `~/.llm-externalizer/settings.yaml` (YAML format, NOT JSON).

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

## CLI Profile Management

As an alternative to the MCP workflow, use the CLI directly:

```bash
npx llm-externalizer profile list
npx llm-externalizer profile add <name> --mode <mode> --api <api> --model <model>
npx llm-externalizer profile select <name>
npx llm-externalizer profile edit <name> --field <value>
npx llm-externalizer profile remove <name>
npx llm-externalizer profile rename <old> <new>
```

Run from the `mcp-server/` directory within the plugin.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `discover` shows `(NOT SET)` for auth token | Env var missing from MCP server process | Add the env var to `.mcp.json` env block or export it in shell |
| Connection refused to local server | LM Studio / Ollama not running | Start the local server, verify URL and port |
| `set_settings` validation error | Invalid profile config | Check validation rules above; ensure mode/api preset match |
| Ensemble returns only one model's results | File exceeds size limit for one model | Normal behavior — grok limit is 20K lines, gemini 50K lines |
| Tools return "not configured" | No active profile or settings.yaml missing | Run `discover` to check; create settings with `get_settings` + `set_settings` |
