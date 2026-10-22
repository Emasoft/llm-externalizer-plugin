// staleFailedModelIds — design §5's 7-day re-probe (P6b-fix N3).
//
// The function shipped in P6b with no test at all, which matters more than the
// usual coverage argument: it is the ONLY thing that ever lets a model out of
// the benchmark-failure set, so a bug here is invisible (a model simply stays
// excluded forever) rather than loud. Real cache file in an isolated
// LLM_EXT_CONFIG_DIR — the function reads the live per-model-per-day ledger, so
// a mock would test the mock.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "../../test-tmp-root.js";
import { join } from "node:path";

import { staleFailedModelIds, benchmarkFailedModels } from "./index.js";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

let cfgDir = "";
let prevCfgDir: string | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed "now" so the cutoff arithmetic is not wall-clock dependent. */
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const dayKey = (offsetDays: number): string =>
  new Date(NOW - offsetDays * DAY_MS).toISOString().slice(0, 10);

/** One ledger row. The key shape is `modelId::date::datasetHash` — the real
 *  one the benchmark run writes; `failedModelsFromCache` splits on `::`. */
function row(
  modelId: string,
  date: string,
  score: { pass: boolean; inconclusive: boolean },
): [string, unknown] {
  return [`${modelId}::${date}::hash1`, { date, score }];
}

const PASS = { pass: true, inconclusive: false };
const FAIL = { pass: false, inconclusive: false };
const INCONCLUSIVE = { pass: false, inconclusive: true };

function writeCache(entries: Array<[string, unknown]>): void {
  writeFileSync(
    join(cfgDir, "security-triage-results.json"),
    JSON.stringify(Object.fromEntries(entries), null, 2),
    "utf-8",
  );
}

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  cfgDir = mkdtempSync(join(tmpdir(), "llmext-stalefail-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("staleFailedModelIds", () => {
  it("returns a FAIL older than maxAgeMs and withholds one inside the window", () => {
    writeCache([
      row("vendor/old-fail", dayKey(30), FAIL),
      row("vendor/recent-fail", dayKey(1), FAIL),
    ]);
    const stale = staleFailedModelIds(7 * DAY_MS, NOW);
    expect([...stale]).toEqual(["vendor/old-fail"]);
  });

  it("never returns a model whose LATEST verdict is a pass, however old the failure was", () => {
    // Latest-wins: an ancient FAIL followed by a later PASS is not a failing
    // model at all, so it is not stale-failed either — re-queuing it would be
    // a pointless (on `paid`, billable) benchmark.
    writeCache([
      row("vendor/recovered", dayKey(40), FAIL),
      row("vendor/recovered", dayKey(20), PASS),
    ]);
    expect(benchmarkFailedModels().has("vendor/recovered")).toBe(false);
    expect([...staleFailedModelIds(7 * DAY_MS, NOW)]).toEqual([]);
  });

  it("treats an INCONCLUSIVE latest verdict as no failure at all", () => {
    writeCache([row("vendor/flaky", dayKey(40), INCONCLUSIVE)]);
    expect([...staleFailedModelIds(7 * DAY_MS, NOW)]).toEqual([]);
  });

  it("is empty when there is no cache file — a missing ledger is 'nothing to re-probe', never a crash", () => {
    expect([...staleFailedModelIds(7 * DAY_MS, NOW)]).toEqual([]);
  });

  it("fails CLOSED on a row with no usable date: an undated FAIL is never declared stale", () => {
    // A row the loader cannot date must not be re-probed on a guess — the
    // cheap error is "stays excluded one more cycle", not "re-benchmark on no
    // evidence".
    writeFileSync(
      join(cfgDir, "security-triage-results.json"),
      JSON.stringify({ "vendor/undated::::hash1": { score: FAIL } }),
      "utf-8",
    );
    expect([...staleFailedModelIds(7 * DAY_MS, NOW)]).toEqual([]);
  });
});
