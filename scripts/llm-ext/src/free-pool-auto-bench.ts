/**
 * Free-pool auto-benchmark trigger (TRDD-f1510055).
 *
 * When `free_only` flips ON and the benchmark cache contains no `:free`
 * entries, the MCP server spawns a detached process running
 * `node dist/benchmark.js --bench-free-pool` so the user's pool is scored
 * once without a manual command. Spawn is fire-and-forget, never blocks
 * the MCP server boot, and respects an env-var escape hatch.
 *
 * Cost-safety: the bench is genuinely $0 by construction — the runner's
 * airtight free_only guard (TRDD-97ef8b63) refuses any non-`:free`
 * model, and `--bench-free-pool` itself rejects any non-`:free` id at
 * the CLI argument layer. Both guards must fail for a paid call to
 * leak through.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./config.js";

// Resolved PER CALL through getConfigDir(), never as import-time constants
// built from homedir(). Two things broke when these were constants:
//
//   1. LLM_EXT_CONFIG_DIR was IGNORED here while settings.yaml honoured it, so
//      a run pointed at a scratch/CI config dir still read the cache, took the
//      lock, and wrote the log in the user's REAL ~/.llm-externalizer. The
//      "isolated" run therefore shared one lock with the real one and read
//      real benchmark results. Reproduced: a scratch-dir run spawned a child
//      that read the REAL settings.yaml and tried to benchmark the user's paid
//      models — only the allow_paid_models master switch stopped it.
//   2. getConfigDir() also resolves symlinks in the deepest existing ancestor
//      so mkdirSync(recursive) cannot be walked out of the allowed path via a
//      planted symlink. A plain join(homedir(), ...) skips that check, so this
//      module was bypassing a security control, not just an env var.
//
// Functions, not constants, because the env var must be read when the path is
// USED — a module-level call would freeze whatever the env held at first
// import, which is exactly the bug in a slower disguise (tests that set the
// var per-case would still collide).
const benchCachePath = (): string => join(getConfigDir(), "benchmark-results.json");
const benchLockPath = (): string => join(getConfigDir(), "free-pool-bench.lock");
const benchLogPath = (): string => join(getConfigDir(), "free-pool-bench.log");
const DISABLE_ENV = "LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH";

/** Public so tests can override; default looks up the bundled benchmark.js
 *  relative to whichever .js loaded this module (works for both the
 *  unbundled compile-time path and the esbuild-bundled dist/ layout). */
export function resolveBenchmarkScriptPath(): string {
  // When bundled, every src/* file collapses into dist/index.js and the
  // benchmark entrypoint lives next to it as dist/benchmark.js. When run
  // from compiled src/ output (tests), we still want dist/benchmark.js
  // so the spawned process boots the exact code path the user would.
  const here = dirname(fileURLToPath(import.meta.url));
  // Try `<here>/benchmark.js` (bundled dist layout) first, then
  // `<here>/../dist/benchmark.js` (running from src/ during tests).
  const bundled = pathResolve(here, "benchmark.js");
  if (existsSync(bundled)) return bundled;
  const fromSrc = pathResolve(here, "..", "dist", "benchmark.js");
  return fromSrc;
}

/** True iff the cached benchmark JSON contains at least one `:free` model
 *  in its `results[]` array. Missing/unreadable cache returns false. */
function benchCacheHasFreeEntries(cachePath: string = benchCachePath()): boolean {
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as { results?: Array<{ modelId?: string }> };
    if (!Array.isArray(data?.results)) return false;
    return data.results.some(
      (r) => typeof r?.modelId === "string" && r.modelId.endsWith(":free"),
    );
  } catch {
    return false;
  }
}

/** True iff a lock file holds a still-alive PID. Stale locks (PID gone)
 *  return false AND the caller should clear the lock. */
function lockHoldsLivePid(lockPath: string = benchLockPath()): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    // `process.kill(pid, 0)` doesn't kill — it only checks existence.
    // Throws ESRCH if the process is gone; throws EPERM if alive but
    // unowned. Either non-throw means the PID is in the process table.
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
      return false;
    }
  } catch {
    return false;
  }
}

export interface MaybeTriggerOpts {
  /** Active profile name — used only for log/telemetry context. */
  activeProfile: string;
  /** Is the active profile currently free_only? Caller pre-resolves. */
  freeOnlyActive: boolean;
  /** Was free_only ON before this transition? null = startup (unknown). */
  freeOnlyWasOn: boolean | null;
  /** Stderr sink — caller supplies process.stderr.write or a stub. */
  log: (msg: string) => void;
  /** Override for the cache path (tests). Default: ~/.llm-externalizer/benchmark-results.json. */
  cachePath?: string;
  /** Override for the lock path (tests). Default: ~/.llm-externalizer/free-pool-bench.lock. */
  lockPath?: string;
  /** Override for the log path (tests). Default: ~/.llm-externalizer/free-pool-bench.log. */
  logPath?: string;
  /** Override for the benchmark.js path (tests). Default: resolved via import.meta.url. */
  scriptPath?: string;
  /** Override for the env-var check (tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Force a bench even when the cache already holds `:free` entries. The auto-
   * reconcile sets this when it has just CHANGED the pool: the cache's old scores
   * don't cover the newly-adopted models, so "cache has entries" must not skip.
   * The lock check and env opt-out still apply — force never double-spawns.
   */
  force?: boolean;
}

export interface TriggerResult {
  /** What happened. "spawned" = bench launched; "skipped" = pre-check failed. */
  outcome: "spawned" | "skipped";
  /** Why it was skipped, or null if spawned. */
  reason: string | null;
  /** Child PID, or null if not spawned. */
  pid: number | null;
}

/**
 * Decide whether to spawn the free-pool auto-bench and do so if needed.
 *
 * Skip conditions (in order):
 *   1. free_only not active → nothing to do.
 *   2. Env-var escape hatch set → user opted out.
 *   3. Cache already has `:free` entries → no need to re-bench.
 *   4. Live lock present → another bench is already running.
 *   5. This is a settings reload AND free_only was already ON before
 *      → not a *transition*, just a re-resolve.
 *
 * Otherwise: spawn a detached `node <benchmark.js> --bench-free-pool`,
 * write the child PID to the lock file, log to benchLogPath(), return.
 */
export function maybeTriggerFreePoolBench(
  opts: MaybeTriggerOpts,
): TriggerResult {
  const {
    activeProfile,
    freeOnlyActive,
    freeOnlyWasOn,
    log,
    cachePath = benchCachePath(),
    lockPath = benchLockPath(),
    logPath = benchLogPath(),
    scriptPath = resolveBenchmarkScriptPath(),
    env = process.env,
    force = false,
  } = opts;

  if (!freeOnlyActive) {
    return { outcome: "skipped", reason: "free_only not active", pid: null };
  }
  if (env[DISABLE_ENV] === "1") {
    log(
      `[llm-externalizer] free-pool auto-bench: ${DISABLE_ENV}=1 — skipped by opt-out.\n`,
    );
    return { outcome: "skipped", reason: "disabled via env", pid: null };
  }
  // `force` (a reconcile-driven pool change) bypasses the cache-has-entries skip:
  // the newly-adopted models are unscored, so an existing cache is exactly the
  // case that DOES need a re-bench.
  if (!force && benchCacheHasFreeEntries(cachePath)) {
    return {
      outcome: "skipped",
      reason: "cache already has :free entries",
      pid: null,
    };
  }
  if (lockHoldsLivePid(lockPath)) {
    log(
      `[llm-externalizer] free-pool auto-bench: another run is already in progress (see ${lockPath}).\n`,
    );
    return {
      outcome: "skipped",
      reason: "lock holds live pid",
      pid: null,
    };
  }
  if (!force && freeOnlyWasOn === true) {
    // Reload of an already-free_only profile — not a *transition*, so
    // not the moment the user expects an auto-bench to fire. `force` (a reconcile
    // pool change) is exactly the case that SHOULD re-bench regardless.
    return {
      outcome: "skipped",
      reason: "not a free_only transition",
      pid: null,
    };
  }

  // Ensure the config dir exists (first-run case where the user never
  // touched settings.yaml manually).
  try {
    mkdirSync(getConfigDir(), { recursive: true });
  } catch {
    /* dir already exists — fine */
  }

  // Open the log file in append mode and hand the fd to the child's
  // stdout+stderr. The fd stays open across our return; the OS reaps
  // it when the child exits.
  let logFd: number;
  try {
    logFd = openSync(logPath, "a");
  } catch (e) {
    log(
      `[llm-externalizer] free-pool auto-bench: could not open log ${logPath}: ${
        (e as Error).message
      }\n`,
    );
    return { outcome: "skipped", reason: "cannot open log file", pid: null };
  }

  let child;
  try {
    child = spawn(
      process.execPath,
      [scriptPath, "--bench-free-pool", "--min-f1", "0.5"],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...env, LLM_EXT_AUTO_BENCH_REASON: `free_only_transition:${activeProfile}` },
      },
    );
  } catch (e) {
    // spawn() throws SYNCHRONOUSLY on argument/resource errors (EMFILE, ENOMEM,
    // a bad options shape). This is a fire-and-forget optimisation launched from
    // the reconcile pre-flight, which is contractually fail-open — a benchmark
    // we could not start must never fail the tool the user actually ran.
    log(
      `[llm-externalizer] free-pool auto-bench: could not spawn: ${(e as Error).message}\n`,
    );
    try {
      closeSync(logFd);
    } catch {
      /* already closed */
    }
    return { outcome: "skipped", reason: "spawn failed", pid: null };
  }

  // MANDATORY, and NOT redundant with the try/catch above: a spawn FAILURE
  // (ENOENT on a missing benchmark.js, EACCES) is reported as an ASYNCHRONOUS
  // 'error' event, not a throw. An 'error' event with no listener is, per Node's
  // EventEmitter contract, re-thrown as an UNCAUGHT EXCEPTION — which would kill
  // the whole MCP server, from a detached tick that no try/catch anywhere can
  // reach. The fail-open contract dies with it. Swallowing to a log is the entire
  // point: the bench is best-effort, the server is not.
  child.on("error", (e: Error) => {
    log(`[llm-externalizer] free-pool auto-bench: child failed to start: ${e.message}\n`);
  });

  // Detach so the bench survives MCP server shutdown.
  child.unref();

  // Best-effort PID record. If the write fails (e.g. read-only FS) we
  // still log + return — the bench is already running.
  try {
    writeFileSync(lockPath, String(child.pid ?? ""), "utf-8");
  } catch {
    /* lock unwritable — duplicate-spawn detection silently degrades */
  }

  log(
    `[llm-externalizer] free_only transition for profile '${activeProfile}' + no :free entries in cache → spawned auto-bench (pid ${child.pid}). Log: ${logPath}\n`,
  );

  return { outcome: "spawned", reason: null, pid: child.pid ?? null };
}
