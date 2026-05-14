#!/usr/bin/env python3
"""detect-runners.py — Find installed local-model runners.

Outputs a single JSON object to stdout, no other lines. Errors go to stderr.
Used by the llm-externalizer-setup-agent in Step 2 to decide whether to skip
to Step 4 (one runner found, auto-select) or branch to Step 3a (none) /
Step 3b (multiple).

Detected runners:
    - Ollama         (CLI: ollama,         port: 11434, native + OpenAI compat)
    - LM Studio      (CLI: lms,            port: 1234,  OpenAI compat + native)
    - vLLM           (python pkg: vllm,    port: 8000,  OpenAI compat)
    - llama.cpp      (CLI: llama-server,   port: 8080,  OpenAI compat)
    - Jan            (no CLI; port: 1337,  OpenAI compat)

Output shape:
    {
      "runners": [
        {"name": "ollama", "version": "0.5.1", "port": 11434,
         "running": true,  "models": ["llama3.1:70b", ...], "cli": "/path/to/ollama"},
        ...
      ]
    }

A runner is included in the output if EITHER:
    - its CLI is on PATH (even if not currently serving), OR
    - its expected port is responding to /v1/models with a parseable list.

This lets the agent show "installed but not running" for cases where the
user installed Ollama but forgot to start `ollama serve`.

Why standard library only: this script runs before we know whether the user
has `requests` or `httpx` available. urllib + json + subprocess is enough.
"""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HTTP_TIMEOUT = 2.0
CMD_TIMEOUT = 5.0


def http_get_json(url: str, timeout: float = HTTP_TIMEOUT) -> Optional[dict]:
    """GET <url> and parse the body as JSON. Return None on any failure.

    Failures we treat as "service not present" rather than fatal:
      - URLError (connection refused, DNS, etc.) — service not running
      - HTTPError (4xx, 5xx)                     — wrong endpoint or auth issue
      - socket.timeout                           — service hung
      - json.JSONDecodeError                     — service returned non-JSON
    """
    try:
        with urlopen(Request(url), timeout=timeout) as r:
            body = r.read()
        return json.loads(body.decode("utf-8", errors="replace"))
    except (URLError, HTTPError, TimeoutError, socket.timeout, json.JSONDecodeError, OSError):
        return None


def run_cli(args: list[str], timeout: float = CMD_TIMEOUT) -> Optional[str]:
    """Run a CLI command, return its first stdout line, or None on any failure.

    Caveat: a non-zero exit MUST return None. An earlier version fell back to
    stderr when stdout was empty, which mis-reported Python ImportError
    tracebacks as "vllm version is Traceback (most recent call last):". If
    a real-world CLI ever prints --version to stderr only AND exits 0, we
    catch that here too. CLIs that print to stderr AND exit non-zero (the
    failure path) are the case this guards against.
    """
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    out = result.stdout.strip() or result.stderr.strip()
    return out.split("\n")[0] if out else None


def _safe_model_names(payload: Optional[dict], key: str, name_field: str) -> list[str]:
    """Extract model names from a /v1/models or /api/tags response, defensively.

    Returns [] (not None, not crash) when: payload is None / wrong shape / the
    list contains non-dict items or items missing the expected name field.
    Without this guard, a single bad entry (e.g. an old / forked runner API)
    raises KeyError inside the detector, which main()'s outer `except Exception`
    converts into "runner not installed" — masking the actual issue.
    """
    items = (payload or {}).get(key, [])
    if not isinstance(items, list):
        return []
    return [m[name_field] for m in items if isinstance(m, dict) and isinstance(m.get(name_field), str)]


def detect_ollama() -> Optional[dict]:
    """Ollama: CLI `ollama`, port 11434, native /api/tags + OpenAI /v1/."""
    cli = shutil.which("ollama")
    tags = http_get_json("http://localhost:11434/api/tags")

    # Skip silently if neither CLI nor server is present — Ollama is not
    # installed at all.
    if cli is None and tags is None:
        return None

    version = run_cli([cli, "--version"]) if cli else None
    return {
        "name": "ollama",
        "version": version or "unknown",
        "port": 11434,
        "running": tags is not None,
        "models": _safe_model_names(tags, "models", "name"),
        "cli": cli,
    }


def detect_lmstudio() -> Optional[dict]:
    """LM Studio: CLI `lms`, port 1234, native + OpenAI compat /v1/."""
    cli = shutil.which("lms")
    models_resp = http_get_json("http://localhost:1234/v1/models")

    if cli is None and models_resp is None:
        return None

    version = run_cli([cli, "--version"]) if cli else None
    return {
        "name": "lmstudio",
        "version": version or "unknown",
        "port": 1234,
        "running": models_resp is not None,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": cli,
    }


def detect_vllm() -> Optional[dict]:
    """vLLM: python package `vllm`, port 8000, OpenAI compat /v1/."""
    # vLLM is a Python package; we test by spawning the active interpreter.
    # This is slow (~150ms) but the only reliable way: `pip show vllm` and
    # `which vllm` both miss installs in venvs / conda envs that the agent
    # cannot see from outside.
    version = run_cli([sys.executable, "-c", "import vllm; print(vllm.__version__)"])
    models_resp = http_get_json("http://localhost:8000/v1/models")

    if version is None and models_resp is None:
        return None

    return {
        "name": "vllm",
        "version": version or "unknown",
        "port": 8000,
        "running": models_resp is not None,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": None,  # vLLM is invoked as `python -m vllm.entrypoints.openai.api_server`
    }


def detect_llamacpp() -> Optional[dict]:
    """llama.cpp: CLI `llama-server`, port 8080, OpenAI compat /v1/."""
    cli = shutil.which("llama-server")
    models_resp = http_get_json("http://localhost:8080/v1/models")

    if cli is None and models_resp is None:
        return None

    version = run_cli([cli, "--version"]) if cli else None
    return {
        "name": "llamacpp",
        "version": version or "unknown",
        "port": 8080,
        "running": models_resp is not None,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": cli,
    }


def detect_jan() -> Optional[dict]:
    """Jan: no canonical CLI; port 1337, OpenAI compat /v1/."""
    # Jan ships as a GUI app — `jan` may exist as a CLI on some platforms but
    # is not the canonical detection path. Probe the port instead.
    models_resp = http_get_json("http://localhost:1337/v1/models")
    if models_resp is None:
        return None
    return {
        "name": "jan",
        "version": "unknown",  # /v1/models does not expose Jan's version
        "port": 1337,
        "running": True,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": shutil.which("jan"),
    }


def main() -> int:
    runners = []
    for fn in (detect_ollama, detect_lmstudio, detect_vllm, detect_llamacpp, detect_jan):
        try:
            r = fn()
        except Exception as e:  # noqa: BLE001
            # Detection of one runner must NEVER kill detection of the rest.
            # Log to stderr and continue.
            print(f"warn: {fn.__name__} crashed: {e}", file=sys.stderr)
            continue
        if r is not None:
            runners.append(r)

    json.dump({"runners": runners}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
