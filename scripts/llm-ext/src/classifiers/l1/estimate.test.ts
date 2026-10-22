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
});
