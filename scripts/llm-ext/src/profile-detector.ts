/**
 * C2b — the detached DETECTOR (TRDD-OE27RD7I section 2).
 *
 * Replaces the in-process "decide + patch + write" the maintainer
 * (dynamic-maintainer.ts's maintainDynamicProfiles) used to run on EVERY tool
 * dispatch with a much cheaper question, asked from a DETACHED child so the
 * command the user actually ran is never slowed down by it: "did the world
 * change since the last time this profile was maintained?" Only on "yes" does
 * it spawn the real UPDATER — the SAME populate/benchmark child
 * populateDefaultProfile already spawns for a first-time population
 * (default-profiles-runner.ts). The detector itself NEVER writes
 * settings.yaml or the sidecar state; it only reads and, conditionally,
 * spawns. D2 exception: a child spawned in "update requested" mode
 * (PROFILE_UPDATE_REQUESTED_ENV) runs the maintainer pass itself -- see
 * runRequestedUpdate.
 *
 * `local` (phase D2, TRDD-C9SXX7HO) is wired: DETECTORS below is a
 * per-profile table specifically so it was one row (a
 * discoverLocalLlmServices-based detector) rather than a third
 * `name === "free" || name === "paid"` branch alongside the two this file
 * already avoided. Its updater is `runPopulateLocalDefaultProfile`
 * (benchmark/index.ts), spawned the same way `populateDefaultProfile` spawns
 * every other profile's updater — this module never spawns it directly.
 *
 * Wiring done separately (index.ts / benchmark/index.ts, C2b-WIRE): who
 * calls `detectProfileChanges`, and from what spawned child process.
 * `default-profiles-runner.ts`'s `spawnDetachedDetector` is the primitive
 * that starts that child; this module is the function its
 * `--detect-profile-changes <name>` argv case calls.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_PRESETS,
  getConfigDir,
  getEnsemblePriceCeiling,
  isPlaceholderProfile,
  loadSettings,
  resolveEnvValue,
  type DynamicProfileName,
  type Settings,
} from "./config.js";
import { fetchWithTimeout } from "./provider/http.js";
import { DISABLE_RECONCILE_ENV } from "./model-reconcile.js";
import { decideDynamicProfile } from "./default-profiles.js";
import { getDynamicProfileRecord } from "./default-profiles-state.js";
import { getCatalog, catalogCachePath } from "./catalog-cache.js";
import { filterFreeModels } from "./free-rotation.js";
import { isFreeSuffixModelId } from "./benchmark/free-mode.js";
import { benchmarkFailedModels, benchmarkPassedModels } from "./benchmark/security-triage/index.js";
// mkdir-lock.ts's withMkdirLock is the shared cross-process mutex every small
// sidecar read-modify-write in this codebase uses (default-profiles-state.ts,
// dynamic-candidates.ts) — reused here for the throttle claim rather than a
// hand-rolled O_EXCL dance.
import { withMkdirLock } from "./mkdir-lock.js";
// REUSED, not copied (per the C2b directive): dynamic-maintainer.ts's own real
// fetcher/mapper, exported for exactly this — a second, hand-copied version is
// how the detector's verdict would drift from the maintainer's. (D5 removed
// the b.ai fetcher from both: the b.ai route is a user group + reserved slot.)
import {
  toDynamicCatalogEntry,
  dynamicCredentialUsability,
  maintainDynamicProfiles,
  type RawCatalogModel,
} from "./dynamic-maintainer.js";
import {
  populateDefaultProfile,
  backgroundUpdateLockPathFor,
  takeProfileUpdateRequest,
  clearProfileUpdateRequest,
  PROFILE_UPDATE_REQUESTED_ENV,
} from "./default-profiles-runner.js";
import { benchLockPid } from "./bench-lock.js";
// TRDD-C9SXX7HO (D2): the `local` detector's own inputs — a probe of the
// well-known local server ports, never the OpenRouter/b.ai catalog.
import { discoverLocalLlmServices } from "./local_discovery/scan.js";
import { localEndpointFingerprint } from "./local-profile.js";

// ── the throttle claim ───────────────────────────────────────────────────

/** design §2.4-adjacent: at most one detector PER PROFILE runs this often.
 *  Without it a burst of commands (a script looping tool calls) would fork a
 *  detector child — a real network round trip — on every single dispatch. */
export const MIN_DETECT_INTERVAL_MS = 60_000;

function detectThrottleStatePath(): string {
  return join(getConfigDir(), "profile-detect-throttle.json");
}

function detectThrottleLockPath(): string {
  return join(getConfigDir(), "profile-detect-throttle.lock");
}

interface DetectThrottleState {
  version: 1;
  claimedAtMs: Partial<Record<DynamicProfileName, number>>;
}

/** Fail-open: an unreadable/corrupt throttle file reads as "never claimed" —
 *  the cost of getting this wrong is one extra (still real-cost-bounded, $0
 *  for free, gated for paid) detector run, never a permanently wedged one. */
function readDetectThrottleState(): DetectThrottleState {
  const path = detectThrottleStatePath();
  if (!existsSync(path)) return { version: 1, claimedAtMs: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return { version: 1, claimedAtMs: {} };
    const state = parsed as Partial<DetectThrottleState>;
    if (typeof state.claimedAtMs !== "object" || state.claimedAtMs === null) {
      return { version: 1, claimedAtMs: {} };
    }
    return { version: 1, claimedAtMs: state.claimedAtMs };
  } catch {
    return { version: 1, claimedAtMs: {} };
  }
}

/** Atomic (tmp + rename), same pattern as every other sidecar in this
 *  codebase (default-profiles-state.ts, dynamic-candidates.ts): a torn read of
 *  this file must never be possible, even though a LOST update (two racing
 *  writes) is exactly what the mkdir lock below exists to prevent instead. */
function writeDetectThrottleState(state: DetectThrottleState): void {
  const path = detectThrottleStatePath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state), "utf-8");
  renameSync(tmp, path);
}

/**
 * Claim the per-profile detect throttle, atomically, BEFORE any spawn is
 * attempted — never written after. This is the fix the review of the first
 * cut demanded: writing the stamp only once a spawn had already happened (or
 * failed) left a window in which two commands landing in the same second
 * both read "not throttled yet" and both spawned a detector.
 *
 * The read-decide-write sequence runs inside a real cross-process mutex
 * (mkdir-lock.ts's withMkdirLock — the ONE lock primitive this codebase uses
 * for exactly this shape of small sidecar read-modify-write), so the decision
 * and the write are one atomic step: whichever process's callback runs first
 * inside the lock is the only one that can see "not yet claimed" and does the
 * claiming; every other concurrent caller sees the fresh stamp it just wrote
 * and returns false.
 *
 * Returns true iff THIS call won the claim (the caller should proceed to
 * detect and possibly spawn); false means a claim within the window already
 * exists (the caller exits quietly — this is normal throttling, not a
 * failure).
 *
 * CLEARING RULE (review follow-up, C2b-FOLLOWUP item 1): the claim expires
 * purely by AGE — `nowMs - claimedAtMs >= MIN_DETECT_INTERVAL_MS` — never by
 * an unlink, a heartbeat, or a live-pid check. There is nothing else to
 * clear: the stamp is written once, inside the lock, and the lock itself is
 * released in the SAME synchronous call (mkdir-lock.ts's own STALE_MS
 * dead-holder sweep is what guards THAT brief window — see mkdir-lock.ts —
 * not this stamp). So a claimant that crashes immediately after winning the
 * claim — the spawned detector child dies, the parent is killed, nothing
 * ever runs a cleanup step — leaves nothing to unlink: the very next call
 * past MIN_DETECT_INTERVAL_MS reclaims exactly like a clean run, with no
 * special crash-recovery path needed (tested in profile-detector.test.ts).
 *
 * BACKWARDS-CLOCK RULE (fix-queue row 95d): this is a DIFFERENT staleness
 * mechanism from bench-lock.ts's `benchLockIsHeld` (pid-liveness + the
 * lock file's own filesystem `mtime`, which cannot itself run backwards) —
 * this claim's age is `nowMs - claimedAtMs` on the CALLER-supplied clock
 * value, so a system clock that jumps backwards (NTP correction, a manual
 * set) makes that delta negative, which is still `< MIN_DETECT_INTERVAL_MS`
 * and therefore correctly still throttled: a backwards jump can only DELAY
 * the next successful claim by at most the size of the jump, never block it
 * forever (tested in profile-detector.test.ts).
 */
export function claimDetectThrottle(name: DynamicProfileName, nowMs: number = Date.now()): boolean {
  return withMkdirLock(detectThrottleLockPath(), () => {
    const state = readDetectThrottleState();
    // `prev === undefined` (never claimed) must NOT be defaulted to 0 for the
    // arithmetic below: `nowMs - 0` is small — and so falsely "inside the
    // window" — for any nowMs under ~60s, which a caller passing an
    // epoch-relative test clock (or, in principle, a real clock near the Unix
    // epoch) would hit on its very FIRST, never-claimed call. Only an actual
    // PRIOR claim may throttle.
    const prev = state.claimedAtMs[name];
    if (prev !== undefined && nowMs - prev < MIN_DETECT_INTERVAL_MS) return false;
    state.claimedAtMs[name] = nowMs;
    writeDetectThrottleState(state);
    return true;
  });
}

// ── the fingerprint (reuses decideDynamicProfile, never re-derives it) ────

/**
 * The real OpenRouter catalog fetcher for a DETACHED detector process.
 *
 * index.ts's own fetchOpenRouterModels cannot be reused here: it reads
 * `activeResolved`, module-scope state populated by index.ts's OWN CLI boot
 * (the active profile's already-resolved URL/token) — state a freshly
 * spawned detector process never has. So this mirrors dynamic-maintainer.ts's
 * `defaultFetchBaiModels` shape: the preset's own default URL/credential,
 * self-contained, no dependency on another module's boot sequence.
 */
async function defaultFetchOpenRouterCatalog(): Promise<RawCatalogModel[]> {
  const preset = API_PRESETS["openrouter-remote"];
  const url = preset?.defaultUrl ?? "https://openrouter.ai/api";
  const key = resolveEnvValue(preset?.defaultAuthEnv ?? "$OPENROUTER_API_KEY");
  if (!key) return []; // no credential: fail open exactly like getCatalog's own failure path
  const res = await fetchWithTimeout(`${url}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const data = (await res.json()) as { data?: RawCatalogModel[] };
  return Array.isArray(data.data) ? data.data : [];
}

export interface DetectOneChangeResult {
  changed: boolean;
}

/**
 * The free/paid detector: computes the SAME two fingerprints
 * maintainOneDynamicProfile banks (decision.poolFingerprint,
 * decision.modelSpecFingerprints) via the identical `decideDynamicProfile`
 * call, then compares them against what is already on disk
 * (getDynamicProfileRecord). `unusable`/`queued`/`record` are NOT needed for
 * either fingerprint — read decideDynamicProfile's own source: `currentFp` is
 * computed from `catalog`/`catalogFreeQualified`/`baiModels`/`priceCeiling`
 * alone, before any of those three params are consulted, and
 * `modelSpecFingerprints` is built from the profile's OWN configured ids
 * against the catalog, same story. Passing empty sets here is therefore not
 * a shortcut that risks a false verdict — it is the whole set of inputs the
 * fingerprint actually depends on.
 */
async function detectRemoteProfileChange(args: {
  name: DynamicProfileName;
  settings: Settings;
  fetchCatalog: () => Promise<RawCatalogModel[]>;
  nowMs: number;
}): Promise<DetectOneChangeResult> {
  const { name, settings, fetchCatalog, nowMs } = args;

  let catalogFetchFailed = false;
  const rawCatalog = await getCatalog<RawCatalogModel>(fetchCatalog, nowMs, {
    path: catalogCachePath(),
    onError: () => {
      catalogFetchFailed = true;
    },
  });
  // P6b-fix2 S-5's rule applies here too: a failed/empty fetch fingerprints
  // "nothing", which must never be compared as if it were a real reading — an
  // outage would otherwise read as "everything changed" (paid) or "nothing
  // needs updating" (a false negative masking a real drift), neither correct.
  if (catalogFetchFailed || rawCatalog.length === 0) return { changed: false };

  const catalog = rawCatalog.map(toDynamicCatalogEntry);
  const catalogById = new Map(rawCatalog.map((m) => [m.id, m]));
  const freeIds = rawCatalog.map((m) => m.id).filter(isFreeSuffixModelId);
  const catalogFreeQualified = filterFreeModels(freeIds, catalogById, benchmarkFailedModels());
  const priceCeiling = name === "paid" ? getEnsemblePriceCeiling(settings) : 0;

  // Same derivation maintainOneDynamicProfile uses: the auto-created
  // placeholder stub counts as "unpopulated" for this decision, never as a
  // real configured profile.
  const existing = settings.profiles[name];
  const current = existing && !isPlaceholderProfile(existing) ? existing : undefined;

  // S3 (row 53 review): the SAME shared helper maintainOneDynamicProfile
  // calls -- before this, the detector passed neither flag at all,
  // decideDynamicProfile's own (now-removed) `= true` defaults silently
  // covered for it, and the detector fingerprinted a pool no credential
  // could actually serve as if it were the real one, disagreeing with the
  // maintainer's write-skip forever (a spurious "changed" every pass).
  // D5: the b.ai half of the helper's return is gone with the b.ai plumbing.
  const { openRouterCredentialUsable } = dynamicCredentialUsability(name, settings);

  const decision = decideDynamicProfile({
    name,
    current,
    catalog,
    catalogFreeQualified,
    // D3c-1b (TRDD-FDI9NYAS): this caller only compares decision.poolFingerprint
    // for drift detection (see below) and never reads decision.patch, so the
    // exact strict/lenient split doesn't change what it observes -- passed for
    // real anyway, so this stays the one true reading instead of a hand-typed
    // stand-in that could drift from the maintainer's.
    benchmarkPassed: benchmarkPassedModels(),
    unusable: new Set(),
    queued: new Set(),
    priceCeiling,
    openRouterCredentialUsable,
  });

  const record = getDynamicProfileRecord(name);
  const changed =
    record === undefined ||
    record.poolFingerprint !== decision.poolFingerprint ||
    JSON.stringify(record.modelSpecFingerprints ?? {}) !== JSON.stringify(decision.modelSpecFingerprints);
  return { changed };
}

// ── per-profile dispatch table ────────────────────────────────────────────

interface DetectorArgs {
  name: DynamicProfileName;
  settings: Settings;
  nowMs: number;
  fetchCatalog: () => Promise<RawCatalogModel[]>;
}
type ProfileDetector = (args: DetectorArgs) => Promise<DetectOneChangeResult>;

/**
 * The `local` detector (TRDD-C9SXX7HO, D2): probes the well-known local
 * server ports (never the OpenRouter catalog `args.fetchCatalog` carries —
 * it is simply unused here) and
 * compares `localEndpointFingerprint`'s reading against `getDynamicProfileRecord("local")`.
 * That record's `poolFingerprint` is banked by
 * `runPopulateLocalDefaultProfile` (benchmark/index.ts) — the ONLY writer,
 * since `local` has no separate catalog-decide pass the way free/paid's
 * `maintainOneDynamicProfile` does — so an undefined record (never populated
 * yet) reads as "changed", same as detectRemoteProfileChange's own
 * `record === undefined` arm.
 */
async function detectLocalProfileChange(): Promise<DetectOneChangeResult> {
  const services = await discoverLocalLlmServices();
  const fingerprint = localEndpointFingerprint(services);
  const record = getDynamicProfileRecord("local");
  return { changed: record === undefined || record.poolFingerprint !== fingerprint };
}

/**
 * ONE row per dynamic profile, not a name === "free" || name === "paid"
 * branch. `free` and `paid` share the same remote-catalog detector;
 * `local` (TRDD-C9SXX7HO, D2) is the local-probe detector above — one row,
 * never a third copy of detectRemoteProfileChange's body.
 */
const DETECTORS: Partial<Record<DynamicProfileName, ProfileDetector>> = {
  free: detectRemoteProfileChange,
  paid: detectRemoteProfileChange,
  local: detectLocalProfileChange,
};

// ── D2: the update a command requested ─────────────────────────────────────

/**
 * D2 (USER 2026-09-18, "the profile updating must happens in background"):
 * the work a command used to do IN THE FOREGROUND before retrying
 * (index.ts's deleted runDynamicProfileUpdateAndWait), now done here, in the
 * detached child requestProfileUpdate spawned under `name`'s ONE
 * background-update lock (SG2) -- so no command ever waits for it.
 *
 *   free / paid: the maintainer pass for `name` only (maintainDynamicProfiles
 *     with heldLockProfile): the $0 patch (a provisional pool in seconds --
 *     on a b.ai-only machine the ONLY writer of the b.ai slot, which populate
 *     cannot write when no OpenRouter model passes), the fingerprint baseline
 *     this detector compares against, the candidate queue, then (forceSweep)
 *     the re-benchmark, handed this same lock. allow_paid_models and the
 *     daily cap still gate a paid spawn.
 *   local: the local rescan (runPopulateLocalDefaultProfile), handed this
 *     same lock -- `local` has no maintainer pass (it is never in the
 *     OpenRouter catalog).
 */
async function runRequestedUpdate(
  name: DynamicProfileName,
  nowMs: number,
  log: (msg: string) => void,
  opts: DetectProfileChangesOpts,
): Promise<DetectProfileChangesResult> {
  const settings = loadSettings();
  if (!settings) return { changed: false, spawned: false, reason: "no settings.yaml" };
  if (name === "local") {
    const outcome = populateDefaultProfile({
      profile: "local",
      allowPaidModels: settings.allow_paid_models === true,
      log,
      alreadyHeldByCaller: true,
    });
    if (outcome.kind === "spawned") return { changed: true, spawned: true };
    clearProfileUpdateRequest(name); // nothing more this pass could do for it
    return { changed: true, spawned: false, reason: outcome.reason };
  }
  await maintainDynamicProfiles({
    fetchCatalog: opts.fetchCatalog ?? defaultFetchOpenRouterCatalog,
    nowMs,
    log,
    heldLockProfile: name,
    forceSweep: true,
  });
  // The maintainer reports settings writes, not spawns: a populate child it
  // started now holds this lock under ITS pid (the SG2 handoff).
  const holder = benchLockPid(backgroundUpdateLockPathFor(name));
  // A request a command left WHILE this pass held the lock was told "an
  // update is underway", and this pass was it: consume it, or the next lock
  // holder would run the same update again. (After a handoff, the populate
  // child's own lastBenchmarkAt serves such a request instead.)
  if (holder === process.pid) clearProfileUpdateRequest(name);
  return { changed: true, spawned: holder !== null && holder !== process.pid };
}

// ── the public entry point ────────────────────────────────────────────────

export interface DetectProfileChangesOpts {
  nowMs?: number;
  log?: (msg: string) => void;
  fetchCatalog?: () => Promise<RawCatalogModel[]>;
}

export interface DetectProfileChangesResult {
  /** True iff a fingerprint difference was found. */
  changed: boolean;
  /** True iff the UPDATER was spawned as a result. */
  spawned: boolean;
  /** Why nothing happened, when `changed` and `spawned` are both false. */
  reason?: string;
}

/**
 * The detector's whole contract (design §2, TRDD-OE27RD7I): decide whether
 * `name`'s dynamic pool needs a re-benchmark, and if so, spawn the UPDATER —
 * the SAME detached populate/benchmark child a first-time population already
 * spawns (populateDefaultProfile). Never writes settings.yaml or the sidecar
 * state itself. Never throws to its caller (the CLI mode this backs is
 * documented to exit 0/1 on that basis; every internal failure here is
 * caught and reported through `reason` instead) — this is meant to run
 * DETACHED, with nobody watching its stdout on the common "nothing changed"
 * path.
 *
 * This function performs its OWN network call (the OpenRouter/b.ai catalog
 * probe) — that is THIS process's traffic, never the command's own request
 * to the profile's model. It runs in a separate, later-spawned child, so it
 * cannot precede or delay whatever request the command that triggered it is
 * already making.
 */
export async function detectProfileChanges(
  name: DynamicProfileName,
  opts: DetectProfileChangesOpts = {},
): Promise<DetectProfileChangesResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const log = opts.log ?? (() => {});
  // The single documented opt-out for ALL dynamic maintenance (addendum F) —
  // covers the detector too, per the C2b directive ("keep
  // LLM_EXT_DISABLE_AUTO_RECONCILE as the switch for the detector spawn
  // only").
  if (process.env[DISABLE_RECONCILE_ENV] === "1") {
    return { changed: false, spawned: false, reason: "disabled" };
  }
  try {
    // D2: the update a command requested -- either this child was spawned for
    // it (the env flag; its requester already applied the respawn throttle,
    // and this pass serves every request left so far) or a command left the
    // "update requested" marker because the lock was held when all its models
    // failed (honoured here unless the failure backoff says wait). No detect
    // throttle, no fingerprint comparison.
    const requested = process.env[PROFILE_UPDATE_REQUESTED_ENV] === "1";
    if (requested) clearProfileUpdateRequest(name);
    if (requested || takeProfileUpdateRequest(name, nowMs)) {
      return await runRequestedUpdate(name, nowMs, log, opts);
    }
    const result = await detectOnce(name, nowMs, log, opts);
    // D2 (orchestrator review, cross-command race): a request that arrived
    // WHILE this plain detection held the lock is honoured before the lock is
    // released -- otherwise a detection that finds no change would exit and
    // the requester's update would be lost. Not when the lock was just handed
    // to a populate child: that child is the update.
    if (benchLockPid(backgroundUpdateLockPathFor(name)) === process.pid && takeProfileUpdateRequest(name, nowMs)) {
      return await runRequestedUpdate(name, nowMs, log, opts);
    }
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[llm-externalizer] --detect-profile-changes ${name} failed: ${reason}\n`);
    return { changed: false, spawned: false, reason };
  }
}

/** The plain detection (C2b): throttle, fingerprint comparison, and on a
 *  change the populate/benchmark spawn, handed this child's lock. */
async function detectOnce(
  name: DynamicProfileName,
  nowMs: number,
  log: (msg: string) => void,
  opts: DetectProfileChangesOpts,
): Promise<DetectProfileChangesResult> {
  if (!claimDetectThrottle(name, nowMs)) {
    return { changed: false, spawned: false, reason: "throttled" };
  }
  const settings = loadSettings();
  if (!settings) return { changed: false, spawned: false, reason: "no settings.yaml" };
  const detector = DETECTORS[name];
  if (!detector) return { changed: false, spawned: false, reason: `no detector registered for '${name}'` };

  const { changed } = await detector({
    name,
    settings,
    nowMs,
    fetchCatalog: opts.fetchCatalog ?? defaultFetchOpenRouterCatalog,
  });
  if (!changed) return { changed: false, spawned: false };

  const allowPaidModels = settings.allow_paid_models === true;
  // SG2 (per-profile singleton lock): this detector process is itself the
  // spawned child of spawnDetachedDetector, running under `name`'s ONE
  // background-update lock (default-profiles-runner.ts's
  // backgroundUpdateLockPathFor) -- production only ever calls
  // detectProfileChanges from that spawned child (benchmark/index.ts's
  // --detect-profile-changes case), so alreadyHeldByCaller is always
  // correct here, never an assumption a test needs to fake around: a
  // direct in-process test call that never held the lock simply gets the
  // "held"-mapped refusal from spawnDetachedBench's own ownership check.
  const outcome = populateDefaultProfile({ profile: name, allowPaidModels, log, alreadyHeldByCaller: true });
  return { changed: true, spawned: outcome.kind === "spawned", reason: outcome.kind !== "spawned" ? outcome.reason : undefined };
}
