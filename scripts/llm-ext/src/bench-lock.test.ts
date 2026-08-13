/**
 * Tests for the shared duplicate-spawn lock (src/bench-lock.ts).
 *
 * The requirement under test is not "does the lock work" but "can the lock
 * WEDGE" — a guard that latches ON forever silently freezes the 5 machine-
 * managed default profiles on a stale model set, and reads in the logs exactly
 * like healthy throttling. Every case below is one of the three staleness axes
 * that must independently release it.
 *
 * Hermetic: real files in a temp dir, no spawn, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  BENCH_LOCK_TTL_MS,
  benchLockIsHeld,
  claimBenchLock,
  commitBenchLock,
  releaseBenchLock,
} from "./bench-lock.js";

let dir = "";
let lockPath = "";

beforeEach(() => {
  dir = mkdtempSync(join("/tmp", "bench-lock-"));
  lockPath = join(dir, "bench.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Backdate a file so the TTL axis sees it as old. */
function backdate(path: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

describe("benchLockIsHeld — a lock is honoured only while ALL THREE axes say alive", () => {
  it("reports NOT held when there is no lock file at all", () => {
    expect(benchLockIsHeld(lockPath)).toBe(false);
  });

  it("reports held for a live pid written just now — the case the lock exists for", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    expect(benchLockIsHeld(lockPath)).toBe(true);
  });

  it("reports NOT held for a dead pid — a crashed bench must not block the next one", () => {
    // 2^22 is above every platform's default pid_max, so it cannot be live.
    writeFileSync(lockPath, "4194304", "utf-8");
    expect(benchLockIsHeld(lockPath)).toBe(false);
  });

  it("reports NOT held past the TTL even when the pid IS live — the wedge-breaker", () => {
    // This is the axis that makes a permanent wedge impossible. A leftover lock
    // whose pid was later REUSED by an unrelated long-lived process passes the
    // liveness check forever; only the TTL releases it.
    writeFileSync(lockPath, String(process.pid), "utf-8");
    backdate(lockPath, BENCH_LOCK_TTL_MS + 60_000);
    expect(benchLockIsHeld(lockPath)).toBe(false);
  });

  it("reports NOT held for garbage content — an unparseable guard must not block", () => {
    writeFileSync(lockPath, "not-a-pid\n", "utf-8");
    expect(benchLockIsHeld(lockPath)).toBe(false);
  });

  it("reports NOT held for an unsignalable (EPERM) pid — we spawn same-uid, so it is not our child", () => {
    // pid 1 is init/launchd, owned by root. As a non-root user process.kill(1,0)
    // throws EPERM. The old code read EPERM as "held", which is precisely how a
    // reused pid landing on a root daemon latched the lock forever.
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (uid === 0) return; // running as root: kill(1,0) succeeds, nothing to assert
    writeFileSync(lockPath, "1", "utf-8");
    expect(benchLockIsHeld(lockPath)).toBe(false);
  });
});

describe("claimBenchLock — atomic create-or-fail, taken BEFORE the spawn", () => {
  it("claims a free lock and stamps OUR pid, so a parent that dies before spawning self-heals", () => {
    const r = claimBenchLock(lockPath);
    expect(r.ok).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));
  });

  it("refuses when a live lock already exists — this is what stops a double spawn", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    const r = claimBenchLock(lockPath);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("held");
  });

  it("steals a STALE lock rather than skipping — otherwise a crashed run disables the feature", () => {
    writeFileSync(lockPath, "4194304", "utf-8"); // dead pid
    const r = claimBenchLock(lockPath);
    expect(r.ok).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));
  });

  it("steals an EXPIRED lock rather than skipping, even with a live pid in it", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    backdate(lockPath, BENCH_LOCK_TTL_MS + 60_000);
    expect(claimBenchLock(lockPath).ok).toBe(true);
  });

  it("reports `unwritable` (not `held`) when the lock path cannot be created — a different remedy", () => {
    const r = claimBenchLock(join(dir, "no-such-dir", "bench.lock"));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("unwritable");
  });
});

describe("commit / release — handing the lock to the child, and giving it back", () => {
  it("commit replaces our pid with the CHILD's, so the lock outlives this process", () => {
    claimBenchLock(lockPath);
    commitBenchLock(lockPath, 4194304);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("4194304");
  });

  it("commit refreshes the mtime, restarting the TTL from the moment the child actually started", () => {
    claimBenchLock(lockPath);
    backdate(lockPath, BENCH_LOCK_TTL_MS + 60_000);
    commitBenchLock(lockPath, process.pid);
    expect(benchLockIsHeld(lockPath)).toBe(true);
  });

  it("release removes the lock, so a failed spawn does not make the next attempt wait out the TTL", () => {
    claimBenchLock(lockPath);
    releaseBenchLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("release on an already-absent lock is silent — it runs on failure paths that must not throw", () => {
    expect(() => releaseBenchLock(lockPath)).not.toThrow();
  });
});
