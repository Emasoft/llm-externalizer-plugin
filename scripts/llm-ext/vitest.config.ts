import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests spawn child processes — give them time
    // Local reasoning models can be very slow (~8 tok/s + 30-60s thinking per call).
    // Batch tests with 3 files need ~6-10 min; single-file tests need ~2-3 min.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // Only run integration + unit tests by default — live tests require LM Studio
    // Run live tests explicitly: npx vitest run src/live.test.ts
    include: [
      'src/index.test.ts',
      // 'profile' command (TRDD-K3PW7Q2M) — read-only list/show against the
      // real compiled CLI + a throwaway multi-profile settings.yaml.
      'src/profile.test.ts',
      // config -> settings group rename (settings-rename task) — settings
      // show/profiles, the removed config group, and the missing-file path.
      'src/settings-group.test.ts',
      // Launcher → server boot handoff — spawns the real launcher and completes
      // an MCP initialize; catches the -32001 regression that unit-level imports
      // (which never go through launcher.mjs) structurally cannot see.
      'src/launcher-boot.test.ts',
      // Grouped CLI launcher (TRDD-DT11TE2Z) — argv rewrite + did-you-mean.
      'src/cli/launcher.test.ts',
      // --profile global flag + -o/--output_dir on newly-report-writing
      // commands (profile+output-flags task).
      'src/cli/profile-flag-and-output-dir.test.ts',
      // --profile visibility in per-command --help (profile-visibility task).
      'src/cli/profile-help-visibility.test.ts',
      // Cost-safety guard — default test backend must never bill (TRDD-e82f2c49).
      'src/test-helpers.test.ts',
      'src/grouping.test.ts',
      'src/safe-body.test.ts',
      // Per-tool model map (tool_models / resolveModelForTool) — TRDD-f45eeaa0.
      'src/config.test.ts',
      // Dynamic default-profile lifecycle (free/free-ensemble/paid/paid-ensemble/
      // paid-mass-scout) — pool fingerprinting, drift decision, and the state sidecar.
      'src/default-profiles.test.ts',
      // The population RUNNER's own policy — paid gate, lock-before-gate
      // ordering, fail-open. The wiring test mocks this module, so without
      // this file the money policy itself has no coverage.
      'src/default-profiles-runner.test.ts',
      // Phase 4 wiring: the boot gate + the dispatcher hook that actually
      // populate a default profile on first use (previously inert).
      'src/default-profile-wiring.test.ts',
      // renderDefaultSettingsYaml() round-trip + first-run/corrupt-recovery
      // regression tests for the removed SETTINGS_TEMPLATE hand-maintained copy.
      'src/config-default-settings.test.ts',
      // high_quality_scan prompt-cache wire transform (TRDD-DBUSM55E).
      'src/high-quality-scan.test.ts',
      // Usage-rule installer (~/.claude/rules/use-llm-externalizer.md).
      'src/rule-install.test.ts',
      // Single-source project-root resolver (reports land inside the project).
      'src/project-root.test.ts',
      // scan_local_llm_services — local-service autodiscovery (parsing + the
      // discover→build→write chain against a tmp LLM_EXT_CONFIG_DIR).
      'src/local_discovery/scan.test.ts',
      // Global usage-history logger — one line per LLM web request.
      'src/usage-history.test.ts',
      // Durable model-health event ledger (TRDD-828238b5 A1).
      'src/model-events.test.ts',
      // Model-health emission at the hot-path sites (TRDD-828238b5 A7-P1).
      'src/model-events-emission.test.ts',
      // Ensemble per-model limits — calibrated-ceiling maxOutput resolver (A3 + ec45c66f).
      'src/ensemble-limits.test.ts',
      // Reasoning-effort cost guard — default "high", per-call "off" opt-out (ec45c66f).
      'src/reasoning-ladder.test.ts',
      // Per-model request body overrides — extracted from index.ts (B1 Phase 1, TRDD-63314265).
      'src/request-overrides.test.ts',
      // Adaptive AIMD rate limiter — extracted from index.ts (B1 Phase 2, TRDD-63314265).
      'src/rate-limiter.test.ts',
      // Free-only switch — config core + context-floor filter (TRDD-8b6b3646).
      'src/free-only.test.ts',
      // Free-model ROTATION — the cross-call cooldown registry + the rotation
      // executor. Covers the daily-quota-vs-transient split, the "cooling models
      // are deferred, never dropped" invariant, and real on-disk persistence.
      'src/free-rotation.test.ts',
      // Rotation WIRING guard — asserts every LLM send path is rotation-aware.
      // The helper being correct is not the risk; a send site never CALLING it is
      // (that is exactly how four paths stayed pinned to one free model).
      'src/free-rotation-coverage.test.ts',
      // Auto model-reconcile PURE CORE — dead/new model detection, free-pool
      // recompute (free auto-adopt, paid warn-only), fail-open on a cold catalog,
      // and the throttle math. Hermetic; no catalog fetch, no settings IO.
      'src/model-reconcile.test.ts',
      // Free-pool auto-bench trigger — fire-and-forget detached child (TRDD-f1510055).
      'src/free-pool-auto-bench.test.ts',
      // The shared duplicate-spawn lock. Tests the three staleness axes that make
      // a permanent wedge impossible — a latched lock silently freezes the 5
      // machine-managed default profiles on a stale model set.
      'src/bench-lock.test.ts',
      // Auto-free on low balance (<$1) — threshold/model/pool helpers (TRDD-542bdbef).
      'src/auto-free.test.ts',
      // Provider-error sanitizer — strips user_id + JSON noise from logs/reports (TRDD-54f508a4).
      'src/provider-error-sanitize.test.ts',
      // CLI success-banner helpers — pure path-pick + banner format (TRDD-54f508a4 Issue 4).
      'src/cli.banner.test.ts',
      'src/mass_scouting/fieldset.test.ts',
      'src/mass_scouting/shorthand.test.ts',
      'src/mass_scouting/registry.test.ts',
      'src/mass_scouting/preclassify.test.ts',
      'src/mass_scouting/cost-estimate.test.ts',
      'src/mass_scouting/scout.test.ts',
      'src/mass_scouting/reports.test.ts',
      'src/mass_scouting/search.test.ts',
      'src/mass_scouting/cli.test.ts',
      'src/mass_scouting/mcp-tools.test.ts',
      // security_scan — dedicated injection-hardened triage tool.
      'src/security_scan/security_scan.test.ts',
      'src/security_scan/wiring.test.ts',
      // Report rendering + bounded-concurrency primitive (TRDD-828238b5 Part F wave 2).
      'src/security_scan/report.test.ts',
      'src/security_scan/concurrency.test.ts',
      // Live smoke (T10) — self-skips via describe.skipIf unless
      // OPENROUTER_API_KEY is set. Default `npm test` reports it skipped.
      'src/security_scan/security_scan_live.test.ts',
      // Live test — runs only when LIVE_TESTS=1 + OPENROUTER_API_KEY are set
      // (gated via describe.skipIf inside the file). Default `npm test`
      // reports it as skipped, runtime ~0ms.
      'src/mass_scouting/live.test.ts',
      // Calibration — runs only when CALIBRATE=1 + OPENROUTER_API_KEY are
      // set. Generates a markdown report under reports/mass_scouting_calibration/.
      'src/mass_scouting/calibrate-payload-size.test.ts',
      // cluster_synonyms primitives — pure-TS unit tests (no LLM, no network).
      'src/cluster/jsonl.test.ts',
      'src/cluster/kmeans.test.ts',
      'src/cluster/unionfind.test.ts',
      'src/cluster/checkpoint.test.ts',
      'src/cluster/preflight_benchmark.test.ts',
      'src/cluster/retry_ladder.test.ts',
      'src/cluster/phase1_batch.test.ts',
      'src/cluster/embeddings.test.ts',
      'src/cluster/cluster_synonyms_main.test.ts',
      // Pre-flight in-memory footprint guard (TRDD-828238b5 B3) — fail-fast
      // before any LLM spend when the corpus+embeddings would OOM. Pure math.
      'src/cluster/memory_guard.test.ts',
      // Cluster policy resolver (resolvePolicy / DEFAULT_POLICY / PolicySchema) —
      // pure config merge + zod validation (TRDD-828238b5 Part F wave 3).
      'src/cluster/policy.test.ts',
      // cluster_synonyms CLI surface — wiring test for the new third-surface
      // adapter (runClusterSynonymsCli). Mock rawLlmCall, no network.
      'src/cluster/wiring.test.ts',
      'src/benchmark/pick.test.ts',
      // Every settings.yaml writer must leave the user's comments intact — the
      // writers used to round-trip through a plain object and silently wipe
      // them. This include entry is load-bearing: the list is EXPLICIT, so an
      // unregistered test file runs only when named by hand and is invisible
      // to `npx vitest run` and to CI.
      'src/benchmark/pick-comment-preservation.test.ts',
      // Per-tool model writer (applyToolModelToSettings) — CLI/cron-only,
      // read-only-MCP-guarded (TRDD-828238b5 A7-P2).
      'src/benchmark/apply-tool-model.test.ts',
      // --auto-replace / --apply CLI surface — hermetic spawn of dist/benchmark.js
      // on a healthy ledger (no network); the writer path (TRDD-828238b5 A7-P3).
      'src/benchmark/auto-replace-cli.test.ts',
      // ── P1 zero-token model pipeline ──────────────────────────────────────
      // The ROTATION threshold that replaced the agent's "is this 404 persistent?"
      // judgment: pure rule, synthetic events, injected clock.
      'src/model-events-persistence.test.ts',
      // Ensemble coverage of the ledger (planEnsembleRotation) — real ledger file.
      'src/model-qualification/ensemble-rotation.test.ts',
      // The flag defaults that used to be prose the agent had to apply by hand
      // (--qualifying-top-n 15) + the P1 writer flags.
      'src/benchmark/cli-args.test.ts',
      // The two new CLI-only settings writers (free_models pool, new-arrival
      // adoption). Real files, real atomic tmp+rename.
      'src/benchmark/apply-free-pool.test.ts',
      'src/benchmark/apply-ensemble-slot.test.ts',
      // The [OK|FAILED] final-line + exit-code contract — hermetic spawn of the
      // real bundle (no network, no key): prereq self-check, cache pick, writers.
      'src/benchmark/cli-contract.test.ts',
      // security-triage model benchmark — golden dataset loader, scorer, and
      // the selection gate. Pure-TS unit tests (no LLM, no network).
      'src/benchmark/security-triage/dataset.test.ts',
      'src/benchmark/security-triage/score.test.ts',
      'src/benchmark/security-triage/select.test.ts',
      // Real-model end-to-end smoke — self-skips unless OPENROUTER_API_KEY is set.
      'src/benchmark/security-triage/live.test.ts',
      // security-triage casesToGroups — pure cases→DedupGroup transform (Part F wave 3).
      'src/benchmark/security-triage/runner.test.ts',
      // security-triage model ROUTING + free_only — HERMETIC end-to-end of the real
      // orchestrator (fake catalog + judge FetchImpl only): the candidate under test is
      // the model actually sent, and free mode never sends the paid incumbent.
      'src/benchmark/security-triage/free-mode.test.ts',
      // security-triage P4 pre-flight workload description — derives callsPerModel /
      // promptCharsPerModel from the real golden dataset + the real judge prompt
      // builders. No network.
      'src/benchmark/security-triage/workload.test.ts',
      // Shared same-or-cheaper selection gate (TRDD-828238b5 A6) — generic
      // three-gate math reused by every per-tool selector. No LLM, no network.
      'src/benchmark/select-common.test.ts',
      // Benchmark report rendering + ground-truth handling (TRDD-828238b5 Part F).
      'src/benchmark/report.test.ts',
      'src/benchmark/ground-truth.test.ts',
      // Model-discovery pure logic (filter/disqualify/qualify/roster) + run scorer
      // (scoreRun) — TRDD-828238b5 Part F wave 3. No network (fetchProgrammingModels excluded).
      'src/benchmark/discover.test.ts',
      'src/benchmark/price-cap.test.ts',
      'src/benchmark/paid-guard.test.ts',
      'src/benchmark/validated.test.ts',
      'src/benchmark/score.test.ts',
      // search-existing per-tool benchmark (TRDD-828238b5 A6) — fixture-backed
      // golden dataset + deterministic precision/recall scorer. No LLM, no network.
      'src/benchmark/search-existing/dataset.test.ts',
      'src/benchmark/search-existing/score.test.ts',
      // search-existing in-process runner — HERMETIC (fake FetchImpl seam only,
      // real pipeline + real scorer). No network, no module mocking.
      'src/benchmark/search-existing/runner.test.ts',
      // search-existing selection gate — criteria identity + winner/incumbent paths.
      'src/benchmark/search-existing/select.test.ts',
      // search-existing P4 pre-flight workload description — derives callsPerModel /
      // promptCharsPerModel from the real fixture corpus + the real FFD bin-packing
      // helper (readAndGroupFiles). No network.
      'src/benchmark/search-existing/workload.test.ts',
      // scan_folder in-process pipeline core — HERMETIC (fake processFileCheck
      // seam only, real rateLimitedParallel + real report assembly). No network,
      // no module mocking (B1 Phase 3, TRDD-63314265).
      'src/benchmark/scan-folder/runner.test.ts',
      // code_task in-process pipeline core — HERMETIC (fake processFileCheck +
      // ensembleStreaming seams only, real readAndGroupFiles + grouping + report
      // assembly). Covers single/inline/batch modes. No network, no module
      // mocking (B1 Phase 3, TRDD-63314265).
      'src/benchmark/code-task/runner.test.ts',
      // code_task CODE-AUDIT per-tool benchmark (P2b) — golden corpus of REAL
      // pre-fix snapshots from this repo's git history + a deterministic,
      // judge-free localization scorer + the same-or-cheaper selection gate.
      // bench-runner.test.ts is HERMETIC (fake FetchImpl seam only; real
      // pipeline, real prompt, real fixtures, real scorer). No LLM, no network.
      'src/benchmark/code-task/dataset.test.ts',
      'src/benchmark/code-task/score.test.ts',
      'src/benchmark/code-task/select.test.ts',
      'src/benchmark/code-task/bench-runner.test.ts',
      // code_task P4 pre-flight workload description — derives callsPerModel /
      // promptCharsPerModel from the real dataset + fixtures on disk. No network.
      'src/benchmark/code-task/workload.test.ts',
      // scan_folder MASS-SEARCH per-tool benchmark (P2c) — twelve files copied
      // VERBATIM from this repo's own src/, three queries whose true MATCH set is
      // DERIVED from the corpus bytes (never hand-listed), a deterministic
      // judge-free per-file MATCH/NO_MATCH scorer, and the same-or-cheaper gate.
      // bench-runner.test.ts is HERMETIC (fake FetchImpl seam only; real pipeline,
      // real prompt, real fixtures, real scorer). No LLM, no network.
      'src/benchmark/scan-folder/dataset.test.ts',
      'src/benchmark/scan-folder/score.test.ts',
      'src/benchmark/scan-folder/select.test.ts',
      'src/benchmark/scan-folder/bench-runner.test.ts',
      // check_against_specs in-process pipeline core — HERMETIC (fake
      // ensembleStreaming seam only, real readFileAsCodeBlock + readAndGroupFiles
      // + grouping + report assembly). Covers per-file / batched / grouped modes.
      // No network, no module mocking (P2a, zero-token model pipeline).
      'src/benchmark/check-specs/runner.test.ts',
      // check_against_specs SPEC-ADHERENCE per-tool benchmark (P2d) — this repo's own
      // shipped TESTING.md audited over thirteen VERBATIM git snapshots, four of them
      // the exact pre-fix bytes a real cost-safety commit replaced, each next to its
      // own fixed twin. Deterministic judge-free per-file CLEAN/VIOLATION scorer + the
      // same-or-cheaper gate. bench-runner.test.ts is HERMETIC (fake FetchImpl seam
      // only; real pipeline, real prompt, real fixtures, real scorer) and ASSERTS that
      // four code-blind baselines FAIL the gate — the corpus cannot decay into
      // something a grep could pass. No LLM, no network.
      'src/benchmark/check-specs/dataset.test.ts',
      'src/benchmark/check-specs/score.test.ts',
      'src/benchmark/check-specs/select.test.ts',
      'src/benchmark/check-specs/bench-runner.test.ts',
      // Pre-flight workload descriptions (P4) — each derives callsPerModel /
      // promptCharsPerModel from that benchmark's REAL corpus on disk, so a corpus edit
      // moves the spend estimate automatically and a stale literal can never quietly
      // under-price a sweep. No network, no LLM.
      'src/benchmark/scan-folder/workload.test.ts',
      'src/benchmark/check-specs/workload.test.ts',
      // ── P3 + P4: --update-all + the HARD SPEND CAP ────────────────────────
      // The per-call spend chokepoint: reserve-BEFORE-send, book-actual-after, and the
      // trip latch that stops a sweep dead. The latch is load-bearing because every
      // runner CATCHES fetch errors (never-throw contract), so a throw alone would be
      // swallowed and the sweep would keep spending. Real ledger + real wrappers; only
      // the HTTP wire is a stub.
      'src/benchmark/budget.test.ts',
      // The one-command refresh: the requirement gate, the pre-flight estimate + abort,
      // the mid-sweep abort driven through the REAL ledger, and the benchmark-proven vs
      // requirement-gated distinction the report must never blur. The catalog and the
      // per-tool runners are seams; settings.yaml is a REAL file written by the REAL
      // atomic writers.
      'src/benchmark/update-all.test.ts',
      // --populate-default-profile NAME: unlike --update-all (writes settings.active
      // plus every registered tool), populates exactly ONE named machine-managed
      // default profile ('free' | 'free-ensemble' | 'paid' | 'paid-ensemble' |
      // 'paid-mass-scout'). Injected catalog + sweep seams (no network); the
      // pre-flight budget abort and settings.yaml writes are the REAL code.
      'src/benchmark/populate-default-profile.test.ts',
      // Per-tool model-qualification registry (TRDD-f45eeaa0 framework core).
      'src/model-qualification/registry.test.ts',
      // Cross-tool model assessment (requirements half of the per-tool gate).
      'src/model-qualification/assess.test.ts',
      // check_model_health drift detection (TRDD-828238b5 A2).
      'src/model-qualification/drift.test.ts',
      // Auto-replacement loop CORE — ledger-triggered per-tool benchmark planner
      // (TRDD-828238b5 A7-P2). Injected seams, no network.
      'src/model-qualification/auto-replace.test.ts',
      // New-model autodiscovery — catalog snapshot diff (TRDD-828238b5 A4).
      'src/model-qualification/new-arrivals.test.ts',
      // Doc-consistency gate — README counts/names match the source (A5).
      'src/doc-consistency.test.ts',
      // Codex-removal guard — shipped tree must never invoke the codex CLI (TRDD-1e2b87cb).
      'src/no-codex-invocation.test.ts',
      'src/default-output-dir.test.ts',
      // File-walking + FFD bin-packed batching engine (TRDD-828238b5 Part F).
      'src/scan-pipeline.test.ts',
      // --estimate dry-run estimator (task #187) — pure arithmetic + fail-fast negatives.
      'src/estimate.test.ts',
      // review_plan delegate-mode plan builder (TRDD-SNAEERHU).
      'src/review-plan.test.ts',
      // Layered per-path review rules (TRDD-3JQVBO7M).
      'src/review-rules.test.ts',
      // Diff-mode review scoping against a real fixture git repo (TRDD-MNK2YNH0).
      'src/diff-scope.test.ts',
      'src/cluster/phase2_verify.test.ts',
      'src/cluster/phase3_canonical.test.ts',
      // session-summary P1 reader/pruner + P2 turn-boundary chunker + P3 model
      // selection + P4 map-reduce driver (TRDD-T4MZ8YQR).
      'src/session_summary/transcript.test.ts',
      'src/session_summary/chunker.test.ts',
      'src/session_summary/model-select.test.ts',
      'src/session_summary/driver.test.ts',
      // Request-deadline contract (TRDD-0H5N1V9W) — the timeout must cover the
      // BODY read, not just time-to-first-byte. Regression for a shipped bug
      // where a stalled generation hung the run forever (measured 1890s against
      // a 300s cap) because the abort timer was cleared when headers arrived.
      'src/provider/http.test.ts',
      // Per-call deadline override — resolveConnection is the single point every
      // request's timeout flows through, so a dropped override would be silent
      // (a slow run, not a wrong number).
      'src/provider/connection.test.ts',
    ],
  },
});
