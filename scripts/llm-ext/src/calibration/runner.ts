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
import type { ChildProcess } from "node:child_process";
import { spawnDetachedChild } from "../bench-spawn.js";
import { CALIBRATE_ARGV, calibratorStatePath, isCalibratorProcess, readCalibratorState, type BrokerEngine, type CalibratorState } from "../broker/protocol.js";
import { claimAndSpawn, roleLogFile, serverLabel, stopOwnServer, type RegistryEntry } from "../broker/registry.js";
import { freePort, parseManagedModel, pidState, spawnLlamaServer, waitReady, withAsyncLock } from "../local-llama-server.js";
import { parseLocalsModel, spawnLocalsServer, waitLocalsReady } from "../local-locals-server.js";
import { getConfigDir } from "../config.js";
import { loadedIdentity, staleness, type LoadedIdentity } from "./fingerprint.js";
import { readRecord, type CalibrationRecord } from "./record.js";
import { acquireModelLock, dequeueUnlocked, loadProgress, readQueue, releaseModelLock, saveProgress, withStateLock, type Progress, type QueueItem } from "./state.js";

/** The phases of the full method, in order (spec section 4). A record is written only once all of them passed. */
export const METHOD_PHASES = ["A", "B", "C"] as const;
export type PhaseName = (typeof METHOD_PHASES)[number];

/** Phase A loads the cal server with one slot at this context (round-2 review N8: an 8k speed prompt plus its output fits). */
export const PHASE_A_CTX = 16384;

export interface CalServer {
  engine: BrokerEngine;
  model: string;
  port: number;
  apiKey: string;
  entry: RegistryEntry;
  /** Locals: the ids its /v1/models lists. */
  baseUrl: string;
  stop: (why: string) => Promise<void>;
}

/** What a phase gets: the loaded server, the progress to append to (saved by `record`), and the log. */
export interface PhaseContext {
  dir: string;
  item: QueueItem;
  server: CalServer;
  /** What the cal server loaded: the record is written with exactly this (spec section 3). */
  identity: LoadedIdentity;
  progress: Progress;
  /** Append a finished trial and save progress atomically. */
  record: (t: Progress["trials"][number]) => void;
  log: (msg: string) => void;
}

export interface Phase {
  name: PhaseName;
  /** "passed", or a failure that ends this model's calibration with `status: calibration-failed`. */
  run: (ctx: PhaseContext) => Promise<{ passed: true } | { passed: false; step: string; message: string }>;
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

/** Start the cal server for one model (one slot, context `ctx`) under the registry's role "cal". */
export async function startCalServer(dir: string, engine: BrokerEngine, model: string, ctx: number, slots: number, log: (m: string) => void): Promise<CalServer> {
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
  try {
    if (engine === "llama") await waitReady(target, entry.pid, () => exited, logFile, apiKey);
    else await waitLocalsReady(target, entry.pid, () => exited, logFile);
  } catch (err) {
    await stop("it did not become ready");
    throw err;
  }
  return { engine, model, port, apiKey, entry, baseUrl: `http://127.0.0.1:${port}`, stop };
}

export interface RunnerOptions {
  dir: string;
  version: string;
  log: (msg: string) => void;
  /** The implemented phases, in order; a model is recorded only when METHOD_PHASES all passed. */
  phases: readonly Phase[];
}

/**
 * The runner loop. Returns why it stopped. One model at a time; each queued
 * model is attempted at most once per run, so a model whose phases are not
 * all implemented (or whose lock another runner holds) cannot spin.
 */
export async function runCalibrator(o: RunnerOptions): Promise<"done" | "handover" | "another-runner" | "stopped"> {
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
  let current: CalServer | null = null;
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
      attempted.add(`${item.engine}\u0000${item.model}`);
      await calibrateOne(o, item, (s) => (current = s));
      current = null;
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

async function calibrateOne(o: RunnerOptions, item: QueueItem, setCurrent: (s: CalServer | null) => void): Promise<void> {
  const name = `${item.engine} '${item.model}'`;
  if (!(await acquireModelLock(o.dir, item.engine, item.model))) {
    o.log(`${name}: another runner holds its lock; skipped`);
    return;
  }
  let server: CalServer | null = null;
  try {
    server = await startCalServer(o.dir, item.engine, item.model, PHASE_A_CTX, 1, o.log);
    setCurrent(server);
    const identity = await loadedIdentity(item.engine, server.baseUrl, server.apiKey, item.model);
    // A valid record that still matches what is loaded (weights, RAM, engine build) needs nothing, unless --force (spec section 3).
    const existing: CalibrationRecord | null = readRecord(o.dir, item.engine, item.model, o.log);
    const stale = existing ? staleness(existing, identity) : null;
    if (existing && !item.force && stale === null) {
      o.log(`${name}: already has a valid, current record (${existing.status}); removed from the queue`);
      withStateLock(o.dir, 60_000, () => {
        dequeueUnlocked(o.dir, item.engine, item.model);
        return true;
      });
      return;
    }
    if (stale !== null) o.log(`${name}: its record is stale (${stale === "weights" ? "the weights or the RAM changed" : `the engine build changed to ${identity.engineVersion}`})`);
    const fingerprint = identity.fingerprint;
    const progress = loadProgress(o.dir, item.engine, item.model, fingerprint);
    saveProgress(o.dir, item.engine, item.model, progress);
    const ctx: PhaseContext = {
      dir: o.dir,
      item,
      server,
      identity,
      progress,
      record: (t) => {
        progress.trials.push(t);
        saveProgress(o.dir, item.engine, item.model, progress);
      },
      log: (m) => o.log(`${name}: ${m}`),
    };
    for (const phase of o.phases) {
      if (progress.phases[phase.name] === "passed") continue;
      const r = await phase.run(ctx);
      progress.phases[phase.name] = r.passed ? "passed" : "failed";
      saveProgress(o.dir, item.engine, item.model, progress);
      if (!r.passed) {
        o.log(`${name}: phase ${phase.name} failed at ${r.step}: ${r.message}`);
        return;
      }
      o.log(`${name}: phase ${phase.name} passed`);
    }
    const missing = METHOD_PHASES.filter((p) => progress.phases[p] !== "passed");
    // Never a record without every phase: a partial record would make the model usable (round-2 review, F13).
    if (missing.length > 0) o.log(`${name}: phases ${missing.join(", ")} are not implemented yet; no record written, the model stays queued`);
  } catch (err) {
    o.log(`${name}: calibration stopped: ${(err as Error).message}`);
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
    const why = await runCalibrator({ dir: getConfigDir(), version, log, phases });
    log(`calibration runner exiting: ${why}`);
    process.exit(0);
  } catch (err) {
    log(`calibration runner failed: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  }
}
