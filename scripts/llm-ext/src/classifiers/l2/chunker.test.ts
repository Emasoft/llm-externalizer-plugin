// L2-19: quicksilver chunker and chunk-merge rules (plan §5, E114-E118); pure functions, no doubles.
import { describe, expect, it } from "vitest";
import { assertChunkChars, chunkJsonState, chunkText, defaultLabel, mergeChunks, CHUNK_OVERLAP } from "./chunker.js";

const lines = (n: number, w = 99): string => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5, "0")} ${"x".repeat(w - 6)}`).join("\n") + "\n";

describe("chunkText", () => {
  it("returns one chunk covering all lines when the text fits", () => {
    expect(chunkText("a\nb\nc", 1000)).toEqual([{ text: "a\nb\nc", from: 1, to: 3 }]);
  });

  it("E114: splits at line ends, overlaps at most 500 chars on a line start, loses nothing", () => {
    const text = lines(300); // 30000 chars
    const chunks = chunkText(text, 5000);
    expect(chunks.length).toBeGreaterThan(5);
    chunks.forEach((c, i) => {
      expect(c.text.length).toBeLessThanOrEqual(5000);
      expect(c.text.endsWith("\n") || i === chunks.length - 1).toBe(true);
      expect(c.from).toBe(text.slice(0, text.indexOf(c.text)).split("\n").length);
      if (i > 0) {
        const prev = chunks[i - 1]!;
        expect(prev.text.length - prev.text.lastIndexOf(c.text.slice(0, 20))).toBeLessThanOrEqual(CHUNK_OVERLAP);
        expect(c.text.startsWith("0")).toBe(true); // snapped to a line start
        expect(c.from).toBeLessThanOrEqual(prev.to + 1);
      }
    });
    expect(chunks.at(-1)!.to).toBe(300);
    expect(chunks.at(-1)!.text.endsWith(text.slice(-100))).toBe(true);
  });

  it("E115: with no newline in reach the cut falls mid-line and the next chunk overlaps by at most 500", () => {
    const text = "y".repeat(2500);
    const chunks = chunkText(text, 1000);
    // starts at 0, 500, 1000, 1500: each next chunk begins exactly 500 chars before the previous end
    expect(chunks.map((c) => c.text.length)).toEqual([1000, 1000, 1000, 1000]);
    expect(chunks.every((c) => c.from === 1 && c.to === 1)).toBe(true);
  });

  it("cuts mid-line when the last newline is closer than 500 chars to the chunk start", () => {
    const text = `${"a".repeat(100)}\n${"b".repeat(3000)}`;
    const [first] = chunkText(text, 1000);
    expect(first!.text.length).toBe(1000);
  });

  it("rejects chunk-chars outside 1000-90000", () => {
    expect(() => assertChunkChars(999)).toThrow(/chunk-chars/);
    expect(() => assertChunkChars(90001)).toThrow(/chunk-chars/);
    expect(() => chunkText("x", 500)).toThrow(/chunk-chars/);
  });
});

describe("chunkJsonState", () => {
  it("keeps a state that fits as one group", () => {
    expect(chunkJsonState({ a: 1 }, 1000)).toEqual({ ok: true, groups: [{ a: 1 }], entries: [["a"]] });
  });

  it("groups whole top-level entries of an object and of an array", () => {
    const obj = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, "v".repeat(400)]));
    const r = chunkJsonState(obj, 1000);
    if (!r.ok) throw new Error("refused");
    expect(r.groups.length).toBeGreaterThan(1);
    expect(Object.assign({}, ...(r.groups as object[]))).toEqual(obj);
    r.groups.forEach((g) => expect(JSON.stringify(g).length).toBeLessThanOrEqual(1000));
    const arr = Array.from({ length: 6 }, (_, i) => "v".repeat(400) + i);
    const a = chunkJsonState(arr, 1000);
    if (!a.ok) throw new Error("refused");
    expect((a.groups as unknown[][]).flat()).toEqual(arr);
  });

  it("E116: one entry larger than a chunk is refused naming its key", () => {
    const r = chunkJsonState({ small: "s", huge: "h".repeat(1500) }, 1000);
    expect(r).toMatchObject({ ok: false, key: "huge" });
  });
});


describe("chunker review fixes", () => {
  it("2: a mid-line cut never splits a surrogate pair", () => {
    const text = "a" + "😀".repeat(3000); // pairs start at odd indices, so a cut at 1000 lands between a high and a low unit
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    chunks.forEach((c) => expect(lone.test(c.text)).toBe(false));
  });

  it("4: chunkJsonState reports the original entry keys or indices of each group", () => {
    const obj = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, "v".repeat(400)]));
    const r = chunkJsonState(obj, 1000);
    if (!r.ok) throw new Error("refused");
    expect(r.entries.flat()).toEqual(Object.keys(obj));
    const a = chunkJsonState(Array.from({ length: 6 }, () => "v".repeat(400)), 1000);
    if (!a.ok) throw new Error("refused");
    expect(a.entries.flat()).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(a.entries.length).toBe(a.groups.length);
  });
});

const noulPart = (noul: number, from = 1, to = 2) => ({ answer: { type: "noul" as const, noul }, from, to });
const choicePart = (choice: string, confidence?: number) => ({ answer: { type: "choice" as const, choice, tie: false, ...(confidence === undefined ? {} : { confidence }) } });

describe("mergeChunks", () => {
  it("noul: the highest decides and its lines are reported", () => {
    const m = mergeChunks([noulPart(0.2, 1, 10), noulPart(0.9, 9, 20), noulPart(0.5, 19, 30)]);
    expect(m).toMatchObject({ chunks: 3, best_chunk: 2, best_lines: [9, 20], answer: { noul: 0.9 } });
  });

  it("score: the highest score decides", () => {
    const m = mergeChunks([{ answer: { type: "score" as const, score: 1 } }, { answer: { type: "score" as const, score: 3 } }]);
    expect(m.best_chunk).toBe(2);
    expect(m.best_lines).toBeUndefined();
  });

  it("E118: a tie goes to the earliest chunk", () => {
    expect(mergeChunks([noulPart(0.7), noulPart(0.7), noulPart(0.7)]).best_chunk).toBe(1);
  });

  it("choice: a default-label chunk does not vote even when more confident", () => {
    const m = mergeChunks([choicePart("other", 0.99), choicePart("cli", 0.9), choicePart("other", 0.99), choicePart("api", 0.6)], "other");
    expect(m.answer).toMatchObject({ choice: "cli" });
    expect(m.best_chunk).toBe(2);
  });

  it("E117: every chunk on the default gives the default at its best confidence", () => {
    const m = mergeChunks([choicePart("other", 0.5), choicePart("other", 0.8), choicePart("other", 0.8)], "other");
    expect(m).toMatchObject({ best_chunk: 2, answer: { choice: "other", confidence: 0.8 } });
  });

  it("a missing confidence counts as lowest", () => {
    expect(mergeChunks([choicePart("a"), choicePart("b", 0.1)], "z").best_chunk).toBe(2);
    expect(mergeChunks([choicePart("a"), choicePart("b")], "z").best_chunk).toBe(1);
  });

  it("a choice merge without a default label is refused", () => {
    expect(() => mergeChunks([choicePart("a", 0.5)])).toThrow(/default/);
  });
});

describe("defaultLabel", () => {
  it("is the last label unless an explicit label is given, which must exist", () => {
    expect(defaultLabel(["a", "b", "c"])).toBe("c");
    expect(defaultLabel(["a", "b", "c"], "a")).toBe("a");
    expect(() => defaultLabel(["a", "b"], "zz")).toThrow(/one of the labels/);
  });
});
