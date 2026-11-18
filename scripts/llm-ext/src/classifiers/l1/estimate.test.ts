import { describe, expect, it } from "vitest";
import { estimateTokens } from "./estimate.js";

describe("estimateTokens", () => {
  // Rates from the claude-jev estimate: letters 1/3, digits 1/2, whitespace 1/4, other ASCII 1/1.5, non-ASCII 1; each class has its own case so a wrong rate fails alone.
  it("counts letters at three per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("abcdef")).toBe(2);
  });

  it("counts digits at two per token", () => {
    expect(estimateTokens("12345")).toBe(3);
  });

  it("counts whitespace at four per token", () => {
    expect(estimateTokens(" \n\t\r \n\t\r")).toBe(2);
    expect(estimateTokens("         ")).toBe(3);
  });

  // 3000 letters are exactly 1000 tokens and 3 symbols exactly 2; a float sum of 1/3 steps can land above the whole number and ceil would add one.
  it("does not round up a total that is exactly whole", () => {
    expect(estimateTokens("a".repeat(3000))).toBe(1000);
    expect(estimateTokens("{}[")).toBe(2);
    expect(estimateTokens("a".repeat(3000) + "{}[")).toBe(1002);
  });

  it("counts other ASCII at one and a half per token", () => {
    expect(estimateTokens("{}[]")).toBe(3);
  });

  // E29: each CJK character costs one token.
  it("counts each CJK character as one token", () => {
    expect(estimateTokens("日本語")).toBe(3);
  });

  // An emoji is one character but two UTF-16 code units; counting code units would give 2.
  it("counts an emoji once, not once per UTF-16 code unit", () => {
    expect(estimateTokens("😀")).toBe(1);
  });

  // 10 letters 3.33 + 2 digits 1 + 3 whitespace 0.75 + 1 comma 0.67 + 1 wide = 6.75 -> 7.
  it("sums every class into one total", () => {
    expect(estimateTokens("Hello, world 42\n日")).toBe(7);
  });

  // A non-string value is counted as its JSON text; 1 letter, 7 symbols, 2 wide = 0.33 + 4.67 + 2 = 7.
  it("counts a non-string value as its JSON text", () => {
    expect(estimateTokens(42)).toBe(1);
    expect(estimateTokens({ a: "日本" })).toBe(7);
  });

  // undefined has no JSON form; throwing beats returning a count that silently drops the value.
  it("throws a TypeError for a value with no JSON form", () => {
    expect(() => estimateTokens(undefined)).toThrow(TypeError);
  });

  // TRDD-4JLBB1YT: the decider tokenizer measured 1.1-1.4 chars per token on random text, so per-class rates undercounted base64 and hex by about 2x.
  // The samples are generated here with a seeded PRNG (no high-entropy literal in the source) and are the same texts as the measurement (b64-1000 seed 1001, hex32-4000 seed 2002), whose decider net counts (decider input_tokens minus the 105 token overhead of the question) were 732 and 3581.
  const rng = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pick = (r: () => number, set: string, n: number): string => {
    let s = "";
    for (let i = 0; i < n; i++) s += set[Math.floor(r() * set.length)];
    return s;
  };
  const B64_SET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const HEX_SET = "0123456789abcdef";

  it("does not undercount a random base64 run against the decider count", () => {
    const sample = pick(rng(1001), B64_SET, 1000);
    expect(estimateTokens(sample)).toBeGreaterThanOrEqual(732);
    expect(estimateTokens(sample)).toBeLessThanOrEqual(732 * 1.1);
  });

  it("does not undercount a list of random 32-char hex ids against the decider count", () => {
    const r = rng(2002);
    const ids: string[] = [];
    for (let n = 0; n < 4000; ) {
      const id = pick(r, HEX_SET, 32);
      ids.push(id);
      n += id.length + 1;
    }
    const sample = ids.join("\n");
    expect(estimateTokens(sample)).toBeGreaterThanOrEqual(3581);
    expect(estimateTokens(sample)).toBeLessThanOrEqual(3581 * 1.1);
  });

  // Seed 2006 is the list that failed the out-of-sample check by 19 tokens (net 3591 against an estimate of 3572): 3 of its 109 UUIDs have under 40 percent digits (13, 14 and 14 of 36 chars), so a digit-share test alone counted them at the per-class rate. Hex-only runs count as random at any digit share.
  it("does not undercount a UUID list whose UUIDs fall under 40 percent digits", () => {
    const r = rng(2006);
    const ids: string[] = [];
    for (let n = 0; n < 4000; ) {
      const h = pick(r, HEX_SET, 32).split("");
      h[12] = "4";
      h[16] = "89ab"[Math.floor(r() * 4)] as string;
      const s = h.join("");
      const id = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
      ids.push(id);
      n += id.length + 1;
    }
    const sample = ids.join("\n");
    expect(estimateTokens(sample)).toBeGreaterThanOrEqual(3591);
    expect(estimateTokens(sample)).toBeLessThanOrEqual(3591 * 1.1);
  });

  // The code excerpt has long camelCase identifiers (case changes, no digits): they must keep the per-class rates. 184 is the estimate of the function before TRDD-4JLBB1YT; the decider measured code at 0.76-0.92 of that estimate, so it must not move.
  it("keeps the per-class estimate for code with long camelCase identifiers", () => {
    const code = [
      "import { floorFailSafeVerdict, judgeGroups, type FetchImpl } from \"./judge\";",
      "export interface SecurityScanRunResult {",
      "  exitCode: number;",
      "  stdout: string;",
      "  stderr: string;",
      "}",
      "function err(text: string): SecurityScanRunResult {",
      "  return { exitCode: 1, stdout: \"\", stderr: text };",
      "}",
      "const deps = { freeOnly: getActiveFreeOnly(), perCallTimeoutMs: input.per_call_timeout_ms, verdict: floorFailSafeVerdict(input.default_verdict_on_error) };",
      "// runSecurityScanCli resolves the active profile once, not per call.",
    ].join("\n");
    expect(estimateTokens(code)).toBe(184);
  });

  // Negative cases (TRDD-4JLBB1YT): a pure digit run and an ISO timestamp (the colons cut it into runs under 16 chars) keep the per-class rates.
  // 20 digits at 6/12 = 10 tokens; the timestamp has 18 digits, 1 letter, 6 other ASCII: (18*6 + 4 + 6*8) / 12 = 13.33 -> 14.
  it("keeps the per-class estimate for a pure digit run and an ISO timestamp", () => {
    expect(estimateTokens("12345678901234567890")).toBe(10);
    expect(estimateTokens("2026-11-18T06:58:29+01:00")).toBe(14);
  });

  // Known approximation, pinned on purpose (TRDD-4JLBB1YT): a digit-dense id with a letter in it is counted as random text at 11/12 per char, an overcount that only splits a request earlier.
  // 20 chars, 14 digits (70%): 20 * 11 / 12 = 18.33 -> 19; per-class it would be (14*6 + 6*4) / 12 = 9.
  it("counts a digit-dense identifier with a letter as random text", () => {
    expect(estimateTokens("build20261118065829x")).toBe(19);
  });

  // A UUID (documentation example, joined from parts so no key-like literal sits in the source): 36 chars, 27 digits, so 36 * 11 / 12 = 33; per-class it would be (27*6 + 5*4 + 4*8) / 12 = 18.
  it("counts a UUID at the random-run rate", () => {
    expect(estimateTokens(["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-"))).toBe(33);
  });
});
