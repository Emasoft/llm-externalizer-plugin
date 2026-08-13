/**
 * Tests for the --until-done backoff policy.
 *
 * The loop it drives is unbounded by design, so every one of these numbers is
 * load-bearing: a zero-length wait busy-loops against a rate-limited endpoint,
 * and a wrong UTC-midnight calculation either stalls a full day or does not
 * wait at all. Pure functions, fixed clock, no IO.
 */

import { describe, it, expect } from "vitest";
import {
  UNTIL_DONE_BASE_MS,
  UNTIL_DONE_CAP_MS,
  msUntilUtcMidnight,
  untilDoneBackoffMs,
  looksQuotaCapped,
} from "./until-done.js";

const AT = (iso: string) => Date.parse(iso);

describe("msUntilUtcMidnight", () => {
  it("is a full day AT midnight, never zero — a zero would spin the retry loop with no wait", () => {
    expect(msUntilUtcMidnight(AT("2026-08-13T00:00:00Z"))).toBe(24 * 3_600_000);
  });

  it("counts down within the day", () => {
    expect(msUntilUtcMidnight(AT("2026-08-13T23:00:00Z"))).toBe(3_600_000);
    expect(msUntilUtcMidnight(AT("2026-08-13T12:00:00Z"))).toBe(12 * 3_600_000);
  });

  it("crosses a month boundary", () => {
    expect(msUntilUtcMidnight(AT("2026-08-31T23:30:00Z"))).toBe(1_800_000);
  });

  it("crosses a year boundary", () => {
    expect(msUntilUtcMidnight(AT("2026-12-31T23:59:00Z"))).toBe(60_000);
  });

  it("is never negative", () => {
    for (const t of ["2026-01-01T00:00:01Z", "2026-06-15T13:37:00Z", "2026-02-28T23:59:59Z"]) {
      expect(msUntilUtcMidnight(AT(t))).toBeGreaterThan(0);
    }
  });
});

describe("untilDoneBackoffMs — ordinary failures double, capped", () => {
  const now = AT("2026-08-13T12:00:00Z");

  it("starts at the base delay on the first retry", () => {
    expect(untilDoneBackoffMs(1, false, now)).toBe(UNTIL_DONE_BASE_MS);
  });

  it("doubles per attempt", () => {
    expect(untilDoneBackoffMs(2, false, now)).toBe(60_000);
    expect(untilDoneBackoffMs(3, false, now)).toBe(120_000);
    expect(untilDoneBackoffMs(4, false, now)).toBe(240_000);
  });

  it("stops at the cap instead of growing without bound", () => {
    expect(untilDoneBackoffMs(10, false, now)).toBe(UNTIL_DONE_CAP_MS);
    expect(untilDoneBackoffMs(100, false, now)).toBe(UNTIL_DONE_CAP_MS);
  });

  it("survives an attempt count large enough to overflow 2**n to Infinity", () => {
    // 2 ** 1100 is Infinity. The clamp must produce the cap, not NaN/Infinity —
    // an Infinity here would be passed to setTimeout, which silently treats it
    // as 1ms and busy-loops.
    const v = untilDoneBackoffMs(1100, false, now);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(UNTIL_DONE_CAP_MS);
  });

  it("never returns a zero or negative wait for any attempt number", () => {
    for (const a of [0, 1, 2, 7, 33, 1000]) {
      expect(untilDoneBackoffMs(a, false, now)).toBeGreaterThan(0);
    }
  });
});

describe("untilDoneBackoffMs — a daily quota waits for the reset, not the curve", () => {
  it("waits until 00:00 UTC when that is sooner than the cap", () => {
    // 10 minutes to midnight: wait exactly that, not the 15-minute cap.
    expect(untilDoneBackoffMs(1, true, AT("2026-08-13T23:50:00Z"))).toBe(600_000);
  });

  it("still reports in at the cap when the reset is far away", () => {
    // Midday: the reset is 12h out, but a run must not go silent that long.
    expect(untilDoneBackoffMs(1, true, AT("2026-08-13T12:00:00Z"))).toBe(UNTIL_DONE_CAP_MS);
  });

  it("ignores the attempt number — a quota does not clear faster on retry 1 than on retry 9", () => {
    const now = AT("2026-08-13T23:55:00Z");
    expect(untilDoneBackoffMs(1, true, now)).toBe(untilDoneBackoffMs(9, true, now));
  });
});

describe("looksQuotaCapped", () => {
  it("matches the phrasings the driver and providers actually emit", () => {
    for (const m of [
      "session-summary: chunk 0 hit a rate limit / availability error: free daily quota exceeded",
      "model demoted (daily-quota): no free calls left today",
      "Daily limit reached for this model",
      "quota exhausted",
    ]) {
      expect(looksQuotaCapped(m)).toBe(true);
    }
  });

  it("does not fire on an ordinary transient, which must use the doubling curve", () => {
    for (const m of [
      "429 Too Many Requests",
      "upstream connect error",
      "session-summary: chunk 2 failed after 3 attempt(s): socket hang up",
    ]) {
      expect(looksQuotaCapped(m)).toBe(false);
    }
  });
});
