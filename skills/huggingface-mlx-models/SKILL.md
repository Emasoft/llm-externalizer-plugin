---
name: huggingface-mlx-models
description: "Select MLX-quantized models from the Hugging Face Hub and run them on Apple Silicon (arm64) via mlx_lm. Covers mxfp4 / nvfp4 / OptiQ-4bit / DQ3_K_M / DQ4plus / mixed_* quant interpretation, unified-memory budgeting, mlx_lm.server launch, and the `generic-local` preset wiring for the llm-externalizer plugin. NOT for Intel Macs (use huggingface-local-models — llama.cpp Metal works on x86_64) or non-Apple platforms."
user-invocable: false
---

## Integration with the llm-externalizer setup agent

The setup wizard's `scripts/setup/recommend-models.py` already emits, for
every recommended model, the list of MLX artifacts available on Hugging Face
(via the whatcani.run runtime=mlx_lm filter). On Apple Silicon arm64 the
wizard surfaces those first; each artifact comes with a pre-built
`download_command` of the form:

    hf download <hf_repo_id> --local-dir ~/models/<short-name>

(no per-file argument — MLX repos are directory-shaped). The wizard runs
that command verbatim. This skill is consulted for:

- Interpreting MLX-specific quant labels (mxfp4 / nvfp4 / OptiQ-4bit /
  DQ3_K_M / DQ4plus / mixed_3_4 / 4bit-DWQ / GPTQ-Int4) — the recommender
  reports the label but doesn't pick between quants for the user
- Unified-memory budgeting (`~70% of total RAM` rule, with the picker table
  below)
- `mlx_lm.server` launch flags (--port / --host / max-tokens), and the
  `generic-local` preset wiring in settings.yaml
- Converting a non-quantized HF repo to MLX with `mlx_lm.convert` when no
  pre-quantized MLX artifact exists yet

The wizard does NOT call this skill on Intel Macs (`uname -m` reports
`x86_64` even on macOS) — MLX requires arm64. Redirect to
`huggingface-local-models` (llama.cpp Metal) on Intel.

# Hugging Face MLX Models (Apple Silicon)

Find MLX-quantized models on the Hub, pick a quantization that fits Apple
Silicon unified memory, and launch via `mlx_lm` (REPL, single generation, or
OpenAI-compatible HTTP server). MLX is Apple's machine-learning framework
with Metal kernels written specifically for the unified-memory architecture
of M-series chips. On Apple Silicon, MLX typically beats llama.cpp's Metal
backend on prompt-processing throughput because the kernels were not ported
from CUDA — they were written for the platform.

## When to prefer MLX over llama.cpp Metal on a Mac

| Aspect | MLX (`mlx_lm`) | llama.cpp Metal |
|---|---|---|
| Native to Apple Silicon | Yes — Metal kernels designed for unified memory | Yes, but ported from CUDA |
| Throughput on M-series | Generally higher prompt-processing tok/s | Lower (Metal port lags the MLX kernels) |
| Memory efficiency | Slightly better (no host/device copy) | Good |
| Model format | safetensors (mlx-converted) | GGUF |
| Server | `mlx_lm.server` | `llama-server` / LM Studio |
| Quantization variety | 4/5/6/8 bit, mxfp4, mxfp8, nvfp4, DQ*, OptiQ-*, mixed_*, GPTQ-Int4, AWQ-Int4, BF16 | Q4_K_M, Q5_K_M, Q6_K, Q8_0, IQ2-4, UD-* |
| Works on Apple Intel (x86_64) | No — MLX requires arm64 | Yes |
| Cross-platform parity | No (Apple-only) | Yes (same GGUF on Mac/Linux/Windows) |

Use **MLX** when:
- The Mac is arm64 (`uname -m` returns `arm64`)
- You want native speed for prompt-heavy workloads (code review, scan_folder, etc.)
- LM Studio is not in the picture (LM Studio uses GGUF + llama.cpp internally even on Mac)

Use **llama.cpp Metal** when:
- Apple Silicon is not available (Intel Mac)
- You also need cross-platform parity (same artifact on Mac/Linux/Windows)
- LM Studio is your chosen runner

## Default workflow

1. **Gate on Apple Silicon.** `[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]` must be true. If not, redirect to `huggingface-local-models` (llama.cpp Metal works on both arm64 and x86_64).
2. **Install mlx-lm.** `uv tool install mlx-lm` (preferred — isolated env, fast) or `pip install --user mlx-lm`. Verify with `mlx_lm.generate --help`. The package brings in `mlx_lm.server`, `mlx_lm.generate`, `mlx_lm.convert`, `mlx_lm.chat`.
3. **Find an MLX model.** Search the `mlx-community/` namespace on HF for the model family you want. Most prominent OSS models have a community-maintained MLX conversion. Examples:
   - `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`
   - `mlx-community/gemma-4-31b-it-4bit`
   - `mlx-community/Llama-3.2-3B-Instruct-4bit`
   - `mlx-community/Meta-Llama-3.1-8B-Instruct-4bit`
   - `mlx-community/Kimi-K2-Instruct-4bit`
   - `mlx-community/MiniMax-M2.7-4bit`
4. **Pick a quantization.** See the picker table below. Smallest compatible quant is usually the best default. Quality order (top = best): `BF16 > 8bit > 6bit > mxfp4 ≈ OptiQ-4bit > 4bit > 3bit`. Compound schemes (DQ*, mixed_*) sit in the middle.
5. **Download.** Via the `hf` CLI (see the `hf-cli` skill for full reference):
   ```bash
   hf download mlx-community/<repo-name> --local-dir ~/models/<short-name>
   ```
   MLX repos are usually directories of safetensors shards, not single files — omit the per-file argument.
6. **Run.** For the llm-externalizer plugin we want the OpenAI-compatible server:
   ```bash
   mlx_lm.server --model ~/models/<short-name> --port 8080 --host 127.0.0.1
   ```
   The server exposes `http://127.0.0.1:8080/v1/chat/completions` and `http://127.0.0.1:8080/v1/models`.
7. **Wire into settings.yaml.** Use the `generic-local` preset — MLX is its own server, not LM Studio. Snippet:
   ```yaml
   profiles:
     mlx-<model-short-name>:
       mode: local
       api: generic-local
       url: "http://127.0.0.1:8080/v1"
       model: "<basename mlx_lm reports at /v1/models>"
       timeout: 600
       context_window: 32768
   ```

## Quick start (single command sequence)

```bash
uv tool install mlx-lm
hf download mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
    --local-dir ~/models/qwen2.5-coder-7b-mlx
mlx_lm.server --model ~/models/qwen2.5-coder-7b-mlx \
    --port 8080 --host 127.0.0.1
```

Add to `~/.llm-externalizer/settings.yaml` under `profiles:`:

```yaml
  mlx-qwen2.5-coder-7b:
    mode: local
    api: generic-local
    url: "http://127.0.0.1:8080/v1"
    model: "qwen2.5-coder-7b-mlx"
    timeout: 600
    context_window: 32768
```

Then call `mcp__llm-externalizer__reset` to reload settings without restarting Claude Code.

## Quantization picker — Apple Silicon unified memory

Rule of thumb: model weights + KV cache (~10% of model at 32K context) + ~5GB OS/headroom must fit comfortably under ~70% of total unified RAM. The 30% reserve absorbs Chrome, the IDE, the Claude Code session, and whatever else the user is running.

| Unified RAM | 1-4B | 7-9B | 13-16B | 24-32B | 70B+ |
|---|---|---|---|---|---|
|  8 GB | 4bit, BF16  | 4bit, 3bit  | —           | —             | — |
| 16 GB | BF16        | 8bit, BF16  | 4bit        | —             | — |
| 24 GB | BF16        | BF16        | 6bit, 8bit  | 4bit          | — |
| 32 GB | BF16        | BF16        | 8bit, BF16  | 4bit, mxfp4   | 3bit (uncomfortable) |
| 48 GB | BF16        | BF16        | BF16        | 6bit, 8bit    | 4bit  |
| 64 GB | BF16        | BF16        | BF16        | 8bit, BF16    | 4bit, 5bit |
| 96 GB | BF16        | BF16        | BF16        | BF16          | 4bit, 6bit |
| 128+ GB | BF16      | BF16        | BF16        | BF16          | 6bit, 8bit |

The table is conservative — actual usability depends on context length and concurrent apps.

### Beyond plain bit-quants

| Label | What it is | When to use |
|---|---|---|
| `mxfp4` / `mxfp8` | Apple's mixed-FP format — same memory as 4bit/8bit but the per-block scale uses FP rather than INT | Try first when quality matters more than maximum size reduction on Apple Silicon |
| `nvfp4` | NVIDIA-style FP4 (1 sign, 3 exponent, 0 mantissa per block scale) | Smaller than mxfp4 but slightly lower quality on Apple Silicon |
| `OptiQ-4bit` | Apple-optimized 4bit; quality between plain 4bit and 5bit | Drop-in replacement for plain 4bit when available |
| `DQ3_K_M` | MLX dynamic quantization, ~3.5bit-equivalent average via per-layer adaptive bitwidth | When memory is tight but you want better quality than plain 3bit |
| `DQ4plus` | MLX dynamic-quant variant, ~4.2bit-equivalent | Good middle-ground between 4bit and 5bit |
| `mixed_3_4` / `mixed_3_5` / `mixed_4_8` etc. | Per-layer mixed precision; the two digits are the precisions used for different layers | Experimental; near-lossless at smaller total size on some models |
| `GPTQ-Int4` / `AWQ-Int4` | Calibrated INT4 quantization (uses a calibration dataset) | Often higher quality than plain 4bit at the same size; slower to load |
| `4bit-DWQ` | "Dynamic weight quantization" variant | Similar to DQ schemes; treat as ~4.5bit |
| `BF16` | No quantization — full bf16 weights | When you have the RAM and want the best possible quality |

## Listing & comparing MLX models

The companion `huggingface-best` skill can find the highest-scoring model
that fits the user's machine, using the official HF benchmark leaderboards.
For MLX-specific repo discovery:

```bash
# Browse the mlx-community namespace
hf api GET '/api/models?author=mlx-community&limit=50'

# Get the file list of a specific repo
hf api GET '/api/models/mlx-community/Qwen2.5-Coder-7B-Instruct-4bit/tree/main?recursive=true'
```

The llm-externalizer plugin's recommender script
(`scripts/setup/recommend-models.py`) already filters whatcani.run's
featured artifacts by runtime: on Apple Silicon it surfaces `mlx_lm`
runtime entries first, with quantization, file size, and download command
pre-built.

## Common gotchas

1. **Intel Macs**: MLX requires Apple Silicon. On Intel, `mlx-lm` installs but fails at runtime. Redirect to `huggingface-local-models` (llama.cpp Metal works on both arm64 and x86_64).
2. **Unified memory pressure**: Loading a 27B 4bit model on a 32 GB Mac with Chrome + IDE + Claude Code open will trigger swap. Close apps or pick a smaller quant before launch.
3. **Repos with only BF16 weights**: some MLX repos haven't been quantized yet. Quantize locally:
   ```bash
   mlx_lm.convert --hf-path mlx-community/<repo> \
       --mlx-path ~/models/<short-name>-q4 \
       --quantize --q-bits 4
   ```
4. **Tokenizer not registered**: if mlx-lm hasn't added support for a new tokenizer family, `mlx_lm.server` fails at load time with `mlx_lm: tokenizer not registered`. Pick a different repo (usually a slightly older / more popular family) or upgrade mlx-lm (`uv tool upgrade mlx-lm`).
5. **Model name in settings.yaml**: `mlx_lm.server` reports the model name as the directory basename in its `/v1/models` response. Set the `model:` field in your llm-externalizer profile to match exactly, or the plugin's `discover` tool will report a name mismatch.
6. **Port conflict with llama.cpp**: both `mlx_lm.server` and `llama-server` default to port 8080. If both are running, pick different ports explicitly with `--port`.
7. **Memory limit on 8 GB Macs**: an 8 GB Apple Silicon Mac with macOS, Chrome, and Claude Code already consumes ~5-6 GB. Only the smallest 4bit ≤3B models leave usable margin. Recommend OpenRouter remote mode (the llm-externalizer's `remote-ensemble` profile) instead.

## Related skills

- **`huggingface-local-models`** — the GGUF / llama.cpp path. Use when on Intel Mac, Linux, Windows, or when cross-platform GGUF parity matters.
- **`hf-cli`** — full reference for the `hf` command (download, upload, search, cache management). Required for any MLX setup since downloads happen via `hf download`.
- **`huggingface-best`** — finds the highest-scoring model for a task within the user's memory budget, across the official HF leaderboards.
- **`huggingface-community-evals`** — runs benchmark evaluations against a chosen model (inspect-ai, lighteval). Use AFTER the model is downloaded and serving, if you want quantitative validation beyond the llm-externalizer's 5-test compatibility check.
