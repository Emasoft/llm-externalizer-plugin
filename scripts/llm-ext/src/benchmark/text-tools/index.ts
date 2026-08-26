/**
 * Text-tools (summarize / topics / sem_deduplicate / describe) model
 * benchmark — orchestrator. Mirrors the code-task/check-specs orchestrators
 * step for step, ONE shared implementation parameterized by `tool` (the four
 * tools share the same options/result contract, the same cache shape, and
 * the same report layout — only the dataset, the criteria and the pipeline
 * runner differ, and those are already parameterized in bench-runner.ts /
 * select.ts):
 *   1. load the tool's golden corpus (dataset.ts — hand-curated, no
 *      fixture-derived ground truth to validate),
 *   2. build the candidate pool — explicit `models`, else auto-discovered
 *      candidates filtered by the tool's per-tool requirements
 *      (TOOL_MODEL_REGISTRY.<tool>.requirements) AND not pricier than the
 *      incumbent,
 *   3. score each candidate via the REAL pipeline runner (bench-runner.ts →
 *      text-tools/core.ts's runSummarize/runTopics/runSemDeduplicate/
 *      runDescribe in-process), with a per-model-per-day cache,
 *   4. apply the selection gate (select.ts → selectTextToolModel),
 *   5. render markdown + JSON reports and return the recommendation + paths.
 *
 * ADVISORY only — this module NEVER writes config. The recommendation is
 * surfaced for the operator to adopt via `tool_models.<tool>` on a
 * settings.yaml profile; the only writer is the CLI (benchmark/pick.ts's
 * applyToolModelToSettings), behind the read-only-MCP guardrail.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBenchmarkRoster,
  assertModelsUnderPriceCap,
  assertPaidBenchmarkAllowed,
  paidBenchmarkWouldRefuse,
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
import {
  buildDescribePrompt,
  buildSemDedupPrompt,
  buildSummarizePrompt,
  buildTopicsPrompt,
  literalDedup,
} from "../../text-tools/core.js";
import type { BenchmarkWorkload } from "../workload-types.js";

import {
  DESCRIBE_CASES,
  SEM_DEDUP_CASES,
  SUMMARIZE_CASES,
  TOPICS_CASES,
  semDedupInput,
} from "./dataset.js";
import {
  runTextToolBenchmarkOnModel,
  TEXT_TOOLS_MAX_OUTPUT_TOKENS,
  type TextToolName,
} from "./bench-runner.js";
import {
  aggregateTextToolScores,
  passesTextToolThresholds,
  DEFAULT_TEXT_TOOL_THRESHOLDS,
  type TextToolScore,
  type TextToolThresholds,
} from "./score.js";
import {
  textToolCriteria,
  selectTextToolModel,
  type TextToolCandidate,
  type TextToolSelectionResult,
} from "./select.js";

/** Registry benchmark id per tool — the single mapping every cache key, report
 *  dir and P4 workload description keys off. */
const BENCHMARK_ID: Record<TextToolName, string> = {
  summarize: "text-summarize",
  topics: "text-topics",
  sem_deduplicate: "text-sem-dedup",
  describe: "text-describe",
};

/**
 * None of the four text tools has a per-tool default model of its own — each
 * runs on the active profile's ensemble. So, like every other per-tool
 * benchmark here, the incumbent defaults to DEFAULT_MODEL unless the caller
 * passes `incumbentModelId`. The cost gate anchors on that incumbent's pricing.
 */
const INCUMBENT_FALLBACK_PRICING: ModelPricing = KNOWN_PRICING[DEFAULT_MODEL] ?? {
  input_per_m_usd: 0.04,
  output_per_m_usd: 0.1,
  context_window: 32_768,
};

export interface TextToolBenchmarkOptions {
  apiKey?: string;
  /** Explicit model ids to assess. When absent, auto-discover the candidate pool. */
  models?: string[];
  /** Report dir. Default `<main-repo-root>/reports/text-tools-benchmark/<tool>/`. */
  outputDir?: string;
  mainRoot?: string;
  /** Ignore the per-model-per-day cache and re-run every model. */
  force?: boolean;
  thresholds?: TextToolThresholds;
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

export interface TextToolAssessment extends TextToolCandidate {
  /** Cases the pipeline FAILED outright (scored as 0). */
  failureReasons: string[];
  costUsd: number;
}

export interface TextToolBenchmarkResult {
  recommendedModelId: string;
  changed: boolean;
  selection: TextToolSelectionResult;
  results: TextToolAssessment[];
  costUsd: number;
  reportPath: string;
  jsonReportPath: string;
  summaryLine: string;
}

// ── Per-tool dataset accessors ───────────────────────────────────────────────

function caseCountFor(tool: TextToolName): number {
  if (tool === "summarize") return SUMMARIZE_CASES.length;
  if (tool === "topics") return TOPICS_CASES.length;
  if (tool === "sem_deduplicate") return SEM_DEDUP_CASES.length;
  return DESCRIBE_CASES.length;
}

function datasetHashFor(tool: TextToolName): string {
  const data: unknown =
    tool === "summarize"
      ? SUMMARIZE_CASES
      : tool === "topics"
        ? TOPICS_CASES
        : tool === "sem_deduplicate"
          ? SEM_DEDUP_CASES
          : DESCRIBE_CASES;
  return createHash("sha1").update(JSON.stringify(data)).digest("hex").slice(0, 12);
}

// ── Cache (per-tool-per-model-per-day, dataset-hash-keyed) ──────────────────
//
// ONE shared cache file for all four tools (composite key carries the tool),
// rather than four near-identical files — the same content, one less path to
// keep straight.

interface CacheEntry {
  date: string;
  datasetHash: string;
  score: TextToolScore;
  costUsd: number;
  latencyMs: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  qualified: boolean;
  disqualifyReason?: string;
  failureReasons: string[];
  qualityPass?: boolean;
}
type CacheFile = Record<string, CacheEntry>;

function cachePath(): string {
  return join(getConfigDir(), "text-tools-results.json");
}

function cacheKey(tool: TextToolName, modelId: string, date: string, datasetHash: string): string {
  return `${tool}::${modelId}::${date}::${datasetHash}`;
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

// ── P4 pre-flight workload description ──────────────────────────────────────

/**
 * Describe what ONE full run of ONE tool's benchmark asks an LLM to do, for
 * ONE model — the P4 pre-flight spend estimate's input. Built from the SAME
 * prompt builders text-tools/core.ts uses (buildSummarizePrompt / etc.), so a
 * corpus edit moves the estimate automatically. Makes NO network call.
 *
 * callsPerModel and promptCharsPerModel are DOUBLED: unlike code-task/
 * check-specs (exactly one LLM call per case), every text-tool case may take
 * ONE corrective retry when the mechanical output validation fails
 * (text-tools/core.ts::callWithOneRetry) — a real second call at real cost.
 * The pre-flight estimate is documented as worst-case elsewhere in this
 * codebase (estimateWorkloadCostUsd's own comment); doubling here keeps that
 * promise instead of quietly under-pricing the retry path.
 */
export function describeWorkload(tool: TextToolName): BenchmarkWorkload {
  let promptChars = 0;
  let cases: number;

  if (tool === "summarize") {
    cases = SUMMARIZE_CASES.length;
    for (const c of SUMMARIZE_CASES) {
      const p = buildSummarizePrompt(c.text, c.maxChars);
      promptChars += p.system.length + p.user.length;
    }
  } else if (tool === "topics") {
    cases = TOPICS_CASES.length;
    for (const c of TOPICS_CASES) {
      const p = buildTopicsPrompt(c.text, 15, 10); // text-tools/core.ts's own defaults
      promptChars += p.system.length + p.user.length;
    }
  } else if (tool === "sem_deduplicate") {
    cases = SEM_DEDUP_CASES.length;
    for (const c of SEM_DEDUP_CASES) {
      const literal = literalDedup(semDedupInput(c)).survivors;
      const p = buildSemDedupPrompt(literal);
      promptChars += p.system.length + p.user.length;
    }
  } else {
    cases = DESCRIBE_CASES.length;
    for (const c of DESCRIBE_CASES) {
      const p = buildDescribePrompt(c.fileName, c.content, c.maxChars);
      promptChars += p.system.length + p.user.length;
    }
  }

  return {
    tool,
    benchmark: BENCHMARK_ID[tool],
    callsPerModel: cases * 2,
    promptCharsPerModel: promptChars * 2,
    maxOutputTokensPerCall: TEXT_TOOLS_MAX_OUTPUT_TOKENS,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

async function runTextToolBenchmark(
  tool: TextToolName,
  opts: TextToolBenchmarkOptions,
): Promise<TextToolBenchmarkResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const caseCount = caseCountFor(tool);
  const datasetHash = datasetHashFor(tool);
  const thresholds = opts.thresholds ?? DEFAULT_TEXT_TOOL_THRESHOLDS;
  const incumbentId = opts.incumbentModelId ?? DEFAULT_MODEL;
  const progress = opts.onProgress ?? ((): void => {});
  const freeOnly = getActiveFreeOnly();
  const criteria = textToolCriteria(tool);

  progress(`Loaded ${caseCount} golden ${tool} cases (dataset ${datasetHash}).`);

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
        const q = qualify(raw, criteria);
        addModel(
          q ?? decorate(raw),
          q !== null,
          q ? undefined : `below ${tool} requirements (cost/context/output/params)`,
        );
      } else {
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
    const { candidates } = buildBenchmarkRoster(catalog, criteria, []);
    const affordable = candidates.filter(
      (c) =>
        c.inputDollarsPerMillion <= incumbentIn + 1e-9 &&
        c.outputDollarsPerMillion <= incumbentOut + 1e-9,
    );
    const sameOrCheaper = rankByQualityIndex(affordable).slice(0, opts.qualifyingTopN ?? 16);
    for (const c of sameOrCheaper) addModel(c, true);
  }

  // ALWAYS assess the incumbent (so the report confirms it still passes),
  // except when the paid-benchmark gates would refuse it — see code-task/
  // index.ts for why an auto-added incumbent is skipped rather than refusing
  // the whole run over it.
  if (!toAssess.has(incumbentId)) {
    const incumbentRefused = paidBenchmarkWouldRefuse({
      id: incumbentId,
      inputDollarsPerMillion: incumbentIn,
      outputDollarsPerMillion: incumbentOut,
    });
    if (incumbentRefused) {
      progress(
        `  ${incumbentId}: incumbent not assessed — it is paid and paid benchmarks are off ($0 spent).`,
      );
    } else if (incumbentDecorated) {
      const q = qualify(incumbentDecorated.raw, criteria);
      addModel(incumbentDecorated, q !== null, q ? undefined : `below ${tool} requirements`);
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

  assertModelsUnderPriceCap([...toAssess.values()].map((v) => v.model));
  assertPaidBenchmarkAllowed([...toAssess.values()].map((v) => v.model));

  progress(`Assessing ${toAssess.size} model(s) over ${caseCount} ${tool} cases…`);

  const cache = loadCache();
  const assessments: TextToolAssessment[] = [];
  let totalCost = 0;

  for (const { model, qualified, disqualifyReason } of toAssess.values()) {
    const freeOnlySkip = freeOnly && !model.id.endsWith(":free");
    const paidRefusedSkip = !freeOnlySkip && paidBenchmarkWouldRefuse(model);
    if (freeOnlySkip || paidRefusedSkip) {
      const skipReason = freeOnlySkip
        ? "free_only active — non-':free' model not benchmarked"
        : "paid benchmarks are off — paid model not benchmarked";
      progress(`  ${model.id}: skipped (${skipReason}).`);
      assessments.push({
        modelId: model.id,
        qualified: false,
        disqualifyReason: skipReason,
        inputDollarsPerMillion: model.inputDollarsPerMillion,
        outputDollarsPerMillion: model.outputDollarsPerMillion,
        latencyMs: 0,
        score: aggregateTextToolScores([], 0, 0),
        failureReasons: [],
        costUsd: 0,
      });
      continue;
    }

    const key = cacheKey(tool, model.id, today(), datasetHash);
    const cached = cache[key];
    let score: TextToolScore;
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
      const run = await runTextToolBenchmarkOnModel(
        tool,
        model.id,
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

    cache[key].qualityPass = passesTextToolThresholds(score, thresholds).pass;

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
    const thr = passesTextToolThresholds(score, thresholds);
    progress(
      `    ${model.id}: ${thr.pass ? "PASS" : "FAIL"} meanScore=${score.meanScore.toFixed(3)} ` +
        `failed=${score.failedCases}/${score.totalCases}`,
    );
  }

  saveCache(cache);

  const selection = selectTextToolModel(tool, {
    candidates: assessments,
    incumbentModelId: incumbentId,
    incumbentInputDollarsPerMillion: incumbentIn,
    incumbentOutputDollarsPerMillion: incumbentOut,
  });

  const mainRoot = resolveProjectMainRoot(opts.mainRoot);
  const reportDir = opts.outputDir ?? join(mainRoot, "reports", "text-tools-benchmark", tool);
  mkdirSync(reportDir, { recursive: true });
  const stamp = reportStamp();
  const jsonReportPath = join(reportDir, `${stamp}-${tool}-benchmark.json`);
  const reportPath = join(reportDir, `${stamp}-${tool}-benchmark.md`);

  const jsonPayload = {
    timestamp: new Date().toISOString(),
    tool,
    datasetHash,
    caseCount,
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
      const thr = passesTextToolThresholds(a.score, thresholds);
      return {
        modelId: a.modelId,
        qualified: a.qualified,
        disqualifyReason: a.disqualifyReason,
        inputDollarsPerMillion: a.inputDollarsPerMillion,
        outputDollarsPerMillion: a.outputDollarsPerMillion,
        latencyMs: a.latencyMs,
        pass: thr.pass,
        reason: thr.reason,
        meanScore: a.score.meanScore,
        failedCases: a.score.failedCases,
        totalCases: a.score.totalCases,
        failureReasons: a.failureReasons,
        costUsd: a.costUsd,
      };
    }),
    rejected: selection.rejected,
  };
  const jtmp = `${jsonReportPath}.tmp.${process.pid}`;
  writeFileSync(jtmp, JSON.stringify(jsonPayload, null, 2), "utf-8");
  renameSync(jtmp, jsonReportPath);

  const md = buildReportMarkdown({
    tool,
    caseCount,
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
  tool: TextToolName;
  caseCount: number;
  datasetHash: string;
  incumbentId: string;
  incumbentIn: number;
  incumbentOut: number;
  thresholds: TextToolThresholds;
  assessments: readonly TextToolAssessment[];
  selection: TextToolSelectionResult;
  totalCost: number;
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.tool} — model benchmark`);
  lines.push("");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(`**Corpus:** ${args.caseCount} hand-curated cases — hash ${args.datasetHash}`);
  lines.push(`**Incumbent:** \`${args.incumbentId}\` (in $${args.incumbentIn.toFixed(3)}/M, out $${args.incumbentOut.toFixed(3)}/M)`);
  lines.push(
    `**Pass gate:** mean concept score ≥ ${args.thresholds.minMeanScore.toFixed(2)} AND ` +
      `≤ ${args.thresholds.maxFailedCases} failed case(s)`,
  );
  lines.push(`**Total LLM spend:** $${args.totalCost.toFixed(6)}`);
  lines.push("");
  lines.push(
    "**Scoring is 100% deterministic — no LLM judge.** Each case checks the tool's own " +
      "hard contract (a character budget, valid JSON, a subset-of-input guarantee) plus " +
      "concept recall against a hand-curated answer key (score.ts).",
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
  lines.push("| Model | Req | Bench | Mean score | Failed | in $/M | out $/M | lat ms |");
  lines.push("|---|---|---|---|---|---|---|---|");
  const sorted = [...args.assessments].sort((a, b) => b.score.meanScore - a.score.meanScore);
  for (const a of sorted) {
    const thr = passesTextToolThresholds(a.score, args.thresholds);
    lines.push(
      `| \`${a.modelId}\` | ${a.qualified ? "ok" : "no"} | ${thr.pass ? "PASS" : "FAIL"} | ` +
        `${a.score.meanScore.toFixed(3)} | ${a.score.failedCases}/${a.score.totalCases} | ` +
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
  if (rec && rec.failureReasons.length > 0) {
    lines.push(`### Pipeline failures for \`${rec.modelId}\``);
    lines.push("");
    for (const f of rec.failureReasons) lines.push(`- ${f}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `Re-run: \`llm-ext-benchmark --${args.tool.replace(/_/g, "-")}-benchmark\` (auto-discover) or ` +
      `\`--${args.tool.replace(/_/g, "-")}-benchmark <id> [<id>...]\` (assess specific models). ADVISORY ` +
      `by default; add \`--apply-profile <P>\` to write the winner into that profile's ` +
      `\`tool_models.${args.tool}\` (CLI-only writer — the MCP surface never writes).`,
  );
  return lines.join("\n") + "\n";
}

// ── The four exported entries ────────────────────────────────────────────────

export function runSummarizeBenchmark(
  opts: TextToolBenchmarkOptions = {},
): Promise<TextToolBenchmarkResult> {
  return runTextToolBenchmark("summarize", opts);
}

export function runTopicsBenchmark(
  opts: TextToolBenchmarkOptions = {},
): Promise<TextToolBenchmarkResult> {
  return runTextToolBenchmark("topics", opts);
}

export function runSemDedupBenchmark(
  opts: TextToolBenchmarkOptions = {},
): Promise<TextToolBenchmarkResult> {
  return runTextToolBenchmark("sem_deduplicate", opts);
}

export function runDescribeBenchmark(
  opts: TextToolBenchmarkOptions = {},
): Promise<TextToolBenchmarkResult> {
  return runTextToolBenchmark("describe", opts);
}
