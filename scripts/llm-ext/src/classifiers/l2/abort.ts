// L2-18, plan D11 and §14 row 29: Ctrl-C during a classify fan-out aborts every in-flight request and keeps what finished.
import { DeadlineError, createDeadline, type Deadline } from "../l0/deadline.js";

/** Shell convention for a process ended by SIGINT. */
export const CTRL_C_EXIT_CODE = 130;

/** process, or any emitter of SIGINT (tests use a real EventEmitter). */
export interface SignalSource {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export interface CtrlC {
  /** Aborted by the first SIGINT; pass it to runCancellable, which feeds it into every request createDeadline. */
  readonly signal: AbortSignal;
  dispose(): void;
}

export function installCtrlC(source: SignalSource = process): CtrlC {
  const ctl = new AbortController();
  const onSigint = (): void => {
    // WHY remove before aborting: while any SIGINT listener exists Node does not exit, so keeping ours would swallow a second Ctrl-C and leave a stuck run unkillable.
    source.off("SIGINT", onSigint);
    ctl.abort(new DeadlineError("aborted"));
  };
  source.on("SIGINT", onSigint);
  return { signal: ctl.signal, dispose: () => source.off("SIGINT", onSigint) };
}

export type Outcome<R> =
  | { status: "done"; value: R }
  | { status: "failed"; error: unknown }
  | { status: "aborted" }
  | { status: "skipped" };

export interface CancellableOptions<T, R> {
  concurrency: number;
  /** Per-request deadline, created fresh for each item and combined with `signal`. */
  timeoutMs: number;
  signal: AbortSignal;
  worker: (item: T, index: number, deadline: Deadline) => Promise<R>;
  /** Called the moment a request finishes, abort or not: this is where its usage is recorded (E53). */
  onDone?: (index: number, value: R) => void;
}

/**
 * Runs `worker` over `items` with bounded concurrency. Never rejects because of an abort: every item gets an
 * outcome, so the usage of finished requests survives a Ctrl-C (E53). Items not started when the signal fires are skipped.
 */
export async function runCancellable<T, R>(
  items: readonly T[],
  opts: CancellableOptions<T, R>,
): Promise<{ outcomes: Outcome<R>[]; aborted: boolean }> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${opts.concurrency}`);
  }
  const outcomes: Outcome<R>[] = items.map(() => ({ status: "skipped" }));
  let next = 0;

  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      if (opts.signal.aborted) return;
      const deadline = createDeadline({ timeoutMs: opts.timeoutMs, signal: opts.signal });
      try {
        const value = await opts.worker(items[i], i, deadline);
        // WHY done even if the signal fired meanwhile: the reply arrived and was billed, so it must be recorded, not discarded.
        outcomes[i] = { status: "done", value };
        opts.onDone?.(i, value);
      } catch (error) {
        // WHY the deadline reason, not the error type: after an abort, fetch fails with its own error shape, but the cause is still the abort.
        outcomes[i] = deadline.reason === "aborted" ? { status: "aborted" } : { status: "failed", error };
      } finally {
        deadline.dispose();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, items.length) }, lane));
  return { outcomes, aborted: opts.signal.aborted };
}
