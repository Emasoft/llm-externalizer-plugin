#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml"]
# ///
"""Profile helper for the shared llm-ext settings.yaml (TRDD-6HGJFPDR sibling work).

WHY THIS EXISTS: ~/.llm-externalizer/settings.yaml is machine-global and 20+ agents
write to it. Two of them edited one profile's tool_models twenty minutes apart on
2026-08-29, each correct from its own evidence, and the config ended up in a state
neither chose. Nothing errored. This tool makes ownership and validity visible
BEFORE an edit, and it never writes.

READ-ONLY BY DESIGN. It prints; you edit. A script that rewrote the shared config
would be the very failure mode it exists to prevent.

  list       every profile, its models, whether it is active
  validated  paid models with a PASSING ledger row (what you may safely pin)
  check <p>  lint one profile: schema, :free suffixes, IRON-RULE exposure
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import yaml

CONFIG = Path(os.environ.get("LLM_EXT_CONFIG_DIR", Path.home() / ".llm-externalizer"))
SETTINGS = CONFIG / "settings.yaml"

# Presets accepted by config.ts::API_PRESETS. Verified 2026-08-29 against
# `llm-ext settings status`, which prints the live list — re-check there if a
# profile is rejected for an api this tool considers valid.
PRESETS = {
    "lmstudio-local", "ollama-local", "vllm-local",
    "llamacpp-local", "generic-local", "openrouter-remote",
}
MODES = {"local", "remote", "remote-ensemble"}

# Ledger -> pass predicate, mirroring benchmark/validated.ts. The deterministic
# per-tool ledgers store no score.pass: a run PASSED iff failureReasons is empty
# (an errored/empty/429 run has a non-empty list). security-triage is the
# exception and carries score.pass, where an `inconclusive` run is NOT a pass.
DETERMINISTIC = [
    "code-task-results.json",
    "scan-folder-results.json",
    "check-specs-results.json",
    "search-existing-results.json",
]


def load_settings() -> dict:
    if not SETTINGS.exists():
        sys.exit(f"no settings at {SETTINGS}")
    return yaml.safe_load(SETTINGS.read_text()) or {}


def _latest_per_model(path: Path) -> dict[str, dict]:
    """Keyed `modelId::date::hash` ledger -> the most recent row per model.

    A missing or unparseable ledger yields {} — which makes every model look
    UNVALIDATED. That is deliberate and matches validated.ts: absence of proof is
    never proof of a pass.
    """
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    latest: dict[str, tuple[str, dict]] = {}
    for key, row in raw.items():
        if not isinstance(row, dict):
            continue
        model = key.split("::")[0]
        date = row.get("date", "") if isinstance(row.get("date"), str) else ""
        prev = latest.get(model)
        if prev is None or date > prev[0]:
            latest[model] = (date, row)
    return {m: r for m, (_, r) in latest.items()}


def validated_models() -> dict[str, set[str]]:
    """tool-ledger -> set of models with a PASSING latest row."""
    out: dict[str, set[str]] = {}
    for name in DETERMINISTIC:
        passed = set()
        for model, row in _latest_per_model(CONFIG / name).items():
            reasons = row.get("failureReasons")
            if isinstance(reasons, list) and len(reasons) == 0:
                passed.add(model)
        out[name] = passed
    triage = set()
    for model, row in _latest_per_model(CONFIG / "security-triage-results.json").items():
        score = row.get("score")
        if isinstance(score, dict) and score.get("pass") is True and score.get("inconclusive") is not True:
            triage.add(model)
    out["security-triage-results.json"] = triage
    # Rank-0 floor: validates every command that has no dedicated benchmark.
    keyword = set()
    for model, row in _latest_per_model(CONFIG / "general-keyword-results.json").items():
        if row.get("ok") is True and row.get("pass") is True and row.get("schemaCompliant") is not False:
            keyword.add(model)
    out["general-keyword-results.json (rank-0 floor)"] = keyword
    return out


def cmd_list() -> int:
    s = load_settings()
    active = s.get("active")
    paid = s.get("allow_paid_models") is True
    print(f"settings: {SETTINGS}")
    print(f"allow_paid_models: {paid}   (absent/false => only FREE models, everywhere)")
    print()
    for name, p in (s.get("profiles") or {}).items():
        if not isinstance(p, dict):
            continue
        mark = "* " if name == active else "  "
        models = [p.get("model")]
        for k in ("second_model", "third_model"):
            if p.get(k):
                models.append(p[k])
        pins = p.get("tool_models") or {}
        pool = p.get("free_models") or []
        print(f"{mark}{name}  [{p.get('mode')}/{p.get('api')}]")
        print(f"    models: {', '.join(m for m in models if m)}")
        if pins:
            distinct = sorted(set(pins.values()))
            print(f"    tool_models: {len(pins)} pin(s) -> {', '.join(distinct)}")
        if pool:
            print(f"    free_models: {len(pool)} entry(ies)")
    print("\n* = active. Use --profile <name> instead of changing it.")
    return 0


def cmd_validated() -> int:
    print("Models with a PASSING ledger row (what a PAID pin may safely use).")
    print("':free' models are IRON-RULE exempt and need none of this.\n")
    for ledger, models in validated_models().items():
        paid = sorted(m for m in models if not m.endswith(":free"))
        free = sorted(m for m in models if m.endswith(":free"))
        print(f"{ledger}")
        print(f"    paid passers: {', '.join(paid) if paid else '(none)'}")
        print(f"    free passers: {len(free)} (exempt anyway)")
    print("\nNo row for a paid model => it REFUSES at $0. Benchmark it, or pin a ':free' one.")
    return 0


def cmd_check(name: str) -> int:
    s = load_settings()
    p = (s.get("profiles") or {}).get(name)
    if not isinstance(p, dict):
        sys.exit(f"no profile '{name}' in {SETTINGS}")
    problems: list[str] = []
    for field in ("mode", "api", "model"):
        if not p.get(field):
            problems.append(f"missing required field '{field}'")
    if p.get("mode") and p["mode"] not in MODES:
        problems.append(f"mode '{p['mode']}' not in {sorted(MODES)}")
    if p.get("api") and p["api"] not in PRESETS:
        problems.append(f"api '{p['api']}' not a known preset {sorted(PRESETS)}")
    for entry in p.get("free_models") or []:
        if not str(entry).endswith(":free"):
            problems.append(f"free_models entry '{entry}' lacks the ':free' suffix (rejected by the validator)")
    if p.get("mode") != "remote-ensemble":
        for k in ("second_model", "third_model"):
            if p.get(k):
                problems.append(f"'{k}' is ignored unless mode is remote-ensemble — a silent no-op")

    paid_enabled = s.get("allow_paid_models") is True
    ledgers = validated_models()
    # A tool is validated by ITS OWN ledger, or by a HARDER one — the hierarchy is
    # DIRECTIONAL. Unioning every ledger (the first version of this function) let a
    # rank-0 keyword pass vouch for code_task, which is exactly backwards and would
    # have blessed the very misconfiguration this tool exists to catch.
    RANK0 = "general-keyword-results.json (rank-0 floor)"
    TOOL_LEDGER = {
        "security_scan": "security-triage-results.json",
        "code_task": "code-task-results.json",
        "scan_folder": "scan-folder-results.json",
        "check_against_specs": "check-specs-results.json",
        "search_existing_implementations": "search-existing-results.json",
        "mass_scout": RANK0,  # its benchmark IS the keyword sweep
        # Text-tool benchmarks write their own ledgers; absent file => no rows => refuse.
        "summarize": "text-summarize-results.json",
        "topics": "text-topics-results.json",
        "sem_deduplicate": "text-sem-dedup-results.json",
        "describe": "text-describe-results.json",
        # No dedicated benchmark: the rank-0 floor is what validates these.
        "cluster_synonyms": RANK0,
        "check_references": RANK0,
        "check_imports": RANK0,
        "compare_files": RANK0,
        "chat": RANK0,
    }

    def validated_for(tool: str, model: str) -> bool:
        if model.endswith(":free"):
            return True  # IRON-RULE exempt
        name = TOOL_LEDGER.get(tool)
        if name is None:  # the bare profile model, tool unknown here
            return any(model in ms for ms in ledgers.values())
        if model in ledgers.get(name, set()):
            return True
        # A harder pass covers an easier tool: any DEDICATED per-tool pass
        # outranks the rank-0 floor.
        if name == RANK0:
            return any(model in ledgers[k] for k in ledgers if k != RANK0)
        return False

    pins = dict(p.get("tool_models") or {})
    unvalidated = [
        f"{tool} -> {m}" for tool, m in sorted(pins.items())
        if m and not validated_for(tool, m)
    ]
    bare = p.get("model", "")
    if bare and not bare.endswith(":free") and not validated_for("", bare) and not pins:
        unvalidated.append(f"(profile model) -> {bare}")

    print(f"profile: {name}")
    for problem in problems:
        print(f"  SCHEMA   {problem}")
    if unvalidated and paid_enabled:
        print("  IRON RULE  paid model with NO passing ledger row — these refuse at $0:")
        for u in unvalidated:
            print(f"             {u}")
    elif unvalidated:
        print("  note     paid pins present but allow_paid_models is false, so free mode")
        print("           overrides them anyway; they would refuse if it were enabled.")
    if not problems and not unvalidated:
        print("  OK       schema valid; no unvalidated paid pins")
    return 1 if problems else 0


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] in {"-h", "--help"}:
        print(__doc__)
        return 0
    cmd, *rest = argv
    if cmd == "list":
        return cmd_list()
    if cmd == "validated":
        return cmd_validated()
    if cmd == "check":
        if not rest:
            sys.exit("check needs a profile name")
        return cmd_check(rest[0])
    sys.exit(f"unknown command '{cmd}' (list | validated | check <profile>)")


if __name__ == "__main__":
    raise SystemExit(main())
