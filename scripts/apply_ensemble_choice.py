#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["ruamel.yaml>=0.18"]
# ///
"""
Atomically update the active profile's ensemble model fields in
~/.llm-externalizer/settings.yaml and record the new ensemble cost
snapshot in ~/.llm-externalizer/ensemble-cost.json.

Does NOT touch the profile's `mode` (local/remote/remote-ensemble) —
the benchmark and this change-model workflow are mode-agnostic; the
user chose the mode deliberately via /plugin configure or by hand,
and this script preserves that choice.

Writes are atomic: modify a temp file alongside the target, fsync, then
`os.replace` it into place. A timestamped backup of the pre-edit
settings.yaml is kept so the user can revert without guessing.

Usage:
    apply_ensemble_choice.py \\
        --model <id1> --second-model <id2> --third-model <id3> \\
        --bench-json ~/.llm-externalizer/benchmark-results.json

Exits 0 on success, non-zero with a single-line stderr message on
failure. On success, prints a compact JSON summary on stdout:

    {
      "activeProfile": "remote-ensemble-geminigrok",
      "activeMode": "remote-ensemble",
      "backup": "/Users/.../.llm-externalizer/settings.yaml.bak.20260422T205500+0200",
      "ensembleCostPath": "/Users/.../.llm-externalizer/ensemble-cost.json",
      "newTotalCost": 0.01234
    }
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, NoReturn

from ruamel.yaml import YAML

CONFIG_DIR = Path.home() / ".llm-externalizer"
SETTINGS_PATH = CONFIG_DIR / "settings.yaml"
ENSEMBLE_COST_PATH = CONFIG_DIR / "ensemble-cost.json"


def die(msg: str, code: int = 1) -> NoReturn:
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(code)


def local_timestamp() -> str:
    """Local-time-with-GMT-offset timestamp, filesystem-safe (no colons in offset)."""
    return datetime.now().astimezone().strftime("%Y%m%dT%H%M%S%z")


def atomic_write_text(path: Path, content: str) -> None:
    """Write `content` to `path` atomically — temp file + fsync + rename.

    Uses the same directory for the temp file so `os.replace` is a
    same-filesystem rename (guaranteed atomic). `fsync` forces the
    temp file's content to disk before the rename is visible.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path_str = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise


def load_bench_json(bench_json_path: Path) -> dict[str, Any]:
    if not bench_json_path.exists():
        die(f"benchmark JSON not found: {bench_json_path}")
    with bench_json_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def find_result(bench: dict[str, Any], model_id: str) -> dict[str, Any]:
    for r in bench.get("results", []):
        if r.get("modelId") == model_id:
            return r
    die(f"model '{model_id}' not found in benchmark results — re-run the benchmark")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="first model id")
    ap.add_argument("--second-model", required=True, help="second model id")
    ap.add_argument("--third-model", required=True, help="third model id")
    ap.add_argument("--bench-json", required=True, help="path to benchmark JSON (with actualCost for each picked model)")
    args = ap.parse_args()

    if not SETTINGS_PATH.exists():
        die(f"settings.yaml not found at {SETTINGS_PATH} — run /plugin configure llm-externalizer first")

    # ── Load settings.yaml preserving comments/quotes. ──────────────────
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    yaml.indent(mapping=2, sequence=4, offset=2)
    with SETTINGS_PATH.open("r", encoding="utf-8") as f:
        data = yaml.load(f)

    if not isinstance(data, dict):
        die(f"{SETTINGS_PATH} is not a YAML mapping")

    active = data.get("active")
    if not active:
        die(f"{SETTINGS_PATH} has no 'active' profile set")
    profiles = data.get("profiles")
    if not isinstance(profiles, dict) or active not in profiles:
        die(f"active profile '{active}' not found under profiles: in {SETTINGS_PATH}")
    profile = profiles[active]
    if not isinstance(profile, dict):
        die(f"profile '{active}' is not a YAML mapping")

    # ── Update the three ensemble fields; do NOT touch mode/api/auth. ──
    preserved_mode = profile.get("mode")
    profile["model"] = args.model
    profile["second_model"] = args.second_model
    profile["third_model"] = args.third_model

    # ── Backup + atomic write of settings.yaml. ────────────────────────
    ts = local_timestamp()
    backup_path = SETTINGS_PATH.with_suffix(SETTINGS_PATH.suffix + f".bak.{ts}")
    backup_path.write_text(SETTINGS_PATH.read_text(encoding="utf-8"), encoding="utf-8")

    import io
    buf = io.StringIO()
    yaml.dump(data, buf)
    atomic_write_text(SETTINGS_PATH, buf.getvalue())

    # ── Record the new ensemble cost snapshot. ─────────────────────────
    bench = load_bench_json(Path(args.bench_json))

    def cost_for(mid: str) -> dict[str, Any]:
        r = find_result(bench, mid)
        if not r.get("ok") or not r.get("pass"):
            die(
                f"model '{mid}' did not PASS in the benchmark — refusing to record "
                f"ensemble cost for a non-passing model. Re-run the benchmark or "
                f"pick a different model."
            )
        return {
            "id": r["modelId"],
            "actualCost": r.get("actualCost", 0.0),
            "inputTokens": r.get("inputTokens", 0),
            "outputTokens": r.get("outputTokens", 0),
            "reasoningTokens": r.get("reasoningTokens", 0),
            "inputDollarsPerMillion": r.get("inputDollarsPerMillion", 0.0),
            "outputDollarsPerMillion": r.get("outputDollarsPerMillion", 0.0),
            "latencyMs": r.get("latencyMs", 0),
            "schemaCompliant": r.get("schemaCompliant", True),
            "meanF1": r.get("meanF1", 0.0),
        }

    members = [cost_for(args.model), cost_for(args.second_model), cost_for(args.third_model)]
    total_cost = sum(m["actualCost"] for m in members)
    snapshot = {
        "lastAcceptedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "activeProfile": active,
        "activeMode": preserved_mode,
        "benchmarkTimestamp": bench.get("timestamp"),
        "members": members,
        "totalCost": total_cost,
    }
    atomic_write_text(ENSEMBLE_COST_PATH, json.dumps(snapshot, indent=2) + "\n")

    # ── Report. ────────────────────────────────────────────────────────
    json.dump(
        {
            "activeProfile": active,
            "activeMode": preserved_mode,
            "backup": str(backup_path),
            "ensembleCostPath": str(ENSEMBLE_COST_PATH),
            "newTotalCost": total_cost,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
