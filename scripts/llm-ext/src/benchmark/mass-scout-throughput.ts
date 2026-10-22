/**
 * mass_scout THROUGHPUT fitness benchmark (TRDD-HBCCFOUF part 1; addendum H).
 *
 * What addendum H demands and why: mass_scout fans out ONE completion per
 * file at DEFAULT_SCOUT_WORKERS (16) concurrent workers, so a free model that
 * is accurate but rate-limited at real concurrency is unfit no matter what
 * its accuracy benchmark says. The check is therefore a SUSTAINED REQUEST
 * BURST sized to the tool's real concurrency (16 in flight, 64 calls ≈ four
 * waves — not a handful of calls), recording every rate-limit (429) response.
 *
 * The probe is classifyPositional over the scout-accuracy fixture — the same
 * per-file completion shape mass_scout sends (structured-output JSON, one
 * record set per call), so the burst measures the tool's actual wire behavior,
 * not an ad-hoc ping. Positional accuracy is NOT the gate here (scout-accuracy
 * already scores that); the gate is THROUGHPUT: >= minSuccessRate of the
 * burst must complete without a rate-limit, and a burst with any hard error
 * (network/timeout/HTTP 5xx) over the error budget fails too. A 429-free but
 * inaccurate model stays fit for mass_scout by this benchmark; it is the
 * throughput fitness that is being measured.
 *
 * Testability: the HTTP send is the injected FetchImpl seam (A9a's rule —
 * never mock module internals; feed responses through the seam). Tests
 * simulate 429s / success mixes with zero network. Verdicts land in the
 * free-fitness ledger via recordFitnessVerdict under the DEFAULT-params hash.
 */

import {
  buildPositionalSchema,
  classifyPositional,
  generateFixture,
  type ScoutFixture,
} from "../mass_scouting/scout-accuracy-fixture.js";
import type { FetchImpl } from "../mass_scouting/scout.js";
import { runWithLimit } from "../mass_scouting/scout.js";
import {
  DEFAULT_THROUGHPUT_PARAMS,
  massScoutThroughputHash,
  recordFitnessVerdict,
  type ThroughputParams,
} from "./free-fitness-ledger.js";

export interface ThroughputCallOutcome {
  ok: boolean;
  /** The call completed and returned a well-formed completion. */
  completed: boolean;
  /** The provider rate-limited this call (HTTP 429). */
  rateLimited: boolean;
  error: string | null;
}

export interface ThroughputBenchmarkResult {
  modelId: string;
  pass: boolean;
  inconclusive: boolean;
  params: ThroughputParams;
  callsSent: number;
  completed: number;
  rateLimited: number;
  hardErrors: number;
  successRate: number;
  meanDurationMs: number;
  failureReasons: string[];
  summaryLine: string;
}

function classifyOutcome(res: Awaited<ReturnType<typeof classifyPositional>>): ThroughputCallOutcome {
  if (res.error === null) {
    return { ok: true, completed: true, rateLimited: false, error: null };
  }
  // classifyPositional collapses every HTTP failure into "HTTP <status>: …"
  // (scout-accuracy-fixture.ts) — parse the status back out rather than
  // duplicating its request path here.
  const m = /^HTTP (\d{3}):/.exec(res.error);
  const status = m === null ? 0 : Number(m[1]);
  if (status === 429) {
    return { ok: false, completed: false, rateLimited: true, error: res.error };
  }
  return { ok: false, completed: false, rateLimited: false, error: res.error };
}

/**
 * Run the sustained burst against ONE model and return the measured outcome.
 * No ledger write here — runMassScoutThroughputBenchmark owns the verdict;
 * this function is the raw measurement so tests can assert on the counts.
 */
async function measureThroughputBurst(
  modelId: string,
  apiKey: string,
  opts: {
    params?: ThroughputParams;
    fixtureSeed?: number;
    fixtureTargetBytes?: number;
    fetchImpl?: FetchImpl;
    /** Per-call timeout forwarded to classifyPositional. Default 90_000. */
    perCallTimeoutMs?: number;
  } = {},
): Promise<{ result: ThroughputBenchmarkResult; fixture: ScoutFixture }> {
  const params = opts.params ?? DEFAULT_THROUGHPUT_PARAMS;
  const fixture = generateFixture(opts.fixtureSeed ?? 1, opts.fixtureTargetBytes ?? 4_096);
  const schema = buildPositionalSchema(fixture.recordCount);

  let completed = 0;
  let rateLimited = 0;
  let hardErrors = 0;
  let durationTotalMs = 0;
  const failureReasons: string[] = [];

  const calls = Array.from({ length: params.calls }, (_, i) => i);
  await runWithLimit(calls, params.workers, async () => {
    const res = await classifyPositional(modelId, "https://openrouter.ai/api", apiKey, fixture, schema, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.perCallTimeoutMs,
    });
    const outcome = classifyOutcome(res);
    if (outcome.completed) {
      completed++;
    } else if (outcome.rateLimited) {
      rateLimited++;
      if (failureReasons.length < 5) failureReasons.push(`call rate-limited: ${res.error}`);
    } else {
      hardErrors++;
      if (failureReasons.length < 5) failureReasons.push(res.error ?? "unknown error");
    }
    durationTotalMs += res.durationMs;
  });

  const successRate = params.calls === 0 ? 0 : completed / params.calls;
  // The gate is the same for a seamed (test) run and a real one — the seam only
  // replaces the wire, never the verdict. Every call lands in exactly one of
  // completed / rate-limited / hard-error, so the burst always yields a
  // CONCLUSIVE verdict: a 429-flood is a proven-unfit model, not a mystery.
  const pass = successRate >= params.minSuccessRate && hardErrors === 0;
  return {
    result: {
      modelId,
      pass,
      inconclusive: false,
      params,
      callsSent: params.calls,
      completed,
      rateLimited,
      hardErrors,
      successRate,
      meanDurationMs: params.calls === 0 ? 0 : durationTotalMs / params.calls,
      failureReasons,
      summaryLine:
        `throughput ${completed}/${params.calls} completed ` +
        `(${rateLimited} x 429, ${hardErrors} hard errors) at ${params.workers} workers — ` +
        `${(successRate * 100).toFixed(1)}% vs ${(params.minSuccessRate * 100).toFixed(0)}% bar`,
    },
    fixture,
  };
}

/**
 * The single callable behind the throughput fitness benchmark: run the burst,
 * record the verdict in the free-fitness ledger under the CURRENT
 * (default-params) hash, return the measured result. The DEFAULT hash is
 * recorded regardless of what params the caller tuned — a tuned run measures
 * under its own hash AND records the default-hash verdict only when it ran
 * with the default params, so a tuned probe can never unlock production.
 */
export async function runMassScoutThroughputBenchmark(
  modelId: string,
  apiKey: string,
  opts: {
    params?: ThroughputParams;
    fixtureSeed?: number;
    fixtureTargetBytes?: number;
    fetchImpl?: FetchImpl;
    perCallTimeoutMs?: number;
    force?: boolean;
    onProgress?: (message: string) => void;
  } = {},
): Promise<ThroughputBenchmarkResult> {
  const progress = opts.onProgress ?? ((): void => {});
  const hash = massScoutThroughputHash(DEFAULT_THROUGHPUT_PARAMS);
  const runHash = massScoutThroughputHash(opts.params ?? DEFAULT_THROUGHPUT_PARAMS);
  const isDefaultRun = runHash === hash;

  const { result } = await measureThroughputBurst(modelId, apiKey, opts);
  progress(result.summaryLine);

  // Record only a run at the DEFAULT policy — a differently-tuned burst is a
  // different benchmark and its verdict must not stand in for this one's.
  if (isDefaultRun) {
    recordFitnessVerdict(
      "mass_scout",
      modelId,
      hash,
      { pass: result.pass, inconclusive: result.inconclusive },
      result.summaryLine,
    );
  } else {
    progress("non-default params — verdict measured but NOT recorded (would not match the unlock hash)");
  }
  return result;
}
