/**
 * Sequential benchmark of LOCAL (and other non-billable) models — D7a.
 *
 * USER spec 2026-09-18 point 3.2: "local profile will detect and test all local
 * models in sequence benchmarking each one, one at time, to create the priority
 * order of fallback and to exclude models unable to comply with the commands. it
 * also uses other attributes to define the ranking (context size, tok/sec, etc.)".
 *
 * WHAT IS REUSED from the OpenRouter keyword sweep (runKeywordSweep in index.ts),
 * and what deliberately is not:
 *   reused  runBenchmarkOnModel (runner.ts: same prompt, same strict JSON schema,
 *           same parsing), scoreRun (score.ts: the exact-match pass) and the pass
 *           predicate of validated.ts isGeneralKeywordPass — the rank-0 check that
 *           validates a model for every tool without a dedicated benchmark. The
 *           caller hands in the sweep's own GroundTruth.
 *   NOT     the catalog fetch, roster, price cap, paid opt-in, budgeted fetch /
 *           spend ledger, report + JSON sidecar, recordGeneralKeywordPasses.
 * Nothing here writes a validation ledger: those are keyed by BARE model id and
 * gate PAID OpenRouter sends, so a local id that equals an OpenRouter id would
 * count as validated there. Results are RETURNED only. The one file write is the
 * $0.000000 history.log line that every LLM web request gets.
 *
 * Not wired in yet: calling this from the local profile's populate/build path is
 * D7b.
 */

import { API_PRESETS, isLocalUrl, overridesEndpoint } from "../config.js";
import { recordRequest } from "../usage-history.js";
import type { GroundTruth } from "./ground-truth.js";
import { chatCompletionsUrl, runBenchmarkOnModel, type RunResult } from "./runner.js";
import { scoreRun } from "./score.js";

/** One model on one server, as local_discovery/scan.ts reports it. */
export interface LocalModelPair {
  /** API root WITHOUT `/v1` — DiscoveredService.baseUrl, e.g. `http://localhost:1234`. */
  baseUrl: string;
  model: string;
  /** DiscoveredModel.contextLength, when the server advertised one. */
  contextLength?: number;
}

export interface LocalBenchDeps {
  /** The keyword sweep's ground truth: buildGroundTruth(<fixtures dir>, BENCHMARK_KEYWORDS). */
  truth: GroundTruth;
  /** Timeout of the untimed warm-up request. Default WARMUP_TIMEOUT_MS. */
  warmupTimeoutMs?: number;
  /** Timeout of the timed benchmark request. Default: the runner's (10 min). */
  timeoutMs?: number;
}

export interface LocalBenchResult {
  baseUrl: string;
  model: string;
  pass: boolean;
  /** meanF1 (0..1) of the timed answer; absent when no parseable answer came back. */
  score?: number;
  /** Generation speed in tokens/s; null when no timed answer came back. */
  tokPerSec: number | null;
  /** How tokPerSec was measured. Server timings and wall clock are not the same quantity. */
  tokPerSecBasis?: string;
  contextLength: number | null;
  failReason?: string;
}

/**
 * Generous on purpose: the warm-up is a model's FIRST request, and a local server
 * (Ollama, LM Studio JIT) loads the weights from disk on it — minutes for a big
 * model on a slow disk. Timing the benchmark only AFTER it keeps disk speed out of
 * tok/s.
 */
const WARMUP_TIMEOUT_MS = 900_000;

/**
 * May this sequential benchmark send to `baseUrl`? True for a local/private
 * address, or for a free-by-nature provider (API_PRESETS isFreeProvider) whose
 * endpoint the URL does not redirect. That is config.ts billableForRoute's rule
 * (`!isLocal && !isFreeProvider`) evaluated on a bare URL, built from the same
 * two deciders resolveRoutes/resolveProfile use (isLocalUrl, overridesEndpoint).
 */
export function isNonBillableEndpoint(baseUrl: string): boolean {
  if (isLocalUrl(baseUrl)) return true;
  // overridesEndpoint("") answers false ("no url = the preset's own"), so an empty
  // string has to be ruled out here or it would pass as the free provider.
  return (
    baseUrl !== "" &&
    Object.values(API_PRESETS).some((preset) => preset.isFreeProvider === true && !overridesEndpoint(baseUrl, preset))
  );
}

/**
 * Benchmark every pair, STRICTLY one request in flight at a time — between models
 * AND inside one model (warm-up, then the timed run). A local box serves models
 * from one pool of RAM/VRAM: two concurrent requests would skew tok/s and can make
 * the server load two models at once. Requests go out in `pairs` order.
 *
 * Throws, before sending anything, when any pair's endpoint could bill: the
 * paid-spend guards (price cap, paid opt-in, spend ledger) are keyed to the
 * OpenRouter catalog and are not on this path. Any other failure fails that ONE
 * model (pass: false + failReason) and the list continues.
 */
export async function benchmarkModelsSequentially(
  pairs: readonly LocalModelPair[],
  deps: LocalBenchDeps,
): Promise<LocalBenchResult[]> {
  const billable = [...new Set(pairs.map((p) => p.baseUrl).filter((url) => !isNonBillableEndpoint(url)))];
  if (billable.length > 0) {
    throw new Error(
      `local benchmark refused: billable endpoint(s) ${billable.join(", ")} — only a local/private address or a ` +
        `free provider (API_PRESETS isFreeProvider) may be benchmarked here. Nothing was sent.`,
    );
  }
  const results: LocalBenchResult[] = [];
  for (const pair of pairs) results.push(await benchmarkOne(pair, deps));
  return results;
}

async function benchmarkOne(pair: LocalModelPair, deps: LocalBenchDeps): Promise<LocalBenchResult> {
  const base = { baseUrl: pair.baseUrl, model: pair.model, contextLength: pair.contextLength ?? null };
  const warmupError = await warmUp(pair, deps.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
  if (warmupError !== null) return { ...base, pass: false, tokPerSec: null, failReason: warmupError };

  const run = await runBenchmarkOnModel(
    // Zero prices + freeOnly:false: the runner's free_only gate reads OpenRouter
    // catalog prices, which mean nothing for a local id. Billability was decided
    // for the endpoint in benchmarkModelsSequentially, before any request.
    { id: pair.model, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 },
    deps.truth.keywords,
    deps.truth.fixtures,
    { baseUrl: pair.baseUrl, freeOnly: false, timeoutMs: deps.timeoutMs },
  );
  if (!run.ok) return { ...base, pass: false, tokPerSec: null, failReason: run.error };

  const score = scoreRun(run, deps.truth);
  const { tokPerSec, basis } = measureTokPerSec(run);
  // validated.ts:101 isGeneralKeywordPass is `ok && pass && schemaCompliant !== false`
  // — "able to comply with the commands". Mirrored, not imported: it is not
  // exported and validated.ts is outside D7a's write scope (see the D7a report).
  const pass = score.pass && run.schemaCompliant;
  const failReason = pass
    ? undefined
    : !score.pass
      ? `answered wrongly (meanF1 ${(score.meanF1 * 100).toFixed(1)}%)`
      : "ignored the response JSON schema (answered under kw1/kw2/kw3, not kw1_functions/…)";
  return { ...base, pass, score: score.meanF1, tokPerSec, tokPerSecBasis: basis, ...(failReason ? { failReason } : {}) };
}

/**
 * One untimed request that makes the server load the model (max_tokens: 1).
 * Returns null on success, else the reason the model fails — an unreachable
 * endpoint or an unknown model stops HERE, without the timed run.
 */
async function warmUp(pair: LocalModelPair, timeoutMs: number): Promise<string | null> {
  const t0 = performance.now();
  let ok = false;
  try {
    const resp = await fetch(chatCompletionsUrl(pair.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: pair.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read the body to the end: the warm-up must be COMPLETELY over before the
    // timed request starts, or the two would overlap on the server.
    const text = await resp.text();
    ok = resp.ok;
    return ok ? null : `warm-up HTTP ${resp.status}: ${text.slice(0, 200)}`;
  } catch (err) {
    return `warm-up network error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    // history.log holds one line per LLM web request (usage-history.ts); $0 here.
    recordRequest({ ok, durationMs: performance.now() - t0, costUsd: 0 });
  }
}

/**
 * tok/s of the timed answer, best source first:
 *   1. server timings (llama.cpp `timings.predicted_n / predicted_ms`): generation
 *      only, prompt processing excluded — the real decode speed;
 *   2. usage.completion_tokens / wall-clock latency (Ollama, LM Studio, vLLM report
 *      no timings): includes prompt processing, so it is a LOWER bound;
 *   3. no usage either: content length / 4 (≈ chars per token) / wall clock — an
 *      estimate, and said so.
 */
function measureTokPerSec(run: RunResult): { tokPerSec: number; basis: string } {
  const body = JSON.parse(run.rawResponse) as {
    timings?: { predicted_n?: unknown; predicted_ms?: unknown };
    choices?: Array<{ message?: { content?: string } }>;
  };
  const n = body.timings?.predicted_n;
  const ms = body.timings?.predicted_ms;
  if (typeof n === "number" && typeof ms === "number" && n > 0 && ms > 0) {
    return { tokPerSec: n / (ms / 1000), basis: "server timings: predicted_n / predicted_ms (generation only)" };
  }
  const seconds = run.latencyMs / 1000;
  if (run.outputTokens > 0) {
    return {
      tokPerSec: run.outputTokens / seconds,
      basis: "usage.completion_tokens / wall-clock latency (includes prompt processing: a lower bound)",
    };
  }
  const chars = body.choices?.[0]?.message?.content?.length ?? 0;
  return { tokPerSec: chars / 4 / seconds, basis: "estimate: content chars / 4 / wall-clock latency (no usage reported)" };
}

/**
 * The fallback priority order. `excluded` = every fail, in input order. `ranked`
 * = the passers, sorted (stable) by this exact comparator:
 *   1. pass            — implied: every fail is already excluded;
 *   2. score desc      — the benchmark meanF1 (missing counts as 0);
 *   3. contextLength desc (unknown counts as 0);
 *   4. tokPerSec desc  (unknown counts as 0);
 *   ties keep input order (the discovery/probe order).
 * Today a pass REQUIRES an exact match, so every passer's score is exactly 1 and
 * key 2 never separates two passers; it is kept so a graded check can slot in.
 * tok/s bases differ by server (see measureTokPerSec), so key 4 compares like with
 * like only between servers of one kind.
 */
export function rankLocalModels(results: readonly LocalBenchResult[]): {
  ranked: LocalBenchResult[];
  excluded: LocalBenchResult[];
} {
  const excluded = results.filter((r) => !r.pass);
  const ranked = results
    .filter((r) => r.pass)
    .sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        (b.contextLength ?? 0) - (a.contextLength ?? 0) ||
        (b.tokPerSec ?? 0) - (a.tokPerSec ?? 0),
    );
  return { ranked, excluded };
}
