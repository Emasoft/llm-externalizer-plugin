/**
 * scan_folder (MASS SEARCH) model benchmark — orchestrator (P2c).
 *
 * The single callable behind the CLI phase and the --auto-replace planner. It
 * mirrors the code-task and search-existing orchestrators step for step:
 *   1. load + validate the golden corpus (deterministic — no LLM judge),
 *   2. build the candidate pool — explicit `models`, else auto-discovered
 *      candidates filtered by scan_folder's per-tool requirements
 *      (TOOL_MODEL_REGISTRY.scan_folder.requirements) AND not pricier than the
 *      incumbent (the cost gate would reject pricier ones — don't spend budget),
 *   3. score each candidate via the REAL pipeline runner (bench-runner.ts →
 *      runScanFolder in-process), with a per-model-per-day cache,
 *   4. apply the selection gate (select.ts → selectScanFolderModel),
 *   5. render markdown + JSON reports and return the recommendation + paths.
 *
 * ADVISORY only — this module NEVER writes config. The recommendation is surfaced
 * for the operator to adopt via `tool_models.scan_folder` on a settings.yaml
 * profile; the only writer is the CLI (benchmark/pick.ts's
 * applyToolModelToSettings), behind the read-only-MCP guardrail.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBenchmarkRoster,
  rankByQualityIndex,
  fetchProgrammingModels,
  qualify,
  type OpenRouterModel,
  type QualifiedModel,
} from "../discover.js";
import { getConfigDir, getActiveFreeOnly } from "../../config.js";
import { resolveProjectMainRoot } from "../../project-root.js";
import { KNOWN_PRICING, type ModelPricing } from "../../mass_scouting/cost-estimate.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import { DEFAULT_MODEL } from "../../security_scan/types.js";
// The confusion-matrix aggregate is the shared one (see score.ts's header) — a
// skipped model still needs a well-formed, empty score object.
import { aggregateScores } from "../search-existing/score.js";

import {
  SCAN_FOLDER_CASES,
  datasetFingerprint,
  deriveMatchingFiles,
  scannedFilesFor,
  validateDataset,
  type ScanFolderCase,
} from "./dataset.js";
import { runScanFolderBenchmarkOnModel } from "./bench-runner.js";
import {
  passesThresholds,
  DEFAULT_SCAN_FOLDER_THRESHOLDS,
  type ScanFolderScore,
  type ScanFolderThresholds,
} from "./score.js";
import {
  SCAN_FOLDER_CRITERIA,
  selectScanFolderModel,
  type ScanFolderCandidate,
  type ScanFolderSelectionResult,
} from "./select.js";

/**
 * scan_folder has no per-tool default model of its own — it runs on the active
 * profile's ensemble. So the benchmark's incumbent defaults to DEFAULT_MODEL (the
 * shared baseline the other three benchmarks also use) unless the caller passes
 * `incumbentModelId`. The cost gate anchors on that incumbent's pricing.
 */
const INCUMBENT_FALLBACK_PRICING: ModelPricing =
  KNOWN_PRICING[DEFAULT_MODEL] ?? { input_per_m_usd: 0.04, output_per_m_usd: 0.1, context_window: 32_768 };

export interface ScanFolderBenchmarkOptions {
  apiKey?: string;
  /** Explicit model ids to assess. When absent, auto-discover the candidate pool. */
  models?: string[];
  /** Report dir. Default `<main-repo-root>/reports/scan-folder-benchmark/`. */
  outputDir?: string;
  mainRoot?: string;
  /** Ignore the per-model-per-day cache and re-run every model. */
  force?: boolean;
  thresholds?: ScanFolderThresholds;
  /** The incumbent to compare against. Default DEFAULT_MODEL. */
  incumbentModelId?: string;
  /** Cap the auto-discovered pool (quality-ranked). Default 16. */
  qualifyingTopN?: number;
  /** Per-call timeout in ms forwarded to the runner. Default 300_000. */
  perCallTimeoutMs?: number;
  /** Test seam — injected HTTP impl forwarded to the runner. */
  fetchImpl?: FetchImpl;
  onProgress?: (message: string) => void;
}

export interface ScanFolderAssessment extends ScanFolderCandidate {
  /** Files whose per-file call produced no report (scored as unscored). */
  failureReasons: string[];
  costUsd: number;
}

export interface ScanFolderBenchmarkResult {
  recommendedModelId: string;
  changed: boolean;
  selection: ScanFolderSelectionResult;
  results: ScanFolderAssessment[];
  costUsd: number;
  reportPath: string;
  jsonReportPath: string;
  summaryLine: string;
}

// ── Cache (per-model-per-day, corpus-fingerprint-keyed) ─────────────────────

interface CacheEntry {
  date: string;
  datasetHash: string;
  score: ScanFolderScore;
  costUsd: number;
  latencyMs: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  qualified: boolean;
  disqualifyReason?: string;
  failureReasons: string[];
}
type CacheFile = Record<string, CacheEntry>;

function cachePath(): string {
  return join(getConfigDir(), "scan-folder-results.json");
}

function cacheKey(modelId: string, date: string, datasetHash: string): string {
  return `${modelId}::${date}::${datasetHash}`;
}

function loadCache(): CacheFile {
  const p = cachePath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as CacheFile;
  } catch {
    // Corrupt cache is non-fatal — treat as empty and overwrite on save.
  }
  return {};
}

function saveCache(cache: CacheFile): void {
  mkdirSync(getConfigDir(), { recursive: true });
  const p = cachePath();
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  renameSync(tmp, p);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveApiKey(override?: string): string {
  const k =
    override ||
    process.env.OPENROUTER_API_KEY ||
    process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
  if (!k) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Export it in your shell, or set the plugin option 'openrouter_api_key' via Claude Code's /plugin configure.",
    );
  }
  return k;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** local-time + GMT-offset compact stamp (agent-reports-location convention). */
function reportStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${oh}${om}`;
}

function pricingFromModel(m: QualifiedModel): ModelPricing {
  return {
    input_per_m_usd: m.inputDollarsPerMillion,
    output_per_m_usd: m.outputDollarsPerMillion,
    context_window: m.contextTokens,
  };
}

/** Best-effort decorate a raw OpenRouter model with numeric pricing fields. */
function decorate(raw: OpenRouterModel): QualifiedModel {
  const ctx = raw.context_length ?? 0;
  const maxOutRaw = raw.top_provider?.max_completion_tokens;
  const maxOut = maxOutRaw === null ? ctx : (maxOutRaw ?? 0);
  const promptPerToken = parseFloat(raw.pricing?.prompt ?? "NaN");
  const completionPerToken = parseFloat(raw.pricing?.completion ?? "NaN");
  const params = new Set(raw.supported_parameters ?? []);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    contextTokens: ctx,
    maxOutputTokens: maxOut,
    inputDollarsPerMillion: isFinite(promptPerToken) ? promptPerToken * 1_000_000 : Infinity,
    outputDollarsPerMillion: isFinite(completionPerToken) ? completionPerToken * 1_000_000 : Infinity,
    supportsStructured: params.has("structured_outputs") || params.has("response_format"),
    supportsReasoning: params.has("reasoning") || params.has("include_reasoning"),
    raw,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function runScanFolderBenchmark(
  opts: ScanFolderBenchmarkOptions = {},
): Promise<ScanFolderBenchmarkResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const cases: readonly ScanFolderCase[] = SCAN_FOLDER_CASES;
  // Fail BEFORE spending a cent if the corpus and the ground truth have drifted (a
  // missing fixture, a truth regex that no longer agrees with the checked-in
  // answer, a query with nothing left to find).
  validateDataset(cases);

  // Fingerprint the questions AND the corpus bytes, so editing a fixture — not just
  // the dataset — invalidates yesterday's cached scores.
  const datasetHash = datasetFingerprint();
  const thresholds = opts.thresholds ?? DEFAULT_SCAN_FOLDER_THRESHOLDS;
  const incumbentId = opts.incumbentModelId ?? DEFAULT_MODEL;
  const progress = opts.onProgress ?? ((): void => {});
  const freeOnly = getActiveFreeOnly();

  const fileDecisions = cases.reduce((n, c) => n + scannedFilesFor(c).length, 0);
  progress(
    `Loaded ${cases.length} queries over ${fileDecisions / cases.length} real files ` +
      `= ${fileDecisions} per-file decisions (corpus ${datasetHash}).`,
  );

  progress("Fetching OpenRouter model catalog…");
  const catalog = await fetchProgrammingModels();
  const byId = new Map(catalog.map((m) => [m.id, m] as const));

  const incumbentRaw = byId.get(incumbentId);
  const incumbentDecorated = incumbentRaw ? decorate(incumbentRaw) : null;
  const incumbentIn =
    incumbentDecorated && isFinite(incumbentDecorated.inputDollarsPerMillion)
      ? incumbentDecorated.inputDollarsPerMillion
      : INCUMBENT_FALLBACK_PRICING.input_per_m_usd;
  const incumbentOut =
    incumbentDecorated && isFinite(incumbentDecorated.outputDollarsPerMillion)
      ? incumbentDecorated.outputDollarsPerMillion
      : INCUMBENT_FALLBACK_PRICING.output_per_m_usd;

  const toAssess = new Map<
    string,
    { model: QualifiedModel; qualified: boolean; disqualifyReason?: string }
  >();
  const addModel = (model: QualifiedModel, qualified: boolean, disqualifyReason?: string): void => {
    if (!toAssess.has(model.id)) toAssess.set(model.id, { model, qualified, disqualifyReason });
  };

  if (opts.models && opts.models.length > 0) {
    for (const id of opts.models) {
      const raw = byId.get(id);
      if (raw) {
        const q = qualify(raw, SCAN_FOLDER_CRITERIA);
        addModel(
          q ?? decorate(raw),
          q !== null,
          q ? undefined : "below scan-folder requirements (cost/context/structured-output)",
        );
      } else {
        // Unknown to the catalog — assess with fallback pricing so the user still
        // sees a score, but it cannot qualify (no capability data).
        const fp = KNOWN_PRICING[id] ?? INCUMBENT_FALLBACK_PRICING;
        addModel(
          {
            id,
            name: id,
            contextTokens: fp.context_window,
            maxOutputTokens: fp.context_window,
            inputDollarsPerMillion: fp.input_per_m_usd,
            outputDollarsPerMillion: fp.output_per_m_usd,
            supportsStructured: false,
            supportsReasoning: false,
            raw: { id },
          },
          false,
          "not found in the OpenRouter catalog",
        );
      }
    }
  } else {
    const { candidates } = buildBenchmarkRoster(catalog, SCAN_FOLDER_CRITERIA, []);
    const affordable = candidates.filter(
      (c) =>
        c.inputDollarsPerMillion <= incumbentIn + 1e-9 &&
        c.outputDollarsPerMillion <= incumbentOut + 1e-9,
    );
    const sameOrCheaper = rankByQualityIndex(affordable).slice(0, opts.qualifyingTopN ?? 16);
    for (const c of sameOrCheaper) addModel(c, true);
  }

  // ALWAYS assess the incumbent, so the report confirms it still passes and the
  // gate has a fallback.
  if (!toAssess.has(incumbentId)) {
    if (incumbentDecorated) {
      const q = qualify(incumbentDecorated.raw, SCAN_FOLDER_CRITERIA);
      addModel(incumbentDecorated, q !== null, q ? undefined : "below scan-folder requirements");
    } else {
      addModel(
        {
          id: incumbentId,
          name: incumbentId,
          contextTokens: INCUMBENT_FALLBACK_PRICING.context_window,
          maxOutputTokens: INCUMBENT_FALLBACK_PRICING.context_window,
          inputDollarsPerMillion: incumbentIn,
          outputDollarsPerMillion: incumbentOut,
          supportsStructured: true,
          supportsReasoning: true,
          raw: { id: incumbentId },
        },
        true,
      );
    }
  }

  progress(`Assessing ${toAssess.size} model(s) over ${fileDecisions} file decisions…`);

  const cache = loadCache();
  const assessments: ScanFolderAssessment[] = [];
  let totalCost = 0;

  for (const { model, qualified, disqualifyReason } of toAssess.values()) {
    // free_only cost-safety: a non-':free' model cannot become the free-mode
    // default, so don't spend a cent running it.
    if (freeOnly && !model.id.endsWith(":free")) {
      progress(`  ${model.id}: skipped (free_only — non-':free' model).`);
      assessments.push({
        modelId: model.id,
        qualified: false,
        disqualifyReason: "free_only active — non-':free' model not benchmarked",
        inputDollarsPerMillion: model.inputDollarsPerMillion,
        outputDollarsPerMillion: model.outputDollarsPerMillion,
        latencyMs: 0,
        score: aggregateScores([]),
        failureReasons: [],
        costUsd: 0,
      });
      continue;
    }

    const key = cacheKey(model.id, today(), datasetHash);
    const cached = cache[key];
    let score: ScanFolderScore;
    let costUsd: number;
    let latencyMs: number;
    let failureReasons: string[];

    if (cached && !opts.force) {
      progress(`  ${model.id}: cache hit (${today()}).`);
      score = cached.score;
      costUsd = cached.costUsd;
      latencyMs = cached.latencyMs;
      failureReasons = cached.failureReasons;
    } else {
      progress(`  ${model.id}: running…`);
      const run = await runScanFolderBenchmarkOnModel(
        model.id,
        cases,
        {
          apiKey,
          pricing: pricingFromModel(model),
          perCallTimeoutMs: opts.perCallTimeoutMs ?? 300_000,
        },
        opts.fetchImpl,
      );
      score = run.aggregate;
      costUsd = run.costUsd;
      latencyMs = Math.round(run.meanLatencyMs);
      failureReasons = run.failures.map((f) => `${f.caseId} / ${f.file}: ${f.reason}`);
      cache[key] = {
        date: today(),
        datasetHash,
        score,
        costUsd,
        latencyMs,
        inputDollarsPerMillion: model.inputDollarsPerMillion,
        outputDollarsPerMillion: model.outputDollarsPerMillion,
        qualified,
        disqualifyReason,
        failureReasons,
      };
    }

    totalCost += costUsd;
    assessments.push({
      modelId: model.id,
      qualified,
      disqualifyReason,
      inputDollarsPerMillion: model.inputDollarsPerMillion,
      outputDollarsPerMillion: model.outputDollarsPerMillion,
      latencyMs,
      score,
      failureReasons,
      costUsd,
    });
    const thr = passesThresholds(score, thresholds);
    progress(
      `    ${model.id}: ${thr.pass ? "PASS" : "FAIL"} ` +
        `microF1=${score.microF1.toFixed(3)} microP=${score.microPrecision.toFixed(3)} ` +
        `microR=${score.microRecall.toFixed(3)} cov=${score.coverage.toFixed(3)} ` +
        `unscored=${failureReasons.length}`,
    );
  }

  saveCache(cache);

  const selection = selectScanFolderModel({
    candidates: assessments,
    incumbentModelId: incumbentId,
    incumbentInputDollarsPerMillion: incumbentIn,
    incumbentOutputDollarsPerMillion: incumbentOut,
  });

  const mainRoot = resolveProjectMainRoot(opts.mainRoot);
  const reportDir = opts.outputDir ?? join(mainRoot, "reports", "scan-folder-benchmark");
  mkdirSync(reportDir, { recursive: true });
  const stamp = reportStamp();
  const jsonReportPath = join(reportDir, `${stamp}-scan-folder-benchmark.json`);
  const reportPath = join(reportDir, `${stamp}-scan-folder-benchmark.md`);

  const jsonPayload = {
    timestamp: new Date().toISOString(),
    datasetHash,
    caseCount: cases.length,
    fileDecisions,
    thresholds,
    incumbent: {
      modelId: incumbentId,
      inputDollarsPerMillion: incumbentIn,
      outputDollarsPerMillion: incumbentOut,
    },
    recommendedModelId: selection.recommendedModelId,
    changed: selection.changed,
    reason: selection.reason,
    costUsd: totalCost,
    assessments: assessments.map((a) => {
      const thr = passesThresholds(a.score, thresholds);
      return {
        modelId: a.modelId,
        qualified: a.qualified,
        disqualifyReason: a.disqualifyReason,
        inputDollarsPerMillion: a.inputDollarsPerMillion,
        outputDollarsPerMillion: a.outputDollarsPerMillion,
        latencyMs: a.latencyMs,
        pass: thr.pass,
        failures: thr.failures,
        microPrecision: a.score.microPrecision,
        microRecall: a.score.microRecall,
        microF1: a.score.microF1,
        macroF1: a.score.macroF1,
        coverage: a.score.coverage,
        failureReasons: a.failureReasons,
        costUsd: a.costUsd,
      };
    }),
    rejected: selection.rejected,
    perCase: Object.fromEntries(assessments.map((a) => [a.modelId, a.score.cases])),
  };
  const jtmp = `${jsonReportPath}.tmp.${process.pid}`;
  writeFileSync(jtmp, JSON.stringify(jsonPayload, null, 2), "utf-8");
  renameSync(jtmp, jsonReportPath);

  const md = buildReportMarkdown({
    cases,
    datasetHash,
    fileDecisions,
    incumbentId,
    incumbentIn,
    incumbentOut,
    thresholds,
    assessments,
    selection,
    totalCost,
  });
  const mtmp = `${reportPath}.tmp.${process.pid}`;
  writeFileSync(mtmp, md, "utf-8");
  renameSync(mtmp, reportPath);

  const summaryLine = selection.changed
    ? `RECOMMEND switch: ${incumbentId} -> ${selection.recommendedModelId} (best same-or-cheaper passer).`
    : `KEEP ${selection.recommendedModelId} (no eligible same-or-cheaper model scored higher).`;

  return {
    recommendedModelId: selection.recommendedModelId,
    changed: selection.changed,
    selection,
    results: assessments,
    costUsd: totalCost,
    reportPath,
    jsonReportPath,
    summaryLine,
  };
}

// ── Markdown report ─────────────────────────────────────────────────────────

function buildReportMarkdown(args: {
  cases: readonly ScanFolderCase[];
  datasetHash: string;
  fileDecisions: number;
  incumbentId: string;
  incumbentIn: number;
  incumbentOut: number;
  thresholds: ScanFolderThresholds;
  assessments: readonly ScanFolderAssessment[];
  selection: ScanFolderSelectionResult;
  totalCost: number;
}): string {
  const lines: string[] = [];
  lines.push("# scan_folder (MASS SEARCH) — model benchmark");
  lines.push("");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(
    `**Corpus:** ${args.cases.length} queries × ${args.fileDecisions / args.cases.length} real source files ` +
      `= ${args.fileDecisions} per-file decisions — corpus ${args.datasetHash}`,
  );
  lines.push(`**Incumbent:** \`${args.incumbentId}\` (in $${args.incumbentIn.toFixed(3)}/M, out $${args.incumbentOut.toFixed(3)}/M)`);
  lines.push(
    `**Pass gate:** micro-F1 ≥ ${args.thresholds.minMicroF1.toFixed(2)} AND ` +
      `micro-recall ≥ ${args.thresholds.minMicroRecall.toFixed(2)} AND ` +
      `coverage ≥ ${args.thresholds.minCoverage.toFixed(2)}`,
  );
  lines.push(`**Total LLM spend:** $${args.totalCost.toFixed(6)}`);
  lines.push("");
  lines.push(
    "**Scoring is 100% deterministic — no LLM judge.** The corpus is twelve files copied " +
      "VERBATIM from this repo's own `mcp-server/src/`, and each query's true MATCH set is " +
      "DERIVED from those bytes by a mechanical rule at run time (not hand-listed), so the " +
      "expected answer cannot drift from the corpus. The score is precision/recall/F1 over " +
      "the per-file MATCH/NO_MATCH verdicts. A MATCH line's cited evidence is reported but " +
      "NOT graded: judging whether a citation really proves the claim is a semantic " +
      "judgment, which would need the judge this benchmark refuses to use.",
  );
  lines.push("");
  lines.push("## Queries");
  lines.push("");
  lines.push("| Query | Matches | Non-matches | Why the truth is unambiguous |");
  lines.push("|---|---|---|---|");
  for (const c of args.cases) {
    const scanned = scannedFilesFor(c).length;
    const matches = deriveMatchingFiles(c).length;
    lines.push(`| ${c.id} | ${matches} | ${scanned - matches} | ${c.rationale} |`);
  }
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`**${args.selection.changed ? "SWITCH" : "KEEP"} → \`${args.selection.recommendedModelId}\`**`);
  lines.push("");
  lines.push(args.selection.reason);
  lines.push("");
  lines.push("## Assessed models");
  lines.push("");
  lines.push("| Model | Req | Bench | micro-F1 | micro-P | micro-R | macro-F1 | Coverage | Unscored | in $/M | out $/M | lat ms |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const sorted = [...args.assessments].sort((a, b) => b.score.microF1 - a.score.microF1);
  for (const a of sorted) {
    const thr = passesThresholds(a.score, args.thresholds);
    lines.push(
      `| \`${a.modelId}\` | ${a.qualified ? "ok" : "no"} | ${thr.pass ? "PASS" : "FAIL"} | ` +
        `${a.score.microF1.toFixed(3)} | ${a.score.microPrecision.toFixed(3)} | ${a.score.microRecall.toFixed(3)} | ` +
        `${a.score.macroF1.toFixed(3)} | ${(a.score.coverage * 100).toFixed(0)}% | ${a.failureReasons.length} | ` +
        `${a.inputDollarsPerMillion.toFixed(3)} | ${a.outputDollarsPerMillion.toFixed(3)} | ${a.latencyMs} |`,
    );
  }
  lines.push("");
  if (args.selection.rejected.length > 0) {
    lines.push("## Rejected (and why)");
    lines.push("");
    for (const r of args.selection.rejected) lines.push(`- \`${r.modelId}\` — ${r.reason}`);
    lines.push("");
  }

  const rec = args.assessments.find((a) => a.modelId === args.selection.recommendedModelId);
  if (rec) {
    lines.push(`## Per-query breakdown — \`${rec.modelId}\``);
    lines.push("");
    lines.push("| Query | Files | TP | FP | FN | TN | Unscored | Precision | Recall | F1 |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const c of rec.score.cases) {
      lines.push(
        `| ${c.caseId} | ${c.scannedFiles} | ${c.truePositives} | ${c.falsePositives} | ` +
          `${c.falseNegatives} | ${c.trueNegatives} | ${c.unscored} | ` +
          `${c.precision.toFixed(3)} | ${c.recall.toFixed(3)} | ${c.f1.toFixed(3)} |`,
      );
    }
    lines.push("");
    if (rec.failureReasons.length > 0) {
      lines.push(`### Files with no parseable verdict — \`${rec.modelId}\``);
      lines.push("");
      for (const f of rec.failureReasons) lines.push(`- ${f}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "Re-run: `llm-externalizer benchmark --scan-folder` (auto-discover) or `--scan-folder <id> [<id>...]` " +
      "(assess specific models). ADVISORY by default; add `--apply-profile <P>` to write the winner into " +
      "that profile's `tool_models.scan_folder` (CLI-only writer — the MCP surface never writes).",
  );
  return lines.join("\n") + "\n";
}
