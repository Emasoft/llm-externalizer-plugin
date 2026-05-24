# vMLX Install, Serve, Diagnostics, Verify, Wire

## Table of Contents

- [Step 1 — Preflight](#step-1--preflight)
- [Step 2 — Install](#step-2--install)
- [Step 3 — Serve a model](#step-3--serve-a-model)
- [Step 4 — Reliability + benchmark (built-in)](#step-4--reliability--benchmark-built-in)
- [Step 5 — Verify](#step-5--verify)
- [Step 6 — Wire into llm-externalizer](#step-6--wire-into-llm-externalizer)
- [Maintenance](#maintenance)
- [Failure modes](#failure-modes)
- [Examples](#examples)

## Step 1 — Preflight

```bash
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] \
  || { echo "vMLX requires Apple Silicon (arm64). Aborting."; exit 1; }
```

If this fails, stop — vMLX has no path on Intel Macs or non-Apple platforms.

## Step 2 — Install

macOS 14+ rejects bare `pip install` (externally-managed-environment) — use an isolated installer. Show the command; let the user run it.

```bash
# Preferred — uv (fast, isolated tool install)
brew install uv 2>/dev/null; uv tool install vmlx

# Alternative — pipx (isolated per-app environment)
brew install pipx 2>/dev/null; pipx install vmlx

# Alternative — venv (legacy)
python3 -m venv ~/.vmlx-env && source ~/.vmlx-env/bin/activate && pip install vmlx
```

Pick ONE. `uv tool install` is cleanest — puts `vmlx` on PATH without venv activation. For image generation: `vmlx[image]`.

## Step 3 — Serve a model

```bash
vmlx serve <model-id> --port 8000
```

- `<model-id>` is any `mlx-community/*` HF repo (e.g. `mlx-community/Qwen3-8B-4bit`). Downloads on first run.
- Default bind: `0.0.0.0:8000`. Keep terminal running or background.

For llm-externalizer scan workloads:

| Flag | Why it helps |
|---|---|
| `--max-model-len 32768` | llm-externalizer needs ≥32K context. |
| `--continuous-batching` | Concurrent request handling. |
| `--enable-prefix-cache` | Reuses KV state when scans share prompt prefix. |
| `--enable-pld` | Prompt Lookup Decoding — strong for code/JSON/schema-heavy output. |
| `--kv-cache-quantization q8` | Shrinks KV cache (`q4` more aggressive). |
| `--api-key sk-...` | Optional auth; set matching `api_token` in profile. |

Example for scanning on a 16 GB Mac:

```bash
vmlx serve mlx-community/Qwen3-8B-4bit --port 8000 \
  --max-model-len 32768 --continuous-batching --enable-prefix-cache \
  --enable-pld --kv-cache-quantization q8
```

## Step 4 — Reliability + benchmark (built-in)

```bash
vmlx doctor <model-id>   # diagnostics — environment + model health
vmlx info   <model-id>   # model metadata and config
vmlx bench  <model-id>   # throughput / latency benchmark
```

`vmlx doctor` + `vmlx bench` are canonical reliability + performance data sources. Surface their output to the user.

## Step 5 — Verify

```bash
curl -s http://localhost:8000/v1/models | jq '.data[].id'
```

Then a real completion, or let the setup wizard's Step 5 run the five calibrated compatibility tests (smoke, structured output, code understanding, long context, output length).

## Step 6 — Wire into llm-externalizer

vMLX is OpenAI-compatible on `:8000` → `vllm-local` preset fits as-is:

```yaml
profiles:
  vmlx-local:
    mode: local
    api: vllm-local            # OpenAI-compatible on :8000
    model: "<model-id>"        # same id you passed to `vmlx serve`
    # url defaults to http://localhost:8000 — override only on a custom port
    # api_token: $VLLM_API_KEY # only if you started vmlx with --api-key (vllm-local preset's default auth env)
```

Hand snippet to user. NEVER write `~/.llm-externalizer/settings.yaml` directly.

## Maintenance

- **Upgrade:** `uv tool upgrade vmlx` (or `pipx upgrade vmlx`).
- **Uninstall:** `uv tool uninstall vmlx` (or `pipx uninstall vmlx`, or delete `~/.vmlx-env`).
- **Desktop alternative:** the project ships "MLX Studio", a native macOS app — mention for terminal-averse users.

## Failure modes

- **`pip install vmlx` aborts (externally-managed-environment)** — use `uv tool install` or `pipx`.
- **`vmlx` not found** — for venv path, activate venv; `uv tool install` avoids this by putting `vmlx` on PATH.
- **OOM on load** — smaller model/quant, lower `--max-model-len`, add `--kv-cache-quantization q4`.
- **`vmlx doctor` reports failures** — surface output verbatim before continuing.

## Examples

```bash
# Happy-path install + serve on M2 Pro 32 GB
uv tool install vmlx
vmlx serve mlx-community/Qwen3-8B-4bit --port 8000 \
  --max-model-len 32768 --continuous-batching --enable-prefix-cache \
  --enable-pld --kv-cache-quantization q8

# Built-in diagnostics
vmlx doctor mlx-community/Qwen3-8B-4bit
vmlx bench  mlx-community/Qwen3-8B-4bit
```
