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
      # Guard against empty / non-numeric output (sysctl exit==0 but no value,
      # observed on some virtualised macOS guests). Without this, bash arithmetic
      # aborts under `set -e` and the script emits no JSON.
      [[ "$RAM_BYTES" =~ ^[0-9]+$ ]] || RAM_BYTES=0
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
      # Same guard as the macOS branch — empty/non-numeric awk output (corrupted
      # /proc/meminfo, BSD-flavor procfs) would otherwise crash bash arithmetic.
      [[ "$RAM_KB" =~ ^[0-9]+$ ]] || RAM_KB=0
      RAM_GB=$(( RAM_KB / 1024 / 1024 ))
    fi

    # GPU detection. nvidia-smi → NVIDIA path. rocm-smi → AMD ROCm path.
    # We don't care about iGPU / Intel Arc here — llama.cpp / vLLM / Ollama
    # all degrade to CPU when neither toolchain is present.
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      GPU="nvidia"
    elif command -v rocm-smi >/dev/null 2>&1 && rocm-smi --showid >/dev/null 2>&1; then
      # rocm-smi present without a real AMD card (e.g. user installed ROCm to
      # build llama.cpp with HIP) would otherwise mis-tag the GPU. --showid
      # exits non-zero when no AMD device is present.
      GPU="amd-rocm"
    fi
    ;;

  MINGW*|MSYS*|CYGWIN*)
    # Native Windows running bash via Git-Bash / MSYS / Cygwin. WSL2 is
    # handled above (its uname returns Linux).
    OS_NORMALIZED="windows"

    # RAM detection chain — wmic was removed in Windows 11 24H2+, so we try
    # PowerShell first (works on every Win10+ install), wmic second (legacy
    # path), and systeminfo as a last resort. Each falls through on empty /
    # non-numeric output so the next fallback gets a turn.
    if command -v powershell.exe >/dev/null 2>&1; then
      # Get-CimInstance is the canonical successor to wmic for Win11. The
      # `-NoProfile` flag bypasses the user's PowerShell profile which can
      # add 1-2s of startup latency; `-Command` runs the literal expression.
      RAM_BYTES=$(powershell.exe -NoProfile -Command \
        "(Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory" \
        2>/dev/null | tr -d '\r\n ' || true)
      if [[ "${RAM_BYTES:-}" =~ ^[0-9]+$ ]]; then
        RAM_GB=$(( RAM_BYTES / 1024 / 1024 / 1024 ))
      fi
    fi
    if (( RAM_GB == 0 )) && command -v wmic >/dev/null 2>&1; then
      # Legacy wmic path — kept as a fallback for Windows 10 ≤ 21H2 boxes
      # where Get-CimInstance may not be present (very old systems).
      RAM_BYTES=$(wmic computersystem get TotalPhysicalMemory /value 2>/dev/null \
                  | tr -d '\r' \
                  | awk -F= '/TotalPhysicalMemory=/ {print $2}')
      if [[ "${RAM_BYTES:-}" =~ ^[0-9]+$ ]]; then
        RAM_GB=$(( RAM_BYTES / 1024 / 1024 / 1024 ))
      fi
    fi
    if (( RAM_GB == 0 )) && command -v systeminfo >/dev/null 2>&1; then
      # systeminfo prints "Total Physical Memory: 16,384 MB" — parse MB
      # value and convert. Slow (~2s) but available everywhere wmic was.
      RAM_MB=$(systeminfo 2>/dev/null \
               | tr -d '\r' \
               | awk -F: '/Total Physical Memory/ {gsub(/[, MB]/,"",$2); print $2}')
      if [[ "${RAM_MB:-}" =~ ^[0-9]+$ ]]; then
        RAM_GB=$(( RAM_MB / 1024 ))
      fi
    fi

    # GPU detection — PowerShell Win32_VideoController is the canonical path.
    # The class lists every video adapter; we look for the strongest matched
    # vendor (NVIDIA wins over AMD wins over Intel) so a laptop with both an
    # integrated iGPU and a discrete dGPU reports the dGPU.
    if command -v powershell.exe >/dev/null 2>&1; then
      GPU_NAMES=$(powershell.exe -NoProfile -Command \
        "(Get-CimInstance -ClassName Win32_VideoController | Select-Object -ExpandProperty Name) -join ';'" \
        2>/dev/null | tr -d '\r' || true)
      # Use case-insensitive grep on the joined adapter names. NVIDIA first
      # so a hybrid-GPU box picks the better path.
      if [[ -n "${GPU_NAMES:-}" ]]; then
        if echo "$GPU_NAMES" | grep -qi "nvidia"; then
          GPU="nvidia"
        elif echo "$GPU_NAMES" | grep -qiE "amd|radeon"; then
          GPU="amd-rocm"
        else
          GPU="none"
        fi
      else
        GPU="unknown"
      fi
    else
      # No PowerShell — fall back to "unknown" so the agent can ask the user.
      GPU="unknown"
    fi
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
