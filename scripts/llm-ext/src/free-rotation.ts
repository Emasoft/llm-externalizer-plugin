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
import { createHash } from "node:crypto";

import {
  getActiveFreeOnly,
  getConfigDir,
  loadSettings,
  resolveProfile,
  effectiveProfileName,
} from "./config.js";
import { isFreeSuffixModelId, paymentErrorCertainty } from "./benchmark/free-mode.js";
import { failureText } from "./provider/http.js";
import { benchmarkFailedModels } from "./benchmark/security-triage/index.js";
import {
  assessModelPersistence,
  parseEventTimestamp,
  readModelEvents,
  PERSISTENCE_WINDOW_HOURS,
  type ModelEvent,
} from "./model-events.js";

import { RetryDeadlineError, retryWindowClosed, type RetryClock } from "./provider/http.js";

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
 *
 * `benchmarkPassed` (TRDD-FDI9NYAS D3c, optional, no default): when a caller
 * passes it, this becomes the STRICT "approved to SERVE" gate on top of the
 * two above — an id with no RECORDED PASS is excluded even though it was
 * never proven to fail either (USER: "no model should be used unless it pass
 * the benchmark"). Left undefined (the default), this function stays the
 * lenient requirements filter it always was, because it ALSO backs
 * candidate-discovery/ranking call sites where a never-benchmarked id must
 * stay VISIBLE — that visibility is how it gets queued for its first
 * benchmark in the first place. Passing this set is what turns "candidate"
 * into "approved to serve"; every caller that determines whether an
 * AUTO-PICKED id may actually be SENT or WRITTEN into a served free_models
 * pool must pass it (manual/static ids are provenance-exempt — union in the
 * profile's manualModels before calling, never pass this filter a bare
 * benchmarkPassed that would also reject a hand-listed id).
 */
export function filterFreeModels(
  freeModels: readonly string[],
  catalogById: ReadonlyMap<string, FreeModelCatalogEntry>,
  benchmarkFailed: ReadonlySet<string> = new Set(),
  benchmarkPassed?: ReadonlySet<string>,
): string[] {
  return freeModels.filter((id) => {
    if (benchmarkFailed.has(id)) return false; // proven-failing benchmark — exclude
    if (benchmarkPassed && !benchmarkPassed.has(id)) return false; // no recorded pass — exclude
    const m = catalogById.get(id);
    if (!m) return true; // unknown to the catalog — keep (lenient on availability)
    const ctx = m.context_length ?? m.top_provider?.context_length ?? 0;
    if (ctx === 0) return true; // catalog has no context info — keep (lenient)
    return ctx >= FREE_FLOOR_MIN_CONTEXT_TOKENS;
  });
}

// ── Bench-evidence ranking (task #189) ─────────────────────────────────
// 2026-08-05 finding: the auto-selected free trio (laguna-xs, north-mini-code,
// nemotron-3.5-content-safety — a SAFETY CLASSIFIER) produced length+empty on
// nearly every code-review call, while all three carried `qualified: false`
// "below code-task requirements" rows in the per-tool ledgers THE WHOLE TIME.
// The evidence existed; selection ignored it (it consumed only the
// security-triage failed set). The cure is RANKING, never hard exclusion —
// invariant 2 above: a pool must degrade, not empty. A model with a passing
// per-tool bench outranks one never benchmarked, which outranks one with a
// real failing/requirements verdict; within a tier the operator's configured
// order is preserved (stable sort).

export type BenchVerdict = "pass" | "fail";

/** One per-tool ledger row, structurally (the files carry more; we read less). */
interface LedgerRow {
  qualified?: unknown;
  disqualifyReason?: unknown;
  /** The persisted GOLDEN-DATASET verdict (passesThresholds at write time).
   *  This is the real task-quality signal: `qualified` records only the
   *  catalog-requirements gate, which rejects the whole ':free' class by
   *  design (allowFree:false) — so without this field no ':free' model could
   *  ever earn a scored verdict and the evidence fold was inert for exactly
   *  the pool it ranks (ultracode F0, 2026-08-05). Absent on legacy rows. */
  qualityPass?: unknown;
}

/**
 * Non-quality row shapes that must NOT demote a model. These are enumerable
 * because WE write them:
 *   • the paid/free skip rows (all contain "not benchmarked" or the free_only
 *     skip phrasing),
 *   • the catalog-availability miss ("not found in the OpenRouter catalog" —
 *     lenient-on-availability, same philosophy as filterFreeModels),
 *   • REQUIREMENTS rejections ("below <tool> requirements (…)"). Measured
 *     2026-08-05: every one of the 17 ledgered ':free' models carried one —
 *     because the premium qualification criteria set allowFree:false and
 *     reject the ':free' CLASS by design (see the filterFreeModels comment).
 *     A class rejection is not evidence the individual is bad AT THE TASK;
 *     counting it demoted the entire pool uniformly, i.e. ranked nothing.
 * Any OTHER qualified:false row (a scored golden-dataset failure) is a real
 * verdict. A future skip row MUST keep the "not benchmarked" phrasing or it
 * will demote models it meant to spare — enforced by the shape tests.
 */
function isNonQualityReason(reason: string): boolean {
  return (
    reason.includes("not benchmarked") ||
    reason.includes("non-':free' model") ||
    reason.includes("not found in the OpenRouter catalog") ||
    reason.includes(" requirements (")
  );
}

/**
 * Fold per-tool ledger objects (keys `model::date::hash` → row) into one
 * verdict per model. PASS wins over FAIL across tools: a model proven good at
 * ONE tool is a usable ensemble member even if it fails another tool's
 * requirements — the per-tool gates still protect those tools individually.
 */
export function parseBenchEvidence(
  ledgers: ReadonlyArray<Record<string, LedgerRow>>,
): Map<string, BenchVerdict> {
  const out = new Map<string, BenchVerdict>();
  for (const ledger of ledgers) {
    for (const [key, row] of Object.entries(ledger)) {
      const id = key.split("::")[0];
      if (!id) continue;
      // Layer 1 — the persisted golden-dataset verdict. When present it
      // decides ALONE: a ':free' model that aced the dataset is a "pass"
      // even though `qualified` is false for its whole class, and a scored
      // flop is a "fail" whatever the requirements gate said.
      if (row.qualityPass === true) {
        out.set(id, "pass"); // pass wins, unconditionally
        continue;
      }
      if (row.qualityPass === false) {
        if (out.get(id) !== "pass") out.set(id, "fail");
        continue;
      }
      // Layer 2 — legacy rows (written before qualityPass existed): infer
      // from the requirements fields, skipping the non-quality shapes.
      if (row.qualified === true) {
        out.set(id, "pass"); // pass wins, unconditionally
        continue;
      }
      if (row.qualified !== false) continue; // malformed row — no verdict
      const reason = typeof row.disqualifyReason === "string" ? row.disqualifyReason : "";
      if (isNonQualityReason(reason)) continue; // skip/availability — no verdict
      if (out.get(id) !== "pass") out.set(id, "fail");
    }
  }
  return out;
}

/** The five per-tool ledger files the evidence fold reads. */
const BENCH_LEDGER_FILES = [
  "code-task-results.json",
  "scan-folder-results.json",
  "check-specs-results.json",
  "search-existing-results.json",
  "security-triage-results.json",
] as const;

/**
 * Load + fold the on-disk ledgers. Best-effort per file (an unreadable or
 * missing ledger contributes nothing — a fresh install ranks everything
 * "unknown" and behavior is identical to the pre-#189 selector).
 */
export function benchEvidenceFromLedgers(
  dir: string = getConfigDir(),
): Map<string, BenchVerdict> {
  const ledgers: Record<string, LedgerRow>[] = [];
  for (const f of BENCH_LEDGER_FILES) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ledgers.push(parsed as Record<string, LedgerRow>);
      }
    } catch {
      /* absent/unreadable ledger → no evidence from it */
    }
  }
  return parseBenchEvidence(ledgers);
}

/**
 * Classifier-class models (safety/guard filters) are not generators and can
 * never produce a code review, whatever their bench rows say — clamp them to
 * the last tier. Id heuristic with honest limits: it catches the observed
 * offenders (content-safety, llama-guard style ids) and misses exotic names;
 * the ledger evidence is the primary signal, this is belt-and-braces.
 */
export function looksLikeClassifier(id: string): boolean {
  const s = id.toLowerCase();
  return s.includes("content-safety") || s.includes("guard") || s.includes("-safety");
}

/**
 * Stable tier sort: pass (0) < unknown (1) < fail (2); classifier-named ids
 * clamp to tier 2. Within a tier the input (operator) order is preserved.
 */
export function rankFreeModelsByBenchEvidence(
  ids: readonly string[],
  evidence: ReadonlyMap<string, BenchVerdict>,
): string[] {
  const tier = (id: string): number => {
    if (looksLikeClassifier(id)) return 2;
    const v = evidence.get(id);
    return v === "pass" ? 0 : v === "fail" ? 2 : 1;
  };
  // Array.prototype.sort is stable per spec — operator order survives per tier.
  return [...ids].sort((a, b) => tier(a) - tier(b));
}

// ── Runtime no-content demotion (task #189 c) ──────────────────────────
// A model that repeatedly burns its whole completion budget on reasoning and
// emits NO content (the length+empty cost-stop in provider/completion.ts) is
// unfit in current conditions whatever its ledger says. Strikes persist
// cross-process (the CLI is one process per invocation) and are SELF-HEALING
// by TWO independent paths: any content-bearing success clears them, and a
// strike EXPIRES after NO_CONTENT_STRIKE_TTL_MS regardless. The TTL is
// load-bearing, not belt-and-braces (ultracode F1, 2026-08-05): a demoted
// model drops out of the top-3 ensemble, and with a healthy top-3 it is never
// called again — so the success-heals path alone could never fire and the
// demotion was PERMANENT, contradicting this module's own self-healing
// invariant. Auto-DUBC needs no user action in either direction. This is a
// QUALITY signal feeding the ensemble ranking — deliberately NOT a rotation
// cooldown (the model may still serve as a rotation fallback; it just stops
// being a preferred ensemble slot).

/** Strikes at or above this rank the model in the fail tier. Three = the
 *  reasoning ladder ran its full course (downgrade, disable, still empty). */
export const NO_CONTENT_DEMOTION_THRESHOLD = 3;

/** A strike record older than this no longer demotes, and a NEW strike after
 *  this gap restarts the count at 1 (the threshold means "3 under CURRENT
 *  conditions", not "3 ever"). 24h matches the free-tier daily-quota rhythm:
 *  conditions that starve a model of output budget reset on that cadence. */
export const NO_CONTENT_STRIKE_TTL_MS = 24 * 60 * 60 * 1000;

interface NoContentStrikes {
  version: 1;
  models: Record<string, { strikes: number; lastAt: number }>;
}

function strikesFilePath(): string {
  return join(getConfigDir(), "no-content-strikes.json");
}

function loadStrikes(): NoContentStrikes {
  try {
    const parsed = JSON.parse(readFileSync(strikesFilePath(), "utf-8")) as NoContentStrikes;
    if (parsed && parsed.version === 1 && parsed.models) return parsed;
  } catch {
    /* absent/corrupt → fresh */
  }
  return { version: 1, models: {} };
}

function saveStrikes(s: NoContentStrikes): void {
  // Same atomic tmp+rename pattern as the cooldown store. Best-effort:
  // a failed write loses one strike observation, never breaks a live call.
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    const tmp = strikesFilePath() + ".tmp";
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, strikesFilePath());
  } catch {
    /* best-effort */
  }
}

/** Record one length+empty terminal outcome (the cost-stop / exhausted label).
 *  A previous record older than the TTL restarts the count at 1 — otherwise a
 *  stale 3-strike entry from yesterday would demote on the FIRST hiccup today,
 *  turning the windowed threshold into a lifetime one. */
export function recordNoContentStrike(modelId: string, nowMs = Date.now()): void {
  if (!modelId) return;
  const s = loadStrikes();
  const prev = s.models[modelId];
  const withinWindow = prev !== undefined && nowMs - prev.lastAt <= NO_CONTENT_STRIKE_TTL_MS;
  s.models[modelId] = { strikes: withinWindow ? prev.strikes + 1 : 1, lastAt: nowMs };
  saveStrikes(s);
}

/** A content-bearing success heals the model — strikes reset to zero. Reads
 *  first and writes only when an entry exists, so the hot success path does
 *  not churn the file on every call. */
export function clearNoContentStrikes(modelId: string): void {
  if (!modelId) return;
  const s = loadStrikes();
  if (!s.models[modelId]) return;
  delete s.models[modelId];
  saveStrikes(s);
}

/** Models at/over the demotion threshold — merged into the fail tier.
 *  Expired records (lastAt older than the TTL) do NOT demote: this is the
 *  time-based half of the self-healing invariant, the only heal path a model
 *  that is never called again can take (see the module note above). */
export function noContentDemotedModels(nowMs = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const [id, rec] of Object.entries(loadStrikes().models)) {
    if (nowMs - rec.lastAt > NO_CONTENT_STRIKE_TTL_MS) continue; // expired — healed
    if (rec.strikes >= NO_CONTENT_DEMOTION_THRESHOLD) out.add(id);
  }
  return out;
}

/**
 * The full evidence picture for ensemble ranking: ledger verdicts overlaid
 * with runtime no-content demotions. The runtime signal is FRESHER than a
 * ledger pass, so it wins — and because it self-heals on the next
 * content-bearing success, a wrongly-demoted model recovers without anyone
 * touching anything.
 */
export function combinedFreeModelEvidence(): Map<string, BenchVerdict> {
  const evidence = benchEvidenceFromLedgers();
  for (const id of noContentDemotedModels()) evidence.set(id, "fail");
  return evidence;
}

/** The top-3 approved free models (the ensemble), best bench evidence first.
 *  Rotation uses the FULL approved list (filterFreeModels) so models 4+ serve
 *  as fallbacks. `benchEvidence` defaults empty (rank = operator order), so
 *  callers without ledger access keep the old behavior. `benchmarkPassed`
 *  (TRDD-FDI9NYAS D3c, optional, no default) forwards straight to
 *  filterFreeModels — see its own doc: the caller must union in the active
 *  profile's manualModels before passing this, or a hand-listed id gets
 *  wrongly excluded too. */
export function selectFreeEnsembleModels(
  freeModels: readonly string[],
  catalogById: ReadonlyMap<string, FreeModelCatalogEntry>,
  benchmarkFailed: ReadonlySet<string> = new Set(),
  benchEvidence: ReadonlyMap<string, BenchVerdict> = new Map(),
  benchmarkPassed?: ReadonlySet<string>,
): string[] {
  const ranked = rankFreeModelsByBenchEvidence(
    filterFreeModels(freeModels, catalogById, benchmarkFailed, benchmarkPassed),
    benchEvidence,
  );
  // THE ORDERING FLOOR (TRDD-6HGJFPDR). Ranking a classifier last only protects
  // the ensemble while the pool is long enough that selection never reaches the
  // bottom. At pool size <= 3, "last" and "selected" are the SAME POSITION, and a
  // safety classifier — which cannot generate a code review at all — would serve
  // as an ensemble member. Measured in TRDD-V32LB992 §3e.5 at pool size 3.
  //
  // So EXCLUDE rather than merely rank. On the live 18-member pool this changes
  // nothing (classifiers already rank below the top 3); it only bites once the
  // pool is short, which is exactly the case ordering cannot cover.
  //
  // The fallback is load-bearing, not defensive padding: if EVERY member is
  // classifier-named, an unconditional exclusion would hand back an empty
  // ensemble and take the tool dark. A degraded ensemble beats no ensemble, and
  // "never dark" is this module's standing invariant.
  const generators = ranked.filter((id) => !looksLikeClassifier(id));
  return (generators.length > 0 ? generators : ranked).slice(0, 3);
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
    if (!s) return [];
    const activeName = effectiveProfileName(s);
    const active = s.profiles[activeName];
    if (!active) return [];
    const r = resolveProfile(activeName, active);
    // The pool this profile should run when free mode is active for ANY reason
    // (free_only, auto-free on low balance / 402, OR the allow_paid_models master
    // switch). Precedence: the profile's OWN curated free_models win over the
    // bundled seed. resolveProfile fills r.freeModels ONLY for a free_only profile,
    // so for a paid profile that pins free_models (the master-switch case, and the
    // credit-switch case) we MUST read the RAW configured list -- otherwise the
    // operator's curated pool is silently dropped and the static seed used instead
    // (a real bug the free-by-default default exposes: on geminigrok the 14
    // configured :free models were ignored in favour of FREE_POOL_SEED).
    const configured =
      r.freeModels.length > 0
        ? r.freeModels
        : Array.isArray(active.free_models)
          ? active.free_models.filter((v): v is string => typeof v === "string")
          : [];
    // Rule 5 (Phase 5 sec (a) Site 5): NO FREE_POOL_SEED fallback -- an
    // unconfigured (static) profile now returns [] honestly instead of
    // silently borrowing the bundled seed. Site 2 (index.ts's activeFreePool)
    // already treats an empty pool as the trigger to refuse/warn rather than
    // proceed (Site 3, engageAutoFree, was deleted outright -- TRDD-OE27RD7I
    // addendum 4), so a mid-command 402 on an unconfigured static profile now
    // surfaces the ORIGINAL 402 (the
    // existing replayResponse(false, 402, body) rotation path) instead of
    // silently switching to a model the profile never configured.
    if (configured.length === 0) return [];
    return filterFreeModels(configured, new Map(), benchmarkFailedModels()).filter(
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
  /** The model id does not route FOR US (no endpoints / 404 / a 403 refusing
   *  this integration access). Effectively gone; re-probed about hourly. */
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
  /**
   * TRDD-W9XLU1HD AC3: how many runs in a row have classified this model
   * "gone". Persisted here (same file, same atomic writer — ONE writer,
   * free-cooldowns.json) so strikes survive process restarts. A model at
   * >= GONE_EVICT_STRIKES strikes is EXCLUDED from reconcile's free-pool
   * re-adoption (computeReconcile reads goneEvictedModels()) until
   * GONE_EVICT_TTL_MS after its LAST strike, after which the entry ages out
   * and the model may be re-probed/adopted again. A successful call
   * (recordAvailable) clears the model's strikes — the self-heal path.
   */
  goneStrikes?: Record<string, { strikes: number; lastAt: number }>;
}

export function emptyStore(): CooldownStore {
  return { version: 1, models: {}, goneStrikes: {} };
}

// ── Pure core ──────────────────────────────────────────────────────────

/** Transient backoff ladder: 30s → 60s → 120s → 240s, capped at 5 min. */
const TRANSIENT_BASE_MS = 30_000;
const TRANSIENT_CAP_MS = 300_000;
/** A model the router can't reach at all is worth re-probing about hourly. */
const GONE_MS = 3_600_000;


/** "gone" verdicts at or above this evict the model from reconcile re-adoption. */
export const GONE_EVICT_STRIKES = 3;
/** Strikes older than this stop counting (the model gets a fresh re-probe window). */
export const GONE_EVICT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// TRDD-W9XLU1HD AC3 — persisted eviction of a repeatedly-dead free model.
// A one-off "gone" verdict self-heals through the hourly cooldown already;
// but a model OpenRouter still LISTS yet rejects every call with a 403/404
// re-enters free_models on every reconcile pass and burns a chunk on it
// every run (the card's original incident: 295 failed session-summary
// chunks across 3 still-listed dead models). The cure: count "gone"
// verdicts per model ACROSS runs in the persisted store. N = 3 matches
// PERSISTENCE_MIN_CONSECUTIVE (model-events.ts) — the codebase's own
// established "3 identical failures = settled fact, not a wobble" bar;
// one or two verdicts still heal via the 1h cooldown alone. 7 days for the
// re-probe expiry mirrors REPROBE_AFTER_MS (default-profiles.ts): long
// enough that a churny catalog doesn't re-adopt a dead model on the next
// sweep, short enough that a genuinely restored model is back within a
// week without operator action.

/**
 * Classify an error string, or return null when it is NOT an availability
 * failure (a real bug, a 400, a schema violation) — in which case the caller
 * must NOT rotate: swapping models would only hide the defect.
 *
 * This is the SINGLE source of truth for "should we rotate?"; index.ts's
 * isModelUnavailableError() delegates to it so the two can never drift.
 */
export function classifyUnavailable(
  detail: string,
  opts: { credentialProvenGoodElsewhere?: boolean } = {},
): UnavailableKind | null {
  const s = (detail || "").toLowerCase();

  // WHY: a 401 is a bad/revoked key, never a verdict on THIS model — the 403
  // block below and the "not found" match both state a 401 is never rotated
  // past. Without this guard OpenRouter's real 401 body "User not found."
  // matched s.includes("not found") and returned "gone", so a dead key walked
  // and cooled every free model (TRDD-8GE0OJ5R). Same prefix anchor as
  // STATUS_CODE_RE: only our own send path's `API error 401` / `HTTP 401`.
  if (/\b(?:api error|http)\s+401\b/.test(s)) return null;

  // The circuit breaker's verdict is GLOBAL, never per-model — checked FIRST
  // because its abort text also contains "overloaded", which the transient
  // branch below would match. That match is exactly how the 2026-08-04
  // livelock ran: a tripped breaker aborts every call instantly, the abort was
  // classified "transient", the model got a 30s cooldown, rotation moved to
  // the next model, which insta-aborted too — the whole pool cycled through
  // 30s cooldowns forever while zero requests went out. Rotating within the
  // same provider cannot outrun a provider-wide verdict; hand the error back
  // so the caller fails fast with the breaker's own message.
  if (s.includes("server issue detected")) {
    return null;
  }

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

  // A 403 is the provider refusing THIS integration access to THIS model. It
  // belongs with the other policy refusals already here ("no endpoints found
  // matching your data policy" is a 403 that this branch has always caught by
  // its text) — the only difference is the phrasing, so classifying it by the
  // code closes the gap for providers that do not say "no endpoints".
  //
  // Why this is safe to ROTATE on, and why it must not be null: a 403 is never
  // a request-shape bug (400) and never a missing/invalid credential (401), so
  // rotating past it cannot hide the one error the user needs to see — the
  // negative that the "REAL defect" test pins. Measured 2026-08-29 on
  // `thinkingmachines/inkling:free`: HTTP 403 "is only available on agentic
  // harnesses". Without this branch classifyUnavailable returned null and the
  // whole call FAILED HARD instead of rotating to the next free model, for
  // every one of its 8 call sites (TRDD-V32LB992).
  //
  // "gone" (not a denylist, not a permanent eviction) is the right horizon: the
  // hourly re-probe self-heals the day access is granted, and it keeps the pool
  // list honest instead of encoding an account-specific fact into settings that
  // model-reconcile would re-adopt anyway.
  //
  // STATUS_CODE_RE anchors on the KNOWN PREFIX our own send path always uses —
  // `API error ${res.status} (${backend.type}): ...` (provider/completion.ts)
  // or `HTTP ${status}` (model-events.ts, security_scan/judge.ts) — never a
  // bare substring/word-boundary match on the digits alone. A bare \bNNN\b
  // (tried and reverted, w4/TRDD send-path cleanup) still matches a token
  // count that happens to equal the status code, e.g. "limit exceeded (1404
  // tokens)" or "context limit exceeded (410 tokens over)" — both would be
  // misread as the model being gone instead of a transient token-limit
  // message. Anchoring on the prefix closes that gap while still matching
  // every real 404/410 our own send path produces — the code is always
  // present and always delimited right after "api error " or "http ".
  //
  // \b403\b, not includes("403"): a bare substring also matches a token count
  // like "1403", and this branch runs BEFORE the transient one, so
  // "limit exceeded (1403 tokens)" would be misread as gone and sidelined for
  // an hour instead of retried in 30s.
  // 401/403 are ambiguous: a bad/revoked API key returns the SAME code for
  // every model, so treating ANY bare 403 as "this model is gone" would mark
  // a whole healthy pool unusable on one credential problem (P2 amendment,
  // 2026-09-16, TRDD-90DM5YHO). Only classify "gone" when the body names
  // THIS model specifically — the phrasings OpenRouter actually uses when a
  // model (not the key) is the problem — OR (below) the caller has already
  // proven this credential good on a DIFFERENT model this run. A bare/generic
  // 403 with neither falls through to `null` below: the caller does not
  // rotate, does not mark anything unusable, and the original auth error
  // surfaces unchanged — exactly what should happen when the key, not the
  // model, is broken. "no endpoints" / "no allowed providers" / "not found" /
  // STATUS_CODE_RE(404) are NOT gated the same way: those already identify a
  // routing failure for THIS model id, they can't be a generic account-wide
  // auth message.
  const modelSpecific403 =
    /\b403\b/.test(s) &&
    (s.includes("only available") ||
      s.includes("agentic harnesses") ||
      s.includes("not available for free") ||
      s.includes("unavailable for free"));
  // A bare/generic 403 (no model-specific phrasing) is ambiguous ON ITS OWN —
  // a bad/revoked key returns the same code for every model. But when the
  // caller has already proven THIS credential good this run (it completed a
  // DIFFERENT model successfully — see markCredentialSucceeded /
  // credentialSucceededOnOtherModel below and completion.ts's wiring at the
  // success-return point and the error-handling gate), the key is ruled out,
  // so a generic 403 can only be about THIS model. Opt-in via `opts`, never
  // the default, so every OTHER caller of classifyUnavailable (applyUnavailable,
  // callWithFreeRotation, session_summary/driver.ts) is unaffected until it is
  // deliberately wired to pass the flag.
  // TRDD-W9XLU1HD coordinator mitigation (2026-10-04): N=2 DISTINCT models
  // rejecting with a generic 403 in the SAME run also rules the key out — a
  // bad key returns 403 for every model, but it does so on the FIRST model
  // tried; by the time TWO different ids have both refused with no model-
  // specific phrasing, the refusal tracks the pool, not one credential or one
  // model. Marking from the second distinct model onward is deliberately
  // conservative: ONE generic 403 stays non-evicting (a single novel-wording
  // refusal could still be an account state on one model), so a false mark
  // requires two independent 403s — and a wrongly-marked model heals through
  // the hourly "gone" re-probe anyway. N=2, not 3: at 2+ the run has already
  // burned a round-trip on a second dead id; waiting for a third just spends
  // another chunk of the pool discovering what two refusals already show.
  const generic403 = /\b403\b/.test(s) && !modelSpecific403;
  const genericThisCredentialProvenGood = generic403 && opts.credentialProvenGoodElsewhere === true;
  const genericDistinct403Quorum = generic403 && generic403DistinctModels.size >= POOL_403_QUORUM;
  // 410 ("Gone") is unambiguous by HTTP definition — unlike 403/401, a
  // provider never returns 410 to mean "your key is bad"; it means THIS
  // resource (the model id) is permanently retired. So it needs no
  // model-specific-phrasing gate, unlike modelSpecific403 above (P2 review
  // finding, 2026-09-16: without this a 410 skipped same-model retry in
  // completion.ts's deterministic4xx gate but was never classified "gone",
  // so it was never persisted/marked run-unusable either — retried forever
  // on the NEXT overall attempt with no memory it was ever dead).
  const STATUS_CODE_RE = /\b(?:api error|http)\s+(404|410)\b/;
  if (
    s.includes("no endpoints") ||
    s.includes("no allowed providers") ||
    s.includes("not found") ||
    STATUS_CODE_RE.test(s) ||
    modelSpecific403 ||
    genericThisCredentialProvenGood ||
    genericDistinct403Quorum
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
  knownKind?: UnavailableKind,
  // Round C0b item 3 (B7): an explicit cooldown horizon — the provider own
  // Retry-After (err.retryAt) — that raises the computed `until` for a
  // "transient" verdict. Ignored for "gone"/"daily-quota" (a future caller
  // must not extend those verdicts with a rate-limit horizon).
  until?: number,
): CooldownStore {
  const prev = store.models[modelId];
  // `knownKind` is the verdict the CALLER already knows to be true for this
  // model (read from the run-unusable registry via `runUnusableKind`) — used
  // only when `detail` itself does not self-classify (a corroborated bare
  // 403, or a synthetic "already proven dead" message with no model-specific
  // phrasing). A real kind cannot clobber correctly, so unlike the OLD
  // `!prev && isRunUnusable(modelId) ? "gone" : null` fallback it replaces,
  // there is no need to gate on `!prev`: that old gate also blocked renewing
  // an EXPIRED "gone" entry (review finding, 2026-09-18, TRDD-W9XLU1HD).
  const kind = classifyUnavailable(detail) ?? knownKind ?? null;
  if (!kind) return store;
  // Strikes only accumulate while the previous cooldown is still in force; a
  // model that has been healthy since its last 429 starts the ladder again.
  const strikes =
    prev && prev.kind === "transient" && prev.until > nowMs ? prev.strikes + 1 : 1;
  return {
    version: 1,
    models: {
      ...store.models,
      [modelId]: {
        // Max-then-min (round C0b item 3, B7): raise a "transient" cooldown to
        // the provider own retryAt, THEN cap the merged value at 24 h from now
        // so a malformed provider value cannot bury a model for days.
        until:
          kind === "transient" && until !== undefined
            ? Math.min(Math.max(computeCooldownUntil(kind, strikes, nowMs), until), nowMs + 86_400_000)
            : Math.min(computeCooldownUntil(kind, strikes, nowMs), nowMs + 86_400_000),
        kind,
        strikes,
        detail: (detail || "").split("\n")[0].slice(0, 200),
      },
    },
    // AC3: eviction strikes live beside the cooldowns and are bumped only by
    // recordUnavailable (bumpGoneStrike) — never here.
    goneStrikes: store.goneStrikes ?? {},
  };
}

/** Clear a model's cooldown — called on a success, so recovery is immediate. */
export function clearCooldown(store: CooldownStore, modelId: string): CooldownStore {
  if (!store.models[modelId]) return store;
  const models = { ...store.models };
  delete models[modelId];
  // AC3: strikes are cleared separately (clearGoneStrikes, from
  // recordAvailable — the only success path). A manual cooldown clear must
  // not silently reset the eviction count.
  return { version: 1, models, goneStrikes: store.goneStrikes ?? {} };
}

/** Drop entries whose cooldown has expired (keeps the persisted file small). */
export function pruneExpired(store: CooldownStore, nowMs: number): CooldownStore {
  const models: Record<string, Cooldown> = {};
  for (const [id, cd] of Object.entries(store.models)) {
    if (cd.until > nowMs) models[id] = cd;
  }
  // AC3: strike records are intentionally NOT pruned here — their own TTL
  // (GONE_EVICT_TTL_MS, checked in goneEvictedModels) governs expiry, and
  // pruning them on the cooldown's shorter horizon would reset the count
  // while the 1h cooldown cycles.
  return { version: 1, models, goneStrikes: store.goneStrikes ?? {} };
}


// ── AC3 persisted eviction strikes (TRDD-W9XLU1HD) ─────────────────────

/** Increment the model's persisted "gone" strike count, restarting the count
 *  at 1 when the previous record is older than GONE_EVICT_TTL_MS (a windowed
 *  threshold, not a lifetime one — same reasoning as recordNoContentStrike).
 *  Pure: returns a new store. */
function bumpGoneStrike(
  store: CooldownStore,
  modelId: string,
  nowMs: number,
): CooldownStore {
  const strikes = store.goneStrikes ?? {};
  const prev = strikes[modelId];
  const withinWindow = prev !== undefined && nowMs - prev.lastAt <= GONE_EVICT_TTL_MS;
  return {
    ...store,
    goneStrikes: {
      ...strikes,
      [modelId]: { strikes: withinWindow ? prev.strikes + 1 : 1, lastAt: nowMs },
    },
  };
}

/** Clear the model's strike record — the heal path on a successful call.
 *  Read-first: no write when there is nothing to clear. */
function clearGoneStrikes(store: CooldownStore, modelId: string): CooldownStore {
  if (!store.goneStrikes || !store.goneStrikes[modelId]) return store;
  const strikes = { ...store.goneStrikes };
  delete strikes[modelId];
  return { ...store, goneStrikes: strikes };
}

/** Models whose persisted "gone" strikes are at/over GONE_EVICT_STRIKES and
 *  whose last strike is still inside GONE_EVICT_TTL_MS — reconcile must not
 *  re-adopt these into free_models (computeReconcile consumes this). Expired
 *  records (lastAt past the TTL) do NOT evict: that is the re-probe window
 *  through which a genuinely restored model returns. */
export function goneEvictedModels(nowMs: number = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const [id, rec] of Object.entries(getCooldownStore(nowMs).goneStrikes ?? {})) {
    if (nowMs - rec.lastAt >= GONE_EVICT_TTL_MS) continue; // expired — may return
    if (rec.strikes >= GONE_EVICT_STRIKES) out.add(id);
  }
  return out;
}

export function isCooling(store: CooldownStore, modelId: string, nowMs: number): boolean {
  const cd = store.models[modelId];
  return !!cd && cd.until > nowMs;
}

// ── This-run-only "proved dead" registry (design §3.1 point 3, §5) ──────
//
// A cooldown (above) is a PERSISTED, cross-process heuristic with an expiry.
// This is the opposite: in-process-only, filled the instant a "gone"/
// "daily-quota" verdict is reached for THIS run (recordUnavailable below,
// and provider/completion.ts's own retry-skip gate), so every subsequent
// free-model pick in THIS process skips a model it already proved dead
// instead of re-learning the same fact over an HTTP round-trip. Never
// persisted, never crosses a process boundary — cleared only by process exit
// or resetRunUnusableForTests() (module state persists across tests in the
// SAME vitest file since vitest isolates per FILE, not per test).
const runUnusable = new Map<string, UnavailableKind>();

// TRDD-W9XLU1HD coordinator mitigation: the distinct generic-403 ids seen
// THIS run. noteGeneric403Model() records the caller's model id when it
// reports a bare 403 (completion.ts's error gate and session_summary's
// classifyModelFallback path); once >= POOL_403_QUORUM distinct ids are in
// the set, classifyUnavailable treats a further generic 403 as "gone".
// In-process only — same lifetime as runUnusable above.
export const POOL_403_QUORUM = 2;
const generic403DistinctModels = new Set<string>();

/** Record that `modelId` was refused with a bare/generic 403 this run. */
export function noteGeneric403Model(modelId: string): void {
  if (modelId) generic403DistinctModels.add(modelId);
}

/** Test hook — clear the distinct-403 set (module state persists per FILE). */
export function resetGeneric403ForTests(): void {
  generic403DistinctModels.clear();
}

/** Record that `id` failed with a run-scoped-dead verdict this run, carrying
 *  WHICH verdict — a bare boolean lost the reason, forcing every later
 *  caller to guess "gone" regardless of the real kind (S3, TRDD-W9XLU1HD:
 *  `kind` is now required — the old default silently misreported daily-quota
 *  verdicts as "gone" for any caller that forgot to pass it). */
export function markRunUnusable(id: string, kind: UnavailableKind): void {
  runUnusable.set(id, kind);
}

/** The verdict kind recorded for `id` this run, or `undefined` if it was
 *  never marked — the typed counterpart to `isRunUnusable`, so a caller that
 *  needs to know WHY (not just whether) reads the real kind instead of
 *  re-guessing "gone" (TRDD-W9XLU1HD review). */
export function runUnusableKind(id: string): UnavailableKind | undefined {
  return runUnusable.get(id);
}

/** True once `markRunUnusable(id)` fired this run. */
export function isRunUnusable(id: string): boolean {
  return runUnusable.has(id);
}

/** Test hook — every test file that touches runUnusable must reset it in
 *  afterEach, or a later test inherits a dirty set. */
export function resetRunUnusableForTests(): void {
  runUnusable.clear();
}

// ── Per-credential run-success registry (TRDD-90DM5YHO item 1) ──────────
//
// A generic 403 (no model-specific phrasing) is ambiguous: it could mean THIS
// model is gone, or the API key is bad/revoked (which returns the same code
// for every model). We can tell them apart within one process: if this
// credential has already completed a chat successfully on a DIFFERENT model
// this run, the key is proven good, so a later generic 403 on model X can
// only be about X. Fingerprint is `${backendType}:${baseUrl}:${sha256(apiKey)
// .slice(0, 12)}` — the credential's SHAPE, never the raw key. baseUrl is
// included (review finding, 2026-09-16) so two same-typed backends pointing
// at DIFFERENT endpoints (a proxy vs. the real API, two openrouter-compatible
// hosts reusing the same key shape) never collide into one fingerprint — a
// key proven good against one service says nothing about another. A falsy
// apiKey (unset/empty) is treated as "no credential" and never marked or
// matched, so every keyless backend of the same type/url does not silently
// collide into a single shared fingerprint. In-process only, same lifetime as
// runUnusable above; cleared only by process exit or the test reset hook.
const credentialSucceededModels = new Map<string, Set<string>>();

function credentialFingerprint(backendType: string, baseUrl: string, apiKey: string): string {
  return `${backendType}:${baseUrl}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`;
}

/** Record that `modelId` completed a chat successfully on this credential this run. */
export function markCredentialSucceeded(
  backendType: string,
  baseUrl: string,
  apiKey: string,
  modelId: string,
): void {
  if (!apiKey) return; // no credential to fingerprint — nothing to remember
  const fp = credentialFingerprint(backendType, baseUrl, apiKey);
  let models = credentialSucceededModels.get(fp);
  if (!models) {
    models = new Set();
    credentialSucceededModels.set(fp, models);
  }
  models.add(modelId);
}

/**
 * True once this credential has succeeded on a model OTHER than `modelId`
 * this run — the discriminator classifyUnavailable's `opts.
 * credentialProvenGoodElsewhere` expects. A success on the SAME model does
 * NOT count (the key could have been revoked mid-run right after).
 */
export function credentialSucceededOnOtherModel(
  backendType: string,
  baseUrl: string,
  apiKey: string,
  modelId: string,
): boolean {
  if (!apiKey) return false; // no credential to fingerprint — never proven good
  const fp = credentialFingerprint(backendType, baseUrl, apiKey);
  const models = credentialSucceededModels.get(fp);
  if (!models) return false;
  for (const id of models) {
    if (id !== modelId) return true;
  }
  return false;
}

/** Test hook — every test file that touches this registry must reset it. */
export function resetCredentialSuccessForTests(): void {
  credentialSucceededModels.clear();
}

// ── Durable runtime verdict — lazy, capped-window cache over model-events.log ──
//
// model-events.log is unbounded (can reach MB scale on a long-lived server);
// re-reading and re-parsing the WHOLE file on every free-model selection would
// make each pick's cost scale with total log size instead of with the ~24h
// window assessModelPersistence actually needs. This loads it ONCE per
// process, keeps only events inside the persistence window, and is updated
// incrementally (not re-read from disk) when THIS process appends its own
// event via noteOwnModelEvent().
let recentEventsCache: ModelEvent[] | null = null;

function recentModelEvents(nowMs: number): ModelEvent[] {
  if (!recentEventsCache) {
    const cutoff = nowMs - PERSISTENCE_WINDOW_HOURS * 3_600_000;
    recentEventsCache = readModelEvents().filter((ev) => {
      const at = parseEventTimestamp(ev.timestamp);
      return at !== null && at >= cutoff;
    });
  }
  return recentEventsCache;
}

/**
 * Call right after appendModelEvent() for a THIS-PROCESS failure so the
 * cached window picks it up without a re-read. A no-op before the first
 * unusableModelIds()/isUnusable() call in this process — the next lazy load
 * reads it off disk like everything else, so nothing is lost, only deferred.
 */
export function noteOwnModelEvent(ev: ModelEvent): void {
  if (recentEventsCache) recentEventsCache.push(ev);
}

/** Test hook — forces the next call to re-read the log from disk. */
export function resetRecentModelEventsCacheForTests(): void {
  recentEventsCache = null;
}

/**
 * The union every unusability check reads (design §5): a recorded FAILING
 * benchmark, a durable runtime verdict (≥3 trailing rotate-worthy failures in
 * 24h), or a this-run "proved dead" mark. Same answer everywhere it's called,
 * so a model one reader considers unusable can't be re-adopted by another.
 */
export function unusableModelIds(nowMs: number = Date.now()): Set<string> {
  const out = new Set<string>(benchmarkFailedModels());
  for (const [id] of assessModelPersistence(recentModelEvents(nowMs), { now: new Date(nowMs) })) {
    out.add(id);
  }
  for (const id of runUnusable.keys()) out.add(id);
  return out;
}

export function isUnusable(id: string, nowMs: number = Date.now()): boolean {
  return unusableModelIds(nowMs).has(id);
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
    // A this-run "proved dead" model (markRunUnusable) is deferred exactly
    // like a cooling one, not dropped — invariant (2) above: a wrong signal
    // can only reorder attempts, never remove a model from the rotation.
    if (isCooling(store, c.id, nowMs) || isRunUnusable(c.id)) deferred.push(c);
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
      // AC3 (TRDD-W9XLU1HD): carry the persisted strike records through —
      // dropping them here would silently reset every model's eviction
      // count on every process restart, making the eviction never fire.
      return { version: 1, models: parsed.models, goneStrikes: parsed.goneStrikes ?? {} };
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
  } catch (err) {
    // Persistence stays best-effort (an unwritable config dir must never fail
    // a live tool call) but must never be INVISIBLE again — T1 (TRDD-W9XLU1HD)
    // reproduced free-cooldowns.json silently never being created on a clean
    // host with zero signal anywhere. One stderr line, not a throw.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[llm-externalizer] free-cooldowns.json write failed: ${msg}\n`);
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
  // Round C0b item 3 (B7): the provider own Retry-After horizon, passed only
  // by the rotation Retry-After refusal site; every other caller keeps the
  // default (undefined) behaviour.
  until?: number,
): void {
  // S1 fix (review of 527d5e8, TRDD-W9XLU1HD): only fall back to the
  // registry verdict when no cooldown is currently in force for this model.
  // Passing runUnusableKind(modelId) UNCONDITIONALLY meant every later
  // AMBIGUOUS error on an already-marked model (a timeout, a 5xx, a parse
  // error, or the synthetic "already verified unavailable this run" message)
  // re-ran applyUnavailable with a freshly computed cooldown, rewriting
  // free-cooldowns.json and bumping strikes even though the existing verdict
  // was still valid. isCooling(store, id, nowMs) is exactly "an entry exists
  // and has not expired" -- the same test as "entry in force".
  const before = getCooldownStore(nowMs);
  const knownKind = isCooling(before, modelId, nowMs) ? undefined : runUnusableKind(modelId);
  const after = applyUnavailable(before, modelId, detail, nowMs, knownKind, until);
  if (after === before) return;
  // A persisted "gone"/"daily-quota" verdict is also a this-run "proved dead"
  // fact (design §3.1 point 3). Every caller of recordUnavailable — this
  // module's own rotation loops (callWithFreeRotation, rotateOverFreeIds) AND
  // session_summary/driver.ts's transition handlers (advanceModel,
  // applyFanoutTransition) — funnels through here, so this is the ONE place
  // that keeps the cross-process cooldown and the in-process runUnusable
  // registry from ever disagreeing about what "gone"/"daily-quota" means.
  const kind = after.models[modelId]?.kind;
  if (kind === "gone" || kind === "daily-quota") markRunUnusable(modelId, kind);
  // TRDD-W9XLU1HD AC3: only a "gone" verdict earns an eviction strike — a
  // daily-quota model is healthy tomorrow by design, never evictable.
  let withStrikes = after;
  if (kind === "gone") withStrikes = bumpGoneStrike(after, modelId, nowMs);
  cache = withStrikes;
  writeStoreToDisk(withStrikes);
}

/** Record a success — a model that answers is available, whatever we believed.
 *  Also clears any AC3 eviction strikes: the self-heal path (a successful
 *  call is the strongest possible counter-evidence to "gone"). */
export function recordAvailable(modelId: string, nowMs: number = Date.now()): void {
  const before = getCooldownStore(nowMs);
  const healed = clearGoneStrikes(before, modelId);
  const after = clearCooldown(healed, modelId);
  if (after === healed && after === before) return;
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
  // `until` — the optional provider Retry-After horizon (round C0b item 3,
  // B7); callers that do not pass it keep the default behaviour.
  recordUnavailable: (id: string, detail: string, now: number, until?: number) => void;
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
    recordUnavailable: (id, detail, now, until) => {
      s = applyUnavailable(s, id, detail, now, undefined, until);
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
  /** The dispatch's shared retry clock (TRDD-YG72CYY7). Once its window is
   *  closed no further candidate is started. */
  retryClock?: RetryClock;
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
  // Newest failure seen (thrown error or failure value): the cause when the
  // shared clock closes under a model that failed with its own plain error.
  let lastThrown: unknown;

  for (;;) {
    // The clock is the dispatch's whole retry budget: once closed, no candidate
    // (not even the first) may start, or it would only end in a RetryDeadlineError
    // with no request of its own.
    const clock = hooks.retryClock;
    if (clock && retryWindowClosed(clock)) {
      // Round C0b item 2 (B5): the cause is FOREIGN only when the rotation has
      // no failure of its own to attach (no lastThrown). When it IS the
      // rotation own lastThrown, the status comes from the cause text
      // ("API error NNN" parse — same fallback rule as completion.ts) and the
      // provider falls back to the clock, then the constructor default.
      const cause = lastThrown ?? clock.lastError;
      const causeText = cause === undefined ? undefined : cause instanceof Error ? cause.message : String(cause);
      const causeStatus =
        lastThrown === undefined
          ? clock.lastStatus
          : Number(/API error (\d{3})\b/.exec(causeText ?? "")?.[1]) || clock.lastStatus;
      throw new RetryDeadlineError(
        {
          attempts: clock.attempts ?? 0,
          elapsedMs: Date.now() - (clock.startedAt ?? Date.now()),
          lastStatus: causeStatus,
          lastProvider: clock.lastProvider,
        },
        cause,
        undefined,
        true,
        lastThrown === undefined,
      );
    }
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
    let refusalUntil: number | undefined;
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
      // First line, capped: a failure VALUE can be a whole partial answer plus
      // its upstream-error tail, and it would flow unbounded into a deadline
      // error's cause text.
      lastThrown = failure.split("\n")[0].slice(0, 300);
    } catch (err) {
      // WHY rethrown untouched, before any recording or rotation, ONLY when
      // `dispatchClosed`: the clock is the dispatch's whole retry budget, and
      // such an error may come from a model that made no request of its own
      // (another slot closed the window). Recording it would put cooldowns on
      // untried models, and rotating would only hand the next model a closed
      // window. A deadline error with dispatchClosed false is one model's own
      // Retry-After beyond the window: the window is still open and that 429 is
      // an availability error, so it falls through to the classification below
      // (cooldown for that model, next model tried).
      if (err instanceof RetryDeadlineError && err.dispatchClosed) throw err;
      lastThrown = err;
      // failureText: a RetryDeadlineError's own message is neutral; its cause
      // carries the availability text classifyUnavailable must read to rotate.
      const msg = failureText(err);
      // A payment error also advances (D1): the free pool IS this profile's
      // chain, and the USER's rule is "skip to the next provider". The
      // completion layer below already spent the one same-model retry an
      // uncertain one gets. It is not an availability verdict, so
      // recordUnavailable below writes no cooldown of its own for it (a model
      // already proven dead this run keeps that verdict, as for any error).
      if (!classifyUnavailable(msg) && paymentErrorCertainty(msg) === null) throw err;
      detail = msg;
      // refusalUntil: set ONLY in the catch (a refusal thrown by the call);
      // a failure VALUE carries no retryAt, so it stays undefined on that path.
      if (err instanceof RetryDeadlineError && err.retryAt !== undefined && !err.dispatchClosed) {
        refusalUntil = err.retryAt;
      }
    }

    lastDetail = detail;
    // Round C0b item 3 (B7): a refusal (dispatchClosed false) with a
    // provider-supplied retryAt cools the model at least until retryAt — the
    // generic 30 s ladder would have the rotation re-trying it at once on the
    // next file, burning an instant 429 per file. The 24 h cap on the merged
    // value lives in applyUnavailable (max-then-min).
    store.recordUnavailable(cur.id, detail, now(), refusalUntil);
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

// registerAutoFreeEngage() DELETED (TRDD-OE27RD7I 14.1-C2c-ENV): this seam
// used to let a leaf module trigger a session-wide paid->free switch on a
// mid-command 402 (see withFreeRotation's now-deleted PAID-mode branch).
// That switch is forbidden, no exceptions (addendum 4) — it had been kept
// as a no-op export because index.ts's own boot-time call site was outside
// an earlier phase's file set; index.ts (this phase's file set) deleted
// engageAutoFree and that call site together, so the seam has zero callers
// anywhere now and is gone, not just unused.

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
  /** Whether free mode is active. Defaults to the global free_only flag —
   *  the profile's own static shape, or the allow_paid_models master switch;
   *  never an automatic engagement (engageAutoFree was deleted outright,
   *  TRDD-OE27RD7I addendum 4). */
  freeActive?: () => boolean;
  now?: () => number;
  store?: RotationStore;
  onRotate?: (from: string, to: string, detail: string) => void;
  // `onCreditExhausted` DELETED (TRDD-OE27RD7I 14.1-C2c-ENV): withFreeRotation's
  // PAID-mode 402 branch that used to consult it was already deleted --
  // paid->free is forbidden, no exceptions -- and its last caller (an
  // existing test passing the hook) has been updated to stop passing it, so
  // the dead field itself is gone too.
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
 *  Under FREE mode, a request pinning a rate-limited ':free' model is
 *  transparently re-sent against the next APPROVED free model, until one
 *  answers or the whole approved pool has been tried — all within the
 *  active (free) profile's own pool.
 *
 * Under PAID mode every request is sent as-is, unconditionally — including a
 * 402. A 402 here used to engage session-wide free and complete the call on
 * the rotating free pool (the direct-HTTP twin of the completion layer's
 * 402 catch, deleted from chatCompletionWithRetry the same phase); that was
 * a paid->free cross-profile borrow, and TRDD-OE27RD7I addendum 4 (USER, no
 * exceptions) forbids it, so it is gone: the caller's own fail-safe path now
 * sees the honest 402.
 *
 * Inert (pass-through) in the safe cases: a paid call under paid mode; a body
 * with no model (catalog/pricing GETs); and a non-availability failure
 * (400/bad-key/schema), which is handed back as-is so a real defect is never
 * masked by rotating the whole pool. A free-mode request pinning a PAID model
 * is NOT passed through — it is served from the free pool, because the only
 * way it occurs is a mid-job auto-free engage (see the branch comment below).
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
    const onRotate = hooks.onRotate ?? logRotation;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return inner(url, init); // not a JSON body we can rewrite — pass through
    }
    const requested = parsed["model"];

    // ── PAID mode: send as-is, always. A 402 (credit exhausted) used to
    // engage session-wide free mode and complete THIS call by rotating over
    // the free pool — a paid->free cross-profile borrow, the direct-HTTP-
    // tools twin of the one deleted from provider/completion.ts's
    // chatCompletionWithRetry. TRDD-OE27RD7I addendum 4 (USER, no
    // exceptions: "no switching to free models ... must exist anymore")
    // forbids it here too, so it is deleted, not reworked: the honest 402
    // now always reaches the caller's own fail-safe path unchanged.
    // `hooks.onCreditExhausted` (FetchRotationHooks) and
    // `registerAutoFreeEngage` are DELETED too (14.1-C2c-ENV) — index.ts's
    // boot-time call site went with engageAutoFree, so nothing calls either
    // seam anymore.
    if (!freeActive()) {
      return inner(url, init);
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
