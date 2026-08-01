# MLX Runtimes Side-by-Side

## Table of Contents

- [When to prefer MLX over llama.cpp Metal on a Mac](#when-to-prefer-mlx-over-llamacpp-metal-on-a-mac)
- [The three first-class MLX runtimes (pick one)](#the-three-first-class-mlx-runtimes-pick-one)

## When to prefer MLX over llama.cpp Metal on a Mac

| Aspect | MLX (any of the three runtimes) | llama.cpp Metal |
|---|---|---|
| Native to Apple Silicon | Yes — Metal kernels designed for unified memory | Yes, but ported from CUDA |
| Throughput on M-series | Generally higher prompt-processing tok/s | Lower (Metal port lags MLX kernels) |
| Memory efficiency | Slightly better (no host/device copy) | Good |
| Model format | safetensors (mlx-converted) | GGUF |
| Quantization variety | 4/5/6/8 bit, mxfp4, mxfp8, nvfp4, DQ*, OptiQ-*, mixed_*, GPTQ-Int4, AWQ-Int4, BF16 | Q4_K_M, Q5_K_M, Q6_K, Q8_0, IQ2-4, UD-* |
| Works on Apple Intel (x86_64) | No — MLX requires arm64 | Yes |
| Cross-platform parity | No (Apple-only) | Yes (same GGUF on Mac/Linux/Windows) |

Use **MLX** when: Mac is arm64, you want native speed for prompt-heavy workloads, you don't need cross-platform parity.

Use **llama.cpp Metal** when: Intel Mac, cross-platform parity needed, or LM Studio already configured for GGUF.

## The three first-class MLX runtimes (pick one)

All three serve MLX-quantized models from `mlx-community/*` HF namespace.

| Aspect | `mlx_lm.server` (official) | vMLX (`vmlx serve`) | LM Studio MLX runtime |
|---|---|---|---|
| Provider | Apple's official `mlx-lm` package on PyPI | Community (`jjang-ai/vmlx`) on PyPI | LM Studio (proprietary GUI app, free) |
| Audience | Python users with `pip`/`uv` workflow | Power users wanting a richer CLI | GUI users avoiding terminal |
| Install | `uv tool install mlx-lm` | `uv tool install vmlx` | `brew install --cask lm-studio` (or .dmg), then enable MLX runtime in Settings → Runtimes |
| Default port | 8080 (pinned to 8082 here to avoid `llama-server` collision) | 8000 | 1234 |
| API surface | OpenAI-compatible only | OpenAI + Anthropic + Ollama compatible | LM Studio native API (OpenAI-compatible subset) |
| Extra CLI | `mlx_lm.generate`, `mlx_lm.convert`, `mlx_lm.chat` | `vmlx doctor`, `vmlx info`, `vmlx bench` (env diagnostics + perf benchmarks in-box) | `lms` CLI (`lms server start`, `lms load`, `lms ls`, `lms log`); GUI for everything else |
| Structured output (`response_format: json_schema`) | Verify empirically per model | Verify empirically per model | Verify empirically per model |
| Best for scan workload | Smallest install footprint; minimal flags; headless servers | Built-in `doctor`/`bench` for setup-wizard reliability+perf | GUI-first users; no command line for download/serve/swap |
| Preset in `settings.yaml` | `generic-local` (`url: http://127.0.0.1:8082/v1`) | `vllm-local` (`url: http://localhost:8000`) | `lmstudio-local` (`url: http://localhost:1234`) |

**Setup-agent hand-off:** for vMLX or the `vllm-local` Apple-Silicon path, invoke `Skill(vmlx-setup)` for install + serve flags. For vLLM-on-Apple-Silicon (vLLM core + community MLX backend plugin), invoke `Skill(vllm-metal-setup)`. For `mlx_lm.server` and LM Studio MLX runtime, the recipes here are self-contained.
