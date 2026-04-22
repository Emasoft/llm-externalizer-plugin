#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["ruamel.yaml>=0.18"]
# ///
"""
Dump the current ensemble-picking state as JSON on stdout.

Invoked by the `/llm-externalizer:llm-externalizer-change-model` command
before showing any menu, so the orchestrator has the full picture with
one subprocess call.

Output schema (single JSON object on stdout):

    {
      "settingsPath": "/Users/.../.llm-externalizer/settings.yaml",
      "settingsExists": true,
      "activeProfile": "remote-ensemble-geminigrok",
      "activeMode": "remote-ensemble",
      "currentEnsemble": {
        "model": "google/gemini-3-flash-preview",
        "second_model": "x-ai/grok-4.1-fast",
        "third_model": "qwen/qwen3.6-plus"
      },
      "previousSnapshot": {
        "lastAcceptedAt": "2026-04-22T20:00:00+0200",
        "activeProfile": "remote-ensemble-geminigrok",
        "members": [
          {"id": "...", "actualCost": 0.00426, "inputDollarsPerMillion": 0.5, ...},
          ...
        ],
        "totalCost": 0.0227
      } | null,
      "benchmarkCache": {
        "path": "/Users/.../.llm-externalizer/benchmark-results.json",
        "timestamp": "2026-04-22T19:53:32+00:00",
        "ageSeconds": 420
      } | null,
      "errors": []  # empty on success; otherwise list of human-readable strings
    }

No mutations. Safe to call repeatedly.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML

CONFIG_DIR = Path.home() / ".llm-externalizer"
SETTINGS_PATH = CONFIG_DIR / "settings.yaml"
ENSEMBLE_COST_PATH = CONFIG_DIR / "ensemble-cost.json"
BENCHMARK_CACHE_PATH = CONFIG_DIR / "benchmark-results.json"


def load_yaml(path: Path) -> Any:
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    with path.open("r", encoding="utf-8") as f:
        return yaml.load(f)


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    out: dict[str, Any] = {
        "settingsPath": str(SETTINGS_PATH),
        "settingsExists": SETTINGS_PATH.exists(),
        "activeProfile": None,
        "activeMode": None,
        "currentEnsemble": None,
        "previousSnapshot": None,
        "benchmarkCache": None,
        "errors": [],
    }

    # Settings.yaml: active profile + current ensemble fields.
    if SETTINGS_PATH.exists():
        try:
            data = load_yaml(SETTINGS_PATH)
            if not isinstance(data, dict):
                out["errors"].append(f"{SETTINGS_PATH} is not a YAML mapping")
            else:
                active = data.get("active")
                profiles = data.get("profiles") or {}
                if active and active in profiles:
                    prof = profiles[active]
                    out["activeProfile"] = active
                    out["activeMode"] = prof.get("mode") if isinstance(prof, dict) else None
                    if isinstance(prof, dict):
                        out["currentEnsemble"] = {
                            "model": prof.get("model"),
                            "second_model": prof.get("second_model"),
                            "third_model": prof.get("third_model"),
                        }
                elif active:
                    out["errors"].append(
                        f"active profile '{active}' not found under profiles:"
                    )
        except Exception as exc:
            out["errors"].append(f"failed to read {SETTINGS_PATH}: {exc}")

    # Previous accepted ensemble snapshot.
    if ENSEMBLE_COST_PATH.exists():
        try:
            out["previousSnapshot"] = load_json(ENSEMBLE_COST_PATH)
        except Exception as exc:
            out["errors"].append(f"failed to read {ENSEMBLE_COST_PATH}: {exc}")

    # Cached benchmark results freshness.
    if BENCHMARK_CACHE_PATH.exists():
        try:
            cache = load_json(BENCHMARK_CACHE_PATH)
            ts_raw = cache.get("timestamp")
            age_seconds: int | None = None
            if ts_raw:
                try:
                    # renderJson writes ISO-8601 via Date.toISOString() which
                    # ends in "Z" — parse as UTC.
                    ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    age_seconds = int((datetime.now(timezone.utc) - ts).total_seconds())
                except Exception:
                    pass
            out["benchmarkCache"] = {
                "path": str(BENCHMARK_CACHE_PATH),
                "timestamp": ts_raw,
                "ageSeconds": age_seconds,
            }
        except Exception as exc:
            out["errors"].append(f"failed to read {BENCHMARK_CACHE_PATH}: {exc}")

    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
