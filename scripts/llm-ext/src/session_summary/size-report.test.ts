/**
 * Tests for the compaction size report.
 *
 * The failure mode this guards is a fabricated number: a divide-by-zero that
 * renders as "NaN% reduction" reads like the compaction broke rather than the
 * arithmetic, and a silently clamped 0% hides the one case worth seeing (a
 * summary bigger than its input).
 */

import { describe, it, expect } from "vitest";
import { formatBytes, reductionPercent, formatSizeReport } from "./size-report.js";

describe("formatBytes", () => {
  it("keeps small sizes in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up through the units", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(2_179_678)).toBe("2.08 MB");
    expect(formatBytes(265_443_684)).toBe("253.1 MB");
  });

  it("uses one decimal once the number is big enough to read without two", () => {
    expect(formatBytes(15 * 1024)).toBe("15.0 KB");
  });

  it("refuses to invent a rendering for a nonsense size", () => {
    expect(formatBytes(NaN)).toBe("?");
    expect(formatBytes(-1)).toBe("?");
  });
});

describe("reductionPercent", () => {
  it("computes the ordinary case", () => {
    expect(reductionPercent(1000, 100)).toBeCloseTo(90);
    expect(reductionPercent(2_179_678, 14_242)).toBeCloseTo(99.35, 2);
  });

  it("returns null rather than NaN when the original size is unusable", () => {
    // The real trigger: an empty or unreadable transcript. "NaN% reduction"
    // would read as a broken compaction rather than a missing measurement.
    expect(reductionPercent(0, 100)).toBeNull();
    expect(reductionPercent(NaN, 100)).toBeNull();
    expect(reductionPercent(-5, 100)).toBeNull();
  });

  it("reports a NEGATIVE reduction instead of hiding it", () => {
    // A summary larger than its input is the one case where running the
    // command was not worth it. Clamping to 0 would conceal exactly that.
    const pct = reductionPercent(100, 150);
    expect(pct).not.toBeNull();
    expect(pct!).toBeLessThan(0);
  });

  it("is 100% only for an empty summary, never by rounding", () => {
    expect(reductionPercent(1000, 0)).toBe(100);
    expect(reductionPercent(1_000_000, 1)).toBeLessThan(100);
  });
});

describe("formatSizeReport", () => {
  it("carries both the human size and the exact byte count", () => {
    const line = formatSizeReport(2_179_678, 14_242);
    expect(line).toContain("2.08 MB");
    expect(line).toContain("2,179,678 B");
    // 14242/1024 = 13.9 — two decimals only below 10, per formatBytes.
    expect(line).toContain("13.9 KB");
    expect(line).toContain("14,242 B");
    expect(line).toContain("99.35% reduction");
  });

  it("appends the pruned size only when one was given", () => {
    expect(formatSizeReport(1000, 100, 400)).toContain("pruned to 400 B");
    expect(formatSizeReport(1000, 100)).not.toContain("pruned");
  });

  it("says n/a instead of printing a number it does not have", () => {
    expect(formatSizeReport(0, 100)).toContain("reduction: n/a");
    expect(formatSizeReport(0, 100)).not.toContain("NaN");
  });

  it("calls out a summary that came out LARGER than the transcript", () => {
    expect(formatSizeReport(100, 150)).toContain("LARGER than the original");
  });
});
