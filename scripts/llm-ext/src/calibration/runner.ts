/**
 * calibration/runner.ts — the detached calibration runner `llm-ext
 * __calibrate` (P6; design/specs/local-calibration-design.md sections 2 and 3).
 *
 * One runner per config dir works through `calibration/queue.json`, one model
 * at a time across both engines: it takes the model's lock, starts its own
 * cal server (registry role "cal", so at most one main plus one cal per
 * engine), fingerprints the loaded weights, runs the method's phases with
 * progress saved after each trial (a crash or a SIGKILL resumes there), stops
 * the cal server and releases the lock. A model whose record is written
 * leaves the queue. The runner exits when every queued model was attempted
 * once in this run, or for a version handover.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totalmem } from "node:os";
import type { ChildProcess } from "node:child_process";
import { spawnDetachedChild } from "../bench-spawn.js";
import { CALIBRATE_ARGV, calibratorStatePath, isCalibratorProcess, readBrokerState, readCalibratorState, TOKEN_HEADER, type BrokerEngine, type CalibratorState } from "../broker/protocol.js";
import { claimAndSpawn, roleLogFile, serverLabel, stopOwnServer, type RegistryEntry } from "../broker/registry.js";
import { freePort, parseManagedModel, pidState, spawnLlamaServer, waitReady, withAsyncLock } from "../local-llama-server.js";
import { parseLocalsModel, spawnLocalsServer, waitLocalsReady } from "../local-locals-server.js";
import { getConfigDir } from "../config.js";
import * as gov from "../governor/client.js";
import { isGovernorConfigError, neverFits } from "../governor/controller.js";
import { isGovernorDirError } from "../governor/state.js";
import { governorConfig } from "../governor/settings.js";
import { estimateFromFiles, estimateOnDisk, loadBounds, weightFilesOnDisk } from "../governor/estimate.js";
import { LOAD_LEASE_MS, LOCALS_CACHE_MAX_GB, LOCALS_CACHE_MIN_GB, LoadBreachError, learnedLowerBound, loadFigures, localsCacheGb, neverFitsMessage, readyBooking, watchLoad, type LoadWatch } from "../governor/load.js";
import { loadedIdentity, staleness, type LoadedIdentity } from "./fingerprint.js";
import { memoryWaitExpired, memoryWaitPrecheck, memoryWaitTick } from "./memory-wait.js";
import { FIXTURE_VERSION, HARNESS_VERSION, memoryVerdictStale, okRecordFrom, PRODUCTION_HARNESS_ID, readRecord, writeRecord, type CalibrationRecord, type MemoryJudged } from "./record.js";
import { acquireModelLock, dequeueUnlocked, loadProgress, readQueue, releaseModelLock, saveProgress, withStateLock, type Progress, type QueueItem } from "./state.js";

/** The phases of the full method, in order (spec section 4). A record is written only once all of them passed. */
export const METHOD_PHASES = ["A", "B", "C"] as const;
export type PhaseName = (typeof METHOD_PHASES)[number];

/** Phase A loads the cal server with one slot at this context (round-2 review N8: an 8k speed prompt plus its output fits). */
export const PHASE_A_CTX = 16384;

/**
 * The calibration harness: the sizes the method runs at. Production uses
 * PRODUCTION_HARNESS; a reduced harness (spec 9 "Real" and 10, the dry run)
 * comes from LLM_EXT_CALIBRATION_HARNESS, so a run can be checked in minutes.
 */
export interface Harness {
  /** Phase A context (spec 4.2). */
  phaseACtx: number;
  /** The largest calibration window W (spec 4.1: 32768). */
  windowCap: number;
  /** Phase B grid steps in tokens; null = the spec 4.3 grid (2048, 4096, 8192 and 0.40 x W). */
  steps: number[] | null;
  /** The record's `harness` id (D4): PRODUCTION_HARNESS_ID, or "custom:<sha256 of the LLM_EXT_CALIBRATION_HARNESS JSON>". */
  id: string;
  /** Trials per counter before the sequential extension (spec 4.3: 5). */
  trials: number;
  /** Phase C main-slot candidates (spec 4.5: 1, 2, 4, 8). */
  mainSlots: number[];
  /** Phase C scouting shares in tokens per request (spec 4.5: 2048, 4096). */
  scoutShares: number[];
  /** Phase C scouting slot counts (spec 4.5: 4, 8). */
  scoutSlots: number[];
}

/** Any change here must bump HARNESS_VERSION (record.ts): records are compared by harness id and version only (D4). */
export const PRODUCTION_HARNESS: Harness = {
  id: PRODUCTION_HARNESS_ID,
  phaseACtx: PHASE_A_CTX,
  windowCap: 32768,
  steps: null,
  trials: 5,
  mainSlots: [1, 2, 4, 8],
  scoutShares: [2048, 4096],
  scoutSlots: [4, 8],
};

/** The harness of this run: LLM_EXT_CALIBRATION_HARNESS (JSON, partial) over the production one. A malformed value is an error, never ignored. */
export function harnessFromEnv(env: NodeJS.ProcessEnv): Harness {
  const raw = env.LLM_EXT_CALIBRATION_HARNESS;
  if (raw === undefined || raw === "") return PRODUCTION_HARNESS;
  let v: Partial<Harness>;
  try {
    v = JSON.parse(raw) as Partial<Harness>;
  } catch {
    throw new Error(`LLM_EXT_CALIBRATION_HARNESS is not JSON: ${raw}`);
  }
  // D4: a custom harness is named by the hash of its JSON, so its record never passes for a production one.
  const h: Harness = { ...PRODUCTION_HARNESS, ...v, id: `custom:${createHash("sha256").update(raw).digest("hex")}` };
  const posInt = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;
  const posList = (l: unknown): boolean => Array.isArray(l) && l.length > 0 && l.every(posInt);
  if (!posInt(h.phaseACtx) || !posInt(h.windowCap) || !posInt(h.trials) || (h.steps !== null && !posList(h.steps)) || !posList(h.mainSlots) || !posList(h.scoutShares) || !posList(h.scoutSlots)) {
    throw new Error(`LLM_EXT_CALIBRATION_HARNESS has an invalid field: ${raw}`);
  }
  return h;
}

export interface CalServer {
  engine: BrokerEngine;
  model: string;
  port: number;
  apiKey: string;
  entry: RegistryEntry;
  /** Locals: the ids its /v1/models lists. */
  baseUrl: string;
  /** The context per slot and the slot count it was started with. */
  ctx: number;
  slots: number;
  /**
   * D10, round 2 M4: what every calibration lease on this server carries, so the budget counts it once, by its T. One
   * object passed into each lease (phase-a.ts, phase-c.ts): a test's fake server without it leases with neither.
   */
  lease: { threads: number; serverPid: number };
  /** False once the server process exited (a crash, or a stop). */
  alive: () => boolean;
  stop: (why: string) => Promise<void>;
}

/** What a phase gets: the loaded server, the progress to append to (saved by `record`), and the log. */
export interface PhaseContext {
  dir: string;
  item: QueueItem;
  /** The current cal server; `restart` replaces it. */
  server: CalServer;
  harness: Harness;
  /** What the cal server loaded: the record is written with exactly this (spec section 3). */
  identity: LoadedIdentity;
  /** How long the cal server took to load and become ready (reported by Phase A). */
  loadMs: number;
  progress: Progress;
  /** Append a finished trial and save progress atomically. */
  record: (t: Progress["trials"][number]) => void;
  /** Save progress after a phase changed it in place (dropped trials, a step pause). */
  save: () => void;
  /** Wait while the broker serves another model (spec section 2, review m5); throws after 5 minutes of pausing. */
  waitForTurn: () => Promise<void>;
  /** Stop the cal server (spec 4.1: free memory is measured with the model unloaded). */
  stopServer: (why: string) => Promise<void>;
  /** Start the cal server again with `ctx` per slot and `slots` slots (spec 2: the runner restarts it freely); updates `server` and `loadMs`. */
  restart: (ctx: number, slots: number) => Promise<void>;
  /** The last lines of the cal server log (for a crash report). */
  logTail: () => string;
  log: (msg: string) => void;
}

export interface Phase {
  name: PhaseName;
  /**
   * "passed"; a failure that ends this model with `status: calibration-failed`; or a paused step
   * (spec section 2: two inconclusive runs in a row), which leaves the model queued for the runner's next pass.
   * `memory` marks the two memory outcomes (coordinator decision 2026-10-29): "too-big" is a calibration-failed record
   * that stores what it was judged against (rule 1); "memory-limited" is its own record status, never a failure (rule 2).
   */
  run: (ctx: PhaseContext) => Promise<{ passed: true } | { passed: false; step: string; message: string; paused?: boolean; memory?: MemoryOutcome }>;
}

/** The two memory outcomes of a phase (coordinator decision 2026-10-29, rules 1 and 2). */
export type MemoryOutcome = { kind: "too-big"; judged: MemoryJudged } | { kind: "memory-limited" };

/**
 * Rule 2: the skips a memory-limited calibration starts again from (fresh pass counters): every inconclusive or given-up
 * skip counted by rule A. An over-total-RAM skip ("memory") is a judgment, not a pass count, and is kept.
 */
const PASS_COUNTED_SKIPS: readonly string[] = ["memory-wait", "timeout", "transport"];

export const calibratorLogPath = (dir: string): string => join(dir, "calibrator-local.log");
const handoverPath = (dir: string): string => join(dir, "calibrator-handover.json");
const runnerLockPath = (dir: string): string => join(dir, "calibrator.lock");
/** How long a stop signal waits for the model in flight to record its outcome before the runner exits anyway. */
const STOP_SETTLE_MS = 10_000;

/** A live runner of this config dir, or null. */
export async function liveCalibrator(dir: string): Promise<CalibratorState | null> {
  const s = readCalibratorState(dir);
  if (!s || pidState(s.pid) !== "alive" || !(await isCalibratorProcess(s.pid))) return null;
  return s;
}

/**
 * Make sure a runner works on the queue (spec section 2). Never waits for it:
 * a command process must not hold a timer or handle (launcher-boot.test.ts),
 * and the runner itself refuses to start beside a live one, so two callers
 * racing here start at most one working runner. A live runner of another
 * version is asked to hand over: it exits after its current model, and the
 * next caller (the broker re-checks every 5 s while it holds jobs) starts
 * this version's.
 */
export async function ensureCalibrator(o: { dir: string; version: string; entry: string; env?: NodeJS.ProcessEnv }): Promise<"running" | "started" | "handover-requested"> {
  const live = await liveCalibrator(o.dir);
  if (live && live.version === o.version) return "running";
  if (live) {
    writeFileSync(handoverPath(o.dir), JSON.stringify({ version: o.version, at: new Date().toISOString() }));
    return "handover-requested";
  }
  mkdirSync(o.dir, { recursive: true });
  spawnDetachedChild({
    command: process.execPath,
    args: [o.entry, CALIBRATE_ARGV],
    logPath: calibratorLogPath(o.dir),
    env: { ...(o.env ?? process.env), LLM_EXT_CONFIG_DIR: o.dir },
    onError: (e) => process.stderr.write(`[llm-externalizer] the calibration runner failed to start: ${e.message}\n`),
  });
  return "started";
}

/**
 * Start the cal server for one model (one slot, context `ctx`) under the registry's role "cal".
 * Review M3: `onClaimed` receives the stop handle as soon as the server is spawned and registered,
 * before it is ready (a load can take minutes), so a signal in that window stops it too.
 * Round 4 #6: `learnedMinBytes` is what an earlier breach of this model taught (its saved "load" memory wait): the
 * lower bound is at least that, and the load is admitted only alone, like the broker's after a breach.
 */
export async function startCalServer(dir: string, engine: BrokerEngine, model: string, ctx: number, slots: number, log: (m: string) => void, onClaimed?: (s: { stop: (why: string) => Promise<void> }) => void, learnedMinBytes = 0): Promise<CalServer> {
  let llamaArgv: string[] = [];
  if (engine === "llama") {
    const parsed = parseManagedModel(model);
    if ("error" in parsed) throw new Error(parsed.error);
    llamaArgv = parsed.argv;
  } else {
    const parsed = parseLocalsModel(model);
    if ("error" in parsed) throw new Error(parsed.error);
  }
  // Governor D11: a cal server is a model load like the broker's, so it waits for the machine's one load grant, and
  // holds it from before the spawn to ready, no longer. Round 2 #4: it carries a projection too, for its own context
  // and slots, from the weight files on disk (the fingerprint of an earlier record names them for an org/repo:quant
  // model). Unknown on a first download: the size is not known before the download ends, so it loads alone.
  const limits = governorConfig().limits;
  // Governor D10: a cal server gets the same T as a main one (spec D10); a malformed server_threads throws before the
  // load grant is asked for. Calibration records are measured under this T; -t is not in a record's identity (D10).
  const threads = gov.spawnThreads(engine);
  const est = estimateOnDisk(engine, model, readRecord(dir, engine, model, log)?.fingerprint.blobs ?? null);
  const cache = engine === "locals" ? LOCALS_CACHE_MAX_GB * 1024 ** 3 : 0;
  // Round 5 M2(a): a Locals lower bound includes the smallest prompt cache, so an alone grant implies cache room.
  const bounds = est === null ? { bytes: 0, minBytes: 0 } : loadBounds(est, ctx * slots, cache, engine === "locals" ? LOCALS_CACHE_MIN_GB * 1024 ** 3 : 0);
  const minBytes = Math.max(bounds.minBytes, learnedMinBytes);
  const alone = learnedMinBytes > 0;
  // Round 2 #1: the lower bound decides never-fits. Thrown as a plain error, so it counts as a crash of this model and
  // ends in a failed record after MAX_CRASHES, with this message.
  if (neverFits(minBytes, limits, totalmem())) throw new Error(neverFitsMessage(model, minBytes, limits));
  // Round 4 #2, #3, #4: the cal server's two RAM figures for the governor's books, and the rest its Locals prompt cache
  // must leave room for (loadFigures, shared with the broker's main server).
  const figures = loadFigures(engine, { bytes: bounds.bytes, minBytes, weightBytes: est?.weight_bytes ?? 0, alone }, limits);
  const lease = await gov.acquire({ kind: "load", timeoutMs: LOAD_LEASE_MS, bytes: bounds.bytes, minBytes, alone });
  let watch: LoadWatch | null = null;
  try {
    let breach: number | null = null;
    let failure: Error | null = null;
    let stopForBreach: (() => void) | null = null;
    watch = await watchLoad(limits, (observed, err) => {
      breach = observed;
      failure = err;
      log(err !== null ? `cal server load stopped by the governor watchdog: ${err.message}` : `cal server load stopped by the governor watchdog: RAM reached its limit after ${Math.round(observed / 2 ** 20)} MiB of growth`);
      stopForBreach?.();
    });
    // Round 2 #5: the same --cache-gb rule as the broker's main server. 0 would unbound the cache, so no room is a wait.
    // Round 4 #3: the room is the reading plus every booked Locals server (an idle one is missing from the reading).
    const rest = figures.cacheRestBytes;
    const cacheGb = engine === "locals" ? localsCacheGb(watch.baselineBytes + gov.bookedBytesNow(), rest, limits) : undefined;
    if (cacheGb === null) throw new LoadBreachError("no-cache-room", 0, rest + LOCALS_CACHE_MIN_GB * 1024 ** 3, `under ${LOCALS_CACHE_MIN_GB} GiB of RAM is left for the cal server's prompt cache of '${model}'`);
    const port = await freePort();
    const target = { port, model, ctx, slots, threads };
    const logFile = roleLogFile(dir, "cal", engine);
    const apiKey = randomBytes(24).toString("hex");
    let exited = false;
    let cwd: string | undefined;
    const entry = await claimAndSpawn({
      dir,
      engine,
      role: "cal",
      ownerPid: process.pid,
      log,
      spawn: async () => {
        let s: { pid: number; argv: string[]; child: ChildProcess };
        if (engine === "llama") s = await spawnLlamaServer(target, llamaArgv, logFile, apiKey);
        else {
          const l = await spawnLocalsServer(target, logFile, logFile, cacheGb);
          cwd = l.cwd;
          s = l;
        }
        s.child.once("exit", () => {
          exited = true;
        });
        log(`spawned cal ${serverLabel(engine)} pid ${s.pid} model '${model}' ctx ${ctx} slots ${slots} port ${port}`);
        return { pid: s.pid, pgid: s.pid, port, argv: s.argv, model, ctx };
      },
    });
    const stop = async (why: string): Promise<void> => {
      try {
        const how = await stopOwnServer(dir, engine, entry, log);
        log(`stopped cal ${serverLabel(engine)} pid ${entry.pid} (${why}): ${how}`);
        // The Locals server's fresh cwd (empty: Locals writes nothing there); rmdir, never a recursive delete.
        if (cwd !== undefined) {
          try {
            rmdirSync(cwd);
          } catch (e) {
            log(`left the Locals working directory ${cwd}: ${(e as Error).message}`);
          }
        }
      } finally {
        // Round 4 #4, #5: forgotten whatever the stop's outcome, so a cal server never stays booked after its stop.
        try {
          gov.unregisterServer(entry.pid);
        } catch (e) {
          log(`could not remove cal server pid ${entry.pid} from the governor: ${(e as Error).message}`);
        }
      }
    };
    stopForBreach = () => void stop("the RAM limit was reached while it loaded").catch((e: Error) => log(`stop failed: ${e.message}`));
    if (breach !== null) stopForBreach();
    // Review M3: from here on the caller can stop the server, while it is still loading (a load can take minutes).
    onClaimed?.({ stop });
    const stopped = (): Error | null => {
      // Round 2 #3: a load the watchdog could not see is an error (fail fast; counted as a crash). A breach is a wait,
      // and what it teaches is a lower bound (round 4 #1), saved by calibrateOne as the model's memory wait (#6).
      if (failure !== null) return failure;
      return breach !== null ? new LoadBreachError("breach", breach, learnedLowerBound(minBytes, breach), `the cal server of '${model}' was stopped at the RAM limit while it loaded`) : null;
    };
    try {
      // Round 4 #4: booked from the spawn, while it loads, like a main server; before the load grant goes (finally), and
      // not caught: a server the governor cannot book is stopped below and the error counts as a crash (fail fast).
      gov.registerServer(entry.pid, { bookedBytes: figures.bookedBytes, residentBytes: figures.residentBytes, engine, role: "cal", threads });
      if (engine === "llama") await waitReady(target, entry.pid, () => exited, logFile, apiKey);
      else await waitLocalsReady(target, entry.pid, () => exited, logFile);
    } catch (err) {
      await stop("it did not become ready");
      // The model waits, it did not fail: the runner leaves it queued and counts no crash (D11).
      throw stopped() ?? err;
    }
    // Round 2 #8: the watch ends at ready. A breach seen before that already stopped the server, even if it answered
    // ready first: that is the breach path, never a server handed to Phase C that is about to die.
    const growth = watch.stop();
    const cut = stopped();
    if (cut !== null) {
      await stop("the governor watchdog stopped its load");
      throw cut;
    }
    if (engine === "locals") {
      // Round 5 M1: booked at ready by what it can really hold (readyBooking), the figures read again from the weight
      // files when there were none before the load. None at all is an error: stopped, and counted as a crash.
      try {
        const booking = readyBooking(figures.bookedBytes, est ?? estimateFromFiles("locals", weightFilesOnDisk("locals", model, null)), ctx * slots, cacheGb ?? 0, growth);
        gov.registerServer(entry.pid, { bookedBytes: booking, residentBytes: booking, engine, role: "cal", threads });
      } catch (err) {
        await stop("it could not be booked with the governor");
        throw err;
      }
    }
    return { engine, model, port, apiKey, entry, baseUrl: `http://127.0.0.1:${port}`, ctx, slots, lease: { threads, serverPid: entry.pid }, alive: () => !exited, stop };
  } finally {
    watch?.stop();
    gov.release(lease);
  }
}

export interface RunnerOptions {
  dir: string;
  version: string;
  log: (msg: string) => void;
  /** The implemented phases, in order; a model is recorded only when METHOD_PHASES all passed. */
  phases: readonly Phase[];
  /** Default PRODUCTION_HARNESS. */
  harness?: Harness;
}

/**
 * The runner loop. Returns why it stopped. One model at a time; each queued
 * model is attempted at most once per run, so a model whose phases are not
 * all implemented (or whose lock another runner holds) cannot spin.
 */
export async function runCalibrator(o: RunnerOptions): Promise<"done" | "handover" | "another-runner" | "stopped" | "paused"> {
  // Round 2 M5: a malformed or out-of-budget server_threads (settings.yaml or env), or any malformed governor setting,
  // ends the run here, before the runner claims
  // the dir or starts a model. Thrown at the first cal server instead, it took the crash path and wrote a failed record
  // for every queued model after MAX_CRASHES: a configuration typo persisted as model failures.
  gov.spawnThreads("llama");
  // One runner per config dir: checked and claimed under the runner lock, so racing starters leave exactly one.
  const claimed = await withAsyncLock(runnerLockPath(o.dir), async () => {
    const live = await liveCalibrator(o.dir);
    if (live && live.pid !== process.pid) return false;
    const tmp = `${calibratorStatePath(o.dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, version: o.version, startedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(tmp, calibratorStatePath(o.dir));
    return true;
  });
  if (!claimed) {
    o.log("another calibration runner is working on this config dir; exiting");
    return "another-runner";
  }
  let current: { stop: (why: string) => Promise<void> } | null = null;
  let stopping = false;
  // Review of 2411e6dc, finding F: the model being calibrated when a signal arrives must log and save its "not counted
  // as a crash" outcome before the process exits, so onSignal waits for it (bounded: a phase stuck past the server
  // stop must not keep a stopped runner alive).
  let inflight: Promise<unknown> | null = null;
  const onSignal = (sig: string): void => {
    stopping = true;
    o.log(`signal ${sig}: stopping after cleanup`);
    void (current?.stop(`runner ${sig}`) ?? Promise.resolve())
      .then(() => Promise.race([(inflight ?? Promise.resolve()).catch(() => undefined), new Promise((r) => setTimeout(r, STOP_SETTLE_MS))]))
      .finally(() => {
        removeOwnState(o.dir);
        process.exit(0);
      });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const attempted = new Set<string>();
  try {
    for (;;) {
      if (stopping) return "stopped";
      if (handoverRequested(o.dir, o.version)) {
        o.log("a newer llm-ext asked for a handover: exiting");
        return "handover";
      }
      const item = readQueue(o.dir).find((i) => !attempted.has(`${i.engine}\u0000${i.model}`));
      if (!item) return "done";
      const one = calibrateOne(o, item, (s) => (current = s), () => stopping);
      inflight = one;
      const r = await one;
      inflight = null;
      if (r === "paused") return "paused";
      // A crash is retried at once; the model's crash counter (progress) bounds it, then a failure record ends it.
      if (r !== "crashed") attempted.add(`${item.engine}\u0000${item.model}`);
    }
  } finally {
    removeOwnState(o.dir);
  }
}

function handoverRequested(dir: string, version: string): boolean {
  try {
    const h = JSON.parse(readFileSync(handoverPath(dir), "utf8")) as { version?: unknown };
    return typeof h.version === "string" && h.version !== version;
  } catch {
    return false;
  }
}

function removeOwnState(dir: string): void {
  if (readCalibratorState(dir)?.pid !== process.pid) return;
  unlinkSync(calibratorStatePath(dir));
  if (existsSync(handoverPath(dir))) unlinkSync(handoverPath(dir));
}

/** Review M2: a model whose calibration crashes (an exception, not a phase verdict) this many times gets a calibration-failed record. */
export const MAX_CRASHES = 3;
/** Round 4 #6: the progress memory-wait key of a model load the governor watchdog stopped (phase steps are "A/…" etc.). */
export const LOAD_WAIT_STEP = "load";
/** Round 5 m4: the memory-wait key of a cal load that found no room for its prompt cache: a wait, never a learned bound. */
export const LOAD_CACHE_WAIT_STEP = "load-cache";

/** Review m5: the runner gave way to the broker's work for too long; the model stays queued (not a crash). */
class PausedError extends Error {}

/**
 * The runner got SIGTERM or SIGINT (for example from `models server-stop`, which stops the runner before its cal
 * server). From then on its cal server is being stopped, so a failed request, a dead server or a phase verdict is the
 * stop itself, not something the model did: nothing is recorded or counted, and the model stays queued with the
 * trials finished before the signal (TRDD-1OOAH3LD, review of 2a3ac697: a user stop must never move a model toward
 * calibration-failed).
 */
class RunnerStopping extends Error {}

/** How the runner waits for the broker's other work (spec section 2, review m5). */
const TURN_POLL_MS = 2000;
const TURN_MAX_PAUSE_MS = 5 * 60_000;

/**
 * Wait until the broker of `dir` (if any) has no queued or running work for
 * another model (spec section 2: calibration pauses for real requests; held
 * jobs of THIS model do not pause it). Throws PausedError after 5 minutes of
 * pausing, so the cal server is stopped and the model is retried later.
 */
export async function waitForTurn(dir: string, engine: BrokerEngine, model: string, log: (m: string) => void): Promise<void> {
  const started = Date.now();
  let said = false;
  for (;;) {
    const st = readBrokerState(dir);
    let busy = false;
    if (st && pidState(st.pid) === "alive") {
      try {
        const res = await fetch(`http://127.0.0.1:${st.port}/v1/health`, { headers: { [TOKEN_HEADER]: st.token }, signal: AbortSignal.timeout(5000) });
        const h = (await res.json()) as { models?: Array<{ engine?: string; model?: string; queued?: number; running?: number }> };
        busy = (h.models ?? []).some((m) => !(m.engine === engine && m.model === model) && (m.queued ?? 0) + (m.running ?? 0) > 0);
      } catch {
        busy = false; // no answering broker: nothing to give way to
      }
    }
    if (!busy) return;
    if (!said) log("pausing: the broker is serving another model");
    said = true;
    if (Date.now() - started > TURN_MAX_PAUSE_MS) throw new PausedError("paused for the broker's work for 5 minutes");
    await new Promise((r) => setTimeout(r, TURN_POLL_MS));
  }
}

async function calibrateOne(o: RunnerOptions, item: QueueItem, setCurrent: (s: { stop: (why: string) => Promise<void> } | null) => void, isStopping: () => boolean): Promise<"done" | "crashed" | "paused"> {
  const name = `${item.engine} '${item.model}'`;
  const harness = o.harness ?? PRODUCTION_HARNESS;
  if (!(await acquireModelLock(o.dir, item.engine, item.model))) {
    o.log(`${name}: another runner holds its lock; skipped`);
    return "done";
  }
  let server: CalServer | null = null;
  let identity: LoadedIdentity | null = null;
  let existing: CalibrationRecord | null = null;
  let engineCheck = false;
  const startedAt = Date.now();
  const dequeue = (): void => {
    withStateLock(o.dir, 60_000, () => {
      dequeueUnlocked(o.dir, item.engine, item.model);
      return true;
    });
  };
  const failedRecord = (step: string, message: string, status: "calibration-failed" | "memory-limited" = "calibration-failed"): CalibrationRecord =>
    engineCheck && existing && status === "calibration-failed"
      ? // The record keeps its measured body; only the status says the new build failed the quick check.
        { ...existing, status: "engine-check-failed", failed_step: step, message }
      : {
          schema: 2,
          harness: harness.id,
          harness_version: HARNESS_VERSION,
          fixture_version: FIXTURE_VERSION,
          engine: item.engine,
          model: item.model,
          // Review M2: a model that never loaded has no blobs to name; the record still ends the wait with the reason.
          fingerprint: identity?.fingerprint ?? { blobs: [], ram_bytes: totalmem() },
          engine_version: identity?.engineVersion ?? "unknown",
          engine_version_checked: identity?.engineVersion ?? "unknown",
          status,
          failed_step: step,
          message,
          calibrated_at: new Date().toISOString(),
          duration_s: Math.round((Date.now() - startedAt) / 1000),
        };
  try {
    // Review of 2411e6dc, finding 2: a Phase C candidate still waiting for free memory is re-checked with the model
    // unloaded, so a pass does not load the model only for Phase C to unload it again (about every minute while
    // requests are held). A forced run (--force) skips the check only on the pass that resets the progress (its waits
    // are dropped there); coordinator decision 2026-10-30: once the reset is stamped (Progress.forced_at), later passes
    // check like any other, so a forced run waiting for memory loads nothing and its wait accumulates.
    const firstRead = loadProgress(o.dir, item.engine, item.model, null, harness.id);
    // A stamp with no forced item (its queue entry was removed by hand before a record was written) must not survive this
    // pass: dropped later, in the reset block, a pass that ends early on a valid record (below) would leave it, and a later
    // --force would find it, skip the reset and resume the old progress instead of re-measuring.
    if (!item.force && firstRead.forced_at !== undefined) {
      delete firstRead.forced_at;
      saveProgress(o.dir, item.engine, item.model, firstRead);
    }
    const resetPending = item.force === true && firstRead.forced_at === undefined;
    const waiting = resetPending ? null : await memoryWaitPrecheck(o.dir, item.engine, item.model, harness.id);
    if (waiting !== null) {
      o.log(`${name}: ${waiting}; the model is not loaded on this pass and stays queued`);
      return "done";
    }
    await waitForTurn(o.dir, item.engine, item.model, (m) => o.log(`${name}: ${m}`));
    // Round 4 #6: a breach of an earlier load left a memory wait under LOAD_WAIT_STEP; the precheck above let this pass
    // load (memory is back, or the wait is over), and the load carries what the breach taught.
    let learnedMinBytes = firstRead.memoryWait?.[LOAD_WAIT_STEP]?.need ?? 0;
    server = await startCalServer(o.dir, item.engine, item.model, harness.phaseACtx, 1, o.log, (s) => setCurrent(s), learnedMinBytes);
    const loadMs = Date.now() - startedAt;
    setCurrent(server);
    identity = await loadedIdentity(item.engine, server.baseUrl, server.apiKey, item.model, o.dir);
    // A valid record that still matches what is loaded (weights, RAM, engine build, method version) needs nothing, unless --force (spec section 3).
    existing = readRecord(o.dir, item.engine, item.model, o.log);
    const stale = existing ? staleness(existing, identity, harness.id) : null;
    // Coordinator decision 2026-10-29: a memory-limited record is never final (whoever queued it wants it measured), and a
    // "too big for this machine's memory" record whose total RAM or memory floor changed is judged again (rules 1, 2).
    const memoryRedo = existing === null ? null : existing.status === "memory-limited" ? "it only waited for free memory" : memoryVerdictStale(existing);
    if (existing && !item.force && stale === null && memoryRedo === null) {
      // Review C1: rewrite it, so a broker that marked the record stale (mtime and size) sees a change and checks again.
      writeRecord(o.dir, existing);
      o.log(`${name}: already has a valid, current record (${existing.status}); removed from the queue`);
      dequeue();
      return "done";
    }
    if (memoryRedo !== null) o.log(`${name}: calibrated again: ${memoryRedo}`);
    if (stale !== null) o.log(`${name}: its record is stale (${stale === "weights" ? "the weights, the RAM or the calibration method changed" : `the engine build changed to ${identity.engineVersion}`})`);
    // Spec section 3, "Quick check only": a new engine build re-runs Phase A on a record that is otherwise valid;
    // a calibration-failed record, new weights or --force recalibrate from scratch.
    engineCheck = existing !== null && stale === "engine" && !item.force && existing.status !== "calibration-failed";
    const fingerprint = identity.fingerprint;
    const progress = loadProgress(o.dir, item.engine, item.model, fingerprint, harness.id);
    if (item.force && progress.forced_at === undefined) {
      // --force re-runs everything (spec section 3): no finished trial is reused. Coordinator decision 2026-10-30: the
      // reset happens once.
      // The queue item keeps `force` until the record is written; resetting on every pass restarted each paused step
      // and dropped each memory wait, so a forced run on a busy machine could loop forever. The stamp (set below)
      // makes later passes resume this progress; it is removed when a record is written (finish, the crash record).
      progress.trials = [];
      progress.phases = {};
      progress.crashes = 0;
      progress.paused = {};
      progress.stepCrashes = {};
      progress.memoryWait = {};
      progress.forced_at = new Date().toISOString();
    }
    // Round 4 #6: the load reached ready, so a wait a breach left for it is over (the phases keep their own waits).
    // Round 5 n3: the rest of this pass (Phase C restarts) no longer carries the learned bound either.
    if (progress.memoryWait !== undefined) {
      delete progress.memoryWait[LOAD_WAIT_STEP];
      delete progress.memoryWait[LOAD_CACHE_WAIT_STEP];
    }
    learnedMinBytes = 0;
    if (engineCheck) {
      // Phase A's earlier trials measured the old build: they are dropped and A runs again; B and C stay.
      progress.trials = progress.trials.filter((t) => !t.step.startsWith("A/"));
      delete progress.phases.A;
    }
    saveProgress(o.dir, item.engine, item.model, progress);
    const ctx: PhaseContext = {
      dir: o.dir,
      item,
      server,
      harness,
      identity,
      loadMs,
      progress,
      // After a stop signal nothing is saved: a trial or a step crash then comes from the stop (RunnerStopping).
      record: (t) => {
        if (isStopping()) throw new RunnerStopping("the runner is stopping");
        progress.trials.push(t);
        saveProgress(o.dir, item.engine, item.model, progress);
      },
      save: () => {
        if (isStopping()) throw new RunnerStopping("the runner is stopping");
        saveProgress(o.dir, item.engine, item.model, progress);
      },
      waitForTurn: () => waitForTurn(o.dir, item.engine, item.model, (m) => o.log(`${name}: ${m}`)),
      stopServer: async (why) => {
        const s = server;
        server = null;
        setCurrent(null);
        if (s) await s.stop(why);
      },
      restart: async (c, slots) => {
        if (isStopping()) throw new RunnerStopping("the runner is stopping");
        await ctx.stopServer(`restart at ctx ${c}, ${slots} slot(s)`);
        const t0 = Date.now();
        server = await startCalServer(o.dir, item.engine, item.model, c, slots, o.log, (s) => setCurrent(s), learnedMinBytes);
        setCurrent(server);
        ctx.server = server;
        ctx.loadMs = Date.now() - t0;
      },
      logTail: () => {
        try {
          return readFileSync(roleLogFile(o.dir, "cal", item.engine), "utf8").split("\n").slice(-20).join("\n");
        } catch {
          return "(no cal server log)";
        }
      },
      log: (m) => o.log(`${name}: ${m}`),
    };
    const finish = (r: CalibrationRecord, line: string): "done" => {
      writeRecord(o.dir, r);
      // Coordinator decision 2026-10-30: the forced run ends with its record; a later --force resets again.
      delete progress.forced_at;
      progress.crashes = 0;
      saveProgress(o.dir, item.engine, item.model, progress);
      o.log(`${name}: ${line}`);
      dequeue();
      return "done";
    };
    for (const phase of engineCheck ? o.phases.filter((p) => p.name === "A") : o.phases) {
      if (progress.phases[phase.name] === "passed") continue;
      const r = await phase.run(ctx);
      if (isStopping()) throw new RunnerStopping("the runner is stopping");
      // Spec section 2: a paused step (two inconclusive runs in a row) leaves the model queued; the runner goes on to the
      // next model and retries the step on its next pass. The phase is neither passed nor failed.
      if (!r.passed && r.paused === true) {
        o.log(`${name}: step ${r.step} paused (${r.message}); the model stays queued`);
        return "done";
      }
      if (!r.passed && r.memory?.kind === "memory-limited") {
        // Rule 2 (coordinator decision 2026-10-29): no verdict. The phase stays unfinished, and the next calibration
        // starts with fresh pass counters: the pass-counted skips and the memory waits are dropped now.
        progress.trials = progress.trials.filter((t) => !(typeof t.data?.skipped === "string" && PASS_COUNTED_SKIPS.includes(t.data.skipped)));
        progress.memoryWait = {};
        saveProgress(o.dir, item.engine, item.model, progress);
        // Review m1: a forced calibration (--force) of a model whose ok record still matches what is loaded only waited for
        // free memory: no new verdict, so the valid measurement is kept (rewritten, so a broker that marked it stale checks
        // again) and the forced run ends. A memory-limited record over it would fail the model's jobs for an hour.
        if (existing?.status === "ok" && stale === null) return finish(existing, `phase ${phase.name} memory-limited at ${r.step} (${r.message}); the existing ok record is kept, run models calibrate --model ${item.model} --force again once memory is free`);
        return finish(failedRecord(r.step, r.message, "memory-limited"), `phase ${phase.name} memory-limited at ${r.step}: ${r.message}`);
      }
      progress.phases[phase.name] = r.passed ? "passed" : "failed";
      saveProgress(o.dir, item.engine, item.model, progress);
      // Spec 4.2: a failed phase ends this model with a record that says why; held jobs then fail at once with it.
      // Rule 1: a model too big for this machine's memory keeps what it was judged against, so a change re-checks it.
      if (!r.passed) {
        const rec = failedRecord(r.step, r.message);
        return finish(r.memory?.kind === "too-big" ? { ...rec, memory_judged: r.memory.judged } : rec, `phase ${phase.name} failed at ${r.step}: ${r.message}`);
      }
      o.log(`${name}: phase ${phase.name} passed`);
    }
    if (engineCheck && existing) {
      if (progress.phases.A !== "passed") {
        o.log(`${name}: the engine quick check needs Phase A, which this runner does not have; no record change, the model stays queued`);
        return "done";
      }
      // The quick check passed: the record now vouches for this build too (the broker's stale stamp changes, held jobs are released).
      // An earlier failed check (engine-check-failed) is cleared by a pass on this build.
      return finish({ ...existing, status: "ok", failed_step: null, message: undefined, engine_version_checked: identity.engineVersion }, `the engine quick check passed on ${identity.engineVersion}; record updated`);
    }
    const missing = METHOD_PHASES.filter((p) => progress.phases[p] !== "passed");
    // Never a record without every phase: a partial record would make the model usable (round-2 review, F13).
    if (missing.length > 0) {
      o.log(`${name}: phases ${missing.join(", ")} are not in this runner; no record written, the model stays queued`);
      return "done";
    }
    const ok = okRecordFrom(
      {
        harness: harness.id,
        harness_version: HARNESS_VERSION,
        fixture_version: FIXTURE_VERSION,
        engine: item.engine,
        model: item.model,
        fingerprint: identity.fingerprint,
        engine_version: identity.engineVersion,
        engine_version_checked: identity.engineVersion,
        calibrated_at: new Date().toISOString(),
        duration_s: Math.round((Date.now() - startedAt) / 1000),
      },
      progress.trials,
    );
    return finish(ok, `calibrated (${harness.id}): fill_tokens fact ${ok.fill_tokens?.fact}, aggregate ${ok.fill_tokens?.aggregate}, bug ${ok.fill_tokens?.bug}; main ${ok.main?.slots} slot(s) of ${ok.main?.slot_ctx}; ${ok.scouting_candidates?.length ?? 0} scouting candidate(s) (the threshold is applied when the record is read)`);
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof RunnerStopping || isStopping()) {
      o.log(`${name}: stopped by a signal (${msg}); not counted as a crash, the model stays queued`);
      return "paused";
    }
    // Unit 6 (D14): a governor setting made invalid while this run goes on (settings.yaml is read again when it changes,
    // and a lowered cpu_limit_pct can put server_threads over the budget) ends the run like the check at its start: a
    // configuration error is the user's to fix, never a crash of this model, which would write failed records.
    // Review M1: an unusable governor directory ends the run the same way, never counted as a crash of the model and never
    // persisted as its failure after MAX_CRASHES: the directory is the user's to fix (or enabled: false, D2).
    if (isGovernorConfigError(err) || isGovernorDirError(err)) throw err;
    if (err instanceof PausedError) {
      o.log(`${name}: ${msg}; the model stays queued`);
      return "paused";
    }
    // Governor D11: a load stopped at the RAM limit is a wait for memory, never a crash of the model. Round 4 #6: what the
    // breach taught is saved as the model's memory wait (need = the learned lower bound), so memoryWaitPrecheck loads
    // nothing on later passes until that much is free above the floor; the next load carries it and runs alone. A wait
    // over MEMORY_WAIT_MAX_MS of checks takes the memory-limited path, as a phase's memory wait does (rule 2).
    if (err instanceof LoadBreachError) {
      // Round 5 m4: no room for the prompt cache is a wait under its own key: its need gates the next pass but never
      // becomes the learned lower bound or the alone mark, which only a breach of the model's size teaches.
      const step = err.reason === "breach" ? LOAD_WAIT_STEP : LOAD_CACHE_WAIT_STEP;
      const p = loadProgress(o.dir, item.engine, item.model, null, harness.id);
      const waits = (p.memoryWait ??= {});
      const wait = memoryWaitTick(waits[step], Math.max(err.needBytes, waits[step]?.need ?? 0), Date.now());
      if (!memoryWaitExpired(wait)) {
        waits[step] = wait;
        saveProgress(o.dir, item.engine, item.model, p);
        o.log(`${name}: ${msg}; it waits for ${Math.round(wait.need / 2 ** 20)} MiB free above the floor, and the model stays queued`);
        return "paused";
      }
      p.memoryWait = {};
      delete p.forced_at;
      saveProgress(o.dir, item.engine, item.model, p);
      const prior = readRecord(o.dir, item.engine, item.model, o.log);
      // Review m1, as in the phases: a forced run (--force) of a model with an ok record only waited for memory, so that
      // record is kept (rewritten, so a broker that marked it stale checks again). Any other run came here because the
      // record is missing or stale, and nothing loaded can tell which: the memory-limited record is the honest verdict.
      const kept = item.force === true && prior?.status === "ok" ? prior : null;
      writeRecord(o.dir, kept ?? failedRecord(step, msg, "memory-limited"));
      o.log(`${name}: ${kept ? "the existing ok record is kept" : "memory-limited"}: its load waited ${Math.round(wait.waited_ms / 60_000)} min for free memory (${msg})`);
      dequeue();
      return "done";
    }
    // Review M2: an exception is counted per model; at MAX_CRASHES the model gets a record with the error, so held
    // jobs fail with it instead of waiting while the runner reloads the model every minute.
    const p = loadProgress(o.dir, item.engine, item.model, null);
    p.crashes = (p.crashes ?? 0) + 1;
    saveProgress(o.dir, item.engine, item.model, p);
    o.log(`${name}: calibration stopped (${p.crashes} of ${MAX_CRASHES}): ${msg}`);
    if (p.crashes < MAX_CRASHES) return "crashed";
    writeRecord(o.dir, failedRecord("runner/error", `calibration stopped ${p.crashes} times; the last error: ${msg}`));
    p.crashes = 0;
    // The record ends a forced run too (coordinator decision 2026-10-30): a later --force resets again.
    delete p.forced_at;
    saveProgress(o.dir, item.engine, item.model, p);
    o.log(`${name}: ${MAX_CRASHES} crashes: wrote a ${engineCheck ? "engine-check-failed" : "calibration-failed"} record`);
    dequeue();
    return "done";
  } finally {
    if (server) await server.stop("model finished");
    setCurrent(null);
    releaseModelLock(o.dir, item.engine, item.model);
  }
}
/** `llm-ext __calibrate` (cli/main.ts): run the runner, then end the process explicitly (like the broker). */
export async function runCalibratorMain(version: string, phases: readonly Phase[] = []): Promise<never> {
  const log = (msg: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  };
  try {
    const why = await runCalibrator({ dir: getConfigDir(), version, log, phases, harness: harnessFromEnv(process.env) });
    log(`calibration runner exiting: ${why}`);
    process.exit(0);
  } catch (err) {
    log(`calibration runner failed: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  }
}
