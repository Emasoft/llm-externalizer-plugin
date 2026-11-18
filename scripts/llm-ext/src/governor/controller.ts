/**
 * governor/controller.ts — the admission rules of the local-inference governor
 * as pure functions: state, reading and clock in, new window and verdict out
 * (design/specs/local-inference-governor-design.md D5, D6, D10). No I/O, in the
 * style of broker/scheduler.ts, so every rule is table-tested with a fake clock.
 */

import type { Metrics } from "./metrics.js";
import type { GovernorLimits, GovernorWindow, Lease, ServerEntry, Waiter } from "./state.js";

export interface ControllerConfig {
  cores: number;
  /** This machine's RAM, for the load projection (D11). A parameter, so the rules stay pure. */
  totalBytes: number;
  settleMs: number;
  /** How long a load head its own projection denies keeps yielding to smaller loads behind it (D11, D13). */
  loadYieldMs: number;
}

export interface GovernorConfig {
  /** D13: false opts this process out: it takes no leases, registers no server, and sends directly as before the governor. */
  enabled: boolean;
  /** D10: 0 = half the thread budget; else the T of every llama-server this process starts, 1 up to the budget. */
  serverThreads: number;
  limits: GovernorLimits;
  settleMs: number;
  loadYieldMs: number;
}

/** One request as the controller judges it. `threads` and `serverPid` count against the budget only once granted. */
export interface GrantRequest extends Waiter {
  threads: number;
  serverPid: number | null;
  /** A load's projected RAM, an upper bound (D11); 0 when unknown. */
  bytes?: number;
  /** A load's lower bound: its weights and the headroom. Over the upper bound, a load is admitted alone on this (D11). */
  minBytes?: number;
  /** Round 4: admitted only alone whatever its bounds: a breach of this model taught that its bounds were wrong (D11). */
  alone?: boolean;
  /** RAM the load gives back first: the server a swap stops before it starts the next (D11). */
  outgoingBytes?: number;
}

export type Denial = "queued" | "stale" | "ram" | "cpu" | "window" | "threads" | "load" | "alone";

export interface Decision {
  window: GovernorWindow;
  grant: boolean;
  denial: Denial | null;
  /** The head goes to the tail: its own limit denied it, and a waiter behind it is not bound by that limit (D13). */
  yields: boolean;
}

type View = { metrics: Metrics; window: GovernorWindow; waiters: Waiter[]; leases: Lease[]; servers: ServerEntry[] };

/** Metrics older than this are not a reading of now (D5). */
export const METRICS_MAX_AGE_MS = 2_000;
/** `w` falls back to 1 after this long with no lease (D5). */
export const IDLE_RESET_MS = 60_000;
const CPU_BAND_PCT = 10;
const RAM_BAND_PCT = 5;
/** After a decrease growth waits for the band this long, the hysteresis (D5). */
const BAND_AFTER_DECREASE_MS = 30_000;
/** A head that took no critical section for this long, per rank of whoever checks, counts as stopped (D7). */
export const STOPPED_HEAD_MS = 10_000;
const FAST_POLL_MS = 200;
const FAST_POLL_JITTER_MS = 50;
const FAST_POLL_MAX_RANKS = 4;
const SLOW_POLL_MS = 1_000;

/**
 * Governor D13: the `local_governor` keys of settings.yaml with their env override, range and default. One table for
 * config.ts localGovernorErrors (the settings check) and resolveConfig (the resolver), so a range is written once.
 * server_threads has no fixed maximum: its bound is the thread budget of the machine (resolveConfig).
 * The ram_limit_pct and cpu_limit_pct defaults are 80, not the 90 and 85 they were: owner directive 2026-11-01, verbatim:
 * "never start a new model inference until the memory is gone under 80% and cpu usage under 80%." and "i told you to put
 * safeguards to both memory and cpu usage to limit your usage to max 80%". Do not raise them back to look less strict.
 */
export const LOCAL_GOVERNOR_KEYS = {
  ram_limit_pct: { env: "LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", min: 50, max: 99, fallback: 80 },
  cpu_limit_pct: { env: "LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", min: 10, max: 100, fallback: 80 },
  max_inferences: { env: "LLM_EXT_GOVERNOR_MAX_INFERENCES", min: 1, max: 256, fallback: 8 },
  server_threads: { env: "LLM_EXT_GOVERNOR_SERVER_THREADS", min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
} as const;
export const LOCAL_GOVERNOR_ENABLED_ENV = "LLM_EXT_GOVERNOR_ENABLED";
/**
 * Test-only, env alone like the timings below (D13: never a setting, never in settings.yaml or the documented settings):
 * lowers the minimum of ram_limit_pct, 1 to 50, so the ram-limit and stop burn tests can set a limit a few points under
 * the ambient RAM reading of any machine (review M5: at 30 % used, the D13 minimum 50 could not be put under it).
 */
export const RAM_LIMIT_MIN_TEST_ENV = "LLM_EXT_GOVERNOR_TEST_RAM_LIMIT_MIN";
/** The broker floor variable unit 6 removed. Set, it is an error naming ram_limit_pct, never silently ignored (review m5). */
const OLD_FLOOR_ENV = "LLM_EXT_BROKER_MEMORY_FLOOR";

/** The `local_governor` section of settings.yaml, already checked by config.ts localGovernorErrors; null when absent. */
export interface LocalGovernorSection {
  enabled?: boolean;
  ram_limit_pct?: number;
  cpu_limit_pct?: number;
  max_inferences?: number;
  server_threads?: number;
}

/** Test-only timings, env alone (D13: they are not settings). */
const TIMING_SETTINGS = [
  { env: "LLM_EXT_GOVERNOR_SETTLE_MS", fallback: 2_000 },
  { env: "LLM_EXT_GOVERNOR_LOAD_YIELD_MS", fallback: 120_000 },
] as const;

/**
 * A governor setting that is malformed, out of range, or above the thread budget. Its own class so calibration keeps it
 * off the crash path (runner.ts): a typo ends the command, never counts as a crash of the model (D14).
 */
export class GovernorConfigError extends Error {
  override name = "GovernorConfigError";
}

/** Whether `err`, or an error it wraps (`cause`), is a GovernorConfigError: direct.ts wraps the error of a failed wait. */
export function isGovernorConfigError(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) if (e instanceof GovernorConfigError) return true;
  return false;
}

function envInt(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) throw new GovernorConfigError(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  return value;
}

/** The minimum of ram_limit_pct in force: 50 (D13), or the test-only RAM_LIMIT_MIN_TEST_ENV, validated (fail fast). */
export function ramLimitMin(env: NodeJS.ProcessEnv = process.env): number {
  const { min } = LOCAL_GOVERNOR_KEYS.ram_limit_pct;
  return envInt(env, RAM_LIMIT_MIN_TEST_ENV, 1, min) ?? min;
}

/**
 * The one resolver of the governor settings (D13): env over settings.yaml over the defaults. Pure: governor/settings.ts
 * reads the file. A malformed env value, or a server_threads above the thread budget (`decide` has no alone escape for
 * threads, so such a server could never be admitted), throws a GovernorConfigError naming where it came from (fail fast).
 */
export function resolveConfig(env: NodeJS.ProcessEnv, section: LocalGovernorSection | null, cores: number, where = "settings.yaml"): GovernorConfig {
  const oldFloor = env[OLD_FLOOR_ENV];
  if (oldFloor !== undefined && oldFloor !== "") throw new GovernorConfigError(`${OLD_FLOOR_ENV} is no longer read: the free memory kept is 100 - ram_limit_pct; set local_governor.ram_limit_pct in ${where} (or ${LOCAL_GOVERNOR_KEYS.ram_limit_pct.env}) and unset ${OLD_FLOOR_ENV}, got ${JSON.stringify(oldFloor)}`);
  const rawEnabled = env[LOCAL_GOVERNOR_ENABLED_ENV];
  let enabled = section?.enabled ?? true;
  if (rawEnabled !== undefined && rawEnabled !== "") {
    if (rawEnabled !== "true" && rawEnabled !== "false") throw new GovernorConfigError(`${LOCAL_GOVERNOR_ENABLED_ENV} must be true or false, got ${JSON.stringify(rawEnabled)}`);
    enabled = rawEnabled === "true";
  }
  const pick = (key: "ram_limit_pct" | "cpu_limit_pct" | "max_inferences"): number => {
    const { env: name, min, max, fallback } = LOCAL_GOVERNOR_KEYS[key];
    return envInt(env, name, key === "ram_limit_pct" ? ramLimitMin(env) : min, max) ?? section?.[key] ?? fallback;
  };
  const limits = { ramLimitPct: pick("ram_limit_pct"), cpuLimitPct: pick("cpu_limit_pct"), maxInferences: pick("max_inferences") };
  const budget = threadBudget(cores, limits.cpuLimitPct);
  const threadsEnv = LOCAL_GOVERNOR_KEYS.server_threads.env;
  const threadsText = `an integer from 0 to ${budget} (this process’s thread budget, cores x cpu_limit_pct / 100; 0 = half the budget)`;
  const rawThreads = env[threadsEnv];
  let serverThreads = section?.server_threads ?? 0;
  if (rawThreads !== undefined && rawThreads !== "") {
    if (!/^\d+$/.test(rawThreads) || Number(rawThreads) > budget) throw new GovernorConfigError(`${threadsEnv} must be ${threadsText}, got ${JSON.stringify(rawThreads)}`);
    serverThreads = Number(rawThreads);
  } else if (serverThreads > budget) {
    throw new GovernorConfigError(`local_governor.server_threads in ${where} must be ${threadsText}, got ${serverThreads}`);
  }
  const [settleMs, loadYieldMs] = TIMING_SETTINGS.map(({ env: name, fallback }) => envInt(env, name, 1, Number.MAX_SAFE_INTEGER) ?? fallback);
  return { enabled, limits, serverThreads, settleMs, loadYieldMs };
}
/** A live head that stopped polling. The grace grows with `rank`, so a stopped rank 1 cannot hide a stopped head from the ranks behind it while 100 waiters still do not all rush the lock. */
export function headStopped(head: Waiter, rank: number, now: number): boolean {
  return now - head.polledAt > STOPPED_HEAD_MS * rank;
}

export function threadBudget(cores: number, cpuLimitPct: number): number {
  return Math.max(1, Math.floor((cores * cpuLimitPct) / 100));
}

/**
 * Threads attributed to a Locals (MLX) server, which has no thread option (D10). Measured in unit 5
 * (reports_dev/governor/20261031_210144+0100-thread-measure.md): at most 1.34 cores busy, at 4 requests on a 135M model
 * (one Python thread drives the GPU); rounded up. Not its OS thread count: 12 to 33 threads, nearly all idle.
 */
export const LOCALS_THREADS = 2;

/**
 * The threads a server llm-ext starts is given and counted by (D10), 0 meaning none: no `-t`, and leases that count 0.
 * - cpu_limit_pct 100 with no override: 0, the CPU limit is disabled (D13), so llama.cpp keeps its own default.
 * - Locals: the measured constant, capped at the budget, or at a budget of 1 its every inference would be denied for good.
 * - llama-server: `override` when set, else half the budget rounded down, at least 1, so two servers fit any budget of 2
 *   or more (5 + 5 at budget 11, 85 % of 14 cores, the old default; the 80 % default gives 11 as well). Measured in unit 5,
 *   with layers on the CPU: every slot shares these T threads, so a server busy with any number of requests uses T
 *   cores; on Metal they stay idle (0.12 to 0.33 cores).
 */
export function serverThreads(engine: "llama" | "locals", cores: number, cpuLimitPct: number, override: number): number {
  const budget = threadBudget(cores, cpuLimitPct);
  if (engine === "locals") return cpuLimitPct >= 100 ? 0 : Math.min(LOCALS_THREADS, budget);
  if (override > 0) return override;
  if (cpuLimitPct >= 100) return 0;
  return Math.max(1, Math.floor(budget / 2));
}


/** The RAM llm-ext may bring the machine to: `ram_limit_pct` of all of it (D4). */
export function ramLimitBytes(limits: GovernorLimits, totalBytes: number): number {
  return (totalBytes * limits.ramLimitPct) / 100;
}

/**
 * Whether a load of `bytes` fits (D11, round 3): RAM used by the reading, plus
 * `bookedBytes`, the projections of registered Locals (MLX) servers (an idle
 * MLX server's wired pages drop to 0, so the reading misses it; an active one
 * is counted twice, wired and booked: conservative by design), plus the load,
 * minus `outgoingBytes`, what the server the swap stops first gives back for
 * sure (its ServerEntry.residentBytes, round 4): a Locals server's booked
 * projection, exactly what the books add, or a llama server's weight bytes,
 * which its wired pages in the reading hold at least (measured: weights + 0.2
 * to 0.4 GiB). Never more than either, so the subtraction cannot admit a load
 * on RAM that never frees. llama servers are not booked: the reading has them.
 * An unknown projection (0) fits by construction; decide admits such a load only alone.
 */
export function loadFits(ramUsedPct: number, bytes: number, outgoingBytes: number, limits: GovernorLimits, totalBytes: number, bookedBytes: number): boolean {
  return (ramUsedPct / 100) * totalBytes + bookedBytes + bytes - outgoingBytes <= ramLimitBytes(limits, totalBytes);
}

/** The RAM the reading cannot see: the projections of registered Locals servers, main and cal (round 3, round 4). */
export function bookedBytes(servers: readonly ServerEntry[]): number {
  return servers.reduce((sum, s) => sum + s.bookedBytes, 0);
}
/** A load that could not fit even with nothing else using RAM: a model error at once, never a wait (D6). */
export function neverFits(bytes: number, limits: GovernorLimits, totalBytes: number): boolean {
  return bytes > ramLimitBytes(limits, totalBytes);
}

/** RAM over its limit this long, with someone waiting, gives an idle server back even with no load waiting (D11). */
export const RAM_OVER_UNLOAD_MS = 30_000;

/** The load a server would be unloaded for: what it needs and what the reading says now (D11). */
export interface UnloadNeed {
  ramUsedPct: number;
  bytes: number;
  outgoingBytes: number;
  limits: GovernorLimits;
  totalBytes: number;
}

/**
 * The bytes a load must find room for: its projection, or its lower bound when it is marked alone (round 4), unknown (0) or
 * the projection could never fit and the load runs alone (round 2 #1).
 */
export function neededBytes(request: Pick<GrantRequest, "bytes" | "minBytes" | "alone">, limits: GovernorLimits, totalBytes: number): number {
  const upper = request.bytes ?? 0;
  return request.alone === true || upper === 0 || neverFits(upper, limits, totalBytes) ? (request.minBytes ?? upper) : upper;
}

/**
 * The server whose owner should stop it to give RAM back (D11): the least
 * recently used one with no inference running on it, not the requester's own
 * (its RAM is the outgoing share already counted), at most one per settle
 * interval. One at a time, so 100 brokers never empty the machine for one load.
 * A flag is not consulted: the caller clears flags older than a settle interval,
 * so an owner that never acted cannot block the next choice (round 2 #2). With a
 * load waiting (`need`), a server is chosen only if the load would fit once every
 * idle server gave its RAM back: unloading that cannot make room only costs the
 * owner a reload (round 2 #9). With RAM over its limit for 30 s and no load
 * denied, `need` asks for 0 bytes: a server is chosen only if giving every idle
 * one back brings the books under the limit (round 4 #7).
 */
export function pickUnload(servers: readonly ServerEntry[], leases: readonly Lease[], requesterPid: number, lastUnloadAt: number, now: number, settleMs: number, need: UnloadNeed | null = null): ServerEntry | null {
  if (now - lastUnloadAt < settleMs) return null;
  // Round 4 #4: never a cal server: its runner stops its own server and does not poll the flag.
  const idle = servers.filter((s) => s.role === "main" && s.ownerPid !== requesterPid && !leases.some((l) => l.kind === "inference" && l.serverPid === s.pid));
  if (need !== null) {
    const freed = idle.reduce((sum, s) => sum + s.residentBytes, 0);
    if (!loadFits(need.ramUsedPct, need.bytes, need.outgoingBytes + freed, need.limits, need.totalBytes, bookedBytes(servers))) return null;
  }
  return idle.reduce<ServerEntry | null>((lru, s) => (lru === null || s.lastUsedAt < lru.lastUsedAt ? s : lru), null);
}

/** Inference weight running now. A load lease is not an inference: it has its own one-at-a-time rule (D11). */
export function runningWeight(leases: Lease[]): number {
  return leases.reduce((sum, l) => sum + (l.kind === "inference" ? l.weight : 0), 0);
}

/** Threads of servers with an inference running. A server counts once, by its first lease (D10). */
export function threadsInUse(leases: Lease[]): number {
  const counted = new Set<number>();
  let sum = 0;
  for (const l of leases) {
    if (l.kind !== "inference") continue;
    if (l.serverPid !== null) {
      if (counted.has(l.serverPid)) continue;
      counted.add(l.serverPid);
    }
    sum += l.threads;
  }
  return sum;
}

/** The AIMD step of D5. `over` and `under` leave a band between them, the hysteresis. */
export function stepWindow(
  window: GovernorWindow,
  reading: { cpuPct: number; ramUsedPct: number },
  running: number,
  limits: GovernorLimits,
  now: number,
  settleMs: number,
): GovernorWindow {
  const next = { ...window, lastRunAt: running > 0 ? now : window.lastRunAt };
  if (running === 0 && next.w !== 1 && now - next.lastRunAt >= IDLE_RESET_MS) return { ...next, w: 1, changedAt: now };
  const settled = now - next.changedAt >= settleMs;
  if (isOver(reading, limits)) {
    const w = Math.max(1, Math.floor(next.w / 2));
    return settled && w !== next.w ? { ...next, w, changedAt: now, lastDecreaseAt: now } : next;
  }
  // The band is hysteresis after a decrease and nothing else: applied always, it held w at 1 for good on a machine
  // sitting at 81.7 percent with a limit of 85 (the old default, now 80; the hysteresis reasoning is unchanged).
  const cpuUnder = limits.cpuLimitPct >= 100 || reading.cpuPct < limits.cpuLimitPct - CPU_BAND_PCT;
  const under = now - next.lastDecreaseAt >= BAND_AFTER_DECREASE_MS || (cpuUnder && reading.ramUsedPct < limits.ramLimitPct - RAM_BAND_PCT);
  if (under && running >= next.w && settled && next.w < limits.maxInferences) return { ...next, w: next.w + 1, changedAt: now };
  return next;
}

function cpuOver(reading: { cpuPct: number }, limits: GovernorLimits): boolean {
  // cpu_limit_pct 100 is the documented way to switch the CPU ceiling off (D13); a busy machine does read 100.
  return limits.cpuLimitPct < 100 && reading.cpuPct >= limits.cpuLimitPct;
}

function isOver(reading: { cpuPct: number; ramUsedPct: number }, limits: GovernorLimits): boolean {
  return cpuOver(reading, limits) || reading.ramUsedPct >= limits.ramLimitPct;
}

/** The verdict on one request. Only the head of its kind may grant itself or move the window (D7). */
export function decide(view: View, request: GrantRequest, now: number, config: ControllerConfig): Decision {
  const denied = (window: GovernorWindow, denial: Denial, yields = false): Decision => ({ window, grant: false, denial, yields });
  const [head, ...behind] = view.waiters.filter((w) => w.kind === request.kind);
  if (head?.id !== request.id) return denied(view.window, "queued");
  const { cpuPct, freePct } = view.metrics;
  if (cpuPct === null || freePct === null || now - view.metrics.at > METRICS_MAX_AGE_MS) return denied(view.window, "stale");

  const { limits } = request;
  const reading = { cpuPct, ramUsedPct: 100 - freePct };
  const running = runningWeight(view.leases);
  const window = stepWindow(view.window, reading, running, limits, now, config.settleMs);
  const limited = (l: GovernorLimits): boolean => reading.ramUsedPct >= l.ramLimitPct || cpuOver(reading, l);
  // A limit binds only its own request (D13). A head its own limit denies steps aside for a waiter that limit does not
  // bind, and leaves the window alone: holding the queue, it would let one strict process stop every laxer one while
  // nothing runs, and a reading that only falls when something changes would never set it free.
  const blockedByOwn = (denial: Denial, laxer: (w: Waiter) => boolean): Decision => {
    const yields = behind.some((w) => !limited(w.limits) && laxer(w));
    return denied(yields ? view.window : window, denial, yields);
  };

  // RAM has no floor: CPU overload slows a machine, RAM exhaustion takes it down (D6).
  if (reading.ramUsedPct >= limits.ramLimitPct) return blockedByOwn("ram", () => true);
  // TRDD-ZTO9K8EK: CPU has no floor either. The owner directive (2026-11-01, quoted at LOCAL_GOVERNOR_KEYS) is to never start
  // a new inference while CPU is at or over the limit; the old floor granted one after 30 s, which starts work the directive
  // forbids. So a waiter stays denied however long it has waited and whatever is running, and only --command_timeout ends
  // the wait. Cost: while other programs keep CPU over the limit, local inference waits.
  if (cpuOver(reading, limits)) return blockedByOwn("cpu", () => true);
  if (request.kind === "load") {
    // A load's RAM shows in the reading only gradually, so two at once would each see the other's room (D11).
    if (view.leases.some((l) => l.kind === "load")) return denied(window, "load");
    // Round 2 #10: a head its own projection denies yields to smaller loads behind it (D13), but only for
    // loadYieldMs. Without the bound a stream of small loads that each fit would keep a big one waiting forever.
    const mayYield = (): boolean => now - request.since < config.loadYieldMs;
    const upper = request.bytes ?? 0;
    const outgoing = request.outgoingBytes ?? 0;
    // Round 3: inferences judge RAM on the reading alone (their KV is allocated at load); a load also counts the books.
    const booked = bookedBytes(view.servers);
    if (request.alone === true || upper === 0 || neverFits(upper, limits, config.totalBytes)) {
      // Round 2 #4: an unknown upper bound (0: no figures before a first download, or no context known) is a load of
      // unknown size, never one admitted as if it were free. Round 2 #1: the same holds for an upper bound (weights + full
      // KV + cache) over the limit while the caller found the lower bound
      // (weights + headroom) under it, or it would have failed the model. The real need lies between the two, so the
      // load runs only alone: no inference running and no other owner's server holding RAM, under the watchdog. Round 4:
      // so does a load marked `alone` after a breach of its model: its bounds proved wrong, whatever they say now.
      const alone = !view.leases.some((l) => l.kind === "inference") && !view.servers.some((s) => s.ownerPid !== request.holder.pid);
      if (!alone) return blockedByOwn("alone", mayYield);
      if (!loadFits(reading.ramUsedPct, request.minBytes ?? upper, outgoing, limits, config.totalBytes, booked)) return blockedByOwn("ram", mayYield);
      return { window, grant: true, denial: null, yields: false };
    }
    // The projection is the head's own figure: a smaller load behind it may fit where it does not (D13).
    if (!loadFits(reading.ramUsedPct, upper, outgoing, limits, config.totalBytes, booked)) return blockedByOwn("ram", mayYield);
    return { window, grant: true, denial: null, yields: false };
  }
  // A weight above `w` runs alone; without this it could never run at all (D9).
  if (running > 0 && running + request.weight > Math.min(window.w, limits.maxInferences)) {
    // Only its own max_inferences is its own limit. A full window binds everybody, and a heavy head must not lose its
    // turn to lighter ones behind it.
    if (limits.maxInferences > view.window.w) return denied(window, "window");
    return blockedByOwn("window", (w) => w.limits.maxInferences > limits.maxInferences);
  }

  const onRunningServer = request.serverPid !== null && view.leases.some((l) => l.kind === "inference" && l.serverPid === request.serverPid);
  const added = onRunningServer ? 0 : request.threads;
  const budget = threadBudget(config.cores, limits.cpuLimitPct);
  if (added > 0 && threadsInUse(view.leases) + added > budget) return blockedByOwn("threads", (w) => threadBudget(config.cores, w.limits.cpuLimitPct) > budget);
  return { window, grant: true, denial: null, yields: false };
}

/**
 * The next poll of a waiter at `rank` (0 = head of its kind). The first ranks
 * poll fast whatever the free capacity: a release wakes nobody, so a rank that
 * slept 1 to 2 s would learn only then that it became head. Measured: 2 grants
 * a second when only the free ranks polled fast, with 3 slots and 300 ms holds.
 */
export function pollDelayMs(rank: number, random: () => number = Math.random): number {
  return rank < FAST_POLL_MAX_RANKS ? FAST_POLL_MS + random() * FAST_POLL_JITTER_MS : SLOW_POLL_MS + random() * SLOW_POLL_MS;
}
