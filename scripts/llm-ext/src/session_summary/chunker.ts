/**
 * Turn-boundary chunker for session-summary transcripts.
 *
 * Packs a pruned `Turn[]` (see transcript.ts) into `TranscriptChunk`s that
 * each fit under a token budget, so a chunk can be handed to a model whose
 * context window is `context_budget = min(model_ctx, --max-chunk-tokens)`.
 * This is deliberately a NEW packer, not a reuse of the existing FFD
 * file-list bin-packer in `scan-folder/core.ts` — that packer treats each
 * file as an opaque, unsplittable unit; a transcript needs to preserve
 * turn ORDER and to split a turn only as a last resort, on line
 * boundaries, never mid-line. See TRDD-T4MZ8YQR P2.
 *
 * A single turn that alone exceeds the budget (a giant tool_result under
 * `--prune none`, for instance) is split into `[continued N/M]` pieces on
 * line boundaries before packing — content is never dropped to fit.
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
  /** Token budget per chunk. Must be a positive number. */
  maxTokens: number;
  /** Trailing turns repeated into the next chunk. Default DEFAULT_OVERLAP_TURNS. */
  overlapTurns?: number;
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
  /** Turn count in the input, before any oversized-turn splitting. */
  totalTurnsIn: number;
  /** Turn count actually packed, after oversized-turn splitting (split pieces count individually). */
  totalTurnsOut: number;
}

/**
 * Pack `turns` into token-budgeted chunks, preserving order, splitting a
 * turn only when it alone exceeds `maxTokens`, and overlapping
 * `overlapTurns` turns across each chunk boundary.
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

  // Expand any turn that alone exceeds the budget into `[continued]`
  // pieces BEFORE packing, so the packer only ever handles turns that fit
  // the budget individually.
  const expanded: Turn[] = [];
  for (const turn of turns) {
    if (estimateTurnTokens(turn) > maxTokens) {
      expanded.push(...splitOversizedTurn(turn, maxTokens));
    } else {
      expanded.push(turn);
    }
  }

  const chunks: TranscriptChunk[] = [];
  let current: Turn[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({
      index: chunks.length,
      turns: current,
      estimatedTokens: currentTokens,
      continuesNext: false, // filled in below once every chunk exists
      continuesFromPrev: false,
    });
  };

  for (const turn of expanded) {
    const tokens = estimateTurnTokens(turn);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      flush();
      // Seed the next chunk with the last `overlapTurns` turns of the
      // chunk just flushed. This can push the new chunk slightly over
      // budget once the next turn is added — that is the accepted
      // trade-off of overlap; the strict budget guarantee only holds
      // with overlapTurns=0.
      const prevTurns = chunks[chunks.length - 1].turns;
      const overlap = overlapTurns > 0 ? prevTurns.slice(-overlapTurns) : [];
      current = [...overlap];
      currentTokens = overlap.reduce((sum, t) => sum + estimateTurnTokens(t), 0);
    }
    current.push(turn);
    currentTokens += tokens;
  }
  flush();

  for (let i = 0; i < chunks.length; i++) {
    chunks[i].continuesFromPrev = i > 0 && overlapTurns > 0;
    chunks[i].continuesNext = i < chunks.length - 1 && overlapTurns > 0;
  }

  return { chunks, totalTurnsIn: turns.length, totalTurnsOut: expanded.length };
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
 * Split a single oversized turn into pieces on line boundaries so no piece
 * (except an unavoidably single huge line) exceeds the token budget.
 * toolCalls/errors are attached only to the first piece to avoid
 * duplicating them across every fragment.
 */
function splitOversizedTurn(turn: Turn, maxTokens: number): Turn[] {
  const lines = turn.text.split("\n");

  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > maxTokens && current.length > 0) {
      pieces.push(current.join("\n"));
      current = [];
      currentTokens = 0;
    }
    // A single line longer than the whole budget still gets its own piece
    // — content is never dropped, only split as finely as line boundaries allow.
    current.push(line);
    currentTokens += lineTokens;
  }
  if (current.length > 0 || pieces.length === 0) pieces.push(current.join("\n"));

  return pieces.map((text, i) => {
    const marker = pieces.length > 1 ? ` [continued ${i + 1}/${pieces.length}]` : "";
    return {
      role: turn.role,
      timestamp: turn.timestamp,
      uuid: turn.uuid,
      parentUuid: turn.parentUuid,
      text: `${text}${marker}`,
      toolCalls: i === 0 ? turn.toolCalls : [],
      errors: i === 0 ? turn.errors : [],
    };
  });
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
