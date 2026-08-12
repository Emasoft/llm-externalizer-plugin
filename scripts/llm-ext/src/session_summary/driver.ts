/**
 * Map-then-join driver for session-summary — TRDD-T4MZ8YQR P4.
 *
 * Orchestrates the pipeline built in P1-P3: stream + prune the transcript
 * (transcript.ts), pack it into token-budgeted chunks (chunker.ts), then
 *
 *   MAP  — summarize each chunk independently into the nine-section
 *          Claude-Code-compaction-equivalent handoff schema (see
 *          `renderChunkPrompt`).
 *   JOIN — concatenate the per-chunk summaries, in order, with a plain
 *          separator. Deliberately NOT a second model call: the schema's
 *          "All User Messages" section is mandatory-VERBATIM, and an LLM
 *          asked to "merge" nine sections across N summaries is exactly
 *          the failure mode that threatens it — it "tidies" the longest,
 *          most repetitive section first. Concatenation cannot drop or
 *          reword a fact, costs no request, spends no free-tier quota, and
 *          is deterministic run to run — the "no facts lost" property
 *          holds by construction, not by prompt discipline.
 *
 * CHECKPOINTING is the load-bearing part, not an afterthought. At the
 * default 1M context floor exactly ONE free model qualifies (P3's
 * `selectEligibleModels`), so there is no rotation partner once its daily
 * cap hits mid-run — an interruption is the EXPECTED outcome of a long
 * run, not an edge case. Every successful map chunk is persisted to
 * `checkpointPath` immediately, and a resumed run verifies the checkpoint
 * was produced from the SAME transcript (path + size + mtime) with the
 * SAME prune level and chunking params before reusing a single byte of it
 * — resuming against a changed input silently would produce a summary
 * that is wrong in a way nobody could detect.
 *
 * COST SAFETY: this command exists specifically to guarantee $0 spend, so
 * `assertFreeOnlyModel(true, ...)` is called with a HARDCODED `true` —
 * unlike every other subsystem, there is no caller-supplied `freeOnly`
 * that could turn this off. A non-':free' `modelId` fails before any file
 * IO or network call.
 *
 * PURE CORE + THIN IO SHELL: the actual model call is injected as
 * `callModel` (see `CallModelFn`), so this module — and its tests — never
 * touch the network. The real HTTP call lives in the CLI layer (P5).
 *
 * CONCURRENCY (owner-specified, 2026-08-12): map chunks are turn-atomic —
 * no chunk's prompt depends on another chunk's summary — and the join above
 * is a deterministic, order-based concatenation, not a model fold. So
 * dispatching several chunks' model calls AT ONCE changes wall-clock only,
 * never output: the same set of per-chunk summaries lands in
 * `checkpoint.mapSummaries`, keyed by index, regardless of completion order.
 * `options.concurrency` (default 1 — sequential — HERE; the CLI layer
 * defaults it to `DEFAULT_CONCURRENCY`, see its own header) bounds how many
 * chunk requests run in flight at once. Launches are staggered by
 * `STAGGER_INTERVAL_MS` per worker so a burst of N concurrent launches never
 * looks like a request spike to the provider. A model-fallback or
 * context-overflow re-chunk mutates the SHARED `chunks` array and
 * `mapSummaries` slice, so it is serialized behind a pause gate that drains
 * every other in-flight chunk first — see `becomeLeaderAndTransition` below.
 */

import { statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { assertFreeOnlyModel } from "../config.js";
import { classifyUnavailable, recordUnavailable, getCooldownStore, earliestReset } from "../free-rotation.js";
import { readTranscript, type PruneLevel, type Turn, type TranscriptStats } from "./transcript.js";
import type { EligibleModel } from "./model-select.js";
import {
  chunkTurns,
  classifyContextOverflow,
  DEFAULT_OVERLAP_TURNS,
  type TranscriptChunk,
} from "./chunker.js";

/** Tokens reserved out of the model's context window for prompt wrapper text
 *  (instructions) plus the completion itself — the chunk BODY must fit in
 *  what's left. A heuristic margin, not a precise accounting; generous
 *  enough that the wrapper text this module actually writes never blows it. */
export const PROMPT_OVERHEAD_TOKENS = 2_000;

/**
 * Hard cap on the per-chunk token budget, INDEPENDENT of how big the
 * selected model's context window is. Measured live (TRDD-T4MZ8YQR
 * follow-up): a 1M-context free model handed a single ~150k-token chunk (the
 * whole pruned transcript, packed into ONE request because the window budget
 * alone allowed it) degenerated to echoing a raw line back instead of
 * summarizing — quality collapses long before the context LIMIT is reached,
 * especially on free models. The context window governs what FITS; it does
 * not govern what a model can summarize WELL, and the two must not be
 * conflated.
 *
 * REVISED to 25k (owner-specified, 2026-08-12; was 50k) now that the map
 * phase runs CONCURRENTLY (see the module header's CONCURRENCY note): the
 * old 50k value was sized for SEQUENTIAL processing, where a bigger chunk
 * meant fewer round-trips and so a shorter total run — a tradeoff that no
 * longer holds once several chunks are in flight at once. Under
 * concurrency, a SMALLER chunk is strictly better on every axis: each
 * request generates less output (so it returns sooner), more of them
 * overlap in wall-clock time, and the per-chunk digest stays well inside
 * the quality-collapse threshold measured above. The one thing a smaller
 * default does NOT do is shrink the model's real capability — see
 * `DEFAULT_CONCURRENCY` for how the two defaults were chosen together.
 *
 * THIS IS A DEFAULT, NOT A CEILING. An explicit `--max_chunk_tokens` is
 * honored VERBATIM and may exceed both this value and the model's window: the
 * caller made a deliberate choice, and this tool must not impose a limit the
 * user did not ask for. An over-large setting is not a foot-gun — the model's
 * own context-overflow error is authoritative and re-splits that chunk, so it
 * degrades into extra calls rather than a failure. Only the DEFAULT is capped
 * by the window; there is no point defaulting to a budget the model cannot
 * accept. */
export const DEFAULT_MAX_CHUNK_TOKENS = 25_000;

/**
 * The CLI layer's default for `--concurrency` when the flag is omitted (see
 * index.ts's session_summary wiring). `summarizeSession` itself defaults
 * `options.concurrency` to 1 (sequential) when omitted — a conservative
 * library default that keeps every caller who doesn't ask for concurrency
 * on the exact behavior this module always had. The CLI is the one place
 * that opts every real invocation INTO concurrency by passing this value
 * explicitly, matching how `max_chunk_tokens` already works (the model-
 * dependent default lives here; a value the caller supplies, explicitly or
 * via the CLI, is honored verbatim — see `DEFAULT_MAX_CHUNK_TOKENS`'s own
 * header).
 *
 * MEASURED against the live account, not estimated (its `rate_limit` API
 * field is deprecated and unusable — `requests: -1`): a burst of 32
 * concurrent requests to the free model landed 32/32 clean (zero 429s,
 * no rate-limit headers even returned); a burst of 64 landed 62/64, with
 * the two 429s carrying `x-ratelimit-limit: 20` and a `x-ratelimit-reset`
 * that was already in the past by the time the burst finished — i.e. a
 * sub-minute rolling window, not the UTC-midnight daily cap. 12 stays
 * comfortably inside the clean zone (32) while leaving headroom for the
 * rest of the ensemble's traffic and for any candidate model with a
 * tighter bucket than this one. Deliberately NOT the measured ceiling —
 * defaulting to the edge of what's clean today is exactly how a small
 * account-side change turns a default into a standing 429 storm. */
export const DEFAULT_CONCURRENCY = 12;

/**
 * Minimum spacing between successive worker LAUNCHES under concurrency > 1
 * (owner-specified, 2026-08-12; revised down from an initial 3s estimate
 * once live burst data existed — see `DEFAULT_CONCURRENCY`'s header). Not a
 * per-request throttle — once a worker is running, it moves straight to its
 * next chunk with no further delay; this only breaks up the INSTANTANEOUS
 * admission burst enough that `DEFAULT_CONCURRENCY` (or any larger explicit
 * value) concurrent launches don't all land in the same tick. The measured
 * bucket is a 20-slot sub-minute window, so 250ms of spread is plenty — 3s
 * per launch would have added ~3s × (concurrency - 1) of pure dead time to
 * every run (e.g. 45s at 16 workers) for no measured benefit.
 *
 * Two consequences worth keeping in mind when reading the map loop below
 * (both measured live, not assumed): request LATENCY here is
 * queue-dominated, not generation-dominated — even a `max_tokens: 8` probe
 * took ~35s, a floor that has nothing to do with completion length. So (1)
 * splitting into smaller chunks does NOT shorten a SEQUENTIAL run — each
 * added chunk pays the same ~35s floor again, smaller chunks only pay off
 * once they run concurrently (see `DEFAULT_MAX_CHUNK_TOKENS`'s header); and
 * (2) a concurrent map phase's wall-clock is approximately the SLOWEST
 * single chunk's time plus the stagger, not the sum of every chunk's time. */
export const STAGGER_INTERVAL_MS = 250;

/**
 * Backoff delay before retrying a chunk that hit an ordinary transient
 * (429) rate-limit blip WHILE running under concurrency > 1 (see
 * `callWithRetry`). Sequential runs (concurrency <= 1, the default) keep
 * the original fail-fast behavior — a lone request has no siblings to keep
 * busy while it waits, so backing off in-process just stalls the whole run
 * for no benefit over "checkpoint and let the operator re-run". Under
 * concurrency, siblings DO keep making progress during the wait, so a
 * bounded backoff-and-retry converts a same-minute blip into a few extra
 * seconds of wall-clock instead of aborting a multi-hour run over one
 * request. 5s clears a single-minute token-bucket refill on this account's
 * measured ~20 req/min ceiling without being so long it stalls the worker
 * pool. */
const TRANSIENT_BACKOFF_MS = 5_000;

/** Real-clock sleep, injected as `sleepFn` through the call chain so tests
 *  can substitute vitest's fake timers instead of waiting for real seconds
 *  to pass. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The injected model-call seam. Takes a fully-rendered prompt, the model id
 *  (already validated free-only by the caller), and a completion budget; a
 *  real implementation calls the OpenRouter chat completions endpoint (P5).
 *  Tests inject a fake — this module never performs network IO itself. */
export type CallModelFn = (
  prompt: string,
  modelId: string,
  maxOutputTokens: number,
) => Promise<string>;

export interface SummarizeSessionOptions {
  transcriptPath: string;
  /** Where the resume checkpoint is read from / written to. */
  checkpointPath: string;
  modelId: string;
  /** The selected model's total context window (P3's EligibleModel.contextLength). */
  modelMaxContext: number;
  /** The selected model's completion ceiling (P3's EligibleModel.maxCompletionTokens). */
  modelMaxCompletionTokens: number;
  /** Ordered fallback candidates (biggest-context-first, same shape as P3's
   *  `selectModels()` output minus the primary `modelId` entry) tried, in
   *  order, when the active model becomes unavailable mid-run — delisted
   *  (404/"gone"), no longer free (402/"payment required"), or its daily
   *  free cap is exhausted. NOT tried on an ordinary transient error (a
   *  429/502/503 blip): that still fails fast with a "re-run later"
   *  message, because swapping models on a blip would silently downgrade
   *  quality instead of just retrying. On a fallback-eligible switch, any
   *  unsent work is re-chunked to the new model's (possibly smaller)
   *  context — see `README`/model-select.ts header. Cooldown bookkeeping
   *  is delegated to the project's existing `free-rotation.ts` registry
   *  (`recordUnavailable`), not reinvented here. */
  fallbackModels?: EligibleModel[];
  callModel: CallModelFn;
  /** Default "aggressive" — matches the CLI layer's documented default (P5 TRDD note). */
  pruneLevel?: PruneLevel;
  chunkOverlapTurns?: number;
  /** Token budget per chunk. Default: min(DEFAULT_MAX_CHUNK_TOKENS,
   *  modelMaxContext minus completion headroom minus PROMPT_OVERHEAD_TOKENS)
   *  — see DEFAULT_MAX_CHUNK_TOKENS's header for why the window alone is not
   *  used as the budget. Fixed regardless of a fallback switch when given
   *  explicitly (an explicit value is a deliberate caller choice, never
   *  auto-capped); derived per-model (and re-derived on every fallback
   *  switch) when omitted. */
  maxChunkTokens?: number;
  /** Bounded retries for a non-availability (real bug/schema) failure before
   *  the run fails. Rate-limit-shaped failures are NEVER retried here — see
   *  `callWithRetry`. Default 2 (three attempts total). */
  maxRetriesPerChunk?: number;
  /** How many chunk requests may be in flight at once. Default: 1
   *  (sequential — the library's conservative default; see
   *  `DEFAULT_CONCURRENCY`'s header for why the CLI opts every real
   *  invocation into 8 instead). A DEFAULT, NOT A CEILING in the same sense
   *  as `maxChunkTokens`: an explicit value — including 1, to force
   *  sequential behavior — is honored verbatim. Launches beyond the first
   *  are staggered by `STAGGER_INTERVAL_MS`. */
  concurrency?: number;
  /** Optional per-chunk progress hook for a caller that wants to render
   *  readable output with several chunks in flight at once (see
   *  `ChunkEvent`). Never required for correctness — purely observational. */
  onChunkEvent?: (event: ChunkEvent) => void;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => string;
}

/** One observable moment in a chunk's lifecycle, for a caller's progress
 *  display. Emitted around the OUTER (index) chunk, not each individual
 *  callModel attempt, so a retried/rechunked chunk still reads as one
 *  logical unit of work to the reader. */
export interface ChunkEvent {
  chunkIndex: number;
  totalChunks: number;
  phase: "start" | "done";
  /** Set only on "done" — wall-clock time this chunk's index spent being
   *  worked, including any retries/backoff it needed. */
  elapsedMs?: number;
}

/** One model-to-model switch that happened mid-run, for the caller's report. */
export interface ModelFallbackEvent {
  fromModel: string;
  toModel: string;
  reason: "gone" | "daily-quota" | "no-longer-free" | "no-text" | "echo";
  detail: string;
  atUnit: string;
}

export interface SummarizeSessionResult {
  summary: string;
  totalChunks: number;
  transcriptStats: TranscriptStats;
  /** True when this run resumed work already recorded in the checkpoint. */
  resumedFromCheckpoint: boolean;
  checkpointPath: string;
  /** The model that produced the final summary — equals options.modelId
   *  unless one or more fallback switches happened. */
  modelId: string;
  /** Every model-to-model switch that happened during this run, in order. */
  fallbackEvents: ModelFallbackEvent[];
}

// ── Checkpoint shape ─────────────────────────────────────────────────────

interface CheckpointIdentity {
  transcriptPath: string;
  transcriptBytes: number;
  transcriptMtimeMs: number;
  pruneLevel: PruneLevel;
  chunkerMaxTokens: number;
  chunkerOverlapTurns: number;
}

interface Checkpoint {
  version: 1;
  identity: CheckpointIdentity;
  totalChunks: number;
  /** One slot per chunk; null until that chunk's map summary lands. */
  mapSummaries: (string | null)[];
  /** The deterministic join of `mapSummaries`, set once every slot is
   *  filled — see `joinChunkSummaries`. Cached so a resumed run whose map
   *  phase was already complete doesn't recompute (cheap, but pointless
   *  work) or re-verify anything about the join. */
  finalSummary: string | null;
  updatedAt: string;
  /** The model actively producing new work as of the last save — informational
   *  (not part of the identity match); reflects the latest fallback switch, if any. */
  activeModelId?: string;
}

function checkpointIdentityMatches(a: CheckpointIdentity, b: CheckpointIdentity): boolean {
  return (
    a.transcriptPath === b.transcriptPath &&
    a.transcriptBytes === b.transcriptBytes &&
    a.transcriptMtimeMs === b.transcriptMtimeMs &&
    a.pruneLevel === b.pruneLevel &&
    a.chunkerMaxTokens === b.chunkerMaxTokens &&
    a.chunkerOverlapTurns === b.chunkerOverlapTurns
  );
}

function describeIdentityMismatch(prev: CheckpointIdentity, cur: CheckpointIdentity): string {
  const diffs: string[] = [];
  if (prev.transcriptPath !== cur.transcriptPath) {
    diffs.push(`transcript path '${prev.transcriptPath}' != '${cur.transcriptPath}'`);
  }
  if (prev.transcriptBytes !== cur.transcriptBytes) {
    diffs.push(`transcript size ${prev.transcriptBytes}B != ${cur.transcriptBytes}B`);
  }
  if (prev.transcriptMtimeMs !== cur.transcriptMtimeMs) {
    diffs.push(`transcript mtime ${prev.transcriptMtimeMs} != ${cur.transcriptMtimeMs}`);
  }
  if (prev.pruneLevel !== cur.pruneLevel) {
    diffs.push(`prune level '${prev.pruneLevel}' != '${cur.pruneLevel}'`);
  }
  if (prev.chunkerMaxTokens !== cur.chunkerMaxTokens) {
    diffs.push(`chunk token budget ${prev.chunkerMaxTokens} != ${cur.chunkerMaxTokens}`);
  }
  if (prev.chunkerOverlapTurns !== cur.chunkerOverlapTurns) {
    diffs.push(`chunk overlap ${prev.chunkerOverlapTurns} != ${cur.chunkerOverlapTurns}`);
  }
  return diffs.join("; ");
}

/**
 * Load an existing checkpoint and verify it belongs to THIS run before
 * handing back a single cached summary. Returns null for "no checkpoint
 * yet" (a fresh run, not an error). Throws fail-fast on a corrupt file or
 * an identity mismatch — silently resuming against a different transcript
 * or different chunking params would produce a summary that is wrong in a
 * way nobody could detect from the output alone.
 */
function loadCheckpoint(path: string, identity: CheckpointIdentity): Checkpoint | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null; // no checkpoint on disk — fresh run
  }

  let parsed: Checkpoint;
  try {
    parsed = JSON.parse(raw) as Checkpoint;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `session-summary: checkpoint at ${path} is not valid JSON (${msg}) — refusing to resume ` +
        `against a corrupt checkpoint. Delete the file to start a fresh run.`,
      { cause: err },
    );
  }
  if (parsed.version !== 1 || !parsed.identity || !Array.isArray(parsed.mapSummaries)) {
    throw new Error(
      `session-summary: checkpoint at ${path} has an unrecognised shape — refusing to resume. ` +
        `Delete the file to start a fresh run.`,
    );
  }
  if (!checkpointIdentityMatches(parsed.identity, identity)) {
    throw new Error(
      `session-summary: checkpoint at ${path} does not match this run (${describeIdentityMismatch(
        parsed.identity,
        identity,
      )}). A checkpoint may only resume the SAME transcript with the SAME prune level and ` +
        `chunking params it was created with. Delete the checkpoint to start fresh with the new settings.`,
    );
  }
  return parsed;
}

/** Atomic write (tmp + rename), matching the project's existing checkpoint/
 *  cooldown-store convention (see free-rotation.ts). Deliberately NOT
 *  best-effort here: losing the ability to resume a multi-hour run is
 *  serious enough that an unwritable checkpoint dir should fail the run
 *  loudly rather than silently run un-resumable. */
function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), "utf-8");
  renameSync(tmp, path);
}

// ── Retry wrapper + model fallback ──────────────────────────────────────

/** Why the active model was dropped from rotation — a strict subset of
 *  `classifyUnavailable`'s kinds plus a locally-detected "no longer free"
 *  (a 402/"payment required" on a model this run selected specifically
 *  BECAUSE it priced at $0 at selection time; the shared classifier does
 *  not carry this case because other callers treat 402 as "switch profile
 *  to the free pool", which doesn't apply here — this run IS the free
 *  pool). Also includes "no-text" — the modality filter in model-select.ts
 *  is deliberately PERMISSIVE (any model with text on both sides of its
 *  modality is selectable, including e.g. a music-generation model that
 *  also accepts/emits text) because a metadata string cannot reliably
 *  predict whether the model's text output is actually USABLE for
 *  summarization; usability is instead enforced HERE, at runtime, by
 *  evidence — an empty or no-text response demotes the model exactly like
 *  a delisting would. Deliberately excludes "transient": a 429/502/503
 *  blip is NOT grounds to abandon a model — see the module header.
 *
 *  "echo" is the sibling of "no-text": a model that returns NON-empty text
 *  that is nevertheless not a summary — it copied its input back verbatim
 *  (measured live: a 1M-context free model handed a large chunk returned a
 *  single raw line lifted from the transcript instead of summarizing it,
 *  and the run reported success because the response was non-empty). Same
 *  treatment as "no-text": demote and fall back, never retried on the same
 *  model — an identical prompt would echo identically. */
type ModelFallbackReason = "gone" | "daily-quota" | "no-longer-free" | "no-text" | "echo";

class ModelUnavailableError extends Error {
  constructor(
    readonly reason: ModelFallbackReason,
    readonly modelId: string,
    readonly detail: string,
  ) {
    super(`model '${modelId}' became unavailable (${reason}): ${detail}`);
    this.name = "ModelUnavailableError";
  }
}

/**
 * A GENUINE provider-side context-overflow rejection — the model's own
 * ground truth that a chunk body was too big for its window, distinct
 * from `ModelUnavailableError` (the MODEL itself is gone/exhausted) and from
 * a rate limit. This is never retried unchanged (the identical prompt would
 * fail identically) and never triggers a model swap — the caller re-splits
 * the offending unit of work smaller and retries on the SAME model. See
 * chunker.ts's `classifyContextOverflow` for the detection rules.
 */
class ContextOverflowError extends Error {
  constructor(
    readonly modelId: string,
    readonly detail: string,
  ) {
    super(`model '${modelId}' rejected the request as exceeding its context window: ${detail}`);
    this.name = "ContextOverflowError";
  }
}

/** Floor for the shrink-on-overflow budget below which we stop halving and
 *  fail loudly — see `shrinkBudgetOnOverflow`'s header. */
const MIN_OVERFLOW_CHUNK_BUDGET = 500;

/** Halve the current chunk token budget in response to a real
 *  context-overflow rejection, floored at `MIN_OVERFLOW_CHUNK_BUDGET`. The
 *  caller MUST check whether the result actually changed (`!== current`)
 *  before using it — a floor that stops moving means the content can't be
 *  reduced any further under this model, and looping on it would be an
 *  infinite retry disguised as progress. */
function shrinkBudgetOnOverflow(current: number): number {
  return Math.max(MIN_OVERFLOW_CHUNK_BUDGET, Math.floor(current / 2));
}

function classifyModelFallback(detail: string): ModelFallbackReason | null {
  const kind = classifyUnavailable(detail);
  if (kind === "gone" || kind === "daily-quota") return kind;
  const s = (detail || "").toLowerCase();
  if (s.includes("402") || s.includes("insufficient credit") || s.includes("payment required")) {
    return "no-longer-free";
  }
  return null;
}

/** Below this many normalized characters, a substring match is not worth
 *  rejecting on — short generic replies ("Done.", "OK, summarized.") can
 *  coincide with a short fragment of the input by chance, and rejecting
 *  those would punish genuinely terse (but real) summaries. Real echoes
 *  measured in the wild (a copied transcript line) run into the hundreds of
 *  characters, so this floor is far below any real echo and only guards
 *  against short-string false positives. */
const ECHO_MIN_RESPONSE_LENGTH = 40;

function normalizeForEchoCheck(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when `response` is not a summary of `sourceText` but a copy of it —
 * the WHOLE (normalized) response appears verbatim as a contiguous
 * substring of the source. Deliberately a "whole-response-is-input" test,
 * not "contains any input text": a legitimate summary very often quotes a
 * short fragment of the source (a file name, an error message, a command)
 * without being an echo, and rejecting on any shared substring would punish
 * that. Only when the ENTIRE response reduces to something already present
 * verbatim in the source — i.e. the model produced no new prose of its own
 * — is this a rejection. Measured live: a 1M-context free model asked to
 * summarize a large chunk returned a single raw line lifted straight from
 * the transcript; that response IS its own source substring in full.
 */
export function isEchoResponse(response: string, sourceText: string): boolean {
  const normResponse = normalizeForEchoCheck(response);
  if (normResponse.length < ECHO_MIN_RESPONSE_LENGTH) return false;
  const normSource = normalizeForEchoCheck(sourceText);
  return normSource.includes(normResponse);
}

/**
 * Call `callModel` with a bounded number of retries — but ONLY for a
 * genuine (non-availability) failure. A rate-limit blip (per the project's
 * own `classifyUnavailable` classifier, the single source of truth for
 * "should we back off?") is NEVER retried here and never triggers a model
 * switch: retrying immediately just re-hits the same wall, and swapping
 * models on an ordinary blip would silently downgrade quality instead of
 * just waiting it out. A delisted / no-longer-free / daily-cap-exhausted
 * model throws a `ModelUnavailableError` instead — the caller (the map
 * loop) is the one that decides whether a fallback candidate exists. The
 * checkpoint already holds every unit of work completed before this one,
 * so every thrown message names the checkpoint path to resume from.
 *
 * `echoCheckSource` is the raw text the model was asked to summarize (the
 * chunk's turns) — used ONLY to detect an echoed response (see
 * `isEchoResponse`); it is never sent anywhere.
 *
 * `retryTransient` (default false, preserving the original sequential
 * behavior byte-for-byte) opts a CONCURRENT run into backing off and
 * retrying an ordinary 429 blip instead of failing the whole run over it —
 * see `TRANSIENT_BACKOFF_MS`'s header for why this is safe only when
 * siblings are making progress during the wait. `sleepFn` is the injected
 * clock for that backoff, defaulting to the real `sleep` — tests substitute
 * vitest's fake timers.
 */
async function callWithRetry(
  prompt: string,
  modelId: string,
  maxOutputTokens: number,
  callModel: CallModelFn,
  maxRetries: number,
  label: string,
  checkpointPath: string,
  echoCheckSource: string,
  retryTransient: boolean = false,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await callModel(prompt, modelId, maxOutputTokens);
      // Runtime evidence, not metadata guessing: model-select.ts admits any
      // model with text on both sides of its modality, including ones
      // whose text output may not actually be usable (e.g. a music model
      // that also nominally emits text). An empty/whitespace-only response
      // is treated exactly like a delisting — demote and let the caller
      // fall back to the next ranked candidate, never returned as if it
      // were a valid (if terse) summary.
      if (result.trim().length === 0) {
        throw new ModelUnavailableError("no-text", modelId, "model returned an empty/no-text response");
      }
      // A non-empty response that is nevertheless just a copy of its input
      // is NOT a summary either — see isEchoResponse's header. Reported as
      // model-unavailable ("echo") so the caller demotes this model and
      // advances the fallback chain exactly like a delisting, instead of
      // returning the echo to the caller as if it were real work.
      if (isEchoResponse(result, echoCheckSource)) {
        throw new ModelUnavailableError(
          "echo",
          modelId,
          `model echoed its input verbatim instead of summarizing it (response: ${result.slice(0, 120)}${result.length > 120 ? "…" : ""})`,
        );
      }
      return result;
    } catch (err) {
      if (err instanceof ModelUnavailableError) throw err; // no-text/echo: never retried, propagate for fallback immediately
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);

      // Ground truth beats our estimate: the eligible free models aren't
      // o200k-tokenized, so `estimateTokens` can undercount. A genuine
      // provider-side overflow is never retried unchanged (the identical
      // prompt fails identically) — it propagates immediately so the
      // caller can re-split the unit of work and retry smaller, on the
      // SAME model (a sizing problem is not an availability problem).
      if (classifyContextOverflow(msg)) {
        throw new ContextOverflowError(modelId, msg);
      }

      const fallbackReason = classifyModelFallback(msg);
      if (fallbackReason) {
        throw new ModelUnavailableError(fallbackReason, modelId, msg);
      }

      if (classifyUnavailable(msg) === "transient") {
        // Concurrent run with attempts left: back off and retry THIS chunk
        // — siblings keep making progress in the meantime, so a same-minute
        // 429 blip costs a few seconds instead of the whole run. Sequential
        // (the default) keeps the original behavior exactly: fail fast,
        // name the checkpoint, let the operator re-run once the limit
        // clears — a lone request has no sibling to keep busy while it
        // waits, so an in-process backoff would just stall for nothing over
        // "checkpoint and stop".
        if (retryTransient && attempt < maxRetries) {
          await sleepFn(TRANSIENT_BACKOFF_MS);
          continue;
        }
        throw new Error(
          `session-summary: ${label} hit a rate limit / availability error on model '${modelId}': ` +
            `${msg}. Checkpoint saved at ${checkpointPath} — re-run the same command to resume once ` +
            `the limit clears (free daily quotas reset at 00:00 UTC).`,
          { cause: err },
        );
      }
      // A genuine (non-availability) failure — worth a bounded retry before
      // giving up, since a transient schema hiccup on the provider side is
      // plausible and cheap to retry once or twice.
    }
  }
  const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `session-summary: ${label} failed after ${maxRetries + 1} attempt(s) on model '${modelId}': ` +
      `${lastMsg}. Checkpoint saved at ${checkpointPath} — fix the underlying issue and re-run to resume.`,
  );
}

// ── Prompt rendering ─────────────────────────────────────────────────────

function renderTurn(turn: Turn): string {
  const parts = [`[${turn.role}]`];
  if (turn.text.trim() !== "") parts.push(turn.text);
  for (const tc of turn.toolCalls) parts.push(`(tool_use ${tc.name}: ${tc.argSummary})`);
  for (const e of turn.errors) parts.push(`(error: ${e})`);
  return parts.join("\n");
}

/** The raw material a chunk's map call is asked to summarize, with no
 *  instruction wrapper — this (not the full prompt) is what `isEchoResponse`
 *  compares the model's response against, so a coincidental match against
 *  the INSTRUCTION text itself can never trigger a false echo rejection. */
function chunkBodyText(chunk: TranscriptChunk): string {
  return chunk.turns.map(renderTurn).join("\n\n");
}

/**
 * The map prompt's fixed instruction body, verbatim (owner-specified,
 * 2026-08-11) — the nine-section Claude-Code-compaction-equivalent handoff
 * schema. `{N}`/`{M}`/`{CONTINUATION}` are interpolated by `renderChunkPrompt`;
 * everything else is reproduced exactly, including heading text and casing,
 * so the schema's shape doesn't drift from what was specified.
 */
function chunkPromptHeader(partNumber: number, totalParts: number, continuation: string): string {
  return `You are compacting part ${partNumber} of ${totalParts} of a Claude Code coding-session transcript${continuation}. Your output REPLACES the transcript for a future session that must RESUME this work, so it must preserve everything needed to continue — it is a handoff, not a report.

Use these sections, in this order, with these exact headings. OMIT any section with no content in this part — never write "none", "N/A", or filler.

## Primary Request and Intent
What the user asked for and why, in detail.

## Key Technical Concepts
Technologies, frameworks, patterns and tools involved.

## Files and Code Sections
Every file examined, created or modified: exact path, why it matters, and the important code or the specific change.

## Errors and Fixes
Every error or failure, how it was fixed, and any feedback the user gave about the fix. Include attempted fixes that did NOT work and why.

## Problem Solving
Problems solved, and troubleshooting still in progress.

## All User Messages
Every message from the USER, copied VERBATIM and in order, excluding tool results. Do NOT paraphrase, summarize, shorten, merge or tidy them. The exact wording IS the content — intent is lost the moment it is reworded. This is the highest-value section here.

## Pending Tasks
Work the user explicitly asked for that is not yet done.

## Current Work
Precisely what was being worked on at the end of this part, with file names and code.

## Next Step
The immediate next action, only if it follows directly from work in flight. Do not invent one.

RULES
- Dense and factual. No editorialising, no padding, no commentary.
- Reproduce names EXACTLY: file paths, commands, flags, function names, commit hashes, error text, line numbers. Never approximate an identifier.
- Do NOT copy transcript text anywhere EXCEPT the "All User Messages" section. Everywhere else, state facts in your own words.
- Your output will be merged with summaries of the other parts: write no introduction and no conclusion.`;
}

function renderChunkPrompt(chunk: TranscriptChunk, totalChunks: number): string {
  const continuationParts = [
    chunk.continuesFromPrev ? "continues from the previous part" : null,
    chunk.continuesNext ? "continues into the next part" : null,
  ].filter((s): s is string => s !== null);
  const continuation = continuationParts.length > 0 ? ` (${continuationParts.join("; ")})` : "";
  const header = chunkPromptHeader(chunk.index + 1, totalChunks, continuation);
  return `${header}\n\n${chunkBodyText(chunk)}`;
}

/** Deterministically join the per-chunk map summaries into the final
 *  session summary — see the module header for why this is NOT a second
 *  model call. Straight concatenation in chunk order, with a plain
 *  separator naming the part so a reader (or the resuming agent) can still
 *  tell which chunk each stretch of text came from; nothing is ever
 *  re-summarized, so no fact from any chunk's summary can be dropped,
 *  reworded, or "tidied" by this step. */
export function joinChunkSummaries(summaries: readonly string[]): string {
  if (summaries.length === 1) return summaries[0];
  return summaries.map((s, i) => `--- Part ${i + 1} of ${summaries.length} ---\n\n${s}`).join("\n\n");
}

/** The turns still owed a map summary from `chunks[fromIndex..]` onward, in
 *  order, with the overlap turns `chunkTurns` duplicates across a boundary
 *  de-duplicated by object identity (the chunker slices the SAME Turn
 *  references into overlap, never clones them, so a `Set` of references is
 *  exact — no timestamp/uuid heuristic needed). Used to re-chunk only the
 *  UNSENT remainder to a new model's budget after a fallback switch, while
 *  every already-summarized chunk (and its checkpointed summary) is left
 *  untouched — a chunk summary is dense prose, not raw input, so it stays
 *  valid regardless of which model produces the NEXT one. */
function collectRemainingTurns(chunks: readonly TranscriptChunk[], fromIndex: number): Turn[] {
  const seen = new Set<Turn>();
  const out: Turn[] = [];
  for (let i = fromIndex; i < chunks.length; i++) {
    for (const t of chunks[i].turns) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

// ── The driver ────────────────────────────────────────────────────────────

/**
 * Summarize a whole session transcript by mapping each chunk to a summary
 * and joining the results, checkpointing after every completed map chunk
 * so an interrupted run resumes instead of restarting.
 */
export async function summarizeSession(
  options: SummarizeSessionOptions,
): Promise<SummarizeSessionResult> {
  const pruneLevel = options.pruneLevel ?? "aggressive";
  const overlapTurns = options.chunkOverlapTurns ?? DEFAULT_OVERLAP_TURNS;
  const maxRetries = options.maxRetriesPerChunk ?? 2;
  const nowIso = options.now ?? (() => new Date().toISOString());

  // The ordered candidate list: the primary model first, then the caller's
  // fallback chain (already ranked biggest-context-first by P3's
  // selectModels()). A KNOWN LIMITATION, documented rather than silently
  // assumed away: a fallback switch is fully handled WITHIN this run, but a
  // process crash mid-fallback + resume starts back over from candidate 0 —
  // if it too is still unavailable, this run's identity check will refuse
  // to resume against the checkpoint's now-different chunking params rather
  // than replaying the switch silently (fail fast beats a wrong resume).
  const models: EligibleModel[] = [
    { id: options.modelId, contextLength: options.modelMaxContext, maxCompletionTokens: options.modelMaxCompletionTokens },
    ...(options.fallbackModels ?? []),
  ];

  // Cost-safety chokepoint (TRDD-T4MZ8YQR: "$0 by construction"). This is
  // HARDCODED true for every candidate, not threaded from any caller option
  // — unlike every other subsystem in this project, session-summary has no
  // way to opt into paid spend at all. Checked before any file IO / chunking
  // work, so a misconfigured modelId fails in milliseconds, not after
  // chunking a multi-hundred-MB transcript.
  for (const m of models) assertFreeOnlyModel(true, "openrouter", m.id);

  let activeModelIdx = 0;
  const activeModel = (): EligibleModel => models[activeModelIdx];
  // The model's REAL usable window — the hard wall a single turn (or any
  // one request) can never exceed, regardless of the quality-cap target
  // below. Passed to `chunkTurns` as `hardBudgetTokens` so an oversized
  // turn is caught (and the run fails loudly, naming the turn) before any
  // model call, per the chunker's atomic-turn invariant.
  const windowBudgetForModel = (m: EligibleModel): number =>
    Math.max(1_000, m.contextLength - m.maxCompletionTokens - PROMPT_OVERHEAD_TOKENS);
  // Effective budget = min(what the model's window allows, the quality cap)
  // — see DEFAULT_MAX_CHUNK_TOKENS's header. An explicit --max_chunk_tokens
  // from the caller is honored verbatim (the caller made a deliberate
  // choice); only the DEFAULT is capped, never a caller-supplied value.
  const budgetForModel = (m: EligibleModel): number =>
    options.maxChunkTokens ?? Math.min(DEFAULT_MAX_CHUNK_TOKENS, windowBudgetForModel(m));
  let maxChunkTokens = budgetForModel(activeModel());

  const fallbackEvents: ModelFallbackEvent[] = [];

  const stat = statSync(options.transcriptPath);
  if (!stat.isFile()) {
    throw new Error(`session-summary: transcript is not a file: ${options.transcriptPath}`);
  }

  const identity: CheckpointIdentity = {
    transcriptPath: resolve(options.transcriptPath),
    transcriptBytes: stat.size,
    transcriptMtimeMs: stat.mtimeMs,
    pruneLevel,
    chunkerMaxTokens: maxChunkTokens,
    chunkerOverlapTurns: overlapTurns,
  };

  let checkpoint: Checkpoint | null = loadCheckpoint(options.checkpointPath, identity);
  const resumedFromCheckpoint = checkpoint !== null;

  const { turns, stats } = await readTranscript(options.transcriptPath, { pruneLevel });
  let { chunks } = chunkTurns(turns, {
    maxTokens: maxChunkTokens,
    overlapTurns,
    hardBudgetTokens: windowBudgetForModel(activeModel()),
  });

  if (checkpoint && checkpoint.totalChunks !== chunks.length) {
    // The identity check above already pins transcript size/mtime + every
    // chunking param, so this should be unreachable in practice — kept as a
    // second, independent guard (fail fast rather than silently packing a
    // mismatched checkpoint) in case a future chunker change makes chunk
    // count non-deterministic for the same inputs.
    throw new Error(
      `session-summary: checkpoint at ${options.checkpointPath} was recorded for ` +
        `${checkpoint.totalChunks} chunks but this run produced ${chunks.length} chunks from the ` +
        `same identity — refusing to resume. Delete the checkpoint to start fresh.`,
    );
  }

  if (!checkpoint) {
    checkpoint = {
      version: 1,
      identity,
      totalChunks: chunks.length,
      mapSummaries: new Array<string | null>(chunks.length).fill(null),
      finalSummary: null,
      updatedAt: nowIso(),
      activeModelId: activeModel().id,
    };
  }

  /** Every candidate has failed for this unit of work: no model left to try.
   *  Reuses the project's own cooldown registry (free-rotation.ts) to name
   *  the earliest moment ANY tried candidate might recover, rather than
   *  reinventing that bookkeeping here. */
  function allModelsExhausted(triedIds: readonly string[], lastErr: ModelUnavailableError): Error {
    const store = getCooldownStore();
    const earliest = earliestReset(store, models.map((m) => m.id), Date.now());
    const when =
      earliest && earliest > Date.now() ? ` Earliest known reset: ${new Date(earliest).toISOString()}.` : "";
    return new Error(
      `session-summary: every candidate free model is unavailable — tried ${triedIds.join(", ")}. ` +
        `Last failure on '${lastErr.modelId}' (${lastErr.reason}): ${lastErr.detail}.${when} ` +
        `Checkpoint saved at ${options.checkpointPath} — re-run once a model recovers.`,
    );
  }

  /** Record the failure (cooldown bookkeeping, reused from free-rotation.ts)
   *  and advance to the next candidate, or throw when none remain. */
  function advanceModel(err: ModelUnavailableError, triedIds: string[]): void {
    recordUnavailable(err.modelId, err.detail);
    triedIds.push(err.modelId);
    if (activeModelIdx + 1 >= models.length) throw allModelsExhausted(triedIds, err);
    activeModelIdx++;
  }

  /** THE TRAP this guards against: chunk sizes are derived from the
   *  SELECTED model's context. Falling back to a smaller-context model
   *  without re-chunking sends oversized chunks that fail outright, and the
   *  symptom looks like "the fallback model is broken" instead of "we
   *  didn't re-chunk". Already-summarized chunks (indices < fromChunkIndex)
   *  are untouched — they are dense summaries, not raw input, so they stay
   *  valid regardless of which model produces the NEXT chunk.
   *
   *  `newBudget` is passed in rather than always derived from the active
   *  model, because a context-overflow re-split (see `ContextOverflowError`)
   *  needs to shrink the budget WITHOUT switching models — reusing this same
   *  re-chunk + checkpoint machinery keeps both paths (model fallback and
   *  overflow re-split) consistent with the resume/identity invariants. */
  function rechunkRemainingMap(fromChunkIndex: number, newBudget: number): void {
    if (newBudget !== maxChunkTokens) {
      const remainingTurns = collectRemainingTurns(chunks, fromChunkIndex);
      const { chunks: newTail } = chunkTurns(remainingTurns, {
        maxTokens: newBudget,
        overlapTurns,
        hardBudgetTokens: windowBudgetForModel(activeModel()),
      });
      const reindexedTail = newTail.map((c, i) => ({ ...c, index: fromChunkIndex + i }));
      chunks = [...chunks.slice(0, fromChunkIndex), ...reindexedTail];
      maxChunkTokens = newBudget;
    }
    checkpoint!.totalChunks = chunks.length;
    checkpoint!.mapSummaries = [
      ...checkpoint!.mapSummaries.slice(0, fromChunkIndex),
      ...new Array<string | null>(chunks.length - fromChunkIndex).fill(null),
    ];
    checkpoint!.identity = { ...checkpoint!.identity, chunkerMaxTokens: maxChunkTokens, chunkerOverlapTurns: overlapTurns };
    checkpoint!.activeModelId = activeModel().id;
    checkpoint!.updatedAt = nowIso();
    saveCheckpoint(options.checkpointPath, checkpoint!);
  }

  // Shared across every chunk for the lifetime of this run — see
  // `allModelsExhausted`'s call site: once a model is demoted it is demoted
  // for the WHOLE run (activeModelIdx only ever advances), so which chunk
  // happened to discover a given model's unavailability is not meaningful;
  // only the cumulative list of everything tried before exhaustion is.
  const triedModelIds: string[] = [];

  /** One attempt cycle on chunk `i`: call the model, and on success persist
   *  the checkpoint immediately (see the module header — no `await` sits
   *  between the mutation and the synchronous `saveCheckpoint`, so two
   *  chunks completing "at once" can never interleave a torn write; the
   *  second call's fs.writeFileSync simply blocks the JS thread until the
   *  first's completes, and picks up its already-applied mutation). Returns
   *  a discriminated outcome instead of performing the model-swap /
   *  re-chunk itself — the sequential and concurrent map loops below need
   *  different coordination around that step (the concurrent one must drain
   *  every other in-flight chunk first; see `becomeLeaderAndTransition`). */
  async function attemptChunk(
    i: number,
    retryTransient: boolean,
    sleepFn: (ms: number) => Promise<void>,
  ): Promise<
    { kind: "ok" } | { kind: "fallback"; err: ModelUnavailableError } | { kind: "overflow"; err: ContextOverflowError }
  > {
    try {
      const summary = await callWithRetry(
        renderChunkPrompt(chunks[i], chunks.length),
        activeModel().id,
        activeModel().maxCompletionTokens,
        options.callModel,
        maxRetries,
        `chunk ${i}`,
        options.checkpointPath,
        chunkBodyText(chunks[i]),
        retryTransient,
        sleepFn,
      );
      checkpoint!.mapSummaries[i] = summary;
      checkpoint!.updatedAt = nowIso();
      saveCheckpoint(options.checkpointPath, checkpoint!);
      return { kind: "ok" };
    } catch (err) {
      if (err instanceof ModelUnavailableError) return { kind: "fallback", err };
      if (err instanceof ContextOverflowError) return { kind: "overflow", err };
      throw err;
    }
  }

  /** Apply a model-fallback or context-overflow outcome: re-chunk the
   *  remaining (unsent) work and, for a fallback, record the switch. Shared
   *  by both map loops — the sequential loop calls it directly (nothing
   *  else can be in flight); the concurrent loop wraps it in
   *  `becomeLeaderAndTransition`'s drain-then-transition gate. */
  function applyTransition(
    i: number,
    outcome: { kind: "fallback"; err: ModelUnavailableError } | { kind: "overflow"; err: ContextOverflowError },
  ): void {
    if (outcome.kind === "fallback") {
      const fromModel = activeModel().id;
      advanceModel(outcome.err, triedModelIds);
      rechunkRemainingMap(i, budgetForModel(activeModel()));
      fallbackEvents.push({
        fromModel,
        toModel: activeModel().id,
        reason: outcome.err.reason,
        detail: outcome.err.detail,
        atUnit: `chunk ${i}`,
      });
      return;
    }
    // Context overflow: the model's own rejection is ground truth that our
    // estimate was too optimistic for THIS chunk's real content — shrink
    // the budget for the remaining (unsent) work and re-pack it at turn
    // boundaries (chunkTurns degrades to line-boundary splitting for any
    // single turn that alone still overflows — see chunker.ts). Never swap
    // models here: this is a sizing problem, not an availability problem.
    const newBudget = shrinkBudgetOnOverflow(maxChunkTokens);
    if (newBudget === maxChunkTokens) {
      throw new Error(
        `session-summary: chunk ${i} still exceeds model '${activeModel().id}'s context window ` +
          `even at the minimum ${MIN_OVERFLOW_CHUNK_BUDGET}-token re-split floor (${outcome.err.detail}). ` +
          `This model cannot summarize this chunk's content — try a model with more context, or ` +
          `raise --min-context. Checkpoint saved at ${options.checkpointPath}.`,
        { cause: outcome.err },
      );
    }
    rechunkRemainingMap(i, newBudget);
  }

  const concurrency = Math.max(1, options.concurrency ?? 1);
  const onChunkEvent = options.onChunkEvent;

  if (concurrency <= 1) {
    // ── MAP (sequential): summarize each chunk, checkpointing after every
    // success. Byte-for-byte the original single-worker behavior — no
    // `retryTransient` backoff (a lone request has no sibling to keep busy
    // while it waits — see `TRANSIENT_BACKOFF_MS`'s header), no stagger.
    for (let i = 0; i < chunks.length; i++) {
      if (checkpoint.mapSummaries[i] !== null) continue; // already done — resume
      const startedAt = Date.now();
      onChunkEvent?.({ chunkIndex: i, totalChunks: chunks.length, phase: "start" });
      for (;;) {
        const outcome = await attemptChunk(i, false, sleep);
        if (outcome.kind === "ok") {
          onChunkEvent?.({ chunkIndex: i, totalChunks: chunks.length, phase: "done", elapsedMs: Date.now() - startedAt });
          break;
        }
        applyTransition(i, outcome); // throws on terminal exhaustion/floor — propagates as before
        // retry the SAME unit of work — chunks[i] now reflects the new
        // model's budget or the shrunk budget.
      }
    }
  } else {
    // ── MAP (concurrent): a bounded pool of workers pulls the next
    // not-yet-done chunk index and processes it. Correctness under
    // concurrency rests on one invariant: `applyTransition` mutates the
    // SHARED `chunks` array and the `mapSummaries` slice from the failing
    // index onward, so it may only run once every OTHER currently in-flight
    // chunk has settled — see `becomeLeaderAndTransition`. Order in the
    // final joined summary is unaffected either way: `mapSummaries` is
    // always keyed by index, never by completion order.
    let nextIndex = 0;
    const inFlight = new Map<number, Promise<void>>();
    let transitioning = false;
    let pauseGate: Promise<void> | null = null;

    /** Serialize a model-fallback/overflow transition behind a pause gate:
     *  the FIRST worker to hit one becomes the leader, drains every other
     *  in-flight attempt (so nothing else touches `chunks`/`mapSummaries`
     *  mid-mutation), then applies the transition and rewinds the dispatch
     *  cursor so the (now-invalidated) tail gets reprocessed. A worker that
     *  arrives while a transition is already underway is a FOLLOWER: it
     *  just waits for the gate to clear, then its own retry loop re-reads
     *  the (possibly now out-of-range) `chunks[i]` and either retries or
     *  stops — no separate transition of its own is needed, since the
     *  leader's rechunk already covers every index from the smallest
     *  failing index onward. */
    async function becomeLeaderAndTransition(
      i: number,
      outcome: { kind: "fallback"; err: ModelUnavailableError } | { kind: "overflow"; err: ContextOverflowError },
    ): Promise<void> {
      if (transitioning) {
        const gate = pauseGate;
        if (gate) await gate;
        return;
      }
      transitioning = true;
      let release!: () => void;
      const gate = new Promise<void>((res) => {
        release = res;
      });
      pauseGate = gate;
      try {
        const others = [...inFlight.entries()].filter(([idx]) => idx !== i).map(([, p]) => p);
        await Promise.allSettled(others);
        applyTransition(i, outcome);
        nextIndex = Math.min(nextIndex, i);
      } finally {
        transitioning = false;
        pauseGate = null;
        release();
      }
    }

    async function worker(workerIdx: number): Promise<void> {
      if (workerIdx > 0) await sleep(STAGGER_INTERVAL_MS * workerIdx);
      for (;;) {
        if (pauseGate) {
          const gate = pauseGate;
          await gate;
          continue;
        }
        if (nextIndex >= chunks.length) return;
        const i = nextIndex;
        if (checkpoint!.mapSummaries[i] !== null) {
          nextIndex++;
          continue;
        }
        nextIndex++;
        const startedAt = Date.now();
        onChunkEvent?.({ chunkIndex: i, totalChunks: chunks.length, phase: "start" });
        const task = (async () => {
          for (;;) {
            const outcome = await attemptChunk(i, true, sleep);
            if (outcome.kind === "ok") {
              onChunkEvent?.({ chunkIndex: i, totalChunks: chunks.length, phase: "done", elapsedMs: Date.now() - startedAt });
              return;
            }
            await becomeLeaderAndTransition(i, outcome);
            // After a transition (as leader or follower), `chunks`/
            // `mapSummaries` may have changed shape entirely. Stop if this
            // index is no longer this worker's to do; otherwise retry it
            // against the fresh state.
            if (i >= chunks.length || checkpoint!.mapSummaries[i] !== null) return;
          }
        })();
        inFlight.set(i, task);
        try {
          await task;
        } finally {
          inFlight.delete(i);
        }
      }
    }

    const workerCount = Math.min(concurrency, chunks.length);
    const settled = await Promise.allSettled(Array.from({ length: workerCount }, (_, k) => worker(k)));
    // `allSettled` (never `all`) so every worker always runs to completion —
    // including the ones still draining behind a leader's pause gate when a
    // sibling worker's error is the one that ultimately dooms the run. That
    // keeps every rejection captured here instead of surfacing as a Node
    // "unhandled rejection" after `summarizeSession` has already returned.
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;
  }

  if (checkpoint.finalSummary === null) {
    // Every map slot is filled by the loop above — join deterministically,
    // no model call, no risk to the mandatory-verbatim sections. See
    // `joinChunkSummaries`'s header for why this is not a second map-reduce
    // phase.
    const mapped = checkpoint.mapSummaries as string[];
    checkpoint.finalSummary = joinChunkSummaries(mapped);
    checkpoint.updatedAt = nowIso();
    saveCheckpoint(options.checkpointPath, checkpoint);
  }

  return {
    summary: checkpoint.finalSummary,
    totalChunks: chunks.length,
    transcriptStats: stats,
    resumedFromCheckpoint,
    checkpointPath: options.checkpointPath,
    modelId: activeModel().id,
    fallbackEvents,
  };
}
