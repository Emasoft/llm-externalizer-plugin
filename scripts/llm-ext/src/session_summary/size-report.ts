/**
 * The one number a compaction is actually FOR: how much smaller the result is
 * than the transcript it replaces.
 *
 * The command already reported chunk counts, lines read and a prune ratio —
 * all inputs to the process, none of them the outcome. A reader had no way to
 * tell a 99% reduction from a 40% one without stat'ing two files by hand.
 */

/** Human-readable bytes. Kept alongside the exact count, never instead of it:
 *  "1.4 MB" is what you read, the raw number is what you compare across runs. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

/**
 * Percent of the original that the summary does NOT occupy.
 *
 * Returns null when the question is meaningless (an empty or unmeasurable
 * transcript) rather than 0, 100 or NaN — a caller must be able to omit the
 * claim instead of printing a fabricated one. NaN in particular would render
 * as "NaN% reduction", which reads like a bug in the compaction rather than in
 * the arithmetic.
 *
 * A NEGATIVE result is returned as-is: a summary larger than its input is a
 * real (if surprising) outcome on a tiny transcript, and hiding it would be
 * hiding the one case where compaction is not worth running.
 */
export function reductionPercent(beforeBytes: number, afterBytes: number): number | null {
  if (!Number.isFinite(beforeBytes) || !Number.isFinite(afterBytes)) return null;
  if (beforeBytes <= 0 || afterBytes < 0) return null;
  return (1 - afterBytes / beforeBytes) * 100;
}

/**
 * The single line printed to stderr and embedded in the report header.
 *
 * `prunedBytes` is optional context, not the headline: pruning is an internal
 * step, while raw-transcript → summary is the comparison a reader came for.
 */
export function formatSizeReport(
  rawBytes: number,
  summaryBytes: number,
  prunedBytes?: number,
): string {
  const pct = reductionPercent(rawBytes, summaryBytes);
  const head =
    `Size: ${formatBytes(rawBytes)} (${rawBytes.toLocaleString()} B) transcript → ` +
    `${formatBytes(summaryBytes)} (${summaryBytes.toLocaleString()} B) summary`;
  const reduction =
    pct === null
      ? " (reduction: n/a)"
      : ` — ${pct.toFixed(2)}% ${pct < 0 ? "LARGER than the original" : "reduction"}`;
  const pruned =
    typeof prunedBytes === "number" && Number.isFinite(prunedBytes) && prunedBytes >= 0
      ? `; pruned to ${formatBytes(prunedBytes)} before summarizing`
      : "";
  return `${head}${reduction}${pruned}`;
}
