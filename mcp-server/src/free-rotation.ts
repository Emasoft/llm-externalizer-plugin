// ── Free-model rotation: the cross-call availability registry ──────────
//
// OpenRouter's ':free' models are rate-limited two ways: a short-window RPM cap
// (a transient 429) and a HARD DAILY request cap that only resets at 00:00 UTC.
// TRDD-8b6b3646 Phase 3 already rotated an ensemble slot to the next free model
// on a 429 — but the rotation counter lived in a local `let` inside one
// ensembleStreaming() call, so it was forgotten the moment that call returned.
// A scan over 50 files therefore re-tried the SAME daily-exhausted model 50
// times, eating a 429 (and a retry ladder) every single file.
//
// This module is the missing memory: a per-model cooldown registry, shared by
// every call in the process AND persisted to disk so the MCP server and the
// `llm-ext-benchmark` CLI — two processes drawing on ONE daily quota — do not
// each have to re-learn that a model is spent.
//
// Design invariants:
//
//  1. COST-SAFETY. Rotation exists ONLY under free mode. Nothing here can widen
//     the set of models that may be billed: candidates come from the caller's
//     approved ':free' pool, and every send still passes assertFreeOnlyModel at
//     the connection layer.
//  2. NEVER WORSE THAN NO REGISTRY. A cooldown is a HEURISTIC derived from an
//     error string. If it is wrong, it must not make the tool unusable — so when
//     every candidate is cooling we still PROBE (soonest-expiry first) instead of
//     hard-failing. "Exhausted" therefore always means "every approved free model
//     was actually TRIED and actually failed on this call", never "the registry
//     thinks they're all busy".
//  3. PURE CORE + THIN IO SHELL. All the decision logic is pure and takes an
//     injected clock, so it is offline-testable; disk access is best-effort and
//     never throws into a live tool call.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  FREE_POOL_SEED,
  getActiveFreeOnly,
  setActiveFreeOnly,
  getConfigDir,
  loadSettings,
  resolveProfile,
} from "./config.js";
import { isFreeSuffixModelId } from "./benchmark/free-mode.js";
import { benchmarkFailedModels } from "./benchmark/security-triage/index.js";

// ── Which free models are APPROVED (the pool rotation may draw on) ──────

/**
 * The only catalog fields the approval filter reads. Deliberately minimal and
 * structural, so this module needs no import from index.ts (which owns the full
 * OpenRouterModelInfo) — that import would be a cycle.
 */
export interface FreeModelCatalogEntry {
  context_length?: number;
  top_provider?: { context_length?: number };
}

/**
 * Minimum context window (tokens) for a free model to enter the ensemble. A
 * lenient floor that drops only obviously-unusable (tiny-context) free models;
 * the real quality gate is the golden-dataset benchmark (Phase 2, TRDD-8b6b3646).
 * Deliberately NOT the 128K premium bar — free models cluster at 32K-256K and a
 * 128K floor would empty most pools.
 */
export const FREE_FLOOR_MIN_CONTEXT_TOKENS = 32_000;

/**
 * The APPROVED free pool (TRDD-8b6b3646). Two zero-spend filters, in the user's
 * preference order:
 *
 *   1. BENCHMARK (Phase 2) — drop any free model with a RECORDED failing
 *      security-triage benchmark (`benchmarkFailed`). Populated by a deliberate
 *      ($0, free-model) benchmark run; empty until then, so this is a no-op on a
 *      fresh install. A model never benchmarked is NOT dropped here.
 *   2. REQUIREMENTS (Phase 1) — drop free models the catalog POSITIVELY reports
 *      below the context floor.
 *
 * The premium qualification framework (qualifyModelForTool) can't be reused for
 * (2): its criteria set allowFree:false, so it rejects every ':free' model by
 * design — hence the dedicated context floor.
 *
 * Lenient on availability: a model absent from the catalog, or whose catalog
 * entry carries no context info, is KEPT (can't assess → don't penalise) — so a
 * cold catalog degrades to the raw list, never an empty pool. Pure +
 * offline-testable: pass an explicit catalog map and failed-set.
 *
 * This IS the definition of "pre-benchmarked and approved": rotation can only
 * ever land on a model that passed through here.
 */
export function filterFreeModels(
  freeModels: readonly string[],
  catalogById: ReadonlyMap<string, FreeModelCatalogEntry>,
  benchmarkFailed: ReadonlySet<string> = new Set(),
): string[] {
  return freeModels.filter((id) => {
    if (benchmarkFailed.has(id)) return false; // proven-failing benchmark — exclude
    const m = catalogById.get(id);
    if (!m) return true; // unknown to the catalog — keep (lenient on availability)
    const ctx = m.context_length ?? m.top_provider?.context_length ?? 0;
    if (ctx === 0) return true; // catalog has no context info — keep (lenient)
    return ctx >= FREE_FLOOR_MIN_CONTEXT_TOKENS;
  });
}

/** The top-3 approved free models (the ensemble). Rotation uses the FULL approved
 *  list (filterFreeModels) so models 4+ serve as fallbacks. */
export function selectFreeEnsembleModels(
  freeModels: readonly string[],
  catalogById: ReadonlyMap<string, FreeModelCatalogEntry>,
  benchmarkFailed: ReadonlySet<string> = new Set(),
): string[] {
  return filterFreeModels(freeModels, catalogById, benchmarkFailed).slice(0, 3);
}

/**
 * The approved free pool resolved from settings on disk — the surface-independent
 * entry point. The MCP server has a warm catalog cache and uses filterFreeModels
 * directly; the CLI processes (mass_scout, security_scan) do not, so they call
 * this. An empty catalog map is safe precisely because filterFreeModels is lenient
 * on availability: with no catalog we keep every id and let the benchmark filter
 * and the ':free' suffix do the gating.
 *
 * Returns [] on any failure — an unreadable settings file must degrade to "no
 * rotation", never to an exception inside a live tool call.
 */
export function approvedFreePoolFromSettings(): string[] {
  try {
    const s = loadSettings();
    const active = s?.profiles[s.active];
    if (!s || !active) return [];
    const r = resolveProfile(s.active, active);
    // The pool this profile should run when free mode is active for ANY reason
    // (free_only, auto-free on low balance / 402, OR the allow_paid_models master
    // switch). Precedence: the profile's OWN curated free_models win over the
    // bundled seed. resolveProfile fills r.freeModels ONLY for a free_only profile,
    // so for a paid profile that pins free_models (the master-switch case, and the
    // credit-switch case) we MUST read the RAW configured list — otherwise the
    // operator's curated pool is silently dropped and the static seed used instead
    // (a real bug the free-by-default default exposes: on geminigrok the 14
    // configured :free models were ignored in favour of FREE_POOL_SEED). The seed
    // is the last-resort fallback only when there is genuinely no configured pool.
    const configured =
      r.freeModels.length > 0
        ? r.freeModels
        : Array.isArray(active.free_models)
          ? active.free_models.filter((v): v is string => typeof v === "string")
          : [];
    const base = configured.length > 0 ? configured : [...FREE_POOL_SEED];
    return filterFreeModels(base, new Map(), benchmarkFailedModels()).filter(
      isFreeSuffixModelId,
    );
  } catch {
    return [];
  }
}

// ── Shapes ─────────────────────────────────────────────────────────────

/** Why a model is unavailable — decides how long it stays out of the rotation. */
export type UnavailableKind =
  /** The provider's DAILY free quota is spent. Only a UTC-midnight reset helps. */
  | "daily-quota"
  /** A short-window rate limit / provider overload. Minutes, not hours. */
  | "transient"
  /** The model id no longer routes (no endpoints / 404). Effectively gone. */
  | "gone";

export interface Cooldown {
  /** Epoch ms until which this model is skipped. */
  until: number;
  kind: UnavailableKind;
  /** Consecutive transient strikes — drives the exponential backoff. */
  strikes: number;
  /** Sanitized first line of the error that put it here (diagnostics only). */
  detail: string;
}

export interface CooldownStore {
  version: 1;
  models: Record<string, Cooldown>;
}

export function emptyStore(): CooldownStore {
  return { version: 1, models: {} };
}

// ── Pure core ──────────────────────────────────────────────────────────

/** Transient backoff ladder: 30s → 60s → 120s → 240s, capped at 5 min. */
const TRANSIENT_BASE_MS = 30_000;
const TRANSIENT_CAP_MS = 300_000;
/** A model the router can't reach at all is worth re-probing about hourly. */
const GONE_MS = 3_600_000;

/**
 * Classify an error string, or return null when it is NOT an availability
 * failure (a real bug, a 400, a schema violation) — in which case the caller
 * must NOT rotate: swapping models would only hide the defect.
 *
 * This is the SINGLE source of truth for "should we rotate?"; index.ts's
 * isModelUnavailableError() delegates to it so the two can never drift.
 */
export function classifyUnavailable(detail: string): UnavailableKind | null {
  const s = (detail || "").toLowerCase();

  // Daily-quota phrasing FIRST: these strings also contain "429"/"rate limit",
  // and treating a spent daily quota as a 30s transient would send us straight
  // back into the same wall, over and over, until midnight UTC.
  //
  // Only phrasings that POSITIVELY name a per-day window belong here. Bare
  // "quota" / "limit exceeded" / "exceeded your" must NOT: providers use those
  // for minute-scale limits too ("quota exceeded, retry in 60s") and even for
  // per-request token caps, and a daily-quota verdict is now PERSISTED to
  // free-cooldowns.json until 00:00 UTC — a misread would sideline a healthy
  // model in every process for up to 24h. Those bare phrases still classify as
  // unavailable (transient, below), so rotation behavior is unchanged; only the
  // cooldown horizon is kept honest.
  if (
    s.includes("free-models-per-day") ||
    s.includes("per-day") ||
    s.includes("per day") ||
    s.includes("daily limit") ||
    s.includes("daily quota") ||
    s.includes("daily rate limit")
  ) {
    return "daily-quota";
  }

  if (
    s.includes("no endpoints") ||
    s.includes("no allowed providers") ||
    s.includes("not found") ||
    s.includes("404")
  ) {
    return "gone";
  }

  if (
    s.includes("429") ||
    s.includes("rate limit") ||
    s.includes("rate-limit") ||
    s.includes("rate_limit") ||
    s.includes("ratelimit") ||
    s.includes("too many requests") ||
    // Ambiguous quota phrasings land here (short backoff), not in daily-quota —
    // see the comment above. Rotation still fires; the model just isn't
    // sidelined until midnight on a guess.
    s.includes("quota") ||
    s.includes("limit exceeded") ||
    s.includes("exceeded your") ||
    s.includes("502") ||
    s.includes("503") ||
    s.includes("overloaded") ||
    s.includes("temporarily unavailable")
  ) {
    return "transient";
  }

  return null;
}

/** Epoch ms of the next 00:00 UTC — when OpenRouter's free daily cap resets. */
export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

/** How long this failure keeps the model out of the rotation. */
export function computeCooldownUntil(
  kind: UnavailableKind,
  strikes: number,
  nowMs: number,
): number {
  if (kind === "daily-quota") return nextUtcMidnight(nowMs);
  if (kind === "gone") return nowMs + GONE_MS;
  const step = TRANSIENT_BASE_MS * 2 ** Math.max(0, strikes - 1);
  return nowMs + Math.min(step, TRANSIENT_CAP_MS);
}

/**
 * Record a failure against a model. Pure: returns a NEW store, leaves the input
 * untouched. Returns the store unchanged when the error is not an availability
 * failure — a real bug must never silently cool a healthy model.
 */
export function applyUnavailable(
  store: CooldownStore,
  modelId: string,
  detail: string,
  nowMs: number,
): CooldownStore {
  const kind = classifyUnavailable(detail);
  if (!kind) return store;
  const prev = store.models[modelId];
  // Strikes only accumulate while the previous cooldown is still in force; a
  // model that has been healthy since its last 429 starts the ladder again.
  const strikes =
    prev && prev.kind === "transient" && prev.until > nowMs ? prev.strikes + 1 : 1;
  return {
    version: 1,
    models: {
      ...store.models,
      [modelId]: {
        until: computeCooldownUntil(kind, strikes, nowMs),
        kind,
        strikes,
        detail: (detail || "").split("\n")[0].slice(0, 200),
      },
    },
  };
}

/** Clear a model's cooldown — called on a success, so recovery is immediate. */
export function clearCooldown(store: CooldownStore, modelId: string): CooldownStore {
  if (!store.models[modelId]) return store;
  const models = { ...store.models };
  delete models[modelId];
  return { version: 1, models };
}

/** Drop entries whose cooldown has expired (keeps the persisted file small). */
export function pruneExpired(store: CooldownStore, nowMs: number): CooldownStore {
  const models: Record<string, Cooldown> = {};
  for (const [id, cd] of Object.entries(store.models)) {
    if (cd.until > nowMs) models[id] = cd;
  }
  return { version: 1, models };
}

export function isCooling(store: CooldownStore, modelId: string, nowMs: number): boolean {
  const cd = store.models[modelId];
  return !!cd && cd.until > nowMs;
}

/** The soonest moment any of `ids` becomes available again, or null. */
export function earliestReset(
  store: CooldownStore,
  ids: readonly string[],
  nowMs: number,
): number | null {
  let earliest: number | null = null;
  for (const id of ids) {
    const cd = store.models[id];
    if (!cd || cd.until <= nowMs) return nowMs; // one is already free
    if (earliest === null || cd.until < earliest) earliest = cd.until;
  }
  return earliest;
}

/**
 * Split a pool into the models to try FIRST (not cooling, original preference
 * order) and the ones to PROBE afterwards (cooling, soonest-expiry first).
 *
 * The deferred half is what makes invariant (2) hold: a stale or wrong cooldown
 * can only ever REORDER attempts, never remove a model from the rotation.
 */
export function orderByAvailability<T extends { id: string }>(
  pool: readonly T[],
  store: CooldownStore,
  nowMs: number,
): { fresh: T[]; deferred: T[] } {
  const fresh: T[] = [];
  const deferred: T[] = [];
  for (const c of pool) {
    if (isCooling(store, c.id, nowMs)) deferred.push(c);
    else fresh.push(c);
  }
  deferred.sort(
    (a, b) => (store.models[a.id]?.until ?? 0) - (store.models[b.id]?.until ?? 0),
  );
  return { fresh, deferred };
}

// ── Persistent registry (IO shell — best-effort, never throws) ──────────

/** Re-read the on-disk store at most this often; another process may have
 *  learned about a dead model since our last look. */
const RELOAD_INTERVAL_MS = 5_000;

let cache: CooldownStore | null = null;
let lastLoadMs = 0;

export function cooldownFilePath(): string {
  return join(getConfigDir(), "free-cooldowns.json");
}

function readStoreFromDisk(): CooldownStore {
  try {
    const raw = readFileSync(cooldownFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CooldownStore>;
    if (parsed && parsed.version === 1 && parsed.models && typeof parsed.models === "object") {
      return { version: 1, models: parsed.models };
    }
  } catch {
    // Missing / corrupt / unreadable — an empty registry is always a safe start:
    // it costs at most one extra 429 to re-learn what we lost.
  }
  return emptyStore();
}

function writeStoreToDisk(store: CooldownStore): void {
  try {
    const path = cooldownFilePath();
    mkdirSync(getConfigDir(), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Persistence is an optimisation, not a correctness requirement — an
    // unwritable config dir must never fail a live tool call.
  }
}

/** The live store, refreshed from disk when our copy is older than the interval. */
export function getCooldownStore(nowMs: number = Date.now()): CooldownStore {
  if (!cache || nowMs - lastLoadMs > RELOAD_INTERVAL_MS) {
    cache = pruneExpired(readStoreFromDisk(), nowMs);
    lastLoadMs = nowMs;
  }
  return cache;
}

/** Record a failure and persist it. No-op when `detail` is not an availability error. */
export function recordUnavailable(
  modelId: string,
  detail: string,
  nowMs: number = Date.now(),
): void {
  const before = getCooldownStore(nowMs);
  const after = applyUnavailable(before, modelId, detail, nowMs);
  if (after === before) return;
  cache = after;
  writeStoreToDisk(after);
}

/** Record a success — a model that answers is available, whatever we believed. */
export function recordAvailable(modelId: string, nowMs: number = Date.now()): void {
  const before = getCooldownStore(nowMs);
  const after = clearCooldown(before, modelId);
  if (after === before) return;
  cache = after;
  writeStoreToDisk(after);
}

/** Test hook: forget the in-memory copy so the next read hits disk. */
export function resetCooldownCacheForTests(): void {
  cache = null;
  lastLoadMs = 0;
}

// ── The rotation executor ──────────────────────────────────────────────

export interface RotationCandidate {
  id: string;
  /** Per-model output ceiling — the call is clamped to it. */
  maxOutput: number;
}

/** Every approved free model was tried on this call and every one failed. */
export class AllFreeModelsExhaustedError extends Error {
  constructor(
    readonly tried: readonly string[],
    readonly earliestResetMs: number | null,
    readonly lastDetail: string,
  ) {
    const when =
      earliestResetMs && earliestResetMs > Date.now()
        ? ` Earliest reset: ${new Date(earliestResetMs).toISOString()} (free daily quotas reset at 00:00 UTC).`
        : "";
    super(
      `All ${tried.length} approved free model(s) are unavailable — tried ${tried.join(", ")}.` +
        `${when} Last error: ${lastDetail}`,
    );
    this.name = "AllFreeModelsExhaustedError";
  }
}

/** The registry seam — injected in tests, the persistent one in production. */
export interface RotationStore {
  get: (now: number) => CooldownStore;
  recordUnavailable: (id: string, detail: string, now: number) => void;
  recordAvailable: (id: string, now: number) => void;
}

export const persistentRotationStore: RotationStore = {
  get: getCooldownStore,
  recordUnavailable,
  recordAvailable,
};

/**
 * A registry that lives only in RAM — no disk, no shared state. Tests inject it
 * so a unit test can never write to the developer's real ~/.llm-externalizer,
 * nor leak a cooldown into the next test.
 */
export function memoryRotationStore(initial: CooldownStore = emptyStore()): RotationStore {
  let s = initial;
  return {
    get: () => s,
    recordUnavailable: (id, detail, now) => {
      s = applyUnavailable(s, id, detail, now);
    },
    recordAvailable: (id) => {
      s = clearCooldown(s, id);
    },
  };
}

export interface RotationHooks<T> {
  now?: () => number;
  /**
   * For seams that report failure as a VALUE rather than a throw (the ensemble
   * slot does — a rate-limited model comes back as finishReason "error"):
   * return the error detail, or null when the result is a success.
   */
  resultFailureDetail?: (result: T) => string | null;
  store?: RotationStore;
  onRotate?: (from: string, to: string, detail: string) => void;
  /** Fires with each model id just before it is called. The ensemble wrapper uses
   *  it to report WHICH model produced the returned result — reading it back off
   *  the provider's echoed `model` field would trust the provider to tell the
   *  truth about a model we rotated away from. */
  onAttempt?: (modelId: string) => void;
}

/**
 * Call `callOne` against the approved free pool, rotating to the next free model
 * on an availability failure, until one answers or EVERY candidate has actually
 * been tried and failed (then: AllFreeModelsExhaustedError).
 *
 * TWO-TIER by design, because the ensemble runs several slots CONCURRENTLY:
 *   • `start`     — this slot's own primary.
 *   • `fallbacks` — a pool SHARED by every slot of the same call, walked through
 *                   `claimFallback` (`() => next++`, atomic in single-threaded
 *                   JS) so two slots can never grab the same fallback. It must
 *                   already be in attempt order — pass it through
 *                   orderByAvailability() ONCE in the caller, never per slot, or
 *                   two slots would resolve the same index to different models.
 * A single-model caller passes its pool as `fallbacks` with no `claimFallback`
 * and gets a private cursor.
 *
 * A COOLING primary is not called — it is set aside and PROBED only if the whole
 * fallback pool is exhausted (invariant 2: a wrong cooldown may reorder attempts,
 * never remove a model from the rotation).
 *
 * A non-availability error (a genuine 400 / schema bug) is re-thrown as-is:
 * rotating on it would burn the entire pool hiding one real defect.
 */
export async function callWithFreeRotation<T>(
  start: RotationCandidate,
  fallbacks: readonly RotationCandidate[],
  callOne: (model: string, maxOutput: number) => Promise<T>,
  hooks: RotationHooks<T> = {},
  claimFallback?: () => number,
): Promise<T> {
  const now = hooks.now ?? Date.now;
  const store = hooks.store ?? persistentRotationStore;

  let cursor = 0;
  const nextFallback = claimFallback ?? (() => cursor++);

  // Defer (don't drop) a cooling primary — but only if there is somewhere to go.
  let probe: RotationCandidate | null = null;
  let cur: RotationCandidate | null = start;
  if (isCooling(store.get(now()), start.id, now()) && fallbacks.length > 0) {
    probe = start;
    cur = null;
  }

  const tried: string[] = [];
  let lastDetail = "unknown error";

  for (;;) {
    if (cur === null) {
      const idx = nextFallback();
      if (idx >= 0 && idx < fallbacks.length) {
        cur = fallbacks[idx];
      } else if (probe) {
        // Pool exhausted — fall back to the model we skipped on a cooldown
        // guess. Better one wasted 429 than a tool that refuses to run.
        cur = probe;
        probe = null;
      } else {
        throw new AllFreeModelsExhaustedError(
          tried,
          earliestReset(
            store.get(now()),
            [start.id, ...fallbacks.map((f) => f.id)],
            now(),
          ),
          lastDetail,
        );
      }
    }

    tried.push(cur.id);
    hooks.onAttempt?.(cur.id);
    let detail: string;
    try {
      const result = await callOne(cur.id, cur.maxOutput);
      const failure = hooks.resultFailureDetail ? hooks.resultFailureDetail(result) : null;
      if (failure === null) {
        store.recordAvailable(cur.id, now());
        return result;
      }
      // A failure the caller reported as a value, but NOT an availability one —
      // hand it straight back so the caller can surface the real error.
      if (!classifyUnavailable(failure)) return result;
      detail = failure;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!classifyUnavailable(msg)) throw err;
      detail = msg;
    }

    lastDetail = detail;
    store.recordUnavailable(cur.id, detail, now());
    hooks.onRotate?.(cur.id, "next free model", detail);
    cur = null;
  }
}

// ── The FetchImpl decorator: rotation for the direct-HTTP tools ─────────
//
// security_scan and mass_scout do NOT go through the completion layer. Each runs
// its own worker pool against an injected `FetchImpl`, with the model baked into
// the request body, its own retry ladder, and (for security_scan) a circuit
// breaker that force-marks every remaining item `uncertain` after N consecutive
// failures. So a daily-capped free model there does not merely fail the job — it
// silently degrades a whole security scan to "uncertain".
//
// Rotating at the FetchImpl boundary fixes both tools without touching either
// pipeline: the 429 never reaches their retry ladders, so their fail-safe and
// circuit-breaker paths behave exactly as they do on a healthy model. It also
// covers every FUTURE direct-HTTP caller for free, because both tools wire the
// SAME production adapter (`realFetch`).

/** Structural mirror of the FetchResponse both tools define (they are identical
 *  by construction; duplicating the shape here avoids importing either). */
export interface RotatingFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type RotatingFetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<RotatingFetchResponse>;

/** A response whose body was already consumed by the decorator, replayed so the
 *  caller can still read it. Real `res.json()` throws on invalid JSON — so does
 *  this, faithfully. */
function replayResponse(ok: boolean, status: number, body: string): RotatingFetchResponse {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

// Which free models this process has actually SENT to. Reports read a delta of
// this so a run that rotated can say so instead of naming only the model it
// asked for — a report that names one model while another answered half the
// items is a report that lies.
//
// Only TRANSITIONS are recorded, not requests: a 10k-file mass_scout run sends
// 10k times but changes model a handful of times, and an entry per request would
// be 10k strings of pure duplication in a long-lived server. The distinct-set
// that readers actually want is unchanged by the dedup.
const modelsSent: string[] = [];

function noteSend(model: string): void {
  if (modelsSent[modelsSent.length - 1] !== model) modelsSent.push(model);
}

/** A token for the current point in the send log. */
export function rotationJournalMark(): number {
  return modelsSent.length;
}

/** The distinct free models actually sent since `mark`, in first-use order. */
export function rotationJournalSince(mark: number): string[] {
  return [...new Set(modelsSent.slice(Math.max(0, mark)))];
}

/** Test hook — clears the send log. */
export function resetRotationJournalForTests(): void {
  modelsSent.length = 0;
}

// Auto-free engagement seam. index.ts owns the real engageAutoFree (it sets the
// autoFreeEngaged flag + autoFreePool + the chokepoint flag, all consistently)
// and REGISTERS it here at startup, so this leaf module can trigger a session-wide
// paid→free switch WITHOUT importing index.ts (which would be a cycle). In a
// standalone CLI process index.ts is never loaded, so the hook stays null and the
// decorator falls back to flipping the config chokepoint flag directly — safe
// there because a CLI process has no completion-ensemble path to keep in sync.
let autoFreeEngageHook: ((reason: string) => void) | null = null;

/** index.ts calls this once at boot with its engageAutoFree. */
export function registerAutoFreeEngage(fn: (reason: string) => void): void {
  autoFreeEngageHook = fn;
}

/** Engage session-wide free mode after a mid-command credit exhaustion. Uses the
 *  registered engageAutoFree when present (the MCP process, keeps every spend
 *  site consistent), else flips the chokepoint flag directly (a CLI process). */
function engageFreeAfterCreditExhaustion(reason: string): void {
  if (autoFreeEngageHook) autoFreeEngageHook(reason);
  else setActiveFreeOnly(true);
}

/**
 * The ONE stderr line for "a free model was rotated away from". Every rotation
 * site (the FetchImpl decorator here, the completion layer's 402 fallback, and
 * index.ts's ensemble/single-call wrappers) logs through this, so the format —
 * and the truncation — can never drift between the four of them again.
 */
export function logRotation(from: string, to: string, detail: string): void {
  process.stderr.write(
    `[llm-externalizer] Free model ${from} unavailable (${detail
      .split("\n")[0]
      .slice(0, 120)}) — rotating to ${to}.\n`,
  );
}

export interface FetchRotationHooks {
  /** The approved free pool, in preference order. Defaults to settings on disk. */
  pool?: () => string[];
  /** Whether free mode is active. Defaults to the global free_only flag, which
   *  engageAutoFree() also sets — so this one predicate covers both. */
  freeActive?: () => boolean;
  now?: () => number;
  store?: RotationStore;
  onRotate?: (from: string, to: string, detail: string) => void;
  /** Test seam for the paid→free credit switch. Defaults to the real engage. */
  onCreditExhausted?: (reason: string) => void;
}

/**
 * Run one rewritten request through an ordered list of ':free' model ids,
 * rotating on each availability failure. `parsed` is the original JSON body; each
 * attempt re-sends it with `model` swapped. Returns the first OK response (body
 * untouched), or — on a real (non-availability) defect or an exhausted list — the
 * last failing response replayed with its body intact so the caller's own
 * error/fail-safe path runs exactly as before.
 */
async function rotateOverFreeIds(
  inner: RotatingFetchImpl,
  url: string,
  init: Parameters<RotatingFetchImpl>[1],
  parsed: Record<string, unknown>,
  attemptOrder: readonly string[],
  store: RotationStore,
  now: () => number,
  onRotate: (from: string, to: string, detail: string) => void,
): Promise<RotatingFetchResponse> {
  let last: RotatingFetchResponse | null = null;
  for (const model of attemptOrder) {
    noteSend(model);
    const res = await inner(url, { ...init, body: JSON.stringify({ ...parsed, model }) });
    if (res.ok) {
      store.recordAvailable(model, now());
      return res; // untouched — the body was never consumed
    }
    const body = await res.text(); // must read to tell "rate-limited" from "real bug"
    const detail = `HTTP ${res.status}: ${body.slice(0, 300)}`;
    last = replayResponse(res.ok, res.status, body);
    if (!classifyUnavailable(detail)) return last; // a real defect — hand it back
    store.recordUnavailable(model, detail, now());
    const idx = attemptOrder.indexOf(model);
    const next = idx + 1 < attemptOrder.length ? attemptOrder[idx + 1] : "(none left)";
    onRotate(model, next, detail);
  }
  return (
    last ??
    replayResponse(false, 429, JSON.stringify({ error: { message: "no approved free models available" } }))
  );
}

/** Order a pool of free ids for attempts: fresh first (preference), cooling ones
 *  deferred to the back but never dropped. */
function orderedFreeAttempts(
  ids: readonly string[],
  store: RotationStore,
  now: () => number,
): string[] {
  const ordered = orderByAvailability(
    ids.map((id) => ({ id })),
    store.get(now()),
    now(),
  );
  return [...ordered.fresh.map((c) => c.id), ...ordered.deferred.map((c) => c.id)];
}

/**
 * Wrap a production FetchImpl for the direct-HTTP tools (security_scan / mass_scout,
 * which do not go through the completion layer) so that:
 *
 *  A. Under FREE mode, a request pinning a rate-limited ':free' model is
 *     transparently re-sent against the next APPROVED free model, until one
 *     answers or the whole approved pool has been tried.
 *
 *  B. Under PAID mode, a request that comes back 402 (credit exhausted mid-
 *     command) engages session-wide free and completes THAT call on the rotating
 *     free pool — the direct-HTTP twin of the completion layer's 402 catch, so a
 *     security_scan / mass_scout that hits $0 still finishes instead of fail-
 *     safing every remaining item. Strictly one-directional (paid→free): there is
 *     no path here that ever sends a paid model under free mode.
 *
 * Inert (pass-through) in the safe cases: a paid call that DIDN'T 402; a body with
 * no model (catalog/pricing GETs); and a non-availability failure
 * (400/bad-key/schema), which is handed back as-is so a real defect is never
 * masked by rotating the whole pool. A free-mode request pinning a PAID model is
 * NOT passed through — it is served from the free pool, because the only way it
 * occurs is a mid-job auto-free engage (see the branch comment below).
 */
export function withFreeRotation(
  inner: RotatingFetchImpl,
  hooks: FetchRotationHooks = {},
): RotatingFetchImpl {
  return async (url, init) => {
    // Defaults are resolved HERE, per request — never at decoration time.
    // security_scan/openrouter.ts decorates at MODULE-INIT (`export const
    // realFetch = withFreeRotation(rawFetch)`), and this module reaches back into
    // security_scan through the security-triage benchmark import. Reading a
    // later-declared const of this module during that circular init is a TDZ crash
    // — and it crashed on the first run. Request time is also simply correct: the
    // free-mode flag and the pool both change after boot.
    const freeActive = hooks.freeActive ?? getActiveFreeOnly;
    const poolOf = hooks.pool ?? approvedFreePoolFromSettings;
    const now = hooks.now ?? Date.now;
    const store = hooks.store ?? persistentRotationStore;
    const onCreditExhausted = hooks.onCreditExhausted ?? engageFreeAfterCreditExhaustion;
    const onRotate = hooks.onRotate ?? logRotation;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return inner(url, init); // not a JSON body we can rewrite — pass through
    }
    const requested = parsed["model"];

    // ── PAID mode: send as-is; only a 402 (credit exhausted) triggers a switch.
    if (!freeActive()) {
      const res = await inner(url, init);
      if (res.status !== 402 || typeof requested !== "string" || requested.length === 0) {
        return res; // not a credit-exhaustion on a real completion call → untouched
      }
      const body = await res.text(); // consume the 402 so we can replay it if needed
      // Engage session-wide free (consistently, via the registered engageAutoFree),
      // then complete THIS call on the free pool. The paid `requested` model is not
      // a candidate — it can never be sent under free mode.
      onCreditExhausted("402 in direct-HTTP tool");
      process.stderr.write(
        `[llm-externalizer] Credit exhausted (402) in a direct-HTTP tool — switching this command to the free pool.\n`,
      );
      const pool = poolOf();
      if (pool.length === 0) return replayResponse(false, 402, body); // no free pool → surface the 402
      const out = await rotateOverFreeIds(
        inner,
        url,
        init,
        parsed,
        orderedFreeAttempts(pool, store, now),
        store,
        now,
        onRotate,
      );
      // If the free pool also couldn't complete it, surface the ORIGINAL 402 (the
      // actionable error), not a downstream free-model 429.
      return out.ok ? out : replayResponse(false, 402, body);
    }

    // ── FREE mode.
    if (typeof requested !== "string" || requested.length === 0) {
      return inner(url, init); // no model in the body (catalog/pricing GET) → pass through
    }
    if (!isFreeSuffixModelId(requested)) {
      // A PAID model pinned in a completion body while free mode is active. The
      // only way here is a MID-JOB auto-free engage: the job-start chokepoints
      // (assertFreeOnlyModel in judge.ts/scout.ts) run once per job and would have
      // thrown on a paid model under free_only-from-boot — but they do NOT re-run
      // per request, and the model is baked into every request body. Passing this
      // through would just 402 again (or violate free mode), so every call AFTER
      // the one that hit the 402 would exhaust its retry ladder and fail-safe —
      // the switch must cover the REST of the job, not only the in-flight call.
      // Serve it from the approved free pool instead (still strictly paid→free).
      const pool = poolOf();
      if (pool.length === 0) {
        // FAIL CLOSED. Passing the request through would SEND THE PAID MODEL while
        // free mode is active — billing the user money they just signalled they
        // don't want spent (auto-free engages at the balance floor or on a 402).
        // Cost-safety outranks completing the call: a synthetic 429 lands in the
        // caller's existing fail-safe path (uncertain verdict / failed file),
        // which is a visible, honest outcome. An unrequested charge is not.
        process.stderr.write(
          `[llm-externalizer] Free mode is active but the approved free pool is EMPTY — refusing to send paid model '${requested}'. The call fails safe instead of billing.\n`,
        );
        return replayResponse(
          false,
          429,
          JSON.stringify({
            error: {
              message:
                "free mode active with an empty approved free pool — refusing to send a paid model",
            },
          }),
        );
      }
      return rotateOverFreeIds(
        inner,
        url,
        init,
        parsed,
        orderedFreeAttempts(pool, store, now),
        store,
        now,
        onRotate,
      );
    }
    // Candidates: the requested model first, then the rest of the approved pool
    // (cooling ones deferred but never dropped). If the requested model is itself
    // cooling and there's somewhere else to go, probe it last.
    const rest = orderedFreeAttempts(
      poolOf().filter((id) => id !== requested),
      store,
      now,
    );
    const candidates = [requested, ...rest];
    const startCooling = isCooling(store.get(now()), requested, now()) && candidates.length > 1;
    const attemptOrder = startCooling ? [...candidates.slice(1), requested] : candidates;
    return rotateOverFreeIds(inner, url, init, parsed, attemptOrder, store, now, onRotate);
  };
}
