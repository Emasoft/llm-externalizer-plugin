---
trdd-id: f45eeaa0-a36b-4d70-90c3-d39813960409
title: Per-tool model qualification framework — each tool's benchmark gates its model selection
status: in-progress
created: 2026-05-24T06:15:05+0200
updated: 2026-05-24T20:07:15+0200
---

# TRDD-f45eeaa0 — Per-tool model qualification framework

**Filename:** `design/tasks/TRDD-20260524_061505+0200-f45eeaa0-per-tool-model-qualification-framework.md`
**Tracked in:** this repo.

## 0. User's request (verbatim intent)

> each mcp tool has one (or more) specific benchmark and requirements. all
> models must satisfy the requirement and pass the test/benchmark specific of
> that tool to be used as new model for that tool.

Generalize the per-model selection so it is **per-TOOL**: every LLM-using MCP
tool declares its own capability **requirements** + one or more **benchmarks**;
a model is eligible to serve a given tool ONLY if it (a) meets that tool's
requirements AND (b) passes that tool's benchmark(s). Among eligible models of
**equivalent (or lower) cost**, pick the best — never a pricier model
(the standing same-cost rule).

## 1. Build order — extract the framework FROM the first instance

To avoid premature abstraction, the framework is **extracted from** the
`security_scan` reference instance, not built ahead of it:
1. [[TRDD-973a0265]] (security-triage benchmark + gate) lands first as the
   concrete reference: dataset + scorer + runner + a single tool's selection gate.
2. Once it works end-to-end, GENERALIZE its shape into the registry + per-tool
   selection mechanism below.
3. Then add each remaining tool's benchmark as an instance.

So this TRDD is **blocked-by** 973a0265 (and transitively #9/#10 + #95).

## 2. The framework

### 2.1 Per-tool descriptor (a registry)
Each LLM-using tool registers:
```
{
  tool: "security_scan",
  requirements: {              // hard eligibility (extends benchmark/discover.ts::qualify)
    structured_output: true,   // response_format / json_schema
    reasoning: true|false,
    min_context: <tokens>,
    cost_ceiling: "<$1/M in&out" // the standing rule
  },
  benchmarks: [ "<dataset+scorer+pass-threshold ref>" ]  // one or more
}
```
Registry lives next to the tools (e.g. `mcp-server/src/model-qualification/registry.ts`),
one entry per LLM-using tool: chat, code_task, scan_folder,
search_existing_implementations, compare_files, check_references, check_imports,
check_against_specs, cluster_synonyms, security_scan, mass_scout. (Pure-utility
tools that make no LLM call — discover, reset, get_settings, or_model_info — have
no descriptor.)

### 2.2 Per-tool benchmarks (instances)
Each is a golden dataset + scorer + pass-threshold, mirroring the existing
`benchmark/` machinery (`ground-truth.ts`/`score.ts`/`runner.ts`):
- `security_scan` → the triage benchmark ([[TRDD-973a0265]]).
- `cluster_synonyms` → meaning-equivalence clustering accuracy (it already has a
  pre-flight benchmark gate — fold it in).
- `code_task` / `check_*` → code-understanding / validation accuracy.
- `scan_folder` / `search_existing_implementations` → detection / duplicate-match
  accuracy.
- `mass_scout` → fieldset-extraction/classification accuracy (the existing
  keyword-classification benchmark is the closest seed).
- `chat` / `compare_files` → looser general-quality benchmarks.
Datasets versioned; cases appended as issues surface.

### 2.3 Per-tool model selection
Generalize `benchmark/pick.ts`: for EACH tool, from the OpenRouter roster, keep
models that pass that tool's `requirements` (qualify) AND its benchmark(s), then
pick best-score → cost → latency among EQUIVALENT-cost passers. Result: a
**per-tool model assignment** (not one global model).
- settings.yaml gains an optional per-tool model map (default model + per-tool
  overrides); absent → the active profile's model (back-compat).
- A model that fails a tool's benchmark is NEVER assigned to that tool, even if
  it's cheaper/faster.

### 2.4 Re-runnable assessment ("assess a new model")
One command runs ALL tool benchmarks against a candidate model and reports which
tools it qualifies for (+ score per tool). 3 surfaces (MCP + CLI + slash),
extending the existing benchmark command. Cached per-model-per-tool-per-day.

## 3. Requirements per tool (first-pass capability map)
| Tool | structured_output | reasoning | long-context | benchmark seed |
|---|---|---|---|---|
| security_scan | yes | yes | medium | triage (973a0265) |
| cluster_synonyms | yes | yes | medium | meaning-equivalence (existing preflight) |
| code_task | yes | yes | high | code-understanding |
| scan_folder | yes | no | high | per-file detection |
| search_existing_implementations | yes | yes | high | duplicate-match |
| check_references/imports/against_specs | yes | no | medium | validation accuracy |
| compare_files | yes | no | high | change-summary |
| mass_scout | yes | no | medium | keyword-classification (existing) |
| chat | no | no | medium | general (loose) |

## 4. Acceptance
- [x] 973a0265 shipped as the reference instance.
- [x] Registry of per-tool {requirements, benchmarks}.
- [x] Per-tool selection enforced for the benchmarked tool — security_scan's
      selection gate is requirements + benchmark-PASS + never-pricier; a failing
      model is never assigned, pricier models never auto-selected. (A generalized
      cross-tool AUTO-selector awaits more per-tool benchmarks; today the
      requirements half is exposed via `assess_model` and the one benchmark via
      `security_triage_benchmark`.)
- [x] settings.yaml per-tool model map — `tool_models` (Profile) +
      `resolveModelForTool` (default + per-tool overrides, back-compat;
      typo-guarded validation against `registeredTools()`); security_scan wired
      as the reference consumer.
- [x] Re-runnable "assess a new model" command, 3 surfaces (MCP `assess_model`
      + CLI `--assess-model` + slash) — the FREE/offline REQUIREMENTS half across
      ALL tools; the benchmark half runs per tool's own benchmark
      (security-triage today, cached per-model-per-day).
- [ ] Each LLM-using tool has at least one benchmark dataset + pass threshold.
      (Incremental: security_scan ✓ + mass_scout ✓; the other 9 stay
      requirements-only until their golden dataset lands — NOT fabricated, per §1
      + the no-fake-tests rule.)
- [x] Docs: how to add a tool's benchmark + how selection works (README §F +
      slash-command docs + this TRDD).

## 5. Status log
| Date | Status change | Note |
|---|---|---|
| 2026-05-24T06:15:05+0200 | created → not-started | Captured the user's generalization: per-tool benchmarks + requirements gate per-tool model selection; best same-cost passer wins. Framework is EXTRACTED FROM the security_scan instance (973a0265) to avoid premature abstraction — blocked-by 973a0265 (→ #9/#10 + #95). Reuses the existing benchmark/ machinery (ground-truth/score/runner/pick) + discover.ts::qualify for requirements. |
| 2026-05-24T12:14:07+0200 | not-started → in-progress | FRAMEWORK CORE landed (mcp-server/src/model-qualification/registry.ts + registry.test.ts, 12 tests): the per-tool requirements registry — the single source of truth for every LLM tool's model requirements + benchmark pointer. Acceptance covered: registry of per-tool {requirements, benchmark} ✓ (all 11 LLM tools; pure-utility tools excluded); security_scan wired to its real triage benchmark (973a0265) ✓; mass_scout → existing keyword-classification ✓; qualifyModelForTool() requirements gate ✓; the security-triage orchestrator now reads security_scan's requirements FROM the registry (real runtime consumer, single source of truth). DELIBERATELY DEFERRED as incremental (NOT premature-abstracted from N=1, per §1 + the user's no-over-engineering rule): the per-tool BENCHMARK DATASETS for the other 9 tools (each is a labeled-golden-dataset research effort — fabricating shallow ones would violate the no-fake-tests rule), the settings.yaml per-tool model map (cross-cutting, every tool's model resolution), and a generalized cross-tool selection + assess-all command. Each lands as its tool gets a real benchmark. Status stays in-progress (NOT completed): the framework foundation is shipped, the per-tool benchmark instances are the remaining body of work. |
| 2026-05-24T20:07:15+0200 | in-progress (more work landed) | PER-TOOL MODEL MAP + ASSESS SURFACE shipped (~13 files, 4 phases, all gates green). Phase 1 — config.ts: `Profile.tool_models` + `ResolvedProfile.toolModels` + `resolveModelForTool` (order: explicit call arg > `tool_models[tool]` > the tool's own default > `profile.model`) + typo-guarded validation (keys ∈ `registeredTools()`, non-empty model-id values) + SETTINGS_TEMPLATE example; new config.test.ts (14). Phase 2 — security_scan wired as the REFERENCE CONSUMER in runSecurityScanCli (best-effort settings read; back-compat: no `tool_models` ⇒ DEFAULT_MODEL exactly as before); wiring.test.ts +4 (asserts the model actually sent to the judge via a capturing FetchImpl). Phase 3 — discover.ts `disqualifyReason()` (qualify() now delegates the predicate to it → single source of truth) surfaced through `registry.qualifyModelForTool().disqualifyReason`; new assess.ts (`assessModelAcrossTools`/`assessModelById`/`renderAssessmentText`) + assess.test.ts (9); 3 surfaces — MCP `assess_model`, CLI `--assess-model`, slash `/llm-externalizer-assess-model` — all FREE + offline (catalog only, no LLM call); mcp-tools.test.ts + index.test.ts roster updated (tool count 18→19). Phase 4 — README §F "Per-tool model overrides" + "Model-qualification tools" + command-table rows (also added the previously-missing security-triage-benchmark rows) + the assess-model slash doc. STILL in-progress: per-tool BENCHMARK DATASETS for the remaining 9 tools — the genuinely-incremental body of work (not fabricated). |
