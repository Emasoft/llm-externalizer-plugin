import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { backfillAllLedgers } from "./backfill-ledgers.js";

import { loadDataset as loadCodeTaskCases, validateDataset as validateCodeTaskCases } from "./code-task/dataset.js";
import { SCAN_FOLDER_CASES, datasetFingerprint as scanFolderFingerprint } from "./scan-folder/dataset.js";
import { CHECK_SPECS_FIXTURES, datasetFingerprint as checkSpecsFingerprint } from "./check-specs/dataset.js";
import { SEARCH_EXISTING_CASES } from "./search-existing/dataset.js";
import { loadDataset as loadTriageCases, resolveDatasetPath as resolveTriageDatasetPath } from "./security-triage/dataset.js";

// Each helper reproduces the SAME expression the production run function uses
// to compute datasetHash (backfillOwnLedger's own contract) — so a real
// matching-hash row can be constructed without hardcoding a hash the fixtures
// could drift out from under.
function codeTaskDatasetHash(): string {
  const cases = loadCodeTaskCases();
  validateCodeTaskCases(cases);
  return createHash("sha1").update(JSON.stringify(cases)).digest("hex").slice(0, 12);
}
function scanFolderDatasetHash(): string {
  void SCAN_FOLDER_CASES; // fixtures fingerprinted on disk, not the case list
  return scanFolderFingerprint();
}
function checkSpecsDatasetHash(): string {
  void CHECK_SPECS_FIXTURES;
  return checkSpecsFingerprint();
}
function searchExistingDatasetHash(): string {
  return createHash("sha1").update(JSON.stringify(SEARCH_EXISTING_CASES)).digest("hex").slice(0, 12);
}
function triageDatasetHash(): string {
  const path = resolveTriageDatasetPath();
  loadTriageCases(path);
  return createHash("sha1").update(readFileSync(path, "utf-8")).digest("hex").slice(0, 12);
}

const TOOLS: {
  tool: string;
  file: string;
  hash: () => string;
  passScore: Record<string, unknown>;
}[] = [
  { tool: "code_task", file: "code-task-results.json", hash: codeTaskDatasetHash, passScore: { macroF1: 0.9, microRecall: 0.9, failedCases: 0 } },
  { tool: "scan_folder", file: "scan-folder-results.json", hash: scanFolderDatasetHash, passScore: { microF1: 0.95, microRecall: 0.95, coverage: 0.95 } },
  { tool: "check_against_specs", file: "check-specs-results.json", hash: checkSpecsDatasetHash, passScore: { microF1: 0.95, microRecall: 0.95, coverage: 0.95 } },
  { tool: "search_existing_implementations", file: "search-existing-results.json", hash: searchExistingDatasetHash, passScore: { microF1: 0.95, microRecall: 0.95, coverage: 0.95 } },
  { tool: "security_scan", file: "security-triage-results.json", hash: triageDatasetHash, passScore: { pass: true, inconclusive: false } },
];

let configDir: string;
const ORIGINAL_CONFIG_DIR = process.env.LLM_EXT_CONFIG_DIR;

beforeEach(() => {
  // config.ts's getConfigDir() only allows a dir under $HOME or /private/tmp
  // (macOS's canonicalized /tmp) — os.tmpdir() resolves under /var/folders/…
  // and gets rejected, so anchor explicitly in the allowed tree.
  configDir = mkdtempSync(join("/private/tmp", "llm-ext-backfill-test-"));
  process.env.LLM_EXT_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe("backfillAllLedgers", () => {
  it("upgrades a matching-hash row, leaves a mismatched-hash row and an already-judged row alone, no network calls", () => {
    for (const t of TOOLS) {
      const hash = t.hash();
      const cache = {
        [`m/match::2026-05-01::${hash}`]: { date: "2026-05-01", datasetHash: hash, score: t.passScore },
        [`m/mismatch::2026-05-01::OLDHASH`]: { date: "2026-05-01", datasetHash: "OLDHASH", score: t.passScore },
        [`m/already-judged::2026-05-01::${hash}`]: {
          date: "2026-05-01",
          datasetHash: hash,
          score: t.passScore,
          qualityPass: false,
        },
      };
      writeFileSync(join(configDir, t.file), JSON.stringify(cache), "utf-8");
    }

    const results = backfillAllLedgers();
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.tool).sort()).toEqual(TOOLS.map((t) => t.tool).sort());
    for (const r of results) expect(r.upgraded).toBe(1);

    for (const t of TOOLS) {
      const hash = t.hash();
      const cache = JSON.parse(readFileSync(join(configDir, t.file), "utf-8")) as Record<
        string,
        { qualityPass?: boolean }
      >;
      expect(cache[`m/match::2026-05-01::${hash}`].qualityPass).toBeDefined();
      expect(cache[`m/mismatch::2026-05-01::OLDHASH`].qualityPass).toBeUndefined();
      expect(cache[`m/already-judged::2026-05-01::${hash}`].qualityPass).toBe(false); // untouched, never overwritten
    }

    // Second pass over the now-upgraded ledgers upgrades nothing further.
    const second = backfillAllLedgers();
    for (const r of second) expect(r.upgraded).toBe(0);
  });

  it("touches no file and upgrades nothing when the config dir has no ledgers yet", () => {
    const results = backfillAllLedgers();
    for (const r of results) expect(r.upgraded).toBe(0);
    for (const t of TOOLS) {
      expect(existsSync(join(configDir, t.file))).toBe(false);
    }
  });
});
