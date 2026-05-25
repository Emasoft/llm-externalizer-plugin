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
