#!/usr/bin/env python3
"""Tests for scripts/setup/vllm-cuda-autoconfig.py — the Linux+NVIDIA VRAM-tuned
`vllm serve` command emitter wired into the setup-agent.

The load-bearing case is the **F7 regression**: the fp8 KV-cache gate used to be
`driver_major == 0 or driver_major >= 535`, which treated an UNKNOWN / unparseable
driver (`driver_major == 0`) as fp8-SUPPORTED. That is optimistic and wrong —
adding `--kv-cache-dtype fp8` to a driver that cannot run fp8 kernels makes vLLM
fail to start. The fix made it conservative (`driver_major >= 535`, so unknown→0→
unsupported). These tests exercise the REAL main() gate via two monkeypatched
environment boundaries (platform + nvidia-smi probe) so a future revert to the
optimistic form is caught.

The rest cover the pure logic: driver parsing, tier selection, quantization
resolution, and command assembly. Only the external environment (platform.system,
nvidia-smi, /proc) is monkeypatched — never the logic under test.

The module filename is hyphenated (not an importable identifier), so it is loaded
via importlib.util.spec_from_file_location rather than `import`.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VLLM_AUTOCONFIG_PY = PROJECT_ROOT / "scripts" / "setup" / "vllm-cuda-autoconfig.py"


def _load_module():
    """Load the hyphenated vllm-cuda-autoconfig.py file as a module via importlib."""
    spec = importlib.util.spec_from_file_location("vllm_cuda_autoconfig", VLLM_AUTOCONFIG_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register BEFORE exec so the @dataclass decorators inside the module can
    # resolve cls.__module__ via sys.modules (Python 3.12's dataclasses._is_type
    # does sys.modules.get(cls.__module__).__dict__ → AttributeError on None for
    # an unregistered dynamically-loaded module). detect-runners.py avoided this
    # only because it has no dataclass.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


vllm_autoconfig = _load_module()


def _gpu(driver: str, free_gb: float = 16.0):
    """Build a GpuInfo with the given driver string and free VRAM (default 16 GB →
    the ge12gb fp8 tier, so the fp8 gate is exercised)."""
    return vllm_autoconfig.GpuInfo(
        name="Test GPU",
        total_vram_gb=max(free_gb, 24.0),
        free_vram_gb=free_gb,
        driver_version=driver,
    )


# ── driver parsing ────────────────────────────────────────────────────────────


def test_driver_major_parses_normal_version():
    """A normal '535.183.01' driver string parses to major 535."""
    assert _gpu("535.183.01").driver_major == 535


def test_driver_major_unparseable_is_zero():
    """An empty or garbage driver string yields major 0 (the 'unknown' sentinel)."""
    assert _gpu("").driver_major == 0
    assert _gpu("not-a-version").driver_major == 0


# ── tier selection ────────────────────────────────────────────────────────────


def test_pick_tier_boundaries_are_inclusive_lower_bounds():
    """Each VRAM threshold (24/12/8 GB) is an inclusive lower bound for its tier."""
    assert vllm_autoconfig.pick_tier(24.0)[0] == "ge24gb"
    assert vllm_autoconfig.pick_tier(23.99)[0] == "ge12gb"
    assert vllm_autoconfig.pick_tier(12.0)[0] == "ge12gb"
    assert vllm_autoconfig.pick_tier(11.99)[0] == "ge8gb"
    assert vllm_autoconfig.pick_tier(8.0)[0] == "ge8gb"
    assert vllm_autoconfig.pick_tier(7.99)[0] == "lt8gb"


# ── quantization resolution ───────────────────────────────────────────────────


def test_quantization_none_on_quant_tier_raises():
    """'none' on a tier that requires quantization raises (no silent OOM later)."""
    tier = vllm_autoconfig.TIERS["ge8gb"]  # needs_quantization=True
    with pytest.raises(ValueError):
        vllm_autoconfig.pick_quantization("some-model", "none", tier)


def test_quantization_none_on_nonquant_tier_returns_none():
    """'none' on a non-quant tier returns None (vLLM picks bf16/fp16 itself)."""
    tier = vllm_autoconfig.TIERS["ge24gb"]  # needs_quantization=False
    assert vllm_autoconfig.pick_quantization("some-model", "none", tier) is None


def test_quantization_auto_sniffs_name_suffix():
    """'auto' infers awq/gptq/fp8 from the model name suffix."""
    tier = vllm_autoconfig.TIERS["ge8gb"]
    assert vllm_autoconfig.pick_quantization("Qwen2.5-Coder-7B-AWQ", "auto", tier) == "awq"
    assert vllm_autoconfig.pick_quantization("model-GPTQ-Int4", "auto", tier) == "gptq"
    assert vllm_autoconfig.pick_quantization("model-FP8", "auto", tier) == "fp8"


def test_quantization_auto_no_hint_on_quant_tier_raises():
    """'auto' with no name hint on a quant-needing tier raises (forces a real variant)."""
    tier = vllm_autoconfig.TIERS["ge8gb"]
    with pytest.raises(ValueError):
        vllm_autoconfig.pick_quantization("plain-model", "auto", tier)


def test_quantization_explicit_passthrough_and_unknown_raises():
    """Explicit awq/gptq/fp8 pass through; an unknown value raises."""
    tier = vllm_autoconfig.TIERS["ge24gb"]
    assert vllm_autoconfig.pick_quantization("m", "awq", tier) == "awq"
    with pytest.raises(ValueError):
        vllm_autoconfig.pick_quantization("m", "int3", tier)


# ── command assembly ──────────────────────────────────────────────────────────


def test_build_command_omits_fp8_when_unsupported():
    """build_vllm_command drops --kv-cache-dtype fp8 when the driver can't run it."""
    tier = vllm_autoconfig.TIERS["ge12gb"]  # kv_cache_dtype="fp8"
    cmd = vllm_autoconfig.build_vllm_command(
        "m", tier, quantization=None, max_context_override=None,
        cpu_offload_gb=0, fp8_kv_supported=False,
    )
    assert "--kv-cache-dtype" not in cmd


def test_build_command_includes_fp8_when_supported():
    """build_vllm_command emits --kv-cache-dtype fp8 on an fp8 tier with a capable driver."""
    tier = vllm_autoconfig.TIERS["ge12gb"]
    cmd = vllm_autoconfig.build_vllm_command(
        "m", tier, quantization=None, max_context_override=None,
        cpu_offload_gb=0, fp8_kv_supported=True,
    )
    assert "--kv-cache-dtype" in cmd
    assert cmd[cmd.index("--kv-cache-dtype") + 1] == "fp8"


def test_build_command_enforce_eager_and_swap_on_low_tier():
    """The <8 GB tier emits --enforce-eager and --swap-space."""
    tier = vllm_autoconfig.TIERS["lt8gb"]
    cmd = vllm_autoconfig.build_vllm_command(
        "m-AWQ", tier, quantization="awq", max_context_override=None,
        cpu_offload_gb=0, fp8_kv_supported=True,
    )
    assert "--enforce-eager" in cmd
    assert "--swap-space" in cmd


def test_build_command_cpu_offload_only_when_positive():
    """--cpu-offload-gb is emitted only when the tier offloads AND the size is > 0."""
    tier = vllm_autoconfig.TIERS["lt8gb"]  # cpu_offload=True
    with_off = vllm_autoconfig.build_vllm_command(
        "m-AWQ", tier, quantization="awq", max_context_override=None,
        cpu_offload_gb=8, fp8_kv_supported=True,
    )
    without_off = vllm_autoconfig.build_vllm_command(
        "m-AWQ", tier, quantization="awq", max_context_override=None,
        cpu_offload_gb=0, fp8_kv_supported=True,
    )
    assert "--cpu-offload-gb" in with_off
    assert "--cpu-offload-gb" not in without_off


def test_build_command_max_context_override_wins():
    """An explicit max-context override beats the tier default --max-model-len."""
    tier = vllm_autoconfig.TIERS["ge12gb"]  # tier default 32768
    cmd = vllm_autoconfig.build_vllm_command(
        "m", tier, quantization=None, max_context_override=4096,
        cpu_offload_gb=0, fp8_kv_supported=True,
    )
    assert cmd[cmd.index("--max-model-len") + 1] == "4096"


# ── F7 regression: the real main() fp8 gate ───────────────────────────────────


def _run_main_with_driver(monkeypatch, capsys, driver: str) -> str:
    """Run main() against a 16 GB (fp8-tier) GPU with the given driver string,
    monkeypatching only the platform check and the nvidia-smi probe. Returns stdout."""
    monkeypatch.setattr(vllm_autoconfig.platform, "system", lambda: "Linux")
    monkeypatch.setattr(vllm_autoconfig, "detect_nvidia_gpu", lambda: _gpu(driver, free_gb=16.0))
    rc = vllm_autoconfig.main(["--model", "plain-model", "--output", "cmd"])
    assert rc == 0
    return capsys.readouterr().out


def test_main_unknown_driver_disables_fp8(monkeypatch, capsys):
    """F7: an UNKNOWN driver (unparseable → major 0) must NOT enable fp8 KV-cache.

    The pre-fix gate `driver_major == 0 or ... >= 535` would have ENABLED fp8 here
    (the bug). The fixed gate `>= 535` disables it. A revert breaks this test."""
    out = _run_main_with_driver(monkeypatch, capsys, "")
    assert "--kv-cache-dtype fp8" not in out


def test_main_old_driver_disables_fp8(monkeypatch, capsys):
    """F7: a driver below 535 (e.g. 534) must NOT enable fp8 KV-cache."""
    out = _run_main_with_driver(monkeypatch, capsys, "534.99")
    assert "--kv-cache-dtype fp8" not in out


def test_main_new_driver_enables_fp8(monkeypatch, capsys):
    """F7 positive control: a driver >= 535 DOES enable fp8 on an fp8 tier."""
    out = _run_main_with_driver(monkeypatch, capsys, "535.183.01")
    assert "--kv-cache-dtype fp8" in out


# ── main() smoke (dry-run, no real GPU) ───────────────────────────────────────


def test_main_dry_run_emits_vllm_command(capsys):
    """--dry-run uses a synthetic 24 GB GPU and emits a `vllm serve` command, exit 0."""
    rc = vllm_autoconfig.main(["--dry-run", "--model", "Qwen2.5-Coder-7B", "--output", "cmd"])
    out = capsys.readouterr().out
    assert rc == 0
    assert out.startswith("vllm serve")


def test_main_print_vram_only_dry_run_emits_json(capsys):
    """--print-vram-only --dry-run prints schema-versioned JSON with the picked tier, exit 0."""
    rc = vllm_autoconfig.main(["--print-vram-only", "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    payload = json.loads(out)
    assert payload["schema_version"] == vllm_autoconfig.SCHEMA_VERSION
    assert payload["tier"] == "ge24gb"  # synthetic 24 GB GPU
