# vllm-metal Install, Serve, Tune, Verify, Wire

## Table of Contents

- [Step 1 — Preflight](#step-1--preflight)
- [Step 2 — Install](#step-2--install)
- [Step 3 — Serve a model](#step-3--serve-a-model)
- [Step 4 — Configure env vars (optional)](#step-4--configure-env-vars-optional)
- [Step 5 — Verify](#step-5--verify)
- [Step 6 — Wire into llm-externalizer](#step-6--wire-into-llm-externalizer)
- [Maintenance](#maintenance)
- [Failure modes](#failure-modes)
- [Examples](#examples)

## Step 1 — Preflight

```bash
# Must be Apple Silicon.
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] \
  || { echo "vllm-metal requires Apple Silicon (arm64). Aborting."; exit 1; }
```

If this fails, stop and tell the user to use stock vLLM (Linux/NVIDIA), LM Studio, or Ollama.

## Step 2 — Install

Creates venv at `~/.venv-vllm-metal`. Show the command; let the user run it (do NOT auto-execute):

```bash
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash
```

Optional Rust frontend (requires `rustup`):

```bash
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash -s -- --with-vllm-rs
```

The installer bootstraps `uv` if missing and pins versions. Multi-minute first run.

## Step 3 — Serve a model

```bash
source ~/.venv-vllm-metal/bin/activate
vllm serve <model-id> --port 8000 --max-model-len 32768
```

- `<model-id>` is a full HF repo id (vLLM serves HF repos, not single GGUF files). Pre-download with `hf download` for progress.
- `--max-model-len 32768` — llm-externalizer needs ≥32K context. Lower if RAM can't hold KV cache.
- Leave terminal running or background it.

## Step 4 — Configure env vars (optional)

Set BEFORE `vllm serve`:

| Variable | Default | When to change |
|---|---|---|
| `VLLM_METAL_MEMORY_FRACTION` | `auto` | Low-RAM Macs: fraction like `0.7` (paged attention only). `auto` ≈ 0.9. |
| `VLLM_METAL_USE_PAGED_ATTENTION` | `1` | Leave on. Required for explicit `MEMORY_FRACTION`. |
| `VLLM_MLX_DEVICE` | `gpu` | `cpu` only for debugging. |
| `VLLM_METAL_PREFIX_CACHE` | unset | Set for prefix-cached scan workloads. |
| `VLLM_METAL_DEBUG` | `0` | `1` for startup/inference failures. |

Example for a 16 GB Mac:

```bash
VLLM_METAL_MEMORY_FRACTION=0.7 vllm serve <model-id> --port 8000 --max-model-len 16384
```

## Step 5 — Verify

```bash
curl -s http://localhost:8000/v1/models | jq '.data[].id'
```

A model id means the server is up. Then run the setup wizard's Step 5 (smoke, structured output, code understanding, long context, output length).

## Step 6 — Wire into llm-externalizer

vllm-metal is wire-compatible with the **`vllm-local`** preset:

```yaml
profiles:
  vllm-metal-local:
    mode: local
    api: vllm-local
    model: "<model-id>"          # same id you passed to `vllm serve`
    # url defaults to http://localhost:8000 — override only on a custom port
```

Hand the snippet to the user. NEVER write `~/.llm-externalizer/settings.yaml` directly.

## Maintenance

- **Upgrade / repair:** `rm -rf ~/.venv-vllm-metal` then re-run the installer.
- **Uninstall:** delete `~/.venv-vllm-metal`.
- **Custom install dir:** substitute it everywhere `~/.venv-vllm-metal` appears.

## Failure modes

- **`uv pip install vllm` was run instead** — stock vLLM, won't work on Apple Silicon. Remove env, use the installer.
- **OOM on load** — lower `--max-model-len`, set `VLLM_METAL_MEMORY_FRACTION` smaller, pick smaller model/quant.
- **`vllm` not found** — activate venv (`source ~/.venv-vllm-metal/bin/activate`) or add `bin/` to `PATH`.
- **Rust frontend fails** — `--with-vllm-rs` needs `cargo`+`rustup`; install Rust or drop the flag.

## Examples

```bash
# Full happy-path install + serve on M2 Pro 32 GB
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash
source ~/.venv-vllm-metal/bin/activate
vllm serve mlx-community/Qwen3.6-32B-Instruct-4bit --port 8000 --max-model-len 32768

# Tight-memory variant on M2 16 GB
VLLM_METAL_MEMORY_FRACTION=0.7 vllm serve mlx-community/Llama-3.2-3B-Instruct --port 8000 --max-model-len 16384
```
