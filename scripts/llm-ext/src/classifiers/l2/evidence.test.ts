import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Built, ProjectCtx } from "../catalog/spec.js";
import { estimateTokens } from "../l1/estimate.js";
import { buildEvidence, cutToTokens, sourceFromSnippet } from "./evidence.js";
import { readForJev } from "./inputs.js";

describe("buildEvidence", () => {
  it("gives every source its position as index, in input order, so instructions can say sources[i] (D5)", () => {
    const e = buildEvidence([{ label: "a.ts", text: "A" }, { label: "b.ts", text: "B" }]);
    expect(e.sharedState).toEqual({ sources: [
      { index: 0, label: "a.ts", text: "A", truncated: false },
      { index: 1, label: "b.ts", text: "B", truncated: false },
    ] });
    expect(e.ctx).toEqual({ truncated: false });
  });
  it("cuts a source over maxChars, flags that source and ctx.truncated, and leaves the others alone", () => {
    const e = buildEvidence([{ label: "big", text: "x".repeat(10) }, { label: "ok", text: "yy" }], { maxChars: 4 });
    const s = (e.sharedState as { sources: { text: string; truncated: boolean }[] }).sources;
    expect(s.map((x) => [x.text, x.truncated])).toEqual([["xxxx", true], ["yy", false]]);
    expect(e.ctx.truncated).toBe(true);
  });
  it("does not flag a source of exactly maxChars", () => {
    expect(buildEvidence([{ label: "f", text: "abcd" }], { maxChars: 4 }).ctx.truncated).toBe(false);
  });
  it("never cuts inside a surrogate pair", () => {
    const e = buildEvidence([{ label: "f", text: "ab" + "\u{1F600}" + "cd" }], { maxChars: 3 });
    expect((e.sharedState as { sources: { text: string }[] }).sources[0]!.text).toBe("ab");
  });
  it("maxTokens cuts a source whose estimated JSON tokens exceed it, flags it, and leaves a fitting one alone", () => {
    const e = buildEvidence([{ label: "cjk", text: "字".repeat(100) }, { label: "ok", text: "ab" }], { maxTokens: 50 });
    const s = (e.sharedState as { sources: { text: string; truncated: boolean }[] }).sources;
    expect(s[0]!.truncated).toBe(true);
    expect(estimateTokens(JSON.stringify(s[0]!.text))).toBeLessThanOrEqual(50);
    expect(estimateTokens(JSON.stringify(s[0]!.text + "字"))).toBeGreaterThan(50);
    expect(s[1]).toMatchObject({ text: "ab", truncated: false });
    expect(e.ctx.truncated).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => buildEvidence([{ label: "f", text: "a" }], { maxTokens: bad })).toThrow(/maxTokens/);
  });
  it("a source flagged partial by the caller is truncated even when nothing is cut here", () => {
    expect(buildEvidence([{ label: "f", text: "a", partial: true }]).ctx.truncated).toBe(true);
  });
  it("refuses no sources, and a maxChars that is not a positive integer", () => {
    expect(() => buildEvidence([])).toThrow(/at least one source/);
    expect(() => buildEvidence([{ label: "f", text: "a" }], { maxChars: 0 })).toThrow(/maxChars/);
    expect(() => buildEvidence([{ label: "f", text: "a" }], { maxChars: 1.5 })).toThrow(/maxChars/);
  });
  it("its result slots into the catalog types without a parallel type", () => {
    const e = buildEvidence([{ label: "f", text: "a" }]);
    const built: Pick<Built, "sharedState"> = { sharedState: e.sharedState };
    const ctx: ProjectCtx = e.ctx;
    expect(built.sharedState).toBeDefined();
    expect(ctx.truncated).toBe(false);
  });
});

describe("cutToTokens contract (shared with buildEvidence maxTokens)", () => {
  const tok = (t: string): number => estimateTokens(JSON.stringify(t));
  it("a budget of 0, or below the two quote characters, returns empty text with cut true; an empty text is never cut", () => {
    for (const budget of [0, 1]) {
      expect(cutToTokens("abc", budget)).toMatchObject({ text: "", cut: true });
      const e = buildEvidence([{ label: "f", text: "abc" }], { maxTokens: budget });
      expect((e.sharedState as { sources: { text: string; truncated: boolean }[] }).sources[0]).toMatchObject({ text: "", truncated: true });
      expect(e.ctx.truncated).toBe(true);
    }
    expect(cutToTokens("", 0)).toMatchObject({ text: "", cut: false });
  });
  it("both refuse a budget that is not a non-negative integer, with the same wording", () => {
    for (const bad of [-1, 0.5, Number.NaN, Infinity]) {
      expect(() => cutToTokens("a", bad)).toThrow(/maxTokens must be a non-negative integer/);
      expect(() => buildEvidence([{ label: "f", text: "a" }], { maxTokens: bad })).toThrow(/maxTokens must be a non-negative integer/);
    }
  });
  it("never ends in a lone high surrogate, whatever the budget, and keeps an emoji that fits", () => {
    const text = "ab\u{1F600}cd\u{1F600}";
    for (let budget = 0; budget <= tok(text) + 1; budget++) {
      const r = cutToTokens(text, budget);
      expect(r.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(text.startsWith(r.text)).toBe(true);
      if (r.text !== "" || budget >= 2) expect(tok(r.text)).toBeLessThanOrEqual(Math.max(budget, 2));
    }
    expect(cutToTokens(text, tok("ab\u{1F600}")).text).toBe("ab\u{1F600}");
    expect(cutToTokens(text, tok("ab")).text).toBe("ab");
  });
  it("is bounded: no prefix longer than budget x the cheapest chars-per-token is ever estimated", () => {
    const seen: number[] = [];
    const real = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((v: unknown, ...rest: unknown[]) => { if (typeof v === "string") seen.push(v.length); return (real as (...a: unknown[]) => string)(v, ...rest); }) as typeof JSON.stringify);
    try {
      const r = cutToTokens("a".repeat(1_000_000), 100);
      expect(r.cut).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // 4 characters per token is the cheapest class (whitespace, 3/12): asserted against estimateTokens itself.
    expect(estimateTokens(" ".repeat(48))).toBe(12);
    for (const ch of ["a", "1", "{", "字", "\n", "\t", "\u0000"]) expect(estimateTokens(ch.repeat(48))).toBeGreaterThanOrEqual(12);
    expect(Math.max(...seen)).toBeLessThanOrEqual(100 * 4);
  });
  it("maxChars and maxTokens together: the smaller cut wins and the source is flagged either way", () => {
    const text = "字".repeat(100);
    const byChars = buildEvidence([{ label: "f", text }], { maxChars: 10, maxTokens: 1000 });
    expect((byChars.sharedState as { sources: { text: string }[] }).sources[0]!.text).toBe("字".repeat(10));
    expect(byChars.ctx.truncated).toBe(true);
    const byTokens = buildEvidence([{ label: "f", text }], { maxChars: 1000, maxTokens: 20 });
    const t = (byTokens.sharedState as { sources: { text: string }[] }).sources[0]!.text;
    expect(tok(t)).toBeLessThanOrEqual(20);
    expect(tok(t + "字")).toBeGreaterThan(20);
    const both = buildEvidence([{ label: "f", text }], { maxChars: 10, maxTokens: 5 });
    expect(tok((both.sharedState as { sources: { text: string }[] }).sources[0]!.text)).toBeLessThanOrEqual(5);
  });
});

describe("sourceFromSnippet", () => {
  const dir = mkdtempSync(join("/tmp", "l209-")); // /tmp, not os.tmpdir(): sanitizeInputPath only allows cwd, HOME and /tmp
  const file = join(dir, "f.txt");
  writeFileSync(file, "l1\nl2\nl3\n");
  it("a whole-file read of a file ending in a newline is not partial", async () => {
    const r = sourceFromSnippet(file, await readForJev(file, { kind: "whole" }));
    expect(r.partial).toBe(false);
    expect(buildEvidence([r]).ctx.truncated).toBe(false);
  });
  it("marks a whole read complete and a line-range read partial, using real readForJev output", async () => {
    const whole = sourceFromSnippet(file, await readForJev(file, { kind: "whole" }));
    const part = sourceFromSnippet(file, await readForJev(file, { kind: "lines", from: 2, to: 3 }));
    expect(whole.partial).toBe(false);
    expect(part).toMatchObject({ label: file, text: "l2\nl3", partial: true });
  });
});
