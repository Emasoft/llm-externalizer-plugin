/**
 * Persistent per-profile bookkeeping for the machine-managed default profiles
 * (`free`, `ensemble`, `mass-scout`).
 *
 * WHY a sidecar rather than more keys in settings.yaml: this is MACHINE state,
 * not user configuration. Writing it into settings.yaml would mean rewriting a
 * hand-edited file on a routine "nothing changed" check, and would put a
 * fingerprint the user cannot meaningfully edit next to settings they own.
 *
 * Every read fails OPEN (missing/corrupt/unreadable ⇒ empty state). A lost
 * state file must degrade to "re-check on next use", never to a crash and never
 * to a refusal to run — the state is an optimisation, not a source of truth.
 * The source of truth for "is this profile populated" is settings.yaml itself.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, type DefaultProfileName } from "./config.js";

/** What we remember about one default profile's last population. */
export interface DefaultProfileRecord {
  /** Epoch ms of the last COMPLETED benchmark for this profile. */
  lastBenchmarkAt: number;
  /**
   * Fingerprint of the candidate pool that produced the current picks. A
   * CHANGE here — not the mere existence of unconfigured ids — is what means
   * "the world moved". See poolFingerprint() in default-profiles.ts.
   */
  poolFingerprint: string;
  /** The ids written into the profile, for diagnostics and reporting. */
  modelIds: string[];
  /** Consecutive failed benchmark attempts; drives the retry backoff. */
  failCount: number;
  /** Epoch ms before which no further attempt should be made. */
  cooldownUntil: number;
}

export interface DefaultProfilesState {
  version: 1;
  profiles: Partial<Record<DefaultProfileName, DefaultProfileRecord>>;
}

// Each fail-open path below builds a FRESH empty state rather than returning a
// shared constant — a caller that mutated a shared one would poison every
// later read in the process.

export function defaultProfilesStatePath(): string {
  return join(getConfigDir(), "default-profiles-state.json");
}

/** Read the state. Never throws: any problem yields the empty state. */
export function readDefaultProfilesState(): DefaultProfilesState {
  const path = defaultProfilesStatePath();
  if (!existsSync(path)) return { version: 1, profiles: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return { version: 1, profiles: {} };
    const state = parsed as Partial<DefaultProfilesState>;
    if (state.version !== 1 || typeof state.profiles !== "object" || state.profiles === null) {
      return { version: 1, profiles: {} };
    }
    return { version: 1, profiles: state.profiles };
  } catch {
    // Corrupt JSON is not an error condition here — see the fail-open note above.
    return { version: 1, profiles: {} };
  }
}

/**
 * Write the state atomically (tmp + rename, 0600). Never throws: a state write
 * failing must not fail the command the user actually asked for. The cost of a
 * lost write is one redundant re-check, which is the safe direction.
 */
export function writeDefaultProfilesState(state: DefaultProfilesState): void {
  const path = defaultProfilesStatePath();
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    try { chmodSync(tmp, 0o600); } catch { /* Windows may not support chmod */ }
    renameSync(tmp, path);
  } catch {
    // Best-effort cleanup so a failed write cannot litter the config dir with
    // tmp files that a later reader might mistake for the real thing.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing further to do */ }
  }
}

/** Read one profile's record, or undefined when never benchmarked. */
export function getProfileRecord(name: DefaultProfileName): DefaultProfileRecord | undefined {
  return readDefaultProfilesState().profiles[name];
}

/** Merge one profile's record back into the state, leaving the others alone. */
export function putProfileRecord(name: DefaultProfileName, record: DefaultProfileRecord): void {
  const state = readDefaultProfilesState();
  state.profiles[name] = record;
  writeDefaultProfilesState(state);
}

/** Bank a SUCCESSFUL population: clears the failure backoff. */
export function recordBenchmarkSuccess(
  name: DefaultProfileName,
  poolFingerprint: string,
  modelIds: readonly string[],
  nowMs: number,
): void {
  putProfileRecord(name, {
    lastBenchmarkAt: nowMs,
    poolFingerprint,
    modelIds: [...modelIds],
    failCount: 0,
    cooldownUntil: 0,
  });
}

/** Exponential backoff after a failed attempt: 15min, 1h, 4h, capped at 24h. */
const BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000];

/**
 * Bank a FAILED attempt and set the cooldown. Without this a profile whose
 * benchmark cannot succeed (no API key, provider outage, empty catalog) would
 * retry on every single command — for the paid profiles that is repeated
 * billable spend, and for `free` it is a stall on every invocation.
 */
export function recordBenchmarkFailure(name: DefaultProfileName, nowMs: number): void {
  const prev = getProfileRecord(name);
  const failCount = (prev?.failCount ?? 0) + 1;
  const backoff = BACKOFF_MS[Math.min(failCount - 1, BACKOFF_MS.length - 1)];
  putProfileRecord(name, {
    lastBenchmarkAt: prev?.lastBenchmarkAt ?? 0,
    // Keep the OLD fingerprint: the attempt failed, so the pool it was reacting
    // to has NOT been consumed. Banking the new one would mark the drift as
    // handled and the profile would never retry once the cooldown expired.
    poolFingerprint: prev?.poolFingerprint ?? "",
    modelIds: prev?.modelIds ?? [],
    failCount,
    cooldownUntil: nowMs + backoff,
  });
}
