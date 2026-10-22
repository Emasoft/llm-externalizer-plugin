// WK-01 (TRDD-IYL8GCAR): characterization tests of the 6 benchmark workloads' ORCHESTRATORS
// (code-task, scan-folder, search-existing, security-triage, check-specs, text-tools).
//
// They pin what the workloads do TODAY, so the workload-kit migration (WK-03..WK-08) can be proven
// to change nothing: ledger file name, ledger key, dataset fingerprint formula, cache hit / miss /
// force, the free-only and paid-benchmark gates, the same-or-cheaper selection, the report file
// names, the JSON report keys and the summary line. The orchestrators call the REAL code; the only
// seams are the two the code itself exposes: the global fetch (the public OpenRouter catalog, a
// stub that refuses every other URL, so no test can reach the network) and `fetchImpl` (the model
// call). Every ledger row is pre-seeded, so a cache hit means no model call is made at all.
// Config dir and report dir are under /tmp; the user's settings file is never read or written.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setActiveFreeOnly } from "../config.js";
import { setAllowPaidModels } from "../paid-switch.js";
import { setPaidBenchmarksAllowed } from "./discover.js";
import type { FetchImpl } from "../security_scan/judge.js";
import { describeWorkload as describeCodeTask, runCodeAuditBenchmark } from "./code-task/index.js";
import { loadDataset as loadCodeTaskCases } from "./code-task/dataset.js";
import { describeWorkload as describeScanFolder, runScanFolderBenchmark } from "./scan-folder/index.js";
import { datasetFingerprint as scanFolderFingerprint } from "./scan-folder/dataset.js";
import {
  describeWorkload as describeSearchExisting,
  runSearchExistingBenchmark,
} from "./search-existing/index.js";
import { SEARCH_EXISTING_CASES } from "./search-existing/dataset.js";
import {
  describeWorkload as describeSecurityTriage,
  runSecurityTriageBenchmark,
} from "./security-triage/index.js";
import { loadDataset as loadTriageCases, resolveDatasetPath } from "./security-triage/dataset.js";
import { describeWorkload as describeCheckSpecs, runCheckSpecsBenchmark } from "./check-specs/index.js";
import { datasetFingerprint as checkSpecsFingerprint } from "./check-specs/dataset.js";
import {
  describeWorkload as describeTextTool,
  runDescribeBenchmark,
  runSemDedupBenchmark,
  runSummarizeBenchmark,
  runTopicsBenchmark,
} from "./text-tools/index.js";
import {
  DESCRIBE_CASES,
  SEM_DEDUP_CASES,
  SUMMARIZE_CASES,
  TOPICS_CASES,
} from "./text-tools/dataset.js";
import type { BenchmarkWorkload } from "./workload-types.js";

import {
  normalisedCheckSpecsPromptChars,
  normalisedCodeTaskPromptChars,
  normalisedScanFolderPromptChars,
  normalisedSearchExistingPromptChars,
  type NormalisedPromptChars,
} from "./path-normalized-count.js";

// ── Shared scenario ─────────────────────────────────────────────────────────

const DAY = "2026-03-04";
const INCUMBENT = "v/incumbent"; // in 0.10 / out 0.20 per M
const CHEAP_PASS = "v/cheap-pass"; // 0.05 / 0.10, scores 0.95
const CHEAP_FAIL = "v/cheap-fail"; // 0.05 / 0.10, fails the bar
const PRICEY = "v/pricey"; // 0.20 / 0.40, scores 0.99 but is dearer than the incumbent
const FREE = "v/free-one:free";

function orModel(id: string, inPerM: number, outPerM: number): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 1_000_000,
    top_provider: { max_completion_tokens: 128_000 },
    // OpenRouter prices PER TOKEN; the orchestrator scales to $/M.
    pricing: { prompt: String(inPerM / 1e6), completion: String(outPerM / 1e6) },
    supported_parameters: ["structured_outputs", "reasoning"],
  };
}

const CATALOG = [
  orModel(INCUMBENT, 0.1, 0.2),
  orModel(CHEAP_PASS, 0.05, 0.1),
  orModel(CHEAP_FAIL, 0.05, 0.1),
  orModel(PRICEY, 0.2, 0.4),
  orModel(FREE, 0, 0),
];

const PRICE: Record<string, [number, number]> = {
  [INCUMBENT]: [0.1, 0.2],
  [CHEAP_PASS]: [0.05, 0.1],
  [CHEAP_FAIL]: [0.05, 0.1],
  [PRICEY]: [0.2, 0.4],
  [FREE]: [0, 0],
};

const sha12 = (data: string | Buffer): string => createHash("sha1").update(data).digest("hex").slice(0, 12);

/** What a workload exposes to the shared scenario. */
interface Spec {
  /** describe() title, also the GOLDEN key. */
  name: string;
  /** Ledger file inside the config dir. */
  cacheFile: string;
  /** The dataset fingerprint, computed here with the formula the workload documents. */
  hash: () => string;
  /** Ledger key of one row. */
  key: (model: string, date: string, hash: string) => string;
  /** The score object a ledger row carries for `model`, for a mean quality `s` in [0,1]. */
  score: (s: number, model: string) => Record<string, unknown>;
  /** Ledger fields beyond the common ones. */
  extra: (s: number) => Record<string, unknown>;
  /** Number of dataset cases (the report's caseCount). */
  caseCount: () => number;
  /** `<stamp>-<reportSlug>-benchmark.{json,md}` */
  reportSlug: string;
  /** First line of the markdown report. */
  mdTitle: string;
  /** The word the selection reasons call the benchmark. */
  benchLabel: string;
  /** Does the run backfill qualityPass on legacy ledger rows? (text-tools has no such step.) */
  backfills: boolean;
  /** Progress line after the dataset is loaded. */
  loaded: (hash: string) => string;
  /** Progress line announcing how many models are assessed. */
  assessing: (n: number) => string;
  /** Progress line (after the 4-space indent and the model id) for a scored row. */
  verdict: (s: number, pass: boolean) => string;
  /** describeWorkload(), pinned exactly. */
  workload: () => BenchmarkWorkload;
  /**
   * The workload description, pinned exactly — EXCEPT `promptCharsPerModel`,
   * which is deliberately absent from every spec.
   *
   * That field is the real count over the real prompt, and the real prompt
   * embeds every file's ABSOLUTE path, so for the four file-sending workloads
   * the count depends on where the repo is cloned and CANNOT be a literal.
   * Their canonical, path-free size is pinned in `expectedNormalisedPromptChars`
   * instead — one number, one meaning, whatever the workload.
   */
  expectedWorkload: Omit<BenchmarkWorkload, "promptCharsPerModel">;
  /**
   * The workload's prompt size with the corpus's LOCATION normalised out — the
   * canonical count the pin holds, the SAME on every checkout.
   *
   * For the workloads whose prompt carries no file path (security-triage and
   * the text tools) the count is already path-independent, so this canonical
   * number IS their absolute number.
   */
  expectedNormalisedPromptChars: number;
  /**
   * The workload's prompt size measured PATH-INDEPENDENTLY — the fixture-root
   * prefix normalised out of the counted text (see path-normalized-count.ts).
   *
   * NULL for the workloads whose prompt carries no file path (security-triage
   * and the text tools): their absolute count is already path-independent, so
   * they need no second measurement.
   */
  normalisedPromptChars: NormalisedPromptChars | null;
  /** Run the orchestrator, normalised. */
  run: (opts: RunOpts) => Promise<Normalised>;
}

interface RunOpts {
  models: string[];
  incumbentModelId: string;
  outputDir: string;
  force?: boolean;
  onProgress: (m: string) => void;
  fetchImpl: FetchImpl;
}

interface Normalised {
  recommendedModelId: string;
  changed: boolean;
  summaryLine: string;
  costUsd: number;
  jsonReportPath: string;
  mdReportPath: string;
  assessedIds: string[];
  selection: {
    reason: string;
    rejected: { modelId: string; reason: string }[];
  };
}

interface Raw {
  recommendedModelId: string;
  changed: boolean;
  summaryLine: string;
  costUsd: number;
  jsonReportPath: string;
  selection: Normalised["selection"];
  reportPath?: string;
  mdReportPath?: string;
  results?: { modelId: string }[];
  scores?: { modelId: string }[];
}

function norm(r: Raw): Normalised {
  return {
    recommendedModelId: r.recommendedModelId,
    changed: r.changed,
    summaryLine: r.summaryLine,
    costUsd: r.costUsd,
    jsonReportPath: r.jsonReportPath,
    mdReportPath: (r.reportPath ?? r.mdReportPath) as string,
    assessedIds: (r.results ?? r.scores ?? []).map((a) => a.modelId),
    selection: r.selection,
  };
}

const plainKey = (m: string, d: string, h: string): string => `${m}::${d}::${h}`;
const toolKey = (tool: string) => (m: string, d: string, h: string): string => `${tool}::${m}::${d}::${h}`;
const failureReasons = (): Record<string, unknown> => ({ failureReasons: [] });
const f3 = (n: number): string => n.toFixed(3);
const PF = (pass: boolean): string => (pass ? "PASS" : "FAIL");

const codeTaskScore = (s: number): Record<string, unknown> => ({
  cases: [],
  microPrecision: s,
  microRecall: s,
  microF1: s,
  macroF1: s,
  exactMatches: 0,
  hallucinations: 0,
  failedCases: 0,
  anchoredRate: 1,
});

const coverageScore = (s: number): Record<string, unknown> => ({
  cases: [],
  microPrecision: s,
  microRecall: s,
  microF1: s,
  macroF1: s,
  coverage: 1,
});

const triageScore = (s: number, model: string): Record<string, unknown> => {
  const total = loadTriageCases().length;
  const pass = s >= 0.5;
  return {
    modelId: model,
    total,
    scoredCount: total,
    erroredCount: 0,
    errorRate: 0,
    correctCount: 0,
    correctRate: s,
    overFlagCount: 0,
    overFlagRate: 0,
    underFlagCount: 0,
    underFlagRate: 0,
    appropriatelyUncertainCount: 0,
    criticalCount: 0,
    criticalUnderFlags: 0,
    score: s,
    inconclusive: false,
    pass,
    failReasons: pass ? [] : ["score below the bar (characterization fixture)"],
    perCase: [],
  };
};

const textScore = (total: number) => (s: number): Record<string, unknown> => ({
  meanScore: s,
  failedCases: 0,
  totalCases: total,
});

function textSpec(
  tool: "summarize" | "topics" | "sem_deduplicate" | "describe",
  cases: readonly unknown[],
  run: (o: RunOpts) => Promise<unknown>,
  expectedWorkload: Omit<BenchmarkWorkload, "promptCharsPerModel">,
  expectedNormalisedPromptChars: number,
): Spec {
  return {
    name: `text-tools ${tool}`,
    cacheFile: "text-tools-results.json",
    hash: () => sha12(JSON.stringify(cases)),
    key: toolKey(tool),
    score: textScore(cases.length),
    extra: failureReasons,
    caseCount: () => cases.length,
    reportSlug: tool,
    mdTitle: `# ${tool} — model benchmark`,
    benchLabel: tool,
    backfills: false,
    loaded: (h) => `Loaded ${cases.length} golden ${tool} cases (dataset ${h}).`,
    assessing: (n) => `Assessing ${n} model(s) over ${cases.length} ${tool} cases…`,
    verdict: (s, pass) => `${PF(pass)} meanScore=${f3(s)} failed=0/${cases.length}`,
    workload: () => describeTextTool(tool),
    normalisedPromptChars: null,
    expectedWorkload,
    expectedNormalisedPromptChars,
    run: async (o) => norm((await run(o)) as Raw),
  };
}

const SPECS: Spec[] = [
  {
    name: "code-task",
    cacheFile: "code-task-results.json",
    hash: () => sha12(JSON.stringify(loadCodeTaskCases())),
    key: plainKey,
    score: codeTaskScore,
    extra: failureReasons,
    caseCount: () => loadCodeTaskCases().length,
    reportSlug: "code-task",
    mdTitle: "# code_task (CODE AUDIT) — model benchmark",
    benchLabel: "code-audit",
    backfills: true,
    loaded: (h) => `Loaded 8 golden cases (dataset ${h}).`,
    assessing: (n) => `Assessing ${n} model(s) over 8 cases…`,
    verdict: (s, pass) => `${PF(pass)} macroF1=${f3(s)} microR=${f3(s)} exact=0/8 halluc=0 fail=0`,
    workload: describeCodeTask,
    normalisedPromptChars: normalisedCodeTaskPromptChars(),
    expectedWorkload: { tool: "code_task", benchmark: "code-task", callsPerModel: 8, maxOutputTokensPerCall: 8192 },
    expectedNormalisedPromptChars: 123865,
    run: async (o) => norm(await runCodeAuditBenchmark(o)),
  },
  {
    name: "scan-folder",
    cacheFile: "scan-folder-results.json",
    hash: scanFolderFingerprint,
    key: plainKey,
    score: coverageScore,
    extra: failureReasons,
    caseCount: () => 3,
    reportSlug: "scan-folder",
    mdTitle: "# scan_folder (MASS SEARCH) — model benchmark",
    benchLabel: "mass-search",
    backfills: true,
    loaded: (h) => `Loaded 3 queries over 12 real files = 36 per-file decisions (corpus ${h}).`,
    assessing: (n) => `Assessing ${n} model(s) over 36 file decisions…`,
    verdict: (s, pass) => `${PF(pass)} microF1=${f3(s)} microP=${f3(s)} microR=${f3(s)} cov=1.000 unscored=0`,
    workload: describeScanFolder,
    normalisedPromptChars: normalisedScanFolderPromptChars(),
    expectedWorkload: { tool: "scan_folder", benchmark: "scan-folder", callsPerModel: 36, maxOutputTokensPerCall: 4096 },
    expectedNormalisedPromptChars: 350043,
    run: async (o) => norm(await runScanFolderBenchmark(o)),
  },
  {
    name: "search-existing",
    cacheFile: "search-existing-results.json",
    hash: () => sha12(JSON.stringify(SEARCH_EXISTING_CASES)),
    key: plainKey,
    score: coverageScore,
    extra: failureReasons,
    caseCount: () => SEARCH_EXISTING_CASES.length,
    reportSlug: "search-existing",
    mdTitle: "# search_existing_implementations — model benchmark",
    benchLabel: "search-existing",
    backfills: true,
    loaded: (h) => `Loaded 10 golden cases (dataset ${h}).`,
    assessing: (n) => `Assessing ${n} model(s) over 10 cases…`,
    verdict: (s, pass) => `${PF(pass)} microF1=${f3(s)} microR=${f3(s)} cov=1.000 fail=0`,
    workload: describeSearchExisting,
    normalisedPromptChars: normalisedSearchExistingPromptChars(),
    expectedWorkload: { tool: "search_existing_implementations", benchmark: "search-existing", callsPerModel: 10, maxOutputTokensPerCall: 8192 },
    expectedNormalisedPromptChars: 140963,
    run: async (o) => norm(await runSearchExistingBenchmark(o)),
  },
  {
    name: "security-triage",
    cacheFile: "security-triage-results.json",
    hash: () => sha12(readFileSync(resolveDatasetPath())),
    key: plainKey,
    score: triageScore,
    extra: () => ({}),
    caseCount: () => loadTriageCases().length,
    reportSlug: "security-triage",
    mdTitle: "# security_scan triage — model benchmark",
    benchLabel: "triage",
    backfills: true,
    loaded: (h) => `Loaded 33 golden cases (dataset ${h}).`,
    assessing: (n) => `Assessing ${n} model(s) over 33 cases…`,
    verdict: (s, pass) => `${PF(pass)} score=${f3(s)} scored=33/33 errored=0 under=0 over=0 critUF=0`,
    workload: describeSecurityTriage,
    normalisedPromptChars: null,
    expectedWorkload: { tool: "security_scan", benchmark: "security-triage", callsPerModel: 33, maxOutputTokensPerCall: 16000 },
    expectedNormalisedPromptChars: 103067,
    run: async (o) => norm(await runSecurityTriageBenchmark(o)),
  },
  {
    name: "check-specs",
    cacheFile: "check-specs-results.json",
    hash: checkSpecsFingerprint,
    key: plainKey,
    score: coverageScore,
    extra: (s) => ({ accuracy: s, failureReasons: [] }),
    caseCount: () => 13,
    reportSlug: "check-specs",
    mdTitle: "# check_against_specs (SPEC ADHERENCE) — model benchmark",
    benchLabel: "spec-adherence",
    backfills: true,
    loaded: (h) => `Loaded 1 real spec over 13 real source files (4 VIOLATION / 9 CLEAN) — corpus ${h}.`,
    assessing: (n) => `Assessing ${n} model(s) over 13 file decisions…`,
    verdict: (s, pass) =>
      `${PF(pass)} microF1=${f3(s)} microP=${f3(s)} microR=${f3(s)} acc=${f3(s)} cov=1.000 unscored=0`,
    workload: describeCheckSpecs,
    normalisedPromptChars: normalisedCheckSpecsPromptChars(),
    expectedWorkload: { tool: "check_against_specs", benchmark: "check-specs", callsPerModel: 13, maxOutputTokensPerCall: 4096 },
    expectedNormalisedPromptChars: 191299,
    run: async (o) => norm(await runCheckSpecsBenchmark(o)),
  },
  textSpec("summarize", SUMMARIZE_CASES, runSummarizeBenchmark, { tool: "summarize", benchmark: "text-summarize", callsPerModel: 12, maxOutputTokensPerCall: 4096 }, 11518),
  textSpec("topics", TOPICS_CASES, runTopicsBenchmark, { tool: "topics", benchmark: "text-topics", callsPerModel: 12, maxOutputTokensPerCall: 4096 }, 11984),
  textSpec("sem_deduplicate", SEM_DEDUP_CASES, runSemDedupBenchmark, { tool: "sem_deduplicate", benchmark: "text-sem-dedup", callsPerModel: 12, maxOutputTokensPerCall: 4096 }, 12206),
  textSpec("describe", DESCRIBE_CASES, runDescribeBenchmark, { tool: "describe", benchmark: "text-describe", callsPerModel: 12, maxOutputTokensPerCall: 4096 }, 14352),
];

/**
 * The report bytes, recorded once from the production code with the clock and the ledger fixed.
 * Hashes (sha256, first 16 hex) of the markdown and of the JSON report (datasetPath removed: it is
 * an absolute path of the machine). A wording, number-format or key-order change in a report moves
 * them. A corpus edit moves them too: re-record then.
 */
const GOLDEN: Record<string, { jsonKeys: string[]; assessmentKeys: string[]; mdSha: string; jsonSha: string }> = {
  "code-task": {
    jsonKeys: ["timestamp", "datasetHash", "caseCount", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected", "perCase"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "failures", "macroF1", "microPrecision", "microRecall", "microF1", "exactMatches", "hallucinations", "anchoredRate", "failedCases", "failureReasons", "costUsd"],
    mdSha: "9dd7fa370e076e9b",
    jsonSha: "684c41dbb8bc850a",
  },
  "scan-folder": {
    jsonKeys: ["timestamp", "datasetHash", "caseCount", "fileDecisions", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected", "perCase"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "failures", "microPrecision", "microRecall", "microF1", "macroF1", "coverage", "failureReasons", "costUsd"],
    mdSha: "10f8d55c93af8a65",
    jsonSha: "45ab42cb49a8da7f",
  },
  "search-existing": {
    jsonKeys: ["timestamp", "datasetHash", "caseCount", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected", "perCase"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "failures", "microPrecision", "microRecall", "microF1", "macroF1", "coverage", "failureReasons", "costUsd"],
    mdSha: "2f6f0176ca046f47",
    jsonSha: "a8db1ca543524e06",
  },
  "security-triage": {
    jsonKeys: ["timestamp", "datasetPath", "datasetHash", "caseCount", "thresholds", "incumbent", "freeOnly", "freeOnlySkipped", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected", "perCase"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "inconclusive", "score", "scoredCount", "erroredCount", "correctRate", "underFlagCount", "overFlagCount", "criticalUnderFlags", "failReasons"],
    mdSha: "2180f9726975c616",
    jsonSha: "d19ef9eda88e64f7",
  },
  "check-specs": {
    jsonKeys: ["timestamp", "datasetHash", "fixtureCount", "violationCount", "cleanCount", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected", "perCase"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "failures", "microPrecision", "microRecall", "microF1", "accuracy", "coverage", "failureReasons", "costUsd"],
    mdSha: "0e8b3f62ef11f68c",
    jsonSha: "1d7bb2eee7df0991",
  },
  "text-tools summarize": {
    jsonKeys: ["timestamp", "tool", "datasetHash", "caseCount", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "reason", "meanScore", "failedCases", "totalCases", "failureReasons", "costUsd"],
    mdSha: "22e9179cec7eb9a2",
    jsonSha: "d220d35735c6af94",
  },
  "text-tools topics": {
    jsonKeys: ["timestamp", "tool", "datasetHash", "caseCount", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "reason", "meanScore", "failedCases", "totalCases", "failureReasons", "costUsd"],
    mdSha: "9227fea5d23412fc",
    jsonSha: "e072ad76a5d590f5",
  },
  "text-tools sem_deduplicate": {
    jsonKeys: ["timestamp", "tool", "datasetHash", "caseCount", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "reason", "meanScore", "failedCases", "totalCases", "failureReasons", "costUsd"],
    mdSha: "d346ddc0d474792f",
    jsonSha: "c9c44036e19476d2",
  },
  "text-tools describe": {
    jsonKeys: ["timestamp", "tool", "datasetHash", "caseCount", "thresholds", "incumbent", "recommendedModelId", "changed", "reason", "costUsd", "assessments", "rejected"],
    assessmentKeys: ["modelId", "qualified", "inputDollarsPerMillion", "outputDollarsPerMillion", "latencyMs", "pass", "reason", "meanScore", "failedCases", "totalCases", "failureReasons", "costUsd"],
    mdSha: "4499baa13fbc680b",
    jsonSha: "86e9e6ddab0f1c7c",
  },
};

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ── The scenario ────────────────────────────────────────────────────────────

describe.each(SPECS)("workload orchestrator: $name", (spec) => {
  let cfg = "";
  let out = "";
  let prevKey: string | undefined;
  let prevCfgDir: string | undefined;
  let modelCalls = 0;
  let progress: string[] = [];

  // A model call means a ledger miss. Every scenario that expects a hit asserts modelCalls===0.
  const fetchImpl = (async () => {
    modelCalls++;
    throw new Error("characterization: no model call expected");
  }) as unknown as FetchImpl;

  const rowKey = (model: string, date: string = DAY): string => spec.key(model, date, spec.hash());

  const seed = (rows: Record<string, number>): void => {
    const ledger: Record<string, unknown> = {};
    for (const [model, s] of Object.entries(rows)) {
      const [inp, outp] = PRICE[model] as [number, number];
      ledger[rowKey(model)] = {
        date: DAY,
        datasetHash: spec.hash(),
        score: spec.score(s, model),
        costUsd: 0.5,
        latencyMs: 100,
        inputDollarsPerMillion: inp,
        outputDollarsPerMillion: outp,
        qualified: true,
        ...spec.extra(s),
      };
    }
    writeFileSync(join(cfg, spec.cacheFile), JSON.stringify(ledger));
  };

  const ledger = (): Record<string, Record<string, unknown>> =>
    JSON.parse(readFileSync(join(cfg, spec.cacheFile), "utf-8")) as Record<string, Record<string, unknown>>;

  const run = (models: string[], extra: Partial<RunOpts> = {}): Promise<Normalised> =>
    spec.run({
      models,
      incumbentModelId: INCUMBENT,
      outputDir: out,
      onProgress: (m) => progress.push(m),
      fetchImpl,
      ...extra,
    });

  const strongSeed = { [INCUMBENT]: 0.9, [CHEAP_PASS]: 0.95, [CHEAP_FAIL]: 0.1, [PRICEY]: 0.99 };

  beforeEach(() => {
    // "/tmp" (not os.tmpdir()): getConfigDir refuses a dir outside $HOME or /tmp, and macOS's
    // tmpdir() resolves to /var/folders/…
    cfg = mkdtempSync(join("/tmp", "wk01-cfg-"));
    out = mkdtempSync(join("/tmp", "wk01-out-"));
    prevKey = process.env.OPENROUTER_API_KEY;
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    modelCalls = 0;
    progress = [];
    setAllowPaidModels(true); // the master switch: paid benchmarks need it, and the ledger is pre-seeded so nothing is spent
    setPaidBenchmarksAllowed(true);
    setActiveFreeOnly(false);
    // Only Date is faked: it fixes the ledger day and the report stamp. Timers and promises stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${DAY}T05:06:07Z`));
    vi.stubGlobal("fetch", async (url: string) => {
      if (!String(url).startsWith("https://openrouter.ai/api/v1/models")) {
        throw new Error(`characterization: unexpected network call to ${String(url)}`);
      }
      return { ok: true, status: 200, json: async () => ({ data: CATALOG }) };
    });
  });

  afterEach(() => {
    setActiveFreeOnly(false);
    setAllowPaidModels(false);
    setPaidBenchmarksAllowed(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("ledger hit: recommends the cheaper passer, rejects the failing and the pricier model, makes no model call", async () => {
    seed(strongSeed);
    const hash = spec.hash();
    const r = await run([CHEAP_PASS, CHEAP_FAIL, PRICEY]);

    expect(r.recommendedModelId).toBe(CHEAP_PASS);
    expect(r.changed).toBe(true);
    expect(r.summaryLine).toBe(`RECOMMEND switch: ${INCUMBENT} -> ${CHEAP_PASS} (best same-or-cheaper passer).`);
    expect(r.costUsd).toBe(2); // four ledger rows at 0.5 each: the ledger cost is summed, nothing is re-charged
    // Named models first, in the order given, then the auto-added incumbent last.
    expect(r.assessedIds).toEqual([CHEAP_PASS, CHEAP_FAIL, PRICEY, INCUMBENT]);
    expect(r.selection.reason).toBe(
      `${CHEAP_PASS} passed the ${spec.benchLabel} benchmark (score 0.950) at no higher cost than the incumbent and scored best among eligible passers.`,
    );
    expect(r.selection.rejected).toHaveLength(2);
    expect(r.selection.rejected[0]?.modelId).toBe(CHEAP_FAIL);
    expect(r.selection.rejected[0]?.reason.startsWith(`failed the ${spec.benchLabel} benchmark: `)).toBe(true);
    expect(r.selection.rejected[1]).toEqual({
      modelId: PRICEY,
      reason:
        "pricier than the incumbent default (in $0.200/out $0.400 vs incumbent in $0.100/out $0.200) — never auto-bump to a pricier model",
    });
    expect(modelCalls).toBe(0);

    const expected = [
      spec.loaded(hash),
      "Fetching OpenRouter model catalog…",
      spec.assessing(4),
      ...(spec.backfills ? ["Backfilled qualityPass on 4 legacy ledger row(s)."] : []),
    ];
    for (const [m, sc] of [[CHEAP_PASS, 0.95], [CHEAP_FAIL, 0.1], [PRICEY, 0.99], [INCUMBENT, 0.9]] as const) {
      expected.push(`  ${m}: cache hit (${DAY}).`, `    ${m}: ${spec.verdict(sc, sc >= 0.5)}`);
    }
    expect(progress).toEqual(expected);
  });

  it("reports: file names, JSON keys, JSON values and the bytes of both files", async () => {
    seed(strongSeed);
    const r = await run([CHEAP_PASS, CHEAP_FAIL, PRICEY]);
    const golden = GOLDEN[spec.name] as (typeof GOLDEN)[string];

    const files = readdirSync(out).sort();
    expect(files).toHaveLength(2);
    const stampRe = "\\d{8}_\\d{6}[+-]\\d{4}";
    expect(files[0]).toMatch(new RegExp(`^${stampRe}-${spec.reportSlug}-benchmark\\.json$`));
    expect(files[1]).toMatch(new RegExp(`^${stampRe}-${spec.reportSlug}-benchmark\\.md$`));
    expect(r.jsonReportPath).toBe(join(out, files[0] as string));
    expect(r.mdReportPath).toBe(join(out, files[1] as string));

    const json = JSON.parse(readFileSync(r.jsonReportPath, "utf-8")) as Record<string, unknown>;
    expect(json.datasetHash).toBe(spec.hash());
    expect(json.timestamp).toBe(`${DAY}T05:06:07.000Z`);
    expect(json.recommendedModelId).toBe(CHEAP_PASS);
    expect(json.changed).toBe(true);
    expect(json.costUsd).toBe(2);
    expect(json.reason).toBe(r.selection.reason);
    expect(json.incumbent).toEqual({ modelId: INCUMBENT, inputDollarsPerMillion: 0.1, outputDollarsPerMillion: 0.2 });
    const assessments = json.assessments as { modelId: string; pass: boolean }[];
    expect(assessments.map((a) => [a.modelId, a.pass])).toEqual([
      [CHEAP_PASS, true],
      [CHEAP_FAIL, false],
      [PRICEY, true],
      [INCUMBENT, true],
    ]);
    expect(json.rejected).toEqual(r.selection.rejected);
    if (json.caseCount !== undefined) expect(json.caseCount).toBe(spec.caseCount());

    // security-triage also records which dataset file it read; the rest of the workloads fingerprint a corpus.
    if (json.datasetPath !== undefined) expect(json.datasetPath).toBe(resolveDatasetPath());
    expect(Object.keys(json)).toEqual(golden.jsonKeys);
    expect(Object.keys(assessments[0] as object)).toEqual(golden.assessmentKeys);

    const md = readFileSync(r.mdReportPath, "utf-8");
    expect(md.split("\n")[0]).toBe(spec.mdTitle);
    expect(md).toContain(`**SWITCH → \`${CHEAP_PASS}\`**`);
    delete json.datasetPath; // an absolute path of this machine
    expect(sha16(md)).toBe(golden.mdSha);
    expect(sha16(JSON.stringify(json, null, 2))).toBe(golden.jsonSha);
  });

  it("ledger: every row keeps its key and cost, and gains the golden-dataset verdict (qualityPass)", async () => {
    seed(strongSeed);
    await run([CHEAP_PASS, CHEAP_FAIL, PRICEY]);
    const after = ledger();
    expect(Object.keys(after).sort()).toEqual([INCUMBENT, CHEAP_PASS, CHEAP_FAIL, PRICEY].map((m) => rowKey(m)).sort());
    for (const m of [INCUMBENT, CHEAP_PASS, PRICEY]) expect(after[rowKey(m)]?.qualityPass).toBe(true);
    expect(after[rowKey(CHEAP_FAIL)]?.qualityPass).toBe(false);
    for (const row of Object.values(after)) {
      expect(row.costUsd).toBe(0.5);
      expect(row.date).toBe(DAY);
      expect(row.datasetHash).toBe(spec.hash());
    }
  });

  it("keeps the incumbent when no assessed model beats it", async () => {
    seed({ [INCUMBENT]: 0.9, [CHEAP_FAIL]: 0.1 });
    const r = await run([CHEAP_FAIL]);
    expect(r.recommendedModelId).toBe(INCUMBENT);
    expect(r.changed).toBe(false);
    expect(r.summaryLine).toBe(`KEEP ${INCUMBENT} (no eligible same-or-cheaper model scored higher).`);
    expect(r.assessedIds).toEqual([CHEAP_FAIL, INCUMBENT]);
    expect(r.selection.rejected.map((x) => x.modelId)).toEqual([CHEAP_FAIL]);
    expect(modelCalls).toBe(0);
    expect(readFileSync(r.mdReportPath, "utf-8")).toContain(`**KEEP → \`${INCUMBENT}\`**`);
  });

  it("paid benchmarks off: the auto-added paid incumbent is not assessed; a user-named paid model is refused before any call", async () => {
    seed({ [FREE]: 0.9 });
    setAllowPaidModels(false);
    const r = await run([FREE]);
    expect(r.assessedIds).toEqual([FREE]);
    expect(r.summaryLine).toBe(`KEEP ${INCUMBENT} (no eligible same-or-cheaper model scored higher).`);
    expect(r.costUsd).toBe(0.5);
    expect(progress).toContain(`  ${INCUMBENT}: incumbent not assessed — it is paid and paid benchmarks are off ($0 spent).`);

    progress = [];
    const outBefore = readdirSync(out).length;
    await expect(run([CHEAP_PASS])).rejects.toThrow(/paid benchmarks are off: allow_paid_models is false/);
    expect(readdirSync(out)).toHaveLength(outBefore); // refused before a report is written
    expect(modelCalls).toBe(0);
  });

  it("free_only: a non-':free' model is skipped with a $0 row and never sent", async () => {
    seed({ [FREE]: 0.9, [INCUMBENT]: 0.9 });
    setActiveFreeOnly(true);
    const r = await run([CHEAP_PASS, FREE]);
    expect(r.assessedIds).toEqual([CHEAP_PASS, FREE, INCUMBENT]);
    expect(r.recommendedModelId).toBe(INCUMBENT);
    expect(r.changed).toBe(false);
    expect(r.costUsd).toBe(0.5); // only the ':free' row costs anything
    expect(modelCalls).toBe(0);
    expect(progress).toContain(`  ${FREE}: cache hit (${DAY}).`);
    expect(progress.filter((l) => l.startsWith(`  ${CHEAP_PASS}: skipped (free_only`))).toHaveLength(1);
    expect(progress.filter((l) => l.startsWith(`  ${INCUMBENT}: skipped (free_only`))).toHaveLength(1);
    const rejected = Object.fromEntries(r.selection.rejected.map((x) => [x.modelId, x.reason]));
    expect(rejected[CHEAP_PASS]).toContain("free_only active — non-':free' model not benchmarked");
    expect(rejected[INCUMBENT]).toContain("free_only active — non-':free' model not benchmarked");
  });

  it("force: ignores the ledger row, calls the model, overwrites the row", async () => {
    seed({ [CHEAP_PASS]: 0.95 });
    // The named model is also the incumbent, so exactly one model is run.
    await run([CHEAP_PASS], { force: true, incumbentModelId: CHEAP_PASS });
    expect(progress).toContain(`  ${CHEAP_PASS}: running…`);
    expect(progress.some((l) => l.includes("cache hit"))).toBe(false);
    // One dataset pass: the describeWorkload() call count is the real call count of one model.
    expect(modelCalls).toBe(spec.expectedWorkload.callsPerModel);
    const after = ledger();
    expect(Object.keys(after)).toEqual([rowKey(CHEAP_PASS)]);
    expect(after[rowKey(CHEAP_PASS)]?.costUsd).toBe(0); // the seeded 0.5 is gone: the row was rewritten from the run
  }, 120_000);

  it("describeWorkload: the pre-flight estimate is pinned exactly", () => {
    // The workload's own count, over the REAL prompt text (absolute paths
    // included). For the four file-sending workloads this number depends on
    // WHERE the repo is cloned — the prompt embeds each file's absolute path,
    // so the count moves with the checkout root's length. It is therefore NOT
    // pinned here; what IS pinned is the path-independent count below.
    const measured = spec.workload();

    if (spec.normalisedPromptChars) {
      // ANTI-DRIFT: the parallel measurement must agree with the real
      // workload on the ABSOLUTE count. If a workload's assembly ever changes
      // (a different helper, a different order, a changed prompt), the two
      // diverge and this fails — so the normalised pin can never be satisfied
      // by a helper that no longer mirrors the real thing.
      expect(spec.normalisedPromptChars.absolute).toBe(measured.promptCharsPerModel);

      // The pin itself: the path-independent prompt size, held EXACTLY.
      // Derived from the ORIGINAL absolute pin (written at a 69-character
      // checkout root) by the law
      //   absolute = normalised + N × (len(fixture_root) − len(placeholder))
      // — N being the number of times the fixture root appears in the counted
      // text (8, 36, 90, 26), the placeholder 14 characters, and the length
      // that of the FIXTURE root (`<checkout-root>/…/benchmark-fixtures/<name>`),
      // NOT the checkout root. Never from one machine's numbers: the four
      // original pins reproduce exactly at a 69-character checkout root, and
      // the normalised count was confirmed identical at two DIFFERENT root
      // lengths.
      expect(spec.normalisedPromptChars.normalised).toBe(spec.expectedNormalisedPromptChars);
    } else {
      // A workload whose prompt carries no file path: its count is already
      // path-independent, so the canonical count IS the real count.
      expect(measured.promptCharsPerModel).toBe(spec.expectedNormalisedPromptChars);
    }

    // Every other field of the workload is still pinned exactly, and none of
    // them depends on the checkout path.
    expect(measured).toEqual({
      ...spec.expectedWorkload,
      promptCharsPerModel: measured.promptCharsPerModel,
    });
  });
});
