// WHY (TRDD-5Q79QZM7 scope 2, USER requirement: "a command must never stay blocked; when a profile's models fail,
// llm-ext repairs the profile and the command works"): when every model of a generated profile fails, the command
// used to start a BACKGROUND update and answer retry-later. This module is the foreground half: wait, bounded, for
// that same update (the detached child that holds the profile's SG2 lock -- requestProfileUpdate already guarantees
// one sweep per profile, so a second session just waits on the first one's lock) and let the caller retry.
// It does NOT run a second benchmark path: the populate logic stays in the detached child.
//
// The wait is on the update's recorded OUTCOME, never on the lock alone: polling only "is the lock held" returned
// ok at once when the child had not taken the lock yet, and equally ok when the update FAILED and released it.
// The outcome is read from the stamps the updater already writes (default-profiles-state.ts), each compared with
// the baseline taken BEFORE the update was requested:
//   re-benchmarked: dynamic record lastBenchmarkAt (stamped only by a completed benchmark child);
//   pruned only:    lastMaintainedAt once the lock is free (a $0 maintainer pass; no re-benchmark happened);
//   failure:        the legacy record's lastFailureAt (recordBenchmarkFailure, which also sets the backoff) -- a
//                   timestamp, not the shared failCount, so another session's earlier failure is never ours.
// Ordering (verified): every one of those records is written by the child while it still holds the lock (the
// benchmark child writes before it exits; the detector hands its lock to the benchmark child instead of releasing
// it), and a lock is released only by the holder's exit. So a free lock with no new record means the updater died
// without booking anything, and that is reported at once -- no grace period is needed. `held` is read BEFORE the
// records so a record written between the two reads is still seen.
import { AsyncLocalStorage } from "node:async_hooks";
import { benchLockIsHeld } from "./bench-lock.js";
import { commandStopReason } from "./command-stop.js";
import { backgroundUpdateLockPathFor, type ProfileUpdateRequest } from "./default-profiles-runner.js";
import { getDynamicProfileRecord, getProfileRecord } from "./default-profiles-state.js";
import type { DynamicProfileName } from "./config.js";

export const FOREGROUND_REPAIR_TIMEOUT_ENV = "LLM_EXT_FOREGROUND_REPAIR_TIMEOUT_MS";
export const DEFAULT_FOREGROUND_REPAIR_TIMEOUT_MS = 10 * 60_000;
export const FOREGROUND_REPAIR_POLL_MS = 500;

/** Missing/blank/non-positive/non-finite -> the default (same fail-safe as parseCatalogTtlMs). */
export function parseForegroundRepairTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_FOREGROUND_REPAIR_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FOREGROUND_REPAIR_TIMEOUT_MS;
}

/** Taken BEFORE the update is requested (the spawn may finish and record within milliseconds); an outcome counts
 *  only if it is stamped at or after this time. */
export interface UpdateBaseline {
  sinceMs: number;
}
export function takeUpdateBaseline(): UpdateBaseline {
  return { sinceMs: Date.now() };
}

/** What failDynamicProfile recorded for the running invocation: the profile whose models all failed and the
 *  update request it made. Absent when the failure was a key/credit/request-specific verdict. */
export interface DynamicExhaustion {
  /** True inside the single same-run retry: failDynamicProfile then starts no further update. */
  retry?: boolean;
  profile?: DynamicProfileName;
  update?: Exclude<ProfileUpdateRequest, { state: "unavailable" }>;
  baseline?: UpdateBaseline;
  /** Items of a multi-item tool that already succeeded in this run (processFileCheck adds them). Zero for a
   *  single-request tool, so the whole call can be retried; above zero the call is never re-run whole. */
  itemsSucceeded?: number;
}
export const dynamicExhaustionStore = new AsyncLocalStorage<DynamicExhaustion>();

/** `rebenchmarked: false` is a $0 maintainer pass that only pruned/reordered models. */
export type ForegroundWaitOutcome = { ok: true; rebenchmarked: boolean } | { ok: false; why: string; failed: boolean };

type Outcome = { kind: "pending" } | { kind: "rebenchmarked" } | { kind: "pruned" } | { kind: "failed"; why: string } | { kind: "ended" };

function readOutcome(profile: DynamicProfileName, base: UpdateBaseline, lockHeld: boolean): Outcome {
  const legacy = getProfileRecord(profile);
  if ((legacy?.lastFailureAt ?? 0) >= base.sinceMs) {
    const until = legacy?.cooldownUntil ? ` (next automatic attempt after ${new Date(legacy.cooldownUntil).toISOString()})` : "";
    return { kind: "failed", why: `the update failed (benchmark attempt ${legacy?.failCount ?? "?"} did not succeed)${until}` };
  }
  const dyn = getDynamicProfileRecord(profile);
  if ((dyn?.lastBenchmarkAt ?? 0) >= base.sinceMs) return { kind: "rebenchmarked" };
  if (lockHeld) return { kind: "pending" };
  if ((dyn?.lastMaintainedAt ?? 0) >= base.sinceMs) return { kind: "pruned" };
  return { kind: "ended" };
}

/** Wait (bounded) for the profile's update to record an outcome newer than `base`. */
export async function waitForProfileUpdate(
  profile: DynamicProfileName,
  update: Exclude<ProfileUpdateRequest, { state: "unavailable" }>,
  base: UpdateBaseline,
  env: NodeJS.ProcessEnv = process.env,
  limitMs: number = parseForegroundRepairTimeoutMs(env[FOREGROUND_REPAIR_TIMEOUT_ENV]),
): Promise<ForegroundWaitOutcome> {
  if (update.state === "recent") {
    return {
      ok: false,
      failed: false,
      why: "an update of this profile finished or failed recently, so no new one was started",
    };
  }
  const lockPath = backgroundUpdateLockPathFor(profile);
  const deadline = Date.now() + limitMs;
  for (;;) {
    // WHY: a command stopped by --command_timeout must not sit out the repair wait. Without this check the loop
    // polled until the update ended or the limit passed, so the 30 s stop grace ended the process with no summary
    // and no unfinished-file list. Checked before every poll, and so before every sleep.
    const stopped = commandStopReason();
    if (stopped !== null) return { ok: false, failed: false, why: `the command was stopped (${stopped})` };
    const held = benchLockIsHeld(lockPath);
    const outcome = readOutcome(profile, base, held);
    if (outcome.kind === "rebenchmarked") return { ok: true, rebenchmarked: true };
    if (outcome.kind === "pruned") return { ok: true, rebenchmarked: false };
    if (outcome.kind === "failed") return { ok: false, failed: true, why: outcome.why };
    if (outcome.kind === "ended") return { ok: false, failed: true, why: "the update ended without recording a result" };
    if (Date.now() >= deadline) {
      return {
        ok: false,
        failed: false,
        why: `the update was still running after ${Math.round(limitMs / 1000)} s (${FOREGROUND_REPAIR_TIMEOUT_ENV})`,
      };
    }
    await new Promise((r) => setTimeout(r, FOREGROUND_REPAIR_POLL_MS));
  }
}