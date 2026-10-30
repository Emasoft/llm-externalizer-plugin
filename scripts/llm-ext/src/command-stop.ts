/**
 * command-stop.ts: the one "this command is being stopped" flag
 * (--command_timeout, spec 15; follow-up review M3).
 *
 * WHY a module of its own: the stop must be seen by EVERY request path, not
 * only the local broker client. The remote/non-managed path (sendChat,
 * fetchWithRetry429) and the direct-fetch workers (security_scan/judge.ts,
 * mass_scouting/scout.ts) and the classify decision runner (classifiers/l0/transport.ts, l2/fan-out.ts) check it too, so a stopped command starts no new
 * request on any profile (and spends no more money); before this, only
 * broker jobs honoured it and a remote command kept submitting for 30 s.
 * No imports: every layer can depend on it without a cycle.
 */

/** Exit code of a command stopped by --command_timeout (the timeout(1) convention); cli/main.ts and classify use it. */
export const COMMAND_TIMEOUT_EXIT = 124;
let reason: string | null = null;

/** Mark the command as stopping. Idempotent: the first reason wins. */
export function stopCommand(why: string): void {
  reason ??= why;
}

/** The stop reason, or null while the command runs normally. */
export function commandStopReason(): string | null {
  return reason;
}

/**
 * Thrown by every request path once the command is stopping. Marked with
 * `final: "stop"` by its users (attachFailure lives in provider/http.ts, which
 * this module must not import): never retried, never a breaker failure, and
 * the profile walker rethrows it at once.
 */
export class CommandStoppedError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "CommandStoppedError";
  }
}

/**
 * Follow-up review M1: after a stop, the summary lines naming EVERY file
 * whose result is not a success. A file that never started (skipped as
 * "Batch aborted", or with no error) or was stopped mid-call gets the stop
 * reason; a file that had already failed for another reason keeps its own
 * error. [] while the command runs normally. One helper for every multi-file
 * summary (scan folder modes 0/1/2, batch check, chat, code task), so no path
 * can list only a count; those summaries print it INSTEAD of their FAILED
 * block once stopped (see isCommandStopped), so no file is listed twice.
 */
export function unfinishedFileLines(results: ReadonlyArray<{ filePath: string; success: boolean; error?: string }>): string[] {
  if (reason === null) return [];
  const unfinished = results.filter((r) => !r.success);
  if (unfinished.length === 0) return [];
  const why = reason;
  return [
    "",
    `UNFINISHED (${unfinished.length}, stopped by --command_timeout):`,
    ...unfinished.map((r) => `  ${r.filePath}: ${r.error === undefined || r.error === "Batch aborted" ? why : r.error}`),
  ];
}

/** True once the command is stopping (the summaries then list unfinished files instead of their FAILED block). */
export function isCommandStopped(): boolean {
  return reason !== null;
}

/** Follow-up review m2: once stopped, an abort's reason is the stop (a "3 of the last 3 failed" text would suggest an outage). */
export function abortReasonText(abortReason: string): string {
  return reason ?? abortReason;
}
