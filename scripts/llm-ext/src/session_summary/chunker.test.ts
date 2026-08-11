// Unit tests for chunker.ts — turn-boundary chunker for session-summary
// transcripts. Pure function, no I/O, no network.

import { describe, it, expect } from "vitest";
import { countTokens } from "gpt-tokenizer";
import {
  chunkTurns,
  classifyContextOverflow,
  estimateTokens,
  computeUsableTokenBudget,
  TOKEN_ESTIMATE_SAFETY_MARGIN,
} from "./chunker.js";
import type { Turn } from "./transcript.js";

function makeTurn(id: string, text: string, extra: Partial<Turn> = {}): Turn {
  return {
    role: "user",
    timestamp: `t-${id}`,
    uuid: id,
    parentUuid: null,
    text,
    toolCalls: [],
    errors: [],
    ...extra,
  };
}

describe("estimateTokens", () => {
  it("computes token counts from the real BPE tokenizer, not the old bytes/4 heuristic", () => {
    // "a" repeated compresses heavily under BPE — its real token count is
    // provably NOT text.length/4 (the old heuristic), and provably smaller.
    const text = "a".repeat(40);
    const naiveBytesOverFour = Math.ceil(Buffer.byteLength(text, "utf8") / 4);
    const real = countTokens(text);
    expect(real).not.toBe(naiveBytesOverFour);
    expect(real).toBeLessThan(naiveBytesOverFour);
  });

  it("applies TOKEN_ESTIMATE_SAFETY_MARGIN on top of the raw tokenizer count", () => {
    const text = "The quick brown fox jumps over the lazy dog, more than once. ".repeat(5);
    const raw = countTokens(text);
    expect(estimateTokens(text)).toBe(Math.ceil(raw * TOKEN_ESTIMATE_SAFETY_MARGIN));
  });

  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("chunkTurns", () => {
  it("throws on a non-positive maxTokens", () => {
    expect(() => chunkTurns([], { maxTokens: 0 })).toThrow();
    expect(() => chunkTurns([], { maxTokens: -5 })).toThrow();
    expect(() => chunkTurns([], { maxTokens: Number.NaN })).toThrow();
  });

  it("throws on a negative or non-integer overlapTurns", () => {
    expect(() => chunkTurns([], { maxTokens: 100, overlapTurns: -1 })).toThrow();
    expect(() => chunkTurns([], { maxTokens: 100, overlapTurns: 1.5 })).toThrow();
  });

  it("returns no chunks for an empty turn list", () => {
    const result = chunkTurns([], { maxTokens: 100 });
    expect(result.chunks).toEqual([]);
    expect(result.totalTurnsIn).toBe(0);
    expect(result.totalTurnsOut).toBe(0);
  });

  it("packs several small turns into a single chunk when they all fit the budget", () => {
    const turns = [makeTurn("1", "short a"), makeTurn("2", "short b"), makeTurn("3", "short c")];
    const result = chunkTurns(turns, { maxTokens: 1000, overlapTurns: 0 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].turns.map((t) => t.uuid)).toEqual(["1", "2", "3"]);
    expect(result.chunks[0].continuesNext).toBe(false);
    expect(result.chunks[0].continuesFromPrev).toBe(false);
  });

  it("splits into multiple chunks once the budget is exceeded, without exceeding it (overlapTurns=0)", () => {
    const turnText = "The quick brown fox jumps over the lazy dog. ".repeat(3);
    const perTurnTokens = estimateTokens(turnText);
    const turns = Array.from({ length: 10 }, (_, i) => makeTurn(String(i), turnText));
    const maxTokens = perTurnTokens * 2 + 1; // fits 2 turns but not 3
    const result = chunkTurns(turns, { maxTokens, overlapTurns: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("loses no original turn — every input turn's uuid appears in at least one chunk", () => {
    const turnText = "turn content padding padding ".repeat(3);
    const perTurnTokens = estimateTokens(turnText);
    const turns = Array.from({ length: 25 }, (_, i) => makeTurn(String(i), turnText));
    const result = chunkTurns(turns, { maxTokens: perTurnTokens * 3, overlapTurns: 2 });

    const seenUuids = new Set<string>();
    for (const chunk of result.chunks) {
      for (const t of chunk.turns) if (t.uuid) seenUuids.add(t.uuid);
    }
    for (const original of turns) {
      expect(seenUuids.has(original.uuid as string)).toBe(true);
    }
  });

  it("overlaps the last N turns of a chunk into the start of the next chunk", () => {
    const turnText = "The quick brown fox jumps over the lazy dog. ".repeat(3);
    const perTurnTokens = estimateTokens(turnText);
    const turns = Array.from({ length: 6 }, (_, i) => makeTurn(String(i), turnText));
    const result = chunkTurns(turns, { maxTokens: perTurnTokens * 2 + 1, overlapTurns: 2 });

    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    const first = result.chunks[0];
    const second = result.chunks[1];
    expect(first.continuesNext).toBe(true);
    expect(second.continuesFromPrev).toBe(true);

    const firstIds = first.turns.map((t) => t.uuid);
    const secondIds = second.turns.map((t) => t.uuid);
    const overlapIds = firstIds.filter((id) => secondIds.includes(id));
    expect(overlapIds.length).toBeGreaterThan(0);
  });

  it("does not mark overlap flags when overlapTurns=0", () => {
    const turnText = "The quick brown fox jumps over the lazy dog. ".repeat(3);
    const perTurnTokens = estimateTokens(turnText);
    const turns = Array.from({ length: 6 }, (_, i) => makeTurn(String(i), turnText));
    const result = chunkTurns(turns, { maxTokens: perTurnTokens * 2 + 1, overlapTurns: 0 });
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of result.chunks) {
      expect(chunk.continuesNext).toBe(false);
      expect(chunk.continuesFromPrev).toBe(false);
    }
  });

  // ── Turn atomicity (owner hard invariant, 2026-08-11) ─────────────────
  //
  // A chunk boundary may fall ONLY between turns; a turn is never split.
  // Each chunk is summarized independently and the summaries are later
  // joined with no reconciling model pass, so a split turn would describe
  // an action in one chunk and its result in another, with neither summary
  // able to see the other half.

  it("a single turn larger than maxTokens becomes its own chunk, intact — never split", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} of a huge tool_result, with some extra padding text`);
    const hugeText = lines.join("\n");
    const huge = makeTurn("huge", hugeText);
    const perLineTokens = estimateTokens(lines[0]);
    const maxTokens = perLineTokens * 5; // far smaller than the whole text
    const small = makeTurn("small", "ok");
    const result = chunkTurns([small, huge], { maxTokens, overlapTurns: 0, hardBudgetTokens: 1_000_000 });

    // The oversized turn lands in its OWN chunk, whole — never fragmented.
    const hugeChunk = result.chunks.find((c) => c.turns.some((t) => t.uuid === "huge"));
    expect(hugeChunk).toBeDefined();
    expect(hugeChunk!.turns).toHaveLength(1);
    expect(hugeChunk!.turns[0].text).toBe(hugeText); // byte-identical, no marker, no fragment
    expect(hugeChunk!.estimatedTokens).toBeGreaterThan(maxTokens); // over-cap, by design
    expect(result.totalTurnsOut).toBe(result.totalTurnsIn); // nothing split, nothing dropped
  });

  it("a single whole turn larger than the hard usable budget raises a clear error instead of being split", () => {
    const hugeText = Array.from({ length: 50 }, (_, i) => `line ${i} padding padding padding`).join("\n");
    const huge = makeTurn("too-big", hugeText, { role: "assistant" });
    const hardBudgetTokens = Math.floor(estimateTokens(hugeText) / 2); // strictly below the turn's own size

    expect(() => chunkTurns([huge], { maxTokens: 100, overlapTurns: 0, hardBudgetTokens })).toThrow(
      /exceeds the model's usable budget/,
    );
    // Names the offending turn, not just a generic overflow message.
    try {
      chunkTurns([huge], { maxTokens: 100, overlapTurns: 0, hardBudgetTokens });
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("assistant");
      expect(msg).toContain("too-big");
    }
  });

  it("hardBudgetTokens defaults to maxTokens when omitted, so an oversized turn fails loudly by default", () => {
    // A caller that never distinguishes the quality target from the
    // model's real ceiling gets the conservative default: maxTokens IS
    // the hard wall too, so an over-cap turn fails instead of silently
    // producing a chunk nobody declared safe to send.
    const hugeText = "x ".repeat(2000);
    const huge = makeTurn("no-hard-budget", hugeText);
    expect(() => chunkTurns([huge], { maxTokens: 10, overlapTurns: 0 })).toThrow(
      /exceeds the model's usable budget/,
    );
  });

  it("an oversized turn becomes its own over-cap chunk when hardBudgetTokens is explicitly larger than maxTokens", () => {
    const hugeText = "x ".repeat(2000);
    const huge = makeTurn("has-hard-budget", hugeText);
    const result = chunkTurns([huge], { maxTokens: 10, overlapTurns: 0, hardBudgetTokens: 1_000_000 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].turns[0].text).toBe(hugeText);
  });

  it("reassembling every chunk in order reproduces the original turn sequence exactly — no turn split, dropped, or duplicated", () => {
    const turnText = "turn content padding padding ".repeat(3);
    const perTurnTokens = estimateTokens(turnText);
    // Mix of ordinary turns and one oversized turn in the middle, to
    // exercise both the normal packer path and the lone-oversized-chunk
    // path in the same sequence.
    const oversizedText = Array.from({ length: 40 }, (_, i) => `oversized line ${i}`).join("\n");
    const turns = [
      ...Array.from({ length: 4 }, (_, i) => makeTurn(`a${i}`, turnText)),
      makeTurn("oversized", oversizedText),
      ...Array.from({ length: 4 }, (_, i) => makeTurn(`b${i}`, turnText)),
    ];
    const maxTokens = perTurnTokens * 2 + 1; // forces multiple chunks; oversized turn exceeds it alone
    const result = chunkTurns(turns, { maxTokens, overlapTurns: 0, hardBudgetTokens: 1_000_000 });

    // Chunk order is preserved (index is monotonically increasing)...
    expect(result.chunks.map((c) => c.index)).toEqual(result.chunks.map((_, i) => i));
    // ...and every turn appears in exactly one chunk, in original order,
    // with no boundary falling inside the oversized turn's text.
    const reassembledUuids = result.chunks.flatMap((c) => c.turns.map((t) => t.uuid));
    expect(reassembledUuids).toEqual(turns.map((t) => t.uuid));
    const oversizedChunk = result.chunks.find((c) => c.turns[0]?.uuid === "oversized" && c.turns.length === 1);
    expect(oversizedChunk).toBeDefined();
    expect(oversizedChunk!.turns[0].text).toBe(oversizedText);
  });

  it("an over-cap lone-turn chunk never participates in overlap seeding (neither direction)", () => {
    const turnText = "The quick brown fox jumps over the lazy dog. ".repeat(3);
    const perTurnTokens = estimateTokens(turnText);
    const oversizedText = Array.from({ length: 40 }, (_, i) => `oversized line ${i} with padding text`).join("\n");
    const turns = [
      makeTurn("a0", turnText),
      makeTurn("a1", turnText),
      makeTurn("oversized", oversizedText),
      makeTurn("b0", turnText),
      makeTurn("b1", turnText),
    ];
    const maxTokens = perTurnTokens * 2 + 1;
    const result = chunkTurns(turns, { maxTokens, overlapTurns: 2, hardBudgetTokens: 1_000_000 });

    const oversizedChunk = result.chunks.find((c) => c.turns[0]?.uuid === "oversized");
    expect(oversizedChunk).toBeDefined();
    expect(oversizedChunk!.continuesFromPrev).toBe(false);
    expect(oversizedChunk!.continuesNext).toBe(false);
    // The chunk right after it must not have been seeded with the
    // oversized turn as "overlap" — it would re-inflate that chunk with
    // the very bulk that made the turn oversized.
    const afterIdx = result.chunks.indexOf(oversizedChunk!) + 1;
    if (afterIdx < result.chunks.length) {
      expect(result.chunks[afterIdx].turns.some((t) => t.uuid === "oversized")).toBe(false);
    }
  });
});

describe("computeUsableTokenBudget", () => {
  it("returns context_length minus the reserved completion minus the measured prompt overhead", () => {
    const overheadText = "You are summarizing a coding session transcript. Follow these instructions exactly.";
    const overheadTokens = estimateTokens(overheadText);
    const result = computeUsableTokenBudget({
      contextLength: 100_000,
      maxCompletionTokens: 8_000,
      promptOverheadText: overheadText,
    });
    expect(result).toBe(100_000 - 8_000 - overheadTokens);
  });

  it("throws when the usable budget is non-positive", () => {
    expect(() =>
      computeUsableTokenBudget({
        contextLength: 1_000,
        maxCompletionTokens: 950,
        promptOverheadText: "padding text ".repeat(50),
      }),
    ).toThrow();
  });

  it("throws on a non-positive contextLength", () => {
    expect(() => computeUsableTokenBudget({ contextLength: 0, maxCompletionTokens: 10, promptOverheadText: "" })).toThrow();
    expect(() => computeUsableTokenBudget({ contextLength: -1, maxCompletionTokens: 10, promptOverheadText: "" })).toThrow();
  });

  it("throws on a negative maxCompletionTokens", () => {
    expect(() => computeUsableTokenBudget({ contextLength: 1000, maxCompletionTokens: -1, promptOverheadText: "" })).toThrow();
  });

  it("accepts a zero prompt overhead and a zero completion reserve", () => {
    const result = computeUsableTokenBudget({ contextLength: 1000, maxCompletionTokens: 0, promptOverheadText: "" });
    expect(result).toBe(1000);
  });
});

describe("classifyContextOverflow", () => {
  it("recognizes common real-world provider context-overflow phrasings", () => {
    const overflowMessages = [
      "400 This model's maximum context length is 4096 tokens. However, your messages resulted in 50000 tokens. Please reduce the length of the messages.",
      "context_length_exceeded: the input exceeds the model's context length",
      "Error: context length exceeded for this request",
      "input length and `max_tokens` exceed context limit: 20000 + 4096 > 16384",
      "too many tokens in the request payload",
      "413 Payload Too Large",
      "Request Entity Too Large",
      "prompt is too long: reduce it and try again",
      "This request exceeds the maximum number of tokens allowed",
    ];
    for (const msg of overflowMessages) {
      expect(classifyContextOverflow(msg), `expected overflow for: ${msg}`).toBe(true);
    }
  });

  it("does NOT classify a rate-limit / daily-quota / generic error as a context overflow", () => {
    const nonOverflowMessages = [
      "HTTP 429: rate limit exceeded, try again later",
      "daily limit exceeded for free-models-per-day",
      "402 insufficient credits",
      "404 No endpoints found for this model",
      "500 internal server error",
      "invalid API key",
    ];
    for (const msg of nonOverflowMessages) {
      expect(classifyContextOverflow(msg), `expected NOT overflow for: ${msg}`).toBe(false);
    }
  });

  it("handles empty/undefined-ish detail without throwing", () => {
    expect(classifyContextOverflow("")).toBe(false);
  });
});
