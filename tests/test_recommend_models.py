#!/usr/bin/env python3
"""Tests for scripts/setup/recommend-models.py — the setup-wizard's "which local
coding model fits this hardware" decision core.

These exercise the PURE, deterministic heart of the 2937-LOC recommender: the
VRAM-headroom fit tiering, the run-status labelling, the license multiplier, the
memory-budget basis selection (GPU vs Apple unified vs CPU RAM), the INT4 +
context memory estimate, the weighted coding score, the last-token parameter
parse (the Qwen3.5-27B → 27B fix), and the top-level recommend_models() ranking
+ compatibility filter (fits/doesn't-fit, sorting, no-candidates edge case).

Inputs are real HardwareProfile / ModelRecord dataclasses; no IO is touched and
nothing under test is mocked — every assertion is on a real computed
recommendation.

The module filename is hyphenated (not an importable identifier), so it is
loaded via importlib.util.spec_from_file_location, and registered in sys.modules
BEFORE exec_module so the module's @dataclass decorators can resolve
cls.__module__ (Python 3.12 dataclasses look it up via sys.modules).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RECOMMEND_MODELS_PY = PROJECT_ROOT / "scripts" / "setup" / "recommend-models.py"


def _load_module():
    """Load the hyphenated recommend-models.py file as a module via importlib."""
    spec = importlib.util.spec_from_file_location("recommend_models", RECOMMEND_MODELS_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register BEFORE exec so the @dataclass decorators inside the module resolve
    # cls.__module__ via sys.modules (Python 3.12 dataclasses._is_type does
    # sys.modules.get(cls.__module__).__dict__ → AttributeError on None for an
    # unregistered dynamically-loaded module).
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rm = _load_module()


def _model(
    name: str = "Test-Model-7B",
    *,
    params_b: float | None = 7.0,
    context_tokens: int | None = 131072,
    license: str | None = "apache-2.0",
    vram_int4_gb: float | None = 4.0,
    livecodebench: float | None = None,
    swe_bench_verified: float | None = None,
    humaneval: float | None = None,
    gpqa_diamond: float | None = None,
    mmlu_pro: float | None = None,
):
    """Build a ModelRecord with realistic defaults; only the fields under test vary."""
    return rm.ModelRecord(
        name=name,
        provider="TestOrg",
        params=f"{params_b}B" if params_b is not None else None,
        params_b=params_b,
        context=str(context_tokens) if context_tokens is not None else None,
        context_tokens=context_tokens,
        license=license,
        vram_int4_gb=vram_int4_gb,
        vram_fp16_gb=(vram_int4_gb * 2) if vram_int4_gb is not None else None,
        mmlu_pro=mmlu_pro,
        gpqa_diamond=gpqa_diamond,
        ifeval=None,
        chatbot_arena=None,
        swe_bench_verified=swe_bench_verified,
        humaneval=humaneval,
        livecodebench=livecodebench,
        aime_2025=None,
        math_500=None,
        source_url="https://example.test/model",
        source="onyx",
    )


def _gpu_hw(vram_gb: float, ram_gb: float = 64.0):
    """Build a single-GPU HardwareProfile with the given VRAM as the memory budget."""
    return rm.HardwareProfile(
        os_name="Linux",
        machine="x86_64",
        cpu="Test CPU",
        ram_gb=ram_gb,
        gpu_names=["Test GPU"],
        gpu_vram_gb=vram_gb,
        largest_single_gpu_vram_gb=vram_gb,
        total_gpu_vram_gb=vram_gb,
        gpu_count=1,
        backend_hints=["CUDA"],
        unified_memory=False,
    )


def test_fit_factor_tiers_by_headroom_ratio():
    """fit_factor maps the headroom ratio to its five discrete fit weights."""
    assert rm.fit_factor(0.40, True) == 1.0  # >= 0.30 comfortable
    assert rm.fit_factor(0.20, True) == 0.90  # >= 0.15
    assert rm.fit_factor(0.08, True) == 0.72  # >= 0.05
    assert rm.fit_factor(0.01, True) == 0.50  # positive but tiny
    # Incompatible or unknown headroom collapses the fit weight to zero.
    assert rm.fit_factor(0.40, False) == 0.0
    assert rm.fit_factor(None, True) == 0.0


def test_run_status_labels_track_headroom_tiers():
    """run_status returns the human label matching each headroom tier (and the not-fit case)."""
    assert rm.run_status(0.40, True) == "runs very comfortably"
    assert rm.run_status(0.20, True) == "runs comfortably"
    assert rm.run_status(0.08, True) == "runs, but tight"
    assert rm.run_status(0.01, True) == "barely fits, not recommended"
    assert rm.run_status(0.40, False) == "does not fit"
    assert rm.run_status(None, True) == "does not fit"


def test_license_factor_branches_permissive_noncommercial_family_default():
    """license_factor returns 1.0 permissive, 0.0 blocked-NC, family/default discounts, 0.92 when unknown."""
    assert rm.license_factor("Apache-2.0", allow_noncommercial=False) == 1.0
    assert rm.license_factor("MIT", allow_noncommercial=False) == 1.0
    # Non-commercial license is fully excluded unless explicitly allowed.
    assert rm.license_factor("CC-BY-NC-4.0", allow_noncommercial=False) == 0.0
    # Once NC is allowed, "CC-BY-NC" still contains the permissive "cc-by" keyword -> 1.0.
    assert rm.license_factor("CC-BY-NC-4.0", allow_noncommercial=True) == 1.0
    # A research-only license has no permissive substring, so it stays fully blocked.
    assert rm.license_factor("Research only license", allow_noncommercial=False) == 0.0
    # Family-branded licenses get a near-full multiplier.
    assert rm.license_factor("Llama 3 Community License", allow_noncommercial=False) == 0.94
    # A present-but-unrecognized license gets the conservative default.
    assert rm.license_factor("Some Proprietary EULA", allow_noncommercial=False) == 0.90
    # An absent license is treated as mildly uncertain, not blocked.
    assert rm.license_factor(None, allow_noncommercial=False) == 0.92


def test_recommendation_memory_budget_selects_gpu_apple_or_cpu_basis():
    """recommendation_memory_budget picks GPU VRAM, Apple unified, or CPU-RAM budget by hardware."""
    # GPU present -> full single-GPU VRAM is the budget.
    basis, mem = rm.recommendation_memory_budget(_gpu_hw(24.0), 0.75, 0.50)
    assert basis == "largest single GPU VRAM"
    assert mem == 24.0
    # No GPU but unified memory -> a fraction of system RAM.
    apple = rm.HardwareProfile(
        os_name="Darwin", machine="arm64", cpu="Apple M3", ram_gb=64.0,
        gpu_names=["Apple M3"], gpu_vram_gb=0.0, largest_single_gpu_vram_gb=0.0,
        total_gpu_vram_gb=0.0, gpu_count=1, backend_hints=["MLX"], unified_memory=True,
    )
    basis, mem = rm.recommendation_memory_budget(apple, 0.75, 0.50)
    assert basis == "Apple unified memory budget"
    assert mem == 48.0  # 64 * 0.75
    # No GPU, no unified memory -> conservative CPU fraction of RAM.
    cpu_only = rm.dataclasses.replace(apple, unified_memory=False, backend_hints=[])
    basis, mem = rm.recommendation_memory_budget(cpu_only, 0.75, 0.50)
    assert basis == "system RAM CPU budget"
    assert mem == 32.0  # 64 * 0.50


def test_estimate_required_memory_adds_context_overhead_and_handles_missing_int4():
    """estimate_required_memory_gb sums INT4 + context overhead + safety, and is None without an INT4 size."""
    model = _model(params_b=7.0, context_tokens=131072, vram_int4_gb=4.0)
    # At 8K context there is zero context overhead, so required == int4 + safety.
    small_ctx = rm.estimate_required_memory_gb(model, context_tokens=8192, safety_overhead_gb=1.25)
    assert small_ctx == 4.0 + 0.0 + 1.25
    # A larger context adds a positive, monotonically growing overhead.
    big_ctx = rm.estimate_required_memory_gb(model, context_tokens=32768, safety_overhead_gb=1.25)
    assert big_ctx is not None
    assert big_ctx > small_ctx
    assert rm.context_overhead_gb(model, 32768) > 0.0
    # A model with no INT4 figure cannot be sized -> None (drives "missing estimate").
    no_int4 = _model(vram_int4_gb=None)
    assert rm.estimate_required_memory_gb(no_int4, context_tokens=32768, safety_overhead_gb=1.25) is None


def test_coding_score_weights_benchmarks_and_ranks_stronger_model_higher():
    """coding_score normalizes benchmarks across the set and scores the better model higher."""
    strong = _model(name="Strong-7B", livecodebench=80.0, swe_bench_verified=60.0, humaneval=90.0)
    weak = _model(name="Weak-7B", livecodebench=20.0, swe_bench_verified=10.0, humaneval=40.0)
    normalized = rm.normalized_benchmark_values([strong, weak])
    strong_score = rm.coding_score(strong, normalized)
    weak_score = rm.coding_score(weak, normalized)
    # Min-max normalization puts the leader at 100 and the laggard at 0 per column.
    assert strong_score == 100.0
    assert weak_score == 0.0
    # A model with no benchmark data at all scores zero (no pieces to weight).
    blank = _model(name="Blank-7B")
    assert rm.coding_score(blank, rm.normalized_benchmark_values([blank])) == 0.0


def test_parse_params_b_from_model_name_uses_last_size_token():
    """parse_params_b_from_model_name takes the architecture-size token, not a version-number prefix."""
    # The regression case: a dotted version prefix must NOT become the size.
    assert rm.parse_params_b_from_model_name("Qwen3.5-27B") == 27.0
    assert rm.parse_params_b_from_model_name("Llama-3.1-8B-Instruct") == 8.0
    # Architecture-annotated sizes (active-param MoE notation) are still recognized.
    assert rm.parse_params_b_from_model_name("Mixtral-8x7B-A3B") == 3.0
    # A name whose only number is a non-"B" suffix (e.g. trillion) has no size token -> None.
    assert rm.parse_params_b_from_model_name("Giant-1.5T") is None
    # A name with no parameter token yields None (no size to estimate from).
    assert rm.parse_params_b_from_model_name("mystery-model-instruct") is None


def test_recommend_models_ranks_comfortable_fit_above_tight_fit():
    """recommend_models marks both models compatible and sorts the higher-scoring, roomier one first."""
    hardware = _gpu_hw(24.0)
    big_room = _model(
        name="Roomy-7B", params_b=7.0, vram_int4_gb=4.0,
        livecodebench=90.0, swe_bench_verified=70.0, humaneval=95.0,
    )
    tight = _model(
        name="Tight-20B", params_b=20.0, vram_int4_gb=16.0,
        livecodebench=40.0, swe_bench_verified=20.0, humaneval=50.0,
    )
    recs = rm.recommend_models(
        [tight, big_room], hardware, evidences=[], context_tokens=32768,
        min_headroom=0.05, allow_noncommercial=False, include_incompatible=False,
        require_whatcanirun=False, unified_memory_fraction=0.75, cpu_memory_fraction=0.50,
    )
    assert [r.model.name for r in recs] == ["Roomy-7B", "Tight-20B"]
    assert recs[0].compatible is True
    assert recs[0].final_score > recs[1].final_score


def test_recommend_models_excludes_model_that_does_not_fit_vram():
    """recommend_models drops a model whose INT4 footprint exceeds the VRAM budget when incompatibles are hidden."""
    hardware = _gpu_hw(8.0)  # only 8 GB of VRAM
    too_big = _model(name="Huge-70B", params_b=70.0, vram_int4_gb=40.0, livecodebench=99.0)
    fits = _model(name="Small-3B", params_b=3.0, vram_int4_gb=2.0, livecodebench=50.0)
    hidden = rm.recommend_models(
        [too_big, fits], hardware, evidences=[], context_tokens=32768,
        min_headroom=0.05, allow_noncommercial=False, include_incompatible=False,
        require_whatcanirun=False, unified_memory_fraction=0.75, cpu_memory_fraction=0.50,
    )
    assert [r.model.name for r in hidden] == ["Small-3B"]
    # With include_incompatible the oversized model reappears but is flagged not-compatible and ranked last.
    shown = rm.recommend_models(
        [too_big, fits], hardware, evidences=[], context_tokens=32768,
        min_headroom=0.05, allow_noncommercial=False, include_incompatible=True,
        require_whatcanirun=False, unified_memory_fraction=0.75, cpu_memory_fraction=0.50,
    )
    by_name = {r.model.name: r for r in shown}
    assert by_name["Huge-70B"].compatible is False
    assert by_name["Huge-70B"].run_status == "does not fit"
    assert shown[-1].model.name == "Huge-70B"


def test_recommend_models_empty_and_zero_hardware_edge_cases():
    """recommend_models returns [] for no candidates, and excludes everything on zero-memory hardware."""
    zero_hw = rm.HardwareProfile(
        os_name="Linux", machine="x86_64", cpu="Test CPU", ram_gb=0.0,
        gpu_names=[], gpu_vram_gb=0.0, largest_single_gpu_vram_gb=0.0,
        total_gpu_vram_gb=0.0, gpu_count=0, backend_hints=[], unified_memory=False,
    )
    common = dict(
        evidences=[], context_tokens=32768, min_headroom=0.05, allow_noncommercial=False,
        require_whatcanirun=False, unified_memory_fraction=0.75, cpu_memory_fraction=0.50,
    )
    # No models in -> empty list out, no crash.
    assert rm.recommend_models([], zero_hw, include_incompatible=True, **common) == []
    # Zero usable memory -> a real model cannot be compatible.
    model = _model(name="Any-7B", vram_int4_gb=4.0, livecodebench=70.0)
    on_zero = rm.recommend_models([model], zero_hw, include_incompatible=True, **common)
    assert on_zero[0].compatible is False
    # Hiding incompatibles on zero hardware yields an empty recommendation set.
    assert rm.recommend_models([model], zero_hw, include_incompatible=False, **common) == []
