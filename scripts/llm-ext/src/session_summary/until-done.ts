/**
 * Backoff policy for `session compact --until-done`.
 *
 * Extracted from the CLI handler because it is the one part of that loop with
 * real bug potential — a wrong sign or a stale "today" in the UTC-midnight
 * arithmetic turns "wait for the quota to reset" into either a busy-loop or a
 * 24-hour stall, and neither is visible until it happens in the field.
 */

/** 30s, doubling. */
export const UNTIL_DONE_BASE_MS = 30_000;

/**
 * Ceiling on ONE sleep. Not a ceiling on total waiting — the loop is unbounded.
 * It exists so the run stays observable (a line at least every 15 minutes) and
 * so a recovery that arrives early, such as another free model coming back, is
 * picked up rather than slept through.
 */
export const UNTIL_DONE_CAP_MS = 900_000;

/** Milliseconds from `nowMs` to the next 00:00 UTC. Exactly 0 is impossible:
 *  midnight itself belongs to the day that is starting, so the answer is a full
 *  day, never zero — a zero would spin the retry loop with no wait at all. */
export function msUntilUtcMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return next - nowMs;
}

/**
 * How long to wait before the next whole-compaction attempt.
 *
 * `quotaCapped` changes the shape, not just the size: a daily quota does not
 * clear on a doubling curve, it clears at 00:00 UTC, so backing off 30s / 60s /
 * 120s against one only burns attempts. The cap still applies, so a run that
 * hits its quota early in the day reports in every 15 minutes instead of going
 * silent until midnight.
 */
export function untilDoneBackoffMs(
  attempt: number,
  quotaCapped: boolean,
  nowMs: number = Date.now(),
): number {
  if (quotaCapped) return Math.min(msUntilUtcMidnight(nowMs), UNTIL_DONE_CAP_MS);
  const exponent = Math.max(0, attempt - 1);
  // 2 ** exponent overflows to Infinity past ~1024 attempts; Math.min pins it
  // to the cap, but computing Infinity first is a needless trap, so clamp the
  // exponent to where the cap is already reached.
  const capped = Math.min(exponent, 32);
  return Math.min(UNTIL_DONE_BASE_MS * 2 ** capped, UNTIL_DONE_CAP_MS);
}

/**
 * Does this failure mean "the free daily quota is gone"?
 *
 * Deliberately a message test: the driver reports quota exhaustion through
 * several paths (a model demoted with reason `daily-quota`, an all-models-
 * exhausted error naming it, a provider message quoted verbatim) and they do
 * not share a type. A false positive costs one longer-than-needed sleep,
 * bounded by the cap; a false negative just uses the ordinary curve. Both are
 * survivable, which is why a loose match is the right call here.
 */
export function looksQuotaCapped(message: string): boolean {
  return /daily[- ]?(quota|cap|limit)|quota exhausted|out of (free )?quota/i.test(message);
}
