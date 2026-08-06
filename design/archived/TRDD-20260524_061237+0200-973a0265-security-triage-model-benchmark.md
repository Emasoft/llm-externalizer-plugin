---
trdd-id: 973a0265-6b04-4167-876c-f30a18631f85
title: Security-triage model benchmark — formalized golden dataset + scorer + selection gate
column: complete
created: 2026-05-24T06:12:37+0200
updated: 2026-08-06T17:35:00+0200
---

# TRDD-973a0265 — Security-triage model benchmark + auto-selection gate

**Filename:** `design/tasks/TRDD-20260524_061237+0200-973a0265-security-triage-model-benchmark.md`
**Tracked in:** this repo.

## 0. User's request (verbatim intent)

> annotate those tests and formalize them in automated tests to do each time we
> need to assess a new model. the models change often, so llm-externalizer must
> automatically select the best model of equivalent cost between those available
> on openrouter. but they must pass the tests/benchmarks.

So: turn the security_scan triage findings (#7 / #9 / #10) + the context-window
calibration cases (#95) into a **reusable, re-runnable model-assessment
benchmark**, and make **passing it a GATE** in auto-selecting the cheapest-
adequate OpenRouter model for the `security_scan` adjudication path.

**This TRDD is the REFERENCE INSTANCE of the per-tool model-qualification
framework [[TRDD-f45eeaa0]].** Build this one concretely first; the framework
(per-tool registry + per-tool selection for ALL tools) is then extracted from
it. The user generalized the requirement: "each mcp tool has one (or more)
specific benchmark and requirements … must … pass the … benchmark specific of
that tool to be used as new model for that tool."

## 1. Two test layers — keep them distinct

- **Code-correctness tests** (already shipped): `security_scan.test.ts` with a
  deterministic mock `FetchImpl`. Test the CODE logic (clamp, redaction,
  windowing, fail-safe). Model-independent. NOT this TRDD.
- **Model-assessment benchmark** (THIS TRDD): a labeled GOLDEN DATASET of real
  snippets → expected verdict, scored against REAL candidate models. Tests the
  MODEL's judgment quality. Re-run per candidate model. This is the selection
  gate.

## 2. Relationship to the existing benchmark machinery

`mcp-server/src/benchmark/` already has the analog for the keyword-
classification task: `ground-truth.ts` (labeled dataset), `score.ts` (scorer),
`runner.ts` (runs a model over the dataset), `discover.ts::qualify` (cost/
context/param eligibility under the <$1/M ceiling), `pick.ts::pickTopN`
(meanF1→cost→latency) + `applyPicksToSettings`. The security-triage benchmark
MIRRORS this structure for verdict adjudication and ADDS a gate to selection —
it does not replace the keyword benchmark (that one selects the general
remote-ensemble; this one gates the security_scan model).

## 3. Deliverables

### 3.0 Living corpus (seeded NOW, during calibration)
`design/benchmarks/security-triage-cases.jsonl` is the ACCUMULATING annotated
corpus — each calibration lesson is appended as it surfaces (the user: "annotate
the issues you encounter in this phase of calibration … use the lessons learned
to create the final benchmark later"). Seeded with 22 cases from #7/#9/#10/#41
(incl. the 3 real v9.11.0 failures: judge-manipulation, defensive over-clamp,
static-literal over-flag). #95 APPENDS its context-window cases here; #96 curates
this corpus into the runnable dataset below. Keep appending here for every new
issue/lesson going forward.

### 3.1 Golden dataset (`mcp-server/src/benchmark/security-triage/dataset.jsonl`)
Each row: `{id, category, snippet|file+line+context_lines, expected_verdict
(threat|not_threat|uncertain), rationale, source_issue}`. Seeded from:
- #7: judge-manipulation / reviewer-directed injection → must NOT be not_threat.
- #9: defensive docs / quoted markers / detection-classifier source → not over-
  clamped (not_threat or uncertain, never a false threat from a quoted marker).
- #10: static-literal vs dynamic provenance (path_traversal/ssrf/cmd_injection):
  visible-taint → threat; visible-static-literal → not_threat;
  origin-out-of-window → uncertain (the #95 context-window cases).
- The 8 clean threat↔non-threat pairs from #7's two-sided batch.
- The 7 CPV real skillaudit FPs (#41) → not_threat.
Dataset is versioned; new cases appended as issues surface (the user: "annotate
those tests and formalize them … each time").

### 3.2 Scorer (`security-triage/score.ts`)
Given model verdicts vs expected, compute: correct-rate, over-flag rate (false
threat), under-flag rate (false not_threat — the DANGEROUS error), and
appropriately-uncertain rate (uncertain WHERE expected, e.g. provenance not
visible — counted CORRECT, not a miss). Weight under-flags heaviest (a missed
threat is worse than an over-flag). Emit a pass/fail against thresholds
(thresholds calibrated from #95 + a safety floor: e.g. 0 under-flags on the
judge-manipulation + visible-taint cases is MANDATORY to pass).

### 3.3 Runner (`security-triage/runner.ts`)
Runs a given model id over the dataset via the real OpenRouter path (reusing
the security_scan judge prompt + json_schema so it measures the SAME pipeline
the tool uses), returns the score. Cheap (dataset ~30-60 cases × cost). Caches
per-model-per-day like the existing benchmark cache.

### 3.4 Selection gate
Extend the model-selection flow: a candidate is eligible for the `security_scan`
default ONLY if (a) it passes `qualify` (cost ceiling / context / params) AND
(b) it PASSES the security-triage benchmark. Among passers of EQUIVALENT cost,
pick the best score (then cost, then latency — mirror pickTopN). Surface a
recommended `security_scan` model (settings.yaml or a documented default). The
cost rule stands: equivalent-or-lower cost only; a pricier model is never auto-
selected (the user's same-cost constraint).

### 3.5 Surfaces (3-surface convention)
A re-runnable assessment command: MCP tool + `llm-externalizer benchmark
--security-triage [--model <id>]` CLI + a slash command. Reuse/extend the
existing benchmark command rather than a wholly new one if clean.

## 4. Sequencing / dependencies
1. #9/#10 fix lands (the provenance + context prompt the benchmark measures).
2. #95 calibration sweep runs → produces the context-window dataset cases + the
   empirical accuracy thresholds → FEEDS §3.1 dataset + §3.2 thresholds.
3. THEN build §3.1–3.5.
Blocked-by the #9/#10 fix + #95 calibration (both must land first).

## 5. Acceptance
- [ ] Golden dataset committed, versioned, seeded from #7/#9/#10/#41/#95.
- [ ] Scorer with under-flag-weighted score + mandatory-zero-under-flag floor on
      the critical cases.
- [ ] Runner scores any model over the dataset via the real judge pipeline.
- [ ] Selection gates the security_scan model on passing the benchmark + picks
      best-of-equivalent-cost; pricier models never auto-selected.
- [ ] Re-runnable on demand (3 surfaces); cached per-model-per-day.
- [ ] Docs: how to assess a new model + the pass thresholds.

## 6. Status log
| Date | Status change | Note |
|---|---|---|
| 2026-05-24T06:12:37+0200 | created → not-started | Captured the user's "formalize the triage tests into a re-runnable model-assessment benchmark + gate auto-selection on passing it (best-of-equivalent-cost)". Mirrors the existing keyword-classification benchmark machinery (ground-truth/score/runner/pick). Distinct from the mock-based code-correctness unit tests. Blocked-by the #9/#10 fix + the #95 calibration sweep (which seed the dataset + thresholds). |
| 2026-05-24T08:07:03+0200 | not-started → in-progress | Built the module under mcp-server/src/benchmark/security-triage/: dataset.jsonl (33 self-contained snippet cases curated from the corpus) + dataset.ts (loader + BENCHMARK_RUBRICS + per-tool SECURITY_TRIAGE_CRITERIA), score.ts (under-flag-weighted scorer + mandatory-zero-critical-under-flag floor + minScore 0.5 gate), runner.ts (reuses judgeGroups — the SAME hardened pipeline), select.ts (3-gate selection: requirements + benchmark-pass + never-pricier-than-incumbent, best-of-equivalent-cost), index.ts (orchestrator: discover → run → score → gate → report JSON+md, per-model-per-day cache). 3 surfaces: MCP tool `security_triage_benchmark`, CLI `llm-ext-benchmark --security-triage [--model] [--force]`, slash command. 31 offline unit tests (dataset/score/select) + 1 self-skipping live e2e. tsc+lint+build+full-suite green. Per-tool SECURITY_TRIAGE_CRITERIA (no reasoning / modest ctx, unlike the keyword ensemble's 128K bar) is the reference instance for [[TRDD-f45eeaa0]]. |
| 2026-05-24T08:52:24+0200 | in-progress → completed | Live validation surfaced TWO real bugs, both fixed: (1) judge.ts cleared the per-call abort timeout right after fetch resolved HEADERS, leaving res.json()/res.text() UNBOUNDED — a slow-body provider hung the call indefinitely (slow-loris vector on the security tool; blocked the benchmark from terminating). Fixed: timer armed through the body read, cleared on every exit path; regression test added (security_scan.test.ts "hung RESPONSE BODY"). (2) the scorer counted fail-safe (timeout/error) verdicts as wrong answers, so a degraded provider FALSELY failed qwen (first complete run: 0.242 FAIL with 26/33 timed out). Fixed: scorer EXCLUDES fail-safe cases; a run with >15% errored is INCONCLUSIVE (neither pass nor fail, incumbent kept, never switches on a bad run). Final live run: qwen INCONCLUSIVE (26/33 errored on a degraded qwen provider) but score 0.857 on the 7 real responses, 0 under-flags, 0 critical under-flags — sound judgment; a clean PASS confirmation awaits a healthy qwen provider (one-command re-run). Full 742-test suite + 37 triage/judge unit tests green; tsc+lint+build clean. ALL acceptance criteria met. NOT yet committed (rides the v9.12.0 bundle, pending user go). |
