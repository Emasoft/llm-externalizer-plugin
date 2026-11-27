/**
 * governor/state.ts — the per-user state directory of the local-inference
 * governor: where it is, who may use it, the short lock and the reaping
 * (design/specs/local-inference-governor-design.md D1, D2, D3).
 *
 * Every mutation is a sync critical section of a few ms that never spans an
 * await. A busy lock is reported, not waited on, so a broker's event loop never
 * blocks; rename makes state-1.json a consistent snapshot for lockless readers.
 * An unusable directory is an error naming the path: a governor that passes
 * through silently is no limit at all.
 */

import { execFile, execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pidState } from "../local-llama-server.js";
import { emptyMetrics, type Metrics } from "./metrics.js";

export type LeaseKind = "inference" | "load";

/** A process. `start` tells it from a later process with the same pid; it is empty on Windows, where pid alone identifies. */
export interface Holder {
  pid: number;
  start: string;
}

export interface GovernorLimits {
  ramLimitPct: number;
  cpuLimitPct: number;
  maxInferences: number;
}

export interface GovernorWindow {
  w: number;
  changedAt: number;
  /** When an inference last ran, for the 60 s return to 1: `changedAt` cannot tell an idle window from a steady one. */
  lastRunAt: number;
  /** When `w` last halved: for 30 s after it growth needs the band, the hysteresis (D5). */
  lastDecreaseAt: number;
}

export interface Waiter {
  id: string;
  kind: LeaseKind;
  weight: number;
  holder: Holder;
  since: number;
  /** Its last critical section, or when it became head: a rank below the head does not poll the lock, so only a head has a live stamp. */
  polledAt: number;
  limits: GovernorLimits;
}

export interface Lease {
  id: string;
  kind: LeaseKind;
  weight: number;
  threads: number;
  serverPid: number | null;
  bytes: number;
  holder: Holder;
  at: number;
  expiresAt: number;
}

export interface ServerEntry {
  pid: number;
  start: string;
  ownerPid: number;
  ownerStart: string;
  threads: number;
  /**
   * Round 4: RAM the books add for it, which the reading cannot see: a Locals (MLX) server's projection (its wired
   * pages drop to 0 while idle); 0 for llama, whose weights the reading has as wired pages.
   */
  bookedBytes: number;
  /**
   * Round 4: RAM stopping it gives back for sure, the most a swap or an unload may subtract: a Locals server's booked
   * projection (exactly what the books add), a llama server's weight bytes (its measured wired rise is weights + 0.2 to
   * 0.4 GiB), 0 when unknown. Never more than it really holds, or a load would be admitted on RAM that never frees.
   */
  residentBytes: number;
  lastUsedAt: number;
  wantUnload: boolean;
  engine: "llama" | "locals";
  /** Round 4: a cal server is booked like a main one but never asked to unload: its runner does not poll the flag. */
  role: "main" | "cal";
}

/** Why a waiter was last refused, as the waiter prints it, by whom and when (D13 status). */
export interface LastDenial {
  kind: LeaseKind;
  reason: string;
  pid: number;
  at: number;
}

export interface GovernorState {
  metrics: Metrics;
  window: GovernorWindow;
  waiters: Waiter[];
  leases: Lease[];
  servers: ServerEntry[];
  /** When a start-time check last ran. Shared, because the head changes often and each new head would otherwise run its own `ps`. */
  pidCheckAt: number;
  /** When a server was last asked to unload: at most one per settle interval (D11). */
  lastUnloadAt: number;
  /** Since when a waiter's own RAM limit has been over, null while it is not: 30 s of it gives an idle server back (D11). */
  ramOverSince: number | null;
  /** Unit 6: the last denial, for server-status (D13); null until one. Optional on read: an older file is still whole. */
  lastDenial: LastDenial | null;
}

/** The schema is in the file name, so a future incompatible one coexists during an upgrade (D3). */
const STATE_FILE = "state-1.json";
const LOCK_DIR = "lock";
/** Holders never refresh the lock, because they never hold it this long (D2). */
export const LOCK_STALE_MS = 5_000;
const PS_TIMEOUT_MS = 30_000;
// lstart prints local time in the locale of the ps: pin both, or two processes with different TZ values would
// read each other's start strings as a reused pid and reap a live holder.
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

/** The directory for given facts. Pure, so the default names are testable without touching the real one. */
export function governorDirFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, user: () => { uid: number; username: string }, tmp: () => string): string {
  const override = env.LLM_EXT_GOVERNOR_DIR;
  if (override) return override;
  try {
    const { uid, username } = user();
    if (platform === "win32") return join(tmp(), `llm-ext-governor-${username.replace(/[^A-Za-z0-9._-]/g, "_")}`);
    // Fixed under /tmp: HOME and TMPDIR differ between tests and workers, and any difference would silently
    // split one machine into several governors, each with the full limit.
    return `/tmp/llm-ext-governor-${uid}`;
  } catch (err) {
    throw new Error(`cannot name the governor directory, this user has no account entry: ${(err as Error).message}. Set LLM_EXT_GOVERNOR_DIR`, { cause: err });
  }
}

export function governorDir(): string {
  return governorDirFor(process.env, process.platform, () => userInfo(), tmpdir);
}

/**
 * An unusable governor directory (another uid, a file, a symlink, an I/O error). Its own class so calibration keeps it
 * off the crash path like a GovernorConfigError (runner.ts): a directory problem is the user's to fix, never persisted
 * as a failure of the model being calibrated (review M1).
 */
export class GovernorDirError extends Error {
  override name = "GovernorDirError";
}

/** Whether `err`, or an error it wraps (`cause`), is a GovernorDirError. */
export function isGovernorDirError(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) if (e instanceof GovernorDirError) return true;
  return false;
}

function dirError(dir: string, why: string, cause?: unknown): Error {
  return new GovernorDirError(`governor directory ${dir} is unusable: ${why}. Local inference cannot be governed there; fix it, or set LLM_EXT_GOVERNOR_DIR to a private directory`, { cause });
}

function checkOwned(dir: string, st: Stats): void {
  // lstat, not stat: a world-writable /tmp allows squatting, and a planted symlink would move the state elsewhere (D1).
  if (st.isSymbolicLink()) throw dirError(dir, "it is a symbolic link");
  if (!st.isDirectory()) throw dirError(dir, "it is not a directory");
  if (process.platform !== "win32" && st.uid !== process.getuid?.()) throw dirError(dir, `it belongs to uid ${st.uid}`);
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** Create the directory if missing and check it. Called on every use, because /tmp can change under a long-lived broker. */
export function ensureGovernorDir(dir: string): void {
  try {
    let st;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") throw err;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      st = lstatSync(dir);
    }
    checkOwned(dir, st);
  } catch (err) {
    if (errnoOf(err) === undefined) throw err;
    throw dirError(dir, (err as Error).message, err);
  }
}

export function emptyState(): GovernorState {
  return { metrics: emptyMetrics(), window: { w: 1, changedAt: 0, lastRunAt: 0, lastDecreaseAt: 0 }, waiters: [], leases: [], servers: [], pidCheckAt: 0, lastUnloadAt: 0, ramOverSince: null, lastDenial: null };
}

/** A server entry with every field of this code, each of its type (round 5 m2). */
function isServerEntry(e: unknown): e is ServerEntry {
  if (typeof e !== "object" || e === null) return false;
  const s = e as Record<string, unknown>;
  const num = (k: string): boolean => typeof s[k] === "number" && Number.isFinite(s[k]);
  return (["pid", "ownerPid", "threads", "bookedBytes", "residentBytes", "lastUsedAt"] as const).every(num) && typeof s.start === "string" && typeof s.ownerStart === "string" && typeof s.wantUnload === "boolean" && (s.engine === "llama" || s.engine === "locals") && (s.role === "main" || s.role === "cal");
}

function parseState(text: string): GovernorState | null {
  try {
    const s = JSON.parse(text) as Partial<GovernorState> | null;
    // A file without the fields of this code is not whole: read as is, `now - undefined` is NaN, every comparison on it
    // is false, and the window would keep the old band and a stale head would never move.
    const current = s && typeof s.window?.lastDecreaseAt === "number" && Array.isArray(s.waiters) && s.waiters.every((w) => typeof w.polledAt === "number");
    // Round 4 #9: lastUnloadAt and ramOverSince are required. The governor never shipped without them, so an older dev
    // state file is not whole and takes the corrupt-file path: started again from an empty state.
    // Round 5 m2: every server entry is checked too. One with a missing or mistyped figure would put NaN into the books
    // (bookedBytes sums them) and every RAM verdict on NaN is false: such a file is not whole either.
    const whole = current && s.metrics && Array.isArray(s.leases) && Array.isArray(s.servers) && s.servers.every(isServerEntry) && typeof s.lastUnloadAt === "number" && (s.ramOverSince === null || typeof s.ramOverSince === "number");
    if (!whole) return null;
    // Unit 6: lastDenial came after the files a live unit-5 process may have written; absent is "none yet", not corrupt,
    // so an upgrade does not reset the leases of the processes still running.
    const lastDenial = s.lastDenial;
    const denialWhole = lastDenial && typeof lastDenial.reason === "string" && typeof lastDenial.at === "number" && typeof lastDenial.pid === "number";
    return { ...(s as GovernorState), lastDenial: denialWhole ? lastDenial : null };
  } catch {
    return null;
  }
}

function readText(dir: string): string | null {
  try {
    return readFileSync(join(dir, STATE_FILE), "utf8");
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return null;
    throw dirError(dir, (err as Error).message, err);
  }
}

/** A consistent snapshot with no lock. Creates nothing: a status read must leave no trace on an idle machine. */
export function readState(dir: string): GovernorState {
  try {
    checkOwned(dir, lstatSync(dir));
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return emptyState();
    if (errnoOf(err) === undefined) throw err;
    throw dirError(dir, (err as Error).message, err);
  }
  const text = readText(dir);
  return (text === null ? null : parseState(text)) ?? emptyState();
}

function tryMkdirLock(lock: string, dir: string): boolean {
  try {
    mkdirSync(lock);
    return true;
  } catch (err) {
    if (errnoOf(err) === "EEXIST") return false;
    throw dirError(dir, (err as Error).message, err);
  }
}

function takeLock(dir: string): boolean {
  const lock = join(dir, LOCK_DIR);
  if (tryMkdirLock(lock, dir)) return true;
  try {
    if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
    rmdirSync(lock);
  } catch (err) {
    // Its holder finished, or another process took it over, between the two calls.
    if (errnoOf(err) !== "ENOENT") throw dirError(dir, (err as Error).message, err);
  }
  return tryMkdirLock(lock, dir);
}

function dropLock(dir: string): void {
  try {
    rmdirSync(join(dir, LOCK_DIR));
  } catch (err) {
    // A holder descheduled past the stale age lost the lock; that risk is accepted in D2, and the owner now is someone else.
    if (errnoOf(err) !== "ENOENT") throw dirError(dir, (err as Error).message, err);
  }
}

/**
 * WHY a retry on Windows (TRDD-2VZ3JGDH): readState reads state-1.json with no lock, and on Windows a rename that
 * replaces a file another process holds open fails with EPERM, while POSIX renames over an open file. Windows CI run
 * 45931381708 failed on exactly that: a child of the 20-process test exited 1 on rename state-1.json.<pid>.tmp ->
 * state-1.json. A reader keeps the file open for one readFileSync, so the rename succeeds a few ms later.
 * RENAME_RETRY_MS stays far under LOCK_STALE_MS, so a lock holder waiting here never looks stale to another process.
 */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
export const RENAME_RETRY_MS = 500;

/** renameSync, retried on win32 while another process holds the target open; every other failure throws at once. */
export function renameReplacing(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  platform: NodeJS.Platform = process.platform,
): void {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let waitMs = 2; ; waitMs = Math.min(waitMs * 2, 50)) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = errnoOf(err);
      if (platform !== "win32" || code === undefined || !RENAME_RETRY_CODES.has(code) || Date.now() + waitMs > deadline) throw err;
      // A sync sleep: writeState runs inside a sync critical section that must never span an await.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

function writeState(dir: string, state: GovernorState): void {
  const file = join(dir, STATE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameReplacing(temp, file);
  } catch (err) {
    throw dirError(dir, (err as Error).message, err);
  }
}

export type Locked<T> = { locked: true; value: T } | { locked: false };

/** One critical section: `fn` mutates the state in place. Sync by type, so it can never span an await. */
export function withStateLock<T>(dir: string, fn: (state: GovernorState) => T): Locked<T> {
  ensureGovernorDir(dir);
  if (!takeLock(dir)) return { locked: false };
  try {
    const text = readText(dir);
    const parsed = text === null ? null : parseState(text);
    if (text !== null && parsed === null) process.stderr.write(`llm-ext: governor state in ${dir} was corrupt, starting from an empty state\n`);
    const state = parsed ?? emptyState();
    const before = JSON.stringify(state);
    const value = fn(state);
    if (JSON.stringify(state) !== before || parsed === null) writeState(dir, state);
    return { locked: true, value };
  } finally {
    dropLock(dir);
  }
}

/**
 * Drop what no longer has a live owner. `starts` is the verdict of a start-time
 * check, taken outside the lock; a live pid with another start is a reused pid.
 * The `expiresAt` backstop catches a leak in a holder that is still alive.
 */
export function reap(state: GovernorState, now: number, starts: Map<number, string> | null, alive: (pid: number) => boolean = (pid) => pidState(pid) !== "dead"): void {
  const gone = ({ pid, start }: Holder): boolean => {
    if (!alive(pid)) return true;
    const seen = starts?.get(pid);
    return seen !== undefined && start !== "" && seen !== start;
  };
  state.waiters = state.waiters.filter((w) => !gone(w.holder));
  state.leases = state.leases.filter((l) => !gone(l.holder) && l.expiresAt > now);
  state.servers = state.servers.filter((s) => !gone({ pid: s.ownerPid, start: s.ownerStart }));
}

/** Every pid the state names as an owner, for a start-time check. */
export function ownerPids(state: GovernorState): number[] {
  return [...new Set([...state.waiters.map((w) => w.holder.pid), ...state.leases.map((l) => l.holder.pid), ...state.servers.map((s) => s.ownerPid)])];
}

function linuxStart(pid: number): string | null {
  try {
    // Field 22; the name in field 2 may hold spaces and parentheses, so count from after its closing one.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch (err) {
    if (errnoOf(err) === "ENOENT" || errnoOf(err) === "ESRCH") return null;
    throw err;
  }
}

/** This process's own identity string. Sync and once per process: a holder must be named inside a critical section. */
export function ownStart(): string {
  if (process.platform === "win32") return "";
  if (process.platform === "linux") {
    const start = linuxStart(process.pid);
    if (start === null) throw new Error("/proc gave no start time for this process");
    return start;
  }
  return execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { env: PS_ENV, timeout: PS_TIMEOUT_MS, encoding: "utf8" }).trim();
}

/** The start strings of the pids that still exist. Empty on Windows, where pid alone identifies a holder. */
export function readStarts(pids: number[]): Promise<Map<number, string>> {
  const starts = new Map<number, string>();
  if (process.platform === "win32" || pids.length === 0) return Promise.resolve(starts);
  if (process.platform === "linux") {
    for (const pid of pids) {
      const start = linuxStart(pid);
      if (start !== null) starts.set(pid, start);
    }
    return Promise.resolve(starts);
  }
  return new Promise((resolve, reject) => {
    execFile("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { env: PS_ENV, timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      // ps exits 1 when none of the pids exists, which is an answer, not a failure.
      if (err && !(err.code === 1 && String(stdout).trim() === "")) {
        reject(err);
        return;
      }
      for (const line of String(stdout).split("\n")) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (m) starts.set(Number(m[1]), m[2]);
      }
      resolve(starts);
    });
  });
}
