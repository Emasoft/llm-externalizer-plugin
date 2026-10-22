// One deadline per call, shared by every attempt, combined with the caller's abort signal (plan §7, E10).

export const DEFAULT_TIMEOUT_MS = 60_000;

export type DeadlineReason = 'timeout' | 'aborted';

/** Thrown by Deadline.sleep / throwIfDone so callers can tell a spent budget from a caller abort. */
export class DeadlineError extends Error {
  constructor(readonly reason: DeadlineReason) {
    super(reason === 'timeout' ? 'deadline exceeded' : 'aborted by caller');
    this.name = 'DeadlineError';
  }
}

export interface Deadline {
  /** Fires on the deadline or on the caller's abort; pass it to fetch. */
  readonly signal: AbortSignal;
  /** Why it fired, or undefined while still live. */
  readonly reason: DeadlineReason | undefined;
  remainingMs(): number;
  throwIfDone(): void;
  /** Waits ms, cut at the deadline; rejects with DeadlineError at once on abort or deadline. */
  sleep(ms: number): Promise<void>;
  /** Clears the timer and the caller-signal listener. */
  dispose(): void;
}

export interface DeadlineOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// WHY one Deadline for the whole call and not one timer per attempt: per-attempt timers would let
// 3 attempts plus backoff waits run for 3x timeout_ms; the caller's budget is for the call.
export function createDeadline(opts: DeadlineOptions = {}): Deadline {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  const ctl = new AbortController();
  let reason: DeadlineReason | undefined;
  const fire = (r: DeadlineReason): void => {
    if (reason) return;
    reason = r;
    ctl.abort(new DeadlineError(r));
  };
  const endsAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => fire('timeout'), timeoutMs);
  // WHY unref: an undisposed deadline must never hold the CLI process open for up to timeoutMs after its work is done.
  timer.unref();
  const onCallerAbort = (): void => fire('aborted');
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (opts.signal?.aborted) onCallerAbort();

  const dispose = (): void => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  };
  const throwIfDone = (): void => {
    if (reason) throw new DeadlineError(reason);
  };

  return {
    signal: ctl.signal,
    get reason() {
      return reason;
    },
    remainingMs: () => Math.max(0, endsAt - Date.now()),
    throwIfDone,
    dispose,
    sleep(ms: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (reason) return reject(new DeadlineError(reason));
        // WHY the wait is listener-driven: an abort must end the retry wait at once (E10), not at the next tick of a timer.
        const t = setTimeout(() => {
          ctl.signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(t);
          reject(new DeadlineError(reason ?? 'aborted'));
        };
        ctl.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
