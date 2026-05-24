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
      'src/grouping.test.ts',
      'src/safe-body.test.ts',
      // Global usage-history logger — one line per LLM web request.
      'src/usage-history.test.ts',
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
      'src/default-output-dir.test.ts',
      'src/cluster/phase2_verify.test.ts',
      'src/cluster/phase3_canonical.test.ts',
    ],
  },
});
