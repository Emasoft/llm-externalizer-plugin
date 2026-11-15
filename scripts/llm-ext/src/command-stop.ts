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

/** Exit code of a command stopped by --stop_on_errors (TRDD-SWNIIFTF): not 124, which tells a script "timed out". */
export const STOP_ON_ERRORS_EXIT = 6;
/** The exit code of a stopped command: 124 for --command_timeout, STOP_ON_ERRORS_EXIT for --stop_on_errors. */
export type StopExitCode = typeof COMMAND_TIMEOUT_EXIT | typeof STOP_ON_ERRORS_EXIT;
let exit: StopExitCode = COMMAND_TIMEOUT_EXIT;
let stoppedBy = "--command_timeout";
let stopOnErrors = false;
let onStopOnErrors: ((reason: string) => void) | undefined;

/** Turn --stop_on_errors on for this command (set once by cli/main.ts). `onStop` runs once, when a stop caused by this flag is first set: cli/main.ts passes the cancel-jobs-and-bounded-exit routine --command_timeout also uses, so a stop with siblings still in flight cannot wait for their HTTP timeouts. */
export function enableStopOnErrors(onStop?: (reason: string) => void): void {
  stopOnErrors = true;
  onStopOnErrors = onStop;
}
/** True when --stop_on_errors is set: the first model failure that would start a fallback ends the command instead. */
export function isStopOnErrors(): boolean {
  return stopOnErrors;
}
/** The flag that stopped the command ("--command_timeout" or "--stop_on_errors"), for wording that must not blame the wrong one. */
export function commandStopFlag(): string {
  return stoppedBy;
}
/** The exit code of the stop that ended the command (only meaningful once isCommandStopped()). */
export function commandStopExitCode(): StopExitCode {
  return exit;
}

let reason: string | null = null;
/** Sleepers to wake when the stop is set (see stoppableSleep). */
const wakers = new Set<() => void>();
/** Aborted with the stop, for a wait that takes a signal (a governor lease). Same stop state: there is no second mechanism. */
const stopController = new AbortController();

/** Mark the command as stopping. Idempotent: the first reason wins. */
/**
 * Mark the command as stopping. Idempotent: the first reason (with its exit code and flag name) wins.
 * WHY exitCode/flag are parameters: --command_timeout exits 124 (the timeout(1) convention); --stop_on_errors is not a
 * timeout, so a script must be able to tell the two apart (TRDD-SWNIIFTF). One stop state, two causes.
 */
export function stopCommand(why: string, exitCode: StopExitCode = COMMAND_TIMEOUT_EXIT, flag: string = "--command_timeout"): void {
  if (reason === null) {
    reason = why;
    exit = exitCode;
    stoppedBy = flag;
    // The first stop caused by --stop_on_errors arms the same bounded exit --command_timeout has (a stop alone waits for in-flight siblings).
    if (exitCode === STOP_ON_ERRORS_EXIT) onStopOnErrors?.(why);
  }
  for (const wake of [...wakers]) wake();
  stopController.abort();
}

/**
 * Wait `ms`, or until the command is stopped, whichever comes first. Resolves (never rejects) either way: the
 * caller's next step is a request path or a loop-top check that already throws CommandStoppedError.
 * WHY one helper: a bare setTimeout backoff ignored --command_timeout until it ran out, so a 60-350 s breaker
 * rung or a --until-done backoff ended in the 30 s hard kill with no summary. It reads the same stop state as
 * everything else; there is no second stop mechanism. The timer deliberately holds the process open: the caller is awaiting
 * this wait, and a timer that did not hold the process would let Node exit mid-wait and lose the run. A stop clears it through `done`.
 */
export function stoppableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (reason !== null || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      wakers.delete(done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.add(done);
    // An optional caller signal ends the wait the same way a stop does (issue 19 / TRDD-3SNQAGIC): a cancelled
    // losing racer parked in a 1-350 s backoff would otherwise keep this timer, and so the process, alive.
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Aborts when the command stops: a poll would see the stop only on its next turn, up to 2 s later, and --command_timeout must end a governor wait at once. */
export function commandStopSignal(): AbortSignal {
  return stopController.signal;
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
    `UNFINISHED (${unfinished.length}, stopped by ${stoppedBy}):`,
    ...unfinished.map((r) => `  ${r.filePath}: ${r.error === undefined || r.error === "Batch aborted" ? why : r.error}`),
  ];
}

/** True once the command is stopping (the summaries then list unfinished files instead of their FAILED block). */
export function isCommandStopped(): boolean {
  return reason !== null;
}

/**
 * The exit outcome of a multi-file command (TRDD-PN84WC1L): an abort or ANY failed file
 * is an error (exit 1), but `partial` marks that some files DID deliver results, so the CLI
 * prints the summary (report paths) on stdout, where a clean run printed them, instead of
 * stderr. WHY: a caller parsing report paths from stdout must not lose 99 good results
 * because 1 of 100 files failed. A stopped command is not decided here: the CLI exits 124.
 */
export function runOutcome(aborted: boolean, failedCount: number, succeededCount: number): { isError: boolean; partial?: true } {
  const isError = aborted || failedCount > 0;
  return isError && succeededCount > 0 ? { isError, partial: true } : { isError };
}

/** Header of the FAILED block of a multi-file summary: how many of the files failed (TRDD-PN84WC1L), counted in the same unit as `total` (one result per file). */
export function failedHeader(failedCount: number, total: number): string {
  return `FAILED (${failedCount} of ${total}):`;
}
/** Follow-up review m2: once stopped, an abort's reason is the stop (a "3 of the last 3 failed" text would suggest an outage). */
export function abortReasonText(abortReason: string): string {
  return reason ?? abortReason;
}
