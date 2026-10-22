// withMkdirLock — the ONE cross-process advisory lock (P6b-fix2 S-4), tested
// directly for the first time (P6b-fix3 N-11).
//
// It had no test of its own: its staleness, deadline and proceed-unlocked
// behaviour were covered only indirectly, through benchmark/daily-spend.test.ts
// (the file the implementation was extracted from) and the maintainer's own
// concurrency case. That is why two hang paths survived the extraction onto the
// EVERY-TOOL-DISPATCH path — the very place a hang is least survivable, because
// the maintainer's "never throws" try/catch cannot catch one.
//
// No mocks anywhere: contention is a REAL second process holding the real lock
// directory, and staleness is a real lock whose real mtime is set into the past.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMkdirLock, STALE_MS, WAIT_MS } from "./mkdir-lock.js";

/** A genuine second PROCESS that takes the lock, announces it, holds it for
 *  holdMs, then releases — what a live holder mid-read-modify-write looks like.
 *  Plain .mjs: no build step, no TS loader, and it is a stand-in for another
 *  process rather than a copy of the code under test. */
// P6b-fix4 N7: it also stamps the instant it is ABOUT TO release, so the waiter
// can be checked for ORDERING (it ran after the release) instead of against a
// wall-clock minimum. The stamp is written BEFORE the rmdir on purpose: it must
// be <= the real release instant, or the comparison could fail on a correct run.
const HOLDER_SRC = `
import { mkdirSync, writeFileSync, rmdirSync } from "node:fs";
const [lockDir, marker, holdMs, released] = process.argv.slice(2);
mkdirSync(lockDir);
writeFileSync(marker, "1");
setTimeout(() => {
  writeFileSync(released, String(Date.now()));
  rmdirSync(lockDir);
}, Number(holdMs));
`;

describe("withMkdirLock", () => {
  let dir = "";
  let lockDir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmext-mkdirlock-"));
    lockDir = join(dir, "the.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("acquires, runs the body, and removes the lock afterwards", () => {
    expect(withMkdirLock(lockDir, () => {
      expect(existsSync(lockDir), "the body must run while the lock is held").toBe(true);
      return 42;
    })).toBe(42);
    expect(existsSync(lockDir), "the lock must be released").toBe(false);
  });

  it("releases the lock even when the body throws", () => {
    expect(() =>
      withMkdirLock(lockDir, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("WAITS for a lock held by a live process, then proceeds once it is released", async () => {
    // Real contention, real process. The 400ms hold is well inside WAIT_MS, so
    // this proves the RELEASE path, not the deadline path.
    const holderPath = join(dir, "holder.mjs");
    writeFileSync(holderPath, HOLDER_SRC, "utf-8");
    const marker = join(dir, "held");
    const releasedAtPath = join(dir, "released-at");
    const holder = spawn(
      process.execPath,
      [holderPath, lockDir, marker, "400", releasedAtPath],
      // Captured rather than inherited, so a holder that dies can be QUOTED in
      // the failure instead of leaving "the holder never took the lock" as the
      // only clue.
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let holderStderr = "";
    holder.stderr?.on("data", (c: Buffer) => {
      holderStderr += c.toString();
    });
    const exited = new Promise<number>((r) => holder.on("exit", (c) => r(c ?? -1)));
    for (let i = 0; i < 300 && !existsSync(marker); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(marker), `the holder never took the lock. stderr:\n${holderStderr}`).toBe(true);

    const start = Date.now();
    const held = withMkdirLock(lockDir, () => existsSync(lockDir));
    const bodyRanAt = Date.now();
    const elapsed = bodyRanAt - start;

    expect(held, "the body must run with the lock actually held, not unlocked").toBe(true);
    // P6b-fix4 N7: ORDERING, not a wall-clock minimum. The old assertion was
    // `elapsed >= 250` against a 400 ms hold discovered through a 10 ms poll
    // loop — on a loaded machine the poll can return late enough that the
    // remaining hold is under 250 ms, and the test then fails while the lock
    // behaved perfectly. What the case is actually about is that the waiter did
    // not break a live lock: its body ran AFTER the holder released.
    expect(existsSync(releasedAtPath), `the holder never recorded its release. stderr:\n${holderStderr}`).toBe(
      true,
    );
    const releasedAt = Number(readFileSync(releasedAtPath, "utf-8"));
    expect(
      bodyRanAt,
      `the body ran ${releasedAt - bodyRanAt} ms BEFORE the holder released — a live lock was broken`,
    ).toBeGreaterThanOrEqual(releasedAt);
    // ...and it did not sit out the whole bound: the release woke it.
    expect(elapsed).toBeLessThan(WAIT_MS);
    expect(await exited, `holder exited non-zero. stderr:\n${holderStderr}`).toBe(0);
  });

  it("takes over a stale NON-EMPTY lock DIRECTORY (P6b-fix4 N5)", () => {
    // The failure mode: `rmdirSync` on a non-empty directory throws ENOTEMPTY,
    // which landed in the catch that only counts down the deadline — so ONE stray
    // file inside the lock dir made the lock permanently untakeable. Every
    // dispatch then waited the full WAIT_MS and proceeded UNLOCKED, silently.
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "leftover.tmp"), "a crashed holder's scratch file", "utf-8");
    const past = (Date.now() - STALE_MS - 60_000) / 1000;
    utimesSync(lockDir, past, past);

    const start = Date.now();
    const held = withMkdirLock(lockDir, () => existsSync(lockDir));
    const elapsed = Date.now() - start;

    expect(held, "the stale non-empty lock must be removed and the lock acquired").toBe(true);
    expect(elapsed, "it must be taken over at once, not waited out for WAIT_MS").toBeLessThan(1_000);
    expect(existsSync(lockDir), "the lock must be released again").toBe(false);
  });

  it("takes over a stale lock DIRECTORY at once", () => {
    mkdirSync(lockDir);
    const past = (Date.now() - STALE_MS - 60_000) / 1000;
    utimesSync(lockDir, past, past);

    const start = Date.now();
    const held = withMkdirLock(lockDir, () => existsSync(lockDir));
    const elapsed = Date.now() - start;

    expect(held).toBe(true);
    expect(elapsed, "a stale lock must be broken immediately, not waited out").toBeLessThan(1_000);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("takes over a stale regular FILE at the lock path (P6b-fix3 S-7')", () => {
    // The hang: rmdirSync on a FILE throws ENOTDIR into the same catch that then
    // `continue`d without checking the deadline — one stray file at the lock path
    // spun forever, on every tool dispatch.
    writeFileSync(lockDir, "not a directory", "utf-8");
    const past = (Date.now() - STALE_MS - 60_000) / 1000;
    utimesSync(lockDir, past, past);

    const start = Date.now();
    const held = withMkdirLock(lockDir, () => existsSync(lockDir));
    const elapsed = Date.now() - start;

    expect(held, "the stale file must be unlinked and the lock actually acquired").toBe(true);
    expect(elapsed).toBeLessThan(1_000);
    expect(existsSync(lockDir)).toBe(false);
  });

  it(
    "RETURNS within the bound when the lock can never be created (absent parent) — 🐌 waits out WAIT_MS",
    () => {
      // The other hang: mkdirSync fails permanently AND statSync fails too, so
      // neither `continue` ever reached the deadline check. This is the shape a
      // deleted config dir, an EACCES mount or a read-only filesystem takes.
      const impossible = join(dir, "gone", "deeper", "the.lock");
      const start = Date.now();
      const held = withMkdirLock(impossible, () => existsSync(impossible));
      const elapsed = Date.now() - start;

      // Documented backstop: it proceeds WITHOUT the lock rather than failing the
      // user's command over a wedged one.
      expect(held).toBe(false);
      expect(elapsed, "it must wait the bound, not give up instantly").toBeGreaterThanOrEqual(WAIT_MS - 50);
      // The assertion that matters: it TERMINATES. Pre-fix this never returned.
      expect(elapsed).toBeLessThan(WAIT_MS * 3);
    },
    WAIT_MS * 4,
  );

  it("does not hot-spin while waiting: the retry loop sleeps", () => {
    // A hot spin burns a full core for up to WAIT_MS on every contended dispatch.
    // CPU time is the only honest observable; wall time passes either way.
    mkdirSync(lockDir); // fresh (not stale), and nothing will release it
    const before = process.cpuUsage();
    const start = Date.now();
    withMkdirLock(lockDir, () => undefined);
    const wallMs = Date.now() - start;
    const cpuMs = (process.cpuUsage(before).user + process.cpuUsage(before).system) / 1000;

    expect(wallMs, "it must actually have waited the bound").toBeGreaterThanOrEqual(WAIT_MS - 50);
    // A spin would put cpuMs at ~wallMs. A sleeping loop wakes ~WAIT_MS/12ms
    // times and does a stat each time, which is a small fraction of it.
    expect(cpuMs, `burned ${cpuMs.toFixed(0)}ms of CPU over ${wallMs}ms of waiting`).toBeLessThan(
      wallMs / 2,
    );
  }, WAIT_MS * 4);
});
