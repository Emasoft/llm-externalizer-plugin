# Apple Silicon Unified-Memory Quant Budget

## Table of Contents

- [Quant selection table](#quant-selection-table)
- [Beyond plain bit-quants](#beyond-plain-bit-quants)

Apple Silicon shares one pool of unified RAM between CPU and GPU. No separate VRAM. Budget formula:

    budget = total_unified_RAM − 4 GB headroom for OS + apps

`mlx_lm` then needs room for: model weights (dominant cost) + KV cache (~10% of model size at 32K context) + small runtime overhead.

The "headroom" 4 GB is the floor — on an 8 GB Mac the OS + Chrome + IDE + Claude Code already consume ~5-6 GB, so effective budget is ~2-3 GB (only smallest 3B-4bit models fit). On ≥32 GB machines, more apps usually run too; the table stays conservative.

## Quant selection table

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

**Recommended default per row**: pick the leftmost quant the row permits — quality order (top = best): `BF16 > 8bit > 6bit > mxfp4 ≈ OptiQ-4bit > 4bit > 3bit`. Compound schemes (DQ*, mixed_*) sit in the middle.

When user runs many concurrent apps, subtract another 4-8 GB and pick the next-smaller quant. KV cache cost scales linearly with `--max-tokens` / context length — a 70B-4bit at 128K context consumes ~10 GB *additional* RAM beyond weights.

## Beyond plain bit-quants

| Label | What it is | When to use |
|---|---|---|
| `mxfp4` / `mxfp8` | Apple's mixed-FP format — same memory as 4bit/8bit but per-block scale uses FP rather than INT | Try first when quality matters more than max size reduction on Apple Silicon |
| `nvfp4` | NVIDIA-style FP4 (1 sign, 3 exponent, 0 mantissa per block scale) | Smaller than mxfp4 but slightly lower quality on Apple Silicon |
| `OptiQ-4bit` | Apple-optimized 4bit; quality between plain 4bit and 5bit | Drop-in replacement for plain 4bit when available |
| `DQ3_K_M` | MLX dynamic quantization, ~3.5bit-equivalent average via per-layer adaptive bitwidth | When memory is tight but you want better quality than plain 3bit |
| `DQ4plus` | MLX dynamic-quant variant, ~4.2bit-equivalent | Middle-ground between 4bit and 5bit |
| `mixed_3_4` / `mixed_3_5` / `mixed_4_8` etc. | Per-layer mixed precision; the two digits are precisions used for different layers | Experimental; near-lossless at smaller total size on some models |
| `GPTQ-Int4` / `AWQ-Int4` | Calibrated INT4 quantization (uses calibration dataset) | Often higher quality than plain 4bit at the same size; slower to load |
| `4bit-DWQ` | "Dynamic weight quantization" variant | Similar to DQ schemes; treat as ~4.5bit |
| `BF16` | No quantization — full bf16 weights | When you have the RAM and want the best possible quality |
