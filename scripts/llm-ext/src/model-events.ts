/**
 * Durable model-health event ledger (TRDD-828238b5 A1).
 *
 * The runtime already DETECTS and mitigates per-call model problems
 * (unsupported-param drops, reasoning-effort downgrades, 429 streaks,
 * schema healing, truncation retries, empty responses, non-retryable
 * failures). Those signals were previously per-session / in-memory only and
 * lost on `reset` / restart, so they could not inform a DURABLE health
 * decision.
 *
 * This module persists those events as a flat, append-only, human-readable
 * sibling of `history.log`, keyed by model id, plus a PURE reader/aggregator
 * that turns the raw events into a per-model health summary. It is the
 * foundation the `check_model_health` self-check (A2) and the auto-replacement
 * loop (A7) build on.
 *
 * Line format (4 fields, " - " separated; detail may itself contain " - "):
 *
 *   <TIMESTAMP> - <MODEL> - <KIND> - <DETAIL>
 *
 * - TIMESTAMP  local ISO + GMT offset, `YYYY-MM-DDTHH:MM:SS±HHMM` (sortable,
 *              reuses usage-history's localIsoTimestamp for a single spelling).
 * - MODEL      the model id the event is about (sanitized: no " - ").
 * - KIND       one of ModelEventKind (a closed enum; safe, no " - ").
 * - DETAIL     short, secret-redacted, truncated context (may be empty).
 *
 * Writing is best-effort: any disk failure is swallowed so it can NEVER break
 * or slow the actual LLM work (same contract as usage-history.ts).
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir } from "./config.js";
import { redactSecrets } from "./security_scan/intake.js";
import { localIsoTimestamp } from "./usage-history.js";

/** Closed set of model-health event kinds emitted by the runtime mitigations. */
export type ModelEventKind =
  | "param_drop" // a request field was dropped (model lacks supported_parameters)
  | "reasoning_downgrade" // reasoning effort downgraded after a 400/422 rejection
  | "rate_limit_429" // a 429 was observed for this model (AIMD halved RPS)
  | "schema_heal" // a non-conforming JSON response had to be repaired
  | "truncation_retry" // a truncated response triggered a continuation retry
  | "empty_response" // the model returned an empty body
  | "non_retryable_failure"; // a 4xx (non-429) / unrecoverable error for this model

/** Every legal kind, for validation + exhaustive zero-initialisation. */
export const MODEL_EVENT_KINDS: readonly ModelEventKind[] = [
  "param_drop",
  "reasoning_downgrade",
  "rate_limit_429",
  "schema_heal",
  "truncation_retry",
  "empty_response",
  "non_retryable_failure",
] as const;

const KIND_SET = new Set<string>(MODEL_EVENT_KINDS);

/** A single parsed model-health event. */
export interface ModelEvent {
  timestamp: string;
  model: string;
  kind: ModelEventKind;
  detail: string;
}

/** Max characters kept from the detail field before truncation. */
const MAX_DETAIL = 160;

/** Absolute path of the model-events log. Honors LLM_EXT_CONFIG_DIR via getConfigDir(). */
export function getModelEventsPath(): string {
  return join(getConfigDir(), "model-events.log");
}

/** Replace the field separator inside a value so it cannot corrupt the line shape. */
function sanitizeField(s: string): string {
  return s.replace(/ - /g, " | ").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Append one model-health event. Best-effort: any failure (unwritable dir,
 * full disk, EACCES) is swallowed so logging can NEVER break the tool call.
 * POSIX O_APPEND makes a single sub-PIPE_BUF line write atomic across
 * processes.
 */
export function appendModelEvent(
  model: string,
  kind: ModelEventKind,
  detail = "",
): void {
  try {
    const safeModel = sanitizeField(String(model || "unknown"));
    let safeDetail = redactSecrets(String(detail ?? "")).redacted.replace(/[\r\n]+/g, " ").trim();
    if (safeDetail.length > MAX_DETAIL) {
      safeDetail = safeDetail.slice(0, MAX_DETAIL - 1) + "…";
    }
    const line = `${localIsoTimestamp()} - ${safeModel} - ${kind} - ${safeDetail}`;
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(getModelEventsPath(), line + "\n", { flag: "a" });
  } catch {
    // Fail-open on LOGGING only — never on the actual work.
  }
}

/**
 * Parse a single model-events line. Returns null for blank / malformed lines
 * (so a partially-written tail line never crashes a read). The detail field is
 * everything after the 3rd " - ", so a detail containing " - " round-trips.
 */
export function parseModelEventLine(line: string): ModelEvent | null {
  // Strip ONLY a trailing newline/CR — not all whitespace — because an empty
  // detail is written as "ts - model - kind - " (a trailing space after the
  // last separator). A full trim would eat that space and break the parse.
  const stripped = line.replace(/[\r\n]+$/, "");
  if (!stripped.trim()) return null;
  const parts = stripped.split(" - ");
  if (parts.length < 3) return null;
  const [timestamp, model, kind] = parts;
  if (!timestamp || !model || !KIND_SET.has(kind)) return null;
  return {
    timestamp,
    model,
    kind: kind as ModelEventKind,
    detail: parts.slice(3).join(" - "),
  };
}

/**
 * Read parsed events from the ledger. Best-effort: returns [] if the file is
 * missing or unreadable. `limit` keeps only the most recent N events (the tail),
 * which is what every consumer wants (recent health, not all history).
 */
export function readModelEvents(opts: { limit?: number; path?: string } = {}): ModelEvent[] {
  let raw: string;
  try {
    raw = readFileSync(opts.path ?? getModelEventsPath(), "utf-8");
  } catch {
    return [];
  }
  const events: ModelEvent[] = [];
  for (const line of raw.split("\n")) {
    const ev = parseModelEventLine(line);
    if (ev) events.push(ev);
  }
  if (typeof opts.limit === "number" && opts.limit >= 0 && events.length > opts.limit) {
    return events.slice(events.length - opts.limit);
  }
  return events;
}

/** Per-model rolled-up health, derived purely from a window of events. */
export interface ModelHealthSummary {
  model: string;
  total: number;
  byKind: Record<ModelEventKind, number>;
  /** True when the window crossed a degradation threshold (see reasons). */
  degraded: boolean;
  /** Human-readable reasons the model was flagged degraded (empty if healthy). */
  reasons: string[];
}

/** Thresholds for the degraded verdict. All have conservative defaults. */
export interface AggregateOptions {
  /** Non-retryable (4xx-class) failures in the window that flag degraded. Default 3. */
  nonRetryableFailureThreshold?: number;
  /** Empty responses in the window that flag degraded. Default 3. */
  emptyResponseThreshold?: number;
  /** Schema heals in the window that flag degraded (structured-output trouble). Default 5. */
  schemaHealThreshold?: number;
}

function zeroByKind(): Record<ModelEventKind, number> {
  const r = {} as Record<ModelEventKind, number>;
  for (const k of MODEL_EVENT_KINDS) r[k] = 0;
  return r;
}

/**
 * Aggregate a window of events into a per-model health summary. PURE — operates
 * only on the passed-in array, no disk / no clock — so it is fully unit-testable
 * with synthetic events. The `degraded` flag is advisory: A2/A7 decide whether
 * to act (the server never silently swaps a model).
 */
export function aggregateModelHealth(
  events: ModelEvent[],
  opts: AggregateOptions = {},
): Map<string, ModelHealthSummary> {
  const nonRetryableMax = opts.nonRetryableFailureThreshold ?? 3;
  const emptyMax = opts.emptyResponseThreshold ?? 3;
  const schemaHealMax = opts.schemaHealThreshold ?? 5;

  const byModel = new Map<string, ModelHealthSummary>();
  for (const ev of events) {
    let s = byModel.get(ev.model);
    if (!s) {
      s = { model: ev.model, total: 0, byKind: zeroByKind(), degraded: false, reasons: [] };
      byModel.set(ev.model, s);
    }
    s.total += 1;
    s.byKind[ev.kind] += 1;
  }

  for (const s of byModel.values()) {
    if (s.byKind.non_retryable_failure >= nonRetryableMax) {
      s.reasons.push(
        `${s.byKind.non_retryable_failure} non-retryable failures (≥ ${nonRetryableMax})`,
      );
    }
    if (s.byKind.empty_response >= emptyMax) {
      s.reasons.push(`${s.byKind.empty_response} empty responses (≥ ${emptyMax})`);
    }
    if (s.byKind.schema_heal >= schemaHealMax) {
      s.reasons.push(
        `${s.byKind.schema_heal} schema heals (≥ ${schemaHealMax}) — structured-output instability`,
      );
    }
    s.degraded = s.reasons.length > 0;
  }

  return byModel;
}

// ── Persistent-failure verdict — the ROTATION threshold (P1 zero-token pipeline) ──
//
// `aggregateModelHealth` above answers "has this model misbehaved a lot, ever?".
// That is the right question for an ADVISORY per-tool audit, but the WRONG one for
// ROTATION: rotating a model rewrites settings.yaml, so it must fire only on a
// failure that is both PERMANENT and STILL CURRENT. Until now that judgment lived
// in prose — the ensemble-autoselect skill told the agent to eyeball the retry
// history and decide "is this 404 persistent?" — which is exactly the kind of
// judgment that costs agent tokens on every model update. It is a code rule now.
//
// THE RULE: a model is PERSISTENTLY BROKEN iff its most recent
// `non_retryable_failure` events inside a rolling `windowHours` window form a
// TRAILING run of >= `minConsecutive` events that all carry the SAME rotate-worthy
// HTTP status. Every clause is load-bearing:
//
//   * non_retryable_failure ONLY. A 429 (rate_limit_429) is normal on the free tier
//     and a 5xx burst is the provider's problem — neither is fixed by swapping the
//     model, so rotating on them would churn the ensemble on every transient outage.
//   * ROTATE-WORTHY statuses only (see ROTATE_WORTHY_STATUSES). 401/403 mean the API
//     KEY is wrong; rotating the model cannot fix an auth misconfiguration and would
//     silently destroy a working ensemble — so they are deliberately excluded.
//   * SAME status, TRAILING run. This is the code spelling of "same error class,
//     still happening". A model that 404'd three times yesterday but whose LATEST
//     failure is a 400 is not a settled deprecation, and a model whose failure class
//     keeps changing is a provider wobble, not a retirement.
//   * >= 3 within <= 24h. Three is the same bar the skill asked the agent to eyeball
//     ("3+ retries, same error"): one stray 400 from a malformed request must never
//     rotate an ensemble, while three identical ones inside a day is a settled fact.
//     The 24h WINDOW is what makes the verdict current — an old, since-healed failure
//     ages out instead of accumulating forever the way the unwindowed counters above
//     do (that unboundedness is precisely why those counters cannot gate a write).

/**
 * HTTP statuses that mean "THIS MODEL ID is unusable" — the only ones a model swap
 * can actually fix. 400 (the model rejects the request shape we send every other
 * model), 404 (id gone from the catalog — OpenRouter retires ids silently), 410
 * (explicitly retired), 422 (unprocessable for this model). Anything else is an
 * account, network, or provider problem that rotation would not repair.
 */
export const ROTATE_WORTHY_STATUSES: readonly number[] = [400, 404, 410, 422];
const ROTATE_WORTHY = new Set<number>(ROTATE_WORTHY_STATUSES);

/** Rolling window over which failures must be concentrated to count as current. */
export const PERSISTENCE_WINDOW_HOURS = 24;
/** Trailing same-status failures required before a model is declared broken. */
export const PERSISTENCE_MIN_CONSECUTIVE = 3;

export interface PersistenceOptions {
  /** Rolling window in hours. Default PERSISTENCE_WINDOW_HOURS (24). */
  windowHours?: number;
  /** Trailing same-status failures required. Default PERSISTENCE_MIN_CONSECUTIVE (3). */
  minConsecutive?: number;
  /** Injected clock — tests pass a fixed `now` so the window is deterministic. */
  now?: Date;
}

/** One model's rotation verdict, derived purely from a window of ledger events. */
export interface ModelPersistenceVerdict {
  model: string;
  /** True iff the code threshold above is met — the sole rotation trigger. */
  persistentlyBroken: boolean;
  /** The repeated status when broken; null otherwise. */
  httpStatus: number | null;
  /** Length of the trailing same-status failure run inside the window. */
  consecutiveFailures: number;
  windowHours: number;
  /** One-line rationale (goes straight into the report — no agent paraphrase). */
  reason: string;
}

/**
 * Extract the HTTP status a `non_retryable_failure` detail carries. Every write
 * site spells it `HTTP <status>` (provider/completion.ts, security_scan/judge.ts),
 * so this regex IS the ledger's status contract — change one, change the other.
 * Returns null when the detail carries no status (an unclassifiable failure, which
 * therefore never triggers a rotation).
 */
export function parseEventHttpStatus(detail: string): number | null {
  const m = /\bHTTP (\d{3})\b/.exec(detail);
  return m ? Number(m[1]) : null;
}

/**
 * Parse a ledger timestamp (`YYYY-MM-DDTHH:MM:SS±HHMM`) into epoch ms. ECMA-262
 * only GUARANTEES `Date.parse` on the `±HH:MM` spelling, so re-insert the colon
 * rather than relying on engine leniency. Returns null on a malformed stamp; the
 * caller SKIPS such an event — an event we cannot place in time can then only make
 * us LESS likely to rotate, never more (the fail-safe direction for a config write).
 */
export function parseEventTimestamp(ts: string): number | null {
  const ms = Date.parse(ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Apply the rotation threshold to a window of events. PURE — no disk, no ambient
 * clock (pass `now`) — so it is fully unit-testable with synthetic events.
 * Only models that produced at least one in-window, status-carrying
 * `non_retryable_failure` appear in the result; a model absent from the map has
 * nothing rotation-relevant on the ledger and is therefore NOT broken.
 */
export function assessModelPersistence(
  events: readonly ModelEvent[],
  opts: PersistenceOptions = {},
): Map<string, ModelPersistenceVerdict> {
  const windowHours = opts.windowHours ?? PERSISTENCE_WINDOW_HOURS;
  const minConsecutive = opts.minConsecutive ?? PERSISTENCE_MIN_CONSECUTIVE;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error(`assessModelPersistence: windowHours must be > 0, got ${windowHours}`);
  }
  if (!Number.isInteger(minConsecutive) || minConsecutive < 1) {
    throw new Error(`assessModelPersistence: minConsecutive must be a positive integer, got ${minConsecutive}`);
  }
  const cutoff = (opts.now ?? new Date()).getTime() - windowHours * 3_600_000;

  const failuresByModel = new Map<string, { at: number; status: number }[]>();
  for (const ev of events) {
    if (ev.kind !== "non_retryable_failure") continue;
    const at = parseEventTimestamp(ev.timestamp);
    if (at === null || at < cutoff) continue;
    const status = parseEventHttpStatus(ev.detail);
    if (status === null) continue;
    const list = failuresByModel.get(ev.model) ?? [];
    list.push({ at, status });
    failuresByModel.set(ev.model, list);
  }

  const out = new Map<string, ModelPersistenceVerdict>();
  for (const [model, failures] of failuresByModel) {
    // Sort by time: the ledger is append-only and therefore already chronological,
    // but concurrent processes append to it, so do not ASSUME order — the trailing
    // run is only meaningful on a chronologically sorted sequence.
    failures.sort((a, b) => a.at - b.at);
    const latest = failures[failures.length - 1].status;
    let run = 0;
    for (let i = failures.length - 1; i >= 0 && failures[i].status === latest; i--) run++;
    const rotateWorthy = ROTATE_WORTHY.has(latest);
    const persistentlyBroken = rotateWorthy && run >= minConsecutive;
    out.set(model, {
      model,
      persistentlyBroken,
      httpStatus: persistentlyBroken ? latest : null,
      consecutiveFailures: run,
      windowHours,
      reason: persistentlyBroken
        ? `${run} consecutive HTTP ${latest} failures in the last ${windowHours}h (≥ ${minConsecutive}) — permanent model-scoped error`
        : rotateWorthy
          ? `${run} consecutive HTTP ${latest} failure(s) in the last ${windowHours}h (< ${minConsecutive}) — not yet persistent`
          : `latest failure is HTTP ${latest}, not model-scoped (${ROTATE_WORTHY_STATUSES.join("/")}) — a model swap would not fix it`,
    });
  }
  return out;
}
