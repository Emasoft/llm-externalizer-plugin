/**
 * Map-reduce driver for session-summary — TRDD-T4MZ8YQR P4.
 *
 * Orchestrates the pipeline built in P1-P3: stream + prune the transcript
 * (transcript.ts), pack it into token-budgeted chunks (chunker.ts), then
 *
 *   MAP    — summarize each chunk independently.
 *   REDUCE — fold the chunk summaries into one session summary, RECURSING
 *            when a fold level itself would still exceed the model's
 *            window. The TRDD measured a 265 MB / ~66M-token transcript
 *            against the ONE eligible 1M-context free model — that is
 *            ~66 full windows just for the map phase, so a single reduce
 *            pass over 66 summaries is not guaranteed to fit either; the
 *            fold must be able to fold its own output again.
 *
 * CHECKPOINTING is the load-bearing part, not an afterthought. At the
 * default 1M context floor exactly ONE free model qualifies (P3's
 * `selectEligibleModels`), so there is no rotation partner once its daily
 * cap hits mid-run — an interruption is the EXPECTED outcome of a long
 * run, not an edge case. Every successful map chunk and every successful
 * reduce fold is persisted to `checkpointPath` immediately, and a resumed
 * run verifies the checkpoint was produced from the SAME transcript (path
 * + size + mtime) with the SAME prune level and chunking params before
 * reusing a single byte of it — resuming against a changed input silently
 * would produce a summary that is wrong in a way nobody could detect.
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
 */

import { statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { assertFreeOnlyModel } from "../config.js";
import { classifyUnavailable } from "../free-rotation.js";
import { readTranscript, type PruneLevel, type Turn, type TranscriptStats } from "./transcript.js";
import {
  chunkTurns,
  DEFAULT_OVERLAP_TURNS,
  BYTES_PER_TOKEN_ESTIMATE,
  type TranscriptChunk,
} from "./chunker.js";

/** Tokens reserved out of the model's context window for prompt wrapper text
 *  (instructions) plus the completion itself — the chunk/fold BODY must fit
 *  in what's left. A heuristic margin, not a precise accounting; generous
 *  enough that the wrapper text this module actually writes never blows it. */
export const PROMPT_OVERHEAD_TOKENS = 2_000;

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
  callModel: CallModelFn;
  /** Default "aggressive" — matches the CLI layer's documented default (P5 TRDD note). */
  pruneLevel?: PruneLevel;
  chunkOverlapTurns?: number;
  /** Token budget per chunk/fold. Default: modelMaxContext minus completion
   *  headroom minus PROMPT_OVERHEAD_TOKENS. */
  maxChunkTokens?: number;
  /** Bounded retries for a non-availability (real bug/schema) failure before
   *  the run fails. Rate-limit-shaped failures are NEVER retried here — see
   *  `callWithRetry`. Default 2 (three attempts total). */
  maxRetriesPerChunk?: number;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => string;
}

export interface SummarizeSessionResult {
  summary: string;
  totalChunks: number;
  transcriptStats: TranscriptStats;
  /** True when this run resumed work already recorded in the checkpoint. */
  resumedFromCheckpoint: boolean;
  checkpointPath: string;
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

/** Fold-in-progress state for the current reduce level. `levelInput` is the
 *  full array of summaries being folded at this level; `foldedSoFar` holds
 *  the outputs already produced for its leading batches (in order), so a
 *  resume can compute the SAME batches deterministically (packIntoBatches
 *  is pure) and know exactly how many are already done. */
interface ReduceProgress {
  level: number;
  levelInput: string[];
  foldedSoFar: string[];
}

interface Checkpoint {
  version: 1;
  identity: CheckpointIdentity;
  totalChunks: number;
  /** One slot per chunk; null until that chunk's map summary lands. */
  mapSummaries: (string | null)[];
  reduce: ReduceProgress | null;
  finalSummary: string | null;
  updatedAt: string;
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

// ── Retry wrapper ────────────────────────────────────────────────────────

/**
 * Call `callModel` with a bounded number of retries — but ONLY for a
 * genuine (non-availability) failure. A rate-limit / daily-cap / provider-
 * gone error (per the project's own `classifyUnavailable` classifier, the
 * single source of truth for "should we back off?") is NEVER retried here:
 * retrying immediately just re-hits the same wall, and the TRDD is explicit
 * that this must checkpoint and surface an actionable message instead of
 * retrying forever. The checkpoint already holds every unit of work
 * completed before this one, so the thrown message always names the
 * checkpoint path to resume from.
 */
async function callWithRetry(
  prompt: string,
  modelId: string,
  maxOutputTokens: number,
  callModel: CallModelFn,
  maxRetries: number,
  label: string,
  checkpointPath: string,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callModel(prompt, modelId, maxOutputTokens);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (classifyUnavailable(msg) !== null) {
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

function renderChunkPrompt(chunk: TranscriptChunk): string {
  const continuation = [
    chunk.continuesFromPrev ? "continues from the previous part" : null,
    chunk.continuesNext ? "continues into the next part" : null,
  ]
    .filter((s): s is string => s !== null)
    .join("; ");
  const header =
    `You are summarizing part ${chunk.index + 1} of a Claude Code coding session transcript` +
    `${continuation ? ` (${continuation})` : ""}. Produce a dense, factual summary of what ` +
    `happened: user requests, decisions made, files changed, commands run, and outcomes. Do not ` +
    `editorialize or pad — this summary will itself be folded together with summaries of the other parts.`;
  const body = chunk.turns.map(renderTurn).join("\n\n");
  return `${header}\n\n${body}`;
}

function renderFoldPrompt(summaries: readonly string[]): string {
  const header =
    `You are folding ${summaries.length} partial summaries of one Claude Code session into a ` +
    `single, coherent summary. Preserve every distinct fact (requests, decisions, files changed, ` +
    `commands run, outcomes); do not drop information for brevity — merge duplicates instead.`;
  const body = summaries.map((s, i) => `--- part ${i + 1} ---\n${s}`).join("\n\n");
  return `${header}\n\n${body}`;
}

// ── Batch packing for the reduce phase (pure — mirrors chunker.ts's packer,
// but over plain summary strings instead of Turns, since a fold input has
// no turn-boundary or tool-call structure to preserve). ───────────────────

function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN_ESTIMATE);
}

/** Pack `items` into token-budgeted batches, never splitting an item (a
 *  chunk/fold summary is treated as atomic — it is already dense prose, not
 *  raw transcript text, so there is no meaningful line boundary to split
 *  it on the way `chunker.ts` splits an oversized turn). */
export function packIntoBatches(items: readonly string[], maxTokens: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const item of items) {
    const tokens = estimateTextTokens(item);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ── The driver ────────────────────────────────────────────────────────────

/**
 * Summarize a whole session transcript via map-reduce, checkpointing after
 * every completed unit of work (map chunk or reduce fold) so an interrupted
 * run resumes instead of restarting.
 */
export async function summarizeSession(
  options: SummarizeSessionOptions,
): Promise<SummarizeSessionResult> {
  const pruneLevel = options.pruneLevel ?? "aggressive";
  const overlapTurns = options.chunkOverlapTurns ?? DEFAULT_OVERLAP_TURNS;
  const maxChunkTokens =
    options.maxChunkTokens ??
    Math.max(1_000, options.modelMaxContext - options.modelMaxCompletionTokens - PROMPT_OVERHEAD_TOKENS);
  const maxRetries = options.maxRetriesPerChunk ?? 2;
  const nowIso = options.now ?? (() => new Date().toISOString());

  // Cost-safety chokepoint (TRDD-T4MZ8YQR: "$0 by construction"). This is
  // HARDCODED true, not threaded from any caller option — unlike every
  // other subsystem in this project, session-summary has no way to opt into
  // paid spend at all. Checked before any file IO / chunking work, so a
  // misconfigured modelId fails in milliseconds, not after chunking a
  // multi-hundred-MB transcript.
  assertFreeOnlyModel(true, "openrouter", options.modelId);

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
  const { chunks } = chunkTurns(turns, { maxTokens: maxChunkTokens, overlapTurns });

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
      reduce: null,
      finalSummary: null,
      updatedAt: nowIso(),
    };
  }

  // ── MAP: summarize each chunk, checkpointing after every success.
  for (let i = 0; i < chunks.length; i++) {
    if (checkpoint.mapSummaries[i] !== null) continue; // already done — resume
    const summary = await callWithRetry(
      renderChunkPrompt(chunks[i]),
      options.modelId,
      options.modelMaxCompletionTokens,
      options.callModel,
      maxRetries,
      `chunk ${i}`,
      options.checkpointPath,
    );
    checkpoint.mapSummaries[i] = summary;
    checkpoint.updatedAt = nowIso();
    saveCheckpoint(options.checkpointPath, checkpoint);
  }

  if (checkpoint.finalSummary !== null) {
    return {
      summary: checkpoint.finalSummary,
      totalChunks: chunks.length,
      transcriptStats: stats,
      resumedFromCheckpoint,
      checkpointPath: options.checkpointPath,
    };
  }

  // ── REDUCE: fold chunk summaries into one, recursing whenever a fold
  // level's own output still needs folding (a summary-of-summaries can
  // itself exceed the budget on a large enough transcript).
  const mapped = checkpoint.mapSummaries as string[]; // every slot filled by the loop above

  if (!checkpoint.reduce) {
    if (mapped.length === 1) {
      checkpoint.finalSummary = mapped[0];
      checkpoint.updatedAt = nowIso();
      saveCheckpoint(options.checkpointPath, checkpoint);
      return {
        summary: mapped[0],
        totalChunks: chunks.length,
        transcriptStats: stats,
        resumedFromCheckpoint,
        checkpointPath: options.checkpointPath,
      };
    }
    checkpoint.reduce = { level: 0, levelInput: mapped, foldedSoFar: [] };
    checkpoint.updatedAt = nowIso();
    saveCheckpoint(options.checkpointPath, checkpoint);
  }

  const foldBudget = maxChunkTokens; // the same budget chunks were packed to

  for (;;) {
    const rp: ReduceProgress | null = checkpoint.reduce;
    if (!rp) break; // unreachable: only null right after finalSummary is set, which exits the loop below

    const batches = packIntoBatches(rp.levelInput, foldBudget);
    if (batches.length >= rp.levelInput.length && rp.levelInput.length > 1) {
      // No progress possible: packing produced as many (or more) batches as
      // inputs, meaning at least one summary alone exceeds the fold budget.
      // Recursing forever here would be an infinite loop disguised as
      // progress — fail fast instead, naming the actionable fix.
      throw new Error(
        `session-summary: cannot fold ${rp.levelInput.length} summaries at reduce level ${rp.level} ` +
          `into fewer batches under a ${foldBudget}-token budget — at least one summary alone ` +
          `exceeds the budget. Increase --max-chunk-tokens or pick a model with more context. ` +
          `Checkpoint saved at ${options.checkpointPath}.`,
      );
    }

    for (let b = rp.foldedSoFar.length; b < batches.length; b++) {
      const batch = batches[b];
      const folded =
        batch.length === 1
          ? batch[0] // a lone item passes through untouched — nothing to fold
          : await callWithRetry(
              renderFoldPrompt(batch),
              options.modelId,
              options.modelMaxCompletionTokens,
              options.callModel,
              maxRetries,
              `reduce level ${rp.level} batch ${b}`,
              options.checkpointPath,
            );
      rp.foldedSoFar.push(folded);
      checkpoint.updatedAt = nowIso();
      saveCheckpoint(options.checkpointPath, checkpoint);
    }

    if (rp.foldedSoFar.length === 1) {
      checkpoint.finalSummary = rp.foldedSoFar[0];
      checkpoint.reduce = null;
      checkpoint.updatedAt = nowIso();
      saveCheckpoint(options.checkpointPath, checkpoint);
      break;
    }

    checkpoint.reduce = { level: rp.level + 1, levelInput: rp.foldedSoFar, foldedSoFar: [] };
    checkpoint.updatedAt = nowIso();
    saveCheckpoint(options.checkpointPath, checkpoint);
  }

  return {
    summary: checkpoint.finalSummary as string,
    totalChunks: chunks.length,
    transcriptStats: stats,
    resumedFromCheckpoint,
    checkpointPath: options.checkpointPath,
  };
}
