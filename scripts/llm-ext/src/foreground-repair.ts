// WHY (TRDD-5Q79QZM7 scope 2, USER requirement: "a command must never stay blocked; when a profile's models fail,
// llm-ext repairs the profile and the command works"): when every model of a generated profile fails, the command
// used to start a BACKGROUND update and answer retry-later. This module is the foreground half: wait, bounded, for
// that same update (the detached child that holds the profile's SG2 lock -- requestProfileUpdate already guarantees
// one sweep per profile, so a second session just waits on the first one's lock) and let the caller retry.
// It does NOT run a second benchmark path: the populate logic stays in the detached child.
//
// The wait is on the update's recorded OUTCOME, never on the lock alone: polling only "is the lock held" returned
// ok at once when the child had not taken the lock yet, and equally ok when the update FAILED and released it.
// The outcome is read from the stamps the updater already writes (default-profiles-state.ts):
//   success: dynamic record lastBenchmarkAt (the benchmark child, on a completed run), or lastMaintainedAt once
//            the lock is free (a requested maintainer pass that needed no benchmark);
//   failure: the legacy record's failCount grew (recordBenchmarkFailure, which also sets the backoff).
import { AsyncLocalStorage } from "node:async_hooks";
import { benchLockIsHeld } from "./bench-lock.js";
import { backgroundUpdateLockPathFor, type ProfileUpdateRequest } from "./default-profiles-runner.js";
import { getDynamicProfileRecord, getProfileRecord } from "./default-profiles-state.js";
import type { DynamicProfileName } from "./config.js";

export const FOREGROUND_REPAIR_TIMEOUT_ENV = "LLM_EXT_FOREGROUND_REPAIR_TIMEOUT_MS";
export const DEFAULT_FOREGROUND_REPAIR_TIMEOUT_MS = 10 * 60_000;
const FOREGROUND_REPAIR_POLL_MS = 500;
/** The lock is free, no outcome is recorded, and this long has passed since the request: the child died unbooked. */
const NO_RESULT_GRACE_MS = 3_000;

/** Tools whose single call is ONE request; every other LLM tool fans out over files/items and is never re-run whole. */
export const SINGLE_REQUEST_TOOLS: ReadonlySet<string> = new Set(["chat", "code_task"]);

/** Missing/blank/non-positive/non-finite -> the default (same fail-safe as parseCatalogTtlMs). */
export function parseForegroundRepairTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_FOREGROUND_REPAIR_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FOREGROUND_REPAIR_TIMEOUT_MS;
}

/** State taken BEFORE the update is requested; an outcome counts only if it is newer than this. */
export interface UpdateBaseline {
  sinceMs: number;
  failCount: number;
}
export function takeUpdateBaseline(profile: DynamicProfileName): UpdateBaseline {
  return { sinceMs: Date.now(), failCount: getProfileRecord(profile)?.failCount ?? 0 };
}

/** What failDynamicProfile recorded for the running invocation: the profile whose models all failed and the
 *  update request it made. Absent when the failure was a key/credit/request-specific verdict. */
export interface DynamicExhaustion {
  /** True inside the single same-run retry: failDynamicProfile then starts no further update. */
  retry?: boolean;
  profile?: DynamicProfileName;
  update?: Exclude<ProfileUpdateRequest, { state: "unavailable" }>;
  baseline?: UpdateBaseline;
}
export const dynamicExhaustionStore = new AsyncLocalStorage<DynamicExhaustion>();

export type ForegroundWaitOutcome = { ok: true } | { ok: false; why: string; failed: boolean };

type Outcome = { kind: "pending" } | { kind: "success" } | { kind: "failed"; why: string };

function readOutcome(profile: DynamicProfileName, base: UpdateBaseline, lockHeld: boolean): Outcome {
  const legacy = getProfileRecord(profile);
  if ((legacy?.failCount ?? 0) > base.failCount) {
    const until = legacy?.cooldownUntil ? ` (next automatic attempt after ${new Date(legacy.cooldownUntil).toISOString()})` : "";
    return { kind: "failed", why: `the update failed (benchmark attempt ${legacy?.failCount ?? "?"} did not succeed)${until}` };
  }
  const dyn = getDynamicProfileRecord(profile);
  if ((dyn?.lastBenchmarkAt ?? 0) >= base.sinceMs) return { kind: "success" };
  if (!lockHeld && (dyn?.lastMaintainedAt ?? 0) >= base.sinceMs) return { kind: "success" };
  return { kind: "pending" };
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
    const held = benchLockIsHeld(lockPath);
    const outcome = readOutcome(profile, base, held);
    if (outcome.kind === "success") return { ok: true };
    if (outcome.kind === "failed") return { ok: false, failed: true, why: outcome.why };
    if (!held && Date.now() - base.sinceMs > NO_RESULT_GRACE_MS) {
      return { ok: false, failed: true, why: "the update ended without recording a result" };
    }
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