// Real filesystem tests for the paid dynamic-profile daily spend cap (design §2.5).
// No mocks — a real tmp config dir, real file reads/writes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "../test-tmp-root.js";
import { join } from "node:path";

import { spentTodayUsd, dailyRemainingUsd, bookDailySpend, dailySpendPath, DEFAULT_PAID_DAILY_CAP_USD } from "./daily-spend.js";
import type { Settings } from "../config.js";

const UTC_NOON = (isoDate: string): number => new Date(`${isoDate}T12:00:00Z`).getTime();

function settingsWithCap(cap: number | undefined): Settings {
  return { paid_benchmark_daily_cap_usd: cap } as unknown as Settings;
}

describe("daily-spend", () => {
  let cfg = "";
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "daily-spend-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("no ledger yet ⇒ $0 spent, full cap remaining", () => {
    const now = UTC_NOON("2026-09-16");
    expect(spentTodayUsd(now)).toBe(0);
    expect(dailyRemainingUsd(settingsWithCap(2), now)).toBe(2);
    expect(dailyRemainingUsd(undefined, now)).toBe(DEFAULT_PAID_DAILY_CAP_USD);
  });

  it("remaining = cap - spent today (UTC)", () => {
    const now = UTC_NOON("2026-09-16");
    bookDailySpend(0.3, now);
    expect(spentTodayUsd(now)).toBeCloseTo(0.3, 6);
    expect(dailyRemainingUsd(settingsWithCap(1), now)).toBeCloseTo(0.7, 6);
  });

  it("bookDailySpend accumulates within the same UTC day", () => {
    const now = UTC_NOON("2026-09-16");
    bookDailySpend(0.1, now);
    bookDailySpend(0.2, now);
    expect(spentTodayUsd(now)).toBeCloseTo(0.3, 6);
  });

  it("crossing a UTC day boundary resets the spend", () => {
    bookDailySpend(0.4, UTC_NOON("2026-09-16"));
    expect(spentTodayUsd(UTC_NOON("2026-09-17"))).toBe(0);
    expect(dailyRemainingUsd(settingsWithCap(1), UTC_NOON("2026-09-17"))).toBe(1);
  });

  it("cap 0 disables paid auto-benchmarking entirely — 0 remaining even with nothing spent", () => {
    expect(dailyRemainingUsd(settingsWithCap(0), UTC_NOON("2026-09-16"))).toBe(0);
  });

  it("a corrupt ledger file fails CLOSED — remaining reads as 0, not as $0-spent-so-far", () => {
    writeFileSync(dailySpendPath(), "{ not json", "utf-8");
    expect(spentTodayUsd(UTC_NOON("2026-09-16"))).toBe(Infinity);
    expect(dailyRemainingUsd(settingsWithCap(5), UTC_NOON("2026-09-16"))).toBe(0);
  });

  it("bookDailySpend prunes entries older than 30 days", () => {
    const day1 = UTC_NOON("2026-08-01");
    const day2 = UTC_NOON("2026-09-16"); // 46 days later — outside the 30-day window
    bookDailySpend(0.2, day1);
    bookDailySpend(0.1, day2);
    const ledger = JSON.parse(readFileSync(dailySpendPath(), "utf-8")) as { days: Record<string, number> };
    expect(Object.keys(ledger.days)).toEqual(["2026-09-16"]);
  });

  it("bookDailySpend ignores non-positive or non-finite amounts", () => {
    bookDailySpend(0, UTC_NOON("2026-09-16"));
    bookDailySpend(-1, UTC_NOON("2026-09-16"));
    bookDailySpend(NaN, UTC_NOON("2026-09-16"));
    expect(spentTodayUsd(UTC_NOON("2026-09-16"))).toBe(0);
  });
});
