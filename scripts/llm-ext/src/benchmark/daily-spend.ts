/**
 * Daily spend cap for the PAID dynamic-profile maintainer (design §2.5).
 *
 * The per-run SpendLedger (budget.ts) bounds ONE benchmark child. This file
 * bounds a whole UTC DAY across every child, so a maintainer that runs many
 * times a day can never rack up more than `paid_benchmark_daily_cap_usd`
 * total. Money is the one place this module fails CLOSED: a corrupt or
 * unreadable ledger reads as "the cap is already spent", never as "$0 spent
 * so far" — the safe direction when the failure mode is "spend more than the
 * user authorized".
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir, paidDailyCapUsd, type Settings } from "../config.js";
import { withMkdirLock } from "../mkdir-lock.js";

export const DEFAULT_PAID_DAILY_CAP_USD = 0.5;

const PRUNE_AFTER_DAYS = 30;

interface DailySpendLedger {
  version: 1;
  days: Record<string, number>;
}

export function dailySpendPath(): string {
  return join(getConfigDir(), "paid-benchmark-spend.json");
}

function lockDirPath(): string {
  return join(getConfigDir(), "paid-benchmark-spend.lock");
}

/** UTC calendar day key, e.g. "2026-09-16". */
function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** true = the file exists but could not be trusted (fail-closed territory). */
function readLedger(): { ledger: DailySpendLedger; corrupt: boolean } {
  const path = dailySpendPath();
  if (!existsSync(path)) return { ledger: { version: 1, days: {} }, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as DailySpendLedger).days !== "object" ||
      (parsed as DailySpendLedger).days === null
    ) {
      process.stderr.write(`llm-ext: ${path} has an unexpected shape — treating the daily paid-benchmark spend as the cap (fail-closed).\n`);
      return { ledger: { version: 1, days: {} }, corrupt: true };
    }
    return { ledger: { version: 1, days: (parsed as DailySpendLedger).days }, corrupt: false };
  } catch (err) {
    process.stderr.write(`llm-ext: ${path} is corrupt (${(err as Error).message}) — treating the daily paid-benchmark spend as the cap (fail-closed).\n`);
    return { ledger: { version: 1, days: {} }, corrupt: true };
  }
}

/** USD spent today (UTC). A corrupt ledger reads as +Infinity so
 *  `dailyRemainingUsd` fails CLOSED (0 remaining) rather than open. */
export function spentTodayUsd(nowMs: number = Date.now()): number {
  const { ledger, corrupt } = readLedger();
  if (corrupt) return Infinity;
  return ledger.days[utcDayKey(nowMs)] ?? 0;
}

/** USD left to spend today under `paid_benchmark_daily_cap_usd`
 *  (0 disables paid auto-benchmarking entirely — never a positive remainder). */
export function dailyRemainingUsd(settings: Settings | null | undefined, nowMs: number = Date.now()): number {
  const cap = paidDailyCapUsd(settings);
  if (cap <= 0) return 0;
  const spent = spentTodayUsd(nowMs);
  return Math.max(0, cap - spent);
}

/**
 * P6b-fix2 S-4: this file's own mkdir spin-lock MOVED to `mkdir-lock.ts`,
 * unchanged, so the three other sidecars that were doing an UNLOCKED
 * read-modify-write (`dynamic-profiles-state.json`, `dynamic-candidates.json`)
 * use this exact implementation rather than a copy of it. Only the lock-dir
 * path stays here — it names THIS ledger.
 */
function withLock<T>(fn: () => T): T {
  return withMkdirLock(lockDirPath(), fn);
}

function pruneOldDays(days: Record<string, number>, nowMs: number): Record<string, number> {
  const cutoff = nowMs - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const cutoffKey = utcDayKey(cutoff);
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(days)) {
    if (k >= cutoffKey) next[k] = v;
  }
  return next;
}

/** Book `usd` against today's (UTC) spend, atomically, under the lock — so a
 *  crashed child's partial spend is never lost (call this incrementally,
 *  once per completed benchmark call, not once per whole run). */
export function bookDailySpend(usd: number, nowMs: number = Date.now()): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  withLock(() => {
    const { ledger } = readLedger();
    const key = utcDayKey(nowMs);
    const days = pruneOldDays(ledger.days, nowMs);
    days[key] = (days[key] ?? 0) + usd;
    const path = dailySpendPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, days }, null, 2), "utf-8");
    renameSync(tmp, path);
  });
}
