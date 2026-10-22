/**
 * Persistent per-profile bookkeeping for the machine-managed dynamic profiles
 * (`free`, `paid`).
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
import { getConfigDir, type DynamicProfileName } from "./config.js";

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
  /**
   * Per-model spec fingerprint at last benchmark time (default-profiles.ts
   * modelSpecFingerprint, addendum I) — undefined for a model with no
   * baseline yet, which decideDynamicProfile treats as "nothing to compare"
   * rather than a false spec-change re-queue. Used by the two DYNAMIC
   * profiles (free/paid) only; the legacy lazy-population path never set it.
   */
  modelSpecFingerprints?: Record<string, string>;
  /**
   * Epoch ms of the last MAINTAINER pass over this dynamic profile (P6b-fix
   * S5). Distinct from lastBenchmarkAt on purpose: `settings status` says
   * "maintained as of <time>", and rendering the BENCHMARK clock there was
   * wrong twice over — it answers a different question, and
   * recordBenchmarkFailure preserves `lastBenchmarkAt: 0` on a
   * never-succeeded profile, so the label rendered 1970-01-01 instead of
   * "not yet maintained". Undefined/0 means "never maintained".
   */
  lastMaintainedAt?: number;
}

export interface DefaultProfilesState {
  version: 1;
  profiles: Partial<Record<DynamicProfileName, DefaultProfileRecord>>;
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
export function getProfileRecord(name: DynamicProfileName): DefaultProfileRecord | undefined {
  return readDefaultProfilesState().profiles[name];
}

/** Merge one profile's record back into the state, leaving the others alone. */
export function putProfileRecord(name: DynamicProfileName, record: DefaultProfileRecord): void {
  const state = readDefaultProfilesState();
  state.profiles[name] = record;
  writeDefaultProfilesState(state);
}

/** Bank a SUCCESSFUL population: clears the failure backoff. */
export function recordBenchmarkSuccess(
  name: DynamicProfileName,
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
export function recordBenchmarkFailure(name: DynamicProfileName, nowMs: number): void {
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



// -- DYNAMIC profile bookkeeping (free / paid) --------------------------
//
// A SEPARATE keyspace/file from the legacy DefaultProfilesState above
// (never mixed): the dynamic profiles are maintained continuously by
// decideDynamicProfile (default-profiles.ts), not by the lazy
// unpopulated -> benchmark trigger the legacy type serves. Reuses
// DefaultProfileRecord's shape (poolFingerprint = the paid-arrivals loop
// guard, modelSpecFingerprints = the per-model drift baseline) since both
// systems need the same bookkeeping fields, just keyed differently.

import { withMkdirLock } from "./mkdir-lock.js";

/**
 * P6b-fix2 N-7: the dynamic keyspace's record is the legacy one MINUS
 * `cooldownUntil`. Nothing on the dynamic path ever read that field — the
 * maintainer's failure backoff consults the LEGACY record
 * (`getProfileRecord(name)`, where `recordBenchmarkFailure` actually writes it)
 * — so carrying a second, always-stale copy here only invited a future reader
 * to consult the wrong one.
 */
export type DynamicProfileRecord = Omit<DefaultProfileRecord, "cooldownUntil">;

export interface DynamicProfilesState {
  version: 1;
  profiles: Partial<Record<DynamicProfileName, DynamicProfileRecord>>;
  /**
   * Epoch ms of the one-time pre-14.0.0 profile-section migration (P6c-a,
   * addendum K). Its PRESENCE, not its value, is what matters: before it, an
   * unmarked `free`/`paid` section is adopted or backed-up-and-regenerated;
   * after it, one is REFUSED by validateSettings instead. Without the stamp
   * the "back up and regenerate" branch would fire again every time the user
   * re-wrote the section, silently discarding their edit each time.
   *
   * Lives here rather than in settings.yaml because it is machine state, and
   * top-level (not per-profile) because the migration is one pass over the
   * whole document, not a per-profile decision.
   */
  migratedAt?: number;
  /**
   * D0 (TRDD-AL8GIZYA): step ids `migrateSettingsTo141` (benchmark/pick.ts)
   * has already applied — distinct from `migratedAt` above because the
   * 14.1.0 steps land in different SLICES of the same release (there is no
   * release between slices, design section 5), so a dev build that has only
   * run D0's step must not mark a later slice's step as done. Presence in
   * the array is what matters; order carries no meaning.
   */
  migrationsApplied?: string[];
}

export function dynamicProfilesStatePath(): string {
  return join(getConfigDir(), "dynamic-profiles-state.json");
}

function dynamicProfilesStateLockPath(): string {
  return join(getConfigDir(), "dynamic-profiles-state.lock");
}

/** Read the dynamic-profiles state. Never throws: any problem yields the
 *  empty state (same fail-open contract as readDefaultProfilesState). */
export function readDynamicProfilesState(): DynamicProfilesState {
  const path = dynamicProfilesStatePath();
  if (!existsSync(path)) return { version: 1, profiles: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return { version: 1, profiles: {} };
    const state = parsed as Partial<DynamicProfilesState>;
    if (state.version !== 1 || typeof state.profiles !== "object" || state.profiles === null) {
      return { version: 1, profiles: {} };
    }
    // `migratedAt` and `migrationsApplied` are carried through explicitly:
    // every write goes through this read, so a field dropped here is a field
    // ERASED on the next write — and erasing either re-arms a one-time,
    // file-rewriting migration (or, for migrationsApplied, an entire step).
    return {
      version: 1,
      profiles: state.profiles,
      ...(typeof state.migratedAt === "number" && isFinite(state.migratedAt)
        ? { migratedAt: state.migratedAt }
        : {}),
      ...(Array.isArray(state.migrationsApplied)
        ? { migrationsApplied: state.migrationsApplied.filter((s): s is string => typeof s === "string") }
        : {}),
    };
  } catch {
    return { version: 1, profiles: {} };
  }
}

/** Epoch ms of the one-time profile-section migration, or undefined when it
 *  has never completed. Fail-open: an unreadable state file reads as "not yet
 *  migrated", so the migration re-inspects rather than skipping forever. */
export function getProfileMigrationStamp(): number | undefined {
  return readDynamicProfilesState().migratedAt;
}

/** Record that the one-time profile-section migration completed. Written
 *  under the same lock as every other field of this file, so it cannot erase
 *  a record a concurrent maintainer just wrote. Returns the write error (never
 *  throws it) — B-1 (fix-queue review correction): the caller (migrateProfileSections)
 *  used to have no way to tell "persisted" from "silently dropped" and had to
 *  guess a cause ("directory not writable") that was not always true; this
 *  return value lets it quote the real cause instead. */
export function stampProfileMigrationDone(nowMs: number): Error | null {
  return withMkdirLock(dynamicProfilesStateLockPath(), () => {
    const state = readDynamicProfilesState();
    if (state.migratedAt !== undefined) return null;
    return writeDynamicProfilesState({ ...state, migratedAt: nowMs });
  });
}

/** Whether one 14.1.0 migration step (D0, TRDD-AL8GIZYA — see
 *  `migrationsApplied` above) has already run. Fail-open like every other
 *  read here: an unreadable state file reads as "not yet applied", so the
 *  step retries instead of being skipped forever. */
export function isMigrationStepApplied(stepId: string): boolean {
  return (readDynamicProfilesState().migrationsApplied ?? []).includes(stepId);
}

/** Record that one 14.1.0 migration step completed — idempotent (recording
 *  an already-recorded step is a no-op) and under the same lock as every
 *  other field of this file, mirroring stampProfileMigrationDone's contract
 *  (returns the write error instead of throwing it). Separate from that
 *  function on purpose: see `migrationsApplied`'s docblock for why one
 *  `migratedAt`-shaped stamp cannot serve both migrations. No `nowMs` — a
 *  step's PRESENCE in the list is all that matters, no per-step timestamp. */
export function markMigrationStepApplied(stepId: string): Error | null {
  return withMkdirLock(dynamicProfilesStateLockPath(), () => {
    const state = readDynamicProfilesState();
    const applied = state.migrationsApplied ?? [];
    if (applied.includes(stepId)) return null;
    return writeDynamicProfilesState({ ...state, migrationsApplied: [...applied, stepId] });
  });
}

/** Write the dynamic-profiles state atomically (tmp + rename, 0600). Never
 *  throws — a lost write just means a re-check next time (see the module
 *  docblock's fail-open contract). Returns the caught error instead (never
 *  throws it), so a caller that needs to know WHY a write was dropped can —
 *  see stampProfileMigrationDone above, its only caller that reads this.
 *
 *  P6b-fix3 N-8: MODULE-PRIVATE. It replaces the whole file wholesale, which is
 *  the exact primitive that caused the lost update S-4 fixed — `putDynamicProfileRecord`
 *  was DELETED for being an exported wrapper around it, and leaving the raw
 *  writer exported invited the same call straight back. Its one legitimate
 *  caller is `updateDynamicProfileRecord` below, inside the lock. */
function writeDynamicProfilesState(state: DynamicProfilesState): Error | null {
  const path = dynamicProfilesStatePath();
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    try { chmodSync(tmp, 0o600); } catch { /* Windows may not support chmod */ }
    renameSync(tmp, path);
    return null;
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing further to do */ }
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Read one dynamic profile's record, or undefined when never benchmarked. */
export function getDynamicProfileRecord(name: DynamicProfileName): DynamicProfileRecord | undefined {
  return readDynamicProfilesState().profiles[name];
}

/**
 * The ONE writer of a dynamic profile's record: read → mutate → write, all
 * INSIDE `<cfg>/dynamic-profiles-state.lock`.
 *
 * P6b-fix2 S-4 — WHY a mutator and not a finished record. Three processes write
 * this file (the maintainer twice per dispatch, a completing benchmark child
 * once), and the read-modify-write was unlocked, so each could write back a
 * snapshot taken before the other's write: the parent erased a child's
 * `lastBenchmarkAt`, the child reverted the parent's `poolFingerprint` (→ the
 * whole under-ceiling paid class re-queued → a billable spawn) or its
 * the spawn-time sweep stamp (retired by CE9B7S8N: the floor no longer keys on spawn time). Atomic tmp+rename answers a torn file,
 * not a lost update. Taking the caller's decision as `(prev) => next` puts the
 * READ inside the same lock as the write, so "carry the other party's field
 * forward" reads the value that is actually on disk.
 *
 * Returning `null` from `mutate` writes NOTHING (P6b-fix2 N-5): this file was
 * being rewritten on every single tool dispatch, twice, even when not one field
 * had moved.
 */
export function updateDynamicProfileRecord(
  name: DynamicProfileName,
  mutate: (prev: DynamicProfileRecord | undefined) => DynamicProfileRecord | null,
): void {
  withMkdirLock(dynamicProfilesStateLockPath(), () => {
    const state = readDynamicProfilesState();
    const next = mutate(state.profiles[name]);
    if (next === null) return;
    state.profiles[name] = next;
    writeDynamicProfilesState(state);
  });
}

/**
 * Bank the completion time of a benchmark run for a DYNAMIC profile, and
 * NOTHING else (P6b-fix B3).
 *
 * WHY only this one field: the maintainer owns `poolFingerprint` and
 * `modelSpecFingerprints` — it is the thing that took the decision those
 * fingerprints describe, so it is the only honest producer of them. A child
 * that also wrote a fingerprint would bank "the world as the CHILD saw it,
 * minutes later", and the next maintainer pass would compare its own view
 * against someone else's snapshot: either a spurious "changed" (a billable
 * re-queue of the whole paid class) or, worse, a spurious "unchanged" that
 * hides real drift. A record that does not exist yet is created with zeroed
 * bookkeeping rather than skipped, so `lastBenchmarkAt` is never lost.
 */
export function recordDynamicBenchmarkAt(name: DynamicProfileName, nowMs: number): void {
  // P6b-fix2 S-4: `prev` is read INSIDE the lock, so the maintainer's
  // concurrent update to the same record is carried forward rather than
  // overwritten with a snapshot taken before it.
  updateDynamicProfileRecord(name, (prev) => ({
    lastBenchmarkAt: nowMs,
    poolFingerprint: prev?.poolFingerprint ?? "",
    modelIds: prev?.modelIds ?? [],
    failCount: prev?.failCount ?? 0,
    modelSpecFingerprints: prev?.modelSpecFingerprints,
    lastMaintainedAt: prev?.lastMaintainedAt,
  }));
}
