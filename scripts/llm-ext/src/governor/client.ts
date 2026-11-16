/**
 * governor/client.ts — what a process calls to take and return a lease on
 * machine-wide local inference (design/specs/local-inference-governor-design.md
 * D2, D5, D6, D7). `tryAcquire` never waits, for a broker's pump; `acquire`
 * polls, for a process with one send to make. One process holds one place per
 * kind in the queue whatever its depth, so 100 requesters take turns.
 */

import { pidState } from "../local-llama-server.js";
import { throwIfStopped } from "../provider/http.js";
import { totalmem } from "node:os";
import { bookedBytes, decide, headStopped, METRICS_MAX_AGE_MS, neededBytes, pickUnload, pollDelayMs, RAM_OVER_UNLOAD_MS, runningWeight, serverThreads, threadBudget, threadsInUse, type ControllerConfig, type Denial, type GovernorConfig, type GrantRequest } from "./controller.js";
import { governorConfig } from "./settings.js";
import { coreCount, needsReading, nextMetrics, readMemory, sampleCpu, type Metrics } from "./metrics.js";
import { governorDir, ownerPids, ownStart, readStarts, readState, reap, withStateLock, type GovernorState, type Holder, type LastDenial, type Lease, type LeaseKind, type Locked, type ServerEntry, type Waiter } from "./state.js";

export type { Lease, LeaseKind } from "./state.js";

export interface AcquireRequest {
  /** The job's execution timeout: a lease expires 60 s after it, a backstop against a leak in a live holder (D3). */
  timeoutMs: number;
  kind?: LeaseKind;
  weight?: number;
  /** A server's thread count, 0 when unknown, as for a user-started server (D9). */
  threads?: number;
  serverPid?: number | null;
  /** The job's --queue_timeout, which can only shorten the CPU floor wait (D6). */
  queueTimeoutMs?: number | null;
  /** A load only: its projected RAM, an upper bound (D11). */
  bytes?: number;
  /** A load only: its lower bound, weights and headroom; a load whose upper bound never fits is admitted alone on it (D11). */
  minBytes?: number;
  /** A load only: admitted only alone whatever its bounds, after a breach of its model (round 4). */
  alone?: boolean;
  /** A load only: the RAM of the server the caller stops before it starts this one (D11). */
  outgoingBytes?: number;
}

export interface AcquireOptions {
  signal?: AbortSignal;
}

export interface GovernorSnapshot {
  dir: string;
  w: number;
  maxInferences: number;
  running: number;
  leases: Lease[];
  waiters: Waiter[];
  cpuPct: number | null;
  ramUsedPct: number | null;
  readingAgeMs: number | null;
  threadsInUse: number;
  threadBudget: number;
  cpuLimitPct: number;
  ramLimitPct: number;
  /** D13: false when this process is opted out (enabled: false): it takes no leases and is not counted. */
  enabled: boolean;
  /** Every server llm-ext registered, with the T it was started with (D10). */
  servers: ServerEntry[];
  lastDenial: LastDenial | null;
}

const EXPIRY_MARGIN_MS = 60_000;
const PID_CHECK_INTERVAL_MS = 30_000;
const WAIT_LINE_INTERVAL_MS = 60_000;
const COMMIT_RETRY_MS = 20;
const COMMIT_RETRY_JITTER_MS = 30;
/** One failed reading is stale, not an error: on an overloaded machine, the case the limits exist for, vm_stat can miss its timeout once. */
const READING_FAILURES_TO_ERROR = 3;

type Op = (state: GovernorState) => void;
interface Attempt {
  lease: Lease | null;
  denial: Denial | null;
}
interface Pending {
  req: AcquireRequest;
  resolve: (lease: Lease) => void;
  reject: (err: unknown) => void;
  stop: () => void;
}
interface Poller {
  key: string;
  dir: string;
  kind: LeaseKind;
  queue: Pending[];
  timer: NodeJS.Timeout | null;
  lastLineAt: number;
}

let me: Holder | null = null;
let leaseSeq = 0;
let commitTimer: NodeJS.Timeout | null = null;
const deferred = new Map<string, Op[]>();
const pollers = new Map<string, Poller>();
const sampling = new Set<string>();
const verdicts = new Map<string, Map<number, string>>();
const failures = new Map<string, unknown>();
const failedReadings = new Map<string, number>();
/** Ids of the leases handed out while the governor is disabled: in no state file, so their release writes nothing. */
const unrecorded = new Set<string>();
/**
 * The queue places this process recorded, by `${dir}\0${kind}`, and the server pids it registered. Kept in memory so
 * a process disabled later (D13) knows what to give back without reading the directory: one that recorded nothing never
 * touches it (D2, enabled: false is the way out of an unusable directory; review M1, M3).
 */
const placed = new Set<string>();
const registered = new Set<number>();

function holder(): Holder {
  me ??= { pid: process.pid, start: ownStart() };
  return me;
}

function waiterId(kind: LeaseKind): string {
  return `${process.pid}:${kind}`;
}

function controllerConfig(config: GovernorConfig): ControllerConfig {
  return { cores: coreCount(), totalBytes: totalmem(), settleMs: config.settleMs, cpuFloorWaitMs: config.cpuFloorWaitMs, loadYieldMs: config.loadYieldMs };
}

function headsOf(state: GovernorState): Waiter[] {
  const heads: Waiter[] = [];
  for (const kind of ["inference", "load"] as const) {
    const head = state.waiters.find((w) => w.kind === kind);
    if (head) heads.push(head);
  }
  return heads;
}

/** `since` stays: a waiter moved back has still waited that long, for the CPU floor (D6). */
function toTail(state: GovernorState, waiter: Waiter): void {
  state.waiters = [...state.waiters.filter((w) => w !== waiter), waiter];
}

function readingFailed(dir: string, err: unknown): void {
  const count = (failedReadings.get(dir) ?? 0) + 1;
  if (count < READING_FAILURES_TO_ERROR) {
    failedReadings.set(dir, count);
    return;
  }
  failedReadings.delete(dir);
  // Kept for the next attempt to throw: readings that keep failing must end in an error, not in a metric stale forever.
  failures.set(dir, err);
}

/**
 * One critical section with the deferred ops applied first. They stay queued
 * until the write succeeded: deleted earlier, a write that throws loses a
 * release, and the lease stays taken until its expiry.
 */
function section<T>(dir: string, fn: (state: GovernorState) => T): Locked<T> {
  const result = withStateLock(dir, (state) => {
    const heads = headsOf(state);
    for (const op of deferred.get(dir) ?? []) op(state);
    const value = fn(state);
    // A rank below the head never takes the lock, so its stamp is old the moment it becomes head; without this every
    // promotion would look stopped (D7).
    const now = Date.now();
    for (const head of headsOf(state)) if (!heads.includes(head)) head.polledAt = now;
    return value;
  });
  if (result.locked) deferred.delete(dir);
  return result;
}

function flush(dir: string): void {
  try {
    if (section(dir, () => undefined).locked) return;
  } catch (err) {
    // flush runs from a release, an abort listener or a timer, where a throw kills a broker over a lease it has already
    // finished with. The op stays queued, and the next attempt delivers the error to a caller that can act on it.
    failures.set(dir, err);
    process.stderr.write(`llm-ext: governor could not record a change: ${(err as Error).message}\n`);
    return;
  }
  if (commitTimer) return;
  // unref: a process that ends with a commit pending is reaped as a dead holder, so this timer need not keep it alive.
  commitTimer = setTimeout(() => {
    commitTimer = null;
    for (const pendingDir of [...deferred.keys()]) flush(pendingDir);
  }, COMMIT_RETRY_MS + Math.random() * COMMIT_RETRY_JITTER_MS);
  commitTimer.unref();
}

/** Apply a change that must not be lost to a busy lock, without ever waiting on the lock (D2). */
function commit(dir: string, op: Op): void {
  const ops = deferred.get(dir);
  if (ops) ops.push(op);
  else deferred.set(dir, [op]);
  flush(dir);
}

/** The reading runs outside the lock, in the background, so a broker's pump never waits on vm_stat (D7, D8). */
function startSampling(dir: string, pids: number[] | null): void {
  if (sampling.has(dir)) return;
  sampling.add(dir);
  void (async () => {
    const { freePct } = await readMemory();
    if (pids) verdicts.set(dir, await readStarts(pids));
    commit(dir, (state) => {
      const now = Date.now();
      // Caught here: an op stays queued until a write succeeds, so one that throws would fail every later attempt.
      try {
        state.metrics = nextMetrics(state.metrics, freePct, sampleCpu(now), now);
        failedReadings.delete(dir);
      } catch (err) {
        readingFailed(dir, err);
      }
    });
  })()
    .catch((err: unknown) => readingFailed(dir, err))
    .finally(() => sampling.delete(dir));
}

/**
 * D13, enabled: false: a lease in no state file, so the process takes no place, is not counted, and its release
 * writes nothing; the caller sends as it did before the governor. `start` stays empty: no `ps` for a lease nobody reaps.
 */
function unrecordedLease(req: AcquireRequest): Lease {
  const now = Date.now();
  const lease: Lease = { id: `off-${process.pid}-${++leaseSeq}-${now}`, kind: req.kind ?? "inference", weight: req.weight ?? 1, threads: 0, serverPid: req.serverPid ?? null, bytes: req.bytes ?? 0, holder: { pid: process.pid, start: "" }, at: now, expiresAt: now + req.timeoutMs + EXPIRY_MARGIN_MS };
  unrecorded.add(lease.id);
  return lease;
}

function attempt(dir: string, req: AcquireRequest, config: GovernorConfig, keepPlace = false): Attempt {
  if (!config.enabled) {
    // Disabled while this process waited (settings.yaml changed): its place is given back, or it would hold up everyone
    // behind it. Known from memory (`placed`), never from a read: D2, enabled: false is the way out of an unusable
    // directory, so a process that recorded nothing there never touches it (review M1). One that queued while enabled
    // gives its place back through commit, which reports a failed write and never throws, so it never blocks this send.
    const kind = req.kind ?? "inference";
    if (placed.has(`${dir}\0${kind}`)) withdrawFrom(dir, kind);
    return { lease: unrecordedLease(req), denial: null };
  }
  const failure = failures.get(dir);
  if (failure !== undefined) {
    failures.delete(dir);
    throw failure;
  }
  const kind = req.kind ?? "inference";
  const id = waiterId(kind);
  const self = holder();
  const result = section(dir, (state) => {
    const now = Date.now();
    let waiter = state.waiters.find((w) => w.id === id);
    if (!waiter) {
      waiter = { id, kind, weight: req.weight ?? 1, holder: self, since: now, polledAt: now, queueTimeoutMs: req.queueTimeoutMs ?? null, limits: config.limits };
      state.waiters.push(waiter);
      placed.add(`${dir}\0${kind}`);
    }
    waiter.polledAt = now;
    waiter.weight = req.weight ?? 1;
    waiter.limits = config.limits;
    // Before the reap: a head the reap promotes still carries its old stamp until the section ends.
    const sameKind = state.waiters.filter((w) => w.kind === kind);
    const rank = sameKind.indexOf(waiter);
    if (rank > 0 && headStopped(sameKind[0], rank, now)) toTail(state, sameKind[0]);
    reap(state, now, verdicts.get(dir) ?? null);
    verdicts.delete(dir);
    // The first waiter that is really polling samples: nobody else can act on a good reading, and 100 samplers are the
    // failure mode of D7. A stopped first waiter of the other kind must not leave every head on a stale reading.
    const readingDue = state.waiters.find((w) => !headStopped(w, 1, now))?.id === id && needsReading(state.metrics, now);
    const pidCheckDue = readingDue && now - state.pidCheckAt >= PID_CHECK_INTERVAL_MS;
    if (pidCheckDue) state.pidCheckAt = now;
    const reading = { due: readingDue, pids: pidCheckDue ? ownerPids(state) : null };
    const request = { ...waiter, weight: req.weight ?? 1, threads: req.threads ?? 0, serverPid: req.serverPid ?? null, bytes: req.bytes ?? 0, minBytes: req.minBytes, alone: req.alone, outgoingBytes: req.outgoingBytes ?? 0 };
    const decision = decide(state, request, now, controllerConfig(config));
    state.window = decision.window;
    giveRamBack(state, kind === "load" && (decision.denial === "ram" || decision.denial === "alone") ? request : null, config, now);
    if (decision.yields) toTail(state, waiter);
    if (!decision.grant) {
      // D13 status: the reason server-status shows. "stale" says nothing about the machine: no reading yet.
      // Review nit: nor "queued", which only says others wait first, and would overwrite the reason that blocks them all.
      if (decision.denial !== null && decision.denial !== "stale" && decision.denial !== "queued") state.lastDenial = { kind, reason: blockedBy(decision.denial, state, config, kind), pid: process.pid, at: now };
      return { lease: null, denial: decision.denial, reading };
    }
    if (keepPlace) {
      // D7: a requester granted with work left goes to the tail, so 100 requesters take turns; not dropped, which left it
      // out of the queue until its next poll. Not kept at the head: a scan with more acquires than the window always has
      // one pending and would never let anyone else in. `since` restarts: the next request has waited from now, and the
      // CPU floor (D6) must not see the wait of one already granted.
      waiter.since = now;
      toTail(state, waiter);
    } else {
      state.waiters = state.waiters.filter((w) => w.id !== id);
      placed.delete(`${dir}\0${kind}`);
    }
    state.window.lastRunAt = now;
    const lease: Lease = {
      id: `${process.pid}-${++leaseSeq}-${now}`,
      kind,
      weight: request.weight,
      threads: request.threads,
      serverPid: request.serverPid,
      bytes: request.bytes,
      holder: self,
      at: now,
      expiresAt: now + req.timeoutMs + EXPIRY_MARGIN_MS,
    };
    state.leases.push(lease);
    touchServerIn(state, lease.serverPid, now);
    // Round 2 #2: a server that takes work is in use, not idle: an unload asked of it is withdrawn, or its owner would
    // stop it under the job it just took the moment that job ends.
    const served = lease.kind === "inference" ? state.servers.find((s) => s.pid === lease.serverPid) : undefined;
    if (served) served.wantUnload = false;
    return { lease, denial: null, reading };
  });
  if (!result.locked) return { lease: null, denial: null };
  if (result.value.reading.due) startSampling(dir, result.value.reading.pids);
  return result.value;
}

/** Use is what makes a server recent: the least recently used idle one is the first to give its RAM back (D11). */
function touchServerIn(state: GovernorState, pid: number | null, now: number): void {
  const entry = pid === null ? undefined : state.servers.find((s) => s.pid === pid);
  if (entry) entry.lastUsedAt = now;
}

/**
 * D11: a load head denied on RAM, or RAM over its limit for 30 s while someone
 * waits, asks the owner of the least recently used idle server to stop it.
 * Judged on this waiter's own RAM limit, like every limit (D13). `load` is the
 * denied load request, null when no load was denied on RAM.
 */
function giveRamBack(state: GovernorState, load: GrantRequest | null, config: GovernorConfig, now: number): void {
  // Round 2 #2: a flag expires after one settle interval. An owner that did not act in that time (busy, or gone) must
  // not hold the choice: the next pass picks again, the same server if it is still the best one.
  if (now - state.lastUnloadAt >= config.settleMs) for (const s of state.servers) s.wantUnload = false;
  const { freePct, at } = state.metrics;
  const fresh = freePct !== null && now - at <= METRICS_MAX_AGE_MS;
  if (fresh) state.ramOverSince = 100 - freePct >= config.limits.ramLimitPct ? (state.ramOverSince ?? now) : null;
  const overLong = state.ramOverSince !== null && now - state.ramOverSince >= RAM_OVER_UNLOAD_MS;
  if (load === null && !overLong) return;
  const total = totalmem();
  // Round 4 #7: RAM over its limit with no load denied asks for 0 bytes: an idle server is unloaded only when giving the
  // idle ones back brings the books under the limit, never as a reflex that costs a reload and frees nothing that helps.
  if (freePct === null) return; // no reading yet: a load denial is always judged on one, so this is the RAM-over path
  const need = { ramUsedPct: 100 - freePct, bytes: load === null ? 0 : neededBytes(load, config.limits, total), outgoingBytes: load?.outgoingBytes ?? 0, limits: config.limits, totalBytes: total };
  const chosen = pickUnload(state.servers, state.leases, process.pid, state.lastUnloadAt, now, config.settleMs, need);
  if (!chosen) return;
  chosen.wantUnload = true;
  state.lastUnloadAt = now;
}

/**
 * One pass, never waiting. Holds this process's place in the queue, so call it
 * again until it answers with a lease, then `release`, or `withdraw` to give up
 * the place. Null covers a denial and a busy lock alike.
 */
export function tryAcquire(req: AcquireRequest): Lease | null {
  return attempt(governorDir(), req, governorConfig()).lease;
}


export interface AttemptResult {
  lease: Lease | null;
  /** Why not, for a caller that must tell a load denial from RAM; null for a busy lock, which says nothing. */
  denial: Denial | null;
}

/** `tryAcquire` with the reason of a denial: the broker keeps serving its loaded model while a load is denied (D8). */
export function attemptLease(req: AcquireRequest): AttemptResult {
  const { lease, denial } = attempt(governorDir(), req, governorConfig());
  return { lease, denial };
}

/**
 * Whether a load would be granted now, from a lockless read: no place in the
 * queue, nothing written. A broker with requests still running asks this
 * before it stops dispatching to drain for a swap, so a load that would be
 * denied anyway never leaves its loaded model idle (D8). Another load waiter
 * ahead is "queued": its turn comes first. Null means a grant.
 */
export function loadVerdict(req: AcquireRequest): Denial | null {
  const config = governorConfig();
  // D13: a disabled process asks for no grant, so nothing ever waits on it.
  if (!config.enabled) return null;
  const state = readState(governorDir());
  const now = Date.now();
  // Round 4 #11: this broker's own waiter keeps its real place (and its `since`, which bounds its yield): a synthetic one
  // at the tail would answer "queued" for a waiter already at the head. Only a broker with no place yet gets one, last.
  // Round 5 m3: only load waiters are passed, as before round 4; decide reads only its own kind (no behaviour change).
  const loads = state.waiters.filter((w) => w.kind === "load");
  const own = loads.find((w) => w.id === waiterId("load"));
  const self: Waiter = own ?? { id: waiterId("load"), kind: "load", weight: 1, holder: holder(), since: now, polledAt: now, queueTimeoutMs: req.queueTimeoutMs ?? null, limits: config.limits };
  const waiters = own ? loads : [...loads, self];
  const request = { ...self, limits: config.limits, threads: 0, serverPid: null, bytes: req.bytes ?? 0, minBytes: req.minBytes, alone: req.alone, outgoingBytes: req.outgoingBytes ?? 0 };
  return decide({ ...state, waiters }, request, now, controllerConfig(config)).denial;
}

/**
 * Record a model server this process owns: booked and chosen to unload as D11 says. Reaped with its owner. `threads` is
 * the T it was started with (D10): the budget counts lease threads, server-status shows it per server (D13). A
 * disabled process registers nothing: it does not count toward the limits (D13).
 */
export function registerServer(pid: number, figures: { bookedBytes: number; residentBytes: number; engine: "llama" | "locals"; role: "main" | "cal"; threads: number }): void {
  if (!governorConfig().enabled) return;
  // Review M3: remembered on an enabled call only, so unregisterServer removes exactly what this process booked, whatever
  // enabled says by then. Added when the op is queued, not inside it: commit applies a process's ops in order, so a
  // removal queued later always runs after this entry is written, even while the lock is busy; marked only inside the
  // op, an unregister arriving before the deferred write would skip the removal and leave a phantom entry.
  registered.add(pid);
  commit(governorDir(), (state) => {
    const now = Date.now();
    const self = holder();
    state.servers = [...state.servers.filter((s) => s.pid !== pid), { pid, start: "", ownerPid: self.pid, ownerStart: self.start, ...figures, lastUsedAt: now, wantUnload: false }];
  });
}

/**
 * The threads a server llm-ext starts now is given and counted by (D10, `serverThreads`): a llama-server's `-t`/`-tb`
 * from this process's cpu_limit_pct and server_threads, a Locals server the measured constant, 0 at cpu_limit_pct 100.
 * Read at each spawn, so a changed limit reaches the next server. server_threads is validated for both engines: a
 * malformed value or one above the budget throws (fail fast). The broker and the calibration runner call it once at
 * start too, so a typo ends the command before any spawn, never on calibration's crash path (round 2, M5).
 */
export function spawnThreads(engine: "llama" | "locals"): number {
  const cores = coreCount();
  const config = governorConfig();
  // D13: a disabled process starts its servers as before the governor, with no -t, and leases nothing for them.
  if (!config.enabled) return 0;
  return serverThreads(engine, cores, config.limits.cpuLimitPct, config.serverThreads);
}

/**
 * The RAM the reading cannot see, from a lockless read: every registered Locals server's booking (round 4 #3). 0 when
 * disabled: a disabled process is judged by no limit, so it needs no booking and must not need the directory (D2, M1).
 */
export function bookedBytesNow(): number {
  if (!governorConfig().enabled) return 0;
  return bookedBytes(readState(governorDir()).servers);
}

/**
 * Forget a server this process stopped, or found dead. Review M3: an entry this process registered is removed whatever
 * enabled says now (one registered while enabled and stopped after a flip to disabled would stay booked, and be picked to
 * unload, until this process exits), and with no resolver call, so a malformed settings.yaml at stop time never keeps an
 * entry. Any other pid keeps the unit-6 rule: removed only while enabled (a caller may remove an entry it did not
 * register, as governor-load.test.ts does for another owner's server), and a disabled process that registered nothing
 * never touches the directory (D2). Only that path reads the settings; the callers catch and log its error.
 */
export function unregisterServer(pid: number): void {
  if (!registered.delete(pid) && !governorConfig().enabled) return;
  commit(governorDir(), (state) => {
    state.servers = state.servers.filter((s) => s.pid !== pid);
  });
}

/** Whether the governor asked the owner of `pid` to stop it (D11). A lockless read: the owner polls it on its tick. */
export function unloadWanted(pid: number): boolean {
  // D2, review M1: a disabled process is never asked to unload and must not need the directory.
  if (!governorConfig().enabled) return false;
  return readState(governorDir()).servers.some((s) => s.pid === pid && s.wantUnload);
}

/** Return a lease. Never lost to a busy lock, and if this process dies first the lease is reaped with it. */
export function release(lease: Lease): void {
  // D13: a lease handed out while disabled is in no state file; its release writes nothing.
  if (unrecorded.delete(lease.id)) return;
  commit(governorDir(), (state) => {
    const now = Date.now();
    state.leases = state.leases.filter((l) => l.id !== lease.id);
    state.window.lastRunAt = now;
    touchServerIn(state, lease.serverPid, now);
  });
}

function withdrawFrom(dir: string, kind?: LeaseKind): void {
  // Only a place this process recorded is given back: a disabled process that queued nothing never touches the directory
  // (D2, review M1), and every place it takes is in `placed` (attempt), so nothing of ours is skipped.
  let had = false;
  for (const k of kind === undefined ? (["inference", "load"] as const) : [kind]) had = placed.delete(`${dir}\0${k}`) || had;
  if (!had) return;
  commit(dir, (state) => {
    state.waiters = state.waiters.filter((w) => w.holder.pid !== process.pid || (kind !== undefined && w.kind !== kind));
  });
}

/** Give up this process's place in the queue, for one kind or all. */
export function withdraw(kind?: LeaseKind): void {
  withdrawFrom(governorDir(), kind);
}

/** A lockless view for status and tests. Touches nothing, so it costs an idle machine no file. */
export function snapshot(): GovernorSnapshot {
  const dir = governorDir();
  const config = governorConfig();
  const { limits } = config;
  const state = readState(dir);
  return {
    dir,
    w: Math.min(state.window.w, limits.maxInferences),
    maxInferences: limits.maxInferences,
    running: runningWeight(state.leases),
    leases: state.leases,
    waiters: state.waiters,
    cpuPct: state.metrics.cpuPct,
    ramUsedPct: state.metrics.freePct === null ? null : 100 - state.metrics.freePct,
    readingAgeMs: readingAge(state.metrics),
    threadsInUse: threadsInUse(state.leases),
    threadBudget: threadBudget(coreCount(), limits.cpuLimitPct),
    cpuLimitPct: limits.cpuLimitPct,
    ramLimitPct: limits.ramLimitPct,
    enabled: config.enabled,
    servers: state.servers,
    lastDenial: state.lastDenial,
  };
}


/**
 * Whether a waiter at `rank` may only read the file. Not when the head of its
 * kind is dead, or stopped (SIGSTOP, Ctrl-Z, a debugger): a live head that
 * stopped polling grants nothing and samples nothing, and reaping happens only
 * in a critical section, so someone behind it has to take one.
 */
export function waitBehindHead(sameKind: Waiter[], rank: number, now: number): boolean {
  if (rank <= 0) return false;
  const head = sameKind[0];
  return pidState(head.holder.pid) !== "dead" && !headStopped(head, rank, now);
}

function readingAge(metrics: Metrics): number | null {
  return metrics.at === 0 ? null : Date.now() - metrics.at;
}

function blockedBy(denial: Denial, state: GovernorState, config: GovernorConfig, kind: LeaseKind): string {
  const { cpuPct, freePct } = state.metrics;
  const { limits } = config;
  switch (denial) {
    case "ram":
      return `RAM is ${Math.round(100 - (freePct ?? 0))}% used, limit ${limits.ramLimitPct}%${kind === "load" ? ", or the model would not fit under it" : ""}`;
    case "cpu":
      return `CPU is ${Math.round(cpuPct ?? 0)}% busy, limit ${limits.cpuLimitPct}%`;
    case "threads":
      return `${threadsInUse(state.leases)} server threads are running, budget ${threadBudget(coreCount(), limits.cpuLimitPct)}`;
    case "alone":
      return "the model may not fit beside anything else, so it loads only when nothing else runs or is loaded";
    case "load":
      return "another model is loading";
    case "window":
      return `${runningWeight(state.leases)} inferences are running, window ${state.window.w}`;
    default:
      return `${state.waiters.length} requests are queued`;
  }
}

function printWait(p: Poller, denial: Denial | null, state: GovernorState, config: GovernorConfig): void {
  // No reading yet is the normal first half second of any request, and a busy lock says nothing: neither blocks anyone.
  if (denial === null || denial === "stale") return;
  const now = Date.now();
  if (now - p.lastLineAt < WAIT_LINE_INTERVAL_MS) return;
  p.lastLineAt = now;
  process.stderr.write(`llm-ext: local ${p.kind === "load" ? "model load" : "inference"} waiting: ${blockedBy(denial, state, config, p.kind)}; requests queue, nothing fails; bound the wait with --command_timeout\n`);
}

function endPoller(p: Poller): void {
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  pollers.delete(p.key);
}

/**
 * Test hook (TRDD-FC2TX9VU): drop every lease poller of this process. WHY: acquire() starts tick() only for the first
 * waiter of a dir+kind and later waiters rely on that poller's timer. A test that abandons a wait (a timeout, or fake
 * timers whose setTimeout never fires) leaves a poller whose timer is dead, and every later acquire in the file queues
 * behind it for ever. The abandoned waits are neither resolved nor rejected (entry.stop only removes the abort listener,
 * so no unhandled rejection): their callers are already gone.
 */
export function resetGovernorPollersForTests(): void {
  for (const p of pollers.values()) {
    if (p.timer) clearTimeout(p.timer);
    for (const entry of p.queue) entry.stop();
  }
  pollers.clear();
}

function failAll(p: Poller, err: unknown): void {
  const queue = p.queue.splice(0);
  endPoller(p);
  for (const entry of queue) {
    entry.stop();
    entry.reject(err);
  }
  withdrawFrom(p.dir, p.kind);
}

function tick(p: Poller): void {
  p.timer = null;
  const head = p.queue[0];
  let delay: number;
  try {
    throwIfStopped();
    const config = governorConfig();
    // Review M1, m1: a disabled process goes straight to attempt, which hands out a lease and gives back a place it took
    // while enabled. Never the rank logic first: that reads the directory (D2: a disabled process must not need it), and a
    // process disabled while queued below a live head would wait for that head instead of proceeding at once (D13).
    let before: GovernorState | null = null;
    let low = false;
    delay = pollDelayMs(0);
    if (config.enabled) {
      before = readState(p.dir);
      const sameKind = before.waiters.filter((w) => w.kind === p.kind);
      const rank = sameKind.findIndex((w) => w.id === waiterId(p.kind));
      delay = pollDelayMs(Math.max(rank, 0));
      // Only the head can use the lock, so everyone else reads the file and sleeps: 100 waiters do not contend (D7).
      low = waitBehindHead(sameKind, rank, Date.now());
    }
    // More pending here after this one: the place is kept, at the tail (D7), so the process is not dropped and re-added a
    // poll later, behind whoever arrived in between.
    const { lease, denial } = low ? { lease: null, denial: "queued" as const } : attempt(p.dir, head.req, config, p.queue.length > 1);
    if (lease) {
      p.queue.shift();
      head.stop();
      head.resolve(lease);
      if (p.queue.length === 0) {
        endPoller(p);
        return;
      }
    } else if (before) {
      // A disabled attempt always hands out a lease, so a denial comes with the state read above.
      printWait(p, denial, before, config);
    }
  } catch (err) {
    failAll(p, err);
    return;
  }
  // Ref'd on purpose: while a caller awaits a lease this timer is the process's work. It is cleared the moment the
  // last pending acquire settles, so nothing outlives it (launcher-boot.test.ts).
  p.timer = setTimeout(() => tick(p), delay);
}

function removePending(p: Poller, entry: Pending, reason: unknown): void {
  const at = p.queue.indexOf(entry);
  if (at < 0) return;
  p.queue.splice(at, 1);
  entry.stop();
  entry.reject(reason);
  if (p.queue.length > 0) return;
  endPoller(p);
  withdrawFrom(p.dir, p.kind);
}

/**
 * Wait for a lease. Waiting is never an error; it ends in a lease, the abort
 * signal, or a stopped command (--command_timeout), checked on every poll.
 */
export function acquire(req: AcquireRequest, options: AcquireOptions = {}): Promise<Lease> {
  const { signal } = options;
  return new Promise<Lease>((resolve, reject) => {
    signal?.throwIfAborted();
    const dir = governorDir();
    const kind = req.kind ?? "inference";
    const key = `${dir}\0${kind}`;
    const found = pollers.get(key);
    const poller: Poller = found ?? { key, dir, kind, queue: [], timer: null, lastLineAt: 0 };
    pollers.set(key, poller);
    const onAbort = (): void => removePending(poller, entry, signal?.reason);
    const entry: Pending = { req, resolve, reject, stop: () => signal?.removeEventListener("abort", onAbort) };
    signal?.addEventListener("abort", onAbort, { once: true });
    poller.queue.push(entry);
    // One poller per process and kind: its timer serves the whole local queue, so depth adds no polling (D7).
    if (!found) tick(poller);
  });
}
