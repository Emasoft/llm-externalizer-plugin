/**
 * code_task CODE-AUDIT model benchmark — orchestrator (P2b).
 *
 * The single callable behind the CLI phase and the --auto-replace planner. It
 * mirrors the search-existing orchestrator (benchmark/search-existing/index.ts)
 * step for step:
 *   1. load + validate the golden corpus (deterministic — no LLM judge),
 *   2. build the candidate pool — explicit `models`, else auto-discovered
 *      candidates filtered by code_task's per-tool requirements
 *      (TOOL_MODEL_REGISTRY.code_task.requirements) AND not pricier than the
 *      incumbent (the cost gate would reject pricier ones — don't spend budget),
 *   3. score each candidate via the REAL pipeline runner (bench-runner.ts →
 *      runCodeTask in-process), with a per-model-per-day cache,
 *   4. apply the selection gate (select.ts → selectCodeTaskModel),
 *   5. render markdown + JSON reports and return the recommendation + paths.
 *
 * ADVISORY only — this module NEVER writes config. The recommendation is
 * surfaced for the operator to adopt via `tool_models.code_task` on a
 * settings.yaml profile; the only writer is the CLI (benchmark/pick.ts's
 * applyToolModelToSettings), behind the read-only-MCP guardrail.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBenchmarkRoster,
  rankByQualityIndex,
  fetchProgrammingModels,
  qualify,
  assertModelsUnderPriceCap,
  type OpenRouterModel,
  type QualifiedModel,
} from "../discover.js";
import { getConfigDir, getActiveFreeOnly } from "../../config.js";
import { resolveProjectMainRoot } from "../../project-root.js";
import { KNOWN_PRICING, type ModelPricing } from "../../mass_scouting/cost-estimate.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import { DEFAULT_MODEL } from "../../security_scan/types.js";

import { buildPreInstructions, codeTaskSystemPrompt, readFileAsCodeBlock } from "../../scan-pipeline.js";
import type { BenchmarkWorkload } from "../workload-types.js";

import {
  CODE_AUDIT_INSTRUCTIONS,
  CODE_AUDIT_LANGUAGE,
  fixturePath,
  loadDataset,
  resolveFixtureRoot,
  validateDataset,
  type CodeAuditCase,
} from "./dataset.js";
import { CODE_TASK_MAX_OUTPUT_TOKENS, runCodeAuditBenchmarkOnModel } from "./bench-runner.js";
import {
  aggregateScores,
  passesThresholds,
  DEFAULT_CODE_AUDIT_THRESHOLDS,
  type CodeAuditScore,
  type CodeAuditThresholds,
} from "./score.js";
import {
  CODE_TASK_CRITERIA,
  selectCodeTaskModel,
  type CodeTaskCandidate,
  type CodeTaskSelectionResult,
} from "./select.js";

/**
 * code_task has no per-tool default model of its own — it runs on the active
 * profile's ensemble. So the benchmark's incumbent defaults to DEFAULT_MODEL
 * (the shared baseline the other two benchmarks also use) unless the caller
 * passes `incumbentModelId`. The cost gate anchors on that incumbent's pricing.
 */
const INCUMBENT_FALLBACK_PRICING: ModelPricing =
  KNOWN_PRICING[DEFAULT_MODEL] ?? { input_per_m_usd: 0.04, output_per_m_usd: 0.1, context_window: 32_768 };

export interface CodeAuditBenchmarkOptions {
  apiKey?: string;
  /** Explicit model ids to assess. When absent, auto-discover the candidate pool. */
  models?: string[];
  /** Report dir. Default `<main-repo-root>/reports/code-task-benchmark/`. */
  outputDir?: string;
  mainRoot?: string;
  /** Ignore the per-model-per-day cache and re-run every model. */
  force?: boolean;
  thresholds?: CodeAuditThresholds;
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

export interface CodeAuditAssessment extends CodeTaskCandidate {
  /** Cases the pipeline FAILED outright (scored as all-missed). */
  failureReasons: string[];
  costUsd: number;
}

export interface CodeAuditBenchmarkResult {
  recommendedModelId: string;
  changed: boolean;
  selection: CodeTaskSelectionResult;
  results: CodeAuditAssessment[];
  costUsd: number;
  reportPath: string;
  jsonReportPath: string;
  summaryLine: string;
}

// ── Cache (per-model-per-day, dataset-hash-keyed) ───────────────────────────

interface CacheEntry {
  date: string;
  datasetHash: string;
  score: CodeAuditScore;
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
  return join(getConfigDir(), "code-task-results.json");
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

export async function runCodeAuditBenchmark(
  opts: CodeAuditBenchmarkOptions = {},
): Promise<CodeAuditBenchmarkResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const cases: readonly CodeAuditCase[] = loadDataset();
  // Fail BEFORE spending a cent if the corpus and the ground truth have drifted
  // (a missing fixture, a buggy symbol that is not in the file's AST, …).
  validateDataset(cases);

  // Hash the ground truth so an edit to the corpus invalidates the per-day cache.
  const datasetHash = createHash("sha1").update(JSON.stringify(cases)).digest("hex").slice(0, 12);
  const thresholds = opts.thresholds ?? DEFAULT_CODE_AUDIT_THRESHOLDS;
  const incumbentId = opts.incumbentModelId ?? DEFAULT_MODEL;
  const progress = opts.onProgress ?? ((): void => {});
  const freeOnly = getActiveFreeOnly();

  progress(`Loaded ${cases.length} golden cases (dataset ${datasetHash}).`);

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
        const q = qualify(raw, CODE_TASK_CRITERIA);
        addModel(
          q ?? decorate(raw),
          q !== null,
          q ? undefined : "below code-task requirements (cost/context/structured-output/reasoning)",
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
    const { candidates } = buildBenchmarkRoster(catalog, CODE_TASK_CRITERIA, []);
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
      const q = qualify(incumbentDecorated.raw, CODE_TASK_CRITERIA);
      addModel(incumbentDecorated, q !== null, q ? undefined : "below code-task requirements");
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

  // Global price-cap fail-fast on the FINAL candidate set (explicit ids +
  // incumbent; discovered were already dropped by filterModels). Refuses BEFORE
  // any send if any model exceeds $1.25/1M — $0 spent. This is the path the user
  // actually hit (`--code-task <ids>`), so the cap binds here first.
  assertModelsUnderPriceCap([...toAssess.values()].map((v) => v.model));

  progress(`Assessing ${toAssess.size} model(s) over ${cases.length} cases…`);

  const cache = loadCache();
  const assessments: CodeAuditAssessment[] = [];
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
    let score: CodeAuditScore;
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
      const run = await runCodeAuditBenchmarkOnModel(
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
      failureReasons = run.failures.map((f) => `${f.caseId}: ${f.reason}`);
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
        `macroF1=${score.macroF1.toFixed(3)} microR=${score.microRecall.toFixed(3)} ` +
        `exact=${score.exactMatches}/${cases.length} halluc=${score.hallucinations} fail=${failureReasons.length}`,
    );
  }

  saveCache(cache);

  const selection = selectCodeTaskModel({
    candidates: assessments,
    incumbentModelId: incumbentId,
    incumbentInputDollarsPerMillion: incumbentIn,
    incumbentOutputDollarsPerMillion: incumbentOut,
  });

  const mainRoot = resolveProjectMainRoot(opts.mainRoot);
  const reportDir = opts.outputDir ?? join(mainRoot, "reports", "code-task-benchmark");
  mkdirSync(reportDir, { recursive: true });
  const stamp = reportStamp();
  const jsonReportPath = join(reportDir, `${stamp}-code-task-benchmark.json`);
  const reportPath = join(reportDir, `${stamp}-code-task-benchmark.md`);

  const jsonPayload = {
    timestamp: new Date().toISOString(),
    datasetHash,
    caseCount: cases.length,
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
        macroF1: a.score.macroF1,
        microPrecision: a.score.microPrecision,
        microRecall: a.score.microRecall,
        microF1: a.score.microF1,
        exactMatches: a.score.exactMatches,
        hallucinations: a.score.hallucinations,
        anchoredRate: a.score.anchoredRate,
        failedCases: a.score.failedCases,
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
  cases: readonly CodeAuditCase[];
  datasetHash: string;
  incumbentId: string;
  incumbentIn: number;
  incumbentOut: number;
  thresholds: CodeAuditThresholds;
  assessments: readonly CodeAuditAssessment[];
  selection: CodeTaskSelectionResult;
  totalCost: number;
}): string {
  const defectCases = args.cases.filter((c) => c.buggySymbols.length > 0).length;
  const cleanCases = args.cases.length - defectCases;
  const plantedDefects = args.cases.reduce((n, c) => n + c.buggySymbols.length, 0);

  const lines: string[] = [];
  lines.push("# code_task (CODE AUDIT) — model benchmark");
  lines.push("");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(
    `**Corpus:** ${args.cases.length} cases (${defectCases} real pre-fix snapshots carrying ${plantedDefects} verified defects, ` +
      `${cleanCases} never-fixed clean files) — hash ${args.datasetHash}`,
  );
  lines.push(`**Incumbent:** \`${args.incumbentId}\` (in $${args.incumbentIn.toFixed(3)}/M, out $${args.incumbentOut.toFixed(3)}/M)`);
  lines.push(
    `**Pass gate:** macro-F1 ≥ ${args.thresholds.minMacroF1.toFixed(2)} AND ` +
      `micro-recall ≥ ${args.thresholds.minMicroRecall.toFixed(2)} AND ` +
      `≤ ${args.thresholds.maxFailedCases} failed case(s)`,
  );
  lines.push(`**Total LLM spend:** $${args.totalCost.toFixed(6)}`);
  lines.push("");
  lines.push(
    "**Scoring is 100% deterministic — no LLM judge.** The score is defect LOCALIZATION by " +
      "symbol name (the tool's own system prompt forbids identifying code by line number, so " +
      "the symbol name is the tool's contract and the only sound key). The corpus's " +
      "`defectClass` labels are reported but NOT graded: matching a model's free-text " +
      "explanation against them is a semantic-equivalence judgment, which would need a judge.",
  );
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`**${args.selection.changed ? "SWITCH" : "KEEP"} → \`${args.selection.recommendedModelId}\`**`);
  lines.push("");
  lines.push(args.selection.reason);
  lines.push("");
  lines.push("## Assessed models");
  lines.push("");
  lines.push("| Model | Req | Bench | macro-F1 | micro-P | micro-R | Exact | Halluc | Anchored | Fail | in $/M | out $/M | lat ms |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const sorted = [...args.assessments].sort((a, b) => b.score.macroF1 - a.score.macroF1);
  for (const a of sorted) {
    const thr = passesThresholds(a.score, args.thresholds);
    lines.push(
      `| \`${a.modelId}\` | ${a.qualified ? "ok" : "no"} | ${thr.pass ? "PASS" : "FAIL"} | ` +
        `${a.score.macroF1.toFixed(3)} | ${a.score.microPrecision.toFixed(3)} | ${a.score.microRecall.toFixed(3)} | ` +
        `${a.score.exactMatches}/${args.cases.length} | ${a.score.hallucinations} | ` +
        `${(a.score.anchoredRate * 100).toFixed(0)}% | ${a.score.failedCases} | ` +
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
    lines.push(`## Per-case breakdown — \`${rec.modelId}\``);
    lines.push("");
    lines.push("| Case | Universe | Expected | Accused | TP | FP | FN | Halluc | Mode | F1 | Defect class (not graded) |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const c of rec.score.cases) {
      lines.push(
        `| ${c.caseId} | ${c.universeSize} | ${c.expected.join(", ") || "—"} | ${c.returned.join(", ") || "—"} | ` +
          `${c.truePositives.length} | ${c.falsePositives.length} | ${c.falseNegatives.length} | ` +
          `${c.hallucinated.length} | ${c.mode} | ${c.f1.toFixed(3)} | ${c.defectClass} |`,
      );
    }
    lines.push("");
    if (rec.failureReasons.length > 0) {
      lines.push(`### Pipeline failures for \`${rec.modelId}\``);
      lines.push("");
      for (const f of rec.failureReasons) lines.push(`- ${f}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "Re-run: `llm-externalizer benchmark --code-task` (auto-discover) or `--code-task <id> [<id>...]` " +
      "(assess specific models). ADVISORY by default; add `--apply-profile <P>` to write the winner " +
      "into that profile's `tool_models.code_task` (CLI-only writer — the MCP surface never writes).",
  );
  return lines.join("\n") + "\n";
}

// ── P4 pre-flight workload description ──────────────────────────────────────

/**
 * Describe what ONE full run of this benchmark actually asks an LLM to do, for
 * ONE model — the P4 pre-flight spend estimate's input. Every number is
 * DERIVED from the real corpus on disk (loadDataset + the real fixture files),
 * reproduced with the SAME helpers bench-runner.ts uses to build the request
 * (readFileAsCodeBlock, buildPreInstructions, codeTaskSystemPrompt) — never a
 * hardcoded count — so a corpus edit moves the estimate automatically and a
 * stale literal can never quietly under-price a sweep. Makes NO network call;
 * it only reads the fixture files already on disk.
 */
export function describeWorkload(): BenchmarkWorkload {
  const cases: readonly CodeAuditCase[] = loadDataset();
  const fixtureRoot = resolveFixtureRoot();
  const preInstructions = buildPreInstructions(true, "read");
  // Same system prompt for every case — code_task's fixtures are all TypeScript.
  const systemPrompt = codeTaskSystemPrompt(CODE_AUDIT_LANGUAGE);

  let promptCharsPerModel = 0;
  for (const c of cases) {
    // Same call as bench-runner.ts's processFileCheck seam: the real fixture
    // path, the real file bytes, no redaction (the benchmark never redacts).
    const codeBlock = readFileAsCodeBlock(fixturePath(c, fixtureRoot), CODE_AUDIT_LANGUAGE);
    const userContent = `${preInstructions}Task: ${CODE_AUDIT_INSTRUCTIONS}\n\n${codeBlock}`;
    promptCharsPerModel += systemPrompt.length + userContent.length;
  }

  return {
    tool: "code_task",
    benchmark: "code-task",
    callsPerModel: cases.length,
    promptCharsPerModel,
    maxOutputTokensPerCall: CODE_TASK_MAX_OUTPUT_TOKENS,
  };
}
