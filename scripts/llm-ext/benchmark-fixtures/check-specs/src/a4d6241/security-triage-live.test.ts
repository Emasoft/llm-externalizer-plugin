/**
 * Live integration smoke for the security-triage benchmark. NO mocking — it
 * drives the real judge pipeline (runner → judgeGroups → OpenRouter) over the
 * full golden dataset on the cheap incumbent model, then scores + gates + writes
 * a report. This is the end-to-end "does the feature actually work" test.
 *
 * Opt-in only — gated on LIVE_TESTS=1 + OPENROUTER_API_KEY, so it self-skips
 * during the normal `npm test` / publish test gate (~0ms) and never spends API
 * budget there. Run explicitly with `LIVE_TESTS=1 npx vitest run
 * src/benchmark/security-triage/live.test.ts`. Reports go to a tmpdir so the
 * repo's reports/ stays clean. Mirrors the mass_scouting/live.test.ts convention.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MODEL } from "../../security_scan/types.js";
import { loadDataset } from "./dataset.js";
import { runSecurityTriageBenchmark } from "./index.js";

// Opt-in only: this fires 33 real OpenRouter calls, so it must NOT run during
// the normal `npm test` / publish test gate. Requires BOTH LIVE_TESTS=1 and a
// key — matching the mass_scouting/live.test.ts convention.
const LIVE =
  process.env.LIVE_TESTS === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "triage-live-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("security-triage benchmark — real-model end-to-end", () => {
  it(
    "scores the incumbent over the golden dataset and produces a gated recommendation + report",
    async () => {
      /** real OpenRouter calls adjudicate every golden case; the gate runs; a report is written. */
      const result = await runSecurityTriageBenchmark({
        models: [DEFAULT_MODEL],
        force: true,
        outputDir: tmp,
      });

      // A recommendation exists and the report files were written.
      expect(result.recommendedModelId.length).toBeGreaterThan(0);
      expect(existsSync(result.jsonReportPath)).toBe(true);
      expect(existsSync(result.mdReportPath)).toBe(true);

      // The incumbent was assessed and its score covers the whole dataset.
      const cases = loadDataset();
      const incumbent = result.scores.find((s) => s.modelId === DEFAULT_MODEL);
      expect(incumbent, "incumbent score present").toBeDefined();
      expect(incumbent!.total).toBe(cases.length);

      // The cheap incumbent is the shipped default; on its REAL verdicts it MUST
      // clear the mandatory safety floor (zero critical under-flags) — fail-safe
      // (errored) cases are excluded, so this holds even under a degraded provider.
      expect(
        incumbent!.criticalUnderFlags,
        `incumbent under-flagged critical cases: ${incumbent!.failReasons.join("; ")}`,
      ).toBe(0);

      // Only assert a capability PASS when the run was CONCLUSIVE (a healthy
      // provider). If the provider degraded (errorRate > maxErrorRate) the run is
      // inconclusive and the model is neither passed nor failed — that is the
      // robustness contract, not a capability claim.
      if (!incumbent!.inconclusive) {
        expect(
          incumbent!.pass,
          `incumbent failed a conclusive run: ${incumbent!.failReasons.join("; ")}`,
        ).toBe(true);
      }
    },
    900_000,
  );
});
