---
name: huggingface-mlx-models
description: "Select MLX-quantized models from the Hugging Face Hub and serve them on Apple Silicon (arm64) via mlx_lm.server, vMLX, or LM Studio's MLX runtime. Covers mxfp4 / OptiQ-4bit / DQ3_K_M quant interpretation and unified-memory quant-budget guidance. Use when the setup wizard picks MLX on arm64. Loaded by llm-externalizer-setup-agent."
user-invocable: false
---

## Overview

Select MLX-quantized models from the Hugging Face Hub and serve them on Apple Silicon (arm64). Covers three first-class MLX runtimes (mlx_lm.server, vMLX, LM Studio MLX), quant label interpretation, unified-memory budgeting, and preset wiring. NOT for Intel Macs (use `huggingface-local-models`) or non-Apple platforms.

## Prerequisites

### Integration with the llm-externalizer setup agent

The setup wizard's `scripts/setup/recommend-models.py` already emits, for
every recommended model, the list of MLX artifacts available on Hugging Face
(via the whatcani.run runtime=mlx_lm filter). On Apple Silicon arm64 the
wizard surfaces those first; each artifact comes with a pre-built
`download_command` of the form:

    hf download <hf_repo_id> --local-dir ~/models/<short-name>

(no per-file argument — MLX repos are directory-shaped). The wizard runs
that command verbatim. This skill is consulted for:

- Picking **which MLX runtime** to serve with — `mlx_lm.server`, vMLX, or
  LM Studio MLX runtime (see the side-by-side table below)
- Interpreting MLX-specific quant labels (mxfp4 / nvfp4 / OptiQ-4bit /
  DQ3_K_M / DQ4plus / mixed_3_4 / 4bit-DWQ / GPTQ-Int4) — the recommender
  reports the label but doesn't pick between quants for the user
- Unified-memory quant-budget guidance (total RAM minus 4 GB headroom rule,
  with the picker table below)
- Per-runtime launch flags and the matching `generic-local` /
  `vllm-local` / `lmstudio-local` preset wiring in settings.yaml
- Converting a non-quantized HF repo to MLX with `mlx_lm.convert` when no
  pre-quantized MLX artifact exists yet

The wizard does NOT call this skill on Intel Macs (`uname -m` reports
`x86_64` even on macOS) — MLX requires arm64. Redirect to
`huggingface-local-models` (llama.cpp Metal) on Intel.

### External requirements

- Apple Silicon Mac (M1 / M2 / M3 / M4 — `uname -m` returns `arm64`)
- Python 3.10+ for `mlx_lm.server`
- `hf` CLI authenticated for gated repos
- One of: `pip install mlx-lm`, `brew install vmlx`, or LM Studio installed (`lms` on PATH)

## Instructions

Follow these numbered steps in order:

1. Decide whether MLX is right for this Mac (see "When to prefer MLX over llama.cpp Metal on a Mac" below).
2. Pick a runtime — `mlx_lm.server`, vMLX, or LM Studio MLX runtime (see "The three first-class MLX runtimes").
3. Compute the unified-memory quant budget (total RAM minus 4 GB headroom).
4. Run the runtime-agnostic default workflow to locate, download, and serve a compatible MLX-quantized model.
5. Apply the runtime-specific launch flags (Runtime 1 / 2 / 3 sub-sections).
6. Verify with the `/v1/models` endpoint and wire into the matching settings.yaml preset.

### Hugging Face MLX Models (Apple Silicon)

Find MLX-quantized models on the Hub, pick a quantization that fits the
unified-memory budget of the user's Mac, and serve via one of the three
first-class MLX runtimes. MLX is Apple's machine-learning framework with
Metal kernels written specifically for the unified-memory architecture of
M-series chips. On Apple Silicon, MLX typically beats llama.cpp's Metal
backend on prompt-processing throughput because the kernels were not ported
from CUDA — they were written for the platform.

## When to prefer MLX over llama.cpp Metal on a Mac

| Aspect | MLX (any of the three runtimes) | llama.cpp Metal |
|---|---|---|
| Native to Apple Silicon | Yes — Metal kernels designed for unified memory | Yes, but ported from CUDA |
| Throughput on M-series | Generally higher prompt-processing tok/s | Lower (Metal port lags the MLX kernels) |
| Memory efficiency | Slightly better (no host/device copy) | Good |
| Model format | safetensors (mlx-converted) | GGUF |
| Quantization variety | 4/5/6/8 bit, mxfp4, mxfp8, nvfp4, DQ*, OptiQ-*, mixed_*, GPTQ-Int4, AWQ-Int4, BF16 | Q4_K_M, Q5_K_M, Q6_K, Q8_0, IQ2-4, UD-* |
| Works on Apple Intel (x86_64) | No — MLX requires arm64 | Yes |
| Cross-platform parity | No (Apple-only) | Yes (same GGUF on Mac/Linux/Windows) |

Use **MLX** when:
- The Mac is arm64 (`uname -m` returns `arm64`)
- You want native speed for prompt-heavy workloads (code review, scan_folder, etc.)
- You don't need cross-platform parity for the same artifact

Use **llama.cpp Metal** when:
- Apple Silicon is not available (Intel Mac)
- You also need cross-platform parity (same artifact on Mac/Linux/Windows)
- The user already has LM Studio configured for GGUF and does not want to switch

## The three first-class MLX runtimes (pick one)

All three serve MLX-quantized models from the `mlx-community/*` HF
namespace. They differ in how the user installs and operates them, which
preset they map to in `settings.yaml`, and which extra commands they ship.

| Aspect | `mlx_lm.server` (official) | vMLX (`vmlx serve`) | LM Studio MLX runtime |
|---|---|---|---|
| Provider | Apple's official `mlx-lm` package on PyPI | Community (`jjang-ai/vmlx`) on PyPI | LM Studio (proprietary GUI app, free) |
| Audience | Python users who already have `pip` / `uv` workflow | Power users who want a richer CLI without writing one | GUI users who don't want to touch the terminal |
| Install | `uv tool install mlx-lm` | `uv tool install vmlx` | `brew install --cask lm-studio` (or download .dmg from lmstudio.ai), then enable the MLX runtime in Settings → Runtimes |
| Default port | 8080 (pinned to 8082 by this skill to avoid collision with `llama-server`) | 8000 | 1234 |
| API surface | OpenAI-compatible only | OpenAI + Anthropic + Ollama compatible | LM Studio native API (OpenAI-compatible subset) |
| Extra CLI | `mlx_lm.generate`, `mlx_lm.convert`, `mlx_lm.chat` (one-shot + REPL helpers) | `vmlx doctor`, `vmlx info`, `vmlx bench` (env diagnostics + perf benchmarks shipped in-box) | `lms` CLI (`lms server start`, `lms load`, `lms ls`, `lms log`); GUI for everything else |
| Structured output (`response_format: json_schema`) | Verify empirically per model | Verify empirically per model | Verify empirically per model |
| Best for the llm-externalizer scan workload | Smallest install footprint; minimal flags; ideal for headless servers | Built-in `doctor` + `bench` give the setup wizard reliability + perf data with no hand-rolling | GUI-first users; no command line for download / serve / model swap |
| Preset in `settings.yaml` | `generic-local` (`url: http://127.0.0.1:8082/v1`) | `vllm-local` (`url: http://localhost:8000`) — OpenAI-compatible on `:8000`; or `generic-local` for a custom URL | `lmstudio-local` (`url: http://localhost:1234`) |

**Setup-agent hand-off:** when the user picks vMLX or wants the
`vllm-local` Apple-Silicon path, invoke `Skill(skill: "vmlx-setup")` for
install + serve flags. When the user wants vLLM-on-Apple-Silicon (vLLM
core + the community MLX backend plugin), invoke
`Skill(skill: "vllm-metal-setup")`. For `mlx_lm.server` and the
LM Studio MLX runtime, the recipes in this file are self-contained.

## Quant budget — Apple Silicon unified memory

Apple Silicon shares one pool of unified RAM between CPU and GPU. There
is no separate VRAM. The budget formula is:

    budget = total_unified_RAM − 4 GB headroom for OS + apps

`mlx_lm` then needs room for: model weights (the dominant cost) + KV cache
(~10 % of model size at 32K context) + a small runtime overhead. The
table below maps the budget to the recommended MLX quant for typical
model sizes.

The "headroom" of 4 GB is the floor — on a 8 GB Mac the OS + Chrome +
IDE + Claude Code already consume ~5-6 GB, so the effective budget on
that machine is ~2-3 GB which only the smallest 3B-4bit models fit. On
machines with ≥32 GB the user usually has more apps running too; the
table stays conservative.

| Unified RAM | Budget (RAM − 4 GB) | 1-4B | 7-9B | 13-16B | 24-32B | 70B+ |
|---|---|---|---|---|---|---|
|  8 GB |  4 GB | 4bit, mxfp4 | (tight — only 7B-4bit fits and leaves no margin) | — | — | — |
| 16 GB | 12 GB | BF16 | 8bit, mxfp4 | 4bit, mxfp4 | — | — |
| 24 GB | 20 GB | BF16 | BF16 | 6bit, 8bit, OptiQ-4bit | 4bit, mxfp4 | — |
| 32 GB | 28 GB | BF16 | BF16 | 8bit, BF16 | 4bit, mxfp4, mixed_3_4 | 3bit (uncomfortable) |
| 48 GB | 44 GB | BF16 | BF16 | BF16 | 6bit, 8bit, OptiQ-4bit | 4bit, mxfp4 |
| 64 GB | 60 GB | BF16 | BF16 | BF16 | 8bit, BF16 | 4bit, 5bit, OptiQ-4bit |
| 96 GB | 92 GB | BF16 | BF16 | BF16 | BF16 | 4bit, 6bit, mxfp4 |
| 128+ GB | 124+ GB | BF16 | BF16 | BF16 | BF16 | 6bit, 8bit, BF16 (largest) |

**Recommended default per row:** pick the leftmost quant that the row
permits — quality order (top = best) is `BF16 > 8bit > 6bit > mxfp4 ≈
OptiQ-4bit > 4bit > 3bit`. Compound schemes (DQ*, mixed_*) sit in the
middle.

When the user runs many concurrent apps, subtract another 4-8 GB from
the budget and pick the next-smaller quant. The KV cache cost scales
linearly with `--max-tokens` / context length — a 70B-4bit model at
128K context will consume ~10 GB *additional* RAM beyond the weights.

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

## Default workflow (runtime-agnostic)

1. **Gate on Apple Silicon.** `[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]` must be true. If not, redirect to `huggingface-local-models` (llama.cpp Metal works on both arm64 and x86_64).
2. **Pick the runtime** from the three-runtime table above. The setup wizard's environment detector reports which are already installed.
3. **Find an MLX model.** Search the `mlx-community/` namespace on HF for the model family you want. Most prominent OSS models have a community-maintained MLX conversion. Examples:
   - `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`
   - `mlx-community/Llama-3.2-3B-Instruct-4bit`
   - `mlx-community/Meta-Llama-3.1-8B-Instruct-4bit`
   - `mlx-community/Qwen3-8B-4bit`
4. **Pick a quantization** from the budget table above. Smallest compatible quant is usually the best default for scan workloads.
5. **Download.** Via the `hf` CLI (see the `hf-cli` skill for full reference) — same command for all three runtimes since they all consume the same `mlx-community` repos:
   ```bash
   hf download mlx-community/<repo-name> --local-dir ~/models/<short-name>
   ```
   MLX repos are usually directories of safetensors shards — omit the per-file argument. (LM Studio MLX runtime can download via the GUI instead; both work.)
6. **Run.** Use the per-runtime recipe below.
7. **Wire into `~/.llm-externalizer/settings.yaml`** using the matching preset from the three-runtime table.

## Runtime 1 — `mlx_lm.server` (official, Python-native)

```bash
uv tool install mlx-lm
hf download mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
    --local-dir ~/models/qwen2.5-coder-7b-mlx
mlx_lm.server --model ~/models/qwen2.5-coder-7b-mlx \
    --port 8082 --host 127.0.0.1
```

The server exposes `http://127.0.0.1:8082/v1/chat/completions` and
`http://127.0.0.1:8082/v1/models`. Port 8082 avoids the default-8080
collision with `llama-server` so a user with both runners can run them
simultaneously. Use the `generic-local` preset:

```yaml
profiles:
  mlx-qwen2.5-coder-7b:
    mode: local
    api: generic-local
    url: "http://127.0.0.1:8082/v1"
    model: "qwen2.5-coder-7b-mlx"     # match basename mlx_lm reports at /v1/models
    timeout: 600
    context_window: 32768
```

Then call `mcp__llm-externalizer__reset` to reload settings without
restarting Claude Code.

## Runtime 2 — vMLX (`vmlx serve`, MLX-native, built-in doctor/bench)

For install + tuned-serve flags + the `vmlx doctor` / `vmlx bench`
reliability + perf checks, invoke `Skill(skill: "vmlx-setup")`. Once the
user has run `vmlx serve <model-id> --port 8000` (and optionally
`--continuous-batching --enable-prefix-cache --enable-pld
--kv-cache-quantization q8` for scan workloads), wire it in with the
`vllm-local` preset (vMLX is OpenAI-compatible on port 8000):

```yaml
profiles:
  vmlx-local:
    mode: local
    api: vllm-local
    model: "mlx-community/Qwen3-8B-4bit"    # same id you passed to `vmlx serve`
    # url defaults to http://localhost:8000 — override only on a custom port
    # api_token: $LM_API_TOKEN              # only if you started vmlx with --api-key
```

For the **vLLM-on-Apple-Silicon** path (vLLM core + community MLX
plugin), use `Skill(skill: "vllm-metal-setup")` instead — it also lands
on the `vllm-local` preset at `:8000`, with `VLLM_METAL_*` env tuning
documented in that skill.

## Runtime 3 — LM Studio MLX runtime (GUI / `lms` CLI)

LM Studio ships its own MLX runtime alongside its llama.cpp runtime.
Enable it once per machine in **Settings → Runtimes**, then either:

- **GUI path:** in the model browser, filter to MLX format, click
  Download. Open Local Server (left sidebar), select the model, press
  **Start Server**. Default port is 1234.
- **Headless / `lms` CLI path** (works in any terminal once LM Studio
  has been launched once to bootstrap the CLI):
  ```bash
  lms server start                              # starts the local server on :1234
  lms get mlx-community/Qwen3-8B-4bit           # downloads if missing
  lms load mlx-community/Qwen3-8B-4bit          # loads the model into the server
  lms ls --json                                 # list loaded models (id used by API)
  lms log stream                                # tail server logs
  ```

Use the `lmstudio-local` preset:

```yaml
profiles:
  lmstudio-mlx:
    mode: local
    api: lmstudio-local
    url: "http://localhost:1234"          # the preset's default — included for clarity
    model: "<id-from-lms-ls>"             # exact id reported by `lms ls --json`
    api_token: $LM_API_TOKEN              # only if LM Studio's API key is set
    timeout: 600
    context_window: 32768
```

LM Studio MLX runtime is the recommended choice for users who don't
want to touch a terminal — model swap is one click, and the GUI shows
unified-memory usage live.

## Listing & comparing MLX models

The companion `huggingface-best` skill can find the highest-scoring
model that fits the user's machine, using the official HF benchmark
leaderboards. For MLX-specific repo discovery:

```bash
# Browse the mlx-community namespace
hf api GET '/api/models?author=mlx-community&limit=50'

# Get the file list of a specific repo
hf api GET '/api/models/mlx-community/Qwen2.5-Coder-7B-Instruct-4bit/tree/main?recursive=true'
```

The llm-externalizer plugin's recommender script
(`scripts/setup/recommend-models.py`) already filters whatcani.run's
featured artifacts by runtime: on Apple Silicon it surfaces `mlx_lm`
runtime entries first, with quantization, file size, and download
command pre-built. The recommender does not know about vMLX or
LM Studio MLX runtime as separate runtimes — they consume the same
`mlx-community` repos as `mlx_lm.server`, so the artifact list is the
same. This skill is what tells the agent how to *serve* each one.

## Converting a non-MLX HF repo to MLX

If no pre-quantized MLX artifact exists for the model you want:

```bash
mlx_lm.convert --hf-path <original-hf-repo> \
    --mlx-path ~/models/<short-name>-q4 \
    --quantize --q-bits 4
```

The output directory is then usable by all three runtimes. vMLX
additionally ships its own `vmlx convert` (similar flags, JANG quant
support) — see `Skill(skill: "vmlx-setup")` for the details.

## Common gotchas

1. **Intel Macs**: MLX requires Apple Silicon. On Intel, `mlx-lm` installs but fails at runtime, and vMLX / LM Studio MLX runtime refuse to start. Redirect to `huggingface-local-models` (llama.cpp Metal works on both arm64 and x86_64).
2. **Unified memory pressure**: Loading a 27B 4bit model on a 32 GB Mac with Chrome + IDE + Claude Code open will trigger swap. Close apps, lower `--max-model-len` / `context_window`, or pick a smaller quant before launch.
3. **Repos with only BF16 weights**: see "Converting a non-MLX HF repo to MLX" above.
4. **Tokenizer not registered**: if `mlx-lm` hasn't added support for a new tokenizer family, `mlx_lm.server` fails at load time with `mlx_lm: tokenizer not registered`. Pick a different repo (usually a slightly older / more popular family) or upgrade mlx-lm (`uv tool upgrade mlx-lm`). vMLX and LM Studio MLX runtime ride on the same `mlx-lm` core under the hood and have the same constraint.
5. **Model name in settings.yaml**: the model id reported by each runtime's `/v1/models` endpoint differs — `mlx_lm.server` uses the directory basename, vMLX uses the full HF repo id (`mlx-community/Foo-4bit`), LM Studio uses whatever `lms ls --json` reports. Set the `model:` field in the profile to match exactly, or the plugin's `discover` tool will report a name mismatch.
6. **Port collisions**: the three runtimes have different defaults (8082 here for `mlx_lm.server`, 8000 for vMLX, 1234 for LM Studio) so they can coexist. If the user runs more than one simultaneously, keep the ports distinct — and keep the profile `url:` pinned per runtime.
7. **Memory limit on 8 GB Macs**: an 8 GB Apple Silicon Mac with macOS, Chrome, and Claude Code already consumes ~5-6 GB. Only the smallest 4bit ≤3B models leave usable margin. Recommend OpenRouter remote mode (the llm-externalizer's `remote-ensemble` profile) instead.
8. **Structured output**: the llm-externalizer requires `response_format: { type: "json_schema" }`. All three runtimes claim OpenAI compatibility but per-model honoring of structured output must be verified empirically — run the setup wizard's Step 5 compatibility test before trusting a given model.

## Output

Return: chosen runtime (mlx_lm.server / vMLX / LM Studio), downloaded MLX repo + quant, launch command, `/v1/models` model-id verified, and the settings.yaml profile fragment ready for paste.

## Error Handling

Handled in "Common gotchas" above. Key items: Intel Mac (refuse, redirect), unified-memory pressure (close apps, lower context), unsupported tokenizer (upgrade mlx-lm or pick different family), port collisions (set distinct ports per runtime), 8 GB Macs (recommend OpenRouter remote mode instead).

## Examples

**Example 1 — M2 Pro 32 GB, vMLX runtime, 13B Q4 model:**

```bash
hf download mlx-community/Qwen3.6-32B-Instruct-4bit --local-dir ~/models/qwen3.6-32b-4bit
vmlx serve ~/models/qwen3.6-32b-4bit --port 8000
```

Settings.yaml fragment: `mode: local`, `api: vllm-local`, `model: "mlx-community/Qwen3.6-32B-Instruct-4bit"`, `url: http://localhost:8000`.

**Example 2 — M3 Max 64 GB, mlx_lm.server, 70B 4bit:**

```bash
hf download mlx-community/Llama-3.3-70B-Instruct-4bit --local-dir ~/models/l3-70b-4bit
mlx_lm.server --model ~/models/l3-70b-4bit --host 127.0.0.1 --port 8082
```

## Resources

### Related skills

- `Skill(skill: "vmlx-setup")` — full vMLX install / serve / `doctor` / `bench` guide. Invoke when the user picks vMLX or wants the OpenAI-compatible MLX-native server on `:8000`.
- `Skill(skill: "vllm-metal-setup")` — vLLM-on-Apple-Silicon (community `vllm-metal` plugin). Invoke when the user specifically wants vLLM semantics on a Mac. Also lands on the `vllm-local` preset at `:8000`.
- `Skill(skill: "huggingface-local-models")` — the GGUF / llama.cpp path. Invoke when on Intel Mac, Linux, Windows, or when cross-platform GGUF parity matters.
- `Skill(skill: "hf-cli")` — full reference for the `hf` command (download, upload, search, cache management). Required for any MLX setup since downloads happen via `hf download` (LM Studio's in-app downloader is an alternative for the LM Studio runtime only).
- `Skill(skill: "huggingface-best")` — finds the highest-scoring model for a task within the user's memory budget, across the official HF leaderboards.
- `Skill(skill: "huggingface-community-evals")` — runs benchmark evaluations against a chosen model (inspect-ai, lighteval). Use AFTER the model is downloaded and serving, if you want quantitative validation beyond the llm-externalizer's 5-test compatibility check.

### External references

- MLX: `https://github.com/ml-explore/mlx`
- mlx-lm: `https://github.com/ml-explore/mlx-lm`
- vMLX: `https://github.com/jjang-ai/vmlx`
- LM Studio: `https://lmstudio.ai`
- mlx-community HF org: `https://huggingface.co/mlx-community`
