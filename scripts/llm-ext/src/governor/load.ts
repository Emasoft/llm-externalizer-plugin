/**
 * governor/load.ts — what a model load needs beside its lease
 * (design/specs/local-inference-governor-design.md D11): the RAM projection
 * from a calibration record, and the watchdog that stops a load whose
 * projection was wrong before it takes the machine past its RAM limit.
 */

import { totalmem } from "node:os";
import { WINDOW_HEADROOM_BYTES } from "../calibration/memory.js";
import { neverFits, ramLimitBytes } from "./controller.js";
import { readMemory } from "./metrics.js";
import type { LoadEstimate } from "./estimate.js";
import type { GovernorLimits } from "./state.js";

/** How often a loading process reads RAM: one vm_stat a second, and one load at a time machine-wide (D7, D11). */
export const WATCH_INTERVAL_MS = 1_000;
/** A server the governor asked to unload may not load again for this long: it rate-limits an unload and reload flapping (D11). */
export const RELOAD_AFTER_UNLOAD_MS = 60_000;

/** RELOAD_AFTER_UNLOAD_MS, or LLM_EXT_GOVERNOR_RELOAD_AFTER_UNLOAD_MS for a test; malformed is an error, never ignored. */
export function reloadAfterUnloadMs(env: NodeJS.ProcessEnv): number {
  const raw = env.LLM_EXT_GOVERNOR_RELOAD_AFTER_UNLOAD_MS;
  if (raw === undefined || raw === "") return RELOAD_AFTER_UNLOAD_MS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`LLM_EXT_GOVERNOR_RELOAD_AFTER_UNLOAD_MS must be a positive integer, got '${raw}'`);
  return Number(raw);
}
/** The prompt cache Locals may keep at most (D11): its default is everything the GPU has left. */
export const LOCALS_CACHE_MAX_GB = 4;
/** How long a load lease lives before the leak backstop reclaims it: a first download of a big model has no job timeout to borrow (D3). */
export const LOAD_LEASE_MS = 3_600_000;

const GIB = 1024 ** 3;

/**
 * The watchdog stopped a load at the RAM limit ("breach"), or there was no room to start it ("no-cache-room"). Not a
 * model error: the model waits. `observedBytes` is the growth the watchdog saw (the whole machine's, so not
 * attributable to the load; 0 for no-cache-room). `needBytes` is what free memory must show before the next pass
 * loads it: for a breach, the lower bound learned from the growth (learnedLowerBound), which the next load also
 * carries and runs alone with; for no-cache-room, the rest of the load plus the smallest prompt cache, a wait only,
 * never a lesson about the model's size (round 5 m4). The calibration runner saves it as the model's memory wait
 * (memory-wait.ts, round 4 #6).
 */
export class LoadBreachError extends Error {
  constructor(
    readonly reason: "breach" | "no-cache-room",
    readonly observedBytes: number,
    readonly needBytes: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The lower bound a breach teaches (round 4 #1): at least what the watchdog saw grow, plus the headroom, never below
 * the bound the load already had. Only the LOWER bound moves: the growth cannot be attributed to the load (other
 * programs grow too), so raising it to the upper projection would turn one spurious breach into a false never-fits.
 * The broker also marks the model alone and fails it at its BREACHES_TO_FAIL-th breach, which bounds the retries.
 */
export function learnedLowerBound(minBytes: number, observedBytes: number): number {
  return Math.max(minBytes, observedBytes + WINDOW_HEADROOM_BYTES);
}

/** What a load of one server is planned on (D11): its bounds, the alone mark, and the figures it was projected from. */
export interface LoadPlan {
  bytes: number;
  minBytes: number;
  weightBytes: number;
  alone: boolean;
  /** The estimate the bounds came from, null when unknown before the load (round 5 M1: read again at ready). */
  est: LoadEstimate | null;
  /** KV tokens the server is started with (ctx x slots). */
  tokens: number;
}
/** Breaches of one model, in a row, after which the broker fails its jobs: retries are bounded, never endless (round 4 #1). */
export const BREACHES_TO_FAIL = 3;

/** What breaches of one model taught the broker since its last good load (round 4 #1). */
export interface Learned {
  minBytes: number;
  breaches: number;
}

/**
 * The broker's bookkeeping after one more breach of a model (round 4 #1): the lower bound (learnedLowerBound over the
 * larger of the plan's and the earlier learned one) and the count; a model with an entry loads only alone, and the
 * upper bound is never touched. `fail` at the BREACHES_TO_FAIL-th in a row: its jobs fail, but the bound and the
 * alone mark stay and only the count restarts (round 5 m5), so the next batch does not repeat three aborted loads.
 */
export function afterBreach(prev: Learned | undefined, planMinBytes: number, observedBytes: number): { learned: Learned; fail: boolean } {
  const breaches = (prev?.breaches ?? 0) + 1;
  const fail = breaches >= BREACHES_TO_FAIL;
  return { learned: { minBytes: learnedLowerBound(Math.max(planMinBytes, prev?.minBytes ?? 0), observedBytes), breaches: fail ? 0 : breaches }, fail };
}

/**
 * The RAM figures of one server load (round 4 #2, #3), shared by the broker's main server and the calibration runner's
 * cal server:
 * - `unbounded`: the load is admitted only alone and sized by its lower bound (marked alone after a breach, upper bound
 *   unknown, or the upper bound could never fit);
 * - `bookedBytes`: what the governor's books add for it, which the reading cannot see: a Locals server's projection
 *   (the lower bound when unbounded); 0 for llama, whose weights the reading has as wired pages;
 * - `residentBytes`: what stopping it gives back for sure, the most a swap or an unload may subtract: a Locals server's
 *   booking (exactly what the books add), a llama server's weight bytes (its measured wired rise is weights + 0.2 to
 *   0.4 GiB), 0 when unknown;
 * - `cacheRestBytes`: the load without Locals' prompt cache, which localsCacheGb leaves room for: the lower bound when
 *   unbounded (the upper one minus a 4 GiB cache would size an alone load by a figure the grant never judged).
 */
export function loadFigures(engine: "llama" | "locals", plan: { bytes: number; minBytes: number; weightBytes: number; alone: boolean }, limits: GovernorLimits, total = totalmem()): { unbounded: boolean; bookedBytes: number; residentBytes: number; cacheRestBytes: number } {
  const unbounded = plan.alone || plan.bytes === 0 || neverFits(plan.bytes, limits, total);
  const projection = unbounded ? plan.minBytes : plan.bytes;
  const bookedBytes = engine === "locals" ? projection : 0;
  return {
    unbounded,
    bookedBytes,
    residentBytes: engine === "locals" ? bookedBytes : plan.weightBytes,
    // Round 5 M2(a): a Locals lower bound includes the smallest prompt cache (LOCALS_CACHE_MIN_GB), so an alone grant
    // judged on it leaves that room; the rest is the lower bound without it.
    cacheRestBytes: unbounded ? Math.max(0, plan.minBytes - (engine === "locals" ? LOCALS_CACHE_MIN_GB * GIB : 0)) : Math.max(0, plan.bytes - LOCALS_CACHE_MAX_GB * GIB),
  };
}

/**
 * What the books hold for a Locals server once it is ready (round 5 M1): the most of the projection it was granted
 * on, weights + KV for its tokens + the --cache-gb it was actually given + WINDOW_HEADROOM_BYTES, and the growth the
 * watchdog saw by ready. An alone or unknown-size load was granted on its lower bound (or 0), so booking only that
 * would leave an idle MLX server, whose wired pages drop to 0, invisible to the reading and the books alike. `est`
 * is the record's or, read again at ready, the weight files' (they exist once the server loaded them); with no
 * estimate the server is not booked at all but is an error, never a silent 0.
 */
export function readyBooking(grantedBytes: number, est: LoadEstimate | null, tokens: number, cacheGb: number, growthBytes: number): number {
  if (est === null) throw new Error("no RAM figures for a Locals server that reached ready (its weight files cannot be read): it would be booked at 0");
  return Math.max(grantedBytes, est.weight_bytes + est.kv_bytes_per_token * tokens + cacheGb * GIB + WINDOW_HEADROOM_BYTES, growthBytes);
}

/**
 * Why the broker holds back a swap to `key` now, or null (round 5 M2(b)): a server of it stopped to give RAM back
 * waits RELOAD_AFTER_UNLOAD_MS before it may load again, and a swap that found no room for the Locals prompt cache
 * waits until `cacheWaitUntil` (one settle interval). Meanwhile the loaded server keeps serving its own queue,
 * instead of sitting idle while the swap is retried every tick.
 */
export function swapHeld(now: number, unloadedAt: number | undefined, reloadMs: number, cacheWaitUntil: number | undefined): "reload-pause" | "cache-room" | null {
  if (unloadedAt !== undefined && now - unloadedAt < reloadMs) return "reload-pause";
  if (cacheWaitUntil !== undefined && now < cacheWaitUntil) return "cache-room";
  return null;
}

/** The never-fits message: a model error naming the figures (D6). */
export function neverFitsMessage(model: string, bytes: number, limits: GovernorLimits, total = totalmem()): string {
  const mib = (x: number): number => Math.round(x / 2 ** 20);
  return `model '${model}' needs about ${mib(bytes)} MiB of RAM to load, more than the ${mib(ramLimitBytes(limits, total))} MiB that ram_limit_pct ${limits.ramLimitPct}% allows of this machine's ${mib(total)} MiB, even with nothing else running`;
}

/**
 * The smallest --cache-gb llm-ext passes. Round 2 #5, read in the installed
 * Locals (locals/service.py: `cache_bytes = int(cache_gb * (1 << 30)) if
 * cache_gb else None`): the value is GiB, 3.7 bounds the cache at 3.7 GiB, and
 * 0 is falsy, so it means no bound at all, Locals' default of all the GPU
 * memory left after the weights and 4 GB. 0.1 is the smallest tenth that is a
 * bound; with less room than that the load waits.
 */
export const LOCALS_CACHE_MIN_GB = 0.1;

/**
 * Locals' --cache-gb: min(4, the room under the limit beside the rest of the
 * load), in tenths of a GiB (D11). Null when the room is under
 * LOCALS_CACHE_MIN_GB: the caller must wait, never pass 0, which unbounds it.
 */
export function localsCacheGb(ramUsedBytes: number, otherBytes: number, limits: GovernorLimits, total = totalmem()): number | null {
  const room = (ramLimitBytes(limits, total) - ramUsedBytes - otherBytes) / GIB;
  const gb = Math.min(LOCALS_CACHE_MAX_GB, Math.floor(room * 10) / 10);
  return gb < LOCALS_CACHE_MIN_GB ? null : gb;
}

export interface LoadWatch {
  /** RAM used when the watch started, bytes. */
  baselineBytes: number;
  /** Stop watching; the growth seen so far, bytes. */
  stop(): number;
}

/** Failed readings in a row after which the watchdog stops the load: it can no longer see the RAM (round 2 #3). */
export const WATCH_FAILURES_TO_STOP = 3;

/**
 * Watch a load from its grant to its ready (D11). Every second the owner reads
 * RAM; at or above `limits.ramLimitPct` it calls `onBreach` once with the
 * growth since the start, and the caller stops its own server. So a wrong
 * projection costs one aborted load, not a breach that goes on growing.
 * The reading is the governor's own (metrics.ts), one definition of used RAM.
 * WATCH_FAILURES_TO_STOP failed readings in a row also stop it, with the error
 * as `failure`: a load nobody can see is not left to grow (fail fast).
 */
export async function watchLoad(
  limits: GovernorLimits,
  onBreach: (observedBytes: number, failure: Error | null) => void,
  intervalMs = WATCH_INTERVAL_MS,
  read: () => Promise<{ usedPct: number }> = readMemory,
): Promise<LoadWatch> {
  const total = totalmem();
  const bytesOf = (r: { usedPct: number }): number => (r.usedPct / 100) * total;
  const baselineBytes = bytesOf(await read());
  let peak = baselineBytes;
  let stopped = false;
  let reading = false;
  let failed = 0;
  const fire = (failure: Error | null): void => {
    stopped = true;
    clearInterval(timer);
    onBreach(Math.max(0, peak - baselineBytes), failure);
  };
  const timer = setInterval(() => {
    // One reading at a time: a vm_stat that is slow on a busy machine must not pile up behind the next tick.
    if (stopped || reading) return;
    reading = true;
    read()
      .then((r) => {
        if (stopped) return;
        failed = 0;
        peak = Math.max(peak, bytesOf(r));
        if (r.usedPct >= limits.ramLimitPct) fire(null);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        // One failure is one missed tick, as for the governor's own sampler; three in a row stop the load.
        failed++;
        if (failed >= WATCH_FAILURES_TO_STOP) fire(new Error(`the RAM reading failed ${failed} times in a row while a model loaded: ${(err as Error).message}`));
      })
      .finally(() => {
        reading = false;
      });
  }, intervalMs);
  // The load itself keeps its owner alive; this timer must not, after a caller that forgot stop().
  timer.unref();
  return {
    baselineBytes,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      return Math.max(0, peak - baselineBytes);
    },
  };
}
