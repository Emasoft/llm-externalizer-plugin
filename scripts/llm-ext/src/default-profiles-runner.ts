/**
 * Launching the population of a machine-managed default profile.
 *
 * The shape of this module is dictated by one hard fact: a keyword sweep takes
 * ~15 minutes and a full refresh 10-40. "Benchmark on first use" therefore can
 * NEVER mean "block the command the user just typed". So population is always a
 * DETACHED child process (the same approach free-pool-auto-bench.ts already
 * uses for the free pool), and what differs per profile is what the CURRENT
 * command does while that child runs:
 *
 *   free        — proceeds immediately on FREE_POOL_SEED, the existing
 *                 "never dark" fallback (resolveAutoFreePool). Nothing is
 *                 blocked, nothing is spent, and the sweep upgrades the pool
 *                 for next time.
 *   ensemble    — no seed exists and none can: these are PAID pools, and any
 *   mass-scout    hardcoded default would either bill the user or go stale.
 *                 So the command fails fast with a remedy instead of stalling
 *                 15 minutes or spending money nobody authorized.
 *
 * The paid pair only auto-spawn under `allow_paid_models: true`. That is not a
 * new policy invented here — it is the same switch model-reconcile.ts already
 * applies (FREE: detect and adopt automatically; PAID: detect and report), and
 * benchmarking a paid model sends billable requests.
 *
 * Every path FAILS OPEN. A population we could not start must never fail the
 * tool the user actually ran.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfigDir, type DefaultProfileName } from "./config.js";

const DISABLE_ENV = "LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION";

/** Profiles that cost money to benchmark, and so never populate unasked. */
const PAID_PROFILES: ReadonlySet<string> = new Set(["ensemble", "mass-scout"]);

export type PopulationOutcome =
  /** A detached benchmark is now running; the caller may proceed (free) or report (paid). */
  | { kind: "spawned"; profile: DefaultProfileName; pid: number | null; blocksCaller: boolean }
  /** Nothing was started, and nothing needed to be. */
  | { kind: "skipped"; profile: DefaultProfileName; reason: string }
  /** Deliberately not started; `remedy` is the exact command the user can run. */
  | { kind: "refused"; profile: DefaultProfileName; reason: string; remedy: string };

/**
 * Locate the bundled benchmark entrypoint. Mirrors
 * free-pool-auto-bench.resolveBenchmarkScriptPath: when esbuild-bundled every
 * src/* file collapses into dist/index.js and benchmark.js sits beside it;
 * when running from compiled src/ (tests) we still want dist/benchmark.js so
 * the child boots the exact code path a user would.
 */
export function resolveBenchmarkScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = pathResolve(here, "benchmark.js");
  if (existsSync(bundled)) return bundled;
  return pathResolve(here, "..", "dist", "benchmark.js");
}

function lockPathFor(profile: DefaultProfileName): string {
  return join(getConfigDir(), `default-profile-${profile}.lock`);
}

function logPathFor(profile: DefaultProfileName): string {
  return join(getConfigDir(), `default-profile-${profile}.log`);
}

/**
 * True iff the lock holds a still-running PID. A stale lock (process gone)
 * reads as unlocked, so a crashed benchmark cannot wedge a profile forever —
 * which for `free` would mean permanently running on the seed pool.
 */
function lockHoldsLivePid(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      // Signal 0 does not kill — it only asks whether the pid exists.
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means alive but owned by another user; only ESRCH means gone.
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

export interface PopulateOpts {
  profile: DefaultProfileName;
  /** The active `allow_paid_models` value — the paid pair honour it. */
  allowPaidModels: boolean;
  /** Stderr sink; caller passes process.stderr.write or a stub. */
  log: (msg: string) => void;
  /** Budget ceiling handed to the child for the paid profiles. */
  budgetUsd?: number;
  lockPath?: string;
  logPath?: string;
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Start populating `profile` if it should be started, and say what happened.
 *
 * Never throws, never blocks, never waits for the child.
 */
export function populateDefaultProfile(opts: PopulateOpts): PopulationOutcome {
  const {
    profile,
    allowPaidModels,
    log,
    budgetUsd,
    lockPath = lockPathFor(opts.profile),
    logPath = logPathFor(opts.profile),
    scriptPath = resolveBenchmarkScriptPath(),
    env = process.env,
  } = opts;

  const isPaid = PAID_PROFILES.has(profile);
  const remedy = isPaid
    ? `llm-ext-benchmark --populate-default-profile ${profile} --budget-usd ${budgetUsd ?? 2}`
    : `llm-ext-benchmark --populate-default-profile ${profile}`;

  if (env[DISABLE_ENV] === "1") {
    return { kind: "skipped", profile, reason: `disabled via ${DISABLE_ENV}` };
  }

  // Checked BEFORE the paid gate: if a benchmark is already running there is
  // nothing to refuse and nothing to advise — saying "run this command" while
  // that very command is mid-flight would just get it run twice.
  if (lockHoldsLivePid(lockPath)) {
    return { kind: "skipped", profile, reason: "a population run is already in progress" };
  }

  if (isPaid && !allowPaidModels) {
    return {
      kind: "refused",
      profile,
      reason:
        `'${profile}' has not been benchmarked yet, and benchmarking it sends billable ` +
        `requests while allow_paid_models is false`,
      remedy,
    };
  }

  try {
    mkdirSync(getConfigDir(), { recursive: true });
  } catch {
    /* already exists */
  }

  let logFd: number;
  try {
    logFd = openSync(logPath, "a");
  } catch (e) {
    return {
      kind: "skipped",
      profile,
      reason: `cannot open log ${logPath}: ${(e as Error).message}`,
    };
  }

  const argv = [scriptPath, "--populate-default-profile", profile];
  if (isPaid && budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));

  let child;
  try {
    child = spawn(process.execPath, argv, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...env, LLM_EXT_AUTO_BENCH_REASON: `default-profile-population:${profile}` },
    });
  } catch (e) {
    // spawn() throws SYNCHRONOUSLY on argument/resource errors (EMFILE, ENOMEM).
    try { closeSync(logFd); } catch { /* already closed */ }
    return { kind: "skipped", profile, reason: `spawn failed: ${(e as Error).message}` };
  }

  // MANDATORY, and not redundant with the try/catch: a spawn FAILURE (ENOENT on
  // a missing benchmark.js, EACCES) arrives as an ASYNCHRONOUS 'error' event.
  // Per Node's EventEmitter contract an 'error' with no listener is re-thrown as
  // an UNCAUGHT EXCEPTION — from a detached tick no try/catch can reach — which
  // would kill the whole process. Population is best-effort; the process is not.
  child.on("error", (e: Error) => {
    log(`[llm-externalizer] default-profile population (${profile}) failed to start: ${e.message}\n`);
  });

  child.unref();

  try {
    writeFileSync(lockPath, String(child.pid ?? ""), "utf-8");
  } catch {
    /* lock unwritable — duplicate-spawn detection degrades, population still runs */
  }

  return { kind: "spawned", profile, pid: child.pid ?? null, blocksCaller: isPaid };
}

/**
 * Render a one-line, actionable message for an outcome — or null when there is
 * nothing worth saying (the `free` path is designed to be invisible: the user
 * asked a question, they get an answer, and the pool quietly improves).
 */
export function describeOutcome(outcome: PopulationOutcome): string | null {
  switch (outcome.kind) {
    case "refused":
      return `[llm-externalizer] ${outcome.reason}.\n  Run: ${outcome.remedy}\n  Or set allow_paid_models: true in settings.yaml to let it populate on first use.\n`;
    case "spawned":
      return outcome.blocksCaller
        ? `[llm-externalizer] '${outcome.profile}' is being benchmarked now (~15 min). Re-run this command when it finishes; progress: ${logPathFor(outcome.profile)}\n`
        : null;
    case "skipped":
      return null;
  }
}
