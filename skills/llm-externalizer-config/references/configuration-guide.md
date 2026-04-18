# Configuration Guide

## Table of Contents

- [Modes](#modes)
- [API Presets](#api-presets)
- [Profile Fields](#profile-fields)
- [Auth Resolution](#auth-resolution)
- [Manual Edit Workflow](#manual-edit-workflow)
- [Validation Rules](#validation-rules)
- [Ensemble Mode](#ensemble-mode)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Modes

| Mode | Behavior |
|------|----------|
| `local` | Sequential requests to a local server |
| `remote` | Parallel requests, single model via OpenRouter |
| `remote-ensemble` | Parallel requests, three models in parallel, combined report |

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
| `third_model` | Optional for `remote-ensemble` | Third model identifier |
| `timeout` | No | Request timeout in seconds |
| `context_window` | No | Context window override (0 = auto-detect) |

## Auth Resolution

Auth fields accept either:
- **`$ENV_VAR_NAME`** — resolved from process environment at runtime
- **`"direct-value"`** — used as-is

Default env vars are set by the API preset. If `discover` shows the token is resolved, auth is working. If it shows `(NOT SET)`, the env var is missing from the MCP server's process environment — check the MCP server env configuration.

## Manual Edit Workflow

**Model & profile configuration is user-only.** The MCP tools `set_settings` and `change_model`, and the CLI subcommands `profile add | select | edit | remove | rename`, are disabled by design. The only supported path is:

**Step 1** — Open `~/.llm-externalizer/settings.yaml` in your editor. You can also call the MCP `get_settings` tool first — it copies the file to the output directory and returns the copy's path, but you are expected to transfer your edits back to the real file yourself.

**Step 2** — Edit the YAML. The structure:

```yaml
active: my-profile-name       # must match a key under profiles:

profiles:
  my-profile-name:
    mode: local                # REQUIRED: local | remote | remote-ensemble
    api: lmstudio-local        # REQUIRED: preset name
    model: "model-name-or-id"  # REQUIRED: model identifier
    # OPTIONAL fields:
    # url: "http://localhost:1234"
    # api_token: $LM_API_TOKEN
    # api_key: $OPENROUTER_API_KEY
    # second_model: "model-id"         # required for remote-ensemble
    # third_model: "model-id"          # optional for remote-ensemble
    # timeout: 300
    # context_window: 100000
```

**Step 3** — Save the file.

**Step 4** — Reload. Either restart Claude Code, or call the `reset` MCP tool to reload without restarting.

**Step 5** — Verify with `discover`.

**CRITICAL**: The file on disk IS the source of truth. Every profile you want to keep must appear in the file — a missing profile is a deleted profile after reload.

## Validation Rules

Validation runs at load time (when the server starts or `reset` is called). If validation fails, the server logs an error and the affected profile becomes unusable. Rules:

- `active` must reference an existing profile key
- `mode` must be `local`, `remote`, or `remote-ensemble`
- `api` must be a valid preset name
- `local` mode requires a `-local` preset; `remote`/`remote-ensemble` requires `openrouter-remote`
- `remote-ensemble` requires `second_model`
- Remote presets require a resolvable `api_key`

To recover: edit the file to fix the issue, save, and call `reset` (or restart Claude Code).

## Ensemble Mode

On OpenRouter with `remote-ensemble` mode, read-only content tools run on multiple models in parallel. Results are combined in one report with per-model sections.

- Per-model file size limits: grok skipped >20,000 lines, gemini skipped >50,000 lines
- On local backends, ensemble is a no-op

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (default for openrouter-remote preset) |
| `LM_API_TOKEN` | LM Studio / generic-local auth token |
| `VLLM_API_KEY` | vLLM auth token |
| `LLM_EXT_CONFIG_DIR` | Override settings directory (default: `~/.llm-externalizer`) |
| `LLM_OUTPUT_DIR` | Override output directory (default: `./reports_dev/llm_externalizer`) |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `discover` shows `(NOT SET)` for auth token | Env var missing from MCP server process | Add the env var to `.mcp.json` env block or export it in shell, then restart Claude Code |
| Connection refused to local server | LM Studio / Ollama not running | Start the local server, verify URL and port |
| Validation error on reload | Invalid profile config | Check validation rules above; ensure mode/api preset match |
| Ensemble returns only one model's results | File exceeds size limit for one model | Normal behavior — grok limit is 20K lines, gemini 50K lines |
| Tools return "not configured" | No active profile or settings.yaml missing | Open `~/.llm-externalizer/settings.yaml`, confirm `active:` points to a valid profile, save, call `reset` |
| `set_settings` / `change_model` return DISABLED | Expected — tools are user-only | Edit `~/.llm-externalizer/settings.yaml` manually instead |
| `npx llm-externalizer profile add/select/edit/remove/rename` errors out | Expected — CLI mutation is disabled | Edit `~/.llm-externalizer/settings.yaml` manually instead |
