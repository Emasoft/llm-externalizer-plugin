#!/usr/bin/env python3
"""vllm-cuda-autoconfig.py — Emit a tuned `vllm serve` command line for Linux+NVIDIA.

Detects free VRAM, system RAM, and CUDA driver version, then emits a
`vllm serve …` command line tuned to actually load and run the requested
model. Low-VRAM consumer GPUs (8-12 GB) cannot run a 13B fp16 model with
vLLM defaults — they need INT4 weights, fp8 KV-cache, CPU-offload, and
swap-space tuning, none of which vLLM auto-picks. This script encodes
that knowledge as a tiered table.

Tiers (based on free VRAM at detection time):
    ≥ 24 GB → bf16 weights, gpu-util 0.92, native context
    12-24 GB → fp8 KV-cache, ctx capped at 32k, gpu-util 0.90
    8-12 GB → INT4 (AWQ/GPTQ), fp8 KV-cache, ctx 16k, enforce-eager
    < 8 GB  → INT4 + CPU offload (sys_ram_gb // 4) + swap 4 GB

Linux+NVIDIA only: vLLM ships CUDA wheels for Linux; ROCm / macOS / Windows
are not targets. On non-Linux hosts the script exits 0 with a polite skip.

Stdlib only: this runs before the wizard knows the user has a real Python
toolchain. Usage:
    vllm-cuda-autoconfig.py --model Qwen2.5-Coder-7B-Instruct-AWQ
    vllm-cuda-autoconfig.py --print-vram-only
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Optional

SCRIPT_VERSION = "1.0.0"
# Schema version for --output json. The setup-agent checks this before
# consuming the structured payload; bumping it forces the agent to
# re-validate field names rather than silently rendering None / 0.
SCHEMA_VERSION = 1

# Minimum CUDA driver version that supports FP8 (sm_89+ / sm_90+ kernels
# require driver 535 or newer per NVIDIA's release notes). Below this the
# script warns and refuses to add `--kv-cache-dtype fp8`.
MIN_CUDA_DRIVER_FOR_FP8 = 535

# Tier boundaries in GB of FREE VRAM. We deliberately use free (not total)
# VRAM: a card that already has X-server / browser / other processes
# occupying memory cannot devote its theoretical max to vLLM. nvidia-smi
# reports both values; we trust `memory.free`.
TIER_THRESHOLDS_GB = (24, 12, 8)  # ≥24, ≥12, ≥8, else <8

# Hard upper bound on `--cpu-offload-gb`. Even with plenty of system RAM,
# offloading > 64 GB of weights creates PCIe-bandwidth bottlenecks that
# make inference unusable. Cap at 32 GB so the user does not foot-gun.
MAX_CPU_OFFLOAD_GB = 32

# Subprocess timeout for nvidia-smi probes. The CLI itself returns in
# < 100 ms on a healthy install; 5 s is generous and bounds the case
# where the driver is wedged.
NVIDIA_SMI_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True)
class GpuInfo:
    """Snapshot of nvidia-smi output for the first GPU."""

    name: str
    total_vram_gb: float
    free_vram_gb: float
    driver_version: str  # may be empty if --query-gpu didn't return it

    @property
    def driver_major(self) -> int:
        """Best-effort parse of the driver major version. Returns 0 on parse fail."""
        head = self.driver_version.split(".", 1)[0].strip()
        try:
            return int(head)
        except ValueError:
            return 0


@dataclass
class TierConfig:
    """Tuning knobs for one VRAM tier. All fields end up on the vllm command line."""

    name: str
    gpu_memory_utilization: float
    max_model_len: Optional[int]  # None = use model's native context
    enforce_eager: bool
    needs_quantization: bool
    kv_cache_dtype: Optional[str]  # "fp8" or None
    cpu_offload: bool
    swap_space_gb: Optional[int]
    notes: list[str] = field(default_factory=list)


# Tier table. Ordered from most-VRAM to least so pick_tier() can short-circuit.
# Each entry maps to one TierConfig that callers turn into vllm flags.
TIERS: dict[str, TierConfig] = {
    "ge24gb": TierConfig(
        name="≥24 GB (datacenter / 3090 / 4090)",
        gpu_memory_utilization=0.92,
        max_model_len=None,
        enforce_eager=False,
        needs_quantization=False,
        kv_cache_dtype=None,
        cpu_offload=False,
        swap_space_gb=None,
    ),
    "ge12gb": TierConfig(
        name="12-24 GB (4070 Ti / 3080 Ti)",
        gpu_memory_utilization=0.90,
        max_model_len=32768,
        enforce_eager=False,
        needs_quantization=False,
        kv_cache_dtype="fp8",
        cpu_offload=False,
        swap_space_gb=None,
        notes=["context capped at 32k to leave headroom for fp8 KV-cache"],
    ),
    "ge8gb": TierConfig(
        name="8-12 GB (3060 / 4060)",
        gpu_memory_utilization=0.88,
        max_model_len=16384,
        enforce_eager=True,
        needs_quantization=True,
        kv_cache_dtype="fp8",
        cpu_offload=False,
        swap_space_gb=None,
        notes=[
            "needs INT4-quantized model variant (AWQ or GPTQ)",
            "--enforce-eager disables CUDA graphs to save VRAM",
        ],
    ),
    "lt8gb": TierConfig(
        name="< 8 GB (1660 / 2060)",
        gpu_memory_utilization=0.85,
        max_model_len=8192,
        enforce_eager=True,
        needs_quantization=True,
        kv_cache_dtype="fp8",
        cpu_offload=True,
        swap_space_gb=4,
        notes=[
            "needs INT4-quantized model; throughput will be limited",
            "CPU-offload uses system RAM as overflow — PCIe-bound",
            "--swap-space 4 reserves 4 GB disk swap for KV-cache spill",
        ],
    ),
}


def detect_nvidia_gpu() -> GpuInfo:
    """Parse nvidia-smi for the first GPU's name, total/free VRAM, and driver.

    Raises RuntimeError if nvidia-smi is missing or returns non-zero. The
    caller should translate that into a clean exit (no NVIDIA GPU).
    """
    if not shutil.which("nvidia-smi"):
        raise RuntimeError("nvidia-smi not found on PATH — no NVIDIA GPU detected")
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.free,driver_version",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=NVIDIA_SMI_TIMEOUT_SECONDS,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"nvidia-smi failed: {exc.stderr.strip() or exc!r}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("nvidia-smi timed out (driver may be wedged)") from exc

    first_line = out.stdout.strip().splitlines()[0] if out.stdout.strip() else ""
    if not first_line:
        raise RuntimeError("nvidia-smi returned no GPU rows")
    parts = [p.strip() for p in first_line.split(",")]
    if len(parts) < 4:
        raise RuntimeError(f"nvidia-smi returned unexpected row shape: {first_line!r}")
    name, total_mib, free_mib, driver = parts[0], parts[1], parts[2], parts[3]
    try:
        total_gb = round(int(total_mib) / 1024, 2)
        free_gb = round(int(free_mib) / 1024, 2)
    except ValueError as exc:
        raise RuntimeError(
            f"nvidia-smi returned non-integer VRAM values: total={total_mib!r} free={free_mib!r}"
        ) from exc
    if total_gb <= 0 or free_gb < 0:
        raise RuntimeError(f"nvidia-smi reported implausible VRAM: total={total_gb} free={free_gb}")
    return GpuInfo(name=name, total_vram_gb=total_gb, free_vram_gb=free_gb, driver_version=driver)


def detect_system_ram_gb() -> int:
    """Return system RAM in GB. Uses os.sysconf on POSIX, /proc/meminfo as fallback.

    Returns 0 if neither source is available — caller should treat that as
    "unknown" and skip CPU-offload sizing rather than crash.
    """
    try:
        pagesize = os.sysconf("SC_PAGE_SIZE")
        pages = os.sysconf("SC_PHYS_PAGES")
        if pagesize > 0 and pages > 0:
            return int((pagesize * pages) / (1024**3))
    except (OSError, ValueError):
        pass
    # /proc/meminfo fallback (Linux only)
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    kib = int(line.split()[1])
                    return int(kib / (1024**2))
    except (OSError, ValueError, IndexError):
        pass
    return 0


def pick_tier(free_vram_gb: float) -> tuple[str, TierConfig]:
    """Return (tier_key, TierConfig) for the given free VRAM in GB."""
    if free_vram_gb >= TIER_THRESHOLDS_GB[0]:
        return "ge24gb", TIERS["ge24gb"]
    if free_vram_gb >= TIER_THRESHOLDS_GB[1]:
        return "ge12gb", TIERS["ge12gb"]
    if free_vram_gb >= TIER_THRESHOLDS_GB[2]:
        return "ge8gb", TIERS["ge8gb"]
    return "lt8gb", TIERS["lt8gb"]


def pick_quantization(model_name: str, requested: str, tier: TierConfig) -> Optional[str]:
    """Resolve the --quantization value or raise ValueError if incompatible.

    Returns None when no `--quantization` flag should be emitted (vLLM picks
    fp16/bf16 from the model's own config). Returns a string ("awq", "gptq",
    "fp8") when an explicit flag is required.
    """
    if requested == "none":
        if tier.needs_quantization:
            raise ValueError(
                f"tier '{tier.name}' requires a quantized model variant; "
                "search Hugging Face for an AWQ or GPTQ variant of this model "
                "(e.g. add '-AWQ' or '-GPTQ' to the repo name)"
            )
        return None
    if requested in ("awq", "gptq", "fp8"):
        return requested
    if requested != "auto":
        raise ValueError(f"unknown --quantization value: {requested!r}")
    # auto: sniff the model name. Common HF convention is suffix-tagged.
    lower = model_name.lower()
    if "awq" in lower:
        return "awq"
    if "gptq" in lower:
        return "gptq"
    if "fp8" in lower:
        return "fp8"
    # No hint in the name. If the tier needs quantization, fail loudly so
    # the user picks a quantized variant rather than silently OOMing later.
    if tier.needs_quantization:
        raise ValueError(
            f"tier '{tier.name}' needs a quantized model but '{model_name}' has "
            "no AWQ/GPTQ/FP8 tag in its name. Search Hugging Face for a "
            "quantized variant (e.g. 'TheBloke/...-AWQ' or '...-GPTQ-Int4')."
        )
    return None


def build_vllm_command(
    model: str,
    tier: TierConfig,
    *,
    quantization: Optional[str],
    max_context_override: Optional[int],
    cpu_offload_gb: int,
    fp8_kv_supported: bool,
) -> list[str]:
    """Assemble the `vllm serve` argv list. Caller joins for display."""
    cmd = [
        "vllm", "serve", model,
        "--host", "0.0.0.0",
        "--port", "8000",
        "--tensor-parallel-size", "1",
        "--gpu-memory-utilization", f"{tier.gpu_memory_utilization}",
    ]
    # max-context: explicit user override wins; else tier default; else
    # leave it off so vLLM uses the model's own config.
    effective_ctx = max_context_override if max_context_override is not None else tier.max_model_len
    if effective_ctx is not None:
        cmd += ["--max-model-len", str(effective_ctx)]
    if quantization is not None:
        cmd += ["--quantization", quantization]
    # Only emit fp8 KV-cache when the driver actually supports it. Older
    # drivers (< 535) silently ignore the flag or crash on first decode.
    if tier.kv_cache_dtype == "fp8" and fp8_kv_supported:
        cmd += ["--kv-cache-dtype", "fp8"]
    if tier.enforce_eager:
        cmd.append("--enforce-eager")
    if tier.cpu_offload and cpu_offload_gb > 0:
        cmd += ["--cpu-offload-gb", str(cpu_offload_gb)]
    if tier.swap_space_gb is not None:
        cmd += ["--swap-space", str(tier.swap_space_gb)]
    return cmd


def shell_quote_argv(argv: list[str]) -> str:
    """Join argv with shell-safe quoting; argv[0] kept bare so output reads as `vllm …`."""
    return " ".join([argv[0]] + [shlex.quote(a) for a in argv[1:]])


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """Build and parse the CLI."""
    p = argparse.ArgumentParser(
        prog="vllm-cuda-autoconfig.py",
        description="Emit a tuned `vllm serve` command line for Linux+NVIDIA hosts.",
    )
    p.add_argument("--model", help="Model name or HF repo to serve (required unless --print-vram-only).")
    p.add_argument("--max-context", type=int, default=None,
                   help="Override --max-model-len; otherwise the tier's default is used.")
    p.add_argument("--quantization", choices=("auto", "awq", "gptq", "fp8", "none"), default="auto",
                   help="Quantization mode. 'auto' sniffs the model name; 'none' lets vLLM use bf16/fp16.")
    p.add_argument("--target-tps", type=float, default=None,
                   help="Hint for target tokens/sec (informational; reflected in --output json).")
    p.add_argument("--output", choices=("cmd", "json", "both"), default="cmd",
                   help="cmd: one-line shell command; json: machine-readable; both: command then JSON.")
    p.add_argument("--dry-run", action="store_true",
                   help="Skip nvidia-smi probe; use a synthetic 24GB GPU for tier picking. Useful for testing.")
    p.add_argument("--print-vram-only", action="store_true",
                   help="Print detected VRAM and tier, then exit. No model needed.")
    p.add_argument("--version", action="version", version=f"%(prog)s {SCRIPT_VERSION}")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    """CLI entry point. Returns process exit code (0 on success)."""
    args = parse_args(argv)

    # Linux+NVIDIA-only gate. --dry-run bypasses the platform check so the
    # script is testable on macOS/Windows CI runners.
    if platform.system() != "Linux" and not args.dry_run:
        print(f"skip — vllm-cuda-autoconfig is Linux+NVIDIA only (detected platform: {platform.system()})")
        return 0

    if args.dry_run:
        # Synthetic high-end GPU so tier picking exercises the ≥24 GB path.
        gpu = GpuInfo(
            name="DRY-RUN synthetic GPU (no probe)",
            total_vram_gb=24.0,
            free_vram_gb=24.0,
            driver_version="999.99",
        )
    else:
        try:
            gpu = detect_nvidia_gpu()
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    tier_key, tier = pick_tier(gpu.free_vram_gb)

    if args.print_vram_only:
        payload = {
            "schema_version": SCHEMA_VERSION,
            "gpu_name": gpu.name,
            "total_vram_gb": gpu.total_vram_gb,
            "free_vram_gb": gpu.free_vram_gb,
            "driver_version": gpu.driver_version,
            "tier": tier_key,
            "tier_description": tier.name,
        }
        print(json.dumps(payload, indent=2))
        return 0

    if not args.model:
        print("error: --model is required (use --print-vram-only to skip)", file=sys.stderr)
        return 2

    # FP8 KV-cache requires CUDA driver ≥ 535. Below that we silently drop
    # the flag and warn the user; the rest of the tier config still applies.
    fp8_kv_supported = gpu.driver_major == 0 or gpu.driver_major >= MIN_CUDA_DRIVER_FOR_FP8
    if tier.kv_cache_dtype == "fp8" and not fp8_kv_supported:
        print(
            f"warning: CUDA driver {gpu.driver_version} < {MIN_CUDA_DRIVER_FOR_FP8} — "
            "fp8 KV-cache disabled. Update your NVIDIA driver for ~30% VRAM savings.",
            file=sys.stderr,
        )

    try:
        quantization = pick_quantization(args.model, args.quantization, tier)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3

    system_ram_gb = detect_system_ram_gb()
    cpu_offload_gb = 0
    if tier.cpu_offload and system_ram_gb > 0:
        # Reserve 3/4 of system RAM for OS + Python + the vLLM worker itself;
        # 1/4 goes to weight overflow. Cap at MAX_CPU_OFFLOAD_GB so massive
        # workstations don't push every weight off the GPU "just because".
        cpu_offload_gb = min(MAX_CPU_OFFLOAD_GB, max(1, system_ram_gb // 4))

    cmd = build_vllm_command(
        args.model,
        tier,
        quantization=quantization,
        max_context_override=args.max_context,
        cpu_offload_gb=cpu_offload_gb,
        fp8_kv_supported=fp8_kv_supported,
    )

    if args.output in ("cmd", "both"):
        print(shell_quote_argv(cmd))

    if args.output in ("json", "both"):
        payload = {
            "schema_version": SCHEMA_VERSION,
            "gpu": {
                "name": gpu.name,
                "total_vram_gb": gpu.total_vram_gb,
                "free_vram_gb": gpu.free_vram_gb,
                "driver_version": gpu.driver_version,
                "fp8_kv_supported": fp8_kv_supported,
            },
            "system_ram_gb": system_ram_gb,
            "tier": tier_key,
            "tier_description": tier.name,
            "tier_notes": tier.notes,
            "model": args.model,
            "quantization": quantization,
            "max_context_override": args.max_context,
            "cpu_offload_gb": cpu_offload_gb,
            "target_tps_hint": args.target_tps,
            "argv": cmd,
            "command_line": shell_quote_argv(cmd),
        }
        print(json.dumps(payload, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
