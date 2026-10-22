/**
 * The one way this codebase starts a detached benchmark child.
 *
 * Two modules need it — free-pool-auto-bench.ts (score the `:free` pool) and
 * default-profiles-runner.ts (populate a machine-managed default profile) — and
 * for a while they each had their own copy of the same 40 lines. Every bug in
 * that sequence therefore existed twice, and a repair applied to one copy left
 * the other broken: the leaked log fd was fixed in both only because a review
 * happened to look at both, while the `mkdirSync(getConfigDir())` bug and the
 * clobbered reason env var were fixed in one and survived in the other.
 *
 * So the sequence lives here, once. Callers keep their POLICY (when to bench,
 * what to refuse, what to tell the user); this owns the MECHANICS, all of which
 * are non-obvious and each of which has already been a bug:
 *
 *   - claim the lock BEFORE spawning, atomically (see bench-lock.ts);
 *   - create the directories the log and lock actually live in — not the config
 *     dir, which is not the same thing once a caller injects a path;
 *   - close OUR copy of the log fd after spawn: spawn() dup'd it into the child,
 *     and the parent's descriptor is a separate open-file entry nothing reaps,
 *     so a long-lived server leaked one fd per bench;
 *   - attach an 'error' listener: a spawn failure arrives ASYNCHRONOUSLY, and an
 *     'error' event with no listener is re-thrown as an uncaught exception from
 *     a detached tick no try/catch can reach — it would kill the MCP server;
 *   - roll the lock back on every failure path, so a bench that never started
 *     cannot block the next attempt.
 *
 * Every path FAILS OPEN. A benchmark we could not start must never fail the
 * command the user actually ran.
 */

import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claimBenchLock, commitBenchLock, releaseBenchLock } from "./bench-lock.js";

/**
 * Locate the bundled benchmark entrypoint.
 *
 * When esbuild-bundles the server, every src/* file collapses into
 * dist/index.js and the benchmark entrypoint sits beside it as dist/benchmark.js.
 * When running from compiled src/ output (tests), we still want dist/benchmark.js
 * so the child boots the exact code path a user would.
 */
export function resolveBenchmarkScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = pathResolve(here, "benchmark.js");
  if (existsSync(bundled)) return bundled;
  return pathResolve(here, "..", "dist", "benchmark.js");
}

export interface SpawnDetachedBenchOpts {
  /** Duplicate-spawn lock. Claimed before spawn, released on any failure. */
  lockPath: string;
  /** Child stdout+stderr are appended here. */
  logPath: string;
  /** The benchmark entrypoint to run under process.execPath. */
  scriptPath: string;
  /** Arguments after the script path. */
  args: readonly string[];
  /** Base environment for the child. */
  env: NodeJS.ProcessEnv;
  /**
   * Provenance for this bench, exported as LLM_EXT_AUTO_BENCH_REASON — the only
   * record of WHY a detached child ran, and the first thing to read when a log
   * shows a bench nobody expected. A reason already present in `env` WINS: the
   * reconcile path sets its own ("reconcile: +N/-M"), and overwriting it here
   * mislabelled every reconcile-driven bench as a transition that never
   * happened.
   */
  reason: string;
  /** Stderr sink — caller passes process.stderr.write or a stub. */
  log: (msg: string) => void;
}

export type SpawnDetachedBenchResult =
  | { ok: true; pid: number | null }
  | { ok: false; reason: string };

/**
 * Start a detached benchmark, or say precisely why it did not start.
 *
 * Never throws.
 */
export function spawnDetachedBench(opts: SpawnDetachedBenchOpts): SpawnDetachedBenchResult {
  const { lockPath, logPath, scriptPath, args, env, reason, log } = opts;

  // The directories that hold the LOG and the LOCK — deliberately not the
  // config dir. When a caller injects paths (tests, or a future per-profile
  // layout) the config dir is not where these files go, so creating it left a
  // first run failing on "cannot open log file" while making a directory
  // nobody asked for.
  for (const d of new Set([dirname(logPath), dirname(lockPath)])) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* already exists, or unwritable — the openSync below reports it properly */
    }
  }

  const claim = claimBenchLock(lockPath);
  if (!claim.ok) {
    return {
      ok: false,
      reason:
        claim.reason === "held"
          ? "a run is already in progress"
          : `cannot write lock ${lockPath}: ${claim.detail}`,
    };
  }

  let logFd: number;
  try {
    logFd = openSync(logPath, "a");
  } catch (e) {
    releaseBenchLock(lockPath);
    return { ok: false, reason: `cannot open log ${logPath}: ${(e as Error).message}` };
  }

  let child;
  try {
    child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...env, LLM_EXT_AUTO_BENCH_REASON: env.LLM_EXT_AUTO_BENCH_REASON ?? reason },
    });
  } catch (e) {
    // spawn() throws SYNCHRONOUSLY on argument/resource errors (EMFILE, ENOMEM,
    // a bad options shape).
    try {
      closeSync(logFd);
    } catch {
      /* already closed */
    }
    releaseBenchLock(lockPath);
    return { ok: false, reason: `spawn failed: ${(e as Error).message}` };
  }

  // MANDATORY, and NOT redundant with the try/catch above: a spawn FAILURE
  // (ENOENT on a missing benchmark.js, EACCES) is reported as an ASYNCHRONOUS
  // 'error' event. Per Node's EventEmitter contract an 'error' with no listener
  // is re-thrown as an UNCAUGHT EXCEPTION — from a detached tick that no
  // try/catch anywhere can reach — which would kill the whole process. The
  // benchmark is best-effort; the process is not.
  child.on("error", (e: Error) => {
    log(`[llm-externalizer] detached bench failed to start: ${e.message}\n`);
    // The child never existed, so its pid will never be reaped into staleness
    // by the liveness check. Release now rather than making the next attempt
    // wait out the TTL.
    releaseBenchLock(lockPath);
  });

  // Detach so the bench survives the parent's shutdown.
  child.unref();

  // Close OUR copy of the log fd. spawn() dup'd it into the child, so the child
  // keeps writing; the parent's descriptor is a SEPARATE open-file entry that
  // nothing ever reaps. In a long-lived MCP server that leaked one fd per bench,
  // and the first casualty of an eventual EMFILE is spawn() itself — i.e. this
  // feature, silently and permanently.
  try {
    closeSync(logFd);
  } catch {
    /* already closed */
  }

  if (typeof child.pid === "number") {
    // Hand the lock to the child. Until this point it holds OUR pid, which dies
    // with this process while the detached bench keeps running.
    commitBenchLock(lockPath, child.pid);
  } else {
    // No pid means the spawn is already failing; the 'error' listener above will
    // fire. Do not leave a lock stamped with an unusable pid.
    releaseBenchLock(lockPath);
  }

  return { ok: true, pid: child.pid ?? null };
}
