import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { FetchImpl } from "../security_scan/judge.js";
import {
  datasetFingerprint,
  scannedFilesFor,
  SCAN_FOLDER_CASES,
  deriveMatchingFiles,
  type ScanFolderCase,
} from "./scan-folder/dataset.js";
import { runHqScanQualityBenchmark } from "./hq-scan-quality.js";
import { hqScanQualityHash, freeFitnessUnlocked } from "./free-fitness-ledger.js";

const FILE_DECISIONS = SCAN_FOLDER_CASES.reduce((n, c) => n + scannedFilesFor(c).length, 0);

/** The request's concatenated message text — how the fakes route by file. */
function requestText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).map((m) => m.content ?? "").join("\n");
}

/** Which fixture is in this request? The pipeline tags each file with its
 *  path in the prompt — matched the same way the bench-runner test does. */
function fixtureOfRequest(body: string): string {
  const text = requestText(body);
  const all = scannedFilesFor(SCAN_FOLDER_CASES[0]!);
  const hit = all.find((rel) => text.includes(`/${rel}`));
  if (!hit) throw new Error(`no fixture matched the request`);
  return hit;
}

function caseOfRequest(body: string): ScanFolderCase {
  const text = requestText(body);
  const hit = SCAN_FOLDER_CASES.find((c) => text.includes(c.criterion.split("\n")[0]));
  if (!hit) throw new Error("no case matched the request");
  return hit;
}

/** The oracle: answers from the corpus-derived ground truth. */
const ORACLE = (body: string): string => {
  const c = caseOfRequest(body);
  const file = fixtureOfRequest(body);
  return deriveMatchingFiles(c).includes(file) ? `MATCH: proof in ${file}` : "NO_MATCH";
};

function fakeOpenRouter(answer: (body: string) => string): FetchImpl {
  return (async (_url: string, init: { body: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: answer(init.body) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 50 },
    }),
    text: async () => "",
  })) as unknown as FetchImpl;
}

// The hq benchmark drives the REAL scan-folder bench-runner, whose catalog
// lookups (realFetch default) are replaced by the seam — no OpenRouterModel
// decoration happens inside, so no catalog stub is needed.

let cfg = "";
let prevCfgDir: string | undefined;
let prevKey: string | undefined;

beforeEach(() => {
  cfg = mkdtempSync(join("/private/tmp", "hq-cfg-"));
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevKey = process.env.OPENROUTER_API_KEY;
  process.env.LLM_EXT_CONFIG_DIR = cfg;
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = prevKey;
  rmSync(cfg, { recursive: true, force: true });
});

describe("hq-scan quality benchmark (addendum H part 2)", () => {
  it("runs the REAL scan-folder pipeline over the golden corpus — one call per file decision", async () => {
    const r = await runHqScanQualityBenchmark("v/oracle:free", {
      apiKey: "k",
      datasetHash: datasetFingerprint(),
      fetchImpl: fakeOpenRouter(ORACLE),
    });
    // The dataset fingerprint the unlock computes — same corpus, same hash.
    expect(hqScanQualityHash(datasetFingerprint())).toBeDefined();
    expect(r.pass).toBe(true);
    expect(r.inconclusive).toBe(false);
    expect(r.microF1).toBe(1);
    expect(r.microRecall).toBe(1);
    expect(r.coverage).toBe(1);
    expect(r.failures).toEqual([]);
  });

  it("a model below the EXISTING quality bar FAILS and never unlocks the tool", async () => {
    const r = await runHqScanQualityBenchmark("v/silent:free", {
      apiKey: "k",
      datasetHash: datasetFingerprint(),
      fetchImpl: fakeOpenRouter(() => "NO_MATCH"),
    });
    expect(r.pass).toBe(false);
    expect(r.microRecall).toBe(0);
    expect(freeFitnessUnlocked("high_quality_scan")).toBe(false);
  });

  it("an oracle pass records the unlock verdict under the CURRENT corpus hash", async () => {
    expect(freeFitnessUnlocked("high_quality_scan")).toBe(false); // locked before
    await runHqScanQualityBenchmark("v/oracle:free", {
      apiKey: "k",
      datasetHash: datasetFingerprint(),
      fetchImpl: fakeOpenRouter(ORACLE),
    });
    expect(freeFitnessUnlocked("high_quality_scan")).toBe(true); // unlocked after
  });

  it("the corpus FILE_DECISIONS invariant holds (the bar is measured over the real corpus)", () => {
    expect(SCAN_FOLDER_CASES.length).toBeGreaterThanOrEqual(3);
    expect(FILE_DECISIONS).toBe(SCAN_FOLDER_CASES.length * 12);
  });
});
