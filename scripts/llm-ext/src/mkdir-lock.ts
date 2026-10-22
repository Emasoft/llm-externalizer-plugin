/**
 * The ONE cross-process advisory lock this codebase uses for a small
 * read-modify-write over a JSON sidecar in the config dir.
 *
 * P6b-fix2 S-4 — WHY it exists as its own module: `benchmark/daily-spend.ts`
 * grew the only correct implementation (money is the one resource nobody was
 * willing to lose an update on), while `dynamic-profiles-state.json` and
 * `dynamic-candidates.json` — both written by the maintainer in the parent AND
 * by a benchmark child — did their read-modify-write with no lock at all.
 * Their writes are atomic (tmp + rename), which answers a TORN FILE and not a
 * LOST UPDATE: process A reads, process B reads, A writes, B writes A's read
 * back out. The concrete losses were a completing child's `lastBenchmarkAt`
 * erased by the parent, and the parent's `poolFingerprint` reverted by the
 * child — the second one costing a billable re-queue of the whole paid class.
 * Copying daily-spend's loop into three more files is how the four would drift;
 * this is that one loop, moved.
 */

import { mkdirSync, rmdirSync, rmSync, statSync } from "node:fs";

/** A lock older than this is considered abandoned by a dead holder. */
export const STALE_MS = 30_000;
/** How long a waiter blocks before giving up and proceeding UNLOCKED. */
export const WAIT_MS = 5_000;

/**
 * A real, synchronous sleep (P6b-fix3 S-7').
 *
 * `withMkdirLock` is synchronous by contract — every mutator it wraps is a sync
 * read-modify-write — so there is no `await` to yield on, and the retry loop had
 * no delay at all: a contended wait was a HOT CPU SPIN for up to WAIT_MS, now on
 * the every-tool-dispatch path (S-4 moved this loop there). `Atomics.wait` on a
 * private SharedArrayBuffer is the one way to block without burning the CPU, and
 * Node — unlike a browser's main thread — permits it on the main thread.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding `lockDir` as a lock. The lock "file" is a DIRECTORY
 * because `mkdir` is atomic on every platform this runs on — no O_EXCL dance,
 * no pid file to parse.
 *
 * The two asymmetries are deliberate and documented in bench-lock.ts for the
 * same reason: being too eager to break a stale lock costs one interleaved
 * write at worst, while being too reluctant would latch the sidecar closed
 * forever after one crash; and a waiter that hits the deadline proceeds
 * WITHOUT the lock rather than failing the user's command over a wedged
 * lock — the stale-lock sweep above is the primary defense, this is only the
 * backstop.
 */
export function withMkdirLock<T>(lockDir: string, fn: () => T): T {
  const deadline = Date.now() + WAIT_MS;
  let acquired = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      break;
    } catch {
      // P6b-fix3 S-7': EVERY exit from this catch now passes the deadline check.
      // Both `continue`s used to skip it, so a `mkdirSync` that can NEVER succeed
      // and whose `statSync` also fails — an absent PARENT directory, EACCES, a
      // read-only filesystem — spun forever. S-4 put this loop on every tool
      // dispatch (maintainDynamicProfiles), whose contract is "a maintenance bug
      // must never take the user's actual command down with it" — and its own
      // try/catch cannot catch a hang.
      let cleared = false;
      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          // P6b-fix4 N5: rmSync(recursive, force) — ONE call for every shape a
          // stale lock path can take.
          //
          // `rmdirSync` on a NON-EMPTY directory throws ENOTEMPTY into the catch
          // below, so a single stray file inside the lock dir made the lock
          // permanently untakeable: every dispatch then waited the full WAIT_MS
          // and proceeded UNLOCKED, silently — 5 s of latency per command and the
          // lost-update race back, with nothing said. It also replaces S-7''s
          // `isDirectory()` branch (a stale regular FILE at the lock path, which
          // `rmdirSync` rejects with ENOTDIR): `force` makes both cases, and a
          // lock that vanished between the failed mkdir and here, the same code.
          rmSync(lockDir, { recursive: true, force: true });
          cleared = true;
          // Breaking someone else's lock is a real event: it means a holder died
          // mid-write, or a lock outlived STALE_MS. Exactly one line, only on a
          // takeover, so it can never become per-dispatch noise.
          process.stderr.write(
            `[llm-externalizer] took over a stale lock (older than ${STALE_MS} ms): ${lockDir}\n`,
          );
        }
      } catch {
        // Either the lock vanished between the failed mkdir and the stat (retry
        // at once, it is probably ours now) or the path is unreadable/uncreatable
        // (retry until the deadline, then proceed unlocked). One shape, because
        // they are indistinguishable from here and the bound covers both.
      }
      if (Date.now() > deadline) break;
      // Cleared a stale lock ⇒ retry immediately. Otherwise back off: jittered so
      // two waiters that collided once do not re-collide in lockstep forever.
      if (!cleared) sleepSync(5 + Math.floor(Math.random() * 16));
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        rmdirSync(lockDir);
      } catch {
        /* already removed — nothing further to do */
      }
    }
  }
}
