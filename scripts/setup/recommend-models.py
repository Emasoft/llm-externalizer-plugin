#!/usr/bin/env python3
# Copyright (c) 2025 Emasoft
# SPDX-License-Identifier: MIT
"""
Recommend locally runnable coding LLMs for the current computer.

This script is aimed at non-expert users. With no options it will:
  1. detect the user's hardware;
  2. fetch coding-oriented, self-hostable model benchmark data from Onyx;
  3. consult whatcani.run's public featured-model API for empirical local
     runtime/quantization evidence when available;
  4. conservatively recommend compatible local models for programming work.

The script is intentionally stdlib-only.

Upstream: local_llm_coding_recommender.py (author's private working repo)
Upstream version vendored: 2.19.1-artifact-param-fix
Local adaptations from upstream (kept minimal so future re-syncs stay easy):
  1. `default_cache_dir()` returns `$CLAUDE_PLUGIN_DATA/setup/cache/` when the
     plugin sets that env var (Claude Code does, automatically). Standalone
     invocations keep the upstream XDG / macOS-Caches / LOCALAPPDATA paths.
  2. `default_log_path()` returns `$CLAUDE_PLUGIN_DATA/setup/logs/recommender.log`
     when CLAUDE_PLUGIN_DATA is set; rotation behavior is unchanged.
  3. `--context-tokens` default raised from 16384 to 32768 to match this
     plugin's hard compatibility threshold (any model recommended here must
     handle ≥32K context for scan_folder / code_task to fit useful inputs).
  4. `--limit` default lowered from 20 to 10 to keep the setup-wizard menu
     scannable on one screen.

Re-sync procedure: copy the upstream file over this one, then re-apply the
four blocks above (each is single-function-scoped; greppable by the comment
"Plugin integration:" inserted next to each adaptation).

Version 2.19.1 (upstream) changes: fixes artifact parameter extraction for names such as Qwen3.5-27B so the size is 27B rather than 3.527B, keeps the anchored Onyx parser, and ranks same-family artifact backfills by parameter count after coding/fit score.
"""

from __future__ import annotations

import argparse
import ctypes
import dataclasses
import html
import json
import logging
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Iterable

ONYX_SELF_HOSTED_URL = "https://onyx.app/self-hosted-llm-leaderboard"
WHATCANIRUN_FEATURED_URL = "https://whatcani.run/api/v0/featured"
SCRIPT_VERSION = "2.19.1-artifact-param-fix"
# Plugin integration: schema version for the --json output shape. The setup
# agent checks `payload.schema_version == RECOMMEND_MODELS_SCHEMA_VERSION` before
# consuming the recommendations[] array; if upstream re-syncs change a field
# name without bumping this version, the agent falls back to manual-name entry
# rather than silently rendering "None" or zero scores.
RECOMMEND_MODELS_SCHEMA_VERSION = 1
# Plugin integration: cap on the body size of any single HTTP fetch. Without
# this an attacker on the network path (or a compromised Onyx/whatcani.run
# mirror) could return a multi-GB response and OOM-kill the wizard.
MAX_FETCH_BODY_BYTES = 50 * 1024 * 1024  # Onyx HTML is ~1 MB; 50× is plenty.
USER_AGENT = f"local-llm-coding-recommender/{SCRIPT_VERSION} (+https://openai.com)"
# whatcani.run /api/v0/featured is a cached API route. The upstream
# source currently accepts runtime/cpu/gpu/gpuCount/ramGb/osName/limit and
# revalidates results every hour. Keep our local cache aligned with that.
WHATCANIRUN_CACHE_TTL_SECONDS = 60 * 60
DEFAULT_NETWORK_RETRIES = 3
DEFAULT_RETRY_DELAY_SECONDS = 1.0
DEFAULT_FETCH_TIMEOUT_SECONDS = 30.0
DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024
DEFAULT_LOG_BACKUP_COUNT = 3

BENCHMARK_COLUMNS = (
    "MMLU-Pro",
    "GPQA Diamond",
    "IFEval",
    "Chatbot Arena",
    "SWE-bench Verified",
    "HumanEval",
    "LiveCodeBench",
    "AIME 2025",
    "MATH-500",
)

TABLE_HEADER = (
    "Model",
    "Params",
    "Context",
    "License",
    "VRAM (INT4)",
    "VRAM (FP16)",
    *BENCHMARK_COLUMNS,
)

PERMISSIVE_LICENSE_KEYWORDS = (
    "mit",
    "apache",
    "bsd",
    "openrail",
    "cc-by",
)

NONCOMMERCIAL_LICENSE_KEYWORDS = (
    "non-commercial",
    "noncommercial",
    "cc-by-nc",
    "cc by nc",
    "research only",
)

CODING_BENCHMARK_WEIGHTS = {
    "livecodebench": 0.38,
    "swe_bench_verified": 0.32,
    "humaneval": 0.20,
    "gpqa_diamond": 0.05,
    "mmlu_pro": 0.05,
}


# Map of model-name prefix to the original training/release brand. Used when
# the recommender synthesizes a row from whatcani.run artifact backfill: the
# artifact repo creator (mlx-community, unsloth, bartowski, mradermacher,
# TheBloke, …) is the *quantization* publisher, NOT the model creator. The
# `provider` field on a `ModelRecord` is meant for the team that trained the
# weights. Lookup is by hyphen-token prefix match (case-insensitive); order
# matters because longer / more specific prefixes must be tried before
# shorter ones (e.g. ``meta-llama`` before bare ``meta``).
BRAND_PROVIDER_PREFIXES: tuple[tuple[str, str], ...] = (
    # Longer / more specific prefixes first.
    ("meta-llama",      "Meta"),
    ("ds-r1",           "DeepSeek"),
    ("deepseek-coder",  "DeepSeek"),
    ("deepseek",        "DeepSeek"),
    # Shorter prefixes after.
    ("llama",           "Meta"),
    ("qwen",            "Alibaba"),
    ("gemma",           "Google"),
    ("phi",             "Microsoft"),
    ("mistral",         "Mistral AI"),
    ("mixtral",         "Mistral AI"),
    ("codestral",       "Mistral AI"),
    ("devstral",        "Mistral AI"),
    ("ministral",       "Mistral AI"),
    ("granite",         "IBM"),
    ("nemotron",        "NVIDIA"),
    ("yi",              "01.AI"),
    ("chatglm",         "Zhipu AI"),
    ("glm",             "Zhipu AI"),
    ("falcon",          "TII"),
    ("kimi",            "Moonshot AI"),
    ("minimax",         "MiniMax"),
    ("olmo",            "Allen Institute (AI2)"),
    ("tulu",            "Allen Institute (AI2)"),
    ("command",         "Cohere"),
    ("aya",             "Cohere"),
    ("smollm",          "Hugging Face"),
    ("smol",            "Hugging Face"),
    ("starcoder",       "BigCode"),
    ("openchat",        "OpenChat"),
    ("internlm",        "Shanghai AI Lab"),
    ("baichuan",        "Baichuan"),
)


def infer_provider_from_name(name: str | None) -> str | None:
    """Best-effort guess of a model's original creator from its name prefix.

    Returns None when no brand prefix in :data:`BRAND_PROVIDER_PREFIXES`
    matches. Quantization-creator names (mlx-community, unsloth, bartowski,
    mradermacher, TheBloke) are deliberately NOT in the map: those are the
    repacking publishers, not the model creators.

    Why this matters: a synthesized ModelRecord built purely from
    whatcani.run evidence has no Onyx ``Provider`` column to fall back on,
    and ``QuantizedArtifact.creator`` (the repo namespace) is the wrong
    field to copy because it reflects the quantization publisher.
    """
    if not name:
        return None
    lowered = name.lower().lstrip("-_ ").strip()
    if not lowered:
        return None
    for prefix, brand in BRAND_PROVIDER_PREFIXES:
        # Require a word-boundary after the prefix — bare `startswith` would
        # match `phidias-xxx` against the `phi` prefix and mis-tag it as
        # Microsoft. Acceptable boundaries: end-of-string, `-`, `_`, or a
        # digit (so `phi3` still matches `phi`).
        if lowered == prefix:
            return brand
        if lowered.startswith(prefix):
            next_char = lowered[len(prefix):len(prefix) + 1]
            if next_char in {"-", "_", "/", "."} or next_char.isdigit():
                return brand
    return None


@dataclasses.dataclass(frozen=True)
class HardwareProfile:
    os_name: str
    machine: str
    cpu: str
    ram_gb: float
    gpu_names: list[str]
    gpu_vram_gb: float
    largest_single_gpu_vram_gb: float
    total_gpu_vram_gb: float
    gpu_count: int
    backend_hints: list[str]
    unified_memory: bool


@dataclasses.dataclass(frozen=True)
class ModelRecord:
    name: str
    provider: str | None
    params: str | None
    params_b: float | None
    context: str | None
    context_tokens: int | None
    license: str | None
    vram_int4_gb: float | None
    vram_fp16_gb: float | None
    mmlu_pro: float | None
    gpqa_diamond: float | None
    ifeval: float | None
    chatbot_arena: float | None
    swe_bench_verified: float | None
    humaneval: float | None
    livecodebench: float | None
    aime_2025: float | None
    math_500: float | None
    source_url: str
    source: str


@dataclasses.dataclass(frozen=True)
class WhatCanIRunEvidence:
    display_name: str | None
    hf_repo_id: str | None
    hf_file_name: str | None
    runtime: str | None
    file_size_gb: float | None
    device_types: list[str]
    model_ref: str | None
    minimum_distinct_devices: int | None
    minimum_runs_per_device: int | None
    priority: int | None
    # raw used to hold the entire upstream featured-model dict for debug
    # logging. That dict flowed through dataclasses.asdict() into the agent's
    # JSON context — an indirect prompt-injection surface (any attacker-
    # controllable field would land in the LLM's working prompt). The field
    # is now retained only as a placeholder set to None at extraction time;
    # downstream consumers (dataclasses.asdict in recommendation_to_dict)
    # surface only the named parsed fields, not the raw upstream object.
    raw: dict[str, Any] | None


@dataclasses.dataclass(frozen=True)
class QuantizedArtifact:
    model_name: str
    creator: str
    quantization: str
    format: str
    runtime: str | None
    hf_repo_id: str
    hf_file_name: str | None
    display_name: str | None
    file_size_gb: float | None
    device_types: list[str]
    url: str
    download_command: str


@dataclasses.dataclass(frozen=True)
class Recommendation:
    model: ModelRecord
    compatible: bool
    run_status: str
    memory_basis: str
    available_memory_gb: float
    estimated_required_gb: float | None
    headroom_gb: float | None
    headroom_ratio: float | None
    coding_score: float
    final_score: float
    whatcanirun: WhatCanIRunEvidence | None
    whatcanirun_matches: list[WhatCanIRunEvidence]
    notes: list[str]


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        cleaned = " ".join(data.split())
        if cleaned:
            self.parts.append(cleaned)

    def texts(self) -> list[str]:
        return [html.unescape(part).strip() for part in self.parts if part.strip()]


def validate_http_url(url: str, *, option_name: str = "url") -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{option_name} must be an http(s) URL, got: {url!r}")
    return url


def fetch_text(
    url: str,
    timeout: float = DEFAULT_FETCH_TIMEOUT_SECONDS,
    retries: int = DEFAULT_NETWORK_RETRIES,
    retry_delay: float = DEFAULT_RETRY_DELAY_SECONDS,
) -> str:
    """Fetch text with bounded retries, explicit timeouts, and diagnostics."""
    validate_http_url(url)
    last_error: BaseException | None = None
    attempts = max(1, int(retries))
    for attempt in range(1, attempts + 1):
        started = time.time()
        try:
            logging.info("fetch_attempt url=%s attempt=%d/%d timeout=%s", url, attempt, attempts, timeout)
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                charset_header = response.headers.get_content_charset() or "utf-8"
                # Pin to a small allow-list — an attacker-controlled
                # Content-Type can request exotic codecs (`base64_codec`,
                # `rot_13`, `hex_codec`) that mangle the content while still
                # decoding "successfully". Anything outside this whitelist
                # falls back to utf-8.
                if charset_header.lower() in {"utf-8", "utf8", "ascii", "latin-1", "iso-8859-1", "windows-1252"}:
                    charset = charset_header
                else:
                    charset = "utf-8"
                status = getattr(response, "status", 200)
                if isinstance(status, int) and status >= 400:
                    raise urllib.error.HTTPError(url, status, f"HTTP {status}", response.headers, None)
                # Bounded read — read MAX_FETCH_BODY_BYTES + 1 to detect overrun
                # without buffering the whole oversized body. Onyx HTML is ~1 MB,
                # whatcani.run JSON is smaller; 50 MB ceiling is generous yet
                # prevents a hostile mirror / MITM from OOM-killing the wizard.
                raw = response.read(MAX_FETCH_BODY_BYTES + 1)
                if len(raw) > MAX_FETCH_BODY_BYTES:
                    raise RuntimeError(
                        f"response from {url} exceeds {MAX_FETCH_BODY_BYTES} bytes "
                        "(refusing to buffer oversized payload)"
                    )
                text = raw.decode(charset, errors="replace")
                logging.info(
                    "fetch_success url=%s attempt=%d status=%s bytes=%d elapsed=%.2fs",
                    url,
                    attempt,
                    status,
                    len(text.encode("utf-8", errors="replace")),
                    time.time() - started,
                )
                return text
        except (urllib.error.URLError, TimeoutError, OSError, UnicodeError) as exc:
            last_error = exc
            logging.warning("fetch_failure url=%s attempt=%d/%d error=%r", url, attempt, attempts, exc)
            if attempt < attempts:
                sleep_for = max(0.0, retry_delay) * attempt
                logging.debug("fetch_retry_sleep_seconds=%.2f", sleep_for)
                time.sleep(sleep_for)
    assert last_error is not None
    raise last_error


def fetch_json(
    url: str,
    timeout: float = DEFAULT_FETCH_TIMEOUT_SECONDS,
    retries: int = DEFAULT_NETWORK_RETRIES,
    retry_delay: float = DEFAULT_RETRY_DELAY_SECONDS,
) -> Any:
    text = fetch_text(url, timeout=timeout, retries=retries, retry_delay=retry_delay)
    try:
        payload = json.loads(text)
        logging.info("json_parse_success url=%s top_level=%s", url, type(payload).__name__)
        return payload
    except json.JSONDecodeError as exc:
        logging.warning("json_parse_failure url=%s error=%r prefix=%r", url, exc, text[:300])
        raise


def expand_path(path: str | os.PathLike[str]) -> Path:
    """Return an absolute, user-expanded Path without requiring it to exist."""
    return Path(path).expanduser().resolve()


def atomic_write_text(path: str | os.PathLike[str], text: str) -> None:
    """Atomically write text to a file in the target directory.

    Cache files are read by later runs, so partial writes caused by a crash or
    interrupted download are worse than a stale cache.  Write to a temporary file
    in the same directory and replace the target only after the full payload is
    flushed.  Path.replace() is atomic on normal local filesystems.
    """
    target = expand_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        temp_path.replace(target)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def save_json(path: str | os.PathLike[str], value: Any) -> None:
    atomic_write_text(path, json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def load_json(path: str | os.PathLike[str]) -> Any:
    with expand_path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def default_cache_dir() -> Path:
    # Plugin integration: when running inside the llm-externalizer setup wizard,
    # $CLAUDE_PLUGIN_DATA is set by Claude Code to a persistent per-plugin data
    # directory that survives plugin updates. Co-locating the recommender cache
    # under setup/cache lets the agent's other state files (env.json,
    # runners.json, test-results.json) live in the same root and survive the
    # same lifecycle. Fall back to the upstream cache paths when run standalone.
    # Strip first — a whitespace-only env var is truthy in Python but Path(" ")
    # resolves to a literal " " directory in CWD that the user can never find.
    plugin_data = (os.environ.get("CLAUDE_PLUGIN_DATA") or "").strip()
    if plugin_data:
        return Path(plugin_data) / "setup" / "cache"
    if platform.system() == "Windows":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "local-llm-coding-recommender"
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Caches" / "local-llm-coding-recommender"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "local-llm-coding-recommender"


def _validate_cache_path(value: str | None, *, option_name: str) -> None:
    """Refuse cache-arg paths that escape the plugin's cache root.

    When the plugin sets CLAUDE_PLUGIN_DATA, the wizard's cache lives under
    `$CLAUDE_PLUGIN_DATA/setup/cache/`. Any other path passed via
    `--from-cache`, `--save-cache`, `--whatcanirun-cache`,
    `--whatcanirun-from-cache`, or `--save-whatcanirun-cache` would either
    leak a JSON read of a sensitive file (e.g. `~/.ssh/id_rsa`) or overwrite
    user-owned content (`~/.zshrc`). Plugin-mode users always go through the
    agent; the agent always passes paths under `default_cache_dir()`.

    Standalone CLI users (no CLAUDE_PLUGIN_DATA) keep the wide-open behaviour
    so existing workflows don't break. Plugin mode wins on safety.
    """
    if not value:
        return
    if not (os.environ.get("CLAUDE_PLUGIN_DATA") or "").strip():
        return  # standalone CLI — no confinement
    allowed_root = default_cache_dir().resolve()
    requested = expand_path(value).resolve()
    try:
        requested.relative_to(allowed_root)
    except ValueError as exc:
        raise ValueError(
            f"{option_name}={value!s} escapes the plugin cache root "
            f"({allowed_root!s}); path traversal refused"
        ) from exc


def default_log_path() -> str:
    # Plugin integration: when CLAUDE_PLUGIN_DATA is set, put the rotating log
    # under setup/logs/ (sibling to setup/cache/) so the agent's state tree is
    # discoverable as one subtree. Upstream default is preserved for standalone.
    plugin_data = (os.environ.get("CLAUDE_PLUGIN_DATA") or "").strip()
    if plugin_data:
        return str(Path(plugin_data) / "setup" / "logs" / "recommender.log")
    return str(default_cache_dir() / "last-run.log")


def setup_logging(log_path: str | None, max_bytes: int = DEFAULT_LOG_MAX_BYTES, backup_count: int = DEFAULT_LOG_BACKUP_COUNT) -> str | None:
    """Configure a rotating diagnostic log and return the path in use.

    The log is opened before hardware probing or network I/O so failures have a
    shareable trace.  A size-based RotatingFileHandler prevents repeated runs
    from growing one unbounded log forever.  If the platform cache directory is
    not writable, fall back to the current directory and record that fact.
    """
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()
    if not log_path:
        root.addHandler(logging.NullHandler())
        root.setLevel(logging.CRITICAL + 1)
        return None

    requested_path = expand_path(log_path)
    fallback_path = expand_path("local_llm_coding_recommender-last-run.log")
    last_error: BaseException | None = None

    for candidate in (requested_path, fallback_path):
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            # Touch a header immediately so users have a file even if a later
            # early-exit path happens before logging emits its first record.
            with candidate.open("a", encoding="utf-8") as handle:
                handle.write("\n--- local-llm-coding-recommender run start ---\n")
                handle.write(f"script_version={SCRIPT_VERSION}\n")
                handle.write(f"path={candidate}\n")
                if candidate != requested_path:
                    handle.write(f"requested_path={requested_path}\n")
                    handle.write(f"fallback_reason={last_error!r}\n")
            handler = RotatingFileHandler(
                candidate,
                mode="a",
                maxBytes=max(0, int(max_bytes)),
                backupCount=max(0, int(backup_count)),
                encoding="utf-8",
            )
            handler.setLevel(logging.DEBUG)
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            root.addHandler(handler)
            root.setLevel(logging.DEBUG)
            logging.info("diagnostic logging active")
            logging.info("diagnostic_log=%s", candidate)
            logging.info("log_rotation max_bytes=%d backup_count=%d", max_bytes, backup_count)
            logging.info("logging_levels_enabled=DEBUG,INFO,WARNING,ERROR,CRITICAL")
            logging.debug("debug logging is active")
            if candidate != requested_path:
                logging.warning("using fallback diagnostic log path; requested_path=%s error=%r", requested_path, last_error)
            return str(candidate)
        except OSError as exc:
            last_error = exc

    # Both candidate paths failed — logging is permanently disabled for this
    # run. Surface the failure to stderr so the user can correct the path
    # (writable cache dir, $CLAUDE_PLUGIN_DATA pointed at a read-only mount,
    # etc.) instead of silently losing diagnostics they explicitly requested.
    print(
        f"warn: diagnostic logging disabled — could not open requested={requested_path!s} "
        f"or fallback={fallback_path!s} (last error: {last_error!r})",
        file=sys.stderr,
    )
    root.addHandler(logging.NullHandler())
    root.setLevel(logging.CRITICAL + 1)
    return None


_SENSITIVE_KEY_SUBSTRINGS = (
    "api_key", "apikey", "token", "secret", "password", "auth", "authorization",
    "bearer", "credential",
)


def safe_args_for_log(args: argparse.Namespace) -> dict[str, Any]:
    """Return a copy of args with values for sensitive-named keys redacted.

    Despite the name, the previous implementation was identical to vars(args)
    — affirmatively misleading for future maintainers. If a future re-sync
    from upstream adds e.g. --hf-token or --whatcanirun-api-key, this function
    now redacts the value before it lands in the rotating diag log.
    """
    redacted: dict[str, Any] = {}
    for key, value in sorted(vars(args).items()):
        if any(substr in key.lower() for substr in _SENSITIVE_KEY_SUBSTRINGS):
            redacted[key] = "[REDACTED]"
        else:
            redacted[key] = value
    return redacted


def safe_argv_for_log(argv: list[str]) -> list[str]:
    """Return a copy of argv with values for sensitive-named flags redacted.

    Handles both `--api-key VALUE` (two tokens) and `--api-key=VALUE` (one
    token). Mirrors safe_args_for_log so direct sys.argv logging stays safe
    if a future upstream re-sync adds secret-bearing flags.
    """
    cleaned: list[str] = []
    mask_next = False
    for token in argv:
        if mask_next:
            cleaned.append("[REDACTED]")
            mask_next = False
            continue
        lower = token.lower()
        if token.startswith("--") and "=" in token:
            flag_name, _, _ = token.partition("=")
            if any(substr in flag_name.lower() for substr in _SENSITIVE_KEY_SUBSTRINGS):
                cleaned.append(f"{flag_name}=[REDACTED]")
                continue
        if token.startswith("--") and any(substr in lower for substr in _SENSITIVE_KEY_SUBSTRINGS):
            cleaned.append(token)
            mask_next = True
            continue
        cleaned.append(token)
    return cleaned


def write_success_diagnostic_log(
    *,
    args: argparse.Namespace,
    log_path: str,
    hardware: HardwareProfile,
    models: list[ModelRecord],
    evidences: list[WhatCanIRunEvidence],
    recommendations: list[Recommendation],
    whatcanirun_source: str | None,
    whatcanirun_error: str | None,
    whatcanirun_diagnostics: dict[str, Any] | None = None,
) -> None:
    compatible = [item for item in recommendations if item.compatible]
    logging.info("local-llm-coding-recommender run completed")
    logging.debug("success diagnostic summary start")
    logging.info("script_version=%s", SCRIPT_VERSION)
    logging.info("python=%s", sys.version.replace("\n", " "))
    logging.info("platform=%s", platform.platform())
    logging.info("argv=%s", json.dumps(safe_argv_for_log(sys.argv), ensure_ascii=False))
    logging.info("options=%s", json.dumps(safe_args_for_log(args), ensure_ascii=False, sort_keys=True))
    logging.info("hardware=%s", json.dumps(dataclasses.asdict(hardware), ensure_ascii=False, sort_keys=True))
    logging.info("models_loaded=%d", len(models))
    logging.info("whatcanirun_source=%s", whatcanirun_source or "not used")
    logging.info("whatcanirun_evidence_count=%d", len(evidences))
    if whatcanirun_diagnostics is not None:
        logging.info("whatcanirun_diagnostics=%s", json.dumps(whatcanirun_diagnostics, ensure_ascii=False, sort_keys=True))
    if whatcanirun_error:
        logging.warning("whatcanirun_error=%s", whatcanirun_error)
    logging.info("recommendations_total=%d compatible=%d", len(recommendations), len(compatible))
    for rank, item in enumerate(recommendations[: min(len(recommendations), args.limit)], start=1):
        logging.info(
            "recommendation_%02d=%s",
            rank,
            json.dumps(recommendation_to_dict(item), ensure_ascii=False, sort_keys=True),
        )
    logging.info("diagnostic_log=%s", os.path.abspath(log_path))


def write_error_diagnostic_log(*, args: argparse.Namespace, log_path: str, error: BaseException) -> None:
    logging.exception("local-llm-coding-recommender failed: %s", error)
    logging.info("script_version=%s", SCRIPT_VERSION)
    logging.info("python=%s", sys.version.replace("\n", " "))
    logging.info("platform=%s", platform.platform())
    logging.info("argv=%s", json.dumps(safe_argv_for_log(sys.argv), ensure_ascii=False))
    logging.info("options=%s", json.dumps(safe_args_for_log(args), ensure_ascii=False, sort_keys=True))
    logging.info("diagnostic_log=%s", os.path.abspath(log_path))


def parse_numeric(value: str | None) -> float | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped or stripped.upper() == "N/A":
        return None
    keep: list[str] = []
    decimal_seen = False
    sign_allowed = True
    for char in stripped:
        if char.isdigit():
            keep.append(char)
            sign_allowed = False
        elif char == "." and not decimal_seen:
            keep.append(char)
            decimal_seen = True
            sign_allowed = False
        elif char == "-" and sign_allowed:
            keep.append(char)
            sign_allowed = False
    if not keep or keep == ["-"]:
        return None
    try:
        return float("".join(keep))
    except ValueError:
        return None


def parse_gb(value: str | None) -> float | None:
    return parse_numeric(value)


def parse_params_b(value: str | None) -> float | None:
    if value is None:
        return None
    stripped = value.strip().upper().replace(",", "")
    number = parse_numeric(stripped)
    if number is None:
        return None
    if "T" in stripped:
        return number * 1000.0
    if "M" in stripped and "B" not in stripped:
        return number / 1000.0
    return number


def parse_context_tokens(value: str | None) -> int | None:
    if value is None:
        return None
    stripped = value.strip().upper().replace(",", "")
    number = parse_numeric(stripped)
    if number is None:
        return None
    if "M" in stripped:
        return int(number * 1_000_000)
    if "K" in stripped:
        return int(number * 1_000)
    return int(number)


def onyx_texts_from_html(page_html: str) -> list[str]:
    parser = TextExtractor()
    parser.feed(page_html)
    return parser.texts()


def equivalent_header(left: str, right: str) -> bool:
    return normalize_identifier(left) == normalize_identifier(right)


def find_header_position(texts: list[str], start: int, header: tuple[str, ...]) -> int | None:
    for index in range(start, len(texts) - len(header)):
        window = texts[index : index + len(header)]
        if all(equivalent_header(a, b) for a, b in zip(window, header, strict=True)):
            return index + len(header)
    return None


def slice_onyx_table_texts(texts: list[str]) -> list[str]:
    start = 0
    for index, text in enumerate(texts):
        lowered = text.lower()
        if "self-hosted" in lowered and "hardware requirements" in lowered:
            start = index
            break
    header_start = find_header_position(texts, start, TABLE_HEADER)
    if header_start is None:
        raise RuntimeError("Could not locate the Onyx self-hosted benchmark table header")
    end_markers = {
        "Compare Self-Hosted LLMs Head-to-Head",
        "Compare Open Source LLMs Head-to-Head",
        "Try These Open Source Models in Onyx",
    }
    for index in range(header_start, len(texts)):
        if texts[index] in end_markers:
            return texts[header_start:index]
    return texts[header_start:]


def make_onyx_record(values: dict[str, str]) -> ModelRecord:
    return ModelRecord(
        name=values.get("Model", ""),
        provider=values.get("Provider"),
        params=values.get("Params"),
        params_b=parse_params_b(values.get("Params")),
        context=values.get("Context"),
        context_tokens=parse_context_tokens(values.get("Context")),
        license=values.get("License"),
        vram_int4_gb=parse_gb(values.get("VRAM (INT4)")),
        vram_fp16_gb=parse_gb(values.get("VRAM (FP16)")),
        mmlu_pro=parse_numeric(values.get("MMLU-Pro")),
        gpqa_diamond=parse_numeric(values.get("GPQA Diamond")),
        ifeval=parse_numeric(values.get("IFEval")),
        chatbot_arena=parse_numeric(values.get("Chatbot Arena")),
        swe_bench_verified=parse_numeric(values.get("SWE-bench Verified")),
        humaneval=parse_numeric(values.get("HumanEval")),
        livecodebench=parse_numeric(values.get("LiveCodeBench")),
        aime_2025=parse_numeric(values.get("AIME 2025")),
        math_500=parse_numeric(values.get("MATH-500")),
        source_url=ONYX_SELF_HOSTED_URL,
        source="Onyx Self-Hosted LLM Leaderboard",
    )


def parse_onyx_models(page_html: str) -> list[ModelRecord]:
    """Parse the Onyx benchmark table with an anchored row scanner.

    Onyx's rendered HTML currently exposes the visible header without a
    Provider column, but each data row includes Provider immediately after
    Model. Older versions of this script tried to pick between fixed-width
    parses by score; that can silently lose whole model families when the page
    adds/removes small text nodes. The row scanner below is stricter: a row is
    accepted only when the cells around a candidate row start look like
    Model/Provider/Params/Context/License/VRAM/VRAM/benchmarks. This preserves
    recent families such as Qwen while rejecting navigation/footer text.
    """
    texts = onyx_texts_from_html(page_html)
    logging.info("onyx_text_extraction_success text_count=%d", len(texts))
    cells = slice_onyx_table_texts(texts)
    logging.info("onyx_table_slice_success cell_count=%d", len(cells))

    with_provider = ("Model", "Provider", "Params", "Context", "License", "VRAM (INT4)", "VRAM (FP16)", *BENCHMARK_COLUMNS)
    without_provider = TABLE_HEADER

    def row_record(row: list[str], header: tuple[str, ...]) -> ModelRecord | None:
        try:
            values = dict(zip(header, row, strict=True))
        except ValueError:
            return None
        record = make_onyx_record(values)
        return record if plausible_onyx_record(record) else None

    candidates: list[tuple[str, list[ModelRecord]]] = []

    # Primary parser: scan every possible row start, but only accept windows
    # whose typed fields are plausible. Then jump by the row width so duplicated
    # overlapping windows do not swamp the result.
    for method_name, header in (("anchored_provider_scan", with_provider), ("anchored_no_provider_scan", without_provider)):
        width = len(header)
        parsed: list[ModelRecord] = []
        seen: set[str] = set()
        index = 0
        while index <= len(cells) - width:
            record = row_record(cells[index:index + width], header)
            if record is not None and record.name not in seen:
                parsed.append(record)
                seen.add(record.name)
                index += width
            else:
                index += 1
        logging.info(
            "onyx_parse_attempt method=%s width=%d parsed=%d sample=%s qwen_sample=%s",
            method_name,
            width,
            len(parsed),
            [item.name for item in parsed[:6]],
            [item.name for item in parsed if "qwen" in item.name.lower()][:10],
        )
        candidates.append((method_name, parsed))

    # Secondary parser: fixed rows are faster and useful for diagnostics. Keep it
    # but never let it replace a better anchored parse unless its quality wins.
    for method_name, header in (("fixed_provider_rows", with_provider), ("fixed_no_provider_rows", without_provider)):
        width = len(header)
        parsed = []
        for row_start in range(0, len(cells) - width + 1, width):
            record = row_record(cells[row_start:row_start + width], header)
            if record is not None:
                parsed.append(record)
        logging.info("onyx_parse_attempt method=%s width=%d parsed=%d sample=%s", method_name, width, len(parsed), [item.name for item in parsed[:6]])
        candidates.append((method_name, parsed))

    scored_candidates = []
    for method_name, parsed in candidates:
        score = onyx_parse_quality_score(parsed)
        # Heavily prefer parses that recover the currently-visible Qwen family;
        # a parse that drops Qwen is almost certainly misaligned or stale.
        if any("qwen" in record.name.lower() for record in parsed):
            score += 0.20
        scored_candidates.append((score, method_name, parsed))
        logging.info("onyx_parse_quality method=%s score=%.3f parsed=%d sample=%s qwen=%s", method_name, score, len(parsed), [item.name for item in parsed[:6]], [item.name for item in parsed if "qwen" in item.name.lower()][:10])

    best_score, best_method, best = max(scored_candidates, key=lambda item: item[0])
    logging.info("onyx_parse_selected method=%s score=%.3f parsed=%d qwen=%s", best_method, best_score, len(best), [item.name for item in best if "qwen" in item.name.lower()][:20])
    return best


def plausible_onyx_record(record: ModelRecord) -> bool:
    if not record.name or record.name.upper() == "N/A":
        return False
    if record.params_b is None or record.params_b <= 0 or record.params_b > 3000:
        return False
    if record.context_tokens is None or record.context_tokens < 1000 or record.context_tokens > 20_000_000:
        return False
    if record.license is None or parse_gb(record.license) is not None:
        return False
    if record.vram_int4_gb is None or record.vram_int4_gb <= 0 or record.vram_int4_gb > 2500:
        return False
    if record.vram_fp16_gb is not None and record.vram_fp16_gb < record.vram_int4_gb:
        return False
    benchmark_values = [
        record.mmlu_pro,
        record.gpqa_diamond,
        record.ifeval,
        record.swe_bench_verified,
        record.humaneval,
        record.livecodebench,
        record.aime_2025,
        record.math_500,
    ]
    for value in benchmark_values:
        if value is not None and (value < 0 or value > 100):
            return False
    if record.chatbot_arena is not None and not (500 <= record.chatbot_arena <= 2500):
        return False
    return True


def onyx_parse_quality_score(records: list[ModelRecord]) -> float:
    if not records:
        return 0.0
    plausible = [record for record in records if plausible_onyx_record(record)]
    if not plausible:
        return 0.0
    names = [record.name for record in plausible]
    unique_name_count = len(set(names))
    uniqueness = unique_name_count / max(1, len(names))
    benchmark_density = sum(
        1
        for record in plausible
        if any(
            value is not None
            for value in (
                record.swe_bench_verified,
                record.humaneval,
                record.livecodebench,
                record.mmlu_pro,
                record.gpqa_diamond,
            )
        )
    ) / max(1, len(plausible))
    provider_density = sum(1 for record in plausible if record.provider and record.provider.upper() != "N/A") / max(1, len(plausible))
    plausibility_ratio = len(plausible) / max(1, len(records))
    # Count matters, but not enough to let a sliding-window false-positive parse
    # beat a smaller fixed-width parse with coherent columns.
    count_component = min(len(plausible), 80) / 80.0
    return (
        0.34 * plausibility_ratio
        + 0.24 * uniqueness
        + 0.18 * benchmark_density
        + 0.14 * provider_density
        + 0.10 * count_component
    )


def model_to_dict(model: ModelRecord) -> dict[str, Any]:
    return dataclasses.asdict(model)


def model_from_dict(value: dict[str, Any]) -> ModelRecord:
    return ModelRecord(**value)


def run_command(args: list[str], timeout: float = 5.0) -> str | None:
    if not args or shutil.which(args[0]) is None:
        return None
    try:
        completed = subprocess.run(args, check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip()


def detect_total_ram_gb() -> float:
    if platform.system() == "Windows":
        class MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        status = MemoryStatusEx()
        status.dwLength = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]  # pyright: ignore[reportAttributeAccessIssue]  # ctypes.windll is Windows-only; guarded above by platform.system() == "Windows"
            return status.ullTotalPhys / 1024**3
    if platform.system() == "Darwin":
        sysctl = run_command(["sysctl", "-n", "hw.memsize"])
        if sysctl and sysctl.isdigit():
            return int(sysctl) / 1024**3
    if hasattr(os, "sysconf"):
        names = os.sysconf_names
        if "SC_PAGE_SIZE" in names and "SC_PHYS_PAGES" in names:
            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
    return 0.0


def detect_nvidia() -> tuple[list[str], float, float, int]:
    output = run_command(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    if not output:
        return [], 0.0, 0.0, 0
    names: list[str] = []
    per_gpu: list[float] = []
    for line in output.splitlines():
        pieces = [piece.strip() for piece in line.split(",")]
        if len(pieces) >= 2:
            names.append(pieces[0])
            try:
                per_gpu.append(float(pieces[1]) / 1024.0)
            except ValueError:
                pass
    return names, max(per_gpu, default=0.0), sum(per_gpu), len(per_gpu)


def detect_amd_rocm() -> tuple[list[str], float, float, int]:
    names: list[str] = []
    per_gpu: list[float] = []
    output = run_command(["rocm-smi", "--showproductname", "--showmeminfo", "vram"], timeout=8.0)
    if not output:
        return names, 0.0, 0.0, 0
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if "Card series:" in line or "Card model:" in line:
            names.append(line.split(":", 1)[-1].strip())
        lowered = line.lower()
        if "total memory" in lowered or "vram total memory" in lowered:
            number = parse_numeric(line)
            if number is not None:
                if "mb" in lowered or "mib" in lowered:
                    per_gpu.append(number / 1024.0)
                elif "gb" in lowered or "gib" in lowered:
                    per_gpu.append(number)
                else:
                    per_gpu.append(number / 1024**3)
    return names, max(per_gpu, default=0.0), sum(per_gpu), len(per_gpu)


def detect_apple_gpu() -> tuple[list[str], bool]:
    if platform.system() != "Darwin":
        return [], False
    machine = platform.machine().lower()
    processor = platform.processor().lower()
    is_apple_silicon = machine == "arm64" or "arm" in processor
    if not is_apple_silicon:
        return [], False
    brand = run_command(["sysctl", "-n", "machdep.cpu.brand_string"]) or "Apple Silicon"
    return [brand], True


def detect_lspci_gpus() -> list[str]:
    output = run_command(["lspci"])
    if not output:
        return []
    names = []
    for line in output.splitlines():
        lowered = line.lower()
        if "vga compatible controller" in lowered or "3d controller" in lowered:
            names.append(line.split(":", 2)[-1].strip())
    return names


def detect_hardware(assume_ram_gb: float | None, assume_vram_gb: float | None, allow_multi_gpu: bool) -> HardwareProfile:
    os_name = platform.system() or sys.platform
    machine = platform.machine()
    cpu = platform.processor() or platform.machine()
    ram_gb = assume_ram_gb if assume_ram_gb is not None else detect_total_ram_gb()

    gpu_names: list[str] = []
    largest_vram = 0.0
    total_vram = 0.0
    gpu_count = 0
    backend_hints: list[str] = []
    unified_memory = False

    nvidia_names, nvidia_largest, nvidia_total, nvidia_count = detect_nvidia()
    if nvidia_names:
        gpu_names.extend(nvidia_names)
        largest_vram = max(largest_vram, nvidia_largest)
        total_vram += nvidia_total
        gpu_count += nvidia_count
        backend_hints.extend(["CUDA", "llama.cpp", "Ollama", "vLLM"])

    amd_names, amd_largest, amd_total, amd_count = detect_amd_rocm()
    if amd_names or amd_total > 0:
        gpu_names.extend(amd_names or ["AMD GPU"])
        largest_vram = max(largest_vram, amd_largest)
        total_vram += amd_total
        gpu_count += amd_count
        backend_hints.extend(["ROCm", "llama.cpp", "Ollama"])

    apple_names, apple_unified = detect_apple_gpu()
    if apple_names:
        gpu_names.extend(apple_names)
        unified_memory = apple_unified
        backend_hints.extend(["Metal", "MLX", "llama.cpp", "Ollama"])

    if not gpu_names:
        lspci_names = detect_lspci_gpus()
        if lspci_names:
            gpu_names.extend(lspci_names)
            backend_hints.extend(["llama.cpp", "Ollama"])

    if assume_vram_gb is not None:
        largest_vram = assume_vram_gb
        total_vram = assume_vram_gb
        gpu_count = max(1, gpu_count)
        if not gpu_names:
            gpu_names = ["Assumed GPU"]
        backend_hints.extend(["assumed GPU backend", "llama.cpp", "Ollama"])

    selected_gpu_vram = total_vram if allow_multi_gpu and total_vram > largest_vram else largest_vram
    if not backend_hints:
        backend_hints = ["CPU", "llama.cpp", "Ollama"]

    return HardwareProfile(
        os_name=os_name,
        machine=machine,
        cpu=cpu,
        ram_gb=ram_gb,
        gpu_names=gpu_names,
        gpu_vram_gb=selected_gpu_vram,
        largest_single_gpu_vram_gb=largest_vram,
        total_gpu_vram_gb=total_vram,
        gpu_count=gpu_count,
        backend_hints=list(dict.fromkeys(backend_hints)),
        unified_memory=unified_memory,
    )


def normalize_identifier(value: str | None) -> str:
    if not value:
        return ""
    value = value.lower().replace("&", " and ")
    return "".join(ch for ch in value if ch.isalnum())


def token_list(value: str | None) -> list[str]:
    if not value:
        return []
    tokens: list[str] = []
    current: list[str] = []
    for ch in value.lower():
        if ch.isalnum() or ch == ".":
            current.append(ch)
        else:
            if current:
                tokens.append("".join(current))
                current = []
    if current:
        tokens.append("".join(current))
    return [token for token in tokens if token]


def token_set(value: str | None) -> set[str]:
    stop = {
        "instruct",
        "chat",
        "model",
        "mlx",
        "gguf",
        "q4",
        "q5",
        "q6",
        "q8",
        "4bit",
        "5bit",
        "6bit",
        "8bit",
        "community",
        "unsloth",
        "the",
    }
    expanded: set[str] = set()
    for token in token_list(value):
        cleaned = token.replace(".", "")
        if cleaned and cleaned not in stop:
            expanded.add(cleaned)
        if "." in token:
            for part in token.split("."):
                if part and part not in stop:
                    expanded.add(part)
    return expanded


def size_markers(value: str | None) -> set[str]:
    markers: set[str] = set()
    for token in token_list(value):
        cleaned = token.lower().replace(".", "")
        if len(cleaned) < 2:
            continue
        suffix = cleaned[-1]
        number = cleaned[:-1]
        if suffix in {"b", "m", "t"} and number.isdigit():
            markers.add(cleaned)
    return markers


def family_markers(value: str | None) -> set[str]:
    markers: set[str] = set()
    for token in token_set(value):
        if token and not token[-1:].isdigit():
            markers.add(token)
        elif token.startswith("qwen") or token.startswith("llama") or token.startswith("gemma") or token.startswith("phi"):
            markers.add(token)
    return markers


def evidence_score(model: ModelRecord, evidence: WhatCanIRunEvidence) -> float:
    model_text = " ".join(part for part in [model.name, model.provider] if part)
    evidence_text = " ".join(
        part
        for part in [evidence.display_name, evidence.hf_repo_id, evidence.hf_file_name, evidence.model_ref]
        if part
    )
    model_tokens = token_set(model_text)
    evidence_tokens = token_set(evidence_text)
    if not model_tokens or not evidence_tokens:
        return 0.0

    model_sizes = size_markers(model.name)
    evidence_sizes = size_markers(evidence_text)
    if model_sizes and evidence_sizes and model_sizes.isdisjoint(evidence_sizes):
        logging.debug(
            "whatcanirun_match_rejected_size_mismatch model=%s model_sizes=%s evidence=%s evidence_sizes=%s",
            model.name,
            sorted(model_sizes),
            evidence.display_name or evidence.hf_repo_id,
            sorted(evidence_sizes),
        )
        return 0.0

    model_families = family_markers(model.name) | family_markers(model.provider)
    evidence_families = family_markers(evidence_text)
    if model_families and evidence_families and model_families.isdisjoint(evidence_families):
        return 0.0

    overlap = len(model_tokens & evidence_tokens)
    token_score = overlap / max(1, min(len(model_tokens), len(evidence_tokens)))

    model_norm = normalize_identifier(model.name)
    candidates = [
        normalize_identifier(evidence.display_name),
        normalize_identifier(evidence.hf_repo_id),
        normalize_identifier(evidence.hf_file_name),
        normalize_identifier(evidence.model_ref),
    ]
    substring_score = 0.0
    for candidate in candidates:
        if not candidate or not model_norm:
            continue
        if model_norm in candidate or candidate in model_norm:
            substring_score = max(substring_score, 1.0)
        else:
            candidate_tokens = token_set(candidate)
            common = len(model_tokens & candidate_tokens)
            substring_score = max(substring_score, common / max(1, min(len(model_tokens), len(candidate_tokens))))

    return max(token_score, substring_score)


def safe_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def safe_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return int(text)
    return None


def string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in (safe_str(part) for part in value) if item]
    text = safe_str(value)
    return [text] if text else []


MAX_EXTRACT_RECURSION_DEPTH = 64


def extract_featured_models(payload: Any) -> list[WhatCanIRunEvidence]:
    """Extract whatcani.run featured model rows from current and older payload shapes.

    The current upstream route is a static JSON route that returns entries shaped
    like packages/shared/src/featured.ts FeaturedWishlistEntry:
      displayName, hfRepoId, hfFileName?, runtime, modelRef, deviceTypes,
      fileSizeBytes?, minimumDistinctDevices, minimumRunsPerDevice, priority.

    Older snapshots and future wrappers may nest these objects, so this function
    recursively searches for rows instead of assuming one top-level shape.

    Depth-capped — the previous unbounded recursion was a RecursionError-DoS
    vector if an attacker on the network path returned deeply-nested JSON.
    The `seen_object_ids` guard is identity-based and a fresh nested chain
    bypasses it; the depth cap closes that hole.
    """
    found: list[WhatCanIRunEvidence] = []
    seen_object_ids: set[int] = set()

    def field(value: dict[str, Any], *names: str) -> Any:
        for name in names:
            if name in value:
                return value[name]
        return None

    def looks_like_featured_model(value: dict[str, Any]) -> bool:
        return bool(
            field(value, "hfRepoId", "hf_repo_id", "repo", "repoId")
            and field(value, "displayName", "display_name", "name")
            and field(value, "runtime", "runtimeName", "runtime_name")
        )

    def visit(value: Any, depth: int = 0) -> None:
        if depth > MAX_EXTRACT_RECURSION_DEPTH:
            return
        object_id = id(value)
        if object_id in seen_object_ids:
            return
        if isinstance(value, dict):
            seen_object_ids.add(object_id)
            if looks_like_featured_model(value):
                file_size = None
                raw_file_size = field(value, "fileSizeBytes", "file_size_bytes", "fileSize", "sizeBytes")
                if isinstance(raw_file_size, (int, float)) and raw_file_size > 0:
                    file_size = float(raw_file_size) / 1024**3
                found.append(
                    WhatCanIRunEvidence(
                        display_name=safe_str(field(value, "displayName", "display_name", "name")),
                        hf_repo_id=safe_str(field(value, "hfRepoId", "hf_repo_id", "repo", "repoId")),
                        hf_file_name=safe_str(field(value, "hfFileName", "hf_file_name", "fileName")),
                        runtime=safe_str(field(value, "runtime", "runtimeName", "runtime_name")),
                        file_size_gb=file_size,
                        device_types=string_list(field(value, "deviceTypes", "device_types")),
                        model_ref=safe_str(field(value, "modelRef", "model_ref", "source")),
                        minimum_distinct_devices=safe_int(field(value, "minimumDistinctDevices", "minimum_distinct_devices")),
                        minimum_runs_per_device=safe_int(field(value, "minimumRunsPerDevice", "minimum_runs_per_device")),
                        priority=safe_int(field(value, "priority")),
                        # raw=value used to keep the entire upstream dict (for
                        # debug logging). That dict flowed through
                        # `recommendation_to_dict` into the agent's context as
                        # JSON — an indirect prompt-injection surface since
                        # any field whatcani.run sets can carry attacker text.
                        # Set to None: per-row debug now uses only the named
                        # parsed fields.
                        raw=None,
                    )
                )
            for child in value.values():
                visit(child, depth + 1)
        elif isinstance(value, list):
            seen_object_ids.add(object_id)
            for child in value:
                visit(child, depth + 1)

    visit(payload)
    deduped: dict[tuple[str | None, str | None, str | None, str | None], WhatCanIRunEvidence] = {}
    for item in found:
        key = (item.runtime, item.display_name, item.hf_repo_id, item.hf_file_name)
        previous = deduped.get(key)
        if previous is None:
            deduped[key] = item
            continue
        previous_priority = previous.priority if previous.priority is not None else 9999
        current_priority = item.priority if item.priority is not None else 9999
        if current_priority < previous_priority:
            deduped[key] = item
    return list(deduped.values())


def recommended_wcir_runtime(hardware: HardwareProfile) -> str:
    if hardware.unified_memory and hardware.os_name == "Darwin":
        return "mlx_lm"
    return "llama.cpp"


def whatcanirun_device_type(hardware: HardwareProfile) -> str:
    if hardware.unified_memory and hardware.os_name == "Darwin":
        return "apple"
    if hardware.gpu_vram_gb > 0:
        return "gpu"
    return "cpu"


def whatcanirun_query_url(base_url: str, hardware: HardwareProfile, limit: int, runtime: str | None) -> str:
    """Return the whatcani.run featured API URL for this machine.

    The upstream route accepts runtime/cpu/gpu/gpuCount/ramGb/osName/limit and
    uses those values to select wishlist entries that are relevant for the
    device and memory budget. Limit is capped server-side at 50.
    """
    query: dict[str, str] = {}
    if runtime:
        query["runtime"] = runtime
    if hardware.cpu:
        query["cpu"] = hardware.cpu
    if hardware.gpu_names:
        query["gpu"] = hardware.gpu_names[0]
    elif hardware.unified_memory and hardware.os_name == "Darwin":
        query["gpu"] = hardware.cpu or "Apple Silicon"
    if hardware.gpu_count > 0:
        query["gpuCount"] = str(hardware.gpu_count)
    if hardware.ram_gb > 0:
        query["ramGb"] = str(max(1, int(hardware.ram_gb)))
    if hardware.os_name:
        query["osName"] = hardware.os_name
    query["limit"] = str(max(1, min(limit, 50)))
    separator = "&" if "?" in base_url else "?"
    return base_url + separator + urllib.parse.urlencode(query)


def whatcanirun_fallback_urls(base_url: str, hardware: HardwareProfile, limit: int, runtime: str | None) -> list[str]:
    urls = [whatcanirun_query_url(base_url, hardware, limit, runtime)]
    basic_query: dict[str, str] = {"limit": str(max(1, min(limit, 50)))}
    if runtime:
        basic_query["runtime"] = runtime
    separator = "&" if "?" in base_url else "?"
    urls.append(base_url + separator + urllib.parse.urlencode(basic_query))
    alternate_runtime = "llama.cpp" if runtime == "mlx_lm" else "mlx_lm"
    urls.append(base_url + separator + urllib.parse.urlencode({"runtime": alternate_runtime, "limit": str(max(1, min(limit, 50)))}))
    urls.append(base_url)
    deduped: list[str] = []
    for url in urls:
        if url not in deduped:
            deduped.append(url)
    return deduped


def filter_whatcanirun_evidence(
    evidences: Iterable[WhatCanIRunEvidence],
    hardware: HardwareProfile,
    runtime: str | None,
    limit: int,
) -> list[WhatCanIRunEvidence]:
    wanted_runtime = runtime or recommended_wcir_runtime(hardware)
    wanted_device_type = whatcanirun_device_type(hardware)
    scored: list[tuple[tuple[int, int, int, str], WhatCanIRunEvidence]] = []

    for evidence in evidences:
        if wanted_runtime and evidence.runtime != wanted_runtime:
            continue
        device_types = set(evidence.device_types)
        # Current public FeaturedModel responses do not include deviceTypes;
        # older/local cache snapshots may include them. Treat missing deviceTypes
        # as already server-filtered, not as a reason to reject the row.
        if device_types and wanted_device_type not in device_types:
            continue
        priority = evidence.priority if evidence.priority is not None else 9999
        distinct_devices = evidence.minimum_distinct_devices if evidence.minimum_distinct_devices is not None else 0
        runs_per_device = evidence.minimum_runs_per_device if evidence.minimum_runs_per_device is not None else 0
        name_key = evidence.display_name or evidence.hf_repo_id or ""
        scored.append(((priority, -distinct_devices, -runs_per_device, name_key), evidence))

    scored.sort(key=lambda item: item[0])
    return [item[1] for item in scored[: max(1, min(limit, 500))]]


def summarize_whatcanirun_payload(payload: Any, extracted: list[WhatCanIRunEvidence], filtered: list[WhatCanIRunEvidence], url: str) -> dict[str, Any]:
    runtime_counts: dict[str, int] = {}
    device_counts: dict[str, int] = {}
    for item in extracted:
        runtime_counts[item.runtime or "unknown"] = runtime_counts.get(item.runtime or "unknown", 0) + 1
        if item.device_types:
            for device_type in item.device_types:
                device_counts[device_type] = device_counts.get(device_type, 0) + 1
        else:
            device_counts["not-provided"] = device_counts.get("not-provided", 0) + 1
    return {
        "url": url,
        "top_level_type": type(payload).__name__,
        "extracted_count": len(extracted),
        "filtered_count": len(filtered),
        "runtime_counts": runtime_counts,
        "device_counts": device_counts,
        "sample": [
            {
                "display_name": item.display_name,
                "hf_repo_id": item.hf_repo_id,
                "hf_file_name": item.hf_file_name,
                "runtime": item.runtime,
                "device_types": item.device_types,
            }
            for item in filtered[:5]
        ],
    }


def load_whatcanirun_evidence(args: argparse.Namespace, hardware: HardwareProfile) -> tuple[list[WhatCanIRunEvidence], str | None, dict[str, Any]]:
    """Load whatcani.run evidence by default, trying several query shapes.

    This function is intentionally persistent: a single empty response or one
    failed query should not make the feature look unused. It records every
    success, empty parse, filter rejection, and failure in diagnostics/logs.
    """
    mode = args.whatcanirun
    diagnostics: dict[str, Any] = {"mode": mode, "network_retries_per_url": args.network_retries, "network_timeout_seconds": args.network_timeout, "retry_delay_seconds": args.retry_delay}
    if mode == "never":
        diagnostics["reason"] = "disabled"
        logging.info("whatcanirun_disabled")
        return [], None, diagnostics

    runtime = args.whatcanirun_runtime or recommended_wcir_runtime(hardware)
    diagnostics["wanted_runtime"] = runtime
    diagnostics["wanted_device_type"] = whatcanirun_device_type(hardware)
    cache_path = args.whatcanirun_cache or str(default_cache_dir() / "whatcanirun_featured.json")
    attempts: list[dict[str, Any]] = []
    all_evidence_by_key: dict[tuple[str | None, str | None, str | None, str | None], WhatCanIRunEvidence] = {}
    sources: list[str] = []

    def remember(payload: Any, source_label: str) -> list[WhatCanIRunEvidence]:
        extracted = extract_featured_models(payload)
        filtered = filter_whatcanirun_evidence(extracted, hardware, runtime, args.whatcanirun_limit)
        summary = summarize_whatcanirun_payload(payload, extracted, filtered, source_label)
        attempts.append(summary)
        logging.info("whatcanirun_attempt=%s", json.dumps(summary, ensure_ascii=False, sort_keys=True))
        for item in extracted:
            key = (item.runtime, item.display_name, item.hf_repo_id, item.hf_file_name)
            if key not in all_evidence_by_key:
                all_evidence_by_key[key] = item
        if extracted:
            sources.append(source_label)
        return filtered

    if args.whatcanirun_from_cache:
        try:
            payload = load_json(args.whatcanirun_from_cache)
            remember(payload, "cache:" + args.whatcanirun_from_cache)
            combined = list(all_evidence_by_key.values())
            filtered = filter_whatcanirun_evidence(combined, hardware, runtime, args.whatcanirun_limit)
            diagnostics["attempts"] = attempts
            diagnostics["combined_extracted_count"] = len(combined)
            diagnostics["combined_filtered_count"] = len(filtered)
            diagnostics["source_count"] = 1 if combined else 0
            diagnostics["sources_with_extractable_rows"] = sources
            return filtered, "cache:" + args.whatcanirun_from_cache, diagnostics
        except (OSError, json.JSONDecodeError) as exc:
            attempts.append({"url": "cache:" + args.whatcanirun_from_cache, "error": repr(exc)})
            logging.warning("whatcanirun_cache_read_failure path=%s error=%r", args.whatcanirun_from_cache, exc)

    network_payload_to_cache: Any = None
    network_payload_source: str | None = None
    for query_url in whatcanirun_fallback_urls(args.whatcanirun_featured_url, hardware, args.whatcanirun_limit, runtime):
        try:
            payload = fetch_json(query_url, timeout=args.network_timeout, retries=args.network_retries, retry_delay=args.retry_delay)
            network_payload_to_cache = payload
            network_payload_source = query_url
            remember(payload, query_url)
        except (RuntimeError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            failure = {"url": query_url, "error": repr(exc)}
            attempts.append(failure)
            logging.warning("whatcanirun_query_failure=%s", json.dumps(failure, ensure_ascii=False, sort_keys=True))

    if not all_evidence_by_key and expand_path(cache_path).exists():
        try:
            age = time.time() - expand_path(cache_path).stat().st_mtime
            payload = load_json(cache_path)
            remember(payload, f"fallback-cache:{cache_path}:age_seconds={int(age)}")
            diagnostics["used_stale_or_existing_cache_after_network_failure"] = True
        except (OSError, json.JSONDecodeError) as exc:
            attempts.append({"url": "fallback-cache:" + cache_path, "error": repr(exc)})
            logging.warning("whatcanirun_fallback_cache_failure path=%s error=%r", cache_path, exc)

    if network_payload_to_cache is not None and (args.save_whatcanirun_cache or mode in {"auto", "always"}):
        save_target = args.save_whatcanirun_cache or cache_path
        try:
            save_json(save_target, network_payload_to_cache)
            logging.info("whatcanirun_cache_saved path=%s source=%s", save_target, network_payload_source)
        except OSError as exc:
            attempts.append({"url": "save-cache:" + save_target, "error": repr(exc)})
            logging.warning("whatcanirun_cache_save_failure path=%s error=%r", save_target, exc)
            # When the user EXPLICITLY passed --save-whatcanirun-cache, a save
            # failure is fail-fast (the user is owed an error, not a silent
            # "we tried and gave up"). Implicit auto-save failures keep the
            # warning-only behaviour because the next run will try again.
            if args.save_whatcanirun_cache:
                raise RuntimeError(
                    f"failed to write --save-whatcanirun-cache {save_target!s}: {exc}"
                ) from exc

    combined = list(all_evidence_by_key.values())
    filtered = filter_whatcanirun_evidence(combined, hardware, runtime, args.whatcanirun_limit)
    diagnostics["attempts"] = attempts
    diagnostics["combined_extracted_count"] = len(combined)
    diagnostics["combined_filtered_count"] = len(filtered)
    diagnostics["source_count"] = len(sources)
    diagnostics["sources_with_extractable_rows"] = sources
    logging.info("whatcanirun_combined extracted=%d filtered=%d sources=%d", len(combined), len(filtered), len(sources))
    source_label = ", ".join(sources[:3]) if sources else network_payload_source
    return filtered, source_label, diagnostics

def matching_evidence_for_model(
    model: ModelRecord,
    evidences: list[WhatCanIRunEvidence],
    minimum_score: float = 0.45,
) -> list[WhatCanIRunEvidence]:
    scored: list[tuple[float, WhatCanIRunEvidence]] = []
    seen: set[tuple[str | None, str | None, str | None, str | None]] = set()
    for evidence in evidences:
        score = evidence_score(model, evidence)
        if score < minimum_score:
            continue
        key = (evidence.runtime, evidence.hf_repo_id, evidence.hf_file_name, evidence.display_name)
        if key in seen:
            continue
        seen.add(key)
        scored.append((score, evidence))

    def quality_rank(evidence: WhatCanIRunEvidence) -> tuple[int, int, int, int, str]:
        text = " ".join(part for part in [evidence.display_name, evidence.hf_file_name, evidence.hf_repo_id] if part).lower()
        preferred_order = ["q4_k_m", "4bit", "q4_0", "q5_k_m", "5bit", "q6_k", "6bit", "q8_0", "8bit"]
        preference = 999
        for index, marker in enumerate(preferred_order):
            if marker in text:
                preference = index
                break
        has_repo = 0 if evidence.hf_repo_id else 1
        has_file = 0 if evidence.hf_file_name else 1
        priority = evidence.priority if evidence.priority is not None else 9999
        return (preference, has_repo, has_file, priority, text)

    scored.sort(key=lambda pair: (-pair[0], quality_rank(pair[1])))
    return [evidence for _, evidence in scored]


def best_evidence_for_model(model: ModelRecord, evidences: list[WhatCanIRunEvidence]) -> WhatCanIRunEvidence | None:
    matches = matching_evidence_for_model(model, evidences)
    return matches[0] if matches else None


def context_overhead_gb(model: ModelRecord, requested_context_tokens: int) -> float:
    if model.params_b is None:
        return 0.0
    base_context = model.context_tokens or 8192
    effective_context = min(requested_context_tokens, base_context)
    if effective_context <= 8192:
        return 0.0
    extra_8k_blocks = (effective_context - 8192) / 8192.0
    return max(0.0, model.params_b * 0.040 * extra_8k_blocks)


def estimate_required_memory_gb(model: ModelRecord, context_tokens: int, safety_overhead_gb: float) -> float | None:
    if model.vram_int4_gb is None:
        return None
    return model.vram_int4_gb + context_overhead_gb(model, context_tokens) + safety_overhead_gb


def normalized_benchmark_values(models: list[ModelRecord]) -> dict[str, dict[str, float]]:
    columns = tuple(CODING_BENCHMARK_WEIGHTS.keys())
    ranges: dict[str, tuple[float, float]] = {}
    for column in columns:
        values = [getattr(model, column) for model in models]
        numeric = [float(value) for value in values if value is not None]
        if numeric:
            ranges[column] = (min(numeric), max(numeric))
    result: dict[str, dict[str, float]] = {}
    for model in models:
        model_result: dict[str, float] = {}
        for column, (minimum, maximum) in ranges.items():
            value = getattr(model, column)
            if value is None:
                continue
            if maximum == minimum:
                model_result[column] = 1.0
            else:
                model_result[column] = (float(value) - minimum) / (maximum - minimum)
        result[model.name] = model_result
    return result


def coding_score(model: ModelRecord, normalized: dict[str, dict[str, float]]) -> float:
    pieces: list[tuple[float, float]] = []
    model_values = normalized.get(model.name, {})
    for column, weight in CODING_BENCHMARK_WEIGHTS.items():
        value = model_values.get(column)
        if value is not None:
            pieces.append((weight, value * 100.0))
    if not pieces:
        return 0.0
    total_weight = sum(weight for weight, _ in pieces)
    return sum(weight * score for weight, score in pieces) / total_weight


def license_factor(license_name: str | None, allow_noncommercial: bool) -> float:
    if not license_name:
        return 0.92
    lowered = license_name.lower()
    if any(keyword in lowered for keyword in NONCOMMERCIAL_LICENSE_KEYWORDS) and not allow_noncommercial:
        return 0.0
    if any(keyword in lowered for keyword in PERMISSIVE_LICENSE_KEYWORDS):
        return 1.0
    if "llama" in lowered or "gemma" in lowered or "qwen" in lowered:
        return 0.94
    return 0.90


def fit_factor(headroom_ratio: float | None, compatible: bool) -> float:
    if not compatible or headroom_ratio is None:
        return 0.0
    if headroom_ratio >= 0.30:
        return 1.0
    if headroom_ratio >= 0.15:
        return 0.90
    if headroom_ratio >= 0.05:
        return 0.72
    return 0.50


def run_status(headroom_ratio: float | None, compatible: bool) -> str:
    if not compatible or headroom_ratio is None:
        return "does not fit"
    if headroom_ratio >= 0.30:
        return "runs very comfortably"
    if headroom_ratio >= 0.15:
        return "runs comfortably"
    if headroom_ratio >= 0.05:
        return "runs, but tight"
    return "barely fits, not recommended"


def recommendation_memory_budget(hardware: HardwareProfile, unified_memory_fraction: float, cpu_memory_fraction: float) -> tuple[str, float]:
    if hardware.gpu_vram_gb > 0:
        return "largest single GPU VRAM" if hardware.gpu_vram_gb == hardware.largest_single_gpu_vram_gb else "multi-GPU VRAM", hardware.gpu_vram_gb
    if hardware.unified_memory:
        return "Apple unified memory budget", hardware.ram_gb * unified_memory_fraction
    return "system RAM CPU budget", hardware.ram_gb * cpu_memory_fraction


def apply_hardware_cli_overrides(args: argparse.Namespace, hardware: HardwareProfile) -> HardwareProfile:
    """Apply explicit hardware simulation flags after normal detection.

    These flags are mainly for testing the recommender from a different machine.
    Ordinary users do not need them.
    """
    if getattr(args, "assume_apple_silicon", False):
        chip = args.assume_apple_chip or hardware.cpu or "Apple Silicon"
        ram_gb = args.assume_ram_gb if args.assume_ram_gb is not None else hardware.ram_gb
        return dataclasses.replace(
            hardware,
            os_name="Darwin",
            machine="arm64",
            cpu=chip,
            ram_gb=ram_gb,
            gpu_names=[chip],
            gpu_vram_gb=0.0,
            largest_single_gpu_vram_gb=0.0,
            total_gpu_vram_gb=0.0,
            gpu_count=1,
            backend_hints=["Apple Metal", "MLX", "llama.cpp", "Ollama"],
            unified_memory=True,
        )
    return hardware


def parse_params_b_from_model_name(name: str) -> float | None:
    """Extract parameter count from a model name using the last size token.

    Do not pass the whole model name to parse_numeric: names such as
    Qwen3.5-27B would become 3.527. The last B/M/T size token is the
    architecture size that should drive memory estimates.
    """
    value = None
    for token in token_list(name):
        if is_parameter_count_token(token):
            value = parse_params_b(token)
    return value


def model_family_prefix_from_name(name: str) -> str:
    """Return a normalized family prefix before the last parameter-count token.

    This lets Qwen3.5-27B artifacts inherit family-level coding benchmark hints
    from an Onyx row such as Qwen 3.5 when Onyx does not yet list that exact
    artifact size. The inherited values are only a ranking hint; the source field
    explicitly marks synthesized rows as artifact/backfill rows.
    """
    tokens = token_list(name)
    last_param_index = None
    for index, token in enumerate(tokens):
        if is_parameter_count_token(token):
            last_param_index = index
    if last_param_index is None:
        family_tokens = tokens
    else:
        family_tokens = tokens[:last_param_index]
    return normalize_identifier("".join(family_tokens))


def raw_family_benchmark_score(model: ModelRecord) -> float:
    values = [
        model.livecodebench,
        model.swe_bench_verified,
        model.humaneval,
        model.gpqa_diamond,
        model.mmlu_pro,
    ]
    numeric = [float(value) for value in values if value is not None]
    return sum(numeric) / len(numeric) if numeric else 0.0


def best_benchmark_template_for_artifact(model_name: str, models: list[ModelRecord]) -> ModelRecord | None:
    artifact_prefix = model_family_prefix_from_name(model_name)
    artifact_family_tokens = family_markers(model_name)
    candidates: list[ModelRecord] = []
    for model in models:
        model_prefix = model_family_prefix_from_name(model.name)
        if artifact_prefix and model_prefix and artifact_prefix == model_prefix:
            candidates.append(model)
            continue
        if artifact_family_tokens and not artifact_family_tokens.isdisjoint(family_markers(model.name) | family_markers(model.provider)):
            # Same high-level family (Qwen/Gemma/Llama/etc.) but not exact size.
            # This is a weaker match, used only when no exact prefix exists.
            candidates.append(model)
    if not candidates:
        return None
    candidates.sort(key=raw_family_benchmark_score, reverse=True)
    return candidates[0]


def synthesize_model_from_artifacts(model_name: str, artifacts: list[QuantizedArtifact], template: ModelRecord | None) -> ModelRecord | None:
    params_b = parse_params_b_from_model_name(model_name)
    if params_b is None:
        return None
    # NOTE: artifact creators (mlx-community, unsloth, bartowski, …) are
    # intentionally NOT aggregated here — they are quantization publishers
    # and used to wrongly populate `provider`. Per-artifact QuantizedArtifact.
    # creator still preserves that information at the right granularity.
    formats = sorted({artifact.format for artifact in artifacts if artifact.format})
    smallest_file = min((artifact.file_size_gb for artifact in artifacts if artifact.file_size_gb and artifact.file_size_gb > 0), default=None)
    # Prefer measured/downloaded artifact size if the upstream feed provides it.
    # Otherwise estimate an INT4-ish footprint from parameter count. This keeps
    # new whatcani.run-only models visible instead of dropping them from the
    # recommender, while still being conservative about fit.
    estimated_int4 = smallest_file if smallest_file is not None else max(0.5, params_b * 0.52)
    context_tokens = template.context_tokens if template else None
    context = template.context if template else None
    source = "whatcani.run artifact backfill"
    if template is not None:
        source += f" + Onyx family benchmark hint from {template.name}"
    # provider chain: prefer the brand inferred directly from the
    # synthesized model_name. The Onyx `template` is selected by
    # `best_benchmark_template_for_artifact`, which falls back to a
    # WEAK family-tokens match when no exact prefix-match exists —
    # so the template can easily be a different brand than the
    # artifact (e.g. ``Meta-Llama-3.1-8B-Instruct`` weak-matches
    # ``DS-R1-Distill-Llama-70B`` on the shared ``llama`` token, and
    # the template's provider field is ``DeepSeek``). The synthesized
    # name is the most reliable signal we have, so name-inference wins.
    # Template.provider remains the fallback when the name has an
    # unknown brand prefix. We still NEVER fall back to `creators`:
    # those are quantization publishers (mlx-community, unsloth,
    # bartowski, …), captured per-artifact in
    # QuantizedArtifact.creator.
    inferred_provider = infer_provider_from_name(model_name)
    return ModelRecord(
        name=model_name,
        provider=(inferred_provider
                  if inferred_provider
                  else (template.provider if template and template.provider else None)),
        params=f"{params_b:g}B",
        params_b=params_b,
        context=context,
        context_tokens=context_tokens,
        license=template.license if template else None,
        vram_int4_gb=estimated_int4,
        vram_fp16_gb=params_b * 2.0,
        mmlu_pro=template.mmlu_pro if template else None,
        gpqa_diamond=template.gpqa_diamond if template else None,
        ifeval=template.ifeval if template else None,
        chatbot_arena=template.chatbot_arena if template else None,
        swe_bench_verified=template.swe_bench_verified if template else None,
        humaneval=template.humaneval if template else None,
        livecodebench=template.livecodebench if template else None,
        aime_2025=template.aime_2025 if template else None,
        math_500=template.math_500 if template else None,
        source_url=WHATCANIRUN_FEATURED_URL,
        source=source + (f"; formats={','.join(formats)}" if formats else ""),
    )


def merge_onyx_models_with_artifact_backfill(models: list[ModelRecord], evidences: list[WhatCanIRunEvidence]) -> list[ModelRecord]:
    """Add whatcani.run-only model families as first-class recommendation rows.

    Onyx is the preferred benchmark/ranking source, but it can lag behind the
    rapidly updated whatcani.run artifact feed. If a quantized artifact family
    is present in whatcani.run and no Onyx row matches its model name/size, add
    a synthetic row with explicit source metadata so users still see runnable
    models such as Qwen3.5-27B.
    """
    artifacts = quantized_artifacts_from_evidence(evidences)
    if not artifacts:
        return models
    groups: dict[str, list[QuantizedArtifact]] = {}
    for artifact in artifacts:
        groups.setdefault(normalized_model_group_name(artifact.model_name), []).append(artifact)

    merged = list(models)
    existing_keys = {normalized_model_group_name(model.name) for model in models}
    added = []
    for group_name, group_artifacts in groups.items():
        if group_name in existing_keys:
            continue
        # Avoid adding tiny utility/base artifacts unless they have enough size
        # metadata to participate in the recommender.
        template = best_benchmark_template_for_artifact(group_artifacts[0].model_name, models)
        synthetic = synthesize_model_from_artifacts(group_artifacts[0].model_name, group_artifacts, template)
        if synthetic is None:
            continue
        merged.append(synthetic)
        added.append(synthetic.name)
        existing_keys.add(group_name)
    logging.info("artifact_backfill_models_added count=%d sample=%s qwen=%s", len(added), added[:10], [name for name in added if "qwen" in name.lower()][:20])
    return merged


def recommend_models(
    models: Iterable[ModelRecord],
    hardware: HardwareProfile,
    evidences: list[WhatCanIRunEvidence],
    context_tokens: int,
    min_headroom: float,
    allow_noncommercial: bool,
    include_incompatible: bool,
    require_whatcanirun: bool,
    unified_memory_fraction: float,
    cpu_memory_fraction: float,
) -> list[Recommendation]:
    model_list = list(models)
    normalized = normalized_benchmark_values(model_list)
    memory_basis, available = recommendation_memory_budget(hardware, unified_memory_fraction, cpu_memory_fraction)
    recommendations: list[Recommendation] = []

    for model in model_list:
        notes: list[str] = []
        evidence_matches = matching_evidence_for_model(model, evidences)
        evidence = evidence_matches[0] if evidence_matches else None
        if evidence:
            notes.append(f"whatcani.run has {len(evidence_matches)} matching local quant/runtime candidate(s)")
        elif require_whatcanirun:
            notes.append("no matching whatcani.run quant/runtime evidence")

        required = estimate_required_memory_gb(model, context_tokens, safety_overhead_gb=1.25)
        license_multiplier = license_factor(model.license, allow_noncommercial)
        if license_multiplier == 0.0:
            notes.append("excluded by non-commercial/license policy")

        if required is None:
            compatible = False
            headroom_gb = None
            headroom_ratio = None
            notes.append("missing INT4 memory estimate")
        else:
            headroom_gb = available - required
            headroom_ratio = headroom_gb / required if required > 0 else None
            compatible = headroom_ratio is not None and headroom_ratio >= min_headroom
            if model.context_tokens is not None and context_tokens > model.context_tokens:
                notes.append(f"requested context exceeds listed context {model.context or model.context_tokens}")
                compatible = False
            if require_whatcanirun and evidence is None:
                compatible = False
            if not compatible:
                notes.append("does not satisfy compatibility requirements")
            elif headroom_ratio is not None and headroom_ratio < 0.10:
                notes.append("barely fits; use lower context or a smaller model")
            elif headroom_ratio is not None and headroom_ratio < 0.25:
                notes.append("fits, but with limited headroom")

        raw_coding = coding_score(model, normalized)
        evidence_multiplier = 1.08 if evidence is not None else 1.0
        final = raw_coding * fit_factor(headroom_ratio, compatible) * license_multiplier * evidence_multiplier
        recommendation = Recommendation(
            model=model,
            compatible=compatible and license_multiplier > 0.0,
            run_status=run_status(headroom_ratio, compatible),
            memory_basis=memory_basis,
            available_memory_gb=available,
            estimated_required_gb=required,
            headroom_gb=headroom_gb,
            headroom_ratio=headroom_ratio,
            coding_score=raw_coding,
            final_score=final,
            whatcanirun=evidence,
            whatcanirun_matches=evidence_matches,
            notes=notes,
        )
        if recommendation.compatible or include_incompatible:
            recommendations.append(recommendation)
    recommendations.sort(key=lambda item: (item.compatible, item.final_score, item.coding_score, item.model.params_b or 0.0), reverse=True)
    return recommendations


def artifact_to_dict(artifact: QuantizedArtifact) -> dict[str, Any]:
    return dataclasses.asdict(artifact)


def quantized_artifacts_from_evidence(evidences: Iterable[WhatCanIRunEvidence]) -> list[QuantizedArtifact]:
    artifacts: list[QuantizedArtifact] = []
    seen: set[tuple[str, str | None, str | None]] = set()
    for evidence in evidences:
        artifact = quantized_artifact_from_evidence(evidence)
        if artifact is None:
            continue
        key = (artifact.hf_repo_id, artifact.hf_file_name, artifact.runtime)
        if key in seen:
            continue
        seen.add(key)
        artifacts.append(artifact)
    artifacts.sort(key=lambda item: (item.model_name.lower(), item.creator.lower(), item.format, quantization_sort_key(item.quantization), item.hf_repo_id, item.hf_file_name or ""))
    return artifacts


def recommendation_to_dict(item: Recommendation) -> dict[str, Any]:
    result = dataclasses.asdict(item)
    result["quantized_downloads"] = [
        artifact_to_dict(artifact)
        for artifact in quantized_artifacts_from_evidence(item.whatcanirun_matches)
    ]
    return result


def format_gb(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.1f} GB"


def safe_local_dir_name(value: str | None) -> str:
    text = value or "model"
    cleaned = []
    for ch in text:
        if ch.isalnum() or ch in {"-", "_", "."}:
            cleaned.append(ch)
        else:
            cleaned.append("-")
    result = "".join(cleaned).strip("-")
    while "--" in result:
        result = result.replace("--", "-")
    # Strip leading dots — an evidence row with display_name "..ssh" would
    # otherwise yield local_dir="..ssh" and a download path of `./models/..ssh`.
    # Shell-quoting + the explicit `./models/` prefix already neutralise the
    # worst, but a defence-in-depth strip is cheap.
    result = result.lstrip(".")
    return result or "model"


def huggingface_model_url(evidence: WhatCanIRunEvidence) -> str | None:
    if not evidence.hf_repo_id:
        return None
    if evidence.hf_file_name:
        return f"https://huggingface.co/{evidence.hf_repo_id}/blob/main/{evidence.hf_file_name}"
    return f"https://huggingface.co/{evidence.hf_repo_id}"


def shell_quote(value: str) -> str:
    """Quote command fragments for copy/paste safety in POSIX-like shells.

    Hugging Face repo IDs and filenames should normally be simple, but they are
    scraped from remote JSON.  Quoting prevents whitespace or shell metacharacters
    in a future artifact name from turning the printed command into something
    surprising.  Windows users can still copy the unambiguous arguments from the
    printed repo/file fields if their shell quoting rules differ.
    """
    return shlex.quote(value)


def huggingface_cli_command(evidence: WhatCanIRunEvidence) -> str | None:
    if not evidence.hf_repo_id:
        return None
    local_dir = safe_local_dir_name(evidence.display_name or evidence.hf_repo_id.split("/")[-1])
    repo = shell_quote(evidence.hf_repo_id)
    directory = shell_quote(f"./models/{local_dir}")
    if evidence.hf_file_name:
        return f"hf download {repo} {shell_quote(evidence.hf_file_name)} --local-dir {directory}"
    return f"hf download {repo} --local-dir {directory}"


def plain_huggingface_cli_command(evidence: WhatCanIRunEvidence) -> str | None:
    if not evidence.hf_repo_id:
        return None
    repo = shell_quote(evidence.hf_repo_id)
    if evidence.hf_file_name:
        return f"hf download {repo} {shell_quote(evidence.hf_file_name)}"
    return f"hf download {repo}"


def quantization_label(evidence: WhatCanIRunEvidence) -> str:
    artifact = quantized_artifact_from_evidence(evidence)
    if artifact is not None:
        return f"{artifact.model_name} / {artifact.creator} / {artifact.format} / {artifact.quantization}"
    return evidence.display_name or evidence.hf_file_name or evidence.hf_repo_id or "unknown artifact"


def strip_file_extension(name: str) -> str:
    lower = name.lower()
    for suffix in (".onnxdata", ".safetensors", ".gguf", ".onnx", ".data", ".ort", ".bin", ".npz"):
        if lower.endswith(suffix):
            return name[:-len(suffix)]
    return name


def normalize_source_name_for_parsing(name: str) -> str:
    """Defensive cleanup before hyphen-tokenizing an artifact name.

    HF repo IDs and file names are reliably hyphen-clean, but the
    whatcani.run ``display_name`` field sometimes carries human formatting:
    spaces, parentheses, and the occasional comma. A name like
    ``Llama 3.2 3B Instruct (4-bit)`` would otherwise split on ``-`` into
    ``["Llama 3.2 3B Instruct (4", "bit)"]``, causing the parser to ship
    ``(4`` into the model name and ``bit)`` as the quantization. Strip
    that formatting before tokenization so the downstream splitter sees
    a normal hyphen-separated identifier.

    The transformation is intentionally narrow: only whitespace runs
    become hyphens and parentheses are removed. Other punctuation is
    preserved because real quant labels do contain dots and underscores
    (``Q4_K_M``, ``Q8_0``, ``MiniMax-M2.7``).
    """
    if not name:
        return name
    name = "-".join(name.split())          # whitespace runs → single hyphen
    name = name.replace("(", "").replace(")", "")
    return name


def repo_creator(repo_id: str | None) -> str | None:
    if not repo_id or "/" not in repo_id:
        return None
    creator = repo_id.split("/", 1)[0].strip()
    return creator or None


def repo_leaf(repo_id: str | None) -> str | None:
    if not repo_id:
        return None
    return repo_id.split("/")[-1].strip() or None


def is_plain_bit_quant(token: str) -> bool:
    lower = token.lower()
    if not lower.endswith("bit"):
        return False
    number = lower[:-3]
    return number.isdigit()


def is_int_quant(token: str) -> bool:
    lower = token.lower()
    if not lower.startswith("int"):
        return False
    number = lower[3:]
    return number.isdigit()


def is_quant_scheme_prefix(token: str) -> bool:
    lower = token.lower()
    upper = token.upper()
    return upper in {"GPTQ", "AWQ", "EXL2", "HQQ", "AQLM", "SPQR", "QUIP"} or lower in {"optiq"}


def is_format_marker_token(token: str) -> bool:
    return token.upper() in {"MLX", "GGUF", "ONNX", "ORT", "BIN", "NPZ", "SAFETENSORS", "GGML"}


def normalize_creator_token(token: str | None) -> str:
    if not token:
        return ""
    return "".join(char.lower() for char in token if char.isalnum())


def is_creator_marker_token(token: str, creator: str | None) -> bool:
    if not creator:
        return False
    token_norm = normalize_creator_token(token)
    creator_norm = normalize_creator_token(creator)
    if not token_norm or not creator_norm:
        return False
    return token_norm == creator_norm


MODEL_DESCRIPTOR_TOKENS = {
    "mini", "instruct", "inst", "it", "base", "reasoner", "reason", "think", "thinking",
    "coder", "code", "chat", "abliterated", "uncensored", "fine", "tuned", "fine-tuned",
    "finetuned", "nano", "micro", "merged", "merge", "adapter", "adaptor",
    "quantized", "trained", "extended", "vlm", "llm", "tts", "stt", "t2v", "v2t",
    "vision", "audio", "video", "text", "image", "preview", "alpha", "beta", "rc",
    "small", "medium", "large", "moe", "a", "e",
}

# Keep this deliberately conservative. Two-letter language markers can look
# exactly like short quantization fragments, so only very common language or
# region aliases seen in model artifact names should live here. ISO 639-1 is
# the baseline, with a few common model-repo aliases such as jp/kr/ch/po.
LANGUAGE_TOKENS = {
    # English / Chinese / Japanese / Korean and common aliases in model names.
    "en", "zh", "ch", "cn", "ja", "jp", "ko", "kr",
    # Major European language markers commonly found in LLM artifact names.
    "es", "de", "ru", "pt", "po", "fr", "it", "nl", "sv", "da", "no", "fi", "pl",
    # Other common language markers that are frequent enough not to be exotic.
    "ar", "he", "hi", "id", "vi", "th", "tr", "uk",
    # Multi-language descriptors.
    "multi", "multilingual",
}


def is_model_descriptor_token(token: str) -> bool:
    lower = token.lower().strip("_ ")
    if not lower:
        return False
    if lower in MODEL_DESCRIPTOR_TOKENS or lower in LANGUAGE_TOKENS:
        return True
    # Keep common descriptor compounds such as fine-tuned and zh-en in model names.
    pieces = [piece for piece in lower.replace("_", "-").split("-") if piece]
    if len(pieces) > 1 and all(piece in MODEL_DESCRIPTOR_TOKENS or piece in LANGUAGE_TOKENS for piece in pieces):
        return True
    return False


def is_parameter_count_token(token: str) -> bool:
    upper = token.upper().strip("_ ")
    if not upper.endswith("B"):
        return False
    body = upper[:-1]
    if not body:
        return False
    # Accept 8B, 27B, 700B and architecture annotations such as A3B/E2B.
    saw_digit = False
    for char in body:
        if char.isdigit():
            saw_digit = True
            continue
        if char in {".", "A", "E", "M"}:
            continue
        return False
    return saw_digit


def is_mixed_quant_token(token: str) -> bool:
    """Return True only for explicit mixed-quantization labels.

    Important: MXFP4/NVFP4/FP4/OptiQ are quantization schemes, not synonyms
    for mixed quantization. A repo such as ``gemma-4-e2b-it-mxfp4`` must be
    reported as quantization ``mxfp4`` with format ``MLX``.
    """
    lower = token.lower()
    return lower in {"mixed", "mixture", "hybrid"}


def normalize_quant_token(token: str) -> str:
    lower = token.lower()
    upper = token.upper()

    # Some artifact names append a model type after the quantization with an
    # underscore, e.g. MXFP4_MOE. Keep the quantization and drop the type. Do
    # not do this for GGUF labels like Q4_K_M, where underscores are integral
    # parts of the quantization name.
    for separator in ("_", "."):
        if separator in lower:
            head, tail = lower.split(separator, 1)
            if tail in MODEL_DESCRIPTOR_TOKENS or tail in LANGUAGE_TOKENS:
                if head.startswith(("mxfp", "nvfp", "fp")) or is_plain_bit_quant(head) or is_int_quant(head):
                    lower = head
                    upper = head.upper()
                    token = head
                    break

    if is_plain_bit_quant(token):
        return lower
    if lower.startswith("mxfp") or lower.startswith("nvfp") or lower.startswith("fp"):
        return lower
    if lower == "optiq":
        return "OptiQ"
    if is_int_quant(token):
        return "Int" + lower[3:]
    if upper in {"GPTQ", "AWQ", "EXL2", "HQQ", "AQLM", "SPQR", "QUIP"}:
        return upper
    if upper in {"F16", "BF16", "Q8_0", "Q4_0", "Q4_1"}:
        return upper
    if upper.startswith("IQ") or upper.startswith("Q"):
        return upper
    return token


def is_quant_start_token(token: str) -> bool:
    upper = token.upper()
    lower = token.lower()
    if is_format_marker_token(token):
        return False
    if upper in {"F16", "BF16", "Q8_0", "Q4_0", "Q4_1"}:
        return True
    if upper.startswith("Q") and len(upper) > 1 and upper[1:2].isdigit():
        return True
    if upper.startswith("IQ") and len(upper) > 2 and upper[2:3].isdigit():
        return True
    # MLX dynamic-quant labels: DQ<digit>… (e.g. DQ3_K_M, DQ4plus). Without
    # this, the fallback parser collapses ``Kimi-K2.5-DQ3_K_M-q8`` into a
    # quant of just ``q8`` and a model name that wrongly carries
    # ``-dq3_k_m`` as a suffix.
    if upper.startswith("DQ") and len(upper) > 2 and upper[2:3].isdigit():
        return True
    if lower.startswith(("mxfp", "nvfp", "fp")):
        return True
    if is_quant_scheme_prefix(token):
        return True
    if is_mixed_quant_token(token):
        return True
    if is_plain_bit_quant(token):
        return True
    if is_int_quant(token):
        return True
    return False


def normalize_quantization_label(raw_quant: str | None, *, format_name: str) -> str | None:
    if not raw_quant:
        return None
    raw = raw_quant.strip("-_")
    if not raw:
        return None

    # Preserve common GGUF UD-* labels exactly as labels, while still keeping
    # GGUF itself as the separate file format.
    if raw.upper().startswith("UD-"):
        return "UD-" + raw[3:].replace("-", "_")

    # Split compound quantization schemes on hyphens only. Underscores are
    # meaningful inside GGUF labels such as Q4_K_M, IQ2_XXS, and Q8_0.
    tokens = [token for token in raw.split("-") if token]
    non_format_tokens = [token for token in tokens if not is_format_marker_token(token)]
    if not non_format_tokens:
        return None

    # Mixed-layer formats: different layers use different numeric formats.
    # Keep this distinct from the storage format/runtime (GGUF or MLX).
    if any(is_mixed_quant_token(token) for token in non_format_tokens):
        return "mixed"

    cleaned = [normalize_quant_token(token) for token in non_format_tokens]

    # If the name contains exactly one quant token, keep that exact quantization
    # label. Examples: ``6bit``, ``mxfp4``, ``nvfp4``, ``Q4_0``.
    if len(cleaned) == 1:
        return cleaned[0]

    # Preserve compound quantization schemes instead of collapsing them. Examples:
    # ``GPTQ-Int4`` -> ``GPTQ-Int4``; ``OptiQ-4bit`` -> ``OptiQ-4bit``;
    # ``MXFP4-Q8`` -> ``mxfp4-Q8``. Use hyphens here because the quantization
    # scheme is a human-facing label, not a Python identifier.
    return "-".join(cleaned)


def creator_name_tokens(creator: str | None) -> list[str]:
    if not creator:
        return []
    return [token for token in creator.replace("_", "-").split("-") if token]


def tokens_match_creator_sequence(tokens: list[str], start: int, creator_tokens: list[str]) -> bool:
    if not creator_tokens:
        return False
    if start + len(creator_tokens) > len(tokens):
        return False
    for offset, creator_token in enumerate(creator_tokens):
        if normalize_creator_token(tokens[start + offset]) != normalize_creator_token(creator_token):
            return False
    return True


def cleaned_name_tokens(name: str, *, creator: str | None) -> list[str]:
    stem = strip_file_extension(name).strip()
    if not stem:
        return []
    raw_tokens = [token.strip() for token in stem.split("-") if token.strip()]
    creator_tokens = creator_name_tokens(creator)
    tokens: list[str] = []
    index = 0
    while index < len(raw_tokens):
        # Only strip multi-token creator markers such as mlx-community when they
        # are literally embedded in an artifact name. Do not strip a single
        # creator token like qwen, mistral, meta, or google because that token is
        # often also part of the model family name. The repo namespace remains
        # the authoritative Creator field.
        if len(creator_tokens) > 1 and tokens_match_creator_sequence(raw_tokens, index, creator_tokens):
            index += len(creator_tokens)
            continue
        token = raw_tokens[index]
        index += 1
        if is_format_marker_token(token):
            continue
        tokens.append(token)
    return tokens


def split_model_and_quant_from_name(name: str, *, format_name: str, creator: str | None = None) -> tuple[str | None, str | None]:
    """Split an artifact name into base model identity and quantization.

    This deliberately uses a negative/subtractive heuristic. Quantization
    schemes change constantly, so the parser avoids maintaining a complete
    positive list of quantization names. It removes creator and format markers,
    keeps the base model name plus conservative TYPE/LANGUAGE descriptors, and
    treats the remaining suffix as the quantization string.
    """
    stem = strip_file_extension(name).strip()
    parts = cleaned_name_tokens(stem, creator=creator)
    if not parts:
        return None, None
    if len(parts) < 2:
        return "-".join(parts), None

    last_param_index = None
    for index, token in enumerate(parts):
        if is_parameter_count_token(token):
            last_param_index = index

    if last_param_index is not None:
        model_tokens = parts[:last_param_index + 1]
        suffix_tokens = parts[last_param_index + 1:]
        quant_start: int | None = None

        for offset, token in enumerate(suffix_tokens):
            # Negative heuristic: after the size anchor, only known model TYPE
            # or LANGUAGE descriptors remain model-name material. The first
            # token that is neither type nor language starts the quantization,
            # regardless of whether the quantization is known today.
            if is_model_descriptor_token(token):
                model_tokens.append(token)
                continue
            quant_start = offset
            break

        if quant_start is None:
            return "-".join(model_tokens).strip("-") or None, None

        quant_tokens = suffix_tokens[quant_start:]
        model_name = "-".join(model_tokens).strip("-")
        raw_quant = "-".join(quant_tokens).strip("-")
        quant = normalize_quantization_label(raw_quant, format_name=format_name)
        return model_name or None, quant or raw_quant or None

    # Fallback parser for names without an obvious B-parameter anchor, such
    # as MiniMax-M2.7-6bit. Walk right-to-left and consume CONSECUTIVE
    # quant-start tokens so that compound MLX schemes like ``DQ3_K_M-q8``
    # or ``MXFP4-Q8`` stay together. The earlier implementation stopped at
    # the first non-descriptor from the right, which collapsed the compound
    # ``DQ3_K_M-q8`` into a quant of just ``q8`` and a model name that
    # carried the rest of the quant (``-dq3_k_m``) as a suffix.
    #
    # Algorithm:
    #   1. Skip descriptors on the right edge (``it``, ``instruct``,
    #      ``coder``, …).
    #   2. On hitting a non-descriptor:
    #      - If it is a quant-start token, begin the quant region and
    #        continue walking left.
    #      - Otherwise treat it as the rightmost suffix (preserves the
    #        original "unknown quant" behaviour: the parser must accept
    #        novel quant labels it does not yet recognise).
    #   3. While inside the quant region, keep extending leftward across
    #      additional quant-start tokens; stop on a descriptor or on the
    #      first plain model-material token.
    quant_start_idx: int | None = None
    for index in range(len(parts) - 1, 0, -1):
        token = parts[index]
        if is_model_descriptor_token(token):
            if quant_start_idx is not None:
                # Descriptor mid-walk closes any pending quant region —
                # descriptors live in the model name, not in quant strings.
                break
            # Pre-quant descriptor on the right edge; keep walking.
            continue
        if is_quant_start_token(token):
            quant_start_idx = index
            continue
        # Plain non-descriptor, non-quant token: model material.
        if quant_start_idx is not None:
            break
        # Original behaviour: accept it as the (unknown) quant candidate
        # so the parser stays useful for novel quant labels.
        quant_start_idx = index
        break

    if quant_start_idx is not None:
        model_name = "-".join(parts[:quant_start_idx]).strip("-")
        raw_quant = "-".join(parts[quant_start_idx:]).strip("-")
        quant = normalize_quantization_label(raw_quant, format_name=format_name)
        return model_name or None, quant or raw_quant or None

    return "-".join(parts).strip("-") or stem, None


def infer_artifact_format(evidence: WhatCanIRunEvidence) -> str:
    file_name = (evidence.hf_file_name or "").lower()
    if file_name.endswith((".gguf", ".bin")):
        return "GGUF"
    if file_name.endswith((".onnx", ".onnxdata", ".data", ".ort")):
        return "ONNX"
    if file_name.endswith((".npz", ".safetensors")):
        # safetensors may also be Transformers weights, but in whatcani.run's
        # mlx_lm entries the repo-level runtime is the strongest signal.
        if (evidence.runtime or "").lower() == "mlx_lm":
            return "MLX"
    runtime = (evidence.runtime or "").lower()
    repo = (evidence.hf_repo_id or "").lower()
    display = (evidence.display_name or "").lower()
    if runtime == "mlx_lm" or "mlx" in repo or "mlx" in display:
        return "MLX"
    if runtime == "llama.cpp":
        return "GGUF"
    if "onnx" in repo or "onnx" in display:
        return "ONNX"
    return runtime.upper() if runtime else "UNKNOWN"


def quantized_artifact_from_evidence(evidence: WhatCanIRunEvidence) -> QuantizedArtifact | None:
    if not evidence.hf_repo_id:
        return None
    creator = repo_creator(evidence.hf_repo_id) or "unknown"
    format_name = infer_artifact_format(evidence)
    # Prefer hf_file_name (always hyphen-clean), then the repo leaf (the
    # part after the slash in ``namespace/repo`` — also hyphen-clean by
    # HF convention). Fall back to display_name only as a last resort:
    # that field routinely contains spaces and parentheses (e.g.
    # ``Llama 3.2 3B Instruct (4-bit)``) that break hyphen tokenization.
    source_name = (
        evidence.hf_file_name
        or repo_leaf(evidence.hf_repo_id)
        or evidence.display_name
        or evidence.hf_repo_id
    )
    source_name = normalize_source_name_for_parsing(source_name)
    model_name, quant = split_model_and_quant_from_name(source_name, format_name=format_name, creator=creator)

    # If a GGUF filename was absent, the repo often ends in -GGUF. Use the repo leaf
    # as a fallback model name, removing the format suffix.
    if not model_name:
        leaf = repo_leaf(evidence.hf_repo_id) or source_name
        if leaf.upper().endswith("-GGUF"):
            leaf = leaf[:-5]
        model_name = leaf
    if not quant:
        quant = evidence.display_name or evidence.hf_file_name or repo_leaf(evidence.hf_repo_id) or "unknown"

    url = huggingface_model_url(evidence)
    command = plain_huggingface_cli_command(evidence)
    if not url or not command:
        return None
    return QuantizedArtifact(
        model_name=model_name,
        creator=creator,
        quantization=quant,
        format=format_name,
        runtime=evidence.runtime,
        hf_repo_id=evidence.hf_repo_id,
        hf_file_name=evidence.hf_file_name,
        display_name=evidence.display_name,
        file_size_gb=evidence.file_size_gb,
        device_types=evidence.device_types,
        url=url,
        download_command=command,
    )


def quantization_sort_key(quantization: str) -> tuple[int, str]:
    text = quantization.upper()
    if text == "MIXED":
        return 8, text
    quality_order = [
        "F16", "BF16", "Q8", "8BIT", "Q6", "6BIT", "Q5", "5BIT",
        "Q4", "4BIT", "IQ4", "Q3", "IQ3", "Q2", "IQ2", "IQ1",
    ]
    for index, marker in enumerate(quality_order):
        if marker in text:
            return index, text
    return len(quality_order) + 1, text


def normalized_model_group_name(model_name: str) -> str:
    # Aggregate case-only variants from different publishers/formats, e.g.
    # gemma-4-26B-A4B-it GGUF and gemma-4-26b-a4b-it MLX.
    return model_name.strip().lower()


def artifact_group_key(artifact: QuantizedArtifact) -> str:
    return normalized_model_group_name(artifact.model_name)


def grouped_quantized_artifacts(evidences: Iterable[WhatCanIRunEvidence]) -> list[tuple[str, list[QuantizedArtifact]]]:
    groups: dict[str, list[QuantizedArtifact]] = {}
    for artifact in quantized_artifacts_from_evidence(evidences):
        groups.setdefault(artifact_group_key(artifact), []).append(artifact)
    for artifacts in groups.values():
        artifacts.sort(key=lambda item: (quantization_sort_key(item.quantization), item.creator.lower(), item.format, item.hf_file_name or item.hf_repo_id))
    result = sorted(groups.items(), key=lambda item: item[0])
    return result


def artifact_compact_line(artifact: QuantizedArtifact) -> str:
    file_ref = artifact.hf_file_name or "entire repo"
    return f"{artifact.quantization} - {artifact.creator} - {file_ref} - {artifact.format}"


def print_artifact(artifact: QuantizedArtifact, prefix: str = "      ") -> None:
    device_types = ",".join(artifact.device_types) if artifact.device_types else "any"
    file_ref = artifact.hf_file_name or "entire repo"
    print(f"{prefix}- {artifact_compact_line(artifact)}")
    print(f"{prefix}  Model-Name: {artifact.model_name}")
    print(f"{prefix}  Quantization: {artifact.quantization}")
    print(f"{prefix}  Creator: {artifact.creator}")
    print(f"{prefix}  Format/runtime: {artifact.format} / {artifact.runtime or 'n/a'}")
    print(f"{prefix}  Devices: {device_types} | file≈{format_gb(artifact.file_size_gb)}")
    print(f"{prefix}  Hugging Face: {artifact.hf_repo_id} :: {file_ref}")
    print(f"{prefix}  URL: {artifact.url}")
    print(f"{prefix}  Download: {artifact.download_command}")



def truncate_cell(value: Any, width: int) -> str:
    text = "" if value is None else str(value)
    if len(text) <= width:
        return text
    return text[: max(0, width - 1)] + "…"


def print_recommendation_table(recommendations: list[Recommendation], limit: int) -> None:
    """Print a compact plain-text table without third-party dependencies."""
    rows = []
    for rank, item in enumerate(recommendations[:limit], start=1):
        rows.append([
            rank,
            item.model.name,
            item.run_status,
            f"{item.coding_score:.1f}",
            f"{item.final_score:.1f}",
            format_gb(item.estimated_required_gb),
            format_gb(item.headroom_gb),
            len(item.whatcanirun_matches),
        ])
    headers = ["#", "Model", "Status", "Coding", "Final", "Req", "Headroom", "Artifacts"]
    widths = [3, 34, 28, 7, 7, 9, 9, 9]
    print("Recommendation summary")
    print("  " + " | ".join(truncate_cell(h, w).ljust(w) for h, w in zip(headers, widths, strict=True)))
    print("  " + "-+-".join("-" * w for w in widths))
    for row in rows:
        print("  " + " | ".join(truncate_cell(v, w).ljust(w) for v, w in zip(row, widths, strict=True)))
    print()

def print_text_report(
    hardware: HardwareProfile,
    recommendations: list[Recommendation],
    limit: int,
    whatcanirun_source: str | None,
    whatcanirun_count: int,
    evidences: list[WhatCanIRunEvidence],
    artifact_groups_limit: int,
    artifacts_per_group: int,
    show_table: bool,
) -> None:
    print("Hardware detected")
    print(f"  OS: {hardware.os_name} {hardware.machine}")
    print(f"  CPU: {hardware.cpu}")
    print(f"  RAM: {hardware.ram_gb:.1f} GB")
    print(f"  GPU(s): {', '.join(hardware.gpu_names) if hardware.gpu_names else 'none detected'}")
    print(f"  GPU VRAM used for fit: {hardware.gpu_vram_gb:.1f} GB")
    if hardware.total_gpu_vram_gb and hardware.total_gpu_vram_gb != hardware.gpu_vram_gb:
        print(f"  Total GPU VRAM seen: {hardware.total_gpu_vram_gb:.1f} GB; largest single GPU: {hardware.largest_single_gpu_vram_gb:.1f} GB")
    print(f"  Unified memory: {'yes' if hardware.unified_memory else 'no'}")
    print(f"  Backend hints: {', '.join(hardware.backend_hints)}")
    if whatcanirun_source:
        print(f"  whatcani.run evidence: {whatcanirun_count} candidates from {whatcanirun_source}")
    else:
        print("  whatcani.run evidence: not used")
    print()

    if show_table:
        print_recommendation_table(recommendations, limit)

    compatible_count = sum(1 for item in recommendations if item.compatible)
    print(f"Compatible models found: {compatible_count}")
    print()

    for rank, item in enumerate(recommendations[:limit], start=1):
        model = item.model
        print(f"{rank}. {model.name} [{item.run_status}]")
        print(f"   Provider: {model.provider or 'n/a'}")
        print(f"   Params/context/license: {model.params or 'n/a'} / {model.context or 'n/a'} / {model.license or 'n/a'}")
        print(f"   Coding score: {item.coding_score:.1f}/100 | final score: {item.final_score:.1f}")
        print(f"   Benchmarks: SWE-bench={model.swe_bench_verified}, HumanEval={model.humaneval}, LiveCodeBench={model.livecodebench}")
        print(f"   Memory basis: {item.memory_basis}; available={format_gb(item.available_memory_gb)}; required≈{format_gb(item.estimated_required_gb)}; headroom={format_gb(item.headroom_gb)}")
        if item.whatcanirun_matches:
            artifacts = quantized_artifacts_from_evidence(item.whatcanirun_matches)
            print(f"   Quantized downloads from whatcani.run: {len(artifacts)} artifact(s)")
            for index, artifact in enumerate(artifacts[:10], start=1):
                print(f"      {index}. {artifact_compact_line(artifact)}")
                print(f"         Model-Name: {artifact.model_name}")
                print(f"         Quantization: {artifact.quantization}")
                print(f"         Creator: {artifact.creator}")
                print(f"         Format/runtime: {artifact.format} / {artifact.runtime or 'n/a'}")
                print(f"         Hugging Face: {artifact.hf_repo_id} :: {artifact.hf_file_name or 'entire repo'}")
                print(f"         URL: {artifact.url}")
                print(f"         Download: {artifact.download_command}")
            if len(artifacts) > 10:
                print(f"      ... {len(artifacts) - 10} more matching artifact(s) in --json output and diagnostic log")
        if item.notes:
            print(f"   Notes: {'; '.join(item.notes)}")
        print(f"   Source: {model.source} - {model.source_url}")
        print()


    groups = grouped_quantized_artifacts(evidences)
    if groups and artifact_groups_limit != 0:
        print("General quantized artifacts discovered from whatcani.run")
        print("  Grouped by Model-Name. Each line starts with quantization, then creator, file/repo, and format.")
        shown_groups = groups if artifact_groups_limit < 0 else groups[:artifact_groups_limit]
        for group_index, (model_name, artifacts) in enumerate(shown_groups, start=1):
            print(f"  {group_index}. {model_name}:")
            shown_artifacts = artifacts if artifacts_per_group < 0 else artifacts[:artifacts_per_group]
            for artifact in shown_artifacts:
                print(f"     - {artifact_compact_line(artifact)}")
                print(f"       Download: {artifact.download_command}")
            if artifacts_per_group >= 0 and len(artifacts) > artifacts_per_group:
                print(f"       ... {len(artifacts) - artifacts_per_group} more artifact(s) for this model in --json output")
        if artifact_groups_limit >= 0 and len(groups) > artifact_groups_limit:
            print(f"  ... {len(groups) - artifact_groups_limit} more model group(s) in --json output")
        print()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recommend compatible local coding LLMs for this computer.")
    parser.add_argument("--version", action="store_true", help="Print the script version and exit")
    parser.add_argument("--context-tokens", type=int, default=32768, help="Target context length for coding use. Default: 32768 (matches the llm-externalizer plugin's hard compatibility threshold; raise it if you need long-context scans, lower it if you are exploring smaller models).")
    parser.add_argument("--min-headroom", type=float, default=0.10, help="Required memory headroom ratio. Default: 0.10")
    parser.add_argument("--limit", type=int, default=10, help="Maximum rows to print. Default: 10 (tuned for the llm-externalizer setup wizard menu; raise for a fuller table).")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of a text report")
    parser.add_argument("--include-incompatible", action="store_true", help="Include incompatible models in output")
    parser.add_argument("--allow-noncommercial", action="store_true", help="Allow non-commercial licenses")
    parser.add_argument("--assume-ram-gb", type=float, default=None, help="Override detected RAM for testing")
    parser.add_argument("--assume-vram-gb", type=float, default=None, help="Override detected GPU VRAM for testing")
    parser.add_argument("--assume-apple-silicon", action="store_true", help="Testing only: simulate a macOS Apple Silicon machine")
    parser.add_argument("--assume-apple-chip", default=None, help="Testing only: Apple chip name to use with --assume-apple-silicon, for example Apple M3 Max")
    parser.add_argument("--allow-multi-gpu", action="store_true", help="Use total VRAM across GPUs. Default uses largest single GPU only.")
    parser.add_argument("--unified-memory-fraction", type=float, default=0.70, help="Apple unified memory fraction to consider usable. Default: 0.70")
    parser.add_argument("--cpu-memory-fraction", type=float, default=0.60, help="System RAM fraction to consider usable for CPU inference. Default: 0.60")
    parser.add_argument("--from-cache", default=None, help="Read Onyx model data from a JSON cache file")
    parser.add_argument("--save-cache", default=None, help="Write retrieved Onyx model data to this JSON cache file")
    parser.add_argument("--url", default=ONYX_SELF_HOSTED_URL, help="Onyx leaderboard URL")
    parser.add_argument("--whatcanirun", choices=("auto", "always", "never"), default="always", help="Consult whatcani.run featured API. Default: always")
    parser.add_argument("--whatcanirun-runtime", choices=("mlx_lm", "llama.cpp"), default=None, help="Override whatcani.run runtime filter")
    parser.add_argument("--whatcanirun-limit", type=int, default=500, help="Maximum matching whatcani.run featured artifacts to keep after all fallback queries. Parameterized public API calls are capped at 50 server-side, but the unfiltered endpoint may return more. Default: 500")
    parser.add_argument("--whatcanirun-featured-url", default=WHATCANIRUN_FEATURED_URL, help="whatcani.run featured JSON API URL")
    parser.add_argument("--network-timeout", type=float, default=DEFAULT_FETCH_TIMEOUT_SECONDS, help=f"Per-request network timeout in seconds. Default: {DEFAULT_FETCH_TIMEOUT_SECONDS:g}")
    parser.add_argument("--network-retries", type=int, default=DEFAULT_NETWORK_RETRIES, help=f"Network attempts per URL. Default: {DEFAULT_NETWORK_RETRIES}")
    parser.add_argument("--retry-delay", type=float, default=DEFAULT_RETRY_DELAY_SECONDS, help=f"Base delay between retries in seconds; multiplied by attempt number. Default: {DEFAULT_RETRY_DELAY_SECONDS:g}")
    parser.add_argument("--whatcanirun-cache", default=None, help="Cache path for whatcani.run API response")
    parser.add_argument("--whatcanirun-from-cache", default=None, help="Read raw whatcani.run API response from JSON")
    parser.add_argument("--save-whatcanirun-cache", default=None, help="Save raw whatcani.run API response to JSON")
    parser.add_argument("--require-whatcanirun", action="store_true", help="Only recommend models with matching whatcani.run evidence")
    parser.add_argument("--artifact-groups-limit", type=int, default=40, help="Maximum model-name artifact groups to print in text output. Default: 40")
    parser.add_argument("--artifacts-per-group", type=int, default=25, help="Maximum quantized artifacts to print per model-name group. Default: 25")
    parser.add_argument("--table", action="store_true", help="Also print a compact recommendation table before the detailed report")
    parser.add_argument("--log-file", default=None, help="Write a diagnostic log to this path. Default: cache directory last-run.log")
    parser.add_argument("--log-max-bytes", type=int, default=DEFAULT_LOG_MAX_BYTES, help=f"Maximum bytes per diagnostic log before rotation. Default: {DEFAULT_LOG_MAX_BYTES}")
    parser.add_argument("--log-backup-count", type=int, default=DEFAULT_LOG_BACKUP_COUNT, help=f"Number of rotated diagnostic logs to keep. Default: {DEFAULT_LOG_BACKUP_COUNT}")
    parser.add_argument("--no-log", action="store_true", help="Disable the diagnostic log file")
    args = parser.parse_args(argv)
    validate_args(args, parser)
    return args


def validate_args(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    """Fail early for invalid options instead of producing odd later behavior."""
    validations = [
        # Plugin's hard requirement is context ≥32K; allow ≥4096 here for
        # standalone CLI users who deliberately want to probe small-context
        # models, but reject the previously-accepted "1" which produced
        # meaningless recommendations.
        (args.context_tokens >= 4096, "--context-tokens must be at least 4096"),
        (0.0 <= args.min_headroom <= 10.0, "--min-headroom must be between 0 and 10"),
        (1 <= args.limit <= 1000, "--limit must be between 1 and 1000"),
        (args.network_timeout > 0, "--network-timeout must be positive"),
        (args.network_retries >= 1, "--network-retries must be at least 1"),
        (args.retry_delay >= 0, "--retry-delay cannot be negative"),
        (0.05 <= args.unified_memory_fraction <= 0.95, "--unified-memory-fraction must be between 0.05 and 0.95"),
        (0.05 <= args.cpu_memory_fraction <= 0.95, "--cpu-memory-fraction must be between 0.05 and 0.95"),
        (args.whatcanirun_limit > 0, "--whatcanirun-limit must be positive"),
        (args.artifact_groups_limit >= 0, "--artifact-groups-limit cannot be negative"),
        (args.artifacts_per_group >= 0, "--artifacts-per-group cannot be negative"),
        (args.log_max_bytes >= 0, "--log-max-bytes cannot be negative"),
        (args.log_backup_count >= 0, "--log-backup-count cannot be negative"),
    ]
    for ok, message in validations:
        if not ok:
            parser.error(message)
    try:
        validate_http_url(args.url, option_name="--url")
        validate_http_url(args.whatcanirun_featured_url, option_name="--whatcanirun-featured-url")
        # T2.14: when running inside the plugin (CLAUDE_PLUGIN_DATA set), pin
        # every cache-arg under the plugin's cache root. Standalone CLI users
        # keep unrestricted paths.
        _validate_cache_path(args.from_cache, option_name="--from-cache")
        _validate_cache_path(args.save_cache, option_name="--save-cache")
        _validate_cache_path(args.whatcanirun_cache, option_name="--whatcanirun-cache")
        _validate_cache_path(args.whatcanirun_from_cache, option_name="--whatcanirun-from-cache")
        _validate_cache_path(args.save_whatcanirun_cache, option_name="--save-whatcanirun-cache")
    except ValueError as exc:
        parser.error(str(exc))


def validate_model_cache_payload(value: Any, *, source: str) -> list[ModelRecord]:
    if not isinstance(value, list):
        raise ValueError(f"{source} must contain a JSON list of model records")
    models: list[ModelRecord] = []
    errors: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            errors.append(f"item {index} is {type(item).__name__}, expected object")
            continue
        try:
            models.append(model_from_dict(item))
        except TypeError as exc:
            errors.append(f"item {index}: {exc}")
    if errors:
        logging.warning("model_cache_validation_errors source=%s errors=%s", source, errors[:5])
    if not models:
        raise ValueError(f"{source} did not contain any valid model records")
    return models


def load_models(args: argparse.Namespace) -> list[ModelRecord]:
    if args.from_cache:
        logging.info("onyx_load_from_cache path=%s", args.from_cache)
        models = validate_model_cache_payload(load_json(args.from_cache), source=args.from_cache)
        logging.info("onyx_cache_loaded models=%d", len(models))
        return models
    page_html = fetch_text(args.url, timeout=args.network_timeout, retries=args.network_retries, retry_delay=args.retry_delay)
    models = parse_onyx_models(page_html)
    if not models:
        logging.error("onyx_parse_no_models url=%s html_prefix=%r", args.url, page_html[:500])
        raise RuntimeError("No models parsed from the Onyx source page")
    logging.info("onyx_models_loaded count=%d sample=%s", len(models), [model.name for model in models[:10]])
    if args.save_cache:
        save_json(args.save_cache, [model_to_dict(model) for model in models])
        logging.info("onyx_cache_saved path=%s models=%d", args.save_cache, len(models))
    return models


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.version:
        print(SCRIPT_VERSION)
        return 0
    log_path = None if args.no_log else (args.log_file or default_log_path())
    log_path = setup_logging(log_path, max_bytes=args.log_max_bytes, backup_count=args.log_backup_count)
    if log_path:
        logging.info("argv=%s", json.dumps(safe_argv_for_log(sys.argv), ensure_ascii=False))
        logging.info("options=%s", json.dumps(safe_args_for_log(args), ensure_ascii=False, sort_keys=True))
    whatcanirun_source: str | None = None
    whatcanirun_error: str | None = None
    evidences: list[WhatCanIRunEvidence] = []
    whatcanirun_diagnostics: dict[str, Any] | None = None
    try:
        models = load_models(args)
        hardware = apply_hardware_cli_overrides(args, detect_hardware(args.assume_ram_gb, args.assume_vram_gb, args.allow_multi_gpu))
        try:
            evidences, whatcanirun_source, whatcanirun_diagnostics = load_whatcanirun_evidence(args, hardware)
        except (RuntimeError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            if args.require_whatcanirun:
                raise RuntimeError(f"failed to consult whatcani.run: {exc}") from exc
            whatcanirun_error = str(exc)
            logging.exception("whatcanirun_unhandled_failure_continuing error=%s", exc)
        models = merge_onyx_models_with_artifact_backfill(models, evidences)
        logging.info("models_after_artifact_backfill count=%d qwen=%s", len(models), [model.name for model in models if "qwen" in model.name.lower()][:30])
        recommendations = recommend_models(
            models=models,
            hardware=hardware,
            evidences=evidences,
            context_tokens=args.context_tokens,
            min_headroom=args.min_headroom,
            allow_noncommercial=args.allow_noncommercial,
            include_incompatible=args.include_incompatible,
            require_whatcanirun=args.require_whatcanirun,
            unified_memory_fraction=args.unified_memory_fraction,
            cpu_memory_fraction=args.cpu_memory_fraction,
        )
        if log_path:
            write_success_diagnostic_log(
                args=args,
                log_path=log_path,
                hardware=hardware,
                models=models,
                evidences=evidences,
                recommendations=recommendations,
                whatcanirun_source=whatcanirun_source,
                whatcanirun_error=whatcanirun_error,
                whatcanirun_diagnostics=whatcanirun_diagnostics,
            )
    except (RuntimeError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        if log_path:
            write_error_diagnostic_log(args=args, log_path=log_path, error=exc)
        print(f"error: {exc}", file=sys.stderr)
        print("hint: retry later, or use --from-cache / --whatcanirun-from-cache with a previously saved JSON cache", file=sys.stderr)
        if log_path:
            print(f"diagnostic log: {os.path.abspath(log_path)}", file=sys.stderr)
        return 2

    if args.json:
        payload = {
            "schema_version": RECOMMEND_MODELS_SCHEMA_VERSION,
            "generated_at_unix": int(time.time()),
            "source": args.url,
            "whatcanirun_source": whatcanirun_source,
            "whatcanirun_error": whatcanirun_error,
            "whatcanirun_diagnostics": whatcanirun_diagnostics,
            "diagnostic_log": os.path.abspath(log_path) if log_path else None,
            "hardware": dataclasses.asdict(hardware),
            "recommendations": [recommendation_to_dict(item) for item in recommendations[: args.limit]],
            "quantized_artifact_groups": [
                {
                    "model_name": model_name,
                    "artifacts": [artifact_to_dict(artifact) for artifact in artifacts],
                }
                for model_name, artifacts in grouped_quantized_artifacts(evidences)
            ],
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        if log_path:
            print(f"Diagnostic log saved to: {os.path.abspath(log_path)}", file=sys.stderr)
    else:
        if whatcanirun_error:
            print(f"Warning: could not consult whatcani.run ({whatcanirun_error}). Continuing with Onyx estimates only.", file=sys.stderr)
        print_text_report(hardware, recommendations, args.limit, whatcanirun_source, len(evidences), evidences, args.artifact_groups_limit, args.artifacts_per_group, args.table)
        if log_path:
            print(f"Diagnostic log saved to: {os.path.abspath(log_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
