/**
 * Launching the population of a machine-managed dynamic profile.
 *
 * The shape of this module is dictated by one hard fact: a keyword sweep takes
 * ~15 minutes and a full refresh 10-40. "Benchmark on first use" therefore can
 * NEVER mean "block the command the user just typed". So population is always a
 * DETACHED child process, and what differs per profile is what the CURRENT
 * command does while that child runs:
 *
 *   free — proceeds immediately on activeFreePool()'s free_only branch: the
 *          profile's own free_models, unchanged (an empty list stays empty —
 *          no FREE_POOL_SEED substitute, Rule 5; the maintainer keeps this
 *          pool populated). A STATIC profile with an empty pool is refused by
 *          activeFreePool's second branch instead. FREE_POOL_SEED
 *          (resolveAutoFreePool) is only the seed the dynamic free benchmark
 *          starts from. Nothing is blocked, nothing is spent, and the sweep
 *          upgrades the pool for next time.
 *   paid — no seed exists and none can: it is a PAID pool, and any hardcoded
 *          default would either bill the user or go stale. So the command
 *          fails fast with a remedy instead of stalling 15 minutes or
 *          spending money nobody authorized.
 *
 * `paid` only auto-spawns under `allow_paid_models: true`. That is not a
 * new policy invented here — it is the same switch model-reconcile.ts already
 * applies (FREE: detect and adopt automatically; PAID: detect and report), and
 * benchmarking a paid model sends billable requests.
 *
 * Every path FAILS OPEN. A population we could not start must never fail the
 * tool the user actually ran.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, loadSettings, type DynamicProfileName } from "./config.js";
import { benchLockIsHeld } from "./bench-lock.js";
import { DISABLE_RECONCILE_ENV } from "./model-reconcile.js";
import { getDynamicProfileRecord, getProfileRecord } from "./default-profiles-state.js";
import {
  resolveBenchmarkScriptPath,
  spawnDetachedBench,
  type SpawnDetachedBenchResult,
} from "./bench-spawn.js";
import { DEFAULT_BUDGET_USD } from "./benchmark/budget.js";
import { dailyRemainingUsd } from "./benchmark/daily-spend.js";

const DISABLE_ENV = "LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION";

/** Profiles that cost money to benchmark, and so never populate unasked.
 *  P6c-a: exactly one name now — the retired static paid profiles are gone,
 *  and `paid` absorbed them. See PAID_RUN_CAP_USD below for its budget rule
 *  (min against the daily spend cap). */
const PAID_PROFILES: ReadonlySet<string> = new Set(["paid"]);

/** The per-run ceiling for the PAID dynamic profile, design §2.5: stays
 *  DEFAULT_BUDGET_USD but is always min'd with what's left of the daily cap. */
export const PAID_RUN_CAP_USD = DEFAULT_BUDGET_USD;

/** Every name this module can be asked to populate — the two dynamic ones
 *  (design §1.1). Kept as a named alias because it appears on the public
 *  PopulationOutcome shape; P6c-a narrowed it to DynamicProfileName when the
 *  legacy machine-owned names were retired. */
export type AnyProfileName = DynamicProfileName;

export type PopulationOutcome =
  /** A detached benchmark is now running; the caller may proceed (free) or report (paid). */
  | {
      kind: "spawned";
      profile: AnyProfileName;
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
  | { kind: "skipped"; profile: AnyProfileName; reason: string }
  /** Deliberately not started; `remedy` is the exact command the user can run. */
  | { kind: "refused"; profile: AnyProfileName; reason: string; remedy: string };

/**
 * SG2 (USER 2026-09-18, "then make it a singleton for each profile then"):
 * the ONE lock guarding ALL background update/benchmark work for `profile`
 * -- its detector (spawnDetachedDetector below), the update a command
 * requests when the profile has no working model (requestProfileUpdate,
 * D2), its populate/benchmark spawn (populateDefaultProfile) and its `local`
 * rescan (routed through the same populateDefaultProfile) all claim this
 * SAME path. No command ever waits on it (D2). Exported -- unlike the old
 * former private aliases -- because three different modules
 * must now agree on it byte-for-byte;
 * index.ts used to hand-duplicate the join() rather than widen this
 * module's surface for "one caller" (see its own updated comment) -- now
 * there are three agreeing callers, so duplicating the string a third time
 * is exactly the drift risk that old comment warned about.
 *
 * Trade-off (SG2 requirement 5), stated once here: while a profile's
 * benchmark sweep runs under this lock, that SAME profile's cheap
 * detector is now ALSO locked out -- it used to run on its own lock and
 * could check for drift mid-sweep (see the old comment this replaced,
 * preserved below at spawnDetachedDetector). Other profiles are
 * unaffected: only cross-mechanism concurrency WITHIN one profile is now
 * serialized, which is the entire point of a per-profile singleton.
 */
export function backgroundUpdateLockPathFor(profile: AnyProfileName): string {
  return join(getConfigDir(), `background-update-${profile}.lock`);
}

/** Where a population child's stdout/stderr lands — surfaced to the user when a
 *  paid population blocks their command, so "wait ~15 min" is checkable.
 *  Throws if the config dir is outside the allowlist (see getConfigDir), which
 *  is why the spawned outcome CARRIES its resolved path instead of calling this
 *  again from a message-rendering path. */
export function defaultProfileLogPath(profile: AnyProfileName): string {
  return join(getConfigDir(), `default-profile-${profile}.log`);
}

export interface PopulateOpts {
  profile: AnyProfileName;
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
  /**
   * SG2: true when the CALLER (the detector child spawned under this same
   * profile's lock, in either of its two modes -- see detectProfileChanges)
   * already exclusively holds `lockPath` and wants the populate/benchmark
   * phase HANDED that same lock rather than refused as "already in
   * progress" against itself. Default false preserves every existing
   * caller (a first-time population, the maintainer maintaining the OTHER
   * dynamic profile) which claims its own lock fresh, exactly as before.
   */
  alreadyHeldByCaller?: boolean;
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
    alreadyHeldByCaller = false,
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
  //   FAIL-OPEN — backgroundUpdateLockPathFor/defaultProfileLogPath call getConfigDir(), which
  //   THROWS when the config dir is outside its allowlist. As default parameters
  //   they were evaluated eagerly, on entry, so this function — documented
  //   "Never throws" — threw before it had decided anything at all. It used to be
  //   awaited from maybeEnsureDefaultProfileReady inside dispatchCallTool, which
  //   has NO try/catch, so that killed the user's tool call outright. P6c-a
  //   retired that caller; the only caller left is maintainOneDynamicProfile,
  //   which maintainDynamicProfiles DOES wrap in a per-name try/catch. So the
  //   throw is no longer fatal — it is silent: population for that profile is
  //   disabled on every dispatch and surfaces as a generic "maintenance failed"
  //   line instead of the config-dir reason. Returning a `skipped` outcome keeps
  //   the real reason visible on either caller.
  //
  //   ORDER — they also ran before the DISABLE_ENV opt-out, so a user who had
  //   explicitly turned population OFF still paid for (and could still be thrown
  //   by) a config-dir resolve.
  let lockPath: string;
  let logPath: string;
  try {
    lockPath = opts.lockPath ?? backgroundUpdateLockPathFor(profile);
    logPath = opts.logPath ?? defaultProfileLogPath(profile);
  } catch (e) {
    return { kind: "skipped", profile, reason: `config dir unusable: ${(e as Error).message}` };
  }

  // Checked BEFORE the paid gate: if a benchmark is already running there is
  // nothing to refuse and nothing to advise — saying "run this command" while
  // that very command is mid-flight would just get it run twice. Same predicate
  // spawnDetachedBench's atomic claim uses; this only buys the clearer message.
  //
  // SG2: skipped entirely when alreadyHeldByCaller -- the "run in progress"
  // IS us (the detector child that just decided to populate, or that is
  // running a requested update). Refusing here would silently drop every
  // automatic populate this profile's own detector child ever triggers,
  // under its own single lock.
  if (!alreadyHeldByCaller && benchLockIsHeld(lockPath)) {
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

  // The dynamic `paid` profile is additionally gated by the DAILY spend cap
  // (design §2.5): allow_paid_models authorizes spending at all, the daily
  // cap bounds how MUCH across every run today. The cap is specific to the
  // dynamic-profile maintainer's auto-benchmarking — a STATIC profile never
  // auto-benchmarks at all, so there is nothing of its to bound.
  let effectiveBudgetUsd = budgetUsd;
  if (profile === "paid") {
    const remaining = dailyRemainingUsd(loadSettings());
    if (remaining <= 0) {
      return {
        kind: "refused",
        profile,
        reason: "the daily paid-benchmark spend cap has been reached; no more billable requests today",
        remedy,
      };
    }
    effectiveBudgetUsd = Math.min(PAID_RUN_CAP_USD, remaining);
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
    if (effectiveBudgetUsd !== undefined) args.push("--budget-usd", String(effectiveBudgetUsd));
  }

  const spawned = spawnDetachedBench({
    lockPath,
    logPath,
    scriptPath,
    args,
    env,
    reason: `default-profile-population:${profile}`,
    log,
    // SG2: hand THIS lock to the new child atomically (bench-spawn.ts's
    // commitBenchLock) instead of re-claiming it -- re-claiming would fail
    // (the lock file already shows a live pid: ours) and refuse to spawn.
    alreadyHeld: alreadyHeldByCaller,
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

// ── C2b: the DETECTOR's detached spawn (TRDD-OE27RD7I) ──────────────────
//
// A separate, much cheaper detached child than the populate/benchmark spawn
// above: it only fetches the catalog and compares a fingerprint
// (profile-detector.ts's detectProfileChanges), never a 10-40 minute
// benchmark sweep.
//
// SG2 (USER 2026-09-18): this USED to sit on its OWN lock path specifically
// so a detector spawn could run "while a benchmark sweep for the same
// profile is in flight" -- quoted from the comment this replaced, kept here
// so the reason for the OLD design is not lost. The USER's explicit
// decision, after seeing that trade-off, was the opposite: ONE lock per
// profile, singleton across every mechanism, INCLUDING the detector -- a
// detector for profile X must now wait out profile X's own in-flight
// benchmark like everything else. So this now returns the SAME path as
// populate (backgroundUpdateLockPathFor); spawnDetachedDetector calls it directly.
//
// NOT part of this module: the spawned child's OWN argv-recognition of
// `--detect-profile-changes` (which script reads it and calls
// detectProfileChanges) and the index.ts call site that invokes
// spawnDetachedDetector below — both are the C2b-wire step; see the C2b-core
// report's "Wire step for index.ts" section for the exact 5-line call.

function detectLogPath(profile: AnyProfileName): string {
  return join(getConfigDir(), `detect-profile-${profile}.log`);
}

/**
 * The exact argv the detached DETECTOR child is spawned with — named here,
 * once, so the parent's spawn call and the child's own future argv-recognition
 * (wired in the C2b-wire step) can never spell the flag differently.
 */
export function detectProfileChangesArgs(profile: AnyProfileName): string[] {
  return ["--detect-profile-changes", profile];
}

/**
 * D2: set to "1" in the environment of a detector child that a COMMAND
 * requested because the profile has no working model (requestProfileUpdate
 * below). profile-detector.ts's detectProfileChanges reads it and runs the
 * update itself -- the maintainer pass, then the re-benchmark -- instead of
 * only comparing fingerprints. An env var, not an argv flag: the child's
 * argv is `--detect-profile-changes <name>` either way, so the benchmark
 * CLI's parser needs no second spelling of the same entry point.
 */
export const PROFILE_UPDATE_REQUESTED_ENV = "LLM_EXT_PROFILE_UPDATE_REQUESTED";

export interface SpawnDetectorOpts {
  profile: AnyProfileName;
  log: (msg: string) => void;
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  /** D2: spawn the child in "update requested" mode (PROFILE_UPDATE_REQUESTED_ENV). */
  updateRequested?: boolean;
}

/**
 * Spawn the detached DETECTOR for `profile`, or say precisely why not.
 *
 * Reuses the SAME detached-spawn primitive as populateDefaultProfile
 * (spawnDetachedBench, bench-spawn.ts's "one mechanism for every detached
 * child this codebase starts") under the SAME per-profile lock
 * (backgroundUpdateLockPathFor, SG2).
 *
 * Never throws, never blocks, never waits for the child.
 */
export function spawnDetachedDetector(opts: SpawnDetectorOpts): SpawnDetachedBenchResult {
  const { profile, log, scriptPath = resolveBenchmarkScriptPath(), env = process.env, updateRequested = false } = opts;
  // Set or REMOVED, never inherited: a plain detection spawned from a process
  // that itself carries the flag must not silently turn into a full update.
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (updateRequested) childEnv[PROFILE_UPDATE_REQUESTED_ENV] = "1";
  else delete childEnv[PROFILE_UPDATE_REQUESTED_ENV];
  return spawnDetachedBench({
    lockPath: backgroundUpdateLockPathFor(profile),
    logPath: detectLogPath(profile),
    scriptPath,
    args: detectProfileChangesArgs(profile),
    env: childEnv,
    reason: `${updateRequested ? "default-profile-update-requested" : "default-profile-detect"}:${profile}`,
    log,
  });
}

/**
 * D2 item 8, COORDINATOR DEFAULT (2026-09-18): once an update for a profile
 * has finished, a command that still finds no working model does not start
 * another one for this long. Without it every failing command would start a
 * new full update (for `paid`, a billable re-benchmark). A catalog change
 * inside the window still triggers one: the per-dispatch detector
 * (profile-detector.ts) spawns the updater on a fingerprint change.
 */
export const PROFILE_UPDATE_RESPAWN_MS = 30 * 60_000;

export type ProfileUpdateRequest =
  /** Spawned now (the detector child in "update requested" mode). */
  | { state: "started" }
  /** The profile's lock is held: something is already running (SG2: start nothing). The request is
   *  left as a marker for the lock's holder -- see markProfileUpdateRequested. */
  | { state: "running" }
  /** An update finished inside PROFILE_UPDATE_RESPAWN_MS, or the failure backoff is active: start nothing. */
  | { state: "recent" }
  /** Nothing is running and nothing could be started; `reason` says why. */
  | { state: "unavailable"; reason: string };

/**
 * D2 (orchestrator review, cross-command race): the persisted "update
 * requested" marker, beside the profile's lock. A command whose models all
 * failed while the lock was held by something else -- e.g. another command's
 * PLAIN detector, which finds no catalog change and would exit without
 * updating -- leaves this marker instead of losing its request. Whoever holds
 * the lock honours it before releasing (profile-detector.ts's
 * detectProfileChanges, in either mode), and the next requester honours it
 * past the respawn throttle. Its content is the epoch ms of the LATEST
 * request.
 */
export function backgroundUpdateRequestPathFor(profile: AnyProfileName): string {
  return join(getConfigDir(), `background-update-${profile}.requested`);
}

/** When the last update of `profile` finished: a successful benchmark
 *  (`lastBenchmarkAt`, also stamped by the local rescan) or a requested
 *  maintainer pass (`lastMaintainedAt`). 0 when never. */
function lastUpdateFinishedMs(profile: AnyProfileName): number {
  const record = getDynamicProfileRecord(profile);
  return Math.max(record?.lastBenchmarkAt ?? 0, record?.lastMaintainedAt ?? 0);
}

function markProfileUpdateRequested(profile: AnyProfileName, nowMs: number): void {
  writeFileSync(backgroundUpdateRequestPathFor(profile), String(nowMs), "utf-8");
}

/** True iff a request marker exists that no update finished after. An
 *  unreadable timestamp counts as pending: a spare update is cheaper than a
 *  lost one. */
export function profileUpdateRequestPending(profile: AnyProfileName): boolean {
  let raw: string;
  try {
    raw = readFileSync(backgroundUpdateRequestPathFor(profile), "utf-8");
  } catch {
    // Absent -- never written, or the lock's holder just consumed it.
    return false;
  }
  const requestedAtMs = Number(raw);
  return !Number.isFinite(requestedAtMs) || lastUpdateFinishedMs(profile) < requestedAtMs;
}

/** The failure backoff (recordBenchmarkFailure's cooldownUntil) is active:
 *  the profile's benchmark itself just FAILED, so re-running it now cannot
 *  help -- the one throttle even a pending request waits out. */
function failureBackoffActive(profile: AnyProfileName, nowMs: number): boolean {
  return nowMs < (getProfileRecord(profile)?.cooldownUntil ?? 0);
}

/** For the lock's holder: true iff a pending request must be honoured now
 *  (the marker is consumed). A marker an update already served is removed;
 *  one that is pending during a failure backoff is KEPT for later. */
export function takeProfileUpdateRequest(profile: AnyProfileName, nowMs: number = Date.now()): boolean {
  const pending = profileUpdateRequestPending(profile);
  if (pending && failureBackoffActive(profile, nowMs)) return false;
  clearProfileUpdateRequest(profile);
  return pending;
}

/** The requested update itself serves every request made so far. */
export function clearProfileUpdateRequest(profile: AnyProfileName): void {
  rmSync(backgroundUpdateRequestPathFor(profile), { force: true });
}

/**
 * D2 item 2 (USER 2026-09-18): make sure `profile`'s background update is
 * running -- start it if the profile's SG2 lock is free, start nothing if it
 * is held -- without ever waiting for it. The caller then fails the command
 * with the retry-later message (every state but "unavailable").
 *
 * The item-8 throttle reads only state that already exists:
 *   - the lock itself (benchLockIsHeld) -- running;
 *   - the dynamic record (dynamic-profiles-state.json): `lastBenchmarkAt`
 *     (stamped by a successful populate/benchmark child, and by the local
 *     rescan) and `lastMaintainedAt` (stamped by the maintainer pass a
 *     requested update runs, see maintainOneDynamicProfile's forceSweep);
 *   - the legacy record's `cooldownUntil` (default-profiles-state.json,
 *     recordBenchmarkFailure's backoff after a FAILED benchmark).
 * A pending request marker skips the 30-min window (orchestrator review: it
 * is a request some command already answered "retry later" to) but never the
 * failure backoff: re-running a benchmark that just failed is the respawn
 * storm item 8 exists to stop. The marker stays on disk until then.
 *
 * Never throws for a spawn problem (spawnDetachedBench never throws);
 * getConfigDir() failures propagate, as on every other path that resolves
 * this lock.
 */
export function requestProfileUpdate(
  opts: Omit<SpawnDetectorOpts, "updateRequested"> & { nowMs?: number },
): ProfileUpdateRequest {
  const { profile, nowMs = Date.now(), env = process.env } = opts;
  // The single documented opt-out for ALL dynamic maintenance (addendum F):
  // the child would refuse anyway (detectProfileChanges' first check), so
  // saying "an update is underway" here would be false.
  if (env[DISABLE_RECONCILE_ENV] === "1") {
    return { state: "unavailable", reason: `automatic maintenance is disabled by ${DISABLE_RECONCILE_ENV}=1` };
  }
  const lockPath = backgroundUpdateLockPathFor(profile);
  if (benchLockIsHeld(lockPath, nowMs)) {
    markProfileUpdateRequested(profile, nowMs);
    return { state: "running" };
  }
  if (failureBackoffActive(profile, nowMs)) return { state: "recent" };
  if (!profileUpdateRequestPending(profile)) {
    const lastFinishedMs = lastUpdateFinishedMs(profile);
    // `lastFinishedMs > 0`: a profile never updated has no window to be inside
    // (same never-claimed rule as profile-detector.ts's claimDetectThrottle).
    if (lastFinishedMs > 0 && nowMs - lastFinishedMs < PROFILE_UPDATE_RESPAWN_MS) return { state: "recent" };
  }
  const spawned = spawnDetachedDetector({ ...opts, updateRequested: true });
  if (spawned.ok) return { state: "started" };
  // Lost the atomic claim to a concurrent spawner: leave the request for it.
  if (benchLockIsHeld(lockPath)) {
    markProfileUpdateRequested(profile, nowMs);
    return { state: "running" };
  }
  return { state: "unavailable", reason: spawned.reason };
}
