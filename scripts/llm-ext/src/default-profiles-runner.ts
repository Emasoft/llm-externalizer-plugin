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
 *   free            — proceeds immediately on FREE_POOL_SEED, the existing
 *   free-ensemble     "never dark" fallback (resolveAutoFreePool). Nothing is
 *                     blocked, nothing is spent, and the sweep upgrades the
 *                     pool for next time.
 *   paid            — no seed exists and none can: these are PAID pools, and
 *   paid-ensemble     any hardcoded default would either bill the user or go
 *   paid-mass-scout   stale. So the command fails fast with a remedy instead
 *                     of stalling 15 minutes or spending money nobody
 *                     authorized.
 *
 * The paid trio only auto-spawn under `allow_paid_models: true`. That is not a
 * new policy invented here — it is the same switch model-reconcile.ts already
 * applies (FREE: detect and adopt automatically; PAID: detect and report), and
 * benchmarking a paid model sends billable requests.
 *
 * Every path FAILS OPEN. A population we could not start must never fail the
 * tool the user actually ran.
 */

import { join } from "node:path";
import { getConfigDir, type DefaultProfileName } from "./config.js";
import { benchLockIsHeld } from "./bench-lock.js";
import { resolveBenchmarkScriptPath, spawnDetachedBench } from "./bench-spawn.js";

const DISABLE_ENV = "LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION";

/** Profiles that cost money to benchmark, and so never populate unasked. */
const PAID_PROFILES: ReadonlySet<string> = new Set(["paid", "paid-ensemble", "paid-mass-scout"]);

export type PopulationOutcome =
  /** A detached benchmark is now running; the caller may proceed (free) or report (paid). */
  | {
      kind: "spawned";
      profile: DefaultProfileName;
      pid: number | null;
      blocksCaller: boolean;
      /**
       * Where the child is writing. Carried on the outcome rather than
       * re-derived by the message sites: defaultProfileLogPath() calls
       * getConfigDir(), which THROWS on a config dir outside the allowlist, and
       * a message-rendering path is the last place that may throw.
       */
      logPath: string;
    }
  /** Nothing was started, and nothing needed to be. */
  | { kind: "skipped"; profile: DefaultProfileName; reason: string }
  /** Deliberately not started; `remedy` is the exact command the user can run. */
  | { kind: "refused"; profile: DefaultProfileName; reason: string; remedy: string };

function lockPathFor(profile: DefaultProfileName): string {
  return join(getConfigDir(), `default-profile-${profile}.lock`);
}

/** Where a population child's stdout/stderr lands — surfaced to the user when a
 *  paid population blocks their command, so "wait ~15 min" is checkable.
 *  Throws if the config dir is outside the allowlist (see getConfigDir), which
 *  is why the spawned outcome CARRIES its resolved path instead of calling this
 *  again from a message-rendering path. */
export function defaultProfileLogPath(profile: DefaultProfileName): string {
  return join(getConfigDir(), `default-profile-${profile}.log`);
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
    scriptPath = resolveBenchmarkScriptPath(),
    env = process.env,
  } = opts;

  const isPaid = PAID_PROFILES.has(profile);
  // `--allow-paid-models-tests` is REQUIRED for the paid two, and leaving it out
  // made this remedy a dead end: a user copy-pasting it hit the same opt-in
  // refusal the message was supposed to resolve. It grants nothing on its own —
  // the child re-reads `allow_paid_models` from settings.yaml and refuses first
  // on that master switch, which this flag explicitly cannot override.
  const remedy = isPaid
    ? `llm-ext-benchmark --populate-default-profile ${profile} --allow-paid-models-tests --budget-usd ${budgetUsd ?? 2}`
    : `llm-ext-benchmark --populate-default-profile ${profile}`;

  if (env[DISABLE_ENV] === "1") {
    return { kind: "skipped", profile, reason: `disabled via ${DISABLE_ENV}` };
  }

  // Resolve the paths HERE, not as destructuring defaults. Two reasons, and the
  // second one shipped as a real defect:
  //
  //   FAIL-OPEN — lockPathFor/defaultProfileLogPath call getConfigDir(), which
  //   THROWS when the config dir is outside its allowlist. As default parameters
  //   they were evaluated eagerly, on entry, so this function — documented
  //   "Never throws" and awaited from maybeEnsureDefaultProfileReady inside
  //   dispatchCallTool, which has no try/catch — could kill the user's tool call
  //   over a benchmark that is meant to be invisible.
  //
  //   ORDER — they also ran before the DISABLE_ENV opt-out, so a user who had
  //   explicitly turned population OFF still paid for (and could still be thrown
  //   by) a config-dir resolve.
  let lockPath: string;
  let logPath: string;
  try {
    lockPath = opts.lockPath ?? lockPathFor(profile);
    logPath = opts.logPath ?? defaultProfileLogPath(profile);
  } catch (e) {
    return { kind: "skipped", profile, reason: `config dir unusable: ${(e as Error).message}` };
  }

  // Checked BEFORE the paid gate: if a benchmark is already running there is
  // nothing to refuse and nothing to advise — saying "run this command" while
  // that very command is mid-flight would just get it run twice. Same predicate
  // spawnDetachedBench's atomic claim uses; this only buys the clearer message.
  if (benchLockIsHeld(lockPath)) {
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

  const args = ["--populate-default-profile", profile];
  if (isPaid) {
    // WITHOUT this the child dies in seconds at assertPaidBenchmarkAllowed's
    // per-run opt-in check, banks a failure cooldown, and retries forever on
    // backoff — so `ensemble`/`mass-scout` could NEVER auto-populate, even with
    // allow_paid_models: true. Passing it is not a loosening: the child reads
    // the MASTER switch (allow_paid_models) from settings.yaml itself and
    // refuses on that first, and this flag cannot override it. We only reach
    // here once that same master switch already gated us above, so this simply
    // carries the authorization the user already gave across the process
    // boundary — the flag exists to stop an UNATTENDED spend nobody asked for,
    // and this spend is exactly the one they asked for.
    args.push("--allow-paid-models-tests");
    if (budgetUsd !== undefined) args.push("--budget-usd", String(budgetUsd));
  }

  const spawned = spawnDetachedBench({
    lockPath,
    logPath,
    scriptPath,
    args,
    env,
    reason: `default-profile-population:${profile}`,
    log,
  });
  if (!spawned.ok) {
    return { kind: "skipped", profile, reason: spawned.reason };
  }

  return { kind: "spawned", profile, pid: spawned.pid, blocksCaller: isPaid, logPath };
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
        ? `[llm-externalizer] '${outcome.profile}' is being benchmarked now (~15 min). Re-run this command when it finishes; progress: ${outcome.logPath}\n`
        : null;
    case "skipped":
      return null;
  }
}
