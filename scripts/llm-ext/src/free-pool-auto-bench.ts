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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import { benchLockIsHeld } from "./bench-lock.js";
import { resolveBenchmarkScriptPath, spawnDetachedBench } from "./bench-spawn.js";

// The bench cache/lock/log live in the CONFIG dir, resolved PER CALL through
// getConfigDir() (see maybeTriggerFreePoolBench), never as import-time
// constants built from homedir(). Two things broke when these were constants:
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
// Resolved at CALL time, not at module scope, because the env var must be read
// when the path is USED — a module-level call would freeze whatever the env
// held at first import, which is exactly the bug in a slower disguise (tests
// that set the var per-case would still collide).
const BENCH_CACHE_FILE = "benchmark-results.json";
const BENCH_LOCK_FILE = "free-pool-bench.lock";
const BENCH_LOG_FILE = "free-pool-bench.log";
const DISABLE_ENV = "LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH";

/** True iff the cached benchmark JSON contains at least one `:free` model
 *  in its `results[]` array. Missing/unreadable cache returns false. */
function benchCacheHasFreeEntries(cachePath: string): boolean {
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

export interface MaybeTriggerOpts {
  /** Active profile name — used only for log/telemetry context. */
  activeProfile: string;
  /** Is the active profile currently free_only? Caller pre-resolves. */
  freeOnlyActive: boolean;
  /** Was free_only ON before this transition? null = startup (unknown). */
  freeOnlyWasOn: boolean | null;
  /** Stderr sink — caller supplies process.stderr.write or a stub. */
  log: (msg: string) => void;
  /** Override for the cache path (tests). Default: <getConfigDir()>/benchmark-results.json. */
  cachePath?: string;
  /** Override for the lock path (tests). Default: <getConfigDir()>/free-pool-bench.lock. */
  lockPath?: string;
  /** Override for the log path (tests). Default: <getConfigDir()>/free-pool-bench.log. */
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
 * write the child PID to the lock file, log to the resolved log path, return.
 */
export function maybeTriggerFreePoolBench(
  opts: MaybeTriggerOpts,
): TriggerResult {
  const {
    activeProfile,
    freeOnlyActive,
    freeOnlyWasOn,
    log,
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

  // Resolve the config dir ONCE, after the two cheap skips above, and only when
  // a path was NOT injected. Two reasons this is not a default-parameter
  // expression:
  //
  //   PERF — a destructuring default is evaluated eagerly, before the first
  //   skip check, so three getConfigDir() calls (each walking ancestors with
  //   realpathSync) ran on every settings reload even though the overwhelmingly
  //   common outcome is an immediate "free_only not active" return.
  //
  //   FAIL-OPEN — getConfigDir() THROWS when the resolved dir escapes its
  //   allowlist ($HOME or /tmp). This function is fire-and-forget: index.ts calls it
  //   from the module-load boot IIFE and from the middle of applyNewSettings'
  //   ATOMIC swap, and neither wraps it. A throw out of a default parameter
  //   would kill boot outright, or leave that swap half-published (new
  //   activeSettings, stale currentBackend). Every other failure in here
  //   degrades to a skip; this one must too.
  const needsConfigDir =
    opts.cachePath === undefined ||
    opts.lockPath === undefined ||
    opts.logPath === undefined;
  let configDir = "";
  if (needsConfigDir) {
    try {
      configDir = getConfigDir();
    } catch (e) {
      log(
        `[llm-externalizer] free-pool auto-bench: config dir unusable: ${
          (e as Error).message
        }\n`,
      );
      return { outcome: "skipped", reason: "config dir unavailable", pid: null };
    }
  }
  const cachePath = opts.cachePath ?? join(configDir, BENCH_CACHE_FILE);
  const lockPath = opts.lockPath ?? join(configDir, BENCH_LOCK_FILE);
  const logPath = opts.logPath ?? join(configDir, BENCH_LOG_FILE);

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
  // Cheap early-out with the SAME predicate spawnDetachedBench's atomic claim
  // uses — this only buys a clearer log line and skips the work below; the
  // claim inside spawnDetachedBench is the actual guard against a double spawn.
  if (benchLockIsHeld(lockPath)) {
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

  const spawned = spawnDetachedBench({
    lockPath,
    logPath,
    scriptPath,
    args: ["--bench-free-pool", "--min-f1", "0.5"],
    env,
    reason: `free_only_transition:${activeProfile}`,
    log,
  });
  if (!spawned.ok) {
    log(`[llm-externalizer] free-pool auto-bench: ${spawned.reason}.\n`);
    return { outcome: "skipped", reason: spawned.reason, pid: null };
  }

  log(
    `[llm-externalizer] free_only transition for profile '${activeProfile}' + no :free entries in cache → spawned auto-bench (pid ${spawned.pid}). Log: ${logPath}\n`,
  );

  return { outcome: "spawned", reason: null, pid: spawned.pid };
}
