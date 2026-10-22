import { describe, expect, it } from "vitest";
import { PolicyError, band, marginMet, maxGate, parseThresholdFlag, resolveThresholds, type ThresholdSpec } from "./policy-kit.js";

describe("band (filter: matched = p >= threshold, borderline = |p - threshold| < band)", () => {
  it("p at the threshold is matched and borderline", () => {
    expect(band(0.5, 0.5, 0.15)).toEqual({ matched: true, borderline: true });
  });
  it("p between threshold and threshold + band is in both (E128)", () => {
    expect(band(0.6, 0.5, 0.15)).toEqual({ matched: true, borderline: true });
  });
  it("p just under the threshold but inside the band is borderline only", () => {
    expect(band(0.4, 0.5, 0.15)).toEqual({ matched: false, borderline: true });
  });
  it("p far from the threshold is neither borderline nor, below it, matched", () => {
    expect(band(0.1, 0.5, 0.15)).toEqual({ matched: false, borderline: false });
    expect(band(0.95, 0.5, 0.15)).toEqual({ matched: true, borderline: false });
  });
  it("the band edge itself is outside the band, despite float noise (0.5 + 0.15 = 0.65)", () => {
    expect(band(0.65, 0.5, 0.15).borderline).toBe(false);
    expect(band(0.35, 0.5, 0.15).borderline).toBe(false);
  });
  it("a zero band leaves no borderline", () => {
    expect(band(0.5, 0.5, 0).borderline).toBe(false);
  });
  it("refuses a probability outside 0..1 and a negative band", () => {
    expect(() => band(1.2, 0.5, 0.1)).toThrow(PolicyError);
    expect(() => band(Number.NaN, 0.5, 0.1)).toThrow(PolicyError);
    expect(() => band(0.5, 0.5, -0.1)).toThrow(PolicyError);
  });
});

describe("marginMet (top versus runner-up)", () => {
  it("is met when the gap reaches the margin", () => {
    expect(marginMet(0.9, 0.3, 0.5)).toBe(true);
    expect(marginMet(0.9, 0.5, 0.5)).toBe(false);
  });
  it("a gap equal to the margin counts despite float noise (0.7 - 0.2 is 0.49999999999999994)", () => {
    expect(0.7 - 0.2).toBeLessThan(0.5);
    expect(marginMet(0.7, 0.2, 0.5)).toBe(true);
  });
  it("a missing runner-up (single option) meets any margin", () => {
    expect(marginMet(0.6, undefined, 0.5)).toBe(true);
  });
  it("a runner-up above the top is refused", () => {
    expect(() => marginMet(0.3, 0.6, 0.1)).toThrow(PolicyError);
  });
  it("refuses a margin outside 0..1", () => {
    expect(() => marginMet(0.9, 0.1, 1.5)).toThrow(PolicyError);
  });
});

describe("maxGate (the largest value decides)", () => {
  it("gates when the maximum reaches the threshold, and reports it", () => {
    expect(maxGate([0.1, 0.7, 0.3], 0.7)).toEqual({ max: 0.7, gated: true });
  });
  it("does not gate below the threshold", () => {
    expect(maxGate([0.1, 0.69], 0.7)).toEqual({ max: 0.69, gated: false });
  });
  it("refuses an empty list (a gate over nothing would pass silently)", () => {
    expect(() => maxGate([], 0.7)).toThrow(PolicyError);
  });
  it("refuses a value outside 0..1", () => {
    expect(() => maxGate([0.2, -0.1], 0.7)).toThrow(PolicyError);
  });
});

const specs: Record<string, ThresholdSpec> = {
  auto: { default: 0.85, min: 0, max: 1 },
  margin: { default: 0.5, min: 0, max: 1 },
  top: { default: 10, min: 1, max: 1000 },
};

describe("parseThresholdFlag (range checks for threshold flags)", () => {
  it("parses a plain decimal inside the range", () => {
    expect(parseThresholdFlag("auto", "0.9", specs.auto)).toBe(0.9);
    expect(parseThresholdFlag("auto", ".5", specs.auto)).toBe(0.5);
    expect(parseThresholdFlag("top", "20", specs.top)).toBe(20);
  });
  it("accepts the range ends", () => {
    expect(parseThresholdFlag("auto", "0", specs.auto)).toBe(0);
    expect(parseThresholdFlag("auto", "1", specs.auto)).toBe(1);
  });
  it("refuses out-of-range values naming flag and range", () => {
    expect(() => parseThresholdFlag("auto", "1.01", specs.auto)).toThrow(/--auto.*0.*1/);
    expect(() => parseThresholdFlag("auto", "-0.1", specs.auto)).toThrow(PolicyError);
    expect(() => parseThresholdFlag("top", "0", specs.top)).toThrow(PolicyError);
  });
  it("refuses text that Number() would accept silently", () => {
    for (const bad of ["", " ", "0x10", "1e-1", "Infinity", "NaN", "0.5abc", "1,5"]) {
      expect(() => parseThresholdFlag("auto", bad, specs.auto)).toThrow(PolicyError);
    }
  });
});

describe("resolveThresholds", () => {
  it("returns the defaults when no flag is given", () => {
    expect(resolveThresholds(specs, {})).toEqual({ auto: 0.85, margin: 0.5, top: 10 });
  });
  it("applies string and number overrides", () => {
    expect(resolveThresholds(specs, { auto: "0.9", margin: 0.4 })).toEqual({ auto: 0.9, margin: 0.4, top: 10 });
  });
  it("refuses an unknown threshold name", () => {
    expect(() => resolveThresholds(specs, { autoo: "0.9" })).toThrow(/unknown threshold.*autoo/);
  });
  it("refuses an out-of-range number override", () => {
    expect(() => resolveThresholds(specs, { margin: 2 })).toThrow(PolicyError);
    expect(() => resolveThresholds(specs, { margin: Number.NaN })).toThrow(PolicyError);
  });
  it("refuses a spec whose default is outside its own range", () => {
    expect(() => resolveThresholds({ x: { default: 5, min: 0, max: 1 } }, {})).toThrow(PolicyError);
  });
  it("does not let an inherited name such as constructor through as a threshold", () => {
    expect(() => resolveThresholds(specs, { constructor: "1" })).toThrow(/unknown threshold/);
  });
});
