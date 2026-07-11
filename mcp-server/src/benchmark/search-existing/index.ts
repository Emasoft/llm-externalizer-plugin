/**
 * search_existing_implementations model benchmark — orchestrator
 * (TRDD-828238b5 A6). The single callable behind all three surfaces (MCP tool /
 * CLI / slash command). It mirrors the security-triage orchestrator's shape
 * (benchmark/security-triage/index.ts), smaller:
 *   1. loads the golden fixture dataset (deterministic — no LLM judge),
 *   2. builds the candidate pool — explicit `models`, or the same qualifying
 *      candidates the security-triage orchestrator uses, filtered via this
 *      tool's per-tool requirements (TOOL_MODEL_REGISTRY.search_existing_
 *      implementations.requirements) AND not pricier than the incumbent
 *      default (the cost gate would reject pricier ones — don't spend budget),
 *   3. scores each candidate over the fixture dataset via the REAL pipeline
 *      runner (runner.ts → runSearchExistingImplementations in-process), with a
 *      per-model-per-day cache,
 *   4. applies the selection gate (select.ts → selectSearchExistingModel),
 *   5. renders a markdown + JSON report under the same report-path conventions
 *      security-triage uses and returns the recommendation + paths.
 *
 * ADVISORY only — like security-triage it NEVER writes config. The recommended
 * model is surfaced for the operator to adopt via the
 * `tool_models.search_existing_implementations` field on a settings.yaml profile.
 *
 * Fail-safe note: unlike security_scan (which protects against hostile code and
 * must never hard-error), this is an explicit assessment action — a missing API
 * key is a hard error, because a benchmark you cannot run is useless.
 *
 * free_only honoring: like the security-triage orchestrator, this calls no
 * model directly — the runner does. The process-wide free_only flag (config.ts)
 * is published by whichever entry point owns the active profile (the MCP server
 * on load, the benchmark CLI in its main()), and the runner's own free_only
 * chokepoint records-but-never-bills a non-':free' model. So in free mode an
 * auto-discovered paid candidate is filtered out by `allowFree`-aware qualify
 * before it ever reaches the runner.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

import {
  SEARCH_EXISTING_CASES,
  resolveFixtureRoot,
  listFixtureFiles,
  type SearchExistingCase,
} from "./dataset.js";
import { runSearchExistingBenchmarkOnModel, SEARCH_EXISTING_MAX_OUTPUT_TOKENS } from "./runner.js";
import {
  aggregateScores,
  passesThresholds,
  DEFAULT_SEARCH_EXISTING_THRESHOLDS,
  type SearchExistingScore,
  type SearchExistingThresholds,
} from "./score.js";
import {
  SEARCH_EXISTING_CRITERIA,
  selectSearchExistingModel,
  type SearchExistingCandidate,
  type SearchExistingSelectionResult,
} from "./select.js";
import { readAndGroupFiles, buildPerFileSectionPrompt, DEFAULT_MAX_PAYLOAD_BYTES } from "../../scan-pipeline.js";
import type { BenchmarkWorkload } from "../workload-types.js";

// ── P4 pre-flight workload estimate ─────────────────────────────────────────

/**
 * Fixed per-call prompt overhead the real pipeline (search-existing/core.ts)
 * builds INLINE — the system message, the base "checking every file..."
 * instructions, the with/without-reference block, and (for multi-file
 * batches) the per-file-section-prompt hint. That text lives inside
 * runSearchExistingImplementations, not exported as a reusable literal, so it
 * cannot be imported byte-for-byte without duplicating core.ts's private
 * prompt-construction logic (which would silently go stale the moment core.ts's
 * wording changes). Measured empirically against the actual strings core.ts
 * builds (system message + the longest with-reference base-prompt branch +
 * the multi-file section hint) at ~2.4k chars; rounded up to a clearly
 * generous 3000 so this stays a SOUND UPPER BOUND, never an under-estimate.
 * Accuracy here is not the run's safety net — budget.ts's per-call HTTP
 * chokepoint is — this only has to keep the pre-flight number honest.
 */
const FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL = 3000;

/** Resolve a fixture-relative path to an absolute on-disk path (mirrors runner.ts's `abs`). */
function absFixturePath(root: string, rel: string): string {
  return resolve(root, rel);
}

/**
 * Derive the P4 pre-flight spend-cap workload for the search_existing_implementations
 * benchmark straight from the real fixture corpus on disk, replaying the SAME
 * per-case file selection the runner uses (runner.ts's scannedAbs filter) and the
 * SAME FFD bin-packing helper (scan-pipeline.ts's readAndGroupFiles) search-existing/
 * core.ts calls per case — so callsPerModel and promptCharsPerModel move
 * automatically with any change to the dataset or fixture corpus. No network call.
 *
 * promptBytes passed to readAndGroupFiles is FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL
 * (our generous fixed-overhead constant) rather than core.ts's exact (private)
 * prompt byte count — a LARGER promptBytes can only shrink the per-batch file
 * budget and so can only produce EQUAL-OR-MORE bins/calls than reality, keeping
 * callsPerModel an over-estimate too, never an under-count.
 */
export function describeWorkload(): BenchmarkWorkload {
  const fixtureRoot = resolveFixtureRoot();
  const allFixtureRel = listFixtureFiles(fixtureRoot);

  let callsPerModel = 0;
  let promptCharsPerModel = 0;

  for (const c of SEARCH_EXISTING_CASES) {
    const sourceRel = new Set(c.sourceFiles ?? []);
    const scannedAbs = allFixtureRel
      .filter((rel) => c.extensions.some((ext) => rel.endsWith(ext)))
      .filter((rel) => !sourceRel.has(rel))
      .map((rel) => absFixturePath(fixtureRoot, rel));

    const { groups } = readAndGroupFiles(
      scannedAbs,
      FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL,
      false, // redact_secrets: false — matches the args the runner builds per case
      DEFAULT_MAX_PAYLOAD_BYTES,
      null,
    );

    callsPerModel += groups.length;
    for (const group of groups) {
      const groupPaths = group.map((fd) => fd.path);
      let callChars = FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL;
      if (groupPaths.length > 1) callChars += buildPerFileSectionPrompt(groupPaths).length;
      for (const fd of group) callChars += fd.block.length;
      promptCharsPerModel += callChars;
    }
  }

  return {
    tool: "search_existing_implementations",
    benchmark: "search-existing",
    callsPerModel,
    promptCharsPerModel,
    maxOutputTokensPerCall: SEARCH_EXISTING_MAX_OUTPUT_TOKENS,
  };
}

/**
 * search_existing_implementations has no per-tool default model of its own — it
 * runs on the active profile's main model. So the benchmark's incumbent defaults
 * to DEFAULT_MODEL (the same shared baseline the security-triage benchmark uses)
 * unless the caller passes `incumbentModelId`. The cost gate is anchored on
 * whatever that incumbent's catalog/KNOWN_PRICING pricing is.
 */
const INCUMBENT_FALLBACK_PRICING: ModelPricing =
  KNOWN_PRICING[DEFAULT_MODEL] ?? { input_per_m_usd: 0.04, output_per_m_usd: 0.1, context_window: 32_768 };

export interface SearchExistingBenchmarkOptions {
  apiKey?: string;
  /** Explicit model ids to assess. When absent, auto-discover the candidate pool. */
  models?: string[];
  /** Report dir. Default `<main-repo-root>/reports/search-existing-benchmark/`. */
  outputDir?: string;
  mainRoot?: string;
  /** Ignore the per-model-per-day cache and re-run every model. */
  force?: boolean;
  thresholds?: SearchExistingThresholds;
  /** The incumbent to compare against. Default DEFAULT_MODEL (no per-tool default). */
  incumbentModelId?: string;
  /**
   * Cap the auto-discovered pool (cheapest-first). The task's `qualifyingTopN`.
   * Default 16 (same as security-triage's maxCandidates).
   */
  qualifyingTopN?: number;
  /** Per-call timeout in ms forwarded to the runner. Default 120_000. */
  perCallTimeoutMs?: number;
  /** Test seam — injected HTTP impl forwarded to the runner. */
  fetchImpl?: FetchImpl;
  onProgress?: (message: string) => void;
}

/**
 * Per-model assessment carried back to the caller (and into the report). Wraps
 * the deterministic aggregate plus the qualify verdict + pricing + latency so
 * the markdown renderer and the selection gate share one shape.
 */
export interface SearchExistingAssessment extends SearchExistingCandidate {
  /** Whole cases the pipeline FAILED outright (scored as all-unscored). */
  failureReasons: string[];
  /** Total USD spent assessing this model over the dataset. */
  costUsd: number;
}

export interface SearchExistingBenchmarkResult {
  recommendedModelId: string;
  changed: boolean;
  selection: SearchExistingSelectionResult;
  /** Every assessed model's score + pricing + latency, best-first. */
  results: SearchExistingAssessment[];
  costUsd: number;
  /** The markdown report path — the task's `reportPath`. */
  reportPath: string;
  jsonReportPath: string;
  summaryLine: string;
}

// ── Cache (per-model-per-day, dataset-hash-keyed) ─────────────────────────

interface CacheEntry {
  date: string;
  datasetHash: string;
  score: SearchExistingScore;
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
  return join(getConfigDir(), "search-existing-results.json");
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
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  const p = cachePath();
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  renameSync(tmp, p);
}

// ── Helpers ────────────────────────────────────────────────────────────────

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

function resolveMainRoot(override?: string): string {
  // Single source of truth — see project-root.ts.
  return resolveProjectMainRoot(override);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** local-time + GMT-offset compact stamp (agent-reports-location convention). */
function reportStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${oh}${om}`;
}

function pricingFromModel(m: { inputDollarsPerMillion: number; outputDollarsPerMillion: number; contextTokens: number }): ModelPricing {
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

export async function runSearchExistingBenchmark(
  opts: SearchExistingBenchmarkOptions = {},
): Promise<SearchExistingBenchmarkResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const cases: readonly SearchExistingCase[] = SEARCH_EXISTING_CASES;
  // Hash the in-source dataset definition so a change to the cases invalidates
  // the per-day cache (the dataset is code, not a file path like security-triage's
  // dataset.jsonl, so we hash its JSON projection).
  const datasetHash = createHash("sha1")
    .update(JSON.stringify(cases))
    .digest("hex")
    .slice(0, 12);
  const thresholds = opts.thresholds ?? DEFAULT_SEARCH_EXISTING_THRESHOLDS;
  const incumbentId = opts.incumbentModelId ?? DEFAULT_MODEL;
  const progress = opts.onProgress ?? (() => {});
  const freeOnly = getActiveFreeOnly();

  progress(`Loaded ${cases.length} golden cases (dataset ${datasetHash}).`);

  // 1. Fetch the catalog once (covers candidate discovery, incumbent lookup,
  //    and explicit-model pricing).
  progress("Fetching OpenRouter model catalog…");
  const catalog = await fetchProgrammingModels();
  const byId = new Map(catalog.map((m) => [m.id, m] as const));

  // 2. Resolve the incumbent's pricing (catalog → KNOWN_PRICING fallback).
  const incumbentRaw = byId.get(incumbentId);
  const incumbentDecorated = incumbentRaw ? decorate(incumbentRaw) : null;
  const incumbentIn = incumbentDecorated && isFinite(incumbentDecorated.inputDollarsPerMillion)
    ? incumbentDecorated.inputDollarsPerMillion
    : INCUMBENT_FALLBACK_PRICING.input_per_m_usd;
  const incumbentOut = incumbentDecorated && isFinite(incumbentDecorated.outputDollarsPerMillion)
    ? incumbentDecorated.outputDollarsPerMillion
    : INCUMBENT_FALLBACK_PRICING.output_per_m_usd;

  // 3. Build the model list to ASSESS — same posture as the security-triage
  //    orchestrator: explicit `models` if given, else auto-discovered qualifying
  //    same-or-cheaper candidates.
  const toAssess = new Map<string, { model: QualifiedModel; qualified: boolean; disqualifyReason?: string }>();
  const addModel = (model: QualifiedModel, qualified: boolean, disqualifyReason?: string) => {
    if (!toAssess.has(model.id)) toAssess.set(model.id, { model, qualified, disqualifyReason });
  };

  if (opts.models && opts.models.length > 0) {
    // Explicit assessment: run exactly these (the user asked); the gate still
    // rejects pricier/failing ones in selection.
    for (const id of opts.models) {
      const raw = byId.get(id);
      if (raw) {
        const q = qualify(raw, SEARCH_EXISTING_CRITERIA);
        addModel(
          q ?? decorate(raw),
          q !== null,
          q ? undefined : "below search-existing requirements (cost/context/structured-output/reasoning)",
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
    // Auto-discovery: qualified candidates (the SAME qualify path the
    // security-triage orchestrator uses, via buildBenchmarkRoster +
    // SEARCH_EXISTING_CRITERIA), pre-filtered to NOT pricier than the incumbent.
    const { candidates } = buildBenchmarkRoster(catalog, SEARCH_EXISTING_CRITERIA, []);
    const affordable = candidates.filter(
      (c) => c.inputDollarsPerMillion <= incumbentIn + 1e-9 && c.outputDollarsPerMillion <= incumbentOut + 1e-9,
    );
    // Quality-rank the affordable candidates (codex coding_index + design-arena
    // code ELO) before the top-N cap, so the paid set is the most-promising
    // affordable models, not merely the cheapest (TRDD-WJND1N2W P2).
    const sameOrCheaper = rankByQualityIndex(affordable).slice(0, opts.qualifyingTopN ?? 16);
    for (const c of sameOrCheaper) addModel(c, true);
  }

  // 4. ALWAYS assess the incumbent (so the report confirms it still passes and
  //    the gate has a fallback) — when it is a model the benchmark can run.
  if (!toAssess.has(incumbentId)) {
    if (incumbentDecorated) {
      const q = qualify(incumbentDecorated.raw, SEARCH_EXISTING_CRITERIA);
      addModel(incumbentDecorated, q !== null, q ? undefined : "below search-existing requirements");
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

  progress(`Assessing ${toAssess.size} model(s) over ${cases.length} cases…`);

  // 5. Run + score each model (sequential — avoids stacking rate-limit hits).
  const cache = loadCache();
  const assessments: SearchExistingAssessment[] = [];
  let totalCost = 0;

  for (const { model, qualified, disqualifyReason } of toAssess.values()) {
    // free_only cost-safety: a non-':free' model would be recorded-not-billed by
    // the runner anyway, but we skip running it entirely (it cannot become the
    // free-mode default) and record it as a $0, requirements-disqualified entry.
    if (freeOnly && !model.id.endsWith(":free")) {
      progress(`  ${model.id}: skipped (free_only — non-':free' model).`);
      const emptyAggregate = aggregateScores([]);
      assessments.push({
        modelId: model.id,
        qualified: false,
        disqualifyReason: "free_only active — non-':free' model not benchmarked",
        inputDollarsPerMillion: model.inputDollarsPerMillion,
        outputDollarsPerMillion: model.outputDollarsPerMillion,
        latencyMs: 0,
        score: emptyAggregate,
        failureReasons: [],
        costUsd: 0,
      });
      continue;
    }

    const key = cacheKey(model.id, today(), datasetHash);
    const cached = cache[key];
    let score: SearchExistingScore;
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
      const run = await runSearchExistingBenchmarkOnModel(
        model.id,
        cases,
        {
          apiKey,
          pricing: pricingFromModel(model),
          perCallTimeoutMs: opts.perCallTimeoutMs ?? 120_000,
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
        `microF1=${score.microF1.toFixed(3)} microR=${score.microRecall.toFixed(3)} ` +
        `cov=${score.coverage.toFixed(3)} fail=${failureReasons.length}`,
    );
  }

  saveCache(cache);

  // 6. Selection gate.
  const selection = selectSearchExistingModel({
    candidates: assessments,
    incumbentModelId: incumbentId,
    incumbentInputDollarsPerMillion: incumbentIn,
    incumbentOutputDollarsPerMillion: incumbentOut,
  });

  // 7. Write the report (same conventions security-triage uses).
  const mainRoot = resolveMainRoot(opts.mainRoot);
  const reportDir = opts.outputDir ?? join(mainRoot, "reports", "search-existing-benchmark");
  mkdirSync(reportDir, { recursive: true });
  const stamp = reportStamp();
  const jsonReportPath = join(reportDir, `${stamp}-search-existing-benchmark.json`);
  const reportPath = join(reportDir, `${stamp}-search-existing-benchmark.md`);

  const jsonPayload = {
    timestamp: new Date().toISOString(),
    datasetHash,
    caseCount: cases.length,
    thresholds,
    incumbent: { modelId: incumbentId, inputDollarsPerMillion: incumbentIn, outputDollarsPerMillion: incumbentOut },
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

// ── Markdown report ──────────────────────────────────────────────────────────

function buildReportMarkdown(args: {
  cases: readonly SearchExistingCase[];
  datasetHash: string;
  incumbentId: string;
  incumbentIn: number;
  incumbentOut: number;
  thresholds: SearchExistingThresholds;
  assessments: readonly SearchExistingAssessment[];
  selection: SearchExistingSelectionResult;
  totalCost: number;
}): string {
  const lines: string[] = [];
  lines.push("# search_existing_implementations — model benchmark");
  lines.push("");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(`**Dataset:** ${args.cases.length} golden fixture cases (hash ${args.datasetHash})`);
  lines.push(`**Incumbent default:** \`${args.incumbentId}\` (in $${args.incumbentIn.toFixed(3)}/M, out $${args.incumbentOut.toFixed(3)}/M)`);
  lines.push(
    `**Pass gate:** micro-F1 ≥ ${args.thresholds.minMicroF1.toFixed(2)} AND ` +
      `micro-recall ≥ ${args.thresholds.minMicroRecall.toFixed(2)} AND ` +
      `coverage ≥ ${args.thresholds.minCoverage.toFixed(2)}`,
  );
  lines.push(`**Total LLM spend:** $${args.totalCost.toFixed(6)}`);
  lines.push("");
  lines.push(`## Recommendation`);
  lines.push("");
  lines.push(`**${args.selection.changed ? "SWITCH" : "KEEP"} → \`${args.selection.recommendedModelId}\`**`);
  lines.push("");
  lines.push(args.selection.reason);
  lines.push("");
  lines.push(`## Assessed models`);
  lines.push("");
  lines.push("| Model | Req | Bench | micro-P | micro-R | micro-F1 | macro-F1 | Cov | Fail | in $/M | out $/M | lat ms |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const sorted = [...args.assessments].sort((a, b) => b.score.microF1 - a.score.microF1);
  for (const a of sorted) {
    const thr = passesThresholds(a.score, args.thresholds);
    lines.push(
      `| \`${a.modelId}\` | ${a.qualified ? "ok" : "no"} | ${thr.pass ? "PASS" : "FAIL"} | ` +
        `${a.score.microPrecision.toFixed(3)} | ${a.score.microRecall.toFixed(3)} | ` +
        `${a.score.microF1.toFixed(3)} | ${a.score.macroF1.toFixed(3)} | ` +
        `${(a.score.coverage * 100).toFixed(0)}% | ${a.failureReasons.length} | ` +
        `${a.inputDollarsPerMillion.toFixed(3)} | ${a.outputDollarsPerMillion.toFixed(3)} | ${a.latencyMs} |`,
    );
  }
  lines.push("");
  if (args.selection.rejected.length > 0) {
    lines.push(`## Rejected (and why)`);
    lines.push("");
    for (const r of args.selection.rejected) {
      lines.push(`- \`${r.modelId}\` — ${r.reason}`);
    }
    lines.push("");
  }
  // Per-case breakdown for the recommended model.
  const rec = args.assessments.find((a) => a.modelId === args.selection.recommendedModelId);
  if (rec) {
    lines.push(`## Per-case breakdown — \`${rec.modelId}\``);
    lines.push("");
    lines.push("| Case | TP | FP | FN | TN | Unscored | Precision | Recall | F1 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const c of rec.score.cases) {
      lines.push(
        `| ${c.caseId} | ${c.truePositives} | ${c.falsePositives} | ${c.falseNegatives} | ` +
          `${c.trueNegatives} | ${c.unscored} | ${c.precision.toFixed(3)} | ` +
          `${c.recall.toFixed(3)} | ${c.f1.toFixed(3)} |`,
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
    "Re-run: `llm-externalizer benchmark --search-existing` (auto-discover) or " +
      "`--search-existing <id> [<id>...]` (assess specific models). ADVISORY only — " +
      "the recommended model is surfaced for the operator to adopt via the " +
      "`tool_models.search_existing_implementations` field on a settings.yaml " +
      "profile; the benchmark never edits config.",
  );
  return lines.join("\n") + "\n";
}
