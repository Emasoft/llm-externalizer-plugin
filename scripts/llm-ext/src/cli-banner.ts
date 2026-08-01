// Pure helpers for the CLI success banner (Issue 4), kept in their own module so
// unit tests can import them WITHOUT loading cli.ts — whose top-level runs the
// MCP/argv machinery and would otherwise execute on import.

/** Pick the report path from a tool's result text: the first non-empty, trimmed
 *  line. Returns undefined when the result carries no path (empty body), so the
 *  caller can skip the banner. */
export function pickReportPath(resultText: string): string | undefined {
  return resultText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/** Build the STDERR success-banner line for a completed tool call, or undefined
 *  when there is no report path to point at. */
export function formatSuccessBanner(
  tool: string,
  resultText: string,
): string | undefined {
  const reportPath = pickReportPath(resultText);
  return reportPath ? `✓ ${tool} complete — report: ${reportPath}` : undefined;
}
