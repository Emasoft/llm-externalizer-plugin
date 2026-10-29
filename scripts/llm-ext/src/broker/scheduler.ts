/**
 * broker/scheduler.ts — the local-engine broker's queueing and rotation rules
 * (TRDD-1OOAH3LD, TRDD-ZGSGGHQG; design/specs/local-engine-broker-design.md
 * points 3, 4 and 6). Pure: no I/O, no timers, the clock is a parameter, so
 * every rule is testable with tiny values.
 */

import type { BrokerEngine } from "./protocol.js";

/** The broker's tunables. Provisional defaults from the spec; every one is overridable through the environment the broker is started with (tests shorten them). */
export interface BrokerTimings {
  /** B: the minimum slice a loaded model is served before a deadline may rotate it out: min(B, its queued count at load) dispatches (spec 6, provisional 32). */
  batch: number;
  /** D: ...or this long on the current model, whichever comes first (spec 6, provisional 180 s). A MINIMUM run, never a maximum. */
  minRunMs: number;
  /** T: the default queue timeout (USER ruling 2026-10-28: 5 min). A job's deadline is submit + its queue timeout; a near deadline rotates its model in after the current minimum slice (spec 6). A job may carry its own (--queue_timeout). */
  starveMs: number;
  /** A job not polled for this long is abandoned and never dispatched (spec 4, 120 s). */
  abandonMs: number;
  /** Longest single long-poll (spec 4, 60 s: every HTTP exchange stays far below undici's 300 s headers timeout). */
  pollWaitMs: number;
  /** No request for this long: the broker stops its server (spec 10, 2 h). */
  idleServerMs: number;
  /** No server and no request for this long: the broker exits (spec 10, 2 h). */
  idleExitMs: number;
  /** Review M2: an empty current queue rotates only after this long without activity on it (1 s), so a sequential caller can submit its next request first. */
  lingerMs: number;
  /** Load-time estimate for a model never loaded yet (60 s); after a load the measured time is used. */
  defaultLoadMs: number;
  /**
   * Locals only (TRDD-ZGSGGHQG L3.4): a job beyond the first in flight is
   * dispatched only while macOS `memory_pressure` reports at least this free
   * percentage; otherwise it waits (never an error). Provisional 10, to be
   * calibrated (P6). A tunable like the others, though not a time.
   */
  memoryFloorPct: number;
}

export const DEFAULT_TIMINGS: BrokerTimings = {
  batch: 32,
  minRunMs: 180_000,
  starveMs: 300_000,
  abandonMs: 120_000,
  pollWaitMs: 60_000,
  idleServerMs: 2 * 3_600_000,
  idleExitMs: 2 * 3_600_000,
  lingerMs: 1000,
  defaultLoadMs: 60_000,
  memoryFloorPct: 10,
};

/** Environment names of the overrides, one per field (LLM_EXT_ prefix, like every llm-ext variable). */
export const TIMING_ENV: Record<keyof BrokerTimings, string> = {
  batch: "LLM_EXT_BROKER_BATCH",
  minRunMs: "LLM_EXT_BROKER_MIN_RUN_MS",
  starveMs: "LLM_EXT_BROKER_STARVE_MS",
  abandonMs: "LLM_EXT_BROKER_ABANDON_MS",
  pollWaitMs: "LLM_EXT_BROKER_POLL_WAIT_MS",
  idleServerMs: "LLM_EXT_BROKER_IDLE_SERVER_MS",
  idleExitMs: "LLM_EXT_BROKER_IDLE_EXIT_MS",
  lingerMs: "LLM_EXT_BROKER_LINGER_MS",
  defaultLoadMs: "LLM_EXT_BROKER_DEFAULT_LOAD_MS",
  memoryFloorPct: "LLM_EXT_BROKER_MEMORY_FLOOR",
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
  /** Queue key: the model id plus its server context and engine (a different -c or engine is a different server). */
  key: string;
  /** Which engine runs it (TRDD-ZGSGGHQG): llama-server or Locals. */
  engine: BrokerEngine;
  model: string;
  ctx: number;
  commandId: string;
  body: string;
  /** Execution timeout counted from dispatch (spec 4: the broker owns timeouts after dispatch). */
  timeoutMs: number;
  /** This job's queue timeout (--queue_timeout, else T): once its deadline nears, its model is rotated in after the current minimum slice (spec 6). Waiting is never an error. */
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

/** The model id first (logs print key.split("\u0000")[0]), then its context and engine: the same id on another engine is another server. */
export function queueKey(model: string, ctx: number, engine: BrokerEngine): string {
  return `${model}\u0000${ctx}\u0000${engine}`;
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
  /** The current model's queued count when it was loaded: its minimum slice is min(B, this). */
  queuedAtLoad = 0;
  /** Last submit/take/finish on the current model (the linger before an empty-queue rotation). */
  lastActivityAt = 0;

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

  /** Measured load time per key (spawn to ready), recorded by the broker after each start. */
  private readonly loadMs = new Map<string, number>();

  recordLoad(key: string, ms: number): void {
    this.loadMs.set(key, ms);
  }

  /** The key's last measured load time, or the default estimate before its first load. */
  loadEstimate(key: string, t: BrokerTimings): number {
    return this.loadMs.get(key) ?? t.defaultLoadMs;
  }

  /**
   * The other key holding the EARLIEST deadline that has passed or falls
   * within that key's load time (deadline = submit + the job's own queue
   * timeout). Counting the load time makes the swap land by the deadline
   * instead of starting at it. null when no other job's deadline is that near.
   */
  dueKey(now: number, t: BrokerTimings): string | null {
    let best: string | null = null;
    let bestDeadline = Infinity;
    for (const j of this.allQueued()) {
      if (j.key === this.current) continue;
      const deadline = j.submittedAt + j.queueTimeoutMs;
      if (deadline > now + this.loadEstimate(j.key, t)) continue;
      if (deadline < bestDeadline) {
        best = j.key;
        bestDeadline = deadline;
      }
    }
    return best;
  }

  /** Note activity on the current model (submit, take, finish): the linger before an "empty queue" rotation counts from the last one. */
  touch(now: number): void {
    this.lastActivityAt = now;
  }

  /**
   * Spec 6 (coordinator decision 2026-10-28, binding). Returns the key to
   * switch to, or null to keep the current model:
   *  1. no current model: the model whose oldest request waited longest;
   *  2. the current queue and in-flight are empty and nothing happened on the
   *     current model for lingerMs (review M2: a sequential caller submits its
   *     next request right after reading the reply; swapping at once cost it a
   *     full rotation per request): the longest-waiting other model;
   *  3. otherwise only when BOTH hold:
   *     (a) the current model dispatched at least min(B, the queued count it
   *         was loaded for), or ran at least D: B and D are a MINIMUM slice,
   *         never a maximum, so after every swap the new model is served
   *         first (this is what ends the review-C1 livelock of two overdue
   *         models swapping back and forth without serving anything);
   *     (b) another model's job has a deadline that has passed or falls within
   *         that model's measured load time (default estimate before its first
   *         load): the model holding the EARLIEST such deadline.
   *     A long --queue_timeout (the user's 99990) therefore really lets its
   *     job wait: its deadline is never near, so (b) never fires for it.
   * Worst-case queue wait: about T + D (+ draining in-flight and one load).
   * The caller stops dispatching while this returns non-null and swaps once
   * in-flight reaches 0.
   */
  wantRotation(now: number, inFlight: number, t: BrokerTimings): string | null {
    const longest = this.longestWaiting(this.current);
    if (longest === null) return null;
    if (this.current === null) return longest;
    if (this.queuedCount(this.current) === 0 && inFlight === 0) return now - this.lastActivityAt >= t.lingerMs ? longest : null;
    const minimumServed = this.servedInRun >= Math.min(t.batch, this.queuedAtLoad) || now - this.runStartedAt >= t.minRunMs;
    return minimumServed ? this.dueKey(now, t) : null;
  }

  /** Make `key` current and restart its run counters; `queued` = its queued count at load (the minimum slice is min(B, queued)). */
  startRun(key: string, now: number, queued = this.queuedCount(key)): void {
    this.current = key;
    this.servedInRun = 0;
    this.runStartedAt = now;
    this.queuedAtLoad = queued;
    this.lastActivityAt = now;
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
