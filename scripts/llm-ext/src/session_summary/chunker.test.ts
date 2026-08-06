// Unit tests for chunker.ts — turn-boundary chunker for session-summary
// transcripts. Pure function, no I/O.

import { describe, it, expect } from "vitest";
import { chunkTurns, BYTES_PER_TOKEN_ESTIMATE } from "./chunker.js";
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
    // Each turn's text is exactly 40 bytes -> 10 tokens at BYTES_PER_TOKEN_ESTIMATE=4.
    const turnText = "x".repeat(40);
    const turns = Array.from({ length: 10 }, (_, i) => makeTurn(String(i), turnText));
    const maxTokens = 25; // fits 2 turns (20 tokens) but not 3 (30 tokens)
    const result = chunkTurns(turns, { maxTokens, overlapTurns: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("loses no original turn — every input turn's uuid appears in at least one chunk", () => {
    const turns = Array.from({ length: 25 }, (_, i) => makeTurn(String(i), `turn number ${i} `.repeat(3)));
    const result = chunkTurns(turns, { maxTokens: 30, overlapTurns: 2 });

    const seenUuids = new Set<string>();
    for (const chunk of result.chunks) {
      for (const t of chunk.turns) if (t.uuid) seenUuids.add(t.uuid);
    }
    for (const original of turns) {
      expect(seenUuids.has(original.uuid as string)).toBe(true);
    }
  });

  it("overlaps the last N turns of a chunk into the start of the next chunk", () => {
    const turnText = "x".repeat(40); // 10 tokens each
    const turns = Array.from({ length: 6 }, (_, i) => makeTurn(String(i), turnText));
    const result = chunkTurns(turns, { maxTokens: 25, overlapTurns: 2 });

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
    const turnText = "x".repeat(40);
    const turns = Array.from({ length: 6 }, (_, i) => makeTurn(String(i), turnText));
    const result = chunkTurns(turns, { maxTokens: 25, overlapTurns: 0 });
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of result.chunks) {
      expect(chunk.continuesNext).toBe(false);
      expect(chunk.continuesFromPrev).toBe(false);
    }
  });

  it("splits a single turn that alone exceeds the budget into [continued] pieces on line boundaries", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} of a huge tool_result`);
    const huge = makeTurn("huge", lines.join("\n"));
    const maxTokens = 50; // 50*4 = 200 bytes per chunk; the whole text is far larger
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
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const huge = makeTurn("huge2", lines.join("\n"), {
      toolCalls: [{ name: "Bash", argSummary: "command=ls" }],
      errors: ["boom"],
    });
    const result = chunkTurns([huge], { maxTokens: 20, overlapTurns: 0 });
    const pieces = result.chunks.flatMap((c) => c.turns);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0].toolCalls).toEqual([{ name: "Bash", argSummary: "command=ls" }]);
    expect(pieces[0].errors).toEqual(["boom"]);
    for (const p of pieces.slice(1)) {
      expect(p.toolCalls).toEqual([]);
      expect(p.errors).toEqual([]);
    }
  });

  it("never exceeds the budget on a per-piece basis even for an oversized turn (single-line exception aside)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `short${i}`);
    const huge = makeTurn("huge3", lines.join("\n"));
    const maxTokens = 10;
    const maxBytes = maxTokens * BYTES_PER_TOKEN_ESTIMATE;
    const result = chunkTurns([huge], { maxTokens, overlapTurns: 0 });
    const pieces = result.chunks.flatMap((c) => c.turns);
    for (const piece of pieces) {
      // Each piece's raw text (marker aside) should be close to the byte
      // budget — never wildly over it, since every line here is short.
      expect(Buffer.byteLength(piece.text, "utf8")).toBeLessThanOrEqual(maxBytes * 2);
    }
  });
});
