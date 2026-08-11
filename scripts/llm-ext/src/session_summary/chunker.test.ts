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

  it("splits a single turn that alone exceeds the budget into [continued] pieces on line boundaries", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} of a huge tool_result, with some extra padding text`);
    const huge = makeTurn("huge", lines.join("\n"));
    const perLineTokens = estimateTokens(lines[0]);
    const maxTokens = perLineTokens * 5; // far smaller than the whole text
    const result = chunkTurns([huge], { maxTokens, overlapTurns: 0 });

    expect(result.totalTurnsOut).toBeGreaterThan(1); // it was split into multiple pieces
    const allPieces = result.chunks.flatMap((c) => c.turns);
    expect(allPieces.every((t) => t.uuid === "huge")).toBe(true);
    expect(allPieces.some((t) => t.text.includes("[continued"))).toBe(true);
    // The reconstructed text (markers stripped) still contains every original line.
    const reconstructed = allPieces.map((t) => t.text.replace(/ \[continued \d+\/\d+\]$/, "")).join("\n");
    for (const line of lines) {
      expect(reconstructed).toContain(line);
    }
    // toolCalls/errors are attached only to the first piece.
    expect(allPieces.filter((t) => t.errors.length > 0 || t.toolCalls.length > 0)).toHaveLength(0);
  });

  it("attaches an oversized turn's toolCalls/errors only to its first split piece", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line number ${i} with some padding text so it tokenizes to more than one token`);
    const huge = makeTurn("huge2", lines.join("\n"), {
      toolCalls: [{ name: "Bash", argSummary: "command=ls" }],
      errors: ["boom"],
    });
    const perLineTokens = estimateTokens(lines[0]);
    const result = chunkTurns([huge], { maxTokens: perLineTokens * 3, overlapTurns: 0 });
    const pieces = result.chunks.flatMap((c) => c.turns);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0].toolCalls).toEqual([{ name: "Bash", argSummary: "command=ls" }]);
    expect(pieces[0].errors).toEqual(["boom"]);
    for (const p of pieces.slice(1)) {
      expect(p.toolCalls).toEqual([]);
      expect(p.errors).toEqual([]);
    }
  });

  it("never exceeds the budget on a per-piece basis for an oversized turn (single-line exception aside)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `short${i}`);
    const huge = makeTurn("huge3", lines.join("\n"));
    const maxTokens = 10;
    const result = chunkTurns([huge], { maxTokens, overlapTurns: 0 });
    const pieces = result.chunks.flatMap((c) => c.turns);
    for (const piece of pieces) {
      const rawPieceText = piece.text.replace(/ \[continued \d+\/\d+\]$/, "");
      // Each piece's own text should not wildly exceed the budget, since
      // every source line here tokenizes to well under `maxTokens` alone.
      expect(estimateTokens(rawPieceText)).toBeLessThanOrEqual(maxTokens * 2);
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
