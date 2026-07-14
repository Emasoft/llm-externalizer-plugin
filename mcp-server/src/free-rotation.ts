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

import { getConfigDir } from "./config.js";

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
  if (
    s.includes("free-models-per-day") ||
    s.includes("per-day") ||
    s.includes("per day") ||
    s.includes("daily limit") ||
    s.includes("daily quota") ||
    s.includes("quota") ||
    s.includes("limit exceeded") ||
    s.includes("exceeded your")
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
