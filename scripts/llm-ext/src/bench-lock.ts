/**
 * The duplicate-spawn lock shared by every detached benchmark child.
 *
 * ONE hard requirement dictates this whole design: an auto-benchmark must
 * NEVER become permanently disabled. The 5 machine-managed default profiles
 * re-score whenever the OpenRouter pool drifts, and a guard that can latch ON
 * forever silently freezes a profile on a stale model set — the failure is
 * invisible, because "skipped: a run is already in progress" reads exactly
 * like healthy throttling.
 *
 * The previous lock could latch, three ways at once:
 *
 *   1. NOTHING EVER DELETED IT. Neither parent nor child unlinked the lock, so
 *      every successful run left a dead-pid file behind permanently.
 *   2. Liveness was `process.kill(pid, 0)` alone. Once a leftover pid is reused
 *      by an unrelated process — guaranteed after a reboot, since pids wrap —
 *      the check reads "held" forever.
 *   3. EPERM counted as HELD. We always spawn same-uid, so a pid we cannot
 *      signal is by definition NOT our child; treating it as held handed the
 *      wedge to any root daemon that happened to land on the reused pid.
 *
 * So staleness is decided on THREE independent axes, and a lock is honoured
 * only if all of them say "alive":
 *
 *   pid parses  AND  pid is signalable by US  AND  mtime is within the TTL
 *
 * Any single axis failing releases the lock. The TTL is the backstop that
 * makes the wedge impossible rather than merely unlikely: even if a reused pid
 * defeats the liveness check, the lock expires on its own.
 *
 * The failure DIRECTION is chosen deliberately. Being too eager to release
 * costs at most one duplicate benchmark (the free pool is $0 by construction;
 * the paid profiles are gated by `allow_paid_models` plus a per-run opt-in).
 * Being too reluctant costs the feature itself, permanently. Given that
 * asymmetry, release wins every tie.
 */

import { existsSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * How long a lock may be honoured without further proof of life.
 *
 * A keyword sweep takes ~15 minutes and a full refresh 10-40 (see
 * default-profiles-runner's header), so 2h is ~3x the worst legitimate run.
 * It is not a duration estimate — it is the bound on how long a wedged lock
 * can suppress benchmarking, which is the number the hard requirement is
 * actually about.
 *
 * If runs ever legitimately exceed this, the symptom is two pids writing into
 * one bench log; the fix then is a child-side mtime heartbeat, not a longer
 * TTL — a longer TTL just lengthens the outage this constant exists to bound.
 */
export const BENCH_LOCK_TTL_MS = 2 * 60 * 60_000;

/** Why a claim failed. `held` is the normal "someone else is benching" case. */
export type ClaimFailure = "held" | "unwritable";

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: ClaimFailure; detail: string };

/**
 * Is this lock file still speaking for a live run?
 *
 * Exported for the callers that only want to REPORT state (and for tests).
 * Never throws: an unreadable, malformed, or vanished lock is not held.
 */
export function benchLockIsHeld(lockPath: string, nowMs: number = Date.now()): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    // Axis 3 first — it is a pure stat, and it is the axis that cannot be
    // fooled by pid reuse, so checking it early keeps the expensive-to-reason
    // -about pid logic off the hot path for an expired lock.
    if (nowMs - statSync(lockPath).mtimeMs > BENCH_LOCK_TTL_MS) return false;

    const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;

    try {
      // Signal 0 does not kill — it asks whether the pid exists AND whether we
      // may signal it.
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // ESRCH: gone. EPERM: alive but NOT ours — we spawn same-uid, so a pid we
      // cannot signal cannot be our benchmark child; it is a reused pid, which
      // is precisely the case that used to latch the lock forever.
      void e;
      return false;
    }
  } catch {
    // Unreadable/unstattable lock. A guard we cannot evaluate must not be a
    // guard that blocks: fail toward running the benchmark.
    return false;
  }
}

/**
 * Take the lock, atomically, BEFORE spawning anything.
 *
 * `openSync(path, "wx")` is the whole point: create-or-fail is a single
 * syscall, so two concurrent processes cannot both believe they won. The old
 * code checked liveness and then wrote the pid only AFTER the spawn, leaving a
 * window in which two CLI processes both passed the check and both spawned.
 *
 * We stamp OUR pid immediately — not the child's, which does not exist yet — so
 * that a parent that dies between claiming and spawning leaves a lock whose pid
 * is already dead, i.e. self-healing on the very next attempt. `commitBenchLock`
 * overwrites it with the child's pid once there is one.
 */
export function claimBenchLock(lockPath: string, nowMs: number = Date.now()): ClaimResult {
  const tryCreate = (): ClaimResult | null => {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, String(process.pid), "utf-8");
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; // caller decides
      return { ok: false, reason: "unwritable", detail: (e as Error).message };
    }
  };

  const first = tryCreate();
  if (first !== null) return first;

  // The file exists. Honour it only while all three staleness axes agree.
  if (benchLockIsHeld(lockPath, nowMs)) {
    return { ok: false, reason: "held", detail: lockPath };
  }

  // Stale — clear it and race once for the claim. A loser here is not an error:
  // it means another process cleared the same stale lock first and is now
  // spawning, which is exactly the outcome the lock exists to produce.
  try {
    unlinkSync(lockPath);
  } catch {
    /* someone else removed it first — the retry below settles who claims it */
  }
  const second = tryCreate();
  if (second !== null) return second;
  return { ok: false, reason: "held", detail: lockPath };
}

/**
 * Record the pid that now OWNS the lock, refreshing its mtime.
 *
 * Called once the child exists. Writing the child's pid is what makes the
 * liveness axis meaningful: the parent returns immediately, so a lock stamped
 * with the parent's pid would read as stale the moment the parent exits, while
 * the detached benchmark is still running.
 */
export function commitBenchLock(lockPath: string, pid: number): void {
  try {
    writeFileSync(lockPath, String(pid), "utf-8");
  } catch {
    /* lock unwritable — duplicate-spawn detection degrades; the bench still runs */
  }
}

/**
 * Drop the lock. Best-effort by design: this runs on the failure paths, where
 * throwing would convert "the benchmark did not start" into "the tool the user
 * actually ran just failed".
 */
export function releaseBenchLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone, or unlinkable — the TTL bounds it either way */
  }
}
