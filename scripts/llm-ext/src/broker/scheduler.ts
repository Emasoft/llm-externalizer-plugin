/**
 * broker/scheduler.ts — the per-engine broker's queueing and rotation rules
 * (TRDD-1OOAH3LD, TRDD-ZGSGGHQG; design/specs/local-engine-broker-design.md
 * points 3, 4 and 6). Pure: no I/O, no timers, the clock is a parameter, so
 * every rule is testable with tiny values.
 */

/** The broker's tunables. Provisional defaults from the spec; every one is overridable through the environment the broker is started with (tests shorten them). */
export interface BrokerTimings {
  /** B: rotate after the current model served this many requests (spec 6, provisional 32). */
  batch: number;
  /** D: ...or after this long on the current model (spec 6, provisional 180 s). */
  maxRunMs: number;
  /** T: the default queue timeout, the longest a queued job waits before its model is forced onto the server (USER ruling 2026-10-28: 5 min, not the spec's provisional 15 min). A job may carry its own (--queue_timeout). */
  starveMs: number;
  /** A job not polled for this long is abandoned and never dispatched (spec 4, 120 s). */
  abandonMs: number;
  /** Longest single long-poll (spec 4, 60 s: every HTTP exchange stays far below undici's 300 s headers timeout). */
  pollWaitMs: number;
  /** No request for this long: the broker stops its server (spec 10, 2 h). */
  idleServerMs: number;
  /** No server and no request for this long: the broker exits (spec 10, 2 h). */
  idleExitMs: number;
}

export const DEFAULT_TIMINGS: BrokerTimings = {
  batch: 32,
  maxRunMs: 180_000,
  starveMs: 300_000,
  abandonMs: 120_000,
  pollWaitMs: 60_000,
  idleServerMs: 2 * 3_600_000,
  idleExitMs: 2 * 3_600_000,
};

/** Environment names of the overrides, one per field (LLM_EXT_ prefix, like every llm-ext variable). */
export const TIMING_ENV: Record<keyof BrokerTimings, string> = {
  batch: "LLM_EXT_BROKER_BATCH",
  maxRunMs: "LLM_EXT_BROKER_MAX_RUN_MS",
  starveMs: "LLM_EXT_BROKER_STARVE_MS",
  abandonMs: "LLM_EXT_BROKER_ABANDON_MS",
  pollWaitMs: "LLM_EXT_BROKER_POLL_WAIT_MS",
  idleServerMs: "LLM_EXT_BROKER_IDLE_SERVER_MS",
  idleExitMs: "LLM_EXT_BROKER_IDLE_EXIT_MS",
};

/** The defaults with every valid positive integer override applied; a malformed value is an error, never silently ignored (fail fast). */
export function timingsFromEnv(env: NodeJS.ProcessEnv): BrokerTimings {
  const out = { ...DEFAULT_TIMINGS };
  for (const key of Object.keys(TIMING_ENV) as Array<keyof BrokerTimings>) {
    const raw = env[TIMING_ENV[key]];
    if (raw === undefined || raw === "") continue;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${TIMING_ENV[key]} must be a positive integer, got '${raw}'`);
    out[key] = Number(raw);
  }
  return out;
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  /** Queue key: the model id plus its server context (a different -c is a different server). */
  key: string;
  model: string;
  ctx: number;
  commandId: string;
  body: string;
  /** Execution timeout counted from dispatch (spec 4: the broker owns timeouts after dispatch). */
  timeoutMs: number;
  /** This job's queue timeout (--queue_timeout, else T): past it, its model is forced onto the server. Waiting is never an error. */
  queueTimeoutMs: number;
  submittedAt: number;
  lastPolledAt: number;
  /** Long-polls currently waiting on this job; a job with one is never abandoned. */
  pollers: number;
  state: JobState;
  dispatchedAt?: number;
  finishedAt?: number;
  result?: { status: number; body: string; contentType: string };
  error?: string;
}

export function queueKey(model: string, ctx: number): string {
  return `${model}\u0000${ctx}`;
}

/**
 * One queue per (model, ctx); inside it, one FIFO per command, served
 * round-robin (spec 3: one command's 1,000 files never block another
 * command's single file).
 */
export class Scheduler {
  private readonly queues = new Map<string, Map<string, Job[]>>();
  /** Per key, the command served last, so the next take starts after it. */
  private readonly lastCommand = new Map<string, string>();
  current: string | null = null;
  servedInRun = 0;
  runStartedAt = 0;

  enqueue(job: Job): void {
    let byCmd = this.queues.get(job.key);
    if (!byCmd) this.queues.set(job.key, (byCmd = new Map()));
    const fifo = byCmd.get(job.commandId);
    if (fifo) fifo.push(job);
    else byCmd.set(job.commandId, [job]);
  }

  /** Remove a queued job (cancel or abandon). true when it was queued. */
  remove(job: Job): boolean {
    const byCmd = this.queues.get(job.key);
    const fifo = byCmd?.get(job.commandId);
    const i = fifo ? fifo.indexOf(job) : -1;
    if (!fifo || i < 0) return false;
    fifo.splice(i, 1);
    if (fifo.length === 0) byCmd!.delete(job.commandId);
    if (byCmd!.size === 0) this.queues.delete(job.key);
    return true;
  }

  queuedCount(key?: string): number {
    let n = 0;
    for (const [k, byCmd] of this.queues) if (key === undefined || k === key) for (const f of byCmd.values()) n += f.length;
    return n;
  }

  keys(): string[] {
    return [...this.queues.keys()];
  }

  allQueued(key?: string): Job[] {
    const out: Job[] = [];
    for (const [k, byCmd] of this.queues) if (key === undefined || k === key) for (const f of byCmd.values()) out.push(...f);
    return out;
  }

  /** Abandoned = not polled for abandonMs and no poll waiting (spec 4). Removed from the queue BEFORE dispatch, so a cancelled command's work never runs. */
  dropAbandoned(now: number, abandonMs: number): Job[] {
    const gone = this.allQueued().filter((j) => j.pollers === 0 && now - j.lastPolledAt > abandonMs);
    for (const j of gone) this.remove(j);
    return gone;
  }

  oldestSubmittedAt(key: string): number | null {
    let min: number | null = null;
    for (const j of this.allQueued(key)) if (min === null || j.submittedAt < min) min = j.submittedAt;
    return min;
  }

  /** The other key whose oldest request has waited longest (spec 6 "next model"), or null. */
  longestWaiting(except: string | null): string | null {
    let best: string | null = null;
    let bestAt = Infinity;
    for (const k of this.keys()) {
      if (k === except) continue;
      const at = this.oldestSubmittedAt(k);
      if (at !== null && at < bestAt) {
        best = k;
        bestAt = at;
      }
    }
    return best;
  }

  /**
   * The other key holding the MOST overdue job, or null. A job's deadline is
   * its submit time plus its own queue timeout (spec 6 as updated 2026-10-28);
   * the earliest passed deadline wins, so a short --queue_timeout is served
   * before an older job with a long one.
   */
  overdue(now: number): string | null {
    let best: string | null = null;
    let bestDeadline = Infinity;
    for (const j of this.allQueued()) {
      const deadline = j.submittedAt + j.queueTimeoutMs;
      if (j.key === this.current || deadline >= now) continue;
      if (deadline < bestDeadline) {
        best = j.key;
        bestDeadline = deadline;
      }
    }
    return best;
  }

  /**
   * Spec 6 with the USER ruling of 2026-10-28. Rotate (returns the key to
   * switch to; null keeps the current model):
   *  - when the current queue and in-flight are empty, to the model whose
   *    oldest request waited longest;
   *  - FORCED when another model's job has waited longer than its own queue
   *    timeout (--queue_timeout, default T = 5 min), to that model;
   *  - when the current model served at least B requests (or ran at least D)
   *    and another model has work, so batches alternate after a calibrated run.
   * The quota clause no longer waits for T: with T a per-job value, "B and
   * waited > T" would let one job with a short --queue_timeout be overridden
   * by another's long one; the forced clause owns the waiting bound alone.
   * The caller stops dispatching while this returns non-null and swaps once
   * in-flight reaches 0.
   */
  wantRotation(now: number, inFlight: number, t: BrokerTimings): string | null {
    const next = this.longestWaiting(this.current);
    if (next === null) return null;
    if (this.current === null) return next;
    if (this.queuedCount(this.current) === 0 && inFlight === 0) return next;
    const forced = this.overdue(now);
    if (forced !== null) return forced;
    if (this.servedInRun >= t.batch || now - this.runStartedAt >= t.maxRunMs) return next;
    return null;
  }

  /** Make `key` current and restart its run counters. */
  startRun(key: string, now: number): void {
    this.current = key;
    this.servedInRun = 0;
    this.runStartedAt = now;
  }

  /** Next job of `key`, round-robin across commands. */
  take(key: string): Job | undefined {
    const byCmd = this.queues.get(key);
    if (!byCmd || byCmd.size === 0) return undefined;
    const cmds = [...byCmd.keys()];
    const last = this.lastCommand.get(key);
    const start = last === undefined ? 0 : (cmds.indexOf(last) + 1) % cmds.length;
    const cmd = cmds[start < 0 ? 0 : start];
    const job = byCmd.get(cmd)!.shift()!;
    if (byCmd.get(cmd)!.length === 0) byCmd.delete(cmd);
    if (byCmd.size === 0) this.queues.delete(key);
    this.lastCommand.set(key, cmd);
    return job;
  }
}
