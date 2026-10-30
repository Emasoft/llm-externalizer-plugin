/**
 * calibration/memory-wait.ts — the one memory-wait mechanism of Phases B and C (P6; spec section 4.1 and 4.5).
 *
 * A step or candidate that fits total RAM minus the floor, but not the free memory now, makes the model wait (no
 * verdict). The wait is saved in the progress, with the bytes it needs, so it survives the runner's passes and the
 * runner can re-check it with the model unloaded (memoryWaitPrecheck). Only time a runner was checking counts
 * (memoryWaitTick). After MEMORY_WAIT_MAX_MS of checks the step is skipped for that pass only (inconclusive), and
 * after INCONCLUSIVE_PASSES such passes it is given up (rule A, coordinator decision 2026-10-29). Phase B and Phase C
 * each decide what a given-up step means for their own result; a busy machine never gives a failed step.
 *
 * This module imports neither phase: Phase C imports Phase B, so a helper shared by both lives here.
 */

import { timingsFromEnv } from "../broker/scheduler.js";
import type { BrokerEngine } from "../broker/protocol.js";
import { freeMemory } from "./memory.js";
import type { PhaseContext } from "./runner.js";
import { loadProgress, saveProgress, type MemoryWait } from "./state.js";

/** How long a step may wait for free memory before it is skipped for the pass (review of fb861fab). */
export const MEMORY_WAIT_MAX_MS = 30 * 60_000;
/** How long between two checks of a memory wait still counts as waiting (runner passes come about every minute). */
export const MEMORY_WAIT_GAP_MS = 5 * 60_000;
/**
 * Runner passes on which a step stayed inconclusive (a memory-wait skip; in Phase C also a timeout or transport skip)
 * before it is given up (rule A, coordinator decision 2026-10-29). Counted per pass, never by wall time.
 */
export const INCONCLUSIVE_PASSES = 3;
/** Why a step is pending after a memory wait, for the log and `calibration-status`. */
export const MEMORY_WAIT_CAUSE = `still short of free memory after ${MEMORY_WAIT_MAX_MS / 60_000} min`;
/** What a given-up memory-wait step means, in the words of a failure message, an unfit reason or a status line. */
export const MEMORY_WAIT_GIVEN_UP = `waited for free memory on ${INCONCLUSIVE_PASSES} passes`;

/** Whether a shape fits memory: "skip" over the hard budget (total RAM minus the floor), "wait" over the soft one (free now). */
export function budgetFit(needBytes: number, hardBudget: number, softBudget: number): "run" | "wait" | "skip" {
  if (needBytes > hardBudget) return "skip";
  if (needBytes > softBudget) return "wait";
  return "run";
}

/** A step fits the hard budget but not the free memory now: the model waits (no verdict, no pause counted). */
export class WaitForMemory extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A memory wait after a check at `nowMs` that still finds memory short (review of a3862052, MINOR-7): the time since
 * the last check is added only when it is at most MEMORY_WAIT_GAP_MS, so time with no runner checking (the runner off,
 * the machine asleep) does not use up the wait.
 */
export function memoryWaitTick(prev: MemoryWait | undefined, need: number, nowMs: number): MemoryWait {
  const at = new Date(nowMs).toISOString();
  if (prev === undefined) return { since: at, seen: at, waited_ms: 0, need };
  const gap = nowMs - Date.parse(prev.seen);
  return { since: prev.since, seen: at, waited_ms: prev.waited_ms + (gap >= 0 && gap <= MEMORY_WAIT_GAP_MS ? gap : 0), need };
}

/** Whether a step has waited long enough for free memory to be skipped for this pass. */
export function memoryWaitExpired(w: MemoryWait): boolean {
  return w.waited_ms >= MEMORY_WAIT_MAX_MS;
}

/**
 * Review of 2411e6dc, finding 2: before a runner pass loads the model, check its saved memory waits (Phase B or C)
 * with the model unloaded. Loading it at the Phase A context only for the phase to unload it again, about every
 * minute while requests are held, starved a machine already short of memory. Returns why the pass should not load
 * the model (every waiting step is still short and none has waited long enough), or null to load it: no wait, memory
 * is back for one of them, or a wait is over (the phase then records the skip). The check counts toward the wait like
 * a check in the phase.
 */
export async function memoryWaitPrecheck(dir: string, engine: BrokerEngine, model: string, harnessId: string): Promise<string | null> {
  const p = loadProgress(dir, engine, model, null, harnessId);
  const entries = Object.entries(p.memoryWait ?? {});
  if (entries.length === 0) return null;
  const { free, floor } = await freeMemory(timingsFromEnv(process.env).memoryFloorPct);
  if (entries.some(([, w]) => w.need <= free - floor)) return null;
  const nowMs = Date.now();
  const ticked = entries.map(([step, w]) => [step, memoryWaitTick(w, w.need, nowMs)] as const);
  if (ticked.some(([, w]) => memoryWaitExpired(w))) return null;
  p.memoryWait = Object.fromEntries(ticked);
  saveProgress(dir, engine, model, p);
  const mib = (x: number): number => Math.round(x / 2 ** 20);
  const [step, w] = ticked[0]!;
  return `${step} still waits for free memory (${mib(w.need)} MiB needed, ${mib(free - floor)} MiB free above the floor; ${Math.round(w.waited_ms / 60_000)} of ${MEMORY_WAIT_MAX_MS / 60_000} min counted)`;
}

/** The memory check of `step` found it fits (or never can): an earlier wait of it ends. */
export function memoryWaitClear(ctx: PhaseContext, step: string): void {
  const waits = ctx.progress.memoryWait;
  if (waits?.[step] === undefined) return;
  delete waits[step];
  ctx.save();
}

/**
 * The memory check of `step` found it fits total RAM minus the floor but not the free memory now (budgetFit "wait";
 * `need` is the bytes it needs above the floor, `free` and `floor` the reading). Under MEMORY_WAIT_MAX_MS of checks the
 * wait is saved and WaitForMemory is thrown: the phase returns paused, no verdict. Once the wait is over it ends, and
 * the skip for this pass is returned for recordInconclusiveSkip.
 */
export function memoryWaitCheck(ctx: PhaseContext, step: string, need: number, free: number, floor: number): { skipped: "memory-wait"; waited_min: number } {
  const waits = (ctx.progress.memoryWait ??= {});
  const wait = memoryWaitTick(waits[step], need, Date.now());
  const waited = Math.round(wait.waited_ms / 60_000);
  const mib = (x: number): number => Math.round(x / 2 ** 20);
  if (memoryWaitExpired(wait)) {
    delete waits[step];
    ctx.save();
    ctx.log(`${step}: skipped for this pass after waiting ${waited} min for free memory (${mib(need)} MiB needed, ${mib(free - floor)} MiB free above the floor)`);
    return { skipped: "memory-wait", waited_min: waited };
  }
  waits[step] = wait;
  ctx.save();
  throw new WaitForMemory(
    step,
    `${step} needs ${mib(need)} MiB; free memory now allows ${mib(free - floor)} MiB: the model waits for memory (waiting since ${wait.since}, ${waited} of ${MEMORY_WAIT_MAX_MS / 60_000} min counted; ${step} is skipped for this pass once ${MEMORY_WAIT_MAX_MS / 60_000} min of checks still find memory short)`,
  );
}

/**
 * Record an inconclusive skip of `step` (rule A): inconclusive until the INCONCLUSIVE_PASSES-th runner pass on which
 * the step stayed inconclusive, which makes it terminal (outcome pass, never fail: the step was not measured). Passes
 * are counted, never wall time: a sleeping machine uses up nothing, and a pass that paused on a wait still under
 * MEMORY_WAIT_MAX_MS records nothing. Only skip trials (a string `skipped`) count, so a step's own graded trials never do.
 */
export function recordInconclusiveSkip(ctx: PhaseContext, step: string, seed: number, data: Record<string, string | number>, cause: string): { passes: number; terminal: boolean } {
  const passes = ctx.progress.trials.filter((t) => t.step === step && t.outcome === "inconclusive" && typeof t.data?.skipped === "string").length + 1;
  const terminal = passes >= INCONCLUSIVE_PASSES;
  ctx.record({ step, seed, outcome: terminal ? "pass" : "inconclusive", data: { ...data, passes }, at: new Date().toISOString() });
  ctx.log(`${step}: ${cause}, pass ${passes} of ${INCONCLUSIVE_PASSES}: ${terminal ? "given up, not scored" : "measured again on the next pass"}`);
  return { passes, terminal };
}
