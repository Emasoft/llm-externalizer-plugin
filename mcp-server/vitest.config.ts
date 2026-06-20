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
      // Cost-safety guard — default test backend must never bill (TRDD-e82f2c49).
      'src/test-helpers.test.ts',
      'src/grouping.test.ts',
      'src/safe-body.test.ts',
      // Per-tool model map (tool_models / resolveModelForTool) — TRDD-f45eeaa0.
      'src/config.test.ts',
      // Usage-rule installer (~/.claude/rules/use-llm-externalizer.md).
      'src/rule-install.test.ts',
      // Single-source project-root resolver (reports land inside the project).
      'src/project-root.test.ts',
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
      // Free-only switch — config core + context-floor filter (TRDD-8b6b3646).
      'src/free-only.test.ts',
      // Free-pool auto-bench trigger — fire-and-forget detached child (TRDD-f1510055).
      'src/free-pool-auto-bench.test.ts',
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
      // cluster_synonyms CLI surface — wiring test for the new third-surface
      // adapter (runClusterSynonymsCli). Mock rawLlmCall, no network.
      'src/cluster/wiring.test.ts',
      'src/benchmark/pick.test.ts',
      // Per-tool model writer (applyToolModelToSettings) — CLI/cron-only,
      // read-only-MCP-guarded (TRDD-828238b5 A7-P2).
      'src/benchmark/apply-tool-model.test.ts',
      // --auto-replace / --apply CLI surface — hermetic spawn of dist/benchmark.js
      // on a healthy ledger (no network); the writer path (TRDD-828238b5 A7-P3).
      'src/benchmark/auto-replace-cli.test.ts',
      // security-triage model benchmark — golden dataset loader, scorer, and
      // the selection gate. Pure-TS unit tests (no LLM, no network).
      'src/benchmark/security-triage/dataset.test.ts',
      'src/benchmark/security-triage/score.test.ts',
      'src/benchmark/security-triage/select.test.ts',
      // Real-model end-to-end smoke — self-skips unless OPENROUTER_API_KEY is set.
      'src/benchmark/security-triage/live.test.ts',
      // Shared same-or-cheaper selection gate (TRDD-828238b5 A6) — generic
      // three-gate math reused by every per-tool selector. No LLM, no network.
      'src/benchmark/select-common.test.ts',
      // Benchmark report rendering + ground-truth handling (TRDD-828238b5 Part F).
      'src/benchmark/report.test.ts',
      'src/benchmark/ground-truth.test.ts',
      // search-existing per-tool benchmark (TRDD-828238b5 A6) — fixture-backed
      // golden dataset + deterministic precision/recall scorer. No LLM, no network.
      'src/benchmark/search-existing/dataset.test.ts',
      'src/benchmark/search-existing/score.test.ts',
      // search-existing in-process runner — HERMETIC (fake FetchImpl seam only,
      // real pipeline + real scorer). No network, no module mocking.
      'src/benchmark/search-existing/runner.test.ts',
      // search-existing selection gate — criteria identity + winner/incumbent paths.
      'src/benchmark/search-existing/select.test.ts',
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
      'src/cluster/phase2_verify.test.ts',
      'src/cluster/phase3_canonical.test.ts',
    ],
  },
});
