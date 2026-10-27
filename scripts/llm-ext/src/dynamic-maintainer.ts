/**
 * P6b — the dynamic-profile maintainer + the "never fails" gate (design §2.1,
 * §3.3; p6-spec.md item 1; TRDD-90DM5YHO).
 *
 * `maintainDynamicProfiles` runs in a DETACHED child (D2: the detector child
 * a command requests when its profile has no working model — see that
 * function's own comment). It NEVER throws: every internal failure is
 * caught here and reduced to one stderr line, because a maintenance bug
 * must never take a command down with it. It keeps BOTH `free` and `paid` current
 * (design §2.1) regardless of which profile the running command uses, but
 * only ever WRITES through writeDynamicProfileSection's own load/compare/write
 * lock (addendum C) — never a document parsed outside that lock.
 *
 * `dynamicProfileGate` is the separate, synchronous read that decides
 * whether the EFFECTIVE profile can serve THIS call at all (design §3.3) —
 * it runs after the maintainer so it sees whatever the maintainer just wrote,
 * and it is the one place addendum H's free-tool refusal text lives.
 *
 * Opt-out: LLM_EXT_DISABLE_AUTO_RECONCILE=1 disables ALL dynamic maintenance
 * (addendum F) — the same var the legacy reconcile already documents, kept
 * so existing user config / CI scripts that set it once still cover the new
 * maintainer too, instead of needing a second variable nobody set.
 */

import { readFileSync, statSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  DYNAMIC_PROFILE_NAMES,
  isDynamicProfileName,
  isPlaceholderProfile,
  getEnsemblePriceCeiling,
  getSettingsPath,
  loadSettings,
  API_PRESETS,
  PLACEHOLDER_MODEL_ID,
  resolveEnvValue,
  // P6b-fix4 B1: both imported from the ONE owner. `chainModelIds` was a private
  // copy here; `validateProfile` is what the write guard below asks before
  // writing, so the maintainer and the boot/reload path judge a section by the
  // same function instead of the maintainer guessing what will be accepted.
  chainModelIds,
  validateProfile,
  // D0 (TRDD-AL8GIZYA): the regeneration gate's own check of the user-owned
  // subsections, so a `selection`/`high_quality_model` defect never triggers
  // a regeneration (design section 3.2 rule 4).
  validateUserOwnedKeys,
  coerceProviderBindings,
  // fix-queue 56: unpopulatedDefaultProfile backs the already-invalid
  // regenerate path and dynamicCredentialUsability's fallback below;
  // profileSectionMarkerState backs isMarkedDynamicSection. Merged into this
  // ONE ./config.js import per coordinator review S-2 (fix-queue row 1
  // removed exactly this shape elsewhere) rather than a second, mid-file
  // `import ... from "./config.js"`.
  // D0 fix-up (TRDD-AL8GIZYA): the `:371` choice AND dynamicCredentialUsability's
  // own free/paid ternary (the same local bug, same fix) both use this one
  // function instead — it already knows "local" too, so a third dynamic name
  // never falls through to the wrong shape.
  unpopulatedDefaultProfile,
  profileSectionMarkerState,
  // R-3: read the cap through the SAME accessor the §3.3 gate uses
  // (config.ts's "Single source of truth" comment on paidDailyCapUsd) instead
  // of the raw settings field — a present-but-invalid cap (null, string,
  // negative) must fall back to the default here too, not just at the gate.
  paidDailyCapUsd,
  // 3e (C2b-wire): resolve the free profile's OWN routes here, from the
  // `settings` already loaded for this pass, instead of leaving
  // readCandidates() to take its own fresh loadSettings() disk read below
  // (one source of settings per pass, not two that could disagree).
  resolveGroups,
  type DynamicProfileName,
  type Profile,
  type ResolvedRoute,
  type Settings,
} from "./config.js";
import { DISABLE_RECONCILE_ENV } from "./model-reconcile.js";
import {
  decideDynamicProfile,
  REPROBE_AFTER_MS,
  type DynamicCatalogEntry,
  type ProfilePatch,
  isFreeForbiddenTool,
} from "./default-profiles.js";
import {
  getDynamicProfileRecord,
  updateDynamicProfileRecord,
  getProfileRecord,
  type DynamicProfileRecord,
} from "./default-profiles-state.js";
import { getCatalog, catalogCachePath, catalogFetchRecentlyFailed } from "./catalog-cache.js";
import { filterFreeModels, type FreeModelCatalogEntry } from "./free-rotation.js";
import { isFreeSuffixModelId } from "./benchmark/free-mode.js";
import {
  benchmarkFailedModels,
  benchmarkPassedModels,
  staleFailedModelIds,
} from "./benchmark/security-triage/index.js";
import { assessModelPersistence, readModelEvents } from "./model-events.js";
import { writeDynamicProfileSection, GENERATED_MARKER, stableStringify, backupSettingsFile } from "./benchmark/pick.js";
import { readCandidates, enqueueCandidates } from "./dynamic-candidates.js";
import {
  populateDefaultProfile,
  describeOutcome,
  defaultProfileLogPath,
  backgroundUpdateLockPathFor,
} from "./default-profiles-runner.js";
import { dailyRemainingUsd } from "./benchmark/daily-spend.js";
// CE9B7S8N: the completion-keyed floor asks the bench lock whether a sweep
// child is ALIVE (SIGKILL-safe: dead-pid + TTL axes), replacing the old
// spawn-time lastSweepAt stamp whose 6 h silence outlived a killed child.
import { benchLockIsHeld } from "./bench-lock.js";

export { GENERATED_MARKER };

/** Raw OpenRouter model shape this module needs (a subset of index.ts's
 *  OpenRouterModelInfo — kept local so this file has no import on index.ts,
 *  which would be circular: index.ts is the one that calls in here). */
export interface RawCatalogModel extends FreeModelCatalogEntry {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
  supported_parameters?: readonly string[];
}

export function toDynamicCatalogEntry(m: RawCatalogModel): DynamicCatalogEntry {
  return {
    id: m.id,
    inputDollarsPerMillion: parseFloat(m.pricing?.prompt ?? "NaN") * 1_000_000,
    outputDollarsPerMillion: parseFloat(m.pricing?.completion ?? "NaN") * 1_000_000,
    contextLength: m.context_length,
    supportedParameters: m.supported_parameters,
  };
}

// ── addendum H: the free-tool refusal text, ONE exported source (P6c's
// doc-contract test reads this, not a retyped string in docs or elsewhere). ──

/** The fixed sentence, tool name substituted by the caller — kept apart from
 *  the paid-off suffix so a caller (or a doc) can quote either half exactly. */
export const FREE_TOOL_UNFIT_BASE = (tool: string): string =>
  `no free model is fit for ${tool}; use --profile paid`;
export const FREE_TOOL_UNFIT_PAID_OFF_SUFFIX = " (paid models are off: set allow_paid_models: true)";

/** addendum H: neither mass_scout nor high_quality_scan has a fitness
 *  benchmark today, so `free` always refuses them (P4 files the follow-up
 *  TRDD that will let the maintainer fill those two heads). */
export function freeToolUnfitRefusal(tool: string, allowPaidModels: boolean): string {
  return FREE_TOOL_UNFIT_BASE(tool) + (allowPaidModels ? "" : FREE_TOOL_UNFIT_PAID_OFF_SUFFIX);
}

function applyPatch(base: Profile, patch: ProfilePatch): Profile {
  const next: Profile = { ...base };
  if (patch.free_models !== undefined) next.free_models = patch.free_models;
  if (patch.paid_models !== undefined) next.paid_models = patch.paid_models;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.second_model !== undefined) next.second_model = patch.second_model;
  if (patch.third_model !== undefined) next.third_model = patch.third_model;
  if (patch.tool_models !== undefined) {
    // P6b-fix2 S-2: REPLACE, never merge. decideDynamicProfile builds
    // `tool_models` as the full REPLACEMENT set with every dropped key OMITTED
    // (a free-forbidden head, a dead head with no fallback, a head below a
    // tool's context floor), and its own change detection compares that set
    // against the whole current map. A merge re-added every omitted key, so the
    // $0 patch could never actually DROP a tool head — the decision said
    // "changed" on every dispatch forever and the head it condemned survived.
    next.tool_models = patch.tool_models;
  }
  return next;
}

/**
 * True iff `name`'s section in the CURRENT on-disk settings.yaml carries the
 * generated marker. fix-queue 56's backup-and-regenerate path only applies to
 * a MARKED section (llm-ext's own, now rejected by a validator rule) — an
 * UNMARKED `free`/`paid` section is either a pre-migration artifact
 * `migrateProfileSections` handles at boot (before the maintainer ever runs)
 * or, post-migration, something `validateSettings`'s reservedDynamicProfileNameError
 * already refuses at load time — neither is this function's to silently
 * overwrite. Re-parses settingsPath directly (not `settings`, which is
 * `loadSettings()`'s plain-object view and has already lost the comment).
 */
function isMarkedDynamicSection(settingsPath: string, name: DynamicProfileName): boolean {
  const text = readFileSync(settingsPath, "utf-8");
  return profileSectionMarkerState(parseDocument(text), name) === "marked";
}


export type RegenerateInvalidSectionOutcome =
  | { kind: "not-applicable" }
  | { kind: "user-keys-invalid"; errors: string[] }
  | { kind: "concurrent-fix" }
  | { kind: "regenerated"; regenerated: Profile; backupPath: string | undefined; errors: string[] };

/**
 * fix-queue 56: the back-up-and-regenerate repair for a MARKED generated
 * section (`free`/`paid`) that already fails `validateProfile` for a reason no
 * pending patch caused. Shared by the maintainer pass (which then repopulates
 * the pool) and by index.ts's dispatch path (which runs it inline, because an
 * invalid ACTIVE profile is refused as NOT CONFIGURED before the maintainer
 * can run -- the 2026-10-22 outage). Writes settings.yaml, with a backup, only
 * for kind "regenerated".
 */
export function regenerateInvalidMarkedSection(args: {
  name: DynamicProfileName;
  settingsPath: string;
  current: Profile;
  nowMs: number;
}): RegenerateInvalidSectionOutcome {
  const { name, settingsPath, current, nowMs } = args;
  // Only a MARKED section is ours to regenerate — see isMarkedDynamicSection's
  // own comment for why an unmarked one is out of scope here (migration or
  // validateSettings already own it).
  if (!isMarkedDynamicSection(settingsPath, name)) return { kind: "not-applicable" };
  // D0 (TRDD-AL8GIZYA, design section 3.2 rule 4): a user-owned-key error
  // (selection/high_quality_model) is NEVER a regeneration trigger — it is the
  // user's own data, and the regenerated placeholder would sit right next to it
  // untouched, so there is nothing for a regeneration to fix.
  const userKeysValidation = validateUserOwnedKeys(name, current);
  if (!userKeysValidation.valid) return { kind: "user-keys-invalid", errors: userKeysValidation.errors };
  const currentValidation = validateProfile(name, current);
  // Coordinator review B-1: `validateProfile` ALSO enforces the Remote-auth
  // rule, so a perfectly-configured section is "invalid" on any dispatch where
  // the API key is simply not exported. Detected with the structured
  // `credentialUsable` check, never by matching error text. A credential gap
  // (even alongside a structural defect) is NOT a regeneration trigger.
  const currentCredentialOnly = !credentialUsable(current, current);
  if (currentValidation.valid || currentCredentialOnly) return { kind: "not-applicable" };
  const regenerated = unpopulatedDefaultProfile(name);
  // Backup runs inside the lock callback, on ONLY the branch that overwrites,
  // so it names precisely the bytes overwritten (coordinator review S-1).
  let backupPath: string | undefined;
  const regenResult = writeDynamicProfileSection(
    settingsPath,
    name,
    // Re-validate the section AS IT IS UNDER THE LOCK: a concurrent writer may
    // have fixed it since `current` was read; never clobber a fresher valid
    // write with a stale "it was invalid" verdict (adversarial review fq56).
    (currentSection) => {
      if (currentSection !== undefined && validateProfile(name, currentSection).valid) {
        return currentSection;
      }
      // fix-queue row 72: shared backupSettingsFile — no `wrapError`, a backup
      // failure must throw its raw error to the caller's catch-and-log.
      backupPath = backupSettingsFile(settingsPath, "settings-before-regenerate", name, { nowMs });
      return regenerated;
    },
    // The writer's own notify is for the UNMARKED-section backup; this section
    // IS marked, so suppress it to avoid a second, misleading notice.
    { nowMs, notify: () => {} },
  );
  if (!regenResult.changed) return { kind: "concurrent-fix" };
  return { kind: "regenerated", regenerated, backupPath, errors: currentValidation.errors };
}

export interface MaintainDynamicProfilesInput {
  /** The real OpenRouter model fetcher — index.ts passes its own
   *  fetchOpenRouterModels (the disk cache in catalog-cache.ts wraps
   *  whichever fetcher it is given; this file has no HTTP client of its
   *  own, by design — see the design §2.2 "the real fetchers are injected"
   *  note this satisfies).
   *
   *  P6b-fix N2: the input used to carry `effectiveProfile`, which nothing
   *  ever read. It is DROPPED rather than wired up, because design §2.1 is
   *  explicit that BOTH dynamic profiles are maintained on every dispatch
   *  regardless of which one the command uses — so there is no work the
   *  effective name could let this function skip, and a required-but-unread
   *  field only invites a caller to believe otherwise. */
  fetchCatalog: () => Promise<RawCatalogModel[]>;
  nowMs?: number;
  log?: (msg: string) => void;
  settingsPath?: string;
  /** SG2 + D2: the ONE dynamic profile whose background-update lock the
   *  CALLER already holds -- the detector child in "update requested" mode
   *  (profile-detector.ts), spawned under that lock by index.ts's
   *  requestProfileUpdate. When set, ONLY this profile is maintained (the
   *  other one's lock is not held, so writing it here would race its own
   *  background work -- SG2 review SF-4), and its populate spawn is handed
   *  this same lock (alreadyHeldByCaller) instead of refusing itself.
   *  Omitted (every test caller) means no lock is held: both profiles are
   *  maintained and each claims its own lock fresh. */
  heldLockProfile?: DynamicProfileName;
  /** D2 item 2: the command found no working model in `heldLockProfile`
   *  (every model failed, or the pool is empty) and asked for this update.
   *  Re-benchmark it now (USER point 4: "it will attempt to update again and
   *  benchmark the new models"): the "nothing new to benchmark" skip, the
   *  failure backoff and the 6 h sweep floor are bypassed, because the
   *  requester already applied D2's own respawn throttle
   *  (requestProfileUpdate, default-profiles-runner.ts). allow_paid_models
   *  and the daily spend cap still gate the spawn (populateDefaultProfile). */
  forceSweep?: boolean;
}

/** One profile's maintenance pass: decide, patch (write), queue candidates,
 *  spawn the background benchmark when there is something new to validate.
 *  Isolated per-profile try/catch in the caller — a 'paid' failure must never
 *  stop 'free' from being maintained this same run. */
/** design §2.4: the per-profile minimum interval between benchmark SWEEPS.
 *  Distinct from the failure backoff — this one bounds SUCCESSFUL sweeps too,
 *  which is what stops a trickle of new candidates from respawning a child
 *  (billably, on `paid`) shortly after the previous one completed. */
export const MIN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Row 19 (OE27RD7I): floor under a respawn after a spawn ATTEMPT, measured on
 *  the profile log's mtime (stamped by bench-spawn.ts at every attempt). */
const SPAWN_ATTEMPT_FLOOR_MS = 15 * 60_000;
async function maintainOneDynamicProfile(args: {
  name: DynamicProfileName;
  settings: Settings;
  settingsPath: string;
  catalog: readonly DynamicCatalogEntry[];
  catalogFreeQualified: readonly string[];
  /** D3c-1b (TRDD-FDI9NYAS): threaded straight into decideDynamicProfile's
   *  own required `benchmarkPassed` param -- see that function's docstring. */
  benchmarkPassed: ReadonlySet<string>;
  /** fix-queue 53: catalogFreeQualified is read from the CACHED OpenRouter
   *  catalog (its listing endpoint needs no auth), so it stays populated even
   *  when $OPENROUTER_API_KEY was never exported — with a stale cache this
   *  used to hand decideDynamicProfile a MIXED provisional pool containing
   *  OpenRouter ids nothing could serve. Computed once per pass via
   *  credentialUsable (see below), the one definition already used for the
   *  write-skip further down this file. D5 (TRDD-90DM5YHO): the b.ai half of
   *  this input (`baiCredentialUsable`) is deleted with the b.ai prepend
   *  plumbing. */
  openRouterCredentialUsable: boolean;
  unusable: ReadonlySet<string>;
  suspects: ReadonlySet<string>;
  staleFailedIds: ReadonlySet<string>;
  priceCeiling: number;
  /** P6b-fix2 S-5: false when the catalog fetch FAILED or came back empty.
   *  A fingerprint computed from an empty catalog must never be BANKED — the
   *  next online dispatch would see "changed" and re-queue the whole paid
   *  class (billably), and the same run would wipe addendum I's per-model
   *  baseline, short-circuiting the spec-change check on the run after that. */
  catalogUsable: boolean;
  nowMs: number;
  log: (msg: string) => void;
  /** fix-queue 56: set on the ONE recursive retry after backing up and
   *  regenerating an already-invalid section, so a pool that is STILL
   *  rejected right after regeneration (e.g. validateProfile itself is the
   *  broken part) logs and stops instead of recursing forever. Every real
   *  caller (maintainDynamicProfiles) omits it — `undefined` means "first
   *  attempt". */
  alreadyRegenerated?: boolean;
  /** SG2: true iff the CALLER of maintainDynamicProfiles already holds
   *  `name`'s ONE background-update lock (its `heldLockProfile`, D2) --
   *  passed straight through to populateDefaultProfile below so it can hand
   *  that SAME lock to the spawned child instead of refusing itself. */
  alreadyHeldByCaller?: boolean;
  /** D2: see MaintainDynamicProfilesInput.forceSweep. */
  forceSweep?: boolean;
}): Promise<boolean> {
  const { name, settings, settingsPath, nowMs, log, alreadyHeldByCaller = false, forceSweep = false } = args;
  const existing: Profile | undefined = settings.profiles[name];
  // The auto-created stub (P6a's overrideActiveProfile) is a REAL Profile
  // object, never `undefined` — but decideDynamicProfile's addendum-J
  // provisional-serve path only fires on `current === undefined`. Detect the
  // stub the same way the legacy machinery already does (isPlaceholderProfile)
  // so a freshly-created, still-empty section is correctly treated as
  // "unpopulated" for the DECISION, while the WRITE still merges onto the
  // real stub object (which already carries the right mode/api/free_only
  // shape) rather than reconstructing one here.
  // P6b-fix3 S-6': a MALFORMED list field means "this profile is broken", not
  // "this profile is empty" — so the maintainer touches nothing and lets the gate
  // do the talking (it already refuses by field name). isPlaceholderProfile
  // deliberately returns FALSE for a malformed `free_models` (config.ts says why:
  // reclassifying a typo as "not benchmarked yet" would swallow the error and
  // overwrite the user's line with benchmark output), so `current` is the broken
  // profile, `defaultProfileModelIds` now reads no ids from it, and WITHOUT this
  // guard the decision would refill the pool from the catalog and write — over a
  // section that already carries the generated marker, so with no backup.
  const malformed = malformedListField(existing);
  if (malformed !== null) {
    log(
      `[llm-externalizer] dynamic profile '${name}': '${malformed}' in settings.yaml is not a list — ` +
        `maintenance skipped, nothing written. Fix it, or delete the section and let llm-ext regenerate it.\n`,
    );
    return false;
  }
  const current = existing && !isPlaceholderProfile(existing) ? existing : undefined;
  // fix-queue 56 (gap 3 of the fix4 self-review): a MARKED, populated section
  // that already fails `validateProfile` — for a reason THIS pass's patch had
  // no part in, e.g. a validator rule tightened after llm-ext wrote it — must
  // not latch behind the "the patch we computed doesn't validate" skip
  // further down. That skip only knows about the CANDIDATE (base + patch); it
  // cannot tell "the patch broke it" from "it was already broken", so a
  // pre-existing defect was silently treated as patch-caused and never
  // touched again. Checking `current` here, before decideDynamicProfile even
  // runs, is what makes the distinction: already-invalid is handled here
  // (backup + regenerate, addendum K's shape reused for a MARKED section);
  // patch-introduced is unaffected and still hits the skip below.
  if (current !== undefined && !args.alreadyRegenerated) {
    const repair = regenerateInvalidMarkedSection({ name, settingsPath, current, nowMs });
    if (repair.kind === "user-keys-invalid") {
      log(
        `[llm-externalizer] dynamic profile '${name}': ${repair.errors.join("; ")} — maintenance skipped, nothing written. Fix it and llm-ext resumes maintaining the generated keys.\n`,
      );
      return false;
    }
    if (repair.kind === "concurrent-fix") {
      // No backup was taken; returning here — instead of recursing into a
      // provisional refill — is what stops this pass from clobbering the
      // fresher write a concurrent writer landed under the lock.
      log(
        `[llm-externalizer] dynamic profile '${name}': a concurrent write already fixed it under the lock — nothing done this pass.\n`,
      );
      return false;
    }
    if (repair.kind === "regenerated") {
      log(
        `[llm-externalizer] dynamic profile '${name}': the current section was already invalid ` +
          `(${repair.errors.join("; ")}) — backed it up to ${repair.backupPath} and regenerated it; continuing.\n`,
      );
      // Retry ONCE against the now-regenerated (valid, unpopulated) section so
      // this pass still makes progress instead of merely leaving a notice —
      // the recursive call re-derives `existing`/`current` from the updated
      // `settings` and provisionally repopulates the pool like any other
      // fresh-install dispatch (addendum J).
      return maintainOneDynamicProfile({
        ...args,
        settings: { ...settings, profiles: { ...settings.profiles, [name]: repair.regenerated } },
        alreadyRegenerated: true,
      });
    }
  }
  // 3e (C2b-wire): pass THIS pass's own settings' free-profile routes instead
  // of letting readCandidates() re-derive them with its own loadSettings()
  // disk read (dynamic-candidates.ts's readCandidates docstring) — one source
  // of settings for the whole pass. Never `null`: passing null tells
  // pruneUnroutedFreeCandidates "no route information available, keep
  // everything unpruned" — but this IS the maintainer's own authoritative
  // pass over `settings` it just loaded, so "no `free` profile yet" is a
  // real, known fact, not an unknown; an empty Map lets the maintainer's own
  // pass prune stray unrouted candidates the moment it can (never a
  // FALSE POSITIVE drop of a routed id, since one can't exist before the
  // `free` profile itself does).
  const freeProfileForRouting = settings.profiles.free;
  const routesFor = freeProfileForRouting
    ? resolveGroups(freeProfileForRouting).routesFor
    : (): ResolvedRoute[] => [];
  const queuedEntries = readCandidates(routesFor)[name];
  const queued = new Set(queuedEntries.map((e) => e.id));
  const record = getDynamicProfileRecord(name);

  const decision = decideDynamicProfile({
    name,
    current,
    catalog: args.catalog,
    catalogFreeQualified: args.catalogFreeQualified,
    benchmarkPassed: args.benchmarkPassed,
    unusable: args.unusable,
    queued,
    priceCeiling: args.priceCeiling,
    record,
    staleFailedIds: args.staleFailedIds,
    suspects: args.suspects,
    openRouterCredentialUsable: args.openRouterCredentialUsable,
  });

  let wroteSettings = false;
  if (decision.patch) {
    // P6b-fix N1: this used to read `existing ?? current`. The right-hand arm
    // was unreachable — `current` is DERIVED from `existing` twenty lines up,
    // so it can only be set when `existing` is — and it read as if it handled
    // a case that cannot occur.
    const base = existing;
    // P6b-fix3 R-2: never attempt a write whose section NO credential can
    // serve. With `$OPENROUTER_API_KEY` unset, the provisional pool this pass
    // would write is a list of ids nothing can send — and writing it made the
    // profile stop looking unpopulated, which switched OFF
    // shouldBootDespiteInvalidActiveProfile's missing-key exemption, so
    // index.ts's reload-after-write rejected the WHOLE document with
    // `⚠ settings.yaml change rejected: Remote api 'openrouter-remote' requires
    // 'api_key'` — a warning about llm-ext's own write, and the dispatch then
    // ran against the pre-write stub anyway. A `providers[]` route with its own
    // working credential is checked too: the b.ai slot carries `$BAI_API_KEY`, so
    // a run with only that key set still writes, and only that slot.
    const missingKeyVar = base === undefined ? null : missingProviderKeyVar(base);
    // The section AS IT WOULD BE WRITTEN, which is what both checks below are
    // actually about.
    const candidate = base === undefined ? undefined : applyPatch(base, decision.patch);
    // P6b-fix4 B1: the routes of the CANDIDATE, not of the patch alone. Read from
    // the patch, this froze maintenance on the very machine B1 is about: once the
    // b.ai-only provisional write has landed, the section carries the route and
    // the NEXT pass's patch (dropping a dead id, replacing a tool head) carries no
    // `providers` at all — so "no route can serve this" was true of the patch and
    // false of the profile, and `free` was written once and never maintained
    // again. `credentialUsable`'s own `routesFrom` param (coordinator review S-2,
    // follow-up 89bc887+) is exactly this: reads `candidate`'s routes, never
    // `base`'s — the shared function this used to be a private, duplicated
    // `coerceProviderBindings(...).some(...)` copy of.
    // P6b-fix4 B1(2), the INVARIANT: the maintainer never writes a section that
    // `validateProfile` rejects. B1(1) taught the Remote-auth rule about
    // `providers[]` routes, which removes the known way this happened — but the
    // consequence of getting it wrong is severe and silent (the reload rejects
    // the WHOLE document, and the next boot serves NOT CONFIGURED for every
    // tool), and the decision function has no idea what the validator will
    // accept. So the candidate is checked against the real validator before the
    // writer is called, and a rejected candidate is not written at all: the
    // section stays as it is, which keeps the unpopulated-placeholder boot
    // exemption available instead of trading it for a pool nothing can serve.
    // Belt-and-braces over B1(1), never a substitute for it.
    //
    // ORDER: the credential arm FIRST. Both arms fire on the same b.ai-less
    // machine — with no credential the candidate is also invalid, because the
    // Remote-auth rule is one of the rules B1(1) just taught about routes — and
    // "export $VAR and re-run" is the actionable half of that same fact, so the
    // user hears the variable, not a validator sentence quoting it.
    //
    // fix-queue 56: `base` was already checked valid above (or this is the
    // post-regeneration retry, where `base` is the fresh unpopulated
    // placeholder), so a rejection here can only be the PATCH's doing —
    // exactly the case this skip-with-one-line branch is for.
    const candidateValidation =
      candidate === undefined ? null : validateProfile(name, candidate);
    // fix-queue 73 (review of 7137cfc, Q1): `missingKeyVar !== null` dropped —
    // credentialUsable's first early return already implies it, but only while that ordering holds.
    if (base && !credentialUsable(base, candidate)) {
      log(
        `[llm-externalizer] dynamic profile '${name}': not populated — ` +
          `${missingKeyVar === null ? "the base api_key" : "$" + missingKeyVar} is not set, ` +
          `so no model written here could be served. Export it and re-run.\n`,
      );
    } else if (base && candidateValidation !== null && !candidateValidation.valid) {
      log(
        `[llm-externalizer] dynamic profile '${name}': the update llm-ext computed would not ` +
          `validate, so nothing was written — ${candidateValidation.errors.join("; ")}\n`,
      );
    } else if (base) {
      const decidedAgainst = stableStringify(base);
      const patch = decision.patch;
      const result = writeDynamicProfileSection(
        settingsPath,
        name,
        // P6b-fix2 S-9 (addendum C): this decision was taken against the
        // section as it looked when this pass called loadSettings(), and the
        // writer's lock is acquired long AFTER that — `decideDynamicProfile`
        // plus the wait itself sit in between. If a benchmark child populated
        // the section in that window, applying a stale decision would replace a
        // freshly-benchmarked profile with this pass's old base plus a
        // provisional pool. Returning the current section UNCHANGED makes the
        // writer's own compare see no difference, so it writes nothing, and the
        // next dispatch re-decides against what the child wrote.
        (currentSection) => {
          if (currentSection === undefined) return applyPatch(base, patch);
          if (stableStringify(currentSection) !== decidedAgainst) return currentSection;
          return applyPatch(currentSection, patch);
        },
        { nowMs, notify: log },
      );
      // P6b-fix4 Q2: this reports WHETHER THIS PASS WROTE, and nothing else. The
      // fix3 shape also OR-ed in a `sectionDifferedUnderLock` flag set inside the
      // patch closure — which only runs when there was a patch AND the writer got
      // as far as calling it, so "the document changed under us" was reported for
      // one path and silently missed on four (the credential skip, the up-to-date
      // decision, the no-section arm, a throw out of the writer). "Did the
      // document change" is a question about the DOCUMENT, so the dispatch site
      // now answers it by hashing settings.yaml around this call (index.ts) and
      // this return went back to meaning the one thing only the maintainer knows.
      wroteSettings = result.changed;
    } else {
      // No section exists at all (user deleted it, or a test skipped the
      // P6a auto-create step) — nothing this module can safely merge onto
      // without duplicating index.ts's placeholder-stub shape. Fail open:
      // skip the write, let the NEXT dispatch (after overrideActiveProfile
      // re-creates the stub) pick it up. Never throws, never silently lies
      // about having written something.
      log(`[llm-externalizer] dynamic profile '${name}': no settings.yaml section to patch — skipped this run.\n`);
    }
  }

  // P6b-fix B3 — the MAINTAINER owns dynamic-profiles-state.json. Written
  // here, unconditionally and right after the $0 patch, because
  // the dynamic record had NO production writer at all: it was
  // always undefined, so `fingerprintChanged` was always true (every dispatch
  // on a populated `paid` re-queued the whole paid class and respawned a
  // billable child), addendum I's spec-change requeue could never fire, and
  // `settings status` always said "not yet maintained". The fingerprint comes
  // from the DECISION, so there is exactly one producer.
  //
  // lastBenchmarkAt is carried forward, never invented here: the benchmark
  // CHILD owns that clock (benchmark/index.ts writes it on a completed run).
  // write is NOT nested inside writeDynamicProfileSection's settings.write.lock
  // (see the P6b-fix report): that lock is module-private to pick.ts and is a
  // non-reentrant mkdir spin-lock, so nesting would deadlock against us, and it
  // guards settings.yaml — a different resource from this sidecar, which has
  // its own lock (P6b-fix2 S-4, dynamic-profiles-state.lock).
  //
  // C2b review follow-up: `decision.modelSpecFingerprints` (below) is built
  // from THIS pass's `current`/`configured` — read at the TOP of this
  // function, before the patch above lands — so a profile going from
  // unpopulated to populated in ONE pass banks an EMPTY baseline even though
  // `free_models`/`paid_models` are non-empty by the time this write happens.
  // Only the NEXT pass (a real dispatch, or profile-detector.ts's detector)
  // sees the now-populated `current` and banks the real per-model baseline —
  // i.e. a freshly-populated profile's sidecar fingerprint lags its own
  // settings.yaml write by exactly one pass. Not a bug (the decision that
  // produced THIS write cannot know what it is about to write), but a real
  // reader trap: profile-detector.test.ts's maintainer-vs-detector
  // equivalence test needed two maintainDynamicProfiles calls to reach the
  // steady state a single real dispatch would only reach on its SECOND run.
  const buildRecord = (prev: DynamicProfileRecord | undefined): DynamicProfileRecord => ({
    // P6b-fix2 S-4: every carried-forward field reads `prev` — the record as it
    // is on disk INSIDE the lock — not the `record` this pass read before
    // deciding and writing. A child that completed in that window used to have
    // its lastBenchmarkAt erased by this write.
    lastBenchmarkAt: prev?.lastBenchmarkAt ?? 0,
    // P6b-fix2 S-5: an unusable catalog contributes no fingerprint at all.
    poolFingerprint: args.catalogUsable ? decision.poolFingerprint : (prev?.poolFingerprint ?? ""),
    modelIds: prev?.modelIds ?? [],
    failCount: prev?.failCount ?? 0,
    modelSpecFingerprints: args.catalogUsable
      ? decision.modelSpecFingerprints
      : prev?.modelSpecFingerprints,
    lastMaintainedAt: nowMs,
  });
  updateDynamicProfileRecord(name, (prev) => {
    const next = buildRecord(prev);
    // P6b-fix2 N-5: in the steady state nothing here moves, and this file was
    // still rewritten on EVERY dispatch, twice (once per profile). Skip the
    // write when only `lastMaintainedAt` would change — but refresh it at least
    // once per sweep interval, so `settings status`'s "maintained as of" is
    // never more than that stale and still proves the maintainer is running.
    const unchanged =
      prev !== undefined &&
      prev.lastBenchmarkAt === next.lastBenchmarkAt &&
      prev.poolFingerprint === next.poolFingerprint &&
      prev.failCount === next.failCount &&
      JSON.stringify(prev.modelIds) === JSON.stringify(next.modelIds) &&
      JSON.stringify(prev.modelSpecFingerprints ?? {}) === JSON.stringify(next.modelSpecFingerprints ?? {});
    // D2: a REQUESTED update always stamps lastMaintainedAt -- it is the
    // "an update finished" clock requestProfileUpdate's respawn throttle
    // reads, and skipping the write here would let every failing command
    // start another update.
    if (unchanged && !forceSweep && nowMs - (prev.lastMaintainedAt ?? 0) < MIN_SWEEP_INTERVAL_MS) return null;
    return next;
  });

  if (decision.candidates.length === 0 && !forceSweep) return wroteSettings;

  // P6b-fix B1: `paid` candidates are only queued (and only spawned) once the
  // user has actually authorized paid spend. Without this the maintainer would
  // enqueue the whole paid class and take a refusal from populateDefaultProfile
  // on EVERY dispatch — including dispatches of an unrelated `--profile free`
  // command — and S1's new stderr line would repeat that refusal every time.
  // The user already said no once; the gate says it again the moment they
  // actually ask for `--profile paid`.
  const allowPaidModels = settings.allow_paid_models === true;
  if (name === "paid" && !allowPaidModels) return wroteSettings;

  // ORDERING (3c, review of 51a100c): the `providers[]` patch above must be ON
  // DISK before this enqueue. dynamic-candidates.ts's pruneUnroutedFreeCandidates
  // drops a b.ai-routed candidate that has no matching `providers[]` route YET —
  // enqueue it before the patch lands and the very next read (even this same
  // pass's own candidate reader, or a concurrent dispatch) sees an "unrouted"
  // id and drops it, so the sweep never sees it and it silently re-arrives next
  // run. The write above already happens first in this function's source
  // order — this comment names the invariant so a future refactor that
  // reorders these two calls does not reintroduce the drop. Getting it wrong
  // costs one wasted read cycle (dropped, then re-enqueued next run), never
  // correctness — so no reader-side duplicate check is added for it.
  if (decision.candidates.length > 0) enqueueCandidates(name, decision.candidates, nowMs);

  // P6b-fix S6 — the two throttles design §2.4 specifies, neither of which the
  // spawn path consulted. Candidates stay QUEUED either way (the queue is what
  // the child reads when it finally runs); only the spawn waits.
  //   cooldownUntil — recordBenchmarkFailure's exponential backoff, written by
  //     the benchmark child into the legacy keyspace under this same name. An
  //     unpopulated profile whose benchmark keeps failing (no key, provider
  //     down) otherwise respawned a detached child on EVERY dispatch, the exact
  //     defect that backoff exists to prevent.
  //   MIN_SWEEP_INTERVAL_MS — the 6h floor between sweeps. The bench lock stops
  //     a concurrent DOUBLE spawn; it does nothing about a fresh spawn right
  //     after a completed one when candidates keep trickling in.
  // Deliberately silent: both are normal throttling, not a swallowed error, and
  // a line here would print on every dispatch for hours.
  // D2: a requested update (forceSweep) skips both -- its requester already
  // applied PROFILE_UPDATE_RESPAWN_MS and the same cooldownUntil
  // (requestProfileUpdate); the 6 h floor would otherwise refuse the
  // re-benchmark the USER asked for when every model fails.
  if (!forceSweep) {
    const cooldownUntil = getProfileRecord(name)?.cooldownUntil ?? 0;
    if (nowMs < cooldownUntil) return wroteSettings;
    // CE9B7S8N — the 6 h floor keys on sweep COMPLETION, never on spawn time.
    // The old lastSweepAt stamp fired at SPAWN, so a child killed before it
    // booked a result froze the next sweep for the full window. The spawn is
    // detached and unref'd (nothing awaits it, and SIGKILL has no exit hook),
    // so completion is read from the evidence on disk:
    //   - dynamic record lastBenchmarkAt — the child stamps it ONLY on a
    //     completed success (recordDynamicBenchmarkAt);
    //   - legacy record cooldownUntil — already checked above; the child
    //     stamps it on every BOOKED failure (recordBenchmarkFailure).
    // A child that died unbooked leaves neither, so the next pass respawns;
    // the bench lock (handed to the child via LLM_EXT_BENCH_LOCK_PATH) is
    // what stops a true concurrent double-spawn while a child IS alive.
    // Deliberately no spawn-time stamp any more: the live-lock check covers
    // the only race the stamp used to paper over.
    // JDFJLPSS: lock first, then a fresh record read — a sweep that finished after the early snapshot must floor this spawn.
    if (benchLockIsHeld(backgroundUpdateLockPathFor(name), nowMs)) return wroteSettings;
    // Row 19 (OE27RD7I): lastBenchmarkAt (below) floors only COMPLETED sweeps
    // (CE9B7S8N); a child that died unbooked left nothing, so every command
    // respawned it. The profile log mtime, stamped at each spawn attempt
    // (bench-spawn.ts), is the attempt record -- no new state file. A
    // detector-triggered update runs with forceSweep (profile-detector.ts),
    // like requestProfileUpdate, so it skips this floor too: a detected change
    // or a user request must not wait out the floor. Any stat error means no floor: background maintenance
    // never blocks or fails the user command, and the spawn's own openSync
    // reports a real I/O problem through its ok:false channel. A mtime far in
    // the future (clock moved back, copied file) would floor for hours, so it
    // is ignored.
    let logMtimeMs: number | null = null;
    try {
      logMtimeMs = statSync(defaultProfileLogPath(name)).mtimeMs;
    } catch {
      /* ENOENT or any other stat error: no floor */
    }
    if (logMtimeMs !== null && logMtimeMs - nowMs <= 60_000 && nowMs - logMtimeMs < SPAWN_ATTEMPT_FLOOR_MS) {
      return wroteSettings;
    }
    const lastSweepFinishedAt = getDynamicProfileRecord(name)?.lastBenchmarkAt ?? 0;
    if (lastSweepFinishedAt > 0 && nowMs - lastSweepFinishedAt < MIN_SWEEP_INTERVAL_MS) {
      return wroteSettings;
    }
  }

  const outcome = populateDefaultProfile({ profile: name, allowPaidModels, log, alreadyHeldByCaller });

  // P6b-fix S1: the outcome used to be DISCARDED, so "the daily paid-benchmark
  // spend cap has been reached", "allow_paid_models is false" and "config dir
  // unusable" all vanished with no output whatsoever. describeOutcome exists
  // for exactly this; it is deliberately silent for a `skipped` outcome (the
  // legacy path's contract: only speak when the USER must act), so the
  // maintainer adds that one case itself rather than changing a shared
  // function's contract for every one of its callers.
  if (outcome.kind === "spawned") {
    // P6b-fix2 S-7: the maintainer's own NEUTRAL line. describeOutcome's
    // spawned text ("… is being benchmarked now. Re-run this command when it
    // finishes") is addressed to a caller who asked for THAT profile — but
    // design §2.1 maintains BOTH profiles on every dispatch, so this fires on a
    // `--profile free` command that has already succeeded and has nothing to
    // re-run. Only the GATE knows which profile the user actually asked for, so
    // only the gate gives re-run advice.
    log(`llm-ext: background benchmark for '${name}' started (~15 min); progress: ${outcome.logPath}\n`);
  } else {
    const msg = describeOutcome(outcome);
    if (msg) log(msg);
    else if (outcome.kind === "skipped") {
      log(`[llm-externalizer] dynamic profile '${name}': population not started — ${outcome.reason}.\n`);
    }
  }

  return wroteSettings;
}

/**
 * Maintain BOTH `free` and `paid` (design §2.1). Never throws. Skipped
 * entirely when LLM_EXT_DISABLE_AUTO_RECONCILE=1 (addendum F: the single
 * documented opt-out for all dynamic maintenance, free or paid).
 *
 * C2b-wire (TRDD-OE27RD7I) landed: index.ts's dispatchCallToolInner no
 * longer calls this in-process before every dispatch — that call made every
 * tool invocation on a dynamic profile pay for a full catalog fetch + patch,
 * which is what card C's 100ms `settings status` latency acceptance forbids.
 * The periodic maintenance now goes through a DIFFERENT path entirely: the
 * dispatch site fires a detached DETECTOR (default-profiles-runner.ts's
 * spawnDetachedDetector -> profile-detector.ts's cheap fingerprint-only
 * detectProfileChanges), which on a real change spawns populateDefaultProfile
 * — this file's own exported fingerprint helpers (toDynamicCatalogEntry,
 * defaultFetchBaiModels) are reused there, but this function itself is not
 * called from that chain at all.
 *
 * D2 (USER 2026-09-18, "the profile updating must happens in background"):
 * no command calls this in-process any more. Its one production caller is
 * the detector child in "update requested" mode (profile-detector.ts's
 * detectProfileChanges), which a command spawns through
 * requestProfileUpdate when its profile has no working model; that child
 * runs it with `heldLockProfile` + `forceSweep`. Tests call it directly.
 */
export async function maintainDynamicProfiles(input: MaintainDynamicProfilesInput): Promise<boolean> {
  // P6b-fix4 Q2: returns `wroteSettings` — "THIS pass wrote settings.yaml".
  // NOT "the document changed": a change another process made is not something
  // this function can see on every path it can return from, and pretending
  // otherwise is what made the reload signal present on one path and absent on
  // four. The dispatch site hashes the file around this call for that question.
  const log = input.log ?? ((m: string) => process.stderr.write(m));
  if (process.env[DISABLE_RECONCILE_ENV] === "1") return false;
  const nowMs = input.nowMs ?? Date.now();
  let wrote = false;
  try {
    const settings = loadSettings();
    if (!settings) return false; // nothing to maintain without a parseable settings.yaml
    const settingsPath = input.settingsPath ?? getSettingsPath();

    // P6b-fix S2: catalog-cache.ts fails OPEN on a fetch failure — correct, but
    // it used to also fail SILENT, so an unreachable OpenRouter produced an
    // empty pool and a gate message blaming a background benchmark that was
    // never the cause. One line, through the injected log (stderr by default).
    // P6b-fix2 S-5: remember that the fetch FAILED, not only that it was
    // reported. A failed fetch fails OPEN (an empty list), and an empty list
    // produces a perfectly well-formed fingerprint of nothing — which must not
    // be banked over a good one.
    let catalogFetchFailed = false;
    const rawCatalog = await getCatalog<RawCatalogModel>(input.fetchCatalog, nowMs, {
      path: catalogCachePath(),
      onError: (err) => {
        catalogFetchFailed = true;
        log(
          `[llm-externalizer] OpenRouter catalog fetch failed: ${
            err instanceof Error ? err.message : String(err)
          } — continuing on the last cached catalog (possibly empty).\n`,
        );
      },
    });
    // An empty catalog is indistinguishable from "the provider listed nothing",
    // and both are equally unsafe to fingerprint — plus the negative cache
    // suppresses the RE-fetch for a minute, so a second dispatch inside that
    // window sees an empty list with no onError of its own.
    const catalogUsable =
      !catalogFetchFailed && rawCatalog.length > 0 && !catalogFetchRecentlyFailedSafe(nowMs);
    const catalog = rawCatalog.map(toDynamicCatalogEntry);
    const catalogById = new Map(rawCatalog.map((m) => [m.id, m]));
    const freeIds = rawCatalog.map((m) => m.id).filter(isFreeSuffixModelId);
    const catalogFreeQualified = filterFreeModels(freeIds, catalogById, benchmarkFailedModels());
    // D3c-1b (TRDD-FDI9NYAS): the STRICT serving gate -- computed once per
    // pass, same shape as `catalogFreeQualified`/`unusable` above, and
    // threaded through decideDynamicProfile so an unpopulated free profile's
    // first write can no longer serve a never-benchmarked catalog id.
    const benchmarkPassed = benchmarkPassedModels();

    // Split persistence verdicts into "unusable" (dropped now) vs "suspect"
    // (403 only — re-queued for verification, never evicted on a single
    // class of evidence; design §5, addendum row "403-suspect").
    const events = readModelEvents();
    const verdicts = assessModelPersistence(events, { now: new Date(nowMs) });
    const suspects = new Set<string>();
    const brokenNon403 = new Set<string>();
    for (const [id, v] of verdicts) {
      if (!v.persistentlyBroken) continue;
      if (v.httpStatus === 403) suspects.add(id);
      else brokenNon403.add(id);
    }
    const unusable = new Set<string>([...benchmarkFailedModels(), ...brokenNon403]);
    const staleFailedIds = staleFailedModelIds(REPROBE_AFTER_MS, nowMs);
    const paidCeiling = getEnsemblePriceCeiling(settings);

    for (const name of DYNAMIC_PROFILE_NAMES) {
      // TRDD-C9SXX7HO (D2): `local` is NEVER maintained through this
      // catalog-based pass — maintainOneDynamicProfile/decideDynamicProfile
      // rank and PRICE-PRUNE a class pool derived from the OpenRouter
      // catalog fetched a few lines up, and `local` has no catalog entry, no
      // price, nothing to rank by; running it through here would prune every
      // detected local model as "not in the catalog" (exactly what the card
      // forbids). `local`'s own detector/updater pair (profile-detector.ts's
      // DETECTORS table + benchmark/index.ts's runPopulateLocalDefaultProfile)
      // is the complete, separate engine for it. Checked BEFORE the
      // credential call below (fix-queue 53 NIT, row 53 review) — `local`
      // has no credential question to answer, so it never asks one.
      if (name === "local") continue;
      // D2: a caller holding one profile's lock maintains that profile only.
      if (input.heldLockProfile !== undefined && name !== input.heldLockProfile) continue;
      // fix-queue 53 (row 53 review): whether the provider's credential
      // actually resolves RIGHT NOW, shared with the write-skip below and
      // with profile-detector.ts's own detector, so the two never silently
      // disagree on this fact again.
      const { openRouterCredentialUsable } = dynamicCredentialUsability(name, settings);
      try {
        const changed = await maintainOneDynamicProfile({
          name,
          settings,
          settingsPath,
          catalog,
          catalogFreeQualified,
          benchmarkPassed,
          openRouterCredentialUsable,
          unusable,
          suspects,
          staleFailedIds,
          priceCeiling: name === "paid" ? paidCeiling : 0,
          catalogUsable,
          nowMs,
          log,
          alreadyHeldByCaller: name === input.heldLockProfile,
          forceSweep: input.forceSweep === true && name === input.heldLockProfile,
        });
        wrote = wrote || changed;
      } catch (err) {
        log(
          `[llm-externalizer] dynamic profile maintenance for '${name}' failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  } catch (err) {
    log(
      `[llm-externalizer] dynamic profile maintenance failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
  // P6b-fix S3: reports whether settings.yaml actually CHANGED, so the caller
  // can re-read its in-memory settings before the gate and the tool run
  // (design §2.6's "the running process re-reads its in-memory settings after
  // a write"). Without this the command that computed the $0 patch still ran
  // against the models it resolved at boot — including one just dropped as
  // dead — and the gate disagreed with it.
  // P6b-fix4 Q2: §2.6's "after a write" means after ANY change to the document,
  // including one another process made — but that is the DISPATCH SITE's check
  // (it hashes settings.yaml around this call), not this return, which reports
  // only what this pass itself did.
  return wrote;
}

// ── §3.3 — the honest limit ──────────────────────────────────────────────

export interface DynamicGateResult {
  isError: true;
  message: string;
  // P14.1 (TRDD-OE27RD7I addendum 2), D2: a caller-visible discriminant for
  // "the pool is empty AND an update could plausibly fill it" -- the ONLY
  // empty-pool refusal for which the dispatch pre-flight starts the
  // background update and answers "retry later" (USER 2026-09-18: "Refuse,
  // retry later"; no command waits for it). Every other refusal (malformed profile,
  // forbidden tool, no credentials, maintenance disabled, catalog recently
  // failed, unpopulated paid/local) must leave this undefined, so the
  // caller branches on structure, never on message text.
  reason?: "empty-pool-refreshable";
}

/**
 * Decide whether `effective` can serve `toolName` right now (design §3.3).
 * Returns null to proceed. Reads settings.yaml FRESH (never the caller's
 * possibly-stale snapshot) because it always runs immediately after
 * maintainDynamicProfiles, which may just have written it.
 *
 * Deviates from the design's `dynamicProfileGate(effective)` one-arg sketch
 * by also taking `toolName`: addendum H's refusal text is PER-TOOL
 * (`no free model is fit for <tool>`), so the tool name must reach this
 * function somehow — named here rather than silently folded into
 * `effective`.
 *
 * NOT implemented here (named gap, not silent — see the P6b report):
 * the "every chain entry unusable THIS RUN" and "every paid model 402"
 * rows of §3.3's table. Both require tracking live call attempts across a
 * single command's execution, which is §3.1/§3.2's job inside the actual
 * completion pipeline (provider/completion.ts, free-rotation.ts's
 * runUnusable), not a pre-dispatch static read. This gate covers the
 * STATIC honest-limit cases: the free-tool fitness refusal (addendum H),
 * an entirely empty free pool with no b.ai fallback, `paid` without
 * `allow_paid_models`, and `paid` unpopulated with the daily cap spent.
 */
/* P6b-fix4 B1: `chainModelIds` moved to config.ts (imported above) — the
 * Remote-auth rule needs the same list, and a second copy is how the gate and
 * the validator would drift apart on "what does this profile send". */
/**
 * The first list-shaped field on `profile` that is NOT a list, or null when
 * every one of them is well-formed (P6b-fix2 S-6). These are the only fields
 * the gate reads as lists; `chainModelIds` above already Array.isArray-guards
 * both, so this exists to NAME the broken one in the refusal rather than to
 * prevent the throw twice.
 */
function malformedListField(profile: Profile | undefined): string | null {
  if (!profile) return null;
  if (profile.free_models !== undefined && !Array.isArray(profile.free_models)) return "free_models";
  if (profile.paid_models !== undefined && !Array.isArray(profile.paid_models)) return "paid_models";
  return null;
}

/** catalogFetchRecentlyFailed reads a path derived from getConfigDir(), which
 *  THROWS for a config dir outside the allowlist. The gate is the last thing
 *  between the user and their command, so it may never throw for a diagnostic
 *  nicety: an unreadable cache simply means "no evidence of a fetch failure". */
function catalogFetchRecentlyFailedSafe(nowMs: number): boolean {
  try {
    return catalogFetchRecentlyFailed(nowMs);
  } catch {
    return false;
  }
}

/**
 * P6b-fix3 R-2: the env-var NAME the profile's remote provider needs and does
 * not have, or null when it resolves (or the provider is local).
 *
 * The maintainer must not attempt a provisional write whose `api_key` cannot
 * resolve: `validateSettings` rejects such a profile, so index.ts's
 * reload-after-write printed
 * `⚠ settings.yaml change rejected: Remote api 'openrouter-remote' requires
 * 'api_key' (env var $OPENROUTER_API_KEY is not set)` — a warning about
 * llm-ext's OWN write, phrased as if the user had broken their file, while the
 * one actionable fact (an unset variable) was buried in a parenthetical. The
 * write also cannot help: nothing in that section can serve a request without
 * the key.
 */
function missingProviderKeyVar(profile: Profile | undefined): string | null {
  if (!profile) return null;
  const preset = profile.api === undefined ? undefined : API_PRESETS[profile.api];
  if (preset === undefined || preset.isLocal) return null;
  const rawAuth = profile.api_key || preset.defaultAuthEnv;
  if (resolveEnvValue(rawAuth) !== "") return null;
  // A literal (non-`$`) api_key that resolves to "" is an empty string in the
  // file, not a missing variable — name the preset's own variable then, which
  // is the one the user is expected to export.
  const ref = rawAuth?.startsWith("$") ? rawAuth : preset.defaultAuthEnv;
  return ref?.startsWith("$") ? ref.slice(1).trim() : null;
}

/**
 * True iff SOME credential can serve `profile` — either its own base
 * api_key/preset resolves, or any of `routesFrom`'s `providers[]` route
 * bindings has a resolvable credential of its own.
 *
 * Coordinator review S-2 (follow-up, 89bc887+): the route `.some(...)` half
 * of this check used to be duplicated verbatim at two call sites — the
 * fix-queue 56 already-invalid branch above, and the pre-existing
 * missing-key skip below — computed against a DIFFERENT profile at each
 * (the section's own `current` vs. the patched `candidate`). Factored into
 * ONE function, `routesFrom` kept as its own parameter rather than folded
 * into `profile`, so the two call sites keep reading routes from whichever
 * profile is correct for THEM: the skip branch below reads from the
 * CANDIDATE (base + patch), never the base alone — the exact distinction
 * fix4's B1(1) fix depends on (see its own comment at that call site). One
 * function body now backs both "is there a usable credential" answers, so
 * they cannot drift apart.
 *
 * `routesFrom` has NO DEFAULT (coordinator review, one-token follow-up to
 * 9fe827d): JavaScript's default-parameter substitution fires on an
 * EXPLICITLY passed `undefined`, not only a genuinely omitted argument — so
 * `= profile` would have made `credentialUsable(base, candidate)` silently
 * fall back to reading `base`'s OWN routes the moment `candidate` is
 * `undefined`, reintroducing exactly the "read from the patch/base instead
 * of the candidate" bug fix4's B1(1) fixed. Every caller now NAMES the
 * routes source explicitly, so an `undefined` `routesFrom` stays `undefined`
 * (`coerceProviderBindings(undefined)` — no routes to check, not "check the
 * caller's other argument instead").
 */
function credentialUsable(profile: Profile | undefined, routesFrom: Profile | undefined): boolean {
  if (profile === undefined) return false;
  if (missingProviderKeyVar(profile) === null) return true;
  return coerceProviderBindings(routesFrom?.providers).some(
    (p) => (p.api ? resolveEnvValue(p.api_key ?? API_PRESETS[p.api]?.defaultAuthEnv) : resolveEnvValue(p.api_key)) !== "",
  );
}

/**
 * S3 (row 53 review): the ONE place `openRouterCredentialUsable` is
 * computed for a given dynamic profile `name`, shared by this module's own
 * maintainOneDynamicProfile call site and by profile-detector.ts's
 * detectRemoteProfileChange. Two independent copies of this logic is exactly
 * how they drifted before: profile-detector.ts never computed the flag at all
 * and decideDynamicProfile's own (now-removed) `= true` default silently
 * covered for it, so the detector fingerprinted a pool no credential could
 * actually serve as if it were real, and disagreed with the maintainer's
 * write-skip forever (fix-queue 53 follow-up S3). D5 (TRDD-90DM5YHO): the
 * b.ai half (`baiCredentialUsable`) is deleted with the b.ai prepend plumbing.
 */
export function dynamicCredentialUsability(
  name: DynamicProfileName,
  settings: Settings,
): { openRouterCredentialUsable: boolean } {
  return {
    openRouterCredentialUsable: credentialUsable(
      settings.profiles[name] ?? unpopulatedDefaultProfile(name),
      undefined,
    ),
  };
}

/** P6b-fix3 R-2: the variables that gate EVERY provider the generated
 *  `free` section can use — OpenRouter's catalog + completions, and (until D5,
 *  TRDD-90DM5YHO) b.ai's free-at-the-provider route. With none set, an empty
 *  free pool is not a benchmark that has not finished; it is a credential that
 *  was never supplied, and no benchmark can ever change that. D5 drops BAI_API_KEY
 *  from the gate list — the b.ai route is a USER group + reserved slot now,
 *  never a generated model the maintainer would write, so an empty pool with
 *  only a b.ai key is a genuinely empty pool. */
const FREE_PROVIDER_KEY_VARS = ["OPENROUTER_API_KEY"] as const;

/**
 * P6b-fix4 S3: ONE definition of "this profile has no credential", shared with
 * the maintainer's write-skip.
 *
 * It used to read the two env vars ONLY, while `missingProviderKeyVar` — the
 * predicate the write-skip uses — reads `profile.api_key` FIRST. So a user who
 * pasted a LITERAL key into settings.yaml and exported nothing was told to
 * "export $OPENROUTER_API_KEY and re-run": a cause that is not theirs, about a
 * credential they already supplied. Same class of misattribution R-2(b) exists
 * to remove, so it gets the same fix — ask the one predicate.
 */
function noFreeProviderCredentials(profile: Profile | undefined): boolean {
  if (profile !== undefined && missingProviderKeyVar(profile) === null) return false;
  return FREE_PROVIDER_KEY_VARS.every((name) => resolveEnvValue(`$${name}`) === "");
}

export function dynamicProfileGate(
  effective: string,
  toolName: string,
  opts: { settings?: Settings | null; nowMs?: number } = {},
): DynamicGateResult | null {
  if (!isDynamicProfileName(effective)) return null;
  const settings = opts.settings !== undefined ? opts.settings : loadSettings();
  const allowPaidModels = settings?.allow_paid_models === true;
  const nowMs = opts.nowMs ?? Date.now();
  const profile = settings?.profiles[effective];

  // P6b-fix2 S-6: fail CLOSED on a malformed profile, by name. A YAML SCALAR
  // where a list belongs is neither null nor undefined, so `?? []` does not
  // fire and `.filter` is not a function — the one function documented as "the
  // last thing between the user and their command, it may never throw" threw,
  // uncaught (dispatchCallToolInner has no try/catch around it).
  // isPlaceholderProfile guards this exact case explicitly because it happens.
  const malformed = malformedListField(profile);
  if (malformed !== null) {
    return {
      isError: true,
      message:
        `${effective} profile: '${malformed}' in settings.yaml is not a list — it must be a YAML list ` +
        `of model ids. Fix it, or delete the section and let llm-ext regenerate it.`,
    };
  }

  const refusal = ((): DynamicGateResult | null => {
    if (effective === "free") {
      // P6b-fix S8: a PREDICATE, not the old two-name Set — `mass_scout_chain`,
      // `mass_scout_search`, `mass_scout_search_xjob` and `security_scan` all
      // drive the same unbenchmarked subsystem and were passing through
      // unrefused. The refusal names the tool the caller actually asked for.
      if (isFreeForbiddenTool(toolName)) {
        return { isError: true, message: freeToolUnfitRefusal(toolName, allowPaidModels) };
      }
      // P6b-fix2 S-1: the refusal keys on the CHAIN — the ids resolveProfile
      // would actually send to — and there is no BAI_API_KEY escape hatch. The
      // old `pool.length === 0 && !hasBaiKey` let a set key stand in for a
      // usable model: with `free_models` empty, resolveProfile's free_only
      // branch sets `model` to `freeModels[0] ?? ""`, so the command proceeded
      // and put the EMPTY STRING on the wire. A b.ai slot that can serve is in
      // `free_models` (the $0 patch puts it there, first, with its route), so
      // it counts itself — a key alone never does.
      // `effective` is always a dynamic profile name here (dynamicProfileGate
      // returns early on isDynamicProfileName(effective) === false above), so
      // this always takes chainModelIds' dynamic-free_only branch.
      const pool = chainModelIds(effective, profile);
      if (pool.length === 0) {
        // P6b-fix S2 / P6b-fix3 R-2(b) + S-3': WHY the pool is empty decides
        // what to say, and only the last arm may promise a benchmark. The old
        // text asserted "a background benchmark is refreshing the pool" in
        // every case — false with no credentials (nothing can fetch a
        // catalog, let alone benchmark), false under the opt-out (the
        // maintainer returns before any maintenance), and unactionable on a
        // dead link. Ordered by how far upstream the cause is, so the user
        // hears the one thing that has to change first.
        //
        // P14.1: `refreshable` names the SAME condition as the last `why` arm
        // below (no credentials / maintenance-disabled / catalog-just-failed
        // all ruled out) -- computed once here, alongside `why`, instead of
        // re-deriving it from the message text, so the caller (dispatch
        // pre-flight) gets a structural discriminant it can act on.
        const noCredentials = noFreeProviderCredentials(profile);
        const maintDisabled = maintenanceDisabled();
        const catalogFailed = catalogFetchRecentlyFailedSafe(nowMs);
        const why = ((): string => {
          if (noCredentials) {
            return (
              `${FREE_PROVIDER_KEY_VARS.map((v) => `$${v}`).join(" and ")} is not set, so no ` +
              "provider can be queried and no free model can be qualified — export it and re-run."
            );
          }
          if (maintDisabled) return populationDisabledMessage("free");
          if (catalogFailed) {
            return (
              "the OpenRouter catalog fetch failed, so no free model could be qualified this run. " +
              "Check connectivity and retry."
            );
          }
          return "A background benchmark is refreshing the pool — retry in a few minutes.";
        })();
        const refreshable = !noCredentials && !maintDisabled && !catalogFailed;
        return {
          isError: true,
          message: `free profile: no usable free model right now (0 available) — ${why}`,
          // P14.1, D2: only THIS cause is a "an update could plausibly fill
          // it" refusal -- the background update + retry-later answer applies
          // to it and to it alone (never to the no-credentials/maintenance-
          // disabled/catalog-failed causes, which an update cannot fix).
          ...(refreshable ? { reason: "empty-pool-refreshable" as const } : {}),
        };
      }
      return null;
    }

    // TRDD-C9SXX7HO (D2): `local` has no spend gate and no benchmark — it is
    // either populated from a real probe or it isn't. MUST come before the
    // "paid" fallthrough below, which otherwise treats any non-"free" name as
    // paid and wrongly demands `allow_paid_models: true` for a profile that
    // never spends a cent.
    if (effective === "local") {
      const isUnpopulated = !profile || isPlaceholderProfile(profile);
      if (isUnpopulated) {
        return {
          isError: true,
          // fix-queue 83 review (carried from the card): SCANNED, not
          // benchmarked — this message must never say "not benchmarked yet".
          message:
            "local: no local endpoint detected yet; start llama.cpp / LM Studio / Ollama / vLLM " +
            "and run any command",
        };
      }
      return null;
    }

    // paid
    if (!allowPaidModels) {
      return { isError: true, message: "paid profile needs allow_paid_models: true in settings.yaml" };
    }
    const isUnpopulated = !profile || isPlaceholderProfile(profile);
    if (isUnpopulated) {
      // P6b-fix3 S-6': `dailyRemainingUsd` reaches `getConfigDir()`, which THROWS
      // for a config dir outside the allowlist — and this function is documented
      // as "the last thing between the user and their command, it may never
      // throw" (dispatchCallToolInner has no try/catch around it). An unreadable
      // spend ledger is a reason to REFUSE the unpopulated paid profile, which is
      // what happens anyway on this path, never a reason to crash the dispatch.
      // Fails CLOSED (no budget) so a broken ledger can never authorize spend.
      //
      // P6b-fix4 N6: the throw is reported AS ITSELF. Collapsing it to "0
      // remaining" sent the user to the cap message — "today's paid-benchmark
      // budget ($5.00) is used up — it resumes tomorrow (UTC)" — for a config dir
      // that cannot be read, so the advice (wait a day, or raise the cap) was
      // unactionable and the one fact that would fix it never appeared. Same
      // class as S-3'/R-2(b): a refusal must name its real cause.
      const spend = ((): { remaining: number } | { error: string } => {
        try {
          return { remaining: dailyRemainingUsd(settings, nowMs) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })();
      if ("error" in spend) {
        return {
          isError: true,
          message:
            "paid profile is not benchmarked yet and its daily paid-benchmark spend ledger could not " +
            `be read, so no benchmark can be authorized: ${spend.error}`,
        };
      }
      if (spend.remaining <= 0) {
        const cap = paidDailyCapUsd(settings);
        return {
          isError: true,
          message:
            `paid profile is not benchmarked yet and today's paid-benchmark budget ($${cap.toFixed(2)}) ` +
            "is used up — it resumes tomorrow (UTC), or raise paid_benchmark_daily_cap_usd",
        };
      }
      // P6b-fix B1 — the §3.3 row that went missing when the dispatch site
      // stopped calling maybeEnsureDefaultProfileReady for a dynamic profile.
      // On HEAD this case returned "BENCHMARK IN PROGRESS … ~15 minutes"
      // (index.ts's paid population branch); without it the command proceeded
      // and sent the unroutable placeholder id to OpenRouter as a raw 404 —
      // the exact failure the placeholder exists to make impossible to
      // mistake for a real model. Same semantics, now a gate row.
      return { isError: true, message: paidBenchmarkInProgressMessage(nowMs) };
    }
    return null;
  })();
  if (refusal) return refusal;

  // P6b-fix B1, LAST-LINE GUARD: whatever the branches above decided, a chain
  // that still holds the unroutable placeholder id must never reach a
  // provider. Deliberately independent of the population bookkeeping — the
  // branches reason about STATE (populated? cap? key?) and this reasons about
  // the thing that actually gets sent, so a future branch that answers a state
  // question wrongly still cannot put the sentinel on the wire.
  if (chainModelIds(effective, profile).includes(PLACEHOLDER_MODEL_ID)) {
    // Defensively local-aware even though the `local` arm above already
    // returns before this point on every unpopulated case it can construct —
    // "not benchmarked yet" would still be a category error for a profile
    // that is scanned, not benchmarked, if some future path ever reached here.
    const isLocal = effective === "local";
    return {
      isError: true,
      message:
        `${effective} profile still holds the unroutable placeholder model id ` +
        `(${PLACEHOLDER_MODEL_ID}) — ` +
        (isLocal ? "no local endpoint has been detected yet. " : "it has not been benchmarked yet. ") +
        // P6b-fix2 S-3: same reason as paidBenchmarkInProgressMessage — under
        // the opt-out no background benchmark is coming.
        (maintenanceDisabled()
          ? populationDisabledMessage(effective)
          : isLocal
            ? "The change detector scans for one in the background; re-run this command once a local runner is up."
            : "A background benchmark populates it; re-run this command when it finishes."),
    };
  }
  return null;
}

/**
 * P6b-fix2 S-3: what to tell a user whose dynamic profile is not populated.
 *
 * `LLM_EXT_DISABLE_AUTO_RECONCILE=1` (addendum F's documented opt-out) returns
 * the maintainer before any maintenance, but the GATE still runs — so the user
 * who set it was told "it is being benchmarked now (~15 min), re-run when it
 * finishes" forever, about an event their own setting guarantees will never
 * happen. A message must never assert a future the code has already ruled out:
 * with the opt-out on, the only thing that can populate the profile is the
 * command named here.
 */
function maintenanceDisabled(): boolean {
  return process.env[DISABLE_RECONCILE_ENV] === "1";
}

function populationDisabledMessage(name: string): string {
  return (
    `automatic maintenance is disabled by ${DISABLE_RECONCILE_ENV}=1, so nothing will populate it — ` +
    `run 'llm-ext-benchmark --populate-default-profile ${name}', or unset ${DISABLE_RECONCILE_ENV}.`
  );
}

/**
 * P6b-fix3 N-7: the instant after which `paid`'s next benchmark SWEEP may start,
 * or null when nothing is throttling it right now.
 *
 * The maintainer holds back the spawn on two floors the gate could not see —
 * `cooldownUntil` (the benchmark child's exponential failure backoff, in the
 * LEGACY record) and the 6 h `MIN_SWEEP_INTERVAL_MS` floor keyed on sweep
 * COMPLETION (CE9B7S8N: dynamic `lastBenchmarkAt` — the child success-stamps
 * it; a booked failure stamps `cooldownUntil` instead) — and stays
 * deliberately silent about both, because a line on every dispatch for hours
 * is noise. The GATE is the one place that speaks, so it has to read the same
 * two floors; otherwise it asserts "is being benchmarked now" for up to six
 * hours during which nothing is running.
 *
 * While a sweep child is ALIVE (bench lock held — SIGKILL-safe liveness) the
 * floor is NOT asserted: "is being benchmarked now" is then the true sentence,
 * with no completion-timestamp guess involved.
 *
 * Both reads reach getConfigDir(), which THROWS for a config dir outside the
 * allowlist — and a message-rendering path is the last place that may throw, so
 * an unreadable state dir means "no evidence of throttling" and the caller falls
 * back to the sentence it used before.
 */
function paidSweepThrottledUntilMs(nowMs: number): number | null {
  try {
    // A cooldown means the last attempt FAILED, so nothing is running — the
    // floor applies from the moment it is written.
    const cooldownUntil = getProfileRecord("paid")?.cooldownUntil ?? 0;
    // CE9B7S8N: keyed on the child's COMPLETED-success stamp, not on spawn
    // time — the SWEEP_ASSUMED_FINISHED_MS approximation is gone with the
    // spawn-time stamp it patched over. A live child (lock still held) means
    // the sweep is RUNNING, never queued, so the live-lock check comes first.
    if (benchLockIsHeld(backgroundUpdateLockPathFor("paid"), nowMs)) return null;
    const lastSweepFinishedAt = getDynamicProfileRecord("paid")?.lastBenchmarkAt ?? 0;
    const sweepFloorUntil =
      lastSweepFinishedAt > 0
        ? lastSweepFinishedAt + MIN_SWEEP_INTERVAL_MS
        : 0;
    const until = Math.max(cooldownUntil, sweepFloorUntil);
    return until > nowMs ? until : null;
  } catch {
    return null;
  }
}

/** HEAD's paid "benchmark in progress" text, re-homed in the gate. The progress
 *  path is best-effort: defaultProfileLogPath calls getConfigDir(), which
 *  throws for a config dir outside the allowlist, and a message-rendering path
 *  is the last place that may throw. */
function paidBenchmarkInProgressMessage(nowMs: number): string {
  if (maintenanceDisabled()) {
    return `paid profile is not benchmarked yet and ${populationDisabledMessage("paid")}`;
  }
  let progress = "";
  try {
    progress = ` Progress: ${defaultProfileLogPath("paid")}`;
  } catch {
    /* no readable config dir — the rest of the message still stands */
  }
  // P6b-fix3 N-7: same class as S-3, one level down — never assert a benchmark
  // the code has already decided not to start yet. "Re-run when it finishes" is
  // unactionable advice when nothing is running; the throttle's expiry is the
  // one fact that tells the user when to come back.
  const throttledUntil = paidSweepThrottledUntilMs(nowMs);
  if (throttledUntil !== null) {
    return (
      "paid profile is not benchmarked yet; its candidates are QUEUED and the next benchmark sweep " +
      `starts after ${new Date(throttledUntil).toISOString()} — re-run this command then.${progress}`
    );
  }
  return (
    "paid profile is not benchmarked yet and is being benchmarked now (typically ~15 minutes) — " +
    `re-run this command when it finishes.${progress}`
  );
}
