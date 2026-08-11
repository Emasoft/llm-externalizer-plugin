/**
 * Turn-boundary chunker for session-summary transcripts.
 *
 * Packs a pruned `Turn[]` (see transcript.ts) into `TranscriptChunk`s that
 * each fit under a token budget, so a chunk can be handed to a model whose
 * context window is `context_budget = min(model_ctx, --max-chunk-tokens)`.
 * This is deliberately a NEW packer, not a reuse of the existing FFD
 * file-list bin-packer in `scan-folder/core.ts` — that packer treats each
 * file as an opaque, unsplittable unit; a transcript needs to preserve turn
 * ORDER. See TRDD-T4MZ8YQR P2.
 *
 * HARD INVARIANT (owner, 2026-08-11): a chunk boundary may fall ONLY
 * between turns. A turn is ATOMIC and is NEVER split across chunks. Each
 * chunk is summarized independently and the per-chunk summaries are later
 * joined with NO second model pass to reconcile them (see driver.ts's
 * `joinChunkSummaries`) — splitting a turn would summarize its two halves
 * without each other's context (an action in one half, its result in the
 * other), producing a self-contradictory joined document that no amount of
 * prompt tuning can fix, because the information was destroyed at split
 * time. So a turn that alone exceeds the soft per-chunk target (`maxTokens`)
 * becomes its own chunk, whole and over-cap — `maxTokens` is a summarization
 * QUALITY target, not a hard wall. The only real hard wall is the model's
 * usable input budget (`hardBudgetTokens` — see `computeUsableTokenBudget`);
 * a turn that doesn't fit even alone under THAT budget can never be sent to
 * the model at all, so `chunkTurns` fails loudly up front naming the turn,
 * rather than silently producing a chunk request that would be rejected (or
 * worse, silently mutilating the turn to make it fit).
 */

import { countTokens } from "gpt-tokenizer";
import type { Turn } from "./transcript.js";

// Real BPE token count (o200k_base, via `gpt-tokenizer`) replaces the old
// bytes/4 heuristic. `gpt-tokenizer` was picked over `js-tiktoken` for this
// module because it ships ZERO runtime dependencies (js-tiktoken pulls in
// base64-js) and is pure JS/TS with no WASM binary — both matter here: this
// package is published through a security gate that flags unexplained
// dependencies and opaque binaries, and a pure-JS tokenizer keeps the
// dependency tree exactly as small as it was before this change. See the
// Phase A report for the full comparison.
//
// HONEST LIMITATION: the eligible free models this tool selects from
// (nemotron, gemma, and whatever else the OpenRouter catalog offers — see
// model-select.ts) do NOT use GPT/o200k tokenization. `countTokens` here is
// therefore an APPROXIMATION of what those models' own tokenizers would
// report, not ground truth. An approximation that happens to undercount
// would silently let a packed chunk overflow the real model's context
// window at request time — the same failure category bytes/4 caused, just
// smaller and harder to notice. `TOKEN_ESTIMATE_SAFETY_MARGIN` exists to
// absorb that gap: every count `estimateTokens()` returns is inflated by
// this factor before it is used for any packing decision. Do NOT remove it
// to "simplify" the math — the eligible model list changes catalog to
// catalog and none of them are guaranteed token-compatible with GPT.
export const TOKEN_ESTIMATE_SAFETY_MARGIN = 1.2;

/**
 * Real, safety-margined token count for `text`. The one function every
 * token-budget decision in this module goes through, so the margin above is
 * applied consistently everywhere (turn packing, oversized-turn splitting,
 * and `computeUsableTokenBudget`'s prompt-overhead measurement).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(countTokens(text) * TOKEN_ESTIMATE_SAFETY_MARGIN);
}

// Default number of trailing turns from a chunk that are repeated at the
// start of the next chunk, so a topic spanning the boundary is not lost
// to either chunk alone.
export const DEFAULT_OVERLAP_TURNS = 2;

export interface ChunkerOptions {
  /** Token budget per chunk. Must be a positive number. A soft QUALITY
   *  target — a turn that alone exceeds it still becomes its own chunk
   *  rather than being split (see the module header). */
  maxTokens: number;
  /** Trailing turns repeated into the next chunk. Default DEFAULT_OVERLAP_TURNS. */
  overlapTurns?: number;
  /** The hard, non-negotiable per-request budget a single request can never
   *  exceed — normally `computeUsableTokenBudget`'s result for the selected
   *  model. Defaults to `maxTokens` when omitted (matching every caller
   *  that doesn't yet distinguish the quality target from the model's real
   *  ceiling). A turn whose own token count exceeds this value can never be
   *  sent to the model even alone, so `chunkTurns` throws instead of
   *  producing an unsendable request or splitting the turn. */
  hardBudgetTokens?: number;
}

export interface TranscriptChunk {
  index: number;
  turns: Turn[];
  estimatedTokens: number;
  /** true when this chunk's trailing turns are also repeated at the start of the next chunk. */
  continuesNext: boolean;
  /** true when this chunk's leading turns were carried over from the previous chunk. */
  continuesFromPrev: boolean;
}

export interface ChunkResult {
  chunks: TranscriptChunk[];
  /** Turn count in the input. */
  totalTurnsIn: number;
  /** Turn count actually packed. A turn is never split or dropped, so this
   *  always equals `totalTurnsIn` — kept as a separate field for backward
   *  compatibility with callers that already destructure it as a sanity
   *  check. */
  totalTurnsOut: number;
}

/**
 * Pack `turns` into token-budgeted chunks, preserving order and never
 * splitting a turn (see the module header). A turn that alone exceeds
 * `maxTokens` becomes its own, over-cap chunk; a turn that exceeds
 * `hardBudgetTokens` (the real per-request ceiling) fails the whole call
 * loudly instead, since no chunk containing it could ever be sent.
 * `overlapTurns` turns are repeated across each chunk boundary, except
 * boundaries touching an over-cap chunk — overlap would re-inflate a
 * neighboring chunk with the very bulk that made the turn oversized.
 */
export function chunkTurns(turns: Turn[], options: ChunkerOptions): ChunkResult {
  const maxTokens = options.maxTokens;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error(`chunkTurns: maxTokens must be a positive finite number, got ${String(maxTokens)}`);
  }
  const overlapTurns = options.overlapTurns ?? DEFAULT_OVERLAP_TURNS;
  if (!Number.isInteger(overlapTurns) || overlapTurns < 0) {
    throw new Error(`chunkTurns: overlapTurns must be a non-negative integer, got ${String(overlapTurns)}`);
  }
  const hardBudgetTokens = options.hardBudgetTokens ?? maxTokens;
  if (!Number.isFinite(hardBudgetTokens) || hardBudgetTokens <= 0) {
    throw new Error(`chunkTurns: hardBudgetTokens must be a positive finite number, got ${String(hardBudgetTokens)}`);
  }

  // Fail fast, up front, on any turn that could never be sent to the model
  // even alone — see the module header. A turn is atomic: there is no way
  // to include it without splitting it (forbidden) or dropping it (also
  // forbidden), so the only honest outcome is to refuse before any model
  // call is attempted.
  for (const turn of turns) {
    const tokens = estimateTurnTokens(turn);
    if (tokens > hardBudgetTokens) {
      throw new Error(
        `chunkTurns: a single ${turn.role} turn (uuid=${turn.uuid ?? "unknown"}, timestamp=${turn.timestamp}) ` +
          `measures ~${tokens} tokens, which exceeds the model's usable budget of ${hardBudgetTokens} tokens ` +
          `even alone. A turn is never split across chunks, so this turn cannot be summarized by this model. ` +
          `Try a more aggressive --prune level, or select a model with a larger context window.`,
      );
    }
  }

  const chunks: TranscriptChunk[] = [];
  const oversized: boolean[] = []; // parallel to `chunks` — true for a lone over-cap turn
  let current: Turn[] = [];
  let currentTokens = 0;

  const flushNormal = (): void => {
    if (current.length === 0) return;
    chunks.push({
      index: chunks.length,
      turns: current,
      estimatedTokens: currentTokens,
      continuesNext: false, // filled in below once every chunk exists
      continuesFromPrev: false,
    });
    oversized.push(false);
  };

  for (const turn of turns) {
    const tokens = estimateTurnTokens(turn);
    if (tokens > maxTokens) {
      // The turn alone exceeds the soft target: flush whatever is pending,
      // then this turn becomes its own whole, over-cap chunk — never
      // split. Not eligible for overlap in either direction (see header).
      flushNormal();
      current = [];
      currentTokens = 0;
      chunks.push({
        index: chunks.length,
        turns: [turn],
        estimatedTokens: tokens,
        continuesNext: false,
        continuesFromPrev: false,
      });
      oversized.push(true);
      continue;
    }
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      flushNormal();
      // Seed the next chunk with the last `overlapTurns` turns of the
      // chunk just flushed — unless that chunk was itself an over-cap lone
      // turn, in which case overlap is skipped (see header).
      const prevIdx = chunks.length - 1;
      const prevWasOversized = oversized[prevIdx];
      const overlap = overlapTurns > 0 && !prevWasOversized ? chunks[prevIdx].turns.slice(-overlapTurns) : [];
      current = [...overlap];
      currentTokens = overlap.reduce((sum, t) => sum + estimateTurnTokens(t), 0);
    }
    current.push(turn);
    currentTokens += tokens;
  }
  flushNormal();

  for (let i = 0; i < chunks.length; i++) {
    if (oversized[i]) continue; // an over-cap chunk never participates in overlap
    if (i > 0 && !oversized[i - 1] && overlapTurns > 0) chunks[i].continuesFromPrev = true;
    if (i < chunks.length - 1 && !oversized[i + 1] && overlapTurns > 0) chunks[i].continuesNext = true;
  }

  return { chunks, totalTurnsIn: turns.length, totalTurnsOut: turns.length };
}

function estimateTurnTokens(turn: Turn): number {
  return estimateTokens(combinedTurnText(turn));
}

/** Turn text + tool-call summaries + error text, joined the same way every
 *  caller of `estimateTurnTokens` measures it. */
function combinedTurnText(turn: Turn): string {
  const toolText = turn.toolCalls.map((tc) => `${tc.name} ${tc.argSummary}`).join("\n");
  const errorText = turn.errors.join("\n");
  return [turn.text, toolText, errorText].filter((s) => s.length > 0).join("\n");
}

/**
 * True when `detail` names a genuine PROVIDER-SIDE context-overflow rejection
 * ("this input is too big for the model's window"), as distinct from a rate
 * limit (429/daily-cap — see free-rotation.ts's `classifyUnavailable`) or a
 * plain schema/auth error. This is the ground-truth check `estimateTokens`
 * above cannot replace: the eligible free models are NOT o200k-tokenized, so
 * our count is an estimate, and the provider's own rejection is the only
 * authoritative signal that a chunk really did overflow. The driver uses
 * this to re-split the offending chunk and retry — never to fail the run
 * outright, and never to swap models (a sizing problem is not an
 * availability problem).
 *
 * Deliberately narrow phrasing: generic words like "limit exceeded" or
 * "token limit" are excluded because providers reuse them for RATE limiting
 * too (see free-rotation.ts's own comment on that exact ambiguity) — a
 * false positive here would re-split a chunk that was actually just
 * rate-limited, burning cycles without fixing anything.
 */
export function classifyContextOverflow(detail: string): boolean {
  const s = (detail || "").toLowerCase();
  return (
    s.includes("context_length_exceeded") ||
    s.includes("maximum context length") ||
    s.includes("context length exceeded") ||
    (s.includes("context window") && (s.includes("exceed") || s.includes("too large") || s.includes("too long"))) ||
    s.includes("too many tokens") ||
    s.includes("input length and") || // OpenAI/OpenRouter's "input length and `max_tokens` exceed context limit"
    s.includes("please reduce the length") ||
    s.includes("reduce the length of the messages") ||
    s.includes("prompt is too long") ||
    s.includes("payload too large") ||
    s.includes("request entity too large") ||
    s.includes("maximum number of tokens allowed")
  );
}

export interface UsableTokenBudgetParams {
  /** The selected model's `context_length` (see model-select.ts's EligibleModel). */
  contextLength: number;
  /** The selected model's `top_provider.max_completion_tokens` — the reply reserve. */
  maxCompletionTokens: number;
  /**
   * The system/instruction preamble that will accompany every chunk request.
   * Measured with the SAME tokenizer as the transcript turns — guessing this
   * the way bytes/4 guessed the transcript's size would reintroduce exactly
   * the overflow bug this module exists to prevent.
   */
  promptOverheadText: string;
}

/**
 * usable_budget = context_length − reserved_completion_tokens − prompt_overhead_tokens
 *
 * Sizing chunks to the model's full `context_length` guarantees overflow the
 * moment the model starts generating a reply, because the completion counts
 * against the same context window as the prompt. `maxCompletionTokens` MUST
 * come from the selected model's own catalog entry — it varies model to
 * model, so a guessed constant here would just move the overflow bug rather
 * than fix it. Fails fast (never silently clamps to 0 or a negative budget)
 * when the model's context can't even hold its own reserved completion plus
 * the preamble — that means this model is unusable for the run, not that the
 * chunker should pretend otherwise.
 */
export function computeUsableTokenBudget(params: UsableTokenBudgetParams): number {
  const { contextLength, maxCompletionTokens, promptOverheadText } = params;
  if (!Number.isFinite(contextLength) || contextLength <= 0) {
    throw new Error(`computeUsableTokenBudget: contextLength must be a positive finite number, got ${String(contextLength)}`);
  }
  if (!Number.isFinite(maxCompletionTokens) || maxCompletionTokens < 0) {
    throw new Error(
      `computeUsableTokenBudget: maxCompletionTokens must be a non-negative finite number, got ${String(maxCompletionTokens)}`,
    );
  }

  const promptOverheadTokens = estimateTokens(promptOverheadText);
  const usable = contextLength - maxCompletionTokens - promptOverheadTokens;
  if (usable <= 0) {
    throw new Error(
      `computeUsableTokenBudget: usable budget is non-positive (context_length=${contextLength}, ` +
        `reserved_completion=${maxCompletionTokens}, prompt_overhead=${promptOverheadTokens}). This ` +
        `model's context cannot hold its own reserved completion plus the instruction preamble — ` +
        `select a different model rather than packing chunks into a budget that can't exist.`,
    );
  }
  return usable;
}
