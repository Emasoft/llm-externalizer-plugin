/**
 * Token and cost totals for the per-file tools (TRDD-RPLLP8CF).
 *
 * One source: the `usage` block each file's provider reply already carried, copied onto the
 * file result by processFileCheck. Nothing here reads the usage-history file or the session
 * counters, so a total can never disagree with the per-file data it sums.
 */

/** What one file's reply reported. `costUsd` is absent when the provider sent no cost. */
export interface FileUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

/** The one-line totals for a SCAN COMPLETE / BATCH CHECK COMPLETE summary. */
export function formatUsageTotals(
  results: readonly { success: boolean; usage?: FileUsage }[],
): string {
  // WHY every result, not only the successful ones: a file whose reply was rejected (finish_reason=error, empty or echoed
  // answer) still spent paid tokens; summing only successes made that spend appear nowhere.
  const withUsage = results.filter((r) => r.usage !== undefined);
  if (withUsage.length === 0) return "Usage: unknown (the provider reported no token usage)";
  const okWithoutUsage = results.filter((r) => r.success && r.usage === undefined).length;
  const tokensIn = withUsage.reduce((s, r) => s + r.usage!.promptTokens, 0);
  const tokensOut = withUsage.reduce((s, r) => s + r.usage!.completionTokens, 0);
  // WHY unknown, never $0: a local or unpriced server sends no cost field, and printing 0.0000 for
  // "not reported" would read as a free run. Any file without a cost makes the whole sum unknown.
  const costKnown = okWithoutUsage === 0 && withUsage.every((r) => r.usage!.costUsd !== undefined);
  const cost = costKnown
    ? `$${withUsage.reduce((s, r) => s + r.usage!.costUsd!, 0).toFixed(4)}`
    : "unknown (not every file reported a cost)";
  const scope = okWithoutUsage === 0 ? "" : ` (from ${withUsage.length} of ${withUsage.length + okWithoutUsage} files)`;
  return `Usage: ${tokensIn} tokens in, ${tokensOut} tokens out, cost ${cost}${scope}`;
}
