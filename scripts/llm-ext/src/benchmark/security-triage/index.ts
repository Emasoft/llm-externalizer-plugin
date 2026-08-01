/**
 * Security-triage model benchmark — orchestrator (TRDD-973a0265 §3.4/§3.5).
 *
 * The single callable behind all three surfaces (MCP tool / CLI / slash
 * command). It:
 *   1. loads the golden dataset,
 *   2. builds the candidate pool — explicit `models`, or auto-discovered
 *      OpenRouter models that meet SECURITY_TRIAGE_CRITERIA (this tool's own
 *      per-tool requirements) AND are not pricier than the incumbent (no point
 *      spending budget on a model the gate would reject for cost),
 *   3. scores each candidate over the dataset via the REAL judge pipeline
 *      (runner.ts → judgeGroups), with a per-model-per-day cache,
 *   4. applies the selection gate (select.ts) to recommend the best
 *      same-or-cheaper passer,
 *   5. writes a JSON + markdown report and returns the recommendation.
 *
 * Fail-safe note: unlike security_scan (which protects against hostile code and
 * must never hard-error), this is an explicit assessment action — a missing API
 * key is a hard error, because a benchmark you cannot run is useless.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBenchmarkRoster,
  assertModelsUnderPriceCap,
  assertPaidBenchmarkAllowed,
  rankByQualityIndex,
  fetchProgrammingModels,
  qualify,
  type OpenRouterModel,
  type QualifiedModel,
} from "../discover.js";
import { setBenchmarkValidationExempt } from "../validated.js";
import { getConfigDir, getActiveFreeOnly } from "../../config.js";
import { FreeModeSkipError, isFreeSuffixModelId } from "../free-mode.js";
import { resolveProjectMainRoot } from "../../project-root.js";
import { KNOWN_PRICING, type ModelPricing } from "../../mass_scouting/cost-estimate.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import { DEFAULT_MODEL } from "../../security_scan/types.js";
import { buildSystemPrompt, buildUserMessage, makeNonce, preScanInjection } from "../../security_scan/prompt.js";
import { ASSUMED_MAX_OUTPUT_TOKENS } from "../budget.js";
import type { BenchmarkWorkload } from "../workload-types.js";

import { BENCHMARK_RUBRICS, loadDataset, resolveDatasetPath, type SecurityTriageCase } from "./dataset.js";
import { runTriageBenchmarkOnModel } from "./runner.js";
import {
  DEFAULT_TRIAGE_THRESHOLDS,
  notBenchmarkedScore,
  scoreTriage,
  type TriageScore,
  type TriageThresholds,
} from "./score.js";
import {
  selectSecurityTriageModel,
  type CandidateAssessment,
  type SelectionResult,
} from "./select.js";
import { getToolDescriptor } from "../../model-qualification/registry.js";

// This tool's model requirements come from the per-tool registry
// (TRDD-f45eeaa0) — the single source of truth. The registry entry points at
// SECURITY_TRIAGE_CRITERIA; reading it here routes the orchestrator's
// auto-discovery + qualify checks through the registry.
const SECURITY_TRIAGE_CRITERIA = getToolDescriptor("security_scan")!.requirements;

const INCUMBENT_FALLBACK_PRICING: ModelPricing =
  KNOWN_PRICING[DEFAULT_MODEL] ?? { input_per_m_usd: 0.04, output_per_m_usd: 0.1, context_window: 32_768 };

export interface SecurityTriageBenchmarkOptions {
  apiKey?: string;
  /** Explicit model ids to assess. When absent, auto-discover the candidate pool. */
  models?: string[];
  datasetPath?: string;
  /** Report dir. Default `<main-repo-root>/reports/security-triage-benchmark/`. */
  outputDir?: string;
  mainRoot?: string;
  /** Ignore the per-model-per-day cache and re-run every model. */
  force?: boolean;
  thresholds?: TriageThresholds;
  /** The current security_scan default to compare against. Default DEFAULT_MODEL. */
  incumbentModelId?: string;
  /** Cap the auto-discovered pool (cheapest-first). Default 16. */
  maxCandidates?: number;
  /**
   * Per-judge-call timeout in ms. Default 45_000 — a triage verdict on a tiny
   * snippet that takes longer than ~45s means an unusably slow model, and a
   * benchmark must not stall on hung connections (the judge's own default is
   * 600_000, tuned for large real scans, not this sweep).
   */
  perCallTimeoutMs?: number;
  /**
   * Validation retries per case. Default 0 — the benchmark measures the model
   * AS-IS in one shot (same philosophy as the keyword benchmark). Retrying a
   * timeout is pure waste, and a model that needs a second try to emit valid
   * JSON is fairly penalised for the strict-schema tool.
   */
  maxRetries?: number;
  /** Concurrent judge calls per model. Default 8. */
  workers?: number;
  /** Test seam — injected HTTP impl forwarded to the judge. */
  fetchImpl?: FetchImpl;
  onProgress?: (message: string) => void;
}

export interface SecurityTriageBenchmarkResult {
  recommendedModelId: string;
  changed: boolean;
  selection: SelectionResult;
  scores: TriageScore[];
  costUsd: number;
  jsonReportPath: string;
  mdReportPath: string;
  summaryLine: string;
}

// ── Cache (per-model-per-day, dataset-hash-keyed) ─────────────────────────

interface CacheEntry {
  date: string;
  datasetHash: string;
  score: TriageScore;
  costUsd: number;
  latencyMs: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  qualified: boolean;
  disqualifyReason?: string;
}
type CacheFile = Record<string, CacheEntry>;

function cachePath(): string {
  return join(getConfigDir(), "security-triage-results.json");
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

// ── Free-ensemble benchmark filter readers (TRDD-8b6b3646 Phase 2) ─────────
// The free-only ensemble drops models that have a RECORDED failing benchmark.
// These read the same per-model cache the benchmark run writes above, so once a
// (free, $0) benchmark run has populated it, the ensemble filter excludes the
// proven-weak free models. No LLM calls here — pure cache reads.

/**
 * Latest-wins extraction of proven-FAILING models from a benchmark cache (PURE,
 * testable). The cache key is `modelId::date::datasetHash`; for each model we
 * take the most-recent entry by date and flag it failed when the verdict is a
 * CONCLUSIVE non-pass (inconclusive runs — empty/errored — are NOT a failure, so
 * a flaky free model is never excluded on inconclusive evidence). Loosely typed
 * so tests can pass synthetic verdicts without importing CacheEntry.
 */
export function failedModelsFromCache(
  cache: Record<string, { date: string; score: { pass: boolean; inconclusive: boolean } }>,
): Set<string> {
  const latest = new Map<string, { date: string; pass: boolean; inconclusive: boolean }>();
  for (const [key, entry] of Object.entries(cache)) {
    const modelId = key.split("::")[0];
    if (!modelId) continue;
    const prev = latest.get(modelId);
    if (!prev || entry.date > prev.date) {
      latest.set(modelId, {
        date: entry.date,
        pass: entry.score.pass,
        inconclusive: entry.score.inconclusive,
      });
    }
  }
  const failed = new Set<string>();
  for (const [modelId, v] of latest) {
    if (!v.inconclusive && !v.pass) failed.add(modelId);
  }
  return failed;
}

/** Models with a recorded FAILING security-triage benchmark (reads the real cache). */
export function benchmarkFailedModels(): Set<string> {
  return failedModelsFromCache(loadCache());
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

export async function runSecurityTriageBenchmark(
  opts: SecurityTriageBenchmarkOptions = {},
): Promise<SecurityTriageBenchmarkResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const datasetPath = opts.datasetPath ?? resolveDatasetPath();
  const cases = loadDataset(datasetPath);
  const datasetHash = createHash("sha1").update(readFileSync(datasetPath, "utf-8")).digest("hex").slice(0, 12);
  const thresholds = opts.thresholds ?? DEFAULT_TRIAGE_THRESHOLDS;
  const incumbentId = opts.incumbentModelId ?? DEFAULT_MODEL;
  const progress = opts.onProgress ?? (() => {});
  const freeOnly = getActiveFreeOnly();

  progress(`Loaded ${cases.length} golden cases (dataset ${datasetHash}).`);

  // 1. Fetch the catalog once (full list — covers candidate discovery, incumbent
  //    lookup, and explicit-model pricing).
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

  // 3. Build the model list to ASSESS.
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
        const q = qualify(raw, SECURITY_TRIAGE_CRITERIA);
        addModel(q ?? decorate(raw), q !== null, q ? undefined : "below this tool's requirements (cost/context/structured-output)");
      } else {
        // Unknown to the catalog — assess with fallback pricing so the user
        // still sees a score, but it cannot qualify (no capability data).
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
    // Auto-discovery: qualified candidates, pre-filtered to NOT pricier than the
    // incumbent (the gate would reject pricier ones — don't spend budget on them).
    const { candidates } = buildBenchmarkRoster(catalog, SECURITY_TRIAGE_CRITERIA, []);
    const affordable = candidates.filter(
      (c) => c.inputDollarsPerMillion <= incumbentIn + 1e-9 && c.outputDollarsPerMillion <= incumbentOut + 1e-9,
    );
    // Quality-rank the affordable candidates (codex + design-arena code ELO)
    // before the top-N cap, so the paid set is the most-promising affordable
    // models, not merely the cheapest (TRDD-WJND1N2W P2).
    const sameOrCheaper = rankByQualityIndex(affordable).slice(0, opts.maxCandidates ?? 16);
    for (const c of sameOrCheaper) addModel(c, true);
  }

  // 4. ALWAYS assess the incumbent (so the report confirms it still passes and
  //    the gate has a fallback).
  if (!toAssess.has(incumbentId)) {
    if (incumbentDecorated) {
      const q = qualify(incumbentDecorated.raw, SECURITY_TRIAGE_CRITERIA);
      addModel(incumbentDecorated, q !== null, q ? undefined : "below this tool's requirements");
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
          supportsReasoning: false,
          raw: { id: incumbentId },
        },
        true,
      );
    }
  }

  // 4b. free_only PRE-condition (never a replacement for the send-time chokepoint).
  //     Under free_only, `judgeGroups` calls assertFreeOnlyModel and THROWS on any
  //     non-':free' id — and step 4 ALWAYS adds the paid incumbent (DEFAULT_MODEL).
  //     That is what killed the whole `--update-all --free` sweep here even though
  //     every CANDIDATE was ':free': the throw came from the incumbent's own
  //     baseline run, not from a candidate. Non-':free' models are therefore skipped
  //     per-model below (the pattern search-existing/scan-folder already use). If
  //     NOTHING ':free' remains, this benchmark genuinely cannot run under free mode
  //     — report that as a typed, expected skip rather than letting a paid id reach
  //     the guard, whose "please report it" wording is reserved for a real leak.
  if (freeOnly && ![...toAssess.keys()].some(isFreeSuffixModelId)) {
    throw new FreeModeSkipError(
      "security_scan",
      incumbentId,
      `security_scan requires non-free model '${incumbentId}' — no ':free' model is available to benchmark under free_only`,
    );
  }

  // Global price-cap fail-fast (explicit ids + incumbent; discovered already
  // dropped by filterModels). Refuses before any send, $0 spent.
  assertModelsUnderPriceCap([...toAssess.values()].map((v) => v.model));
  assertPaidBenchmarkAllowed([...toAssess.values()].map((v) => v.model));

  progress(`Assessing ${toAssess.size} model(s) over ${cases.length} cases…`);

  // 5. Run + score each model (sequential — avoids stacking rate-limit hits).
  const cache = loadCache();
  const assessments: CandidateAssessment[] = [];
  const scores: TriageScore[] = [];
  const freeOnlySkipped: string[] = [];
  let totalCost = 0;

  for (const { model, qualified, disqualifyReason } of toAssess.values()) {
    // free_only: never SEND a non-':free' model (the judge's assertFreeOnlyModel
    // would throw and abort the sweep, and OpenRouter would bill it). Record it as
    // a $0, UNBENCHMARKED entry so the report still accounts for it — it is
    // disqualified, so it can never become the free-mode default, and the incumbent
    // still serves as the cost baseline / fallback in the selection gate.
    if (freeOnly && !isFreeSuffixModelId(model.id)) {
      progress(`  ${model.id}: skipped (free_only — non-':free' model, not sent).`);
      freeOnlySkipped.push(model.id);
      const skippedScore = notBenchmarkedScore(
        model.id,
        cases.length,
        "not benchmarked: free_only is active and this is not a ':free' model",
      );
      scores.push(skippedScore);
      assessments.push({
        modelId: model.id,
        qualified: false,
        disqualifyReason: "free_only active — non-':free' model not benchmarked",
        inputDollarsPerMillion: model.inputDollarsPerMillion,
        outputDollarsPerMillion: model.outputDollarsPerMillion,
        latencyMs: 0,
        triage: skippedScore,
      });
      continue;
    }

    const key = cacheKey(model.id, today(), datasetHash);
    const cached = cache[key];
    let score: TriageScore;
    let costUsd: number;
    let latencyMs: number;

    if (cached && !opts.force) {
      progress(`  ${model.id}: cache hit (${today()}).`);
      score = cached.score;
      costUsd = cached.costUsd;
      latencyMs = cached.latencyMs;
    } else {
      progress(`  ${model.id}: running…`);
      const t0 = Date.now();
      // The IRON RULE gate lives inside `judgeGroups`, which this runner calls —
      // and a candidate is UNVALIDATED by definition until this very run scores
      // it. Without the exemption the benchmark refuses its own subject and no
      // paid model could ever become validated for security_scan. The run has
      // already cleared the two cost gates above (price cap + paid opt-in), so
      // this exempts the one caller that has paid the toll. try/finally: the flag
      // must not survive the call, however it ends.
      setBenchmarkValidationExempt(true);
      let run: Awaited<ReturnType<typeof runTriageBenchmarkOnModel>>;
      try {
        run = await runTriageBenchmarkOnModel(
          model.id,
          cases,
          {
            apiKey,
            pricing: pricingFromModel(model),
            perCallTimeoutMs: opts.perCallTimeoutMs ?? 45_000,
            maxRetries: opts.maxRetries ?? 0,
            workers: opts.workers,
          },
          opts.fetchImpl,
        );
      } finally {
        setBenchmarkValidationExempt(false);
      }
      const elapsed = Date.now() - t0;
      latencyMs = cases.length > 0 ? Math.round(elapsed / cases.length) : elapsed;
      score = scoreTriage(model.id, cases, run.verdicts, thresholds, run.failSafe);
      costUsd = run.costUsd;
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
      };
    }

    totalCost += costUsd;
    scores.push(score);
    assessments.push({
      modelId: model.id,
      qualified,
      disqualifyReason,
      inputDollarsPerMillion: model.inputDollarsPerMillion,
      outputDollarsPerMillion: model.outputDollarsPerMillion,
      latencyMs,
      triage: score,
    });
    progress(
      `    ${model.id}: ${score.inconclusive ? "INCONCLUSIVE" : score.pass ? "PASS" : "FAIL"} ` +
        `score=${score.score.toFixed(3)} scored=${score.scoredCount}/${score.total} errored=${score.erroredCount} ` +
        `under=${score.underFlagCount} over=${score.overFlagCount} critUF=${score.criticalUnderFlags}`,
    );
  }

  saveCache(cache);

  // 6. Selection gate.
  const selection = selectSecurityTriageModel({
    candidates: assessments,
    incumbentModelId: incumbentId,
    incumbentInputDollarsPerMillion: incumbentIn,
    incumbentOutputDollarsPerMillion: incumbentOut,
  });

  // 7. Write the report.
  const mainRoot = resolveMainRoot(opts.mainRoot);
  const reportDir = opts.outputDir ?? join(mainRoot, "reports", "security-triage-benchmark");
  mkdirSync(reportDir, { recursive: true });
  const stamp = reportStamp();
  const jsonReportPath = join(reportDir, `${stamp}-security-triage-benchmark.json`);
  const mdReportPath = join(reportDir, `${stamp}-security-triage-benchmark.md`);

  const jsonPayload = {
    timestamp: new Date().toISOString(),
    datasetPath,
    datasetHash,
    caseCount: cases.length,
    thresholds,
    incumbent: { modelId: incumbentId, inputDollarsPerMillion: incumbentIn, outputDollarsPerMillion: incumbentOut },
    freeOnly,
    // The models free_only refused to send (paid ids — typically the incumbent
    // itself). Recorded so a free-mode report never LOOKS like the incumbent was
    // re-scored when it was not.
    freeOnlySkipped,
    recommendedModelId: selection.recommendedModelId,
    changed: selection.changed,
    reason: selection.reason,
    costUsd: totalCost,
    assessments: assessments.map((a) => ({
      modelId: a.modelId,
      qualified: a.qualified,
      disqualifyReason: a.disqualifyReason,
      inputDollarsPerMillion: a.inputDollarsPerMillion,
      outputDollarsPerMillion: a.outputDollarsPerMillion,
      latencyMs: a.latencyMs,
      pass: a.triage.pass,
      inconclusive: a.triage.inconclusive,
      score: a.triage.score,
      scoredCount: a.triage.scoredCount,
      erroredCount: a.triage.erroredCount,
      correctRate: a.triage.correctRate,
      underFlagCount: a.triage.underFlagCount,
      overFlagCount: a.triage.overFlagCount,
      criticalUnderFlags: a.triage.criticalUnderFlags,
      failReasons: a.triage.failReasons,
    })),
    rejected: selection.rejected,
    perCase: Object.fromEntries(scores.map((s) => [s.modelId, s.perCase])),
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
    freeOnlySkipped,
  });
  const mtmp = `${mdReportPath}.tmp.${process.pid}`;
  writeFileSync(mtmp, md, "utf-8");
  renameSync(mtmp, mdReportPath);

  const summaryLine = selection.changed
    ? `RECOMMEND switch: ${incumbentId} -> ${selection.recommendedModelId} (best same-or-cheaper passer).`
    : `KEEP ${selection.recommendedModelId} (no eligible same-or-cheaper model scored higher).`;

  return {
    recommendedModelId: selection.recommendedModelId,
    changed: selection.changed,
    selection,
    scores,
    costUsd: totalCost,
    jsonReportPath,
    mdReportPath,
    summaryLine,
  };
}

// ── Pre-flight workload description (P4 spend-cap estimate) ────────────────

/**
 * Derive this benchmark's P4 pre-flight workload for ONE model (see
 * `BenchmarkWorkload`, workload-types.ts). Every field is DERIVED from the real
 * golden dataset on disk plus the REAL prompt-building functions the runner
 * actually calls (`buildSystemPrompt` / `buildUserMessage` / `preScanInjection`
 * from security_scan/prompt.ts) — never a hand-counted guess — so a corpus edit
 * or a prompt-wording change moves this estimate automatically. Makes NO
 * network call.
 *
 * callsPerModel — `casesToGroups()` (runner.ts) maps ONE dataset case to ONE
 * `DedupGroup` with a single member: no batching/dedup across cases in this
 * benchmark (unlike the real security_scan tool, which dedupes identical
 * findings before judging). So it is one judge call per case, and the
 * orchestrator's default `maxRetries: 0` for this run (see
 * `runSecurityTriageBenchmark` above) means exactly one attempt per case on
 * the planned path — a retry is a runtime contingency, not part of the
 * workload the estimate should count.
 *
 * promptCharsPerModel — for each case: the EXACT system prompt (category +
 * `BENCHMARK_RUBRICS[category]` + the REAL pre-scan injection markers for that
 * case's own snippet, built precisely as `judgeOneGroup` builds it) plus the
 * EXACT user message (the nonce-delimited snippet envelope), summed over
 * every case in the dataset.
 *
 * maxOutputTokensPerCall — judge.ts's `reqBody` (the actual wire request; see
 * `judgeOneGroup`) sets NO `max_tokens` / `max_completion_tokens` field at
 * all, so there is no real per-call literal to read verbatim. The run is not
 * unbounded, though: `budget.ts`'s `chargeRequest` — the ONE place spend is
 * actually reserved before a call goes out over the wire — already treats a
 * request body with no numeric `max_tokens` as `ASSUMED_MAX_OUTPUT_TOKENS`
 * (16,000). Reusing that SAME exported constant here, rather than inventing a
 * smaller schema-sized guess (the strict schema's `reason` field caps at 600
 * chars, so a well-behaved reply is a few hundred tokens), is deliberate: a
 * verbose/reasoning model that ignores that guidance is bounded, in practice,
 * by whatever the real chokepoint reserves for the call — 16,000. A smaller
 * number here would make this pre-flight estimate UNDER-price exactly the
 * case the chokepoint itself budgets for, which is the one failure mode a
 * spend-cap estimate must never produce.
 */
export function describeWorkload(): BenchmarkWorkload {
  const cases = loadDataset();
  // One nonce for the whole estimate. Its only role here is prompt length: the
  // envelope delimiters embed it, and every real call uses a nonce of the same
  // fixed length (16 hex chars — see prompt.ts's makeNonce), so this reproduces
  // the real per-call overhead exactly. No network call.
  const nonce = makeNonce();
  let promptCharsPerModel = 0;
  for (const c of cases) {
    const { markers } = preScanInjection(c.snippet);
    const systemPrompt = buildSystemPrompt({
      nonce,
      category: c.category,
      rubric: BENCHMARK_RUBRICS[c.category],
      language: c.language,
      injectionMarkers: markers,
    });
    const userMessage = buildUserMessage(nonce, c.snippet);
    promptCharsPerModel += systemPrompt.length + userMessage.length;
  }
  return {
    tool: "security_scan",
    benchmark: "security-triage",
    callsPerModel: cases.length,
    promptCharsPerModel,
    maxOutputTokensPerCall: ASSUMED_MAX_OUTPUT_TOKENS,
  };
}

// ── Markdown report ──────────────────────────────────────────────────────────

function buildReportMarkdown(args: {
  cases: readonly SecurityTriageCase[];
  datasetHash: string;
  incumbentId: string;
  incumbentIn: number;
  incumbentOut: number;
  thresholds: TriageThresholds;
  assessments: readonly CandidateAssessment[];
  selection: SelectionResult;
  totalCost: number;
  /** Paid ids free_only refused to send (empty unless free_only is active). */
  freeOnlySkipped: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push("# security_scan triage — model benchmark");
  lines.push("");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(`**Dataset:** ${args.cases.length} golden cases (hash ${args.datasetHash})`);
  lines.push(`**Incumbent default:** \`${args.incumbentId}\` (in $${args.incumbentIn.toFixed(3)}/M, out $${args.incumbentOut.toFixed(3)}/M)`);
  lines.push(`**Pass gate:** zero critical under-flags AND score ≥ ${args.thresholds.minScore.toFixed(2)}`);
  lines.push(`**Total LLM spend:** $${args.totalCost.toFixed(6)}`);
  if (args.freeOnlySkipped.length > 0) {
    lines.push(
      `**free_only active:** ${args.freeOnlySkipped.length} non-\`:free\` model(s) were NOT benchmarked ` +
        `(${args.freeOnlySkipped.map((id) => `\`${id}\``).join(", ")}) — free mode may not send a paid model. ` +
        `They appear below as unbenchmarked (score 0, INCONCLUSIVE), NOT as failures.`,
    );
  }
  lines.push("");
  lines.push(`## Recommendation`);
  lines.push("");
  lines.push(`**${args.selection.changed ? "SWITCH" : "KEEP"} → \`${args.selection.recommendedModelId}\`**`);
  lines.push("");
  lines.push(args.selection.reason);
  lines.push("");
  lines.push(`## Assessed models`);
  lines.push("");
  lines.push("| Model | Req | Bench | Score | Scored | Err | Correct | Under | Over | CritUF | in $/M | out $/M | lat ms |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const sorted = [...args.assessments].sort((a, b) => b.triage.score - a.triage.score);
  for (const a of sorted) {
    const bench = a.triage.inconclusive ? "INCONCLUSIVE" : a.triage.pass ? "PASS" : "FAIL";
    lines.push(
      `| \`${a.modelId}\` | ${a.qualified ? "ok" : "no"} | ${bench} | ` +
        `${a.triage.score.toFixed(3)} | ${a.triage.scoredCount}/${a.triage.total} | ${a.triage.erroredCount} | ` +
        `${(a.triage.correctRate * 100).toFixed(0)}% | ${a.triage.underFlagCount} | ` +
        `${a.triage.overFlagCount} | ${a.triage.criticalUnderFlags} | ${a.inputDollarsPerMillion.toFixed(3)} | ` +
        `${a.outputDollarsPerMillion.toFixed(3)} | ${a.latencyMs} |`,
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
    lines.push("| Case | Category | Expected | Returned | Result | Src |");
    lines.push("|---|---|---|---|---|---|");
    for (const p of rec.triage.perCase) {
      const result = p.errored
        ? "errored (excluded)"
        : p.correct
          ? "correct"
          : p.underFlag
            ? "UNDER-FLAG"
            : p.overFlag
              ? "over-flag"
              : "miss";
      lines.push(`| ${p.id} | ${p.category} | ${p.expected} | ${p.returned} | ${result} | ${p.source} |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    "Re-run: `llm-externalizer benchmark --security-triage` (auto-discover) or " +
      "`--security-triage --model <id>` (assess one). The recommended model is " +
      "surfaced for the operator to adopt via the security_scan `model` parameter.",
  );
  return lines.join("\n") + "\n";
}
