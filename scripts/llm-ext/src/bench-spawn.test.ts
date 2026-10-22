/**
 * Tests for the one detached-spawn seam (src/bench-spawn.ts), and specifically
 * for the LOCK LIFECYCLE it owns end-to-end with bench-lock.ts.
 *
 * P6c-a2a item 66. The defect these exist for was found by the P6d dogfood run,
 * not by this suite: a populator child exited with code 0 and its lock file was
 * still sitting in the config dir fifteen minutes later
 * (`default-profile-free.lock`, stamped `51700`, that pid long dead). Nothing
 * ever released a lock on the SUCCESS path — the parent released only on its own
 * failure paths, and the child had no idea a lock existed. It did not wedge
 * anything, because `benchLockIsHeld`'s dead-pid axis releases such a lock
 * logically; but it left the config dir asserting a run that had finished, and it
 * leaned the whole guarantee on the one axis this module's own header calls the
 * weakest (a REUSED pid inside the 2 h TTL reads "alive").
 *
 * The cases below are the two halves of the fix:
 *   - the parent hands the lock down (`LLM_EXT_BENCH_LOCK_PATH`) and a REAL
 *     child, the actual bundled `dist/benchmark.js`, gives it back on exit;
 *   - a child that exited WITHOUT releasing (simulated with a dead pid, which is
 *     exactly the state the dogfood run left behind) does not block the next
 *     spawn, and the takeover says so once — while a LIVE one still does block.
 *
 * Hermetic: temp dirs only, no network. The one real child is `--help`, which
 * prints and `process.exit(0)`s in milliseconds without reading settings or the
 * catalog. It runs the REAL production entrypoint on purpose: the arming lives in
 * that entry guard, so a stub child would test a re-implementation of the thing
 * that broke rather than the thing itself.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { statSync, utimesSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { BENCH_LOCK_PATH_ENV, benchLockPid, commitBenchLock } from "./bench-lock.js";
import { resolveBenchmarkScriptPath, spawnDetachedBench } from "./bench-spawn.js";

/** Absolute path to the REAL bench-lock.ts source, for the two cases below that
 *  import it directly into a spawned child rather than through a stub — Node 26
 *  strips TS types natively and the module imports only node:fs, so this loads
 *  the actual production `releaseOwnBenchLockOnExit` / `claimBenchLock`. */
const BENCH_LOCK_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "bench-lock.ts",
);

let dir = "";
let lockPath = "";
let logPath = "";
let noopScript = "";
let lines: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join("/tmp", "bench-spawn-"));
  lockPath = join(dir, "bench.lock");
  logPath = join(dir, "bench.log");
  noopScript = join(dir, "noop.js");
  writeFileSync(noopScript, "process.exit(0);\n");
  lines = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function spawnWith(over: Partial<Parameters<typeof spawnDetachedBench>[0]> = {}) {
  return spawnDetachedBench({
    lockPath,
    logPath,
    scriptPath: noopScript,
    args: [],
    env: { ...process.env, LLM_EXT_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
    reason: "test",
    log: (m) => lines.push(m),
    ...over,
  });
}

/** Poll to a deadline rather than sleeping blind — the child is detached, so
 *  there is nothing to await. Returns true as soon as the predicate holds. */
function waitFor(pred: () => boolean, ms = 30_000): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    // Yield the CPU instead of busy-spinning existsSync in a tight loop: a
    // failing case used to pin a core at 100% and block the vitest worker for
    // the full deadline (~90s across the three cases that use this). Atomics.wait
    // is synchronous, so the test stays a plain function — no async plumbing.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return pred();
}

/** Async twin of `waitFor`, for the one case that must race a poll against a
 *  child's 'exit' event: `waitFor`'s synchronous busy-poll blocks the event
 *  loop, so libuv can never reap the child or fire 'exit' while it runs. */
async function waitForAsync(pred: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await delay(25);
  }
  return pred();
}

describe("spawnDetachedBench — row 19: every spawn attempt stamps the log", () => {
  it("bumps an old log mtime and leaves a marker line even when the child writes nothing", () => {
    writeFileSync(logPath, "");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(logPath, old, old);
    const res = spawnWith();
    // No await between the call and the assertions: the child (noop.js) never
    // writes, so only the parent's own marker write can have changed the file.
    const mtimeMs = statSync(logPath).mtimeMs;
    expect(res.ok).toBe(true);
    expect(Math.abs(Date.now() - mtimeMs)).toBeLessThan(5_000);
    expect(readFileSync(logPath, "utf-8")).toMatch(/^\[llm-ext\] spawn attempt \d{4}-\d{2}-\d{2}T/m);
  });
});
describe("spawnDetachedBench — handing the lock down to the child (item 66)", () => {
  it("exports the lock path to the child as LLM_EXT_BENCH_LOCK_PATH", () => {
    const out = join(dir, "env.json");
    const tmp = out + ".tmp";
    const rec = join(dir, "record-env.js");
    // Write-then-rename: rename is atomic on POSIX, so the poll below can never
    // read a half-written file (the same trap default-profiles-runner.test.ts's
    // recorder already hit once).
    writeFileSync(
      rec,
      `const fs=require("fs"); fs.writeFileSync(${JSON.stringify(tmp)}, JSON.stringify(` +
        `process.env[${JSON.stringify(BENCH_LOCK_PATH_ENV)}] ?? null)); ` +
        `fs.renameSync(${JSON.stringify(tmp)}, ${JSON.stringify(out)}); process.exit(0);\n`,
    );
    expect(spawnWith({ scriptPath: rec }).ok).toBe(true);
    expect(waitFor(() => existsSync(out))).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toBe(lockPath);
  });

  it("ALWAYS exports our own lock path, never one inherited from an outer bench", () => {
    // A stale LLM_EXT_BENCH_LOCK_PATH in the ambient environment would make this
    // child delete a lock belonging to a different run.
    const out = join(dir, "env2.json");
    const tmp = out + ".tmp";
    const rec = join(dir, "record-env2.js");
    writeFileSync(
      rec,
      `const fs=require("fs"); fs.writeFileSync(${JSON.stringify(tmp)}, JSON.stringify(` +
        `process.env[${JSON.stringify(BENCH_LOCK_PATH_ENV)}] ?? null)); ` +
        `fs.renameSync(${JSON.stringify(tmp)}, ${JSON.stringify(out)}); process.exit(0);\n`,
    );
    const inherited = join(dir, "someone-elses.lock");
    expect(
      spawnWith({
        scriptPath: rec,
        env: {
          ...process.env,
          LLM_EXT_CONFIG_DIR: dir,
          [BENCH_LOCK_PATH_ENV]: inherited,
        } as NodeJS.ProcessEnv,
      }).ok,
    ).toBe(true);
    expect(waitFor(() => existsSync(out))).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toBe(lockPath);
  });

  it("a REAL benchmark child releases the lock when it exits — the P6d dogfood defect", () => {
    // The actual bundled entrypoint, reached exactly as production reaches it.
    // `--help` exits through `process.exit(0)` inside parseArgs, which is the
    // harshest non-signal exit path there is: it skips the rest of main()
    // entirely, and only a registered 'exit' hook survives it.
    const r = spawnWith({ scriptPath: resolveBenchmarkScriptPath(), args: ["--help"] });
    expect(r.ok).toBe(true);
    const gone = waitFor(() => !existsSync(lockPath));
    expect(
      gone,
      `lock still present after the child exited; stamp=${String(benchLockPid(lockPath))}, log:\n${
        existsSync(logPath) ? readFileSync(logPath, "utf-8").slice(0, 2000) : "(no log)"
      }`,
    ).toBe(true);
  });
});

describe("spawnDetachedBench — a lock whose pid is dead is FREE (item 66)", () => {
  it("takes over a lock a crashed/leaked child left behind, and says so exactly once", () => {
    // 2^22 is above every platform's pid_max, so this is the state the dogfood
    // run left: a real lock file naming a process that no longer exists.
    writeFileSync(lockPath, "4194304", "utf-8");
    expect(spawnWith().ok).toBe(true);
    const takeover = lines.filter((l) => l.includes("taking over a stale benchmark lock"));
    expect(takeover.length).toBe(1);
    expect(takeover[0]).toContain("4194304");
    expect(takeover[0]).toContain(lockPath);
  });

  it("still REFUSES while the pid is live — the takeover must not become a free-for-all", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8"); // this test process
    const r = spawnWith();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/already in progress/i);
    expect(lines.filter((l) => l.includes("taking over"))).toEqual([]);
    // And the live lock is untouched — a refused claim must not clear it.
    expect(benchLockPid(lockPath)).toBe(process.pid);
  });
});

describe("releaseOwnBenchLockOnExit — a REAL child dies BY THE SIGNAL it released on (SF-1)", () => {
  // Not spawnDetachedBench: that call detach()+unref()s the child and returns
  // only a pid, so there is nothing to listen for 'exit' on and no way to read
  // signalCode. This case needs the raw handle to distinguish "died by the
  // signal" from "called process.exit(143) and merely LOOKS the same" — the
  // masquerade the mandatory assertion below exists to catch. It exercises the
  // SOURCE function's own signal path directly (imports bench-lock.ts, not the
  // dist bundle); the existing "--help" real-child case above already covers
  // the dist bundle's entry-guard arming of this same hook.
  it.skipIf(process.platform === "win32")(
    "SIGTERM: the lock is gone, exitCode is null, and signalCode is SIGTERM — within a bounded deadline",
    async () => {
      // win32 has no POSIX signal disposition for the handler to re-raise into.
      const readyPath = join(dir, "ready");
      const script = [
        `import { releaseOwnBenchLockOnExit } from ${JSON.stringify(pathToFileURL(BENCH_LOCK_SRC).href)};`,
        `import { writeFileSync } from "node:fs";`,
        `releaseOwnBenchLockOnExit(process.env[${JSON.stringify(BENCH_LOCK_PATH_ENV)}]);`,
        `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
        `setInterval(() => {}, 1000);`,
      ].join("\n");

      const child: ChildProcess = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: { ...process.env, [BENCH_LOCK_PATH_ENV]: lockPath },
        },
      );
      let childStderr = "";
      child.stderr?.on("data", (d: Buffer) => (childStderr += d.toString()));

      const exited = new Promise<void>((resolveExit) =>
        child.on("exit", () => resolveExit()),
      );
      // If the child dies before it ever signals ready, the synchronous
      // waitFor above would hang until vitest's testTimeout — it blocks the
      // event loop, so 'exit' can never even be observed while it polls.
      // Race an async poll against the real 'exit' event instead, so a dead
      // child fails in milliseconds with its stderr in the message.
      const exitedBeforeReady = new Promise<never>((_resolve, rejectReady) =>
        child.once("exit", (code, signal) =>
          rejectReady(
            new Error(
              `child exited before signalling ready (code=${code}, signal=${signal}); stderr:\n${childStderr}`,
            ),
          ),
        ),
      );
      // The child's real (post-ready) exit fires this same 'exit' listener
      // again, rejecting `exitedBeforeReady` long after the race below has
      // settled — swallow that here so it never surfaces as an unhandled
      // rejection; Promise.race still saw the original, unmodified promise.
      exitedBeforeReady.catch(() => {});

      try {
        expect(
          await Promise.race([
            waitForAsync(() => existsSync(readyPath)),
            exitedBeforeReady,
          ]),
        ).toBe(true);
        // Production order: the parent's commitBenchLock re-stamps the lock
        // with the CHILD's pid only once the child exists (N-1).
        commitBenchLock(lockPath, child.pid as number);
        // The stamp must be observed BEFORE the kill, or "the lock is gone"
        // below would pass vacuously if the swallowed-error re-stamp never
        // actually landed.
        expect(benchLockPid(lockPath)).toBe(child.pid);

        child.kill("SIGTERM");

        // A synchronous poll cannot observe 'exit': it blocks the event loop
        // libuv needs to reap the child and fire the event, so signalCode
        // would never update. Await the real event instead, raced against a
        // deadline: a `once` -> `on` regression re-enters the SIGTERM handler
        // on the re-raise rather than hitting the default disposition, so the
        // child never actually exits and this times out red (proved manually
        // against a mutated once->on copy of bench-lock.ts — see the impl
        // report for the exact files compared).
        const TIMED_OUT = Symbol("timeout");
        const outcome = await Promise.race([
          exited.then(() => "exited" as const),
          new Promise<typeof TIMED_OUT>((r) =>
            setTimeout(() => r(TIMED_OUT), 5000),
          ),
        ]);
        expect(outcome).toBe("exited");

        // (1) the lock file is GONE.
        expect(existsSync(lockPath)).toBe(false);
        // (2) it died BY THE SIGNAL — signalCode, never exitCode. A
        // `process.exit(143)` masquerade sets exitCode=143 with signalCode
        // null and must fail these two assertions.
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBe("SIGTERM");
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    },
  );
});

describe("claimBenchLock — 4 parallel claimers on ONE stale lock, at most two of four win (SF-4)", () => {
  it("at least one child gets ok:true; every loser gets held; the file ends up stamped with a winner's pid", async () => {
    // A dead pid, the same sentinel bench-lock.test.ts uses: 2^22 is above
    // every platform's default pid_max, so it can never collide with one of
    // the 4 fresh claimer pids below — unlike spawn-a-no-op-and-reap-its-pid,
    // which stays a REAL pid the OS can (and under load, will) hand straight
    // back to one of those 4 children, turning it live out from under us.
    const deadPid = 4194304;
    writeFileSync(lockPath, String(deadPid), "utf-8");

    const script = [
      `import { claimBenchLock } from ${JSON.stringify(pathToFileURL(BENCH_LOCK_SRC).href)};`,
      `console.log(JSON.stringify(claimBenchLock(process.argv[1])));`,
      // Stay alive until the parent has read our result and kills us. An
      // immediate exit turns a WINNER's pid into a fresh dead pid, and a late
      // claimer would then legitimately take over that "abandoned" lock — two
      // winners on a perfectly correct tree, a false failure this suite must
      // not manufacture.
      `process.stdin.resume();`,
    ].join("\n");

    const children = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ["--input-type=module", "-e", script, lockPath]),
    );

    const results = await Promise.all(
      children.map(
        (child, i) =>
          new Promise<{ ok: boolean; reason?: string }>(
            (resolveResult, rejectResult) => {
              let out = "";
              let err = "";
              child.stderr.on("data", (d: Buffer) => (err += d.toString()));
              child.stdout.on("data", (d: Buffer) => {
                out += d.toString();
                const nl = out.indexOf("\n");
                if (nl !== -1) resolveResult(JSON.parse(out.slice(0, nl)));
              });
              // A child that dies before printing its result line must fail
              // fast with a diagnostic, never hang until vitest's 900s
              // testTimeout: race the stdout wait against the child's own
              // exit and reject with what it printed to stderr.
              child.on("exit", (code, signal) => {
                rejectResult(
                  new Error(
                    `claimer #${i} exited before printing a result (code=${code}, signal=${signal}); stderr:\n${err}`,
                  ),
                );
              });
            },
          ),
      ),
    );

    for (const child of children) child.kill("SIGKILL");

    // Exactly one winner is the overwhelmingly common outcome, but it is NOT
    // guaranteed: claimBenchLock's stale-takeover branch (see its header
    // comment in bench-lock.ts) has a documented residual few-syscall window
    // in which two claimers can both observe the stale lock as takeable and
    // both win — the accepted failure direction there is a duplicate $0
    // bench run, never a wedge or a torn stamp. Asserting winners.length ===
    // 1 flaked under host CPU contention (2/15 runs), so this test asserts
    // the real invariant instead: no wedge (at least one winner), no torn
    // stamp (every loser was genuinely told "held", and the lock names a
    // pid that belongs to one of the winners), and no result went missing —
    // capped at 2 winners: the stale file is moved by exactly one claimer,
    // and every other win needs a gap that a LOSING claimer opened (a filled
    // gap, or a link-back a stealer then moves), so with n = 4 winners <=
    // (n+1)/2 = 2 — a systemic bug letting all four through still fails
    // here. Proof sketch: the comment above observedStalePid in
    // claimBenchLock.
    expect(results.length).toBe(4);
    const winnerIndices = results
      .map((r, i) => (r.ok ? i : -1))
      .filter((i) => i !== -1);
    const losers = results.filter((r) => !r.ok);
    expect(winnerIndices.length).toBeGreaterThanOrEqual(1);
    expect(winnerIndices.length).toBeLessThanOrEqual(2);
    for (const l of losers) expect(l.reason).toBe("held");

    const finalContent = readFileSync(lockPath, "utf-8").trim();
    expect(finalContent.length).toBeGreaterThan(0);
    const finalPid = Number(finalContent);
    expect(Number.isInteger(finalPid)).toBe(true);
    const winnerPids = winnerIndices.map((i) => children[i].pid);
    expect(winnerPids).toContain(finalPid);
  });
});


describe("spawnDetachedBench — alreadyHeld refuses a caller that does not own the lock (SF-2b)", () => {
  it("lock stamped with a live foreign pid + alreadyHeld:true -> ok:false and the lock file is untouched", () => {
    // Relies on the parent (the vitest runner) staying alive for the test's duration.
    // process.ppid is alive and is not this process: exactly a caller claiming a lock it does not hold.
    writeFileSync(lockPath, String(process.ppid), "utf-8");
    const before = readFileSync(lockPath);

    const r = spawnWith({ alreadyHeld: true });

    expect(r.ok).toBe(false);
    expect(readFileSync(lockPath).equals(before)).toBe(true);
  });

  it("an async spawn error does NOT release a lock now owned by another live pid", async () => {
    // A nonexistent execPath makes spawn() emit an ASYNC 'error' event (ENOENT). Between the claim and that
    // event another process may take the lock over; releasing it then would admit a double spawn.
    const realExecPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: join(dir, "no-such-node"), configurable: true, writable: true });
    try {
      spawnWith();
    } finally {
      Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true, writable: true });
    }
    // process.ppid (the vitest runner) is alive and is not this process: a foreign live owner.
    writeFileSync(lockPath, String(process.ppid), "utf-8");
    expect(await waitForAsync(() => lines.some((l) => l.includes("detached bench failed to start")), 10_000)).toBe(true);
    expect(benchLockPid(lockPath)).toBe(process.ppid);
  });
});
