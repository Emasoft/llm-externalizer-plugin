#!/usr/bin/env python3
"""Tests for scripts/setup/test-model.py — the OpenAI-compatible-endpoint
compatibility tester used by the setup wizard.

The load-bearing target is the SSRF guard `_validate_local_url`. It is a PURE
validation function, so it is fed real URL strings and its accept/reject
behaviour is asserted directly — no mocking of the unit under test.

A precise note on what the guard ACTUALLY enforces (verified by reading the
source, not the docstring): it restricts the URL scheme to http/https AND
requires a non-empty netloc. That is the entire rule. It does NOT block the
cloud-metadata IP or external hosts by address — `http://169.254.169.254` and
`http://evil.example.com` are well-formed http URLs and PASS. The SSRF
exposure the docstring worries about (dumping the wizard's env via
`file:///proc/self/environ`, or probing instance metadata via a non-http
scheme) is closed by the http(s)-only restriction: urllib.request.urlopen
silently accepts file://, ftp://, gopher://, etc., and THOSE are exactly what
the guard rejects. So the reject-side tests target scheme/netloc violations,
which is what the code checks, rather than IP-blocklisting it does not do.

The remaining tests cover the other pure helpers: the bearer-token redaction
(`_sanitise_error_body`), the response-shape discriminator (`extract_content`),
and the error-sentinel extractor (`_err_from_call`).

The module filename is hyphenated (not an importable identifier), so it is
loaded via importlib.util.spec_from_file_location rather than `import`. The
module is registered in sys.modules BEFORE exec_module so any decorator that
resolves cls.__module__ via sys.modules works (mirrors the pattern in
test_vllm_cuda_autoconfig.py).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEST_MODEL_PY = PROJECT_ROOT / "scripts" / "setup" / "test-model.py"


def _load_module():
    """Load the hyphenated test-model.py file as a module via importlib."""
    spec = importlib.util.spec_from_file_location("test_model_under_test", TEST_MODEL_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


test_model = _load_module()


# ── _validate_local_url: the SSRF guard (ACCEPT side) ──────────────────────────


def test_validate_url_accepts_localhost_loopback_and_external_http():
    """Any well-formed http(s) URL with a non-empty host passes (localhost, 127.0.0.1, [::1], external)."""
    # The guard whitelists by scheme+netloc, not by address — every one of these
    # is a valid http(s) URL with a host, so all are returned unchanged.
    for url in (
        "http://localhost:11434/v1",
        "http://127.0.0.1:1234/v1",
        "https://127.0.0.1:8443/v1",
        "http://[::1]:11434/v1",
        "http://0.0.0.0:8000/v1",
        "https://api.openrouter.ai/v1",
    ):
        assert test_model._validate_local_url(url) == url


def test_validate_url_accepts_metadata_ip_because_guard_is_scheme_based():
    """An http URL to the cloud-metadata IP passes — the guard gates on scheme, not IP (documents real behaviour)."""
    # This pins the guard's ACTUAL contract: it does NOT IP-blocklist 169.254.169.254.
    # The docstring's IMDS concern is mitigated by rejecting non-http schemes, not
    # by rejecting this address. If a future change adds IP-blocking, this test must
    # be revisited deliberately rather than silently passing.
    url = "http://169.254.169.254/latest/meta-data/"
    assert test_model._validate_local_url(url) == url


# ── _validate_local_url: the SSRF guard (REJECT side) ──────────────────────────


def test_validate_url_rejects_file_scheme_env_exfil_vector():
    """`file:///proc/self/environ` is rejected with SystemExit — blocks env-dump SSRF."""
    with pytest.raises(SystemExit):
        test_model._validate_local_url("file:///proc/self/environ")


def test_validate_url_rejects_non_http_schemes():
    """Non-http(s) schemes (ftp, gopher, data) urllib would otherwise accept are rejected."""
    for url in (
        "ftp://localhost/x",
        "gopher://127.0.0.1:70/_probe",
        "data:text/plain;base64,aGVsbG8=",
    ):
        with pytest.raises(SystemExit):
            test_model._validate_local_url(url)


def test_validate_url_rejects_schemeless_and_empty_netloc():
    """A bare host with no scheme, and an http URL with an empty host, are both rejected."""
    # "localhost:11434/v1" parses scheme='localhost' (not http) → reject.
    with pytest.raises(SystemExit):
        test_model._validate_local_url("localhost:11434/v1")
    # "http:///v1" has scheme http but an EMPTY netloc → reject on the netloc clause.
    with pytest.raises(SystemExit):
        test_model._validate_local_url("http:///v1")
    # Empty string → no scheme, no netloc → reject.
    with pytest.raises(SystemExit):
        test_model._validate_local_url("")


# ── _sanitise_error_body: bearer-token redaction ───────────────────────────────


def test_sanitise_error_body_redacts_token_shapes():
    """OpenAI sk-, Hugging Face hf_, and `Bearer <token>` shapes are replaced with [REDACTED]."""
    body = (
        "auth failed for sk-ABCDEF1234567890 and hf_abcdef12345678 "
        "using header Bearer secrettoken9999"
    )
    cleaned = test_model._sanitise_error_body(body)
    assert "sk-ABCDEF1234567890" not in cleaned
    assert "hf_abcdef12345678" not in cleaned
    assert "secrettoken9999" not in cleaned
    assert cleaned.count("[REDACTED]") == 3


def test_sanitise_error_body_leaves_clean_text_unchanged():
    """A body with no token-shaped substrings is returned byte-for-byte unchanged."""
    body = "HTTP 404: model 'qwen2.5-coder:7b' not found on this server"
    assert test_model._sanitise_error_body(body) == body


# ── extract_content: response-shape discriminator ──────────────────────────────


def test_extract_content_returns_text_for_plain_string_reply():
    """A normal {choices:[{message:{content:'...'}}]} reply yields (text, None)."""
    resp = {"choices": [{"message": {"content": "hello there"}}]}
    text, hint = test_model.extract_content(resp)
    assert text == "hello there"
    assert hint is None


def test_extract_content_distinguishes_tool_calls_from_malformed():
    """tool_calls content gives a specific hint; a missing choices array gives the shape hint."""
    tool_resp = {"choices": [{"message": {"content": None, "tool_calls": [{"id": "c1"}]}}]}
    text, hint = test_model.extract_content(tool_resp)
    assert text == ""
    assert hint is not None and "tool_calls" in hint

    malformed = {"object": "error"}  # no .choices at all
    text2, hint2 = test_model.extract_content(malformed)
    assert text2 == ""
    assert hint2 is not None and "no .choices" in hint2


# ── _err_from_call: error-sentinel extractor ───────────────────────────────────


def test_err_from_call_ignores_null_error_but_returns_real_error():
    """`error: null` alongside a valid reply is NOT a failure; a non-empty error string is returned."""
    # Proxy/llama.cpp builds legitimately include "error": null on success.
    assert test_model._err_from_call({"error": None, "choices": [{}]}) is None
    assert test_model._err_from_call({"choices": [{}]}) is None
    # A genuine sentinel error string is surfaced verbatim.
    assert test_model._err_from_call({"error": "transport: timed out"}) == "transport: timed out"
