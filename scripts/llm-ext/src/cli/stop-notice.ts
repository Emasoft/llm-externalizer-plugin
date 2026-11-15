// The line a stopped command prints once its broker jobs are settled.
// WHY a function of what actually happened (TRDD-GBC4A4CF): the old fixed suffix
// ("N unfinished local job(s) cancelled; writing the results already complete") was wrong for a
// command stopped while it still waited (e.g. on the profile update): it claimed "0 jobs cancelled" and
// results that never existed, and nothing was written. The line is shared by --command_timeout and
// --stop_on_errors (endStoppedCommand in main.ts), where earlier files may or may not have finished, so
// the closing clause must hold either way. It says "kept", not "written": a 30 s hard kill can follow
// (a --stop_on_errors sibling stuck on its HTTP timeout, a remote request that never ends) and then
// nothing more is written; the hard-kill line in main.ts reports that case. The caller appends the newline.
export function stopNoticeLine(reason: string, cancelled: number, failed: string[]): string {
  const parts = [reason];
  if (cancelled > 0) parts.push(`${cancelled} unfinished local job(s) cancelled`);
  // Follow-up review m1: only confirmed DELETEs are counted; the rest are named.
  if (failed.length > 0) parts.push(`${failed.length} job(s) could not be cancelled (left to the broker's abandon rule): ${failed.join(", ")}`);
  parts.push("finished results, if any, are kept");
  return `llm-ext: ${parts.join("; ")}`;
}
