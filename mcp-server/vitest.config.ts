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
      // Ensemble per-model limits — calibrated-ceiling maxOutput resolver (A3 + ec45c66f).
      'src/ensemble-limits.test.ts',
      // Reasoning-effort cost guard — default "high", per-call "off" opt-out (ec45c66f).
      'src/reasoning-ladder.test.ts',
      // Free-only switch — config core + context-floor filter (TRDD-8b6b3646).
      'src/free-only.test.ts',
      // Free-pool auto-bench trigger — fire-and-forget detached child (TRDD-f1510055).
      'src/free-pool-auto-bench.test.ts',
      // Auto-free on low balance (<$1) — threshold/model/pool helpers (TRDD-542bdbef).
      'src/auto-free.test.ts',
      // Provider-error sanitizer — strips user_id + JSON noise from logs/reports (TRDD-54f508a4).
      'src/provider-error-sanitize.test.ts',
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
      // cluster_synonyms CLI surface — wiring test for the new third-surface
      // adapter (runClusterSynonymsCli). Mock rawLlmCall, no network.
      'src/cluster/wiring.test.ts',
      'src/benchmark/pick.test.ts',
      // security-triage model benchmark — golden dataset loader, scorer, and
      // the selection gate. Pure-TS unit tests (no LLM, no network).
      'src/benchmark/security-triage/dataset.test.ts',
      'src/benchmark/security-triage/score.test.ts',
      'src/benchmark/security-triage/select.test.ts',
      // Real-model end-to-end smoke — self-skips unless OPENROUTER_API_KEY is set.
      'src/benchmark/security-triage/live.test.ts',
      // Per-tool model-qualification registry (TRDD-f45eeaa0 framework core).
      'src/model-qualification/registry.test.ts',
      // Cross-tool model assessment (requirements half of the per-tool gate).
      'src/model-qualification/assess.test.ts',
      // check_model_health drift detection (TRDD-828238b5 A2).
      'src/model-qualification/drift.test.ts',
      // New-model autodiscovery — catalog snapshot diff (TRDD-828238b5 A4).
      'src/model-qualification/new-arrivals.test.ts',
      // Doc-consistency gate — README counts/names match the source (A5).
      'src/doc-consistency.test.ts',
      'src/default-output-dir.test.ts',
      'src/cluster/phase2_verify.test.ts',
      'src/cluster/phase3_canonical.test.ts',
    ],
  },
});
