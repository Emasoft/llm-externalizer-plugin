/**
 * calibration/state.ts — the calibration files every llm-ext process shares
 * (P6; design/specs/local-calibration-design.md section 3):
 *  - `calibration/queue.json`: models waiting for calibration, in order;
 *  - `calibration/seen-models.json`: the managed profiles' model ids at the
 *    last boot, and `used_profiles` (profiles that sent a request), which
 *    together decide trigger 2;
 *  - `calibration/<engine>/<slug>.progress.json`: finished trials (seeds and
 *    outcomes, never input text), for resume;
 *  - `calibration/<engine>/<slug>.lock`: the per-model lock (a pid file).
 * queue.json and seen-models.json change only under `calibration/state.lock`
 * (read-modify-write, atomic rename; round-2 review A8).
 */

import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidState } from "../local-llama-server.js";
import { isRunnerOf, type BrokerEngine } from "../broker/protocol.js";
import { calibrationDir, FIXTURE_VERSION, HARNESS_VERSION, recordSlug, type Fingerprint } from "./record.js";

export interface QueueItem {
  engine: BrokerEngine;
  model: string;
  /** Why it is queued: "first-use" (a held job), "model-change" (trigger 2), "manual" (models calibrate). */
  reason: "first-use" | "model-change" | "manual" | "stale";
  /** models calibrate --force: calibrate even when a valid record exists. */
  force?: boolean;
  at: string;
}

export interface SeenModels {
  /** Managed local profile name -> its model ids (model, second_model, third_model) at the last boot. */
  profiles: Record<string, string[]>;
  /** Profiles that sent at least one request through the broker (trigger 2 applies only to these). */
  used_profiles: string[];
}

const root = (dir: string): string => join(dir, "calibration");
export const queuePath = (dir: string): string => join(root(dir), "queue.json");
export const seenModelsPath = (dir: string): string => join(root(dir), "seen-models.json");
const stateLockPath = (dir: string): string => join(root(dir), "state.lock");

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** A state-lock holder older than this is dead or stuck: every critical section is a few file reads and writes. */
const STATE_LOCK_STALE_MS = 30_000;

/**
 * Take a stale lock directory away atomically (review m1): rename it to a
 * unique name, so of two waiters that both judged it stale only one wins,
 * and the loser can never remove the winner's fresh lock. Then remove the
 * renamed copy (its files, then the directory).
 */
function takeAway(lock: string): void {
  const gone = `${lock}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, gone);
  } catch {
    return; // someone else took it (or it was released): the caller retries
  }
  for (const f of ["owner", "pid"]) {
    try {
      unlinkSync(join(gone, f));
    } catch {
      /* not there */
    }
  }
  rmdirSync(gone);
}

/**
 * Run `fn` under `calibration/state.lock`, waiting at most `waitMs`. Returns
 * undefined when the lock could not be taken in time: the boot trigger waits
 * only briefly and skips itself for that run (it must never block or fail a
 * command); the runner and models calibrate wait longer. The lock holds an
 * `owner` token, so a holder whose lock was taken over as stale never
 * removes the new holder's lock on release (review m1).
 */
export function withStateLock<T>(dir: string, waitMs: number, fn: () => T): T | undefined {
  mkdirSync(root(dir), { recursive: true });
  const lock = stateLockPath(dir);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), token);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STATE_LOCK_STALE_MS) {
          takeAway(lock);
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (Date.now() > deadline) return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    let owner: string | null = null;
    try {
      owner = readFileSync(join(lock, "owner"), "utf8");
    } catch {
      /* taken over and released by another process */
    }
    if (owner === token) {
      unlinkSync(join(lock, "owner"));
      rmdirSync(lock);
    }
  }
}
export function readQueue(dir: string): QueueItem[] {
  const raw = readJson(queuePath(dir)) as { items?: unknown } | null;
  if (!raw || !Array.isArray(raw.items)) return [];
  return (raw.items as QueueItem[]).filter((i) => (i.engine === "llama" || i.engine === "locals") && typeof i.model === "string" && i.model !== "");
}

/** Add a model unless it is already queued (a later --force upgrades the queued item). Caller holds the state lock. */
export function enqueueUnlocked(dir: string, item: Omit<QueueItem, "at">): void {
  const items = readQueue(dir);
  const same = items.find((i) => i.engine === item.engine && i.model === item.model);
  if (same) {
    if (!item.force || same.force) return;
    same.force = true;
  } else items.push({ ...item, at: new Date().toISOString() });
  writeJsonAtomic(queuePath(dir), { version: 1, items });
}

/** Remove a model from the queue (its record was written). Caller holds the state lock. */
export function dequeueUnlocked(dir: string, engine: BrokerEngine, model: string): void {
  const items = readQueue(dir);
  const kept = items.filter((i) => !(i.engine === engine && i.model === model));
  if (kept.length !== items.length) writeJsonAtomic(queuePath(dir), { version: 1, items: kept });
}

export function readSeenModels(dir: string): SeenModels | null {
  const raw = readJson(seenModelsPath(dir)) as Partial<SeenModels> | null;
  if (!raw || typeof raw.profiles !== "object" || raw.profiles === null || !Array.isArray(raw.used_profiles)) return null;
  return { profiles: raw.profiles, used_profiles: raw.used_profiles.filter((p): p is string => typeof p === "string") };
}

export function writeSeenModelsUnlocked(dir: string, seen: SeenModels): void {
  writeJsonAtomic(seenModelsPath(dir), { version: 1, ...seen });
}

// ── Per-model lock ──────────────────────────────────────────────────────

export const modelLockPath = (dir: string, engine: BrokerEngine, model: string): string => join(calibrationDir(dir, engine), `${recordSlug(model)}.lock`);

/**
 * Take the model's lock for this process (a directory holding a `pid` file).
 * It has no time limit: calibration holds it for hours. A lock whose pid is
 * dead or is not this config dir's calibration runner is taken over
 * (`isRunnerOf`, review m1: a runner of another config dir that reused the
 * pid is no holder). Returns false when the live runner holds it.
 *
 * Review m1: the pid file is written under a temp name and renamed, so a
 * reader never sees a half-written one; a lock with no pid file yet that is
 * younger than a few seconds is being created and is left alone; a takeover
 * renames the old lock away atomically, so two takers cannot both win.
 */
export async function acquireModelLock(dir: string, engine: BrokerEngine, model: string, self: (pid: number) => Promise<boolean> = (pid) => isRunnerOf(dir, pid)): Promise<boolean> {
  const lock = modelLockPath(dir, engine, model);
  mkdirSync(calibrationDir(dir, engine), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(lock);
      const tmp = join(lock, `pid.${process.pid}.tmp`);
      writeFileSync(tmp, String(process.pid));
      renameSync(tmp, join(lock, "pid"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const pid = Number(readJson(join(lock, "pid")) ?? NaN);
    if (!Number.isInteger(pid)) {
      let age: number;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      if (age < MODEL_LOCK_CREATING_MS) return false;
    } else if (pid > 1 && pid !== process.pid && pidState(pid) === "alive" && (await self(pid))) return false;
    // Dead holder, a reused pid, or a lock this process left: take it away and retry.
    takeAway(lock);
  }
  return false;
}

/** A model lock without its pid file this young is still being created by its taker. */
const MODEL_LOCK_CREATING_MS = 5000;

export function releaseModelLock(dir: string, engine: BrokerEngine, model: string): void {
  const lock = modelLockPath(dir, engine, model);
  const pid = Number(readJson(join(lock, "pid")) ?? NaN);
  if (pid !== process.pid) return; // not ours (taken over): never remove another runner's lock
  unlinkSync(join(lock, "pid"));
  rmdirSync(lock);
}
// ── Progress (resume) ───────────────────────────────────────────────────

export interface TrialRecord {
  /** "A/known-answer", "B/fact/13107", ... */
  step: string;
  seed: number;
  outcome: "pass" | "fail" | "inconclusive";
  /** Whatever the step needs to decide without re-running (completion tokens, measured rates, ...). Never input text. */
  data?: Record<string, number | string | boolean | null>;
  at: string;
}

export interface Progress {
  harness_version: number;
  fixture_version: number;
  /** null until the cal server was loaded and the weights fingerprinted. */
  fingerprint: Fingerprint | null;
  trials: TrialRecord[];
  /** Phases finished, with their outcome. */
  phases: Record<string, "passed" | "failed">;
  /** Review M2: calibration runs of this model that ended in an exception (reset when a record is written). */
  crashes?: number;
  /** Spec section 2: how often each step was paused after two inconclusive runs in a row (the second pause fails the model). */
  paused?: Record<string, number>;
  /** Spec section 2: cal server crashes counted per step (the third fails the model). */
  stepCrashes?: Record<string, number>;
}

export const progressPath = (dir: string, engine: BrokerEngine, model: string): string => join(calibrationDir(dir, engine), `${recordSlug(model)}.progress.json`);

const emptyProgress = (): Progress => ({ harness_version: HARNESS_VERSION, fixture_version: FIXTURE_VERSION, fingerprint: null, trials: [], phases: {} });

/**
 * The model's progress, kept only while the harness and fixture versions and
 * (once known) the fingerprint still match (spec section 3: resume reuses
 * exactly those trials). Anything else starts fresh.
 */
export function loadProgress(dir: string, engine: BrokerEngine, model: string, fingerprint: Fingerprint | null): Progress {
  const raw = readJson(progressPath(dir, engine, model)) as Partial<Progress> | null;
  if (!raw || raw.harness_version !== HARNESS_VERSION || raw.fixture_version !== FIXTURE_VERSION || !Array.isArray(raw.trials) || typeof raw.phases !== "object" || raw.phases === null) {
    return { ...emptyProgress(), fingerprint };
  }
  const old = raw.fingerprint ?? null;
  if (fingerprint !== null && old !== null && (old.ram_bytes !== fingerprint.ram_bytes || old.blobs.join() !== fingerprint.blobs.join())) return { ...emptyProgress(), fingerprint };
  const counts = (v: unknown): Record<string, number> => (typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number")) : {});
  return {
    harness_version: HARNESS_VERSION,
    fixture_version: FIXTURE_VERSION,
    fingerprint: fingerprint ?? old,
    trials: raw.trials,
    phases: raw.phases,
    crashes: typeof raw.crashes === "number" ? raw.crashes : 0,
    paused: counts(raw.paused),
    stepCrashes: counts(raw.stepCrashes),
  };
}

export function saveProgress(dir: string, engine: BrokerEngine, model: string, p: Progress): void {
  mkdirSync(calibrationDir(dir, engine), { recursive: true });
  writeJsonAtomic(progressPath(dir, engine, model), p);
}
