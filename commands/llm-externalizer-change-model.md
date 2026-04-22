---
name: llm-externalizer-change-model
description: Interactively pick a new 3-model OpenRouter ensemble for the active profile. Runs the benchmark (or reuses a cached one), presents a menu per slot (first / second / third), shows the new ensemble's cost vs the last accepted snapshot, and on confirmation atomically updates ~/.llm-externalizer/settings.yaml. Never touches the profile's mode (local/remote/remote-ensemble) — that stays as the user configured it.
allowed-tools:
  - Bash
  - AskUserQuestion
argument-hint: "(no arguments — the whole flow is interactive)"
effort: medium
---

## What this command does

1. Reads the current active profile + the last-accepted ensemble snapshot.
2. Asks whether to run a **fresh benchmark** or **reuse the cached results** (if a cache exists), with the cache's timestamp shown in the menu label.
3. Runs `bin/llm-ext-benchmark` (when fresh) and parses the JSON sidecar from `~/.llm-externalizer/benchmark-results.json`.
4. Shows three sequential `AskUserQuestion` menus — SELECT FIRST MODEL, SELECT SECOND MODEL, SELECT THIRD MODEL — each listing the passing models with their per-call cost, latency, F1, and schema-compliance status. Already-picked models are removed from subsequent menus.
5. Computes the new ensemble's cost (sum of the three picks' actual per-call costs from the benchmark) and compares against the last-accepted snapshot. The delta is reported as a %; the user sees both absolute and relative.
6. Asks Accept / Retry / Cancel.
7. On **Accept**: runs `apply_ensemble_choice.py` which atomically rewrites the active profile's `model`/`second_model`/`third_model` fields in `settings.yaml` (keeping comments, quotes, and the profile's `mode` intact), saves a timestamped backup next to it, and records the new ensemble in `~/.llm-externalizer/ensemble-cost.json`.
8. On **Retry**: loops back to step 4, reusing the same benchmark results (no second benchmark run).
9. On **Cancel**: exits clean; no file is modified.

**Mode preservation (CRITICAL):** this command and the benchmark itself are **mode-agnostic**. They always benchmark via OpenRouter regardless of whether the active profile is `local`, `remote`, or `remote-ensemble`. On accept, only the three ensemble-model fields are updated — `mode`, `api`, `url`, `api_key`, `api_token`, timeouts, context-window overrides all stay byte-for-byte unchanged.

## Step 0 — Read current state

```bash
STATE_JSON=$(uv run --quiet --with 'ruamel.yaml>=0.18' "${CLAUDE_PLUGIN_ROOT}/scripts/read_ensemble_state.py")
printf '%s\n' "$STATE_JSON"
```

Parse the JSON (with `python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["field"])'` or `jq` if available) to extract:

- `.settingsExists` — must be true; otherwise abort with `[FAILED] llm-externalizer-change-model — settings.yaml missing. Run /plugin configure llm-externalizer first.`
- `.activeProfile` — name of the profile we'll be modifying (just for display).
- `.activeMode` — shown to the user (and preserved).
- `.currentEnsemble` — the three current IDs (shown for context).
- `.previousSnapshot` — null on first run, else `{lastAcceptedAt, totalCost, members}`.
- `.benchmarkCache` — null or `{path, timestamp, ageSeconds}`.

Echo the `.errors` array (if any) to stderr and abort if non-empty.

## Step 1 — Benchmark freshness choice

If `.benchmarkCache` is present (not null), ask via `AskUserQuestion`:

- `question`: `"Benchmark data source?"`
- options (Run fresh is default — first position, the user can press Enter):
  1. `"Run fresh benchmark"` — description: `"Re-query OpenRouter and re-score every candidate now. Takes ~1–3 min and costs <$0.10."`
  2. `"Use cached (from <HUMAN_AGE_OR_TIMESTAMP>)"` — description: `"Skip the benchmark and use the existing results at ~/.llm-externalizer/benchmark-results.json. Timestamp: <.benchmarkCache.timestamp>."`

`<HUMAN_AGE_OR_TIMESTAMP>` is built from `.benchmarkCache.ageSeconds` via shell:

```bash
fmt_age() {
  local s="$1"
  [ -z "$s" ] || [ "$s" = "null" ] && { printf 'unknown age'; return; }
  if [ "$s" -lt 90 ]; then printf '%ss ago' "$s"
  elif [ "$s" -lt 5400 ]; then printf '%dm ago' $((s/60))
  elif [ "$s" -lt 172800 ]; then printf '%dh ago' $((s/3600))
  else printf '%dd ago' $((s/86400))
  fi
}
```

If `.benchmarkCache` is null (no cache), skip the question — always run fresh.

## Step 2 — Run benchmark (unless user chose cached)

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark"
```

The benchmark auto-saves the JSON sidecar to `~/.llm-externalizer/benchmark-results.json` (no flag needed). If the benchmark exits non-zero, surface its last stderr line and abort.

## Step 3 — Parse benchmark results, filter to passers

```bash
BENCH_JSON="$HOME/.llm-externalizer/benchmark-results.json"
test -f "$BENCH_JSON" || { echo "[FAILED] llm-externalizer-change-model — benchmark JSON missing at $BENCH_JSON"; exit 1; }

# Extract compact passing-model table (id, actualCost, latencyMs, meanF1, schemaCompliant, context, out, $/M in, $/M out)
python3 - "$BENCH_JSON" <<'PY'
import json, sys
with open(sys.argv[1]) as f: bench = json.load(f)
passing = [r for r in bench["results"] if r.get("ok") and r.get("pass")]
passing.sort(key=lambda r: r["actualCost"])  # cheapest first
for r in passing:
    print(f'{r["modelId"]}\t{r["actualCost"]:.5f}\t{r["latencyMs"]:.0f}\t{r["meanF1"]*100:.1f}\t{"yes" if r.get("schemaCompliant", True) else "SHORT-NAMES"}\t{r["contextTokens"]}\t{r["maxOutputTokens"]}\t{r["inputDollarsPerMillion"]:.3f}\t{r["outputDollarsPerMillion"]:.3f}')
PY
```

Each tab-delimited row is one passing candidate. If zero rows, abort with `[FAILED] llm-externalizer-change-model — no models passed the benchmark. Loosen the filter in discover.ts or re-run.`

## Step 4 — SELECT FIRST MODEL / SECOND / THIRD (loop-restartable)

Build an `AskUserQuestion` for each slot. The option labels include full model id + cost + latency; descriptions include F1, context, max output, schema compliance, and $/M rates. Example label: `"stepfun/step-3.5-flash — $0.0019 · 18s"`. Example description: `"F1 100.0% · ctx 262K · out 64K · $0.10 in / $0.30 out per M · schema ✓"`.

- For **SELECT FIRST MODEL**, include all passing candidates.
- For **SELECT SECOND MODEL**, exclude the first pick.
- For **SELECT THIRD MODEL**, exclude the first two picks.

Store the three picks in shell variables (`PICK_1`, `PICK_2`, `PICK_3`) — these are the model IDs, NOT the label strings.

## Step 5 — Compute costs + show comparison

```bash
python3 - "$BENCH_JSON" "$PICK_1" "$PICK_2" "$PICK_3" "$HOME/.llm-externalizer/ensemble-cost.json" <<'PY'
import json, sys, os
bench_path, p1, p2, p3, prev_path = sys.argv[1:6]
with open(bench_path) as f: bench = json.load(f)
by_id = {r["modelId"]: r for r in bench["results"] if r.get("ok") and r.get("pass")}
picks = [by_id.get(p) for p in (p1, p2, p3)]
if any(p is None for p in picks):
    print("INVALID_PICK", file=sys.stderr); sys.exit(2)
new_total = sum(p["actualCost"] for p in picks)

prev = None
if os.path.exists(prev_path):
    with open(prev_path) as f: prev = json.load(f)

report = {
    "picks": [{"id": p["modelId"], "cost": p["actualCost"], "latencyMs": p["latencyMs"],
               "meanF1": p["meanF1"], "schemaCompliant": p.get("schemaCompliant", True)} for p in picks],
    "newTotal": new_total,
    "previousTotal": prev["totalCost"] if prev else None,
    "previousAt":    prev["lastAcceptedAt"] if prev else None,
    "previousMembers": [m["id"] for m in prev.get("members", [])] if prev else None,
}
if prev and prev.get("totalCost", 0) > 0:
    report["deltaPct"] = (new_total - prev["totalCost"]) / prev["totalCost"] * 100
else:
    report["deltaPct"] = None
print(json.dumps(report, indent=2))
PY
```

Surface to the user:

- `NEW ENSEMBLE` heading
- One line per pick: `  N. <modelId> — $<cost>/call · <latency>ms · F1 <pct>% · schema <yes|SHORT-NAMES>`
- `  Total: $<newTotal>/call`
- If `previousTotal` is not null:
  - `PREVIOUS ENSEMBLE (accepted <previousAt>)`
  - `  members: <comma-list of previousMembers>`
  - `  Total: $<previousTotal>/call`
  - `  Delta: <±N.N>% (this number is indicative — token counts per call may have shifted since the snapshot)`
- Else:
  - `(no previous ensemble on record — first change-model run)`

## Step 6 — Accept / Retry / Cancel

`AskUserQuestion` with three options (Accept default):

1. `"Accept this ensemble"` — description: `"Write the 3 model IDs to settings.yaml (the mode/api/auth fields stay untouched) and record the new cost snapshot."`
2. `"Retry — pick different models"` — description: `"Reopen the SELECT FIRST/SECOND/THIRD menus. The benchmark is NOT re-run."`
3. `"Cancel — keep current ensemble"` — description: `"No files modified."`

Dispatch:

- `Accept` → Step 7.
- `Retry` → go to Step 4. (Shell variables `PICK_1/2/3` are cleared.)
- `Cancel` → print `[DONE] llm-externalizer-change-model — no changes. Previous ensemble intact.` and exit 0.

## Step 7 — Apply (on Accept)

```bash
APPLY_OUT=$(uv run --quiet --with 'ruamel.yaml>=0.18' \
  "${CLAUDE_PLUGIN_ROOT}/scripts/apply_ensemble_choice.py" \
    --model "$PICK_1" --second-model "$PICK_2" --third-model "$PICK_3" \
    --bench-json "$HOME/.llm-externalizer/benchmark-results.json" 2>&1)
APPLY_RC=$?
if [ $APPLY_RC -ne 0 ]; then
    echo "[FAILED] llm-externalizer-change-model — apply script failed:"
    printf '%s\n' "$APPLY_OUT" | sed -n '1,5p'
    exit 1
fi
printf '%s\n' "$APPLY_OUT"
```

Parse `$APPLY_OUT` (a JSON blob) for `backup` and `ensembleCostPath`. Tell the user:

```
[DONE] llm-externalizer-change-model — applied.
  Active profile: <activeProfile> (mode <activeMode>, unchanged)
  New ensemble: <PICK_1>, <PICK_2>, <PICK_3>
  Backup: <backup path>
  Snapshot: <ensembleCostPath>
```

## Constraints

- NEVER modify the active profile's `mode`, `api`, `url`, `api_key`, `api_token`, `timeout`, `context_window`, or any field other than `model` / `second_model` / `third_model`.
- NEVER apply an ensemble that contains a model which did not PASS in the benchmark — `apply_ensemble_choice.py` already enforces this, but the command also filters the menu options to passing models only.
- NEVER re-run the benchmark automatically on Retry. Only Step 1's explicit "Run fresh" option runs it.
- NEVER `Read` the full markdown report. Only the JSON sidecar is used, and even that only at the per-model summary level.
- On any network / JSON parse / script failure, abort with a single-line `[FAILED] llm-externalizer-change-model — <reason>`. Do NOT half-apply a change.

## Error table

| Error | Response |
|-------|----------|
| `settings.yaml` missing | `[FAILED] — settings.yaml missing at <path>. Run /plugin configure llm-externalizer first.` |
| active profile missing / malformed | `[FAILED] — <reason from read_ensemble_state.py .errors>.` |
| benchmark returns 0 passing models | `[FAILED] — no models passed the benchmark.` |
| picked model not present in benchmark (should never happen — menu is filtered) | `[FAILED] — picked model not found in benchmark results — menu state corrupted.` |
| apply script fails | `[FAILED] — apply script failed: <stderr first line>.` |
| user picks Cancel | `[DONE] — no changes. Previous ensemble intact.` (exit 0) |
