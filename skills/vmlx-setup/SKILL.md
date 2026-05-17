---
name: vmlx-setup
description: |-
  Install, set up, and configure the vMLX backend — an MLX-native inference
  server for Apple Silicon (jjang-ai/vmlx) exposing an OpenAI/Anthropic/Ollama
  compatible API. Use when the user wants MLX-native serving on an Apple
  Silicon Mac, says "set up vmlx", "install vmlx", "mlx inference server",
  "run mlx-community models", or the llm-externalizer setup wizard picks vMLX
  as the macOS backend. Apple Silicon (M1/M2/M3/M4) ONLY.
argument-hint: "[model-id] [--port N] [--api-key KEY]"
effort: medium
---

# vMLX — MLX-native inference server setup

`jjang-ai/vmlx` is an **MLX-native inference server for Apple Silicon**. It
serves LLMs/VLMs from the `mlx-community` Hugging Face org and exposes an
**OpenAI + Anthropic + Ollama compatible HTTP API on `http://localhost:8000`**.
It is self-hosted — no third-party API keys.

Compared with `vllm-metal` (vLLM core + an MLX backend plugin), vMLX is
MLX-native end to end: lighter-weight, and it ships built-in `doctor`
(diagnostics) and `bench` (performance) subcommands the setup wizard can use
directly for reliability + benchmark checks.

## Scope and limits — read first

- **Apple Silicon only.** M1/M2/M3/M4, Python 3.10+. Not Intel Macs, not
  Linux/Windows.
- **`mlx-community` models.** Thousands of pre-quantized MLX models work out
  of the box; vMLX can also `convert` other models to MLX / JANG quant.
- **Structured output is NOT assumed.** The llm-externalizer requires
  `response_format: { type: "json_schema" }`. vMLX is OpenAI-compatible and
  has tool-call / reasoning parsers, but json-schema structured output must be
  verified empirically — run the setup wizard's Step 5 compatibility test
  before trusting a given model.
- **Community-maintained**, Apache-2.0. Treat as an alternative backend, not
  the default macOS choice.

## Step 1 — Preflight

```bash
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] \
  || { echo "vMLX requires Apple Silicon (arm64). Aborting."; exit 1; }
```

If this fails, stop — vMLX has no path on Intel Macs or non-Apple platforms.

## Step 2 — Install

vMLX is on PyPI as `vmlx`. macOS 14+ rejects bare `pip install`
(externally-managed-environment) — use an isolated installer. Show the command;
let the user run it.

```bash
# Preferred — uv (fast, isolated tool install)
brew install uv 2>/dev/null; uv tool install vmlx

# Alternative — pipx (isolated per-app environment)
brew install pipx 2>/dev/null; pipx install vmlx

# Alternative — venv (legacy)
python3 -m venv ~/.vmlx-env && source ~/.vmlx-env/bin/activate && pip install vmlx
```

Pick ONE. `uv tool install` is the cleanest — it puts `vmlx` on PATH without a
venv to activate. For image generation the user additionally needs
`vmlx[image]`.

## Step 3 — Serve a model

```bash
vmlx serve <model-id> --port 8000
```

- `<model-id>` is any `mlx-community/*` HF repo, e.g.
  `mlx-community/Qwen3-8B-4bit`. vMLX downloads it on first run.
- Default bind is `0.0.0.0:8000`. Keep the terminal running or background it.

For llm-externalizer scan workloads, useful serve flags:

| Flag | Why it helps a scan workload |
|---|---|
| `--max-model-len 32768` | llm-externalizer needs a ≥32K context window. |
| `--continuous-batching` | Concurrent request handling — matters for parallel scans. |
| `--enable-prefix-cache` | Reuses KV state when many scans share a prompt prefix. |
| `--enable-pld` | Prompt Lookup Decoding — strong for code / JSON / schema-heavy output, no draft model needed. |
| `--kv-cache-quantization q8` | Shrinks KV cache on low-RAM Macs (`q4` is more aggressive). |
| `--api-key sk-...` | Optional auth; if set, put the same value in the profile's `api_token`. |

Example tuned for scanning on a 16 GB Mac:

```bash
vmlx serve mlx-community/Qwen3-8B-4bit --port 8000 \
  --max-model-len 32768 --continuous-batching --enable-prefix-cache \
  --enable-pld --kv-cache-quantization q8
```

## Step 4 — Reliability + benchmark (built-in)

vMLX ships diagnostics and benchmarking — use these instead of hand-rolling:

```bash
vmlx doctor <model-id>   # diagnostics — environment + model health
vmlx info   <model-id>   # model metadata and config
vmlx bench  <model-id>   # throughput / latency benchmark
```

`vmlx doctor` + `vmlx bench` are the canonical reliability + performance data
source when the setup wizard needs to evaluate a candidate model on this
machine. Surface their output to the user; do not re-implement what they
already measure.

## Step 5 — Verify

```bash
curl -s http://localhost:8000/v1/models | jq '.data[].id'
```

Then a real completion, or let the setup wizard's Step 5 run the five
calibrated compatibility tests (smoke, structured output, code understanding,
long context, output length).

## Step 6 — Wire into llm-externalizer

vMLX's API is OpenAI-compatible on `:8000`, so the **`vllm-local`** preset
(default `http://localhost:8000`) fits as-is; **`generic-local`** is the
explicit fallback if you need to point at a custom URL.

```yaml
profiles:
  vmlx-local:
    mode: local
    api: vllm-local            # OpenAI-compatible on :8000; or generic-local
    model: "<model-id>"        # same id you passed to `vmlx serve`
    # url defaults to http://localhost:8000 — override only on a custom port
    # api_token: $LM_API_TOKEN # only if you started vmlx with --api-key
```

Hand the snippet to the user to paste into `~/.llm-externalizer/settings.yaml`
(the wizard / `build-snippet.py` handles safe YAML quoting). NEVER write that
file directly — profile changes are user-only.

## Maintenance

- **Upgrade:** `uv tool upgrade vmlx` (or `pipx upgrade vmlx`).
- **Uninstall:** `uv tool uninstall vmlx` (or `pipx uninstall vmlx`, or delete
  `~/.vmlx-env`).
- **Desktop alternative:** the project also ships "MLX Studio", a native macOS
  app — mention it for users who do not want a terminal server.

## Failure modes

- **`pip install vmlx` aborts (externally-managed-environment)** → use
  `uv tool install` or `pipx` per Step 2.
- **`vmlx` not found after install** → for the venv path, the venv was not
  activated; `uv tool install` avoids this by putting `vmlx` on PATH directly.
- **Out-of-memory on load** → smaller model / quant, lower `--max-model-len`,
  add `--kv-cache-quantization q4`.
- **`vmlx doctor` reports failures** → surface its output verbatim to the user
  before continuing; it is the authoritative health check.

## Related

- `vllm-metal-setup` skill — the vLLM-on-MLX alternative. Use vllm-metal when
  the user specifically wants vLLM semantics; use vMLX for a lighter MLX-native
  server with built-in `doctor` / `bench`.
- `huggingface-mlx-models` skill — selecting MLX-quantized models from the Hub.
