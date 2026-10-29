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

import { randomBytes } from "node:crypto";
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
import { loadedIdentity, staleness, type LoadedIdentity } from "./fingerprint.js";
import { FIXTURE_VERSION, HARNESS_VERSION, readRecord, writeRecord, type CalibrationRecord } from "./record.js";
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
  /** Trials per counter before the sequential extension (spec 4.3: 5). */
  trials: number;
}

export const PRODUCTION_HARNESS: Harness = { phaseACtx: PHASE_A_CTX, windowCap: 32768, steps: null, trials: 5 };

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
  const h = { ...PRODUCTION_HARNESS, ...v };
  const posInt = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;
  if (!posInt(h.phaseACtx) || !posInt(h.windowCap) || !posInt(h.trials) || (h.steps !== null && !(Array.isArray(h.steps) && h.steps.length > 0 && h.steps.every(posInt)))) {
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
   */
  run: (ctx: PhaseContext) => Promise<{ passed: true } | { passed: false; step: string; message: string; paused?: boolean }>;
}

export const calibratorLogPath = (dir: string): string => join(dir, "calibrator-local.log");
const handoverPath = (dir: string): string => join(dir, "calibrator-handover.json");
const runnerLockPath = (dir: string): string => join(dir, "calibrator.lock");

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
 */
export async function startCalServer(dir: string, engine: BrokerEngine, model: string, ctx: number, slots: number, log: (m: string) => void, onClaimed?: (s: { stop: (why: string) => Promise<void> }) => void): Promise<CalServer> {
  let llamaArgv: string[] = [];
  if (engine === "llama") {
    const parsed = parseManagedModel(model);
    if ("error" in parsed) throw new Error(parsed.error);
    llamaArgv = parsed.argv;
  } else {
    const parsed = parseLocalsModel(model);
    if ("error" in parsed) throw new Error(parsed.error);
  }
  const port = await freePort();
  const target = { port, model, ctx, slots };
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
        const l = await spawnLocalsServer(target, logFile, logFile);
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
  };
  // Review M3: from here on the caller can stop the server, while it is still loading (a load can take minutes).
  onClaimed?.({ stop });
  try {
    if (engine === "llama") await waitReady(target, entry.pid, () => exited, logFile, apiKey);
    else await waitLocalsReady(target, entry.pid, () => exited, logFile);
  } catch (err) {
    await stop("it did not become ready");
    throw err;
  }
  return { engine, model, port, apiKey, entry, baseUrl: `http://127.0.0.1:${port}`, ctx, slots, alive: () => !exited, stop };
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
  const onSignal = (sig: string): void => {
    stopping = true;
    o.log(`signal ${sig}: stopping after cleanup`);
    void (current?.stop(`runner ${sig}`) ?? Promise.resolve()).finally(() => {
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
      const r = await calibrateOne(o, item, (s) => (current = s));
      current = null;
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

/** Review m5: the runner gave way to the broker's work for too long; the model stays queued (not a crash). */
class PausedError extends Error {}

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

async function calibrateOne(o: RunnerOptions, item: QueueItem, setCurrent: (s: { stop: (why: string) => Promise<void> } | null) => void): Promise<"done" | "crashed" | "paused"> {
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
  const failedRecord = (step: string, message: string): CalibrationRecord =>
    engineCheck && existing
      ? // The record keeps its measured body; only the status says the new build failed the quick check.
        { ...existing, status: "engine-check-failed", failed_step: step, message }
      : {
          schema: 1,
          harness_version: HARNESS_VERSION,
          fixture_version: FIXTURE_VERSION,
          engine: item.engine,
          model: item.model,
          // Review M2: a model that never loaded has no blobs to name; the record still ends the wait with the reason.
          fingerprint: identity?.fingerprint ?? { blobs: [], ram_bytes: totalmem() },
          engine_version: identity?.engineVersion ?? "unknown",
          engine_version_checked: identity?.engineVersion ?? "unknown",
          status: "calibration-failed",
          failed_step: step,
          message,
          calibrated_at: new Date().toISOString(),
          duration_s: Math.round((Date.now() - startedAt) / 1000),
        };
  try {
    await waitForTurn(o.dir, item.engine, item.model, (m) => o.log(`${name}: ${m}`));
    server = await startCalServer(o.dir, item.engine, item.model, harness.phaseACtx, 1, o.log, (s) => setCurrent(s));
    const loadMs = Date.now() - startedAt;
    setCurrent(server);
    identity = await loadedIdentity(item.engine, server.baseUrl, server.apiKey, item.model, o.dir);
    // A valid record that still matches what is loaded (weights, RAM, engine build, method version) needs nothing, unless --force (spec section 3).
    existing = readRecord(o.dir, item.engine, item.model, o.log);
    const stale = existing ? staleness(existing, identity) : null;
    if (existing && !item.force && stale === null) {
      // Review C1: rewrite it, so a broker that marked the record stale (mtime and size) sees a change and checks again.
      writeRecord(o.dir, existing);
      o.log(`${name}: already has a valid, current record (${existing.status}); removed from the queue`);
      dequeue();
      return "done";
    }
    if (stale !== null) o.log(`${name}: its record is stale (${stale === "weights" ? "the weights, the RAM or the calibration method changed" : `the engine build changed to ${identity.engineVersion}`})`);
    // Spec section 3, "Quick check only": a new engine build re-runs Phase A on a record that is otherwise valid;
    // a calibration-failed record, new weights or --force recalibrate from scratch.
    engineCheck = existing !== null && stale === "engine" && !item.force && existing.status !== "calibration-failed";
    const fingerprint = identity.fingerprint;
    const progress = loadProgress(o.dir, item.engine, item.model, fingerprint);
    if (item.force) {
      // --force re-runs everything (spec section 3): no finished trial is reused.
      progress.trials = [];
      progress.phases = {};
      progress.crashes = 0;
      progress.paused = {};
      progress.stepCrashes = {};
    }
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
      record: (t) => {
        progress.trials.push(t);
        saveProgress(o.dir, item.engine, item.model, progress);
      },
      save: () => saveProgress(o.dir, item.engine, item.model, progress),
      waitForTurn: () => waitForTurn(o.dir, item.engine, item.model, (m) => o.log(`${name}: ${m}`)),
      stopServer: async (why) => {
        const s = server;
        server = null;
        setCurrent(null);
        if (s) await s.stop(why);
      },
      restart: async (c, slots) => {
        await ctx.stopServer(`restart at ctx ${c}, ${slots} slot(s)`);
        const t0 = Date.now();
        server = await startCalServer(o.dir, item.engine, item.model, c, slots, o.log, (s) => setCurrent(s));
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
      progress.crashes = 0;
      saveProgress(o.dir, item.engine, item.model, progress);
      o.log(`${name}: ${line}`);
      dequeue();
      return "done";
    };
    for (const phase of engineCheck ? o.phases.filter((p) => p.name === "A") : o.phases) {
      if (progress.phases[phase.name] === "passed") continue;
      const r = await phase.run(ctx);
      // Spec section 2: a paused step (two inconclusive runs in a row) leaves the model queued; the runner goes on to the
      // next model and retries the step on its next pass. The phase is neither passed nor failed.
      if (!r.passed && r.paused === true) {
        o.log(`${name}: step ${r.step} paused (${r.message}); the model stays queued`);
        return "done";
      }
      progress.phases[phase.name] = r.passed ? "passed" : "failed";
      saveProgress(o.dir, item.engine, item.model, progress);
      // Spec 4.2: a failed phase ends this model with a record that says why; held jobs then fail at once with it.
      if (!r.passed) return finish(failedRecord(r.step, r.message), `phase ${phase.name} failed at ${r.step}: ${r.message}`);
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
    if (missing.length > 0) o.log(`${name}: phases ${missing.join(", ")} are not implemented yet; no record written, the model stays queued`);
    return "done";
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof PausedError) {
      o.log(`${name}: ${msg}; the model stays queued`);
      return "paused";
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
