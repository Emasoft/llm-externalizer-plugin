import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  tooManyUnanswered,
  isUnansweredFilesNonEvidence,
  isFailedCasesNonEvidence,
  isTextToolNonEvidence,
  evidenceQualityPass,
  recordQualityPass,
  NON_EVIDENCE_REASON,
} from "./quality-evidence.js";
import {
  aggregateScores as codeAggregate,
  answeredOnlyScore as codeAnsweredOnly,
  passesThresholds as codeTaskPasses,
  type CaseScore as CodeCaseScore,
} from "./code-task/score.js";
import {
  aggregateScores as searchAggregate,
  answeredOnlyScore as searchAnsweredOnly,
  passesThresholds as searchPasses,
  scoreCase as searchScoreCase,
  type SearchExistingScore,
  type SectionVerdict,
} from "./search-existing/score.js";
import {
  aggregateTextToolScores,
  answeredOnlyTextToolScore,
  passesTextToolThresholds as textToolPasses,
} from "./text-tools/score.js";
import { backfillAllLedgers } from "./backfill-ledgers.js";
import { backfillLegacyQualityPass } from "./backfill-quality-pass.js";
import { judgeCodeTask } from "./code-task/select.js";
import { loadDataset as loadCodeTaskCases, validateDataset as validateCodeTaskCases } from "./code-task/dataset.js";
import { datasetFingerprint as scanFolderFingerprint } from "./scan-folder/dataset.js";
import { datasetFingerprint as checkSpecsFingerprint } from "./check-specs/dataset.js";
import { SEARCH_EXISTING_CASES } from "./search-existing/dataset.js";
import { loadDataset as loadTriageCases, resolveDatasetPath as resolveTriageDatasetPath } from "./security-triage/dataset.js";

describe("the shared non-evidence rule", () => {
  it("tooManyUnanswered: more than a quarter of the cases, compared as counts (2 of 8 scored, 3 of 8 abstains)", () => {
    expect(tooManyUnanswered(2, 8)).toBe(false);
    expect(tooManyUnanswered(3, 8)).toBe(true);
    expect(tooManyUnanswered(8, 8)).toBe(true);
    expect(tooManyUnanswered(3, 13)).toBe(false);
    expect(tooManyUnanswered(4, 13)).toBe(true);
    expect(tooManyUnanswered(0, 0)).toBe(false); // an empty run is not provable non-evidence
  });

  it("file tools: over a quarter of the files unanswered abstains; unparseable answers stay scored; old rows keep the coverage-0 rule", () => {
    const thirteen = (unanswered: number, unparseable = 0): ReturnType<typeof searchScore> =>
      searchScore([
        ...Array.from({ length: unanswered }, (): [boolean, SectionVerdict | undefined] => [false, undefined]),
        ...Array.from({ length: unparseable }, (): [boolean, SectionVerdict | undefined] => [false, "unparseable"]),
        ...Array.from({ length: 13 - unanswered - unparseable }, (): [boolean, SectionVerdict | undefined] => [false, "no"]),
      ]);
    expect(isUnansweredFilesNonEvidence(thirteen(4))).toBe(true);
    expect(isUnansweredFilesNonEvidence(thirteen(3))).toBe(false);
    expect(isUnansweredFilesNonEvidence(thirteen(13))).toBe(true); // nothing answered at all
    expect(isUnansweredFilesNonEvidence(thirteen(0, 13))).toBe(false); // answered, but broke the output contract
    // Rows written before the `unanswered` field: only coverage exactly 0 is provable non-evidence.
    expect(isUnansweredFilesNonEvidence({ microF1: 0, microRecall: 0, coverage: 0 })).toBe(true);
    expect(isUnansweredFilesNonEvidence({ coverage: 0.083 })).toBe(false);
    expect(isUnansweredFilesNonEvidence({ coverage: 0.923 })).toBe(false);
    expect(isUnansweredFilesNonEvidence({ microF1: 0 })).toBe(false);
    expect(isUnansweredFilesNonEvidence({ coverage: Number.NaN })).toBe(false);
    expect(isUnansweredFilesNonEvidence(null)).toBe(false);
  });

  it("code-task: 2 of 8 failed cases is scored, 3 of 8 abstains, all failed abstains even though macro-F1 is 0.375", () => {
    const failed = (n: number): unknown => {
      const cases = [...Array.from({ length: n }, () => codeCase(0, true)), ...Array.from({ length: 8 - n }, () => codeCase(1))];
      return codeAggregate(cases);
    };
    expect(isFailedCasesNonEvidence(failed(2))).toBe(false);
    expect(isFailedCasesNonEvidence(failed(3))).toBe(true);
    expect(isFailedCasesNonEvidence({ cases: eightFailed, failedCases: 8, macroF1: 0.375 })).toBe(true);
    expect(isFailedCasesNonEvidence({ cases: [], failedCases: 0 })).toBe(false);
    expect(isFailedCasesNonEvidence({ failedCases: 8 })).toBe(false); // no cases list — not provable
    expect(isFailedCasesNonEvidence(undefined)).toBe(false);
  });

  it("code-task: a partly answered run is judged on the answered cases only (2 of 8 failed, the rest perfect, passes)", () => {
    const cases = [...Array.from({ length: 2 }, () => codeCase(0, true)), ...Array.from({ length: 6 }, () => codeCase(1))];
    const score = codeAggregate(cases);
    // The raw score fails: the two failed cases drag macro-F1 down and exceed maxFailedCases (1).
    expect(codeTaskPasses(score).pass).toBe(false);
    expect(evidenceQualityPass(score, isFailedCasesNonEvidence, (s) => codeTaskPasses(codeAnsweredOnly(s)).pass)).toBe(true);
  });

  it("code-task: an empty returned list on a case with no failure record is a real answer, not an unanswered case", () => {
    const clean = Array.from({ length: 8 }, () => codeCase(1)); // returned: [], failed: false — a genuine NO DEFECTS
    expect(isFailedCasesNonEvidence(codeAggregate(clean))).toBe(false);
  });

  it("file tools: a partly answered run is judged on the answered files only (1 of 13 unanswered expected-YES file is not a miss)", () => {
    const entries: [boolean, SectionVerdict | undefined][] = [
      [true, "yes"],
      [true, "yes"],
      [true, "yes"],
      [true, undefined], // expected-YES file whose request failed
      ...Array.from({ length: 9 }, (): [boolean, SectionVerdict | undefined] => [false, "no"]),
    ];
    const score = searchScore(entries);
    expect(searchPasses(score).pass).toBe(false); // raw recall 0.75 < 0.85
    expect(evidenceQualityPass(score, isUnansweredFilesNonEvidence, (s) => searchPasses(searchAnsweredOnly(s)).pass)).toBe(true);
  });

  it("file tools: an unparseable answer on an expected-YES file still counts as a miss (only unanswered files leave the denominator)", () => {
    const entries: [boolean, SectionVerdict | undefined][] = [
      [true, "yes"],
      [true, "yes"],
      [true, "yes"],
      [true, "unparseable"],
      ...Array.from({ length: 9 }, (): [boolean, SectionVerdict | undefined] => [false, "no"]),
    ];
    const score = searchScore(entries);
    expect(evidenceQualityPass(score, isUnansweredFilesNonEvidence, (s) => searchPasses(searchAnsweredOnly(s)).pass)).toBe(false);
  });

  it("file tools: more than a quarter of the files unanswered abstains instead of storing a verdict", () => {
    const entries: [boolean, SectionVerdict | undefined][] = [
      ...Array.from({ length: 4 }, (): [boolean, SectionVerdict | undefined] => [true, undefined]),
      ...Array.from({ length: 9 }, (): [boolean, SectionVerdict | undefined] => [false, "no"]),
    ];
    expect(evidenceQualityPass(searchScore(entries), isUnansweredFilesNonEvidence, (s) => searchPasses(searchAnsweredOnly(s)).pass)).toBeUndefined();
  });

  it("text tools: only cases with no content at all are unanswered; an echo or invalid-output case stays a wrong answer", () => {
    // 6 cases: 4 scored 1.0, one echo (failed, content present), one with no content (failed, unanswered).
    const score = aggregateTextToolScores([1, 1, 1, 1, 0, 0], 2, 6, 1);
    expect(textToolPasses(score).pass).toBe(false); // raw: 2 failed cases > max 1
    expect(isTextToolNonEvidence(score)).toBe(false); // 1 of 6 unanswered
    expect(evidenceQualityPass(score, isTextToolNonEvidence, (s) => textToolPasses(answeredOnlyTextToolScore(s)).pass)).toBe(true);
    expect(isTextToolNonEvidence(aggregateTextToolScores([1, 1, 1, 0, 0, 0], 3, 6, 3))).toBe(true); // half unanswered
    expect(isTextToolNonEvidence(aggregateTextToolScores([1, 1, 1, 0, 0, 0], 3, 6))).toBe(false); // older row, no field
  });

  it("evidenceQualityPass abstains on non-evidence and otherwise returns the threshold verdict", () => {
    const never = (): boolean => false;
    expect(evidenceQualityPass({ coverage: 0 }, isUnansweredFilesNonEvidence, never)).toBeUndefined();
    expect(evidenceQualityPass({ coverage: 0.5 }, isUnansweredFilesNonEvidence, never)).toBe(false);
    expect(evidenceQualityPass({ coverage: 0.95 }, isUnansweredFilesNonEvidence, () => true)).toBe(true);
  });

  it("recordQualityPass removes an earlier false on abstention instead of leaving it", () => {
    const row: { qualityPass?: boolean } = { qualityPass: false };
    recordQualityPass(row, undefined, "test ledger row");
    expect("qualityPass" in row).toBe(false);
    recordQualityPass(row, true, "test ledger row");
    expect(row.qualityPass).toBe(true);
  });
});

describe("selection judgement and ledger-removal logging (TRDD-90BXJ2KO)", () => {
  it("judgeCodeTask judges on answered cases only and refuses a run with over a quarter of its cases unanswered", () => {
    const partial = codeAggregate([codeCase(0, true), codeCase(0, true), ...Array.from({ length: 6 }, () => codeCase(1))]);
    expect(codeTaskPasses(partial).pass).toBe(false); // raw: 2 failed cases exceed maxFailedCases
    expect(judgeCodeTask(partial).pass).toBe(true);
    const outage = codeAggregate([codeCase(0, true), codeCase(0, true), codeCase(0, true), ...Array.from({ length: 5 }, () => codeCase(1))]);
    expect(judgeCodeTask(outage).pass).toBe(false);
    expect(judgeCodeTask(outage).failures).toEqual([NON_EVIDENCE_REASON]);
  });

  it("every removal of a stored false writes one stderr line naming the ledger and row", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const row: { qualityPass?: boolean } = { qualityPass: false };
      recordQualityPass(row, undefined, "code-task-results.json row m/x::d::h");
      const cache = { "m/y::d::h": { datasetHash: "h", score: { cases: eightFailed, failedCases: 8 }, qualityPass: false } };
      expect(backfillLegacyQualityPass(cache, "h", () => true, isFailedCasesNonEvidence, "code-task-results.json")).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("code-task-results.json row m/x::d::h");
    expect(writes[1]).toContain("code-task-results.json row m/y::d::h");
  });
});

/** A code-task per-case score; `failed` marks a case the pipeline never produced a report for. */
function codeCase(f1: number, failed = false): CodeCaseScore {
  return {
    caseId: "c",
    file: "f.ts",
    expected: [],
    returned: [],
    truePositives: [],
    falsePositives: [],
    falseNegatives: [],
    hallucinated: [],
    universeSize: 1,
    mode: failed ? "empty" : "anchored",
    precision: f1,
    recall: f1,
    f1,
    exactMatch: false,
    failed,
    defectClass: "x",
  };
}

/** One search-family case built by the REAL scoreCase from [expectedYes, verdict] pairs (undefined = no report). */
function searchScore(entries: [boolean, SectionVerdict | undefined][]): SearchExistingScore {
  const files = entries.map((_, i) => `f${i}`);
  const expectedYes = new Set(files.filter((_, i) => entries[i][0]));
  const verdicts = new Map<string, SectionVerdict>();
  entries.forEach(([, v], i) => {
    if (v !== undefined) verdicts.set(`f${i}`, v);
  });
  return searchAggregate([searchScoreCase("c", files, expectedYes, verdicts)]);
}

// Same hash expressions the production backfillOwnLedger uses (see backfill-ledgers.test.ts).
function codeTaskDatasetHash(): string {
  const cases = loadCodeTaskCases();
  validateCodeTaskCases(cases);
  return createHash("sha1").update(JSON.stringify(cases)).digest("hex").slice(0, 12);
}
function searchExistingDatasetHash(): string {
  return createHash("sha1").update(JSON.stringify(SEARCH_EXISTING_CASES)).digest("hex").slice(0, 12);
}
function triageDatasetHash(): string {
  const path = resolveTriageDatasetPath();
  loadTriageCases(path);
  return createHash("sha1").update(readFileSync(path, "utf-8")).digest("hex").slice(0, 12);
}

const eightFailed = Array.from({ length: 8 }, () => codeCase(0, true));
const eightAnsweredFail = Array.from({ length: 8 }, () => codeCase(0.3125));
const FILE_FAMILY_GENUINE_FAIL = searchScore([
  [true, "yes"], // TP
  [false, "yes"], // FP
  [true, "no"], // FN
  [false, "no"], // TN
  [false, "no"], // TN
  [false, "unparseable"],
  [false, "unparseable"],
  [false, "unparseable"],
  [false, "unparseable"],
]);
const TOOLS: { tool: string; file: string; hash: () => string; outage: unknown; genuineFail: unknown }[] = [
  {
    tool: "code_task",
    file: "code-task-results.json",
    hash: codeTaskDatasetHash,
    outage: { cases: eightFailed, failedCases: 8, macroF1: 0.375, microRecall: 0 },
    genuineFail: { cases: eightAnsweredFail, failedCases: 0, macroF1: 0.3125, microRecall: 0.2 },
  },
  {
    tool: "scan_folder",
    file: "scan-folder-results.json",
    hash: scanFolderFingerprint,
    outage: { microF1: 0, microRecall: 0, coverage: 0 },
    genuineFail: FILE_FAMILY_GENUINE_FAIL,
  },
  {
    tool: "check_against_specs",
    file: "check-specs-results.json",
    hash: checkSpecsFingerprint,
    outage: { microF1: 0, microRecall: 0, coverage: 0 },
    genuineFail: FILE_FAMILY_GENUINE_FAIL,
  },
  {
    tool: "search_existing_implementations",
    file: "search-existing-results.json",
    hash: searchExistingDatasetHash,
    outage: { microF1: 0, microRecall: 0, coverage: 0 },
    genuineFail: FILE_FAMILY_GENUINE_FAIL,
  },
];

let configDir: string;
const ORIGINAL_CONFIG_DIR = process.env.LLM_EXT_CONFIG_DIR;

beforeEach(() => {
  // getConfigDir() only allows a dir under $HOME or /tmp, so anchor in /tmp.
  configDir = mkdtempSync(join("/tmp", "llm-ext-quality-evidence-test-"));
  process.env.LLM_EXT_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe("zero-call backfill over non-evidence rows, per tool", () => {
  it("abstains on an outage row, repairs a non-evidence false, still judges a genuine fail, never touches a genuine false", () => {
    for (const t of TOOLS) {
      const hash = t.hash();
      const cache = {
        [`m/outage::2026-08-02::${hash}`]: { date: "2026-08-02", datasetHash: hash, score: t.outage },
        // Already backfilled to false by the pre-rule code, under an older dataset hash.
        "m/repair::2026-08-02::OLDHASH": { date: "2026-08-02", datasetHash: "OLDHASH", score: t.outage, qualityPass: false },
        [`m/genuine::2026-08-02::${hash}`]: { date: "2026-08-02", datasetHash: hash, score: t.genuineFail },
        [`m/judged::2026-08-02::${hash}`]: { date: "2026-08-02", datasetHash: hash, score: t.genuineFail, qualityPass: false },
      };
      writeFileSync(join(configDir, t.file), JSON.stringify(cache), "utf-8");
    }
    const triageHash = triageDatasetHash();
    const triageInconclusive = { date: "2026-08-02", datasetHash: triageHash, score: { pass: false, inconclusive: true }, qualityPass: false };
    writeFileSync(join(configDir, "security-triage-results.json"), JSON.stringify({ [`m/t::2026-08-02::${triageHash}`]: triageInconclusive }), "utf-8");

    const results = backfillAllLedgers();
    for (const t of TOOLS) {
      // repair + genuine; the outage row is NOT counted (it is left unjudged).
      expect(results.find((r) => r.tool === t.tool)?.upgraded, t.tool).toBe(2);
      const onDisk = JSON.parse(readFileSync(join(configDir, t.file), "utf-8")) as Record<string, { qualityPass?: boolean }>;
      const hash = t.hash();
      expect("qualityPass" in onDisk[`m/outage::2026-08-02::${hash}`], t.tool).toBe(false);
      expect("qualityPass" in onDisk["m/repair::2026-08-02::OLDHASH"], t.tool).toBe(false);
      expect(onDisk[`m/genuine::2026-08-02::${hash}`].qualityPass, t.tool).toBe(false);
      expect(onDisk[`m/judged::2026-08-02::${hash}`].qualityPass, t.tool).toBe(false);
    }
    // Security-triage keeps its own `inconclusive` abstention and is not given the repair.
    expect(results.find((r) => r.tool === "security_scan")?.upgraded).toBe(0);

    // Idempotent: a second pass changes nothing.
    for (const r of backfillAllLedgers()) expect(r.upgraded, r.tool).toBe(0);
  });
});
