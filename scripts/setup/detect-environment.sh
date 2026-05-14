#!/usr/bin/env bash
# detect-environment.sh — Identify the user's OS, architecture, RAM, and GPU.
#
# Outputs a single JSON object to stdout, no other lines. Errors go to stderr.
# Used by the llm-externalizer-setup-agent in Step 1 to pick a recommended
# runner + model size.
#
# Output shape:
#   {
#     "os":      "macos" | "linux" | "wsl2" | "windows" | "unknown",
#     "arch":    "arm64" | "x86_64" | "<raw uname -m>",
#     "ram_gb":  <integer>,
#     "gpu":     "apple-metal" | "nvidia" | "amd-rocm" | "none" | "unknown"
#   }
#
# Why bash and not python: this script must run BEFORE we know whether the
# user has a working Python toolchain. uname + sysctl/meminfo are guaranteed
# on every supported platform; jq is not.

set -euo pipefail

OS_RAW=$(uname -s 2>/dev/null || echo "Unknown")
ARCH=$(uname -m 2>/dev/null || echo "unknown")
RAM_GB=0
GPU="none"
OS_NORMALIZED="unknown"

case "$OS_RAW" in
  Darwin)
    OS_NORMALIZED="macos"
    if command -v sysctl >/dev/null 2>&1; then
      RAM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
      RAM_GB=$(( RAM_BYTES / 1024 / 1024 / 1024 ))
    fi
    # Apple Silicon → unified-memory Metal GPU. Intel Macs may have discrete
    # AMD GPUs but llama.cpp/MLX support on Intel is degraded; report "none"
    # for Intel so the agent steers the user toward CPU-friendly model sizes.
    if [[ "$ARCH" == "arm64" ]]; then
      GPU="apple-metal"
    fi
    ;;

  Linux)
    # WSL2 reports `Linux` from uname but has `Microsoft` or `WSL` in
    # /proc/version. This matters because the recommended runner differs
    # (Ollama on the Linux side, NOT LM Studio bridged from Windows).
    if [[ -r /proc/version ]] && grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
      OS_NORMALIZED="wsl2"
    else
      OS_NORMALIZED="linux"
    fi

    if [[ -r /proc/meminfo ]]; then
      RAM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
      RAM_GB=$(( RAM_KB / 1024 / 1024 ))
    fi

    # GPU detection. nvidia-smi → NVIDIA path. rocm-smi → AMD ROCm path.
    # We don't care about iGPU / Intel Arc here — llama.cpp / vLLM / Ollama
    # all degrade to CPU when neither toolchain is present.
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      GPU="nvidia"
    elif command -v rocm-smi >/dev/null 2>&1; then
      GPU="amd-rocm"
    fi
    ;;

  MINGW*|MSYS*|CYGWIN*)
    # Native Windows running bash via Git-Bash / MSYS / Cygwin. WSL2 is
    # handled above (its uname returns Linux).
    OS_NORMALIZED="windows"
    if command -v wmic >/dev/null 2>&1; then
      # wmic is deprecated in Windows 11 but still ships everywhere bash
      # would be installed. PowerShell would be cleaner but adds startup
      # cost (~1s) we don't want here.
      RAM_BYTES=$(wmic computersystem get TotalPhysicalMemory /value 2>/dev/null \
                  | tr -d '\r' \
                  | awk -F= '/TotalPhysicalMemory=/ {print $2}')
      if [[ -n "${RAM_BYTES:-}" ]]; then
        RAM_GB=$(( RAM_BYTES / 1024 / 1024 / 1024 ))
      fi
    fi
    # GPU detection on Windows requires PowerShell or wmic; skip it here
    # and let the agent ask the user. False "none" is fine — the agent
    # always offers a runner that works on CPU as a fallback.
    GPU="unknown"
    ;;

  *)
    OS_NORMALIZED="unknown"
    ;;
esac

# Emit the result. printf rather than echo so we control the trailing newline
# exactly (the agent reads the file as JSON, an extra newline is harmless but
# we keep it tidy).
printf '{"os":"%s","arch":"%s","ram_gb":%d,"gpu":"%s"}\n' \
  "$OS_NORMALIZED" "$ARCH" "$RAM_GB" "$GPU"
