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

import type { Turn } from "./transcript.js";

// Heuristic token estimate: 1 token ≈ 4 bytes of UTF-8 text. This matches
// the same heuristic already used to size the 265 MB transcript in the
// TRDD (bytes/4 ≈ 66M tokens). Not a real tokenizer — kept as ONE named
// constant so every caller estimates the same way.
export const BYTES_PER_TOKEN_ESTIMATE = 4;

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
  const toolBytes = turn.toolCalls.reduce((sum, tc) => sum + tc.name.length + tc.argSummary.length, 0);
  const errorBytes = turn.errors.reduce((sum, e) => sum + Buffer.byteLength(e, "utf8"), 0);
  const totalBytes = Buffer.byteLength(turn.text, "utf8") + toolBytes + errorBytes;
  return Math.ceil(totalBytes / BYTES_PER_TOKEN_ESTIMATE);
}

/**
 * Split a single oversized turn into pieces on line boundaries so no piece
 * (except an unavoidably single huge line) exceeds the token budget.
 * toolCalls/errors are attached only to the first piece to avoid
 * duplicating them across every fragment.
 */
function splitOversizedTurn(turn: Turn, maxTokens: number): Turn[] {
  const maxBytes = Math.max(1, maxTokens * BYTES_PER_TOKEN_ESTIMATE);
  const lines = turn.text.split("\n");

  const pieces: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for the joining newline
    if (currentBytes + lineBytes > maxBytes && current.length > 0) {
      pieces.push(current.join("\n"));
      current = [];
      currentBytes = 0;
    }
    // A single line longer than the whole budget still gets its own piece
    // — content is never dropped, only split as finely as line boundaries allow.
    current.push(line);
    currentBytes += lineBytes;
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
