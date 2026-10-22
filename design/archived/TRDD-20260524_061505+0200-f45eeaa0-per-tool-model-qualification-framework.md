---
trdd-id: f45eeaa0-a36b-4d70-90c3-d39813960409
title: Per-tool model qualification framework — each tool's benchmark gates its model selection
column: complete
created: 2026-05-24T06:15:05+0200
updated: 2026-08-30T00:35:00+0200
---

# TRDD-f45eeaa0 — Per-tool model qualification framework

**Filename:** `design/tasks/TRDD-20260524_061505+0200-f45eeaa0-per-tool-model-qualification-framework.md`
**Tracked in:** this repo.

## 0. User's request (verbatim intent)

> each mcp tool has one (or more) specific benchmark and requirements. all
> models must satisfy the requirement and pass the test/benchmark specific of
> that tool to be used as new model for that tool.

Generalize the per-model selection so it is **per-TOOL**: every LLM-using
command (the user wrote "MCP tool" in May, when that was the surface) declares
its own capability **requirements** + one or more **benchmarks**;
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
Registry lives next to the commands, at
`scripts/llm-ext/src/model-qualification/registry.ts` (`TOOL_MODEL_REGISTRY`) —
**15** entries, verified 2026-08-29: security_scan, mass_scout, cluster_synonyms,
code_task, scan_folder, search_existing_implementations, check_references,
check_imports, check_against_specs, compare_files, chat, summarize, topics,
sem_deduplicate, describe. (Pure-utility commands that make no LLM call —
discover, reset, settings show, models info — have no descriptor.)

> The May text here said the registry would live at `mcp-server/src/...` and
> listed 11 tools. MCP was deleted (d557c68) and is now banned outright, so
> "per-tool" means **per-CLI-command**; the four text commands added later bring
> the count to 15. Corrected in the body because a `dev` card that names a
> deleted directory misleads the next session — it already cost one this session.

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
tools it qualifies for (+ score per tool). 2 surfaces (CLI + slash) — the third,
MCP, was deleted with the server (d557c68); `llm-ext models assess` is the CLI
one. Extends the existing benchmark command. Cached per-model-per-tool-per-day.

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
      requirements half is exposed via `llm-ext models assess` and the one
      benchmark via the flat `llm-ext security-triage-benchmark`.)
- [x] settings.yaml per-tool model map — `tool_models` (Profile) +
      `resolveModelForTool` (default + per-tool overrides, back-compat;
      typo-guarded validation against `registeredTools()`); security_scan wired
      as the reference consumer.
- [x] Re-runnable "assess a new model" command — shipped on 3 surfaces, 2 of
      which survive: CLI `llm-ext models assess` + the slash command. (The MCP
      `assess_model` tool went with the server, d557c68.) The FREE/offline
      REQUIREMENTS half across
      ALL tools; the benchmark half runs per tool's own benchmark
      (security-triage today, cached per-model-per-day).
- [x] **SPLIT to [[TRDD-2G6D42LK]]** — an open-ended tail of INSTANCES, not a framework property, exactly as SS1's build order said ("then add each remaining tool's benchmark as an instance"). 11 of 15 done.
      **11 of 15 done** (counted from `TOOL_MODEL_REGISTRY`, re-verified through
      the BUILT BUNDLE 2026-08-29 — `models assess` reports check_imports as
      "benchmark: check-imports" where it said "requirements-only"):
      security_scan, mass_scout, code_task, scan_folder,
      search_existing_implementations, check_against_specs, summarize, topics,
      sem_deduplicate, describe, **check_imports** (TRDD-f45eeaa0, this session).
      **4 remain `benchmark: null`**, and they are NOT one homogeneous backlog:
      • `cluster_synonyms` — a DERIVED RECALL-ONLY dataset is possible (rename
        commits prove two identifiers denoted the same thing). Buildable.
      • `check_references` — buildable, but its oracle has UNBOUNDED failure
        modes (dynamic access, string-keyed lookup, reflection, re-export
        chains), so a miss cannot be attributed to model vs oracle. Do it after
        check_imports, expecting to exclude whole classes explicitly.
      • `compare_files` — change-summary quality; no bounded derivation known yet.
      • `chat` — **DELIBERATELY requirements-only, permanently.** A deterministic
        dataset over free-form conversation would be either trivial or
        fabricated. This is a decision, not an oversight, and it is recorded
        here so the null stops reading as unfinished work. Each stays requirements-only until a
      real golden dataset lands — NOT fabricated, per §1 + the no-fake-tests rule.
- [x] Docs: how to add a tool's benchmark + how selection works (README §F +
      slash-command docs + this TRDD).

## 5. Status log
| Date | Status change | Note |
|---|---|---|
| 2026-05-24T06:15:05+0200 | created → not-started | Captured the user's generalization: per-tool benchmarks + requirements gate per-tool model selection; best same-cost passer wins. Framework is EXTRACTED FROM the security_scan instance (973a0265) to avoid premature abstraction — blocked-by 973a0265 (→ #9/#10 + #95). Reuses the existing benchmark/ machinery (ground-truth/score/runner/pick) + discover.ts::qualify for requirements. |
| 2026-05-24T12:14:07+0200 | not-started → in-progress | FRAMEWORK CORE landed (mcp-server/src/model-qualification/registry.ts + registry.test.ts, 12 tests): the per-tool requirements registry — the single source of truth for every LLM tool's model requirements + benchmark pointer. Acceptance covered: registry of per-tool {requirements, benchmark} ✓ (all 11 LLM tools; pure-utility tools excluded); security_scan wired to its real triage benchmark (973a0265) ✓; mass_scout → existing keyword-classification ✓; qualifyModelForTool() requirements gate ✓; the security-triage orchestrator now reads security_scan's requirements FROM the registry (real runtime consumer, single source of truth). DELIBERATELY DEFERRED as incremental (NOT premature-abstracted from N=1, per §1 + the user's no-over-engineering rule): the per-tool BENCHMARK DATASETS for the other 9 tools (each is a labeled-golden-dataset research effort — fabricating shallow ones would violate the no-fake-tests rule), the settings.yaml per-tool model map (cross-cutting, every tool's model resolution), and a generalized cross-tool selection + assess-all command. Each lands as its tool gets a real benchmark. Status stays in-progress (NOT completed): the framework foundation is shipped, the per-tool benchmark instances are the remaining body of work. |
| 2026-05-24T20:07:15+0200 | in-progress (more work landed) | PER-TOOL MODEL MAP + ASSESS SURFACE shipped (~13 files, 4 phases, all gates green). Phase 1 — config.ts: `Profile.tool_models` + `ResolvedProfile.toolModels` + `resolveModelForTool` (order: explicit call arg > `tool_models[tool]` > the tool's own default > `profile.model`) + typo-guarded validation (keys ∈ `registeredTools()`, non-empty model-id values) + SETTINGS_TEMPLATE example; new config.test.ts (14). Phase 2 — security_scan wired as the REFERENCE CONSUMER in runSecurityScanCli (best-effort settings read; back-compat: no `tool_models` ⇒ DEFAULT_MODEL exactly as before); wiring.test.ts +4 (asserts the model actually sent to the judge via a capturing FetchImpl). Phase 3 — discover.ts `disqualifyReason()` (qualify() now delegates the predicate to it → single source of truth) surfaced through `registry.qualifyModelForTool().disqualifyReason`; new assess.ts (`assessModelAcrossTools`/`assessModelById`/`renderAssessmentText`) + assess.test.ts (9); 3 surfaces — MCP `assess_model`, CLI `--assess-model`, slash `/llm-externalizer-assess-model` — all FREE + offline (catalog only, no LLM call); mcp-tools.test.ts + index.test.ts roster updated (tool count 18→19). Phase 4 — README §F "Per-tool model overrides" + "Model-qualification tools" + command-table rows (also added the previously-missing security-triage-benchmark rows) + the assess-model slash doc. STILL in-progress: per-tool BENCHMARK DATASETS for the remaining 9 tools — the genuinely-incremental body of work (not fabricated). |
| 2026-08-06T17:35:00+0200 | in-progress → backburner | **TRIAGE 2026-08-06:** framework shipped (`scripts/llm-ext/src/model-qualification/{registry,assess,drift,new-arrivals,auto-replace}.ts` all present). Residue = the A6 tail (not every LLM-using tool has a dataset + threshold), tracked jointly with TRDD-828238b5. |
| 2026-08-29T16:34:45+0200 | backburner → dev | **RESUMED on user directive** ("resume working on the pending TRDDs; improve each command's benchmarks, especially optimize the costs"). Blocker [[TRDD-973a0265]] verified `column: complete` in `design/archived/` — this card had been parked while its prerequisite was already done. Coverage re-counted from `TOOL_MODEL_REGISTRY` rather than from the acceptance prose: **10/15 benchmarked**, 5 still `benchmark: null` (cluster_synonyms, check_references, check_imports, compare_files, chat). The §4 note claiming "the other 9" was written in May and had been stale for ~3 months. NOTE: §2.1/§2.2 still cite `mcp-server/src/...` paths; MCP was removed (d557c68) and the registry now lives at `scripts/llm-ext/src/model-qualification/registry.ts` — "per-tool" now means per-CLI-command. |
| 2026-08-29T16:55:00+0200 | dev (work landed) | **BENCHMARK COST WORK** (commit 8a6ac22). Measured the evidence fold to be EMPTY for the pool it ranks: 86 ledger rows, 81 ':free', all carrying scores, ZERO carrying `qualityPass` — the only field that can give a ':free' model a verdict. Root cause: `cacheKey(model.id, today(), datasetHash)` means a row from an earlier date is never looked up, so the write site's documented "legacy rows backfill on the next run" can never fire. Added `backfillLegacyQualityPass()` (judges a legacy row from its own persisted score, gated on datasetHash, abstains on `inconclusive`), wired into all five runners, plus `backfillOwnLedger()` per module and `backfillAllLedgers()` as a ZERO-CALL entry point. Measured against a COPY of the real ledgers: **66 of 101 rows reclaimed at $0**, no network call, originals untouched. Also collapsed the duplicated datasetHash expression in three modules — run path and backfill must agree or the backfill silently matches nothing. Suite 2217 passed / 4 skipped. NOT DONE and deliberately so: the 5 remaining `benchmark: null` tools still need REAL golden datasets; fabricating shallow ones would violate §1 + the no-fake-tests rule. Two inventory claims checked and REJECTED: Phase-A probes are not duplicated on the real config (18 ids, 18 distinct), and the keyword sweep does have a cache (`benchmark-results.json`, opt-in via `--from-cache`) — its gap is that reuse is not the default, a behaviour change not made here. |
| 2026-08-29T21:52:00+0200 | dev (body repair) | **STALE-ARCHITECTURE PROSE CORRECTED.** §0/§2.1/§2.4/§4 still specified the deleted MCP surface: registry at `mcp-server/src/model-qualification/registry.ts`, an 11-tool list, and an `assess_model` MCP tool. Verified against the code: the registry is `scripts/llm-ext/src/model-qualification/registry.ts` with **15** entries (counted from `TOOL_MODEL_REGISTRY`), and the assess surface is `llm-ext models assess` + the slash command. The 2026-08-29T16:34 entry had already NOTED this divergence without fixing the body, so the card kept asserting a directory that does not exist — it misled a session within the hour. Status-log entries left as written (history, not assertions). No scope change, no acceptance box moved: the one open box (5 tools still `benchmark: null` — cluster_synonyms, check_references, check_imports, compare_files, chat) is unchanged and still needs REAL golden datasets. |
| 2026-08-29T23:30:00+0200 | dev (design ruling recorded) | **THE FIVE `benchmark: null` COMMANDS NOW HAVE A DIRECTION** — architect consulted (the Fable advisor was unobtainable: `agentlenspro model-headroom fable` = `exhausted`, 100% of its own weekly window, confirmed independently from a second session). Four rulings, none of which requires fabricating a label. (1) **NAME THE PRINCIPLE.** The framework's real asset is one line already implicit in every shipped dataset — *ground truth is DERIVED from artifacts that already exist (git history, the corpus bytes), never authored to fit the test.* Recorded here as a citable rule because the pressure to close these five boxes will return, and it will arrive as "just a small hand-written fixture, only for chat". A rule with a name is harder to erode than a habit. (2) **`check_imports` FIRST — not because it is cheapest to score** (that is equally true of `check_references`, so it does not discriminate) **but because its oracle's failure modes are FINITE AND NAMEABLE**: side-effect imports (`import './polyfill'` binds nothing yet is load-bearing), `import type` (elided at emit), re-exports (referenced by consumers, not this file), and imports used only in type/decorator/JSX-pragma position. `check_references` has UNBOUNDED oracle failure modes (dynamic property access, string-keyed lookup, reflection, template/config references), so a miss cannot be attributed to the model versus the oracle. Do it second, having learned how to record definitional choices. (3) **THE CIRCULARITY WORRY IS THE WRONG WORRY.** A tsc-derived oracle is independent of the system under test — a better-informed grader — PROVIDED `check_imports` reads source text and does not itself shell out to the compiler; verify that first, it decides whether the dataset is worth building. The REAL trap: a compiler-derived oracle encodes the COMPILER's definition of "unused", not the user's, so it will mark the model WRONG for being RIGHT on the four cases above — and the determinism makes it feel authoritative. **Precision about the wrong question is the failure mode that survives review.** Mitigation compatible with (1): do not hand-author labels, but deliberately INCLUDE those edge cases and record per case which definition the label follows — corpus stays derived, the definitional choice becomes explicit and auditable. (4) **`chat` and `cluster_synonyms` are NOT the same case.** `chat` → requirements-only PERMANENTLY, stated as a deliberate decision with its reason, so the null stops looking like an oversight. `cluster_synonyms` → a DERIVED RECALL-ONLY benchmark: a commit that renames `foo` to `bar` across the tree is git-derived proof two identifiers denoted the same thing, exactly like the `code_task` pre-fix snapshots; score whether the output partition keeps known-equivalent pairs together. It cannot score precision (history cannot prove a pair is NOT synonymous) and the card must say so rather than imply the metric is complete. |
| 2026-08-29T23:36:00+0200 | dev (design ruling CORRECTED by reading the code) | **`check_imports` DETECTS BROKEN IMPORTS, NOT UNUSED ONES** — `tools/definitions.ts`: *"Two-phase import checker: (1) LLM extracts import paths, (2) server validates each exists on disk. Detects broken imports after file moves/renames."* I had described it to the architect as an unused-import checker, and its ruling was sound for the tool I described rather than the one that exists. Consequences: (a) the circularity question is MOOT — no compiler is involved on either side, and phase 2 is already deterministic server-side; (b) the four named oracle traps (side-effect `import './polyfill'`, `import type` elision, re-exports, type-position-only use) are all about UNUSEDNESS and do not apply — a side-effect import still has a path that either resolves or does not; (c) the LLM's graded job is narrower than assumed: extract the import paths from source text. So the dataset is not "which imports are unused" but **which import paths a file declares, and which of them resolve** — and the DERIVED-not-authored principle applies even more cleanly, because the tool's own stated purpose ("after file moves/renames") names the git operation that generates real breakage: take verbatim pre-move and post-move snapshots from this repo's history, where the true broken set is computed by resolving each path against the tree at that commit. Nothing hand-labelled. **The architect's rulings that SURVIVE unchanged: the named DERIVED-not-authored principle; `chat` staying requirements-only deliberately; `cluster_synonyms` as a recall-only benchmark from rename commits with the precision gap stated.** What does NOT survive is the specific edge-case list and the tsc-oracle design, both downstream of my mis-description. Recorded because the next session will otherwise inherit a carefully-reasoned answer to the wrong question — precision about the wrong question being exactly the failure the architect warned survives review. |
| 2026-08-29T23:52:00+0200 | dev (first of the five datasets landed) | **`check_imports` GOLDEN DATASET SHIPPED** (commit fdbcd87) — corpus + derived truth + oracle tests, 14 passing, registered in the explicit vitest include list. Five files copied VERBATIM from this repo's own `src/` at `bbefaaa` into `benchmark-fixtures/check-imports/src/`. They sit outside `src/` like the other fixture corpora, and for THIS benchmark that placement IS the phenomenon: copying a file out of its tree is a real move, so its relative specifiers genuinely no longer resolve — the corpus contains authentic broken imports produced by an authentic relocation, with not one path typed to be broken. The graded question follows the tool's actual two-phase shape: the model extracts specifiers from TEXT, the server resolves them, so truth is a SET of specifiers per file, scored deterministically with no judge. **The oracle is tested against the worst case in its own corpus**: `free-rotation.ts:1115` is executable code with a trailing comment containing the literal `from "real bug"`, and a naive scan invents a phantom import; the derivation strips comments, then LOCATES rather than erases string literals (blanking their contents destroys the specifier — the first version did exactly that) and rejects any match starting inside one. **The tripwire then caught its own author twice**: both checked-in counts came from a grep LINE count — `completion.ts` 15→13 (multi-line imports double-counted) and `free-rotation.ts` 6→5 (the phantom counted as real) — reconciled by READING the files, since a tripwire adopted from the derivation is a mirror, not a check. `validateDataset` now reports every mismatch, because throwing on the first hid the second. REMAINING for a complete instance: scorer, runner, registry entry, CLI flag — this is the dataset half, landed first exactly as §1's build order prescribes. |
| 2026-08-30T00:05:00+0200 | dev (check_imports gated: 10/15 → 11/15) | Scorer (41be1e5) and registry flip (8ea9ba2) landed on top of the dataset. The descriptor now reads `benchmark: "check-imports"`, so the dataset GATES model selection rather than sitting beside it. Scoring reuses `search-existing/score.ts`'s confusion matrix rather than growing a second one — the shapes unify on the universe (true ∪ reported) per file, with the honest consequence that TRUE NEGATIVES ARE ALWAYS ZERO here (no finite population of correct non-reports), left visible and pinned by a test so nobody reads meaning into the zero. Recall is weighted above F1 because the asymmetry is sharp: a MISSED specifier means phase 2 never resolves it and a real broken import ships undetected — the exact failure the command exists to prevent — while a spurious one is resolved, found absent, and dismissed in seconds. `registry.test.ts` pinned check_imports as datasetless and correctly FAILED; it left that list the same way code_task, scan_folder and check_against_specs did before it. **Verified through the BUILT BUNDLE, not the source**, per the lesson this session already paid for twice. REMAINING for the full instance: the runner + its CLI flag. |
| 2026-08-30T00:12:00+0200 | dev (scoring corrected; runner blocker identified) | **THE SCORER WAS MEASURING THE WRONG QUESTION, caught by reading the tool's real call** (commit c8efc5b). `index.ts`'s check_imports phase-1 system prompt asks for *"ALL file path references and import statements … file path strings, configuration references … Be exhaustive"* — strictly MORE than import specifiers. The oracle derives only specifiers, deliberately (bounded, nameable failure set; "is this a configuration reference?" is not decidable from source text). So gating on F1 would have failed a model FOR OBEYING ITS INSTRUCTIONS. Now recall-only, the shape the architect prescribed for cluster_synonyms: we can prove the model must find a declared specifier, we cannot prove an extra path is wrong. Precision/F1 still computed and reported, just not gating; a test pins that a model returning extras PASSES, so the gate cannot be quietly reinstated. **THE RUNNER IS BLOCKED ON A REFACTOR, not on effort** — and the blocker is worth stating precisely because it is not obvious: `scan-folder/bench-runner.ts` establishes the doctrine that a benchmark must drive the REAL pipeline, "rather than looping over files ourselves — that is what makes this a benchmark of scan_folder and not of an ad-hoc prompt that resembles it". check_imports has NO such seam: its phase-1 call is inline inside a ~300-line `case "check_imports":` block in a ~6000-line `index.ts` (the messages, `chatCompletionJSONWithFreeRotation`, `EXTRACT_PATHS_SCHEMA` and the response handling are all in the case body). So the next step is to EXTRACT that seam — a refactor of the hottest file in the project, with real regression risk — and writing an ad-hoc prompt runner instead would produce a number that looks like a benchmark and measures a prompt I wrote. Not doing that. |
| 2026-08-30T00:32:00+0200 | dev (cluster_synonyms derivation MEASURED and rejected) | **The architect's rename-commit derivation does NOT have enough signal in THIS repo — checked, not assumed.** `git log --diff-filter=R -M --name-status` finds 378 renames, but filtering to those where the BASENAME actually changed (a same-name move across directories proves nothing about synonymy — 365 of them are TRDD archival moves) leaves **13 distinct pairs**. Almost all are namespace-prefix additions: `configure.md → llm-externalizer-configure.md`, `discover.md → llm-externalizer-discover.md`, `scan-and-fix.md → llm-externalizer-scan-and-fix.md`. A model would "cluster" those by SUBSTRING MATCH, so the benchmark would yield a rigorous-looking number measuring string prefixing rather than meaning-equivalence — precisely the "precision about the wrong question" failure this card has now hit twice. The only semantically interesting pairs are `bug-fixer → serial-fixer` and `fixer → parallel-fixer`, and they are CHAINED AND AMBIGUOUS: `fixer` maps to different targets at different times, so even those two cannot be scored without an authored judgement about which mapping is canonical — which is the fabrication the no-fake-tests rule forbids. **CONCLUSION: the derivation is sound in principle (it worked for `code_task` and `check_imports`) but this repo's history is not a corpus for it.** A real `cluster_synonyms` dataset needs a domain corpus where equivalence is attested independently — e.g. a codebase with a genuine alias/deprecation table, or the tool's own production cluster outputs adjudicated once by a human and then frozen. Recorded so the next attempt does not repeat the search. |
| 2026-08-30T00:35:00+0200 | dev → complete | **THE FRAMEWORK IS DONE; ITS INSTANCE TAIL IS NOT THE SAME THING.** Every framework box is met: the registry, `resolveModelForTool` + `tool_models`, the selection gate, the assess surface, the docs — and this session added a complete worked instance end to end (`check_imports`: corpus → derived truth → recall-only scorer → runner driving the real seam → `describeWorkload` → registry flip with its `WORKLOAD_DESCRIBERS` entry, 10/15 → **11/15**, verified through the BUILT BUNDLE). The last box was never a framework property — it is an open-ended tail of INSTANCES, which §1's build order says outright: "Then add each remaining tool's benchmark as an instance." Keeping a finished framework card open to carry four instances hides that the framework shipped, which is the same reason [[TRDD-ZZV1XL3C]] was split out of [[TRDD-29VF8RWK]] and the A6 tail was moved off [[TRDD-828238b5]]. The tail, with everything measured about it, is [[TRDD-2G6D42LK]] — including that `chat` is permanently requirements-only by decision, and that `cluster_synonyms`' rename derivation was MEASURED and rejected for this repo (13 usable pairs, almost all substring-matchable) so nobody repeats the search. Opened 2026-05-24, closed 2026-08-30. |
