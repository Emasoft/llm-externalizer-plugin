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

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, linkSync, renameSync } from "node:fs";

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
 * The env var a parent uses to hand the lock it claimed down to the detached
 * child, so the child can release it on the way out (see
 * `releaseOwnBenchLockOnExit`). Absent for a hand-run benchmark, which owns no
 * lock and must therefore never delete one.
 */
export const BENCH_LOCK_PATH_ENV = "LLM_EXT_BENCH_LOCK_PATH";

/**
 * The pid stamped in a lock file, or null when there is no readable, sane stamp.
 *
 * Split out of `benchLockIsHeld` because the exit-release hook asks a DIFFERENT
 * question — "is this still MY lock?" — before unlinking. A lock that was taken
 * over by another process while we ran belongs to THAT process, and unlinking it
 * would let a third process claim it concurrently: exactly the double-spawn this
 * module exists to prevent. Never throws.
 */
export function benchLockPid(lockPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

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

    const pid = benchLockPid(lockPath);
    if (pid === null) return false;

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
 * Create-or-fail is the whole point: two concurrent processes cannot both
 * believe they won. The old code checked liveness and then wrote the pid only
 * AFTER the spawn, leaving a window in which two CLI processes both passed the
 * check and both spawned. `tryCreate` writes the pid to a tmp file and
 * publishes it with `linkSync` so the lock is never observable empty (see the
 * comment inside `tryCreate`).
 *
 * We stamp OUR pid immediately — not the child's, which does not exist yet — so
 * that a parent that dies between claiming and spawning leaves a lock whose pid
 * is already dead, i.e. self-healing on the very next attempt. `commitBenchLock`
 * overwrites it with the child's pid once there is one.
 */
export function claimBenchLock(
  lockPath: string,
  nowMs: number = Date.now(),
  log?: (msg: string) => void,
): ClaimResult {
  const tryCreate = (): ClaimResult | null => {
    // Write the pid to a per-process tmp file FIRST, then atomically publish it
    // with linkSync (create-or-fail, same as the old openSync "wx"). This closes
    // the zero-byte window the old code had: `openSync(wx)` created an EMPTY
    // lockPath and only then wrote the pid, so a concurrent benchLockPid/
    // benchLockIsHeld landing in that window read 0 bytes -> null -> "not held"
    // -> a second parent took over and spawned too.
    const tmp = `${lockPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, String(process.pid), "utf-8");
    } catch (e) {
      // Nothing was published; nothing was created, so there is nothing to
      // clean up either.
      return { ok: false, reason: "unwritable", detail: (e as Error).message };
    }

    try {
      linkSync(tmp, lockPath);
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; // caller decides
      // Anything else (EPERM, ENOSPC, a symlink race) is reported as
      // unwritable like any other permissions problem — the caller refuses
      // to spawn on `!ok`, so it is loud, not hidden.
      return { ok: false, reason: "unwritable", detail: (e as Error).message };
    } finally {
      // Always try to drop our own tmp name. Once linkSync succeeds, tmp and
      // lockPath are the SAME inode (a hard link), so this only removes the
      // throwaway path — lockPath keeps the content already fully written.
      try {
        unlinkSync(tmp);
      } catch {
        // ENOENT, or litter — a leaked tmp is inert: nothing reads it.
      }
    }
  };

  const first = tryCreate();
  if (first !== null) return first;

  // Read the pid BEFORE judging staleness so the compare after the rename
  // below uses the pid that was actually JUDGED, not a re-read. This gives a
  // BOUND, not exclusion: the stale file is moved by exactly ONE claimer (its
  // content never comes back); every other win needs a gap — lockPath
  // momentarily absent between a claimer's rename-away and its link-back or
  // second tryCreate — and a filled gap costs its opener the claim, while a
  // stealer (a claimer whose pre-judgment read saw a rival's FRESH pid and
  // whose rename then moves the file a losing restorer just linked back)
  // needs one losing restorer each. Hence with n concurrent claimers winners
  // <= (n+1)/2. A live winner can still lose its lock to such a stealer —
  // bounded the same way — and the cost is a duplicate $0 bench, never a
  // wedge.
  const observedStalePid = benchLockPid(lockPath);

  // The file exists. Honour it only while all three staleness axes agree.
  if (benchLockIsHeld(lockPath, nowMs)) {
    return { ok: false, reason: "held", detail: lockPath };
  }

  // Stale — but between the check above and here, another process racing us
  // may ALSO have judged it stale, already renamed it away, and already
  // installed its own FRESH lock at lockPath. `observedStalePid` above was
  // captured right before that judgment, not re-read here, so the compare
  // after the rename below tells us whether we actually moved the same file
  // we judged stale: if it does not match, what we just renamed away was the
  // other process's fresh claim, not the stale lock — put it straight back
  // and lose this race gracefully. This narrows the double-takeover window
  // from the whole stale branch (the old unconditional unlink) to the span
  // between the pre-judgment read and this rename, and what remains still
  // fails in the module's chosen direction: at most a duplicate $0
  // benchmark, never a wedge.
  const stolenPath = `${lockPath}.stale.${process.pid}`;
  try {
    renameSync(lockPath, stolenPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Someone else acted on this lock first (took it over, or released it
      // normally) — the next dispatch re-reads current state.
      return { ok: false, reason: "held", detail: lockPath };
    }
    return { ok: false, reason: "unwritable", detail: (e as Error).message };
  }
  const renamedPid = benchLockPid(stolenPath);
  if (renamedPid !== observedStalePid) {
    // What we renamed away was NOT the stale lock we judged a moment ago — a
    // racing process already won the takeover and installed a fresh lock at
    // lockPath in between. Put it straight back — but with linkSync
    // (create-or-fail), NEVER renameSync (unconditional replace). Between our
    // failed match-check and this restore, lockPath is momentarily ABSENT (we
    // already moved it to stolenPath), and a THIRD process's own legitimate
    // tryCreate can land in exactly that gap. A renameSync restore would
    // silently clobber that third process's fresh lock with the stale content
    // we are putting back — turning a duplicate-bench race into an actual
    // wedge (two processes both believing they hold the lock, the file
    // agreeing with neither). linkSync instead fails EEXIST in that case, and
    // we simply drop our now-irrelevant copy: whatever is at lockPath already
    // is the authoritative state.
    try {
      linkSync(stolenPath, lockPath);
    } catch {
      /* someone else's legitimate claim is there now — nothing to restore */
    }
    try {
      unlinkSync(stolenPath);
    } catch {
      /* already gone, or was never linked — either way nothing left to clean up */
    }
    return { ok: false, reason: "held", detail: lockPath };
  }

  // ONE stderr line, here and nowhere else (P6c-a2a item 66): a takeover is the
  // only moment the invisible self-healing becomes visible, and a silent one is
  // indistinguishable from "the lock was never there" — which is precisely how a
  // child that leaks its lock on exit (the P6d dogfood finding) stayed
  // undiagnosed for 15 minutes. It is a takeover, not a failure, so it is a
  // single informational line — emitted ONLY after the second tryCreate below
  // actually succeeds, so a process that confirms the rename but then loses the
  // re-race never claims a takeover it did not complete.
  //
  // Worded for BOTH stale reasons. We got here when ANY of the three axes said
  // "not alive", so "pid N is dead" would be a false statement about the
  // TTL-expiry case, where the pid can be very much alive (a reused pid, the
  // wedge the TTL exists to break). Name the pid — it is the diagnostic — and
  // state the disjunction rather than guessing which axis fired.
  try {
    unlinkSync(stolenPath);
  } catch {
    /* our own throwaway rename target — nothing else can reference it */
  }
  const second = tryCreate();
  if (second !== null && second.ok) {
    log?.(
      `[llm-externalizer] taking over a stale benchmark lock (pid ${observedStalePid ?? "unreadable"}: gone, not ours, or past the ${Math.round(BENCH_LOCK_TTL_MS / 60_000)}-minute TTL): ${lockPath}\n`,
    );
    return second;
  }
  return second ?? { ok: false, reason: "held", detail: lockPath };
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
  // Write-then-rename, matching tryCreate: writeFileSync(lockPath, ...) alone
  // truncates first and writes second, so a concurrent benchLockPid/
  // benchLockIsHeld landing in that window reads 0 bytes -> null -> "not
  // held" -> a second parent takes over and spawns. renameSync is atomic, so
  // readers only ever see the old content or the new one, never neither.
  const tmp = `${lockPath}.${process.pid}.commit.tmp`;
  try {
    writeFileSync(tmp, String(pid), "utf-8");
    renameSync(tmp, lockPath);
  } catch {
    /* lock unwritable — duplicate-spawn detection degrades; the bench still runs */
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp was never created, or already gone */
    }
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

/**
 * Release `lockPath` when THIS process exits — on every path a process can
 * leave by.
 *
 * P6c-a2a item 66. Until this existed nothing ever deleted a lock on the SUCCESS
 * path: the parent released only on its own failure paths, and the child — whose
 * pid `commitBenchLock` stamps — had no idea a lock existed at all. The P6d
 * dogfood run caught the consequence directly: `default-profile-free.lock`
 * stamped `51700`, that pid long dead, the file still sitting in the config dir
 * 15 minutes later. It did not wedge anything (the dead-pid axis of
 * `benchLockIsHeld` already releases it logically), but it left the config dir
 * asserting a run that had finished, and it narrows the safety margin to the one
 * hazard this module calls out by name: a REUSED pid inside the 2 h TTL reads
 * "alive" and does wedge.
 *
 * The exit-path coverage, measured (not assumed) — see the report's table:
 *   normal completion / `process.exitCode` .. 'exit' fires
 *   explicit `process.exit(n)` ............. 'exit' fires
 *   uncaught throw / unhandled rejection ... 'exit' fires (code 1)
 *   SIGTERM / SIGINT / SIGHUP ............. 'exit' does NOT fire — hence the
 *                                            per-signal `once` handlers below
 *   SIGKILL / power loss .................. unreachable by any hook; the
 *                                            dead-pid + TTL axes are the backstop
 *
 * `process.once` for the signals, then re-raising the SAME signal: removing our
 * listener restores the default disposition, so the process still dies with the
 * correct signalled status (143/130/129) instead of a synthesised exit code.
 * Signal listeners do not keep the event loop referenced, so arming this never
 * makes a finished benchmark hang.
 *
 * The ownership check is load-bearing: we unlink ONLY while the stamp is still
 * our own pid. A lock another process took over (stale takeover, TTL expiry)
 * belongs to that process, and deleting it would let a third process claim the
 * same lock concurrently.
 *
 * This guarantee holds only AFTER the parent's `commitBenchLock` has re-stamped
 * the lock with THIS process's pid (N-1): a child that exits before that point
 * still sees the parent's pid in the lock and `releaseIfOurs` declines to
 * touch it, so it releases nothing; the parent then leaves a lock stamped with
 * its own, now-dead pid, which self-heals on the very next `claimBenchLock`
 * attempt via the dead-pid axis rather than via this hook.
 */
export function releaseOwnBenchLockOnExit(lockPath: string, pid: number = process.pid): void {
  const releaseIfOurs = (): void => {
    if (benchLockPid(lockPath) === pid) releaseBenchLock(lockPath);
  };
  process.on("exit", releaseIfOurs);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(sig, () => {
      releaseIfOurs();
      process.kill(process.pid, sig);
    });
  }
}
