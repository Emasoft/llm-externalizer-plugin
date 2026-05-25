#!/usr/bin/env python3
"""Tests for scripts/setup/detect-runners.py — the "safe detection, never crash
the wizard" helpers.

Covers three real behaviors of the runner-detection helpers:
  - _safe_model_names tolerates a non-dict (list) JSON payload without raising
  - _safe_model_names still extracts names from a well-formed dict (no regression)
  - _vllm_import_probe reports a broken-but-installed vLLM as not-usable

The module filename is hyphenated (not an importable identifier), so it is
loaded via importlib.util.spec_from_file_location rather than `import`.
"""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from types import SimpleNamespace

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DETECT_RUNNERS_PY = PROJECT_ROOT / "scripts" / "setup" / "detect-runners.py"


def _load_module():
    """Load the hyphenated detect-runners.py file as a module via importlib."""
    spec = importlib.util.spec_from_file_location("detect_runners", DETECT_RUNNERS_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


detect_runners = _load_module()


def test_safe_model_names_list_payload_returns_empty():
    """A list (wrong-shape) payload yields [] instead of raising AttributeError."""
    # A forked/old runner API returning a bare JSON array is truthy, so the old
    # `(payload or {}).get(...)` kept the list and crashed on `.get`.
    result = detect_runners._safe_model_names([{"name": "x"}], "models", "name")
    assert result == []


def test_safe_model_names_wellformed_dict_returns_names():
    """A well-formed dict payload still returns the model names (no regression)."""
    payload = {"models": [{"name": "llama3.1:70b"}, {"name": "qwen2:7b"}]}
    result = detect_runners._safe_model_names(payload, "models", "name")
    assert result == ["llama3.1:70b", "qwen2:7b"]


def test_vllm_import_probe_broken_install_reported_not_usable(monkeypatch):
    """A vLLM that imports-but-errors is reported broken (not-usable), not absent."""
    # Stub subprocess.run to mimic `import vllm` crashing with an exception class
    # that the old allowlist (ImportError/OSError/RuntimeError) did NOT cover, so
    # it used to fall through to (None, None) == "not installed".
    fake = SimpleNamespace(
        returncode=1,
        stdout="",
        stderr=(
            "Traceback (most recent call last):\n"
            '  File "<string>", line 1, in <module>\n'
            "AttributeError: module 'vllm' has no attribute '__version__'"
        ),
    )

    def fake_run(*_args, **_kwargs):
        return fake

    monkeypatch.setattr(subprocess, "run", fake_run)

    version, import_error = detect_runners._vllm_import_probe()
    # Not usable: no clean version, AND flagged as installed-but-broken.
    assert version is None
    assert import_error is not None
    assert "AttributeError" in import_error
