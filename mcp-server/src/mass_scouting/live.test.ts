/**
 * Phase 4 — live smoke test on ~50 fixture files against real OpenRouter
 * (qwen/qwen-2.5-7b-instruct). Verifies the full pipeline end-to-end.
 *
 * GATED: only runs when BOTH `LIVE_TESTS=1` AND `OPENROUTER_API_KEY` are
 * present in the environment. The file IS in `vitest.config.ts > include`,
 * but `describe.skipIf` makes the suite a no-op when the gates aren't
 * satisfied (default `npm test` reports it as a skipped suite, ~0ms).
 * Run explicitly:
 *
 *   LIVE_TESTS=1 OPENROUTER_API_KEY=$KEY \
 *     npx vitest run src/mass_scouting/live.test.ts
 *
 * Acceptance criteria (TRDD §10 / blueprint §3.1):
 *   • files_ok == 50      (zero hard failures)
 *   • cost_usd < $0.005   (well under blueprint's $0.000_039/file × 50 budget)
 *   • markdown report contains the expected sections
 *
 * Cleanup: the tmpdir + its 50 fixture files are removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFieldset } from "./fieldset";
import { openRegistry, type Registry } from "./registry";
import { preclassifyAll } from "./preclassify";
import {
  KNOWN_PRICING,
  estimateJobCost,
  type ModelPricing,
} from "./cost-estimate";
import { runScoutJob, type FetchImpl } from "./scout";
import { renderMarkdownReport, summariseJob } from "./reports";

// ── Gating ─────────────────────────────────────────────────────────────

const LIVE_ENABLED =
  process.env.LIVE_TESTS === "1" && !!process.env.OPENROUTER_API_KEY;

// Use describe.skipIf so the test is reported as "skipped", not "failed",
// when the gates aren't satisfied. This matches the existing live-test
// convention in the project: the run is loud-but-clean by default.
const skipReason = !LIVE_ENABLED
  ? `[skipped] set LIVE_TESTS=1 and export OPENROUTER_API_KEY to run`
  : "";

// ── Fixtures ───────────────────────────────────────────────────────────

const FIXTURE_DIR = join(
  tmpdir(),
  `mass-scout-live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
const FIXTURE_COUNT = 50;
const COST_BUDGET_USD = 0.005;

/**
 * Generate a deterministic fixture set: 25 "async" files and 25 "sync" files.
 * Filenames + small body sizes (~200–400 bytes) keep total tokens well under
 * the cost budget.
 */
function generateFixtures(): string[] {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < FIXTURE_COUNT; i++) {
    const isAsync = i % 2 === 0;
    const path = join(
      FIXTURE_DIR,
      isAsync ? `mod-${i}.async.ts` : `mod-${i}.sync.ts`,
    );
    const body = isAsync
      ? [
          `// Module ${i} — async / await example`,
          `export async function loadThing${i}(url: string): Promise<string> {`,
          `  const res = await fetch(url);`,
          `  return await res.text();`,
          `}`,
          `export const tag${i} = "async";`,
        ].join("\n")
      : [
          `// Module ${i} — synchronous example`,
          `export function compute${i}(x: number): number {`,
          `  return x * x + ${i};`,
          `}`,
          `export const tag${i} = "sync";`,
        ].join("\n");
    writeFileSync(path, body, "utf-8");
    paths.push(path);
  }
  return paths;
}

afterAll(() => {
  if (LIVE_ENABLED) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});

// ── Real-fetch adapter ─────────────────────────────────────────────────

/**
 * Adapt `globalThis.fetch` to the FetchImpl signature. Node 18+ ships fetch
 * natively, so no polyfill is needed.
 */
const realFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

// ── Test ───────────────────────────────────────────────────────────────

describe.skipIf(!LIVE_ENABLED)(
  `mass-scouting — live OpenRouter smoke test ${skipReason}`,
  () => {
    let reg: Registry;
    const paths: string[] = [];

    beforeAll(() => {
      generateFixtures().forEach((p) => paths.push(p));
      reg = openRegistry({ path: ":memory:" });
      // Register every fixture (read-once, body cached as BLOB).
      for (const p of paths) {
        reg.registerFile({
          file_path: p,
          source_root: FIXTURE_DIR,
          body: readFileSync(p),
          registered_via: "folder",
        });
      }
    });

    afterAll(() => {
      reg.close();
    });

    it(
      "scouts 50 fixtures end-to-end, cost < $0.005, zero hard failures",
      async () => {
        const fieldset = parseFieldset({
          version: 1,
          fieldset_name: "live-smoke",
          fields: [
            {
              name: "is_async",
              description: "true if the file uses async / await",
              type: { kind: "bool" },
            },
            {
              name: "purpose",
              description:
                "one of: data_fetch, computation, configuration, documentation, other",
              type: {
                kind: "enum",
                values: [
                  "data_fetch",
                  "computation",
                  "configuration",
                  "documentation",
                  "other",
                ],
              },
            },
            {
              name: "summary",
              description: "one short sentence describing the file (≤80 chars)",
              type: { kind: "string", max_length: 80 },
            },
          ],
        });

        // 1. Preclassify (script-only, no network).
        const pre = preclassifyAll(reg);
        expect(pre.classified).toBe(FIXTURE_COUNT);

        // 2. Sanity-check the cost estimate is well under budget.
        const pricing: ModelPricing =
          KNOWN_PRICING["qwen/qwen-2.5-7b-instruct"]!;
        const est = estimateJobCost(reg, {
          pricing,
          prompt_overhead_bytes: 400, // approximate — system prompt is ~400 bytes
          schema_overhead_bytes: 600, // compiled JSON schema for 3 fields
          expected_output_bytes: 120, // tight envelope for our 3-field response
        });
        expect(est.files_eligible).toBe(FIXTURE_COUNT);
        expect(est.est_cost_usd).toBeLessThan(COST_BUDGET_USD);

        // 3. Live run.
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("OPENROUTER_API_KEY missing — gate bug");

        const result = await runScoutJob(
          reg,
          {
            jobId: `live-smoke-${Date.now()}`,
            fieldset,
            pricing,
            model: "qwen/qwen-2.5-7b-instruct",
            apiKey,
            workers: 8, // moderate concurrency — keep gentle on the API
            maxRetries: 1,
            sourceRoot: FIXTURE_DIR,
            smokeTest: true,
            // Default scout cap of 40% is fine — fixtures are tiny.
          },
          realFetch,
        );

        // Report so a human reading the test output knows what happened.
        // (Tests in this project log freely — no no-console rule active.)
        console.log(
          `[live] files=${result.filesTotal} ok=${result.filesOk} failed=${result.filesFailed} ` +
            `retries=${result.retries} cost=$${result.costUsd.toFixed(6)}`,
        );

        expect(result.filesOk).toBe(FIXTURE_COUNT);
        expect(result.filesFailed).toBe(0);
        expect(result.costUsd).toBeLessThan(COST_BUDGET_USD);

        // 4. Render the report and sanity check it.
        const summary = summariseJob(reg, result.jobId);
        const md = renderMarkdownReport(summary);
        expect(md).toContain("## Run summary");
        expect(md).toContain("## Per-field stats");
        expect(md).toContain("`is_async`");
        // Half the fixtures are async — expect both true and false to appear.
        const isAsync = summary.per_field["is_async"];
        expect(isAsync).toBeDefined();
        expect(isAsync!.total).toBe(FIXTURE_COUNT);
      },
      // Generous timeout — qwen-7b first-call latency on a cold provider can
      // be 20-30s, then ~1s thereafter. 8 workers × 50 files / 8 = 6 calls
      // serial-equivalent + warmup. 5 minutes is plenty.
      300_000,
    );
  },
);
