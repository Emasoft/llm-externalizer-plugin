// L2-19, plan §5 and D28: the quicksilver 0.3.0 chunker and chunk-merge rules, re-implemented from its behaviour spec (qs.mjs chunkText, mergeChunks, chunkState; MIT, credited in NOTICE).
// Nothing sent is truncated: a text longer than one chunk becomes several chunks that each fit, never a clipped one.
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import type { NoulAnswer } from "../l1/validate.js";
import type { ScoreAnswer } from "../l1/validate-score.js";

export const CHUNK_CHARS_DEFAULT = 60000;
export const CHUNK_CHARS_MIN = 1000;
export const CHUNK_CHARS_MAX = 90000;
// Why 500: a match that straddles a cut is whole in one of the two chunks.
export const CHUNK_OVERLAP = 500;

// Why throw: a --chunk-chars outside the range is a caller bug; clamping would send chunks the user did not ask for.
export function assertChunkChars(n: number): void {
  if (!Number.isInteger(n) || n < CHUNK_CHARS_MIN || n > CHUNK_CHARS_MAX) throw new Error(`chunk-chars must be an integer from ${CHUNK_CHARS_MIN} to ${CHUNK_CHARS_MAX}, got ${String(n)}`);
}

export interface TextChunk { text: string; from: number; to: number }

function countNewlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = s.indexOf("\n", from); i !== -1 && i < to; i = s.indexOf("\n", i + 1)) n++;
  return n;
}


// True when a cut at `i` would fall between a high and a low surrogate.
function splitsPair(s: string, i: number): boolean {
  const hi = s.charCodeAt(i - 1);
  const lo = s.charCodeAt(i);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

// Cut rule of §5: end pulled back to just after the last newline if that newline is at least 500 chars past the chunk start, else cut mid-line; the next chunk starts 500 chars before the end, snapped forward to a line start; from/to are 1-based lines.
export function chunkText(text: string, chunkChars: number): TextChunk[] {
  assertChunkChars(chunkChars);
  const out: TextChunk[] = [];
  let start = 0;
  let line = 1;
  for (;;) {
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1);
      if (nl >= start + CHUNK_OVERLAP) end = nl + 1;
      // Why back by one: a cut between a high and a low surrogate would send two lone halves of an emoji; a newline cut can never land there.
      else if (splitsPair(text, end)) end -= 1;
    }
    out.push({ text: text.slice(start, end), from: line, to: line + countNewlines(text, start, end - 1) });
    if (end >= text.length) return out;
    // Why this always moves forward: end - start > CHUNK_OVERLAP (chunkChars >= 1000, and a newline cut is >= start + 500 + 1).
    let next = end - CHUNK_OVERLAP;
    const nl = text.indexOf("\n", next);
    if (nl !== -1 && nl < end - 1) next = nl + 1;
    // Why forward by one: the next chunk must not open on the low half of a pair either.
    else if (splitsPair(text, next)) next += 1;
    line += countNewlines(text, start, next);
    start = next;
  }
}

// entries[i] names the original top-level keys (object) or indices (array, as strings) of groups[i], so a reference into the state can be mapped back (D5).
export type JsonChunks = { ok: true; groups: unknown[]; entries: string[][] } | { ok: false; key: string; chars: number };

// E116: an object or array larger than one chunk is split into groups of whole top-level entries; one entry larger than a chunk is refused naming its key (an array entry is named by index), because splitting it would break references into it.
export function chunkJsonState(state: unknown, chunkChars: number): JsonChunks {
  assertChunkChars(chunkChars);
  const size = (v: unknown): number => JSON.stringify(v).length;
  if (size(state) <= chunkChars) return { ok: true, groups: [state], entries: [state !== null && typeof state === "object" ? Object.keys(state) : []] };
  if (state === null || typeof state !== "object") throw new Error(`a ${typeof state} state is larger than one chunk (chunk-chars ${chunkChars}) and cannot be split`);
  const isArray = Array.isArray(state);
  const entries: [string, unknown][] = isArray ? state.map((v, i) => [String(i), v]) : Object.entries(state);
  const groups: [string, unknown][][] = [];
  let cur: [string, unknown][] = [];
  let len = 2;
  for (const e of entries) {
    const n = isArray ? size(e[1]) : size(e[0]) + 1 + size(e[1]);
    if (n + 2 > chunkChars) return { ok: false, key: e[0], chars: n };
    if (cur.length > 0 && len + n + 1 > chunkChars) { groups.push(cur); cur = []; len = 2; }
    cur.push(e);
    len += n + 1;
  }
  groups.push(cur);
  return { ok: true, groups: groups.map((g) => (isArray ? g.map((e) => e[1]) : Object.fromEntries(g))), entries: groups.map((g) => g.map((e) => e[0])) };
}

export type ChunkAnswer = NoulAnswer | ScoreAnswer | ChoiceAnswer;
export interface ChunkPart<A extends ChunkAnswer = ChunkAnswer> { answer: A; from?: number; to?: number }
export interface MergedAnswer<A extends ChunkAnswer = ChunkAnswer> { answer: A; chunks: number; best_chunk: number; best_lines?: [number, number] }

// §5 default label: --default when given (must be a label), else the last label.
export function defaultLabel(labels: string[], explicit?: string): string {
  if (explicit === undefined) {
    const last = labels.at(-1);
    if (last === undefined) throw new Error("a choice needs at least one label");
    return last;
  }
  if (!labels.includes(explicit)) throw new Error(`default must be one of the labels: ${labels.join(", ")}`);
  return explicit;
}

// §5 merge, E117/E118: highest noul / score / confidence decides, never an average. A choice chunk whose label is the default does not vote (else four unremarkable catch-all chunks hide one real one); with no voting chunk the default wins at its best confidence. Ties go to the earliest chunk (strict >), a missing confidence is lowest.
export function mergeChunks<A extends ChunkAnswer>(parts: ChunkPart<A>[], dflt?: string): MergedAnswer<A> {
  if (parts.length === 0) throw new Error("mergeChunks needs at least one chunk");
  const value = (p: ChunkPart<A>): number => {
    const a = p.answer;
    return (a.type === "noul" ? a.noul : a.type === "score" ? a.score : a.confidence) ?? -Infinity;
  };
  const isChoice = parts[0]!.answer.type === "choice";
  // Why throw: without the default every catch-all chunk would vote and the rule would silently not apply.
  if (isChoice && dflt === undefined) throw new Error("a choice merge needs the default label");
  const votes = parts.filter((p) => !(p.answer.type === "choice" && p.answer.choice === dflt));
  const pool = votes.length > 0 ? votes : parts;
  const best = pool.reduce((x, y) => (value(y) > value(x) ? y : x));
  return { answer: best.answer, chunks: parts.length, best_chunk: parts.indexOf(best) + 1, ...(best.from === undefined || best.to === undefined ? {} : { best_lines: [best.from, best.to] as [number, number] }) };
}
