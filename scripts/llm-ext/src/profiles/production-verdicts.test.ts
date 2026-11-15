import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadDataset as loadCodeTaskCases, validateDataset as validateCodeTaskCases } from "../benchmark/code-task/dataset.js";
import { hqScanQualityHash } from "../benchmark/free-fitness-ledger.js";
import { datasetFingerprint } from "../benchmark/scan-folder/dataset.js";
import { datasetHashFor } from "../benchmark/text-tools/index.js";
import { DEFAULT_SCOUT_ACCURACY_TARGET_BYTES, DEFAULT_SCOUT_ACCURACY_THRESHOLD } from "../config.js";
import { scoutAccuracyHash } from "../mass_scouting/scout-accuracy-ledger.js";
import { productionVerdictReader } from "./production-verdicts.js";
import { fileSources, verdict } from "./verdicts.js";

// The code-task benchmark's own dataset hash expression (code-task/index.ts datasetFingerprint), as
// backfill-ledgers.test.ts reproduces it: a legacy row is only backfilled under the CURRENT hash.
function codeTaskDatasetHash(): string {
  const cases = loadCodeTaskCases();
  validateCodeTaskCases(cases);
  return createHash("sha1").update(JSON.stringify(cases)).digest("hex").slice(0, 12);
}

let configDir: string;
const ORIGINAL_CONFIG_DIR = process.env.LLM_EXT_CONFIG_DIR;

beforeEach(() => {
  // getConfigDir() only allows a dir under $HOME or /tmp; os.tmpdir() resolves under /var/folders on macOS.
  configDir = mkdtempSync(join("/tmp", "llm-ext-prodverdict-test-"));
  process.env.LLM_EXT_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe("productionVerdictReader", () => {
  it("carries the three current hashes exactly as their benchmarks compute them, frozen", () => {
    const src = productionVerdictReader(configDir);
    expect(src.currentHash.scout).toBe(scoutAccuracyHash(DEFAULT_SCOUT_ACCURACY_THRESHOLD, DEFAULT_SCOUT_ACCURACY_TARGET_BYTES));
    expect(src.currentHash.hqScanQuality).toBe(hqScanQualityHash(datasetFingerprint()));
    for (const kind of ["summarize", "topics", "sem_deduplicate", "describe"] as const) {
      expect(src.currentHash.textTool(kind)).toBe(datasetHashFor(kind));
    }
    expect(Object.isFrozen(src)).toBe(true);
    expect(Object.isFrozen(src.currentHash)).toBe(true);
  });

  it("refuses a config dir that is not the active one", () => {
    const other = mkdtempSync(join("/tmp", "llm-ext-prodverdict-other-"));
    try {
      expect(() => productionVerdictReader(other)).toThrow(/is not the active config dir/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("backfills a legacy code-task row at the current hash before reading: untested before, pass after", () => {
    const hash = codeTaskDatasetHash();
    const key = `m/legacy::2026-05-01::${hash}`;
    const ledger = join(configDir, "code-task-results.json");
    writeFileSync(
      ledger,
      JSON.stringify({ [key]: { date: "2026-05-01", datasetHash: hash, score: { macroF1: 0.9, microRecall: 0.9, failedCases: 0 } } }),
      "utf-8",
    );
    const plain = fileSources(configDir, { scout: undefined, hqScanQuality: undefined, textTool: () => undefined });
    expect(verdict(plain, "m/legacy", "code_task").verdict).toBe("untested");

    const result = verdict(productionVerdictReader(configDir), "m/legacy", "code_task");
    expect(result).toEqual({ verdict: "pass", store: "S2", at: "2026-05-01" });
    const onDisk = JSON.parse(readFileSync(ledger, "utf-8")) as Record<string, { qualityPass?: boolean }>;
    expect(onDisk[key].qualityPass).toBe(true);
  });

  it("judges a text-tools row only under the current text-tools hash", () => {
    const current = datasetHashFor("summarize");
    writeFileSync(
      join(configDir, "text-tools-results.json"),
      JSON.stringify({
        [`summarize::m/current::2026-05-01::${current}`]: { date: "2026-05-01", qualityPass: true },
        "summarize::m/stale::2026-05-01::OLDHASH": { date: "2026-05-01", qualityPass: true },
      }),
      "utf-8",
    );
    const src = productionVerdictReader(configDir);
    expect(verdict(src, "m/current", "summarize").verdict).toBe("pass");
    expect(verdict(src, "m/stale", "summarize").verdict).toBe("untested");
  });
});
