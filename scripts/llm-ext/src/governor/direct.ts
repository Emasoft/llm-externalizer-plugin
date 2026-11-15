/**
 * governor/direct.ts — the lease around a send that reaches a model server
 * without the broker (design/specs/local-inference-governor-design.md D9): a
 * user-started server, a benchmark, calibration. Only a loopback URL takes one.
 * A LAN or remote server spends another machine's memory, so such a send never
 * touches the governor directory.
 */

import { commandStopSignal } from "../command-stop.js";
import { isLoopbackUrl } from "../config.js";
import { throwIfStopped, type AttemptGate } from "../provider/http.js";
import { acquire, release, type Lease } from "./client.js";
import { governorConfig } from "./settings.js";
import { governorDir } from "./state.js";

export interface DirectLeaseOptions {
  /** A step that sends this many requests at once takes one lease for them all, so a smaller window cannot be measured as a slower model (D9). */
  weight?: number;
  /**
   * D10, round 2 M4: the threads and pid of the server, when llm-ext started it (a cal server): the budget then counts it
   * once, by T, like a broker server. Absent for a user-started server, whose threads are unknown (D9, D14).
   */
  threads?: number;
  serverPid?: number;
  /** The caller's own end to the wait, beside the stop of the command. */
  signal?: AbortSignal;
  /** The time spent waiting, once the lease exists: the caller must keep it out of its request timeout (D9). Not called for a send that takes no lease. */
  onWaited?: (ms: number) => void;
}

/**
 * The lease for a send to `url`, or null when it needs none; pair it with
 * `releaseDirectLease` in a `finally`. Waiting is never an error, so
 * --stop_on_errors cannot fire here. It ends in a lease, or at once on a stop
 * (--command_timeout), so a run keeps its finished results. A governor that
 * cannot answer fails the send naming its directory: an ungoverned send is the
 * one thing this module exists to prevent.
 */
export async function takeDirectLease(url: string, timeoutMs: number, options: DirectLeaseOptions = {}): Promise<Lease | null> {
  // D13: enabled: false sends directly, as before the governor, and never touches the directory. A malformed setting
  // throws here, naming settings.yaml or the env variable: never an ungoverned send by mistake.
  if (!isLoopbackUrl(url) || !governorConfig().enabled) return null;
  const dir = governorDir();
  const t0 = Date.now();
  // AbortSignal.any, a new signal per wait: a listener per wait on the one stop signal would print MaxListenersExceededWarning from 11 parallel requests on.
  const signal = AbortSignal.any(options.signal ? [commandStopSignal(), options.signal] : [commandStopSignal()]);
  try {
    // A user-started server passes no `threads`: its threads are unknown (llama-server's /props and /slots carry no thread
    // count, checked in unit 5), so only the CPU reading and max_inferences bound it (D9, D14). A cal server passes its T.
    const lease = await acquire({ timeoutMs, weight: options.weight, threads: options.threads, serverPid: options.serverPid }, { signal });
    options.onWaited?.(Date.now() - t0);
    return lease;
  } catch (err) {
    // The abort reason carries no failure fields; this rethrows the stop marked final, which no retry or fallback touches.
    throwIfStopped();
    if (options.signal?.aborted) throw err;
    throw new Error(`local inference governor at ${dir} failed, request not sent: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export function releaseDirectLease(lease: Lease | null): void {
  if (lease) release(lease);
}

/** One send of any shape under a lease, released on every way out. */
export async function withDirectLease<T>(url: string, timeoutMs: number, send: () => Promise<T>, options: DirectLeaseOptions = {}): Promise<T> {
  const lease = await takeDirectLease(url, timeoutMs, options);
  try {
    return await send();
  } finally {
    releaseDirectLease(lease);
  }
}

/**
 * The response, returned at once, whose lease is released when the caller's
 * body read ends: at its end, on a read error, or on a cancel. WHY not at the
 * headers: fetch resolves there, and a server that flushes them early is still
 * generating (provider/http.ts, TRDD-0H5N1V9W), so a release there would admit
 * another inference beside it. WHY not by reading the body here first: that
 * defeats an incremental reader, and a server that sends headers then stalls
 * would hold the lease with no bound but the lease expiry. That expiry is the
 * backstop here too, for a caller that neither reads nor cancels the body.
 */
export function releaseAtBodyEnd(res: Response, lease: Lease | null): Response {
  if (!lease) return res;
  if (!res.body) {
    release(lease);
    return res;
  }
  let released = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    clearTimeout(backstop);
    release(lease);
  };
  // unref: a process whose caller has finished must not stay alive for a timer that only returns a lease.
  const backstop = setTimeout(finish, Math.max(0, lease.expiresAt - Date.now()));
  backstop.unref();
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          finish();
          controller.error(err);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    },
    // 0: no read ahead of the caller, so the lease ends with the caller's own read.
    { highWaterMark: 0 },
  );
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** One HTTP send under a lease that lasts to the end of its body (see releaseAtBodyEnd). */
export async function leasedResponse(url: string, timeoutMs: number, send: () => Promise<Response>, options: DirectLeaseOptions = {}): Promise<Response> {
  const lease = await takeDirectLease(url, timeoutMs, options);
  let res: Response;
  try {
    res = await send();
  } catch (err) {
    releaseDirectLease(lease);
    throw err;
  }
  return releaseAtBodyEnd(res, lease);
}

/**
 * The gate fetchWithRetry429 runs around each single attempt: one lease per
 * attempt, held to the end of that attempt's body, so a 429 backoff or a
 * retry sleep holds no slot while the server computes nothing, and each lease
 * lives only as long as one request, inside its expiry. Undefined for a URL
 * that is not this machine.
 */
export function directAttemptGate(url: string, timeoutMs: number, options: DirectLeaseOptions = {}): AttemptGate | undefined {
  if (!isLoopbackUrl(url)) return undefined;
  return (fetchOnce, waited) =>
    leasedResponse(url, timeoutMs, fetchOnce, {
      ...options,
      onWaited: (ms) => {
        waited(ms);
        options.onWaited?.(ms);
      },
    });
}
