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

import argparse
import json
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HTTP_TIMEOUT = 2.0
CMD_TIMEOUT = 5.0


def wsl2_host_ip() -> Optional[str]:
    """If running on WSL2, return the Windows host IP (else None).

    WSL2 reports `Linux` from uname but `microsoft` appears in /proc/version.
    /etc/resolv.conf's nameserver entry resolves to the Windows host on a
    default WSL2 install. The agent can use this to probe both `localhost`
    (Linux side) and the Windows host (where LM Studio commonly runs).
    """
    try:
        version_text = Path("/proc/version").read_text(errors="replace")
    except OSError:
        return None
    if "microsoft" not in version_text.lower() and "wsl" not in version_text.lower():
        return None
    try:
        resolv = Path("/etc/resolv.conf").read_text(errors="replace")
    except OSError:
        return None
    for line in resolv.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "nameserver":
            return parts[1].strip()
    return None


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
    # A truthy non-dict payload (e.g. a JSON list returned by a forked runner
    # API) would survive `payload or {}` and then blow up on `.get`. Guard on
    # the type so "wrong shape" yields [] per the docstring instead of raising
    # AttributeError that main()'s outer except would mask as "not installed".
    if not isinstance(payload, dict):
        return []
    items = payload.get(key, [])
    if not isinstance(items, list):
        return []
    return [m[name_field] for m in items if isinstance(m, dict) and isinstance(m.get(name_field), str)]


def detect_ollama(probe_host: str = "localhost") -> Optional[dict]:
    """Ollama: CLI `ollama`, port 11434, native /api/tags + OpenAI /v1/."""
    cli = shutil.which("ollama")
    tags = http_get_json(f"http://{probe_host}:11434/api/tags")

    # Skip silently if neither CLI nor server is present — Ollama is not
    # installed at all.
    if cli is None and tags is None:
        return None

    version = run_cli([cli, "--version"]) if cli else None
    return {
        "name": "ollama",
        "version": version or "unknown",
        "host": probe_host,
        "port": 11434,
        "running": tags is not None,
        "models": _safe_model_names(tags, "models", "name"),
        "cli": cli,
    }


def detect_lmstudio(probe_host: str = "localhost") -> Optional[dict]:
    """LM Studio: CLI `lms`, port 1234, native + OpenAI compat /v1/."""
    cli = shutil.which("lms")
    models_resp = http_get_json(f"http://{probe_host}:1234/v1/models")

    if cli is None and models_resp is None:
        return None

    version = run_cli([cli, "--version"]) if cli else None
    return {
        "name": "lmstudio",
        "version": version or "unknown",
        "host": probe_host,
        "port": 1234,
        "running": models_resp is not None,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": cli,
    }


def _vllm_import_probe() -> tuple[Optional[str], Optional[str]]:
    """Probe `import vllm` and discriminate "not installed" from "half-installed".

    Returns (version, import_error):
      - (version, None) — vllm imported cleanly
      - (None, None)    — vllm not present at all (ModuleNotFoundError, FileNotFoundError)
      - (None, msg)     — vllm IS present but the import crashes (e.g. mismatched
                          CUDA, missing _C extension). The agent should surface
                          this distinctly: "vLLM is installed but broken — fix
                          your CUDA/Python pairing, don't reinstall vLLM".
    """
    try:
        result = subprocess.run(
            [sys.executable, "-c", "import vllm; print(vllm.__version__)"],
            capture_output=True, text=True, timeout=CMD_TIMEOUT, check=False,
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None, None
    if result.returncode == 0:
        out = result.stdout.strip()
        return (out.split("\n")[0] if out else None), None
    # Non-zero. ModuleNotFoundError → not installed (None, None). EVERY other
    # non-zero exit means vLLM IS present but importing it crashed → installed
    # but broken (None, msg). Enumerating specific exception classes
    # (ImportError/OSError/RuntimeError) silently dropped the long tail —
    # AttributeError, TypeError, ValueError, AssertionError, bare SystemExit,
    # C-extension aborts with no recognisable class name — into the "not
    # installed" bucket, the opposite of this function's intent. A broken
    # install is anything that isn't cleanly "the module isn't there".
    stderr = result.stderr.strip()
    if "ModuleNotFoundError" in stderr:
        return None, None
    # Trim the message — full tracebacks would balloon the JSON. Last line of
    # the traceback is typically the actual error class + message.
    last_line = stderr.splitlines()[-1] if stderr else "unknown import failure"
    return None, last_line[:200]


def detect_vllm(probe_host: str = "localhost") -> Optional[dict]:
    """vLLM: python package `vllm`, port 8000, OpenAI compat /v1/."""
    version, import_error = _vllm_import_probe()
    models_resp = http_get_json(f"http://{probe_host}:8000/v1/models")

    # Nothing detected at all — really not installed.
    if version is None and import_error is None and models_resp is None:
        return None

    return {
        "name": "vllm",
        "version": version or ("broken" if import_error else "unknown"),
        "host": probe_host,
        "port": 8000,
        "running": models_resp is not None,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": None,  # vLLM is invoked as `python -m vllm.entrypoints.openai.api_server`
        # Only present when the import crashed — agent uses this to tell the
        # user "vLLM is installed but the import fails: <reason>".
        "import_error": import_error,
    }


def detect_llamacpp(probe_host: str = "localhost") -> Optional[dict]:
    """llama.cpp: CLI `llama-server`, port 8080, OpenAI compat /v1/."""
    cli = shutil.which("llama-server")
    models_resp = http_get_json(f"http://{probe_host}:8080/v1/models")

    if cli is None and models_resp is None:
        return None

    version = run_cli([cli, "--version"]) if cli else None
    return {
        "name": "llamacpp",
        "version": version or "unknown",
        "host": probe_host,
        "port": 8080,
        "running": models_resp is not None,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": cli,
    }


def detect_jan(probe_host: str = "localhost") -> Optional[dict]:
    """Jan: no canonical CLI; port 1337, OpenAI compat /v1/.

    Port 1337 is a common dev port — anything bound there returning JSON
    would otherwise be mis-tagged as Jan. We require BOTH `/v1/models`
    (OpenAI compat) AND `/api/version` (Jan-specific) to respond before
    claiming it's really Jan running.
    """
    models_resp = http_get_json(f"http://{probe_host}:1337/v1/models")
    if models_resp is None:
        return None
    # Jan-specific endpoint check — defeats port-1337 collisions (any old
    # tool, Hyper, dev webhook server) that happens to return valid JSON.
    version_resp = http_get_json(f"http://{probe_host}:1337/api/version")
    if version_resp is None:
        # /v1/models responded but /api/version did not — likely NOT Jan.
        # Skip to avoid a false positive.
        return None
    # /api/version typically returns {"version":"x.y.z"}. Even if it returns
    # an unexpected shape, we now have two-endpoint corroboration that this
    # is really Jan.
    version = None
    if isinstance(version_resp, dict):
        raw_version = version_resp.get("version")
        if isinstance(raw_version, str):
            version = raw_version
    return {
        "name": "jan",
        "version": version or "unknown",
        "host": probe_host,
        "port": 1337,
        "running": True,
        "models": _safe_model_names(models_resp, "data", "id"),
        "cli": shutil.which("jan"),
    }


DETECTORS = (detect_ollama, detect_lmstudio, detect_vllm, detect_llamacpp, detect_jan)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find installed local-model runners.",
    )
    parser.add_argument(
        "--probe-host", default=None,
        help=("Hostname/IP to probe for runners (default: localhost). On WSL2 "
              "the agent may pass the Windows host IP so LM Studio installs "
              "running on the Windows side are visible."),
    )
    parser.add_argument(
        "--include-wsl2-host", action="store_true",
        help=("On WSL2, ALSO probe the Windows host IP (derived from "
              "/etc/resolv.conf) and merge results. No effect off WSL2."),
    )
    args = parser.parse_args()

    primary_host = args.probe_host or "localhost"
    runners = []
    hosts = [primary_host]
    if args.include_wsl2_host:
        wsl_host = wsl2_host_ip()
        if wsl_host and wsl_host not in hosts:
            hosts.append(wsl_host)

    for host in hosts:
        for fn in DETECTORS:
            try:
                r = fn(probe_host=host)
            except (URLError, HTTPError, TimeoutError, socket.timeout, OSError, json.JSONDecodeError) as e:
                # Narrow the catch — the previous bare `except Exception:`
                # mapped genuine bugs to "warn: <fn> crashed" which the
                # outer agent never read. The classes above cover the
                # legitimate "service not present / unparseable response"
                # cases per fail-fast: real bugs propagate to the user.
                print(f"warn: {fn.__name__}@{host} crashed: {type(e).__name__}: {e}", file=sys.stderr)
                continue
            if r is not None:
                runners.append(r)

    json.dump({"runners": runners}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
