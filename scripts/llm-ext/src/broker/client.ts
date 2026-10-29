/**
 * broker/client.ts — the command-process side of the local-model broker
 * (spec points 1, 2, 4 and 11): find or start the broker, submit a finished
 * request body, long-poll for the result, cancel on abort.
 *
 * It holds NO timer and no handle between calls: every wait is an HTTP long
 * poll the broker bounds (60 s), so a finished command exits at once
 * (launcher-boot.test.ts rule).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { spawnDetachedChild } from "../bench-spawn.js";
import { fileURLToPath } from "node:url";
import { attachFailure, stoppedError, throwIfStopped } from "../provider/http.js";
import { CommandStoppedError, commandStopReason, stopCommand } from "../command-stop.js";
import { ManagedServerError, pidState, withAsyncLock } from "../local-llama-server.js";
import {
  BROKER_ARGV,
  COMMAND_HEADER,
  CTX_HEADER,
  ENGINE_HEADER,
  DISPATCHED_HEADER,
  QUEUE_TIMEOUT_HEADER,
  STATE_HEADER,
  HELD_HEADER,
  TIMEOUT_HEADER,
  TOKEN_HEADER,
  brokerLogPath,
  brokerSpawnLockPath,
  readBrokerState,
  isBrokerProcess,
  type BrokerEngine,
  type BrokerState,
  type JobReply,
} from "./protocol.js";

/** How long a client waits for a broker it started to write its state file. */
const START_WAIT_MS = 15_000;
/** The wait a client asks for on every poll; the broker caps it at its own pollWaitMs (spec 4: 60 s). */
const POLL_WAIT_S = 60;
/** Health checks of a live broker before giving up (each up to 3 s, HEALTH_RETRY_MS apart): about 15 s on a loaded machine. */
const HEALTH_TRIES = 4;
const HEALTH_RETRY_MS = 1000;

/** One id per command process: the unit of the broker's round-robin (spec 3). */
export const COMMAND_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * This process's llm-ext version, set once by cli/main.ts (the VERSION anchor
 * publish.py rewrites lives there, so it is handed in rather than duplicated).
 * A broker of another version is drained and replaced (spec 11).
 */
let clientVersion: string | null = null;
export function setBrokerClientVersion(version: string): void {
  clientVersion = version;
}
export function brokerClientVersion(): string {
  if (clientVersion === null) throw new BrokerUnavailableError("the llm-ext version was never set for the broker client (cli/main.ts sets it at start)");
  return clientVersion;
}


/**
 * --queue_timeout for this command, in ms (USER ruling 2026-10-28): every job
 * this process submits carries it; once a job's wait nears it, the broker
 * rotates its model in after the current model's minimum slice (spec 6). A
 * large value lets the job wait. Undefined = the broker default T (5 min).
 * Waiting past it is never an error.
 */
let queueTimeoutMs: number | undefined;
export function setBrokerQueueTimeoutMs(ms: number | undefined): void {
  queueTimeoutMs = ms;
}
export function brokerQueueTimeoutMs(): number | undefined {
  return queueTimeoutMs;
}

export interface BrokerEndpoint {
  url: string;
  token: string;
  pid: number;
}

/**
 * A model-scoped failure the broker reported for a job (the model could not
 * start, its request failed or timed out). Marked final "stop" so
 * chatCompletionWithRetry neither retries it nor counts it toward the circuit
 * breaker: the broker already owns the execution, and a retry would just
 * queue the same failing work again. The fallback walker marks (URL, model)
 * dead for the walk, never the URL alone (spec 5).
 */
export class BrokerJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerJobError";
    attachFailure(this, { final: "stop" });
  }
}

/** The broker itself could not be reached or started: the whole URL is dead for the walk (spec 5). */
export class BrokerUnavailableError extends ManagedServerError {
  constructor(message: string) {
    super(message);
    this.name = "BrokerUnavailableError";
  }
}

/**
 * The walker's endpoint verdict for a failed chain entry (spec 5):
 * "endpoint-model" = the broker reported a failure for ONE model, so only
 * (URL, model) is dead; "endpoint" = the endpoint itself failed (a connection
 * error, or any ManagedServerError: the broker could not be started or
 * reached, or its spawn lock timed out, and as a "model" failure every next
 * model would wait out the same lock again); null = neither.
 * Review M11: BrokerJobError is tested FIRST, because its text quotes the
 * server's network error ("read ECONNRESET" when one model's server crashed)
 * and the regex would mark the whole broker URL dead, skipping every other
 * local model.
 */
export function endpointFailureKind(err: unknown, msg: string): "endpoint" | "endpoint-model" | null {
  if (err instanceof BrokerJobError) return "endpoint-model";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(msg) || err instanceof ManagedServerError) return "endpoint";
  return null;
}

function endpointOf(s: BrokerState): BrokerEndpoint {
  return { url: `http://127.0.0.1:${s.port}`, token: s.token, pid: s.pid };
}

async function health(s: BrokerState): Promise<{ version: string; draining: boolean } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/health`, { headers: { [TOKEN_HEADER]: s.token }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as { version: string; draining: boolean };
  } catch {
    return null;
  }
}

/** The broker entry this process can re-run: the bundle it was loaded from (dist/llm-ext.js in production). */
export function defaultBrokerEntry(): string {
  const self = fileURLToPath(import.meta.url);
  if (!/\.(m?js)$/.test(self)) throw new BrokerUnavailableError(`cannot start the broker from unbundled source (${self}); pass an entry`);
  return self;
}

export interface EnsureBrokerOptions {
  dir: string;
  version: string;
  /** The script started as `node <entry> __broker`; default: this bundle. */
  entry?: string;
  env?: NodeJS.ProcessEnv;
  /** P6: skip the per-process memo (the remembered broker gave a job back because it is exiting). */
  fresh?: boolean;
}

/** Last broker seen by this process, per config dir; re-validated with kill(pid,0) on every use. */
const known = new Map<string, BrokerEndpoint>();

/**
 * Find the live broker of this version, or start one. ONE broker serves every
 * local engine (TRDD-ZGSGGHQG): the spawn happens under the broker spawn lock
 * after a re-check (spec 1). A broker of another version is asked to drain and
 * exit, and a new one is started at once (spec 11); the new one waits for the
 * old one's main server slot (registry), so the two never run two main servers.
 */
export async function ensureBroker(o: EnsureBrokerOptions): Promise<BrokerEndpoint> {
  const memo = known.get(o.dir);
  if (memo && !o.fresh && pidState(memo.pid) === "alive") return memo;
  const usable = async (): Promise<BrokerEndpoint | null> => {
    const s = readBrokerState(o.dir);
    if (!s || pidState(s.pid) !== "alive") return null;
    // A live pid that is not a broker (reused after the broker died): the state is stale, a new broker may start.
    if (!(await isBrokerProcess(s.pid))) return null;
    // Review M9: a LIVE broker whose health check fails is never answered with a
    // second spawn (spec 1: one broker): retry a bounded number of times, then
    // fail fast with BrokerUnavailableError.
    let h: Awaited<ReturnType<typeof health>> = null;
    for (let i = 0; i < HEALTH_TRIES && h === null; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, HEALTH_RETRY_MS));
      h = await health(s);
    }
    if (h === null) {
      throw new BrokerUnavailableError(
        `the local-model broker (pid ${s.pid}) is running but did not answer its health check ${HEALTH_TRIES} times; not starting a second broker. See ${brokerLogPath(o.dir)}`,
      );
    }
    if (h.draining) return null;
    if (h.version !== o.version) {
      // Handover: ask the old broker to stop accepting, drain and exit.
      await fetch(`http://127.0.0.1:${s.port}/v1/shutdown`, { method: "POST", headers: { [TOKEN_HEADER]: s.token }, signal: AbortSignal.timeout(3000) }).catch(
        () => undefined,
      );
      return null;
    }
    return endpointOf(s);
  };
  mkdirSync(o.dir, { recursive: true });
  const ep =
    (await usable()) ??
    (await withAsyncLock(brokerSpawnLockPath(o.dir), async () => {
      const again = await usable();
      if (again) return again;
      const before = readBrokerState(o.dir)?.pid;
      startBroker(o);
      const deadline = Date.now() + START_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const s = readBrokerState(o.dir);
        if (s && s.pid !== before && (await health(s))?.version === o.version) return endpointOf(s);
      }
      throw new BrokerUnavailableError(`the local-model broker did not start within ${START_WAIT_MS / 1000} s; see ${brokerLogPath(o.dir)}`);
    }));
  known.set(o.dir, ep);
  return ep;
}

/**
 * Start the detached broker through bench-spawn.ts (the one place detached
 * children are spawned): log fd lifetime, error listener and unref are owned
 * there; the broker outlives this command.
 */
function startBroker(o: EnsureBrokerOptions): void {
  spawnDetachedChild({
    command: process.execPath,
    args: [o.entry ?? defaultBrokerEntry(), BROKER_ARGV],
    logPath: brokerLogPath(o.dir),
    env: { ...(o.env ?? process.env), LLM_EXT_CONFIG_DIR: o.dir },
    onError: (e) => process.stderr.write(`[llm-externalizer] the local-model broker failed to start: ${e.message}\n`),
  });
}

export interface BrokerJobRequest {
  /** The engine whose server runs it (TRDD-ZGSGGHQG). */
  engine: BrokerEngine;
  /** The finished request body (JSON text), exactly as it would go to the server. */
  body: string;
  model: string;
  ctx: number;
  /** Execution timeout, counted by the broker from dispatch. */
  timeoutMs: number;
  /** --queue_timeout in ms; undefined = the broker's default T. */
  queueTimeoutMs?: number;
}

/** Jobs submitted but not yet finished, per logical call (chatCompletionWithRetry's call object) and request identity: a retry of that call reuses its pending job (spec 4). */
const pendingByScope = new WeakMap<object, Map<string, string>>();

/** Every job this process has at a broker and not yet seen finish, by id (for --command_timeout). */
const active = new Map<string, BrokerEndpoint>();
/** Job submissions (POST /v1/jobs) still in flight (review m1). */
const submitting = new Set<Promise<string>>();
/** How long a --command_timeout waits for in-flight submissions before it cancels what it has. */
const SUBMIT_DRAIN_MS = 5000;
/** P6: how many times one call follows a `requeued` reply to the current broker (each is a broker exit or an abandoned held job). */
const MAX_REQUEUES = 10;
/** P6 (review F4): the held-for-calibration line is printed at once, then at most this often, per model. */
const HELD_PRINT_MS = 60_000;
const heldPrintedAt = new Map<string, number>();
function printHeld(model: string, engine: BrokerEngine): void {
  const last = heldPrintedAt.get(model) ?? 0;
  if (Date.now() - last < HELD_PRINT_MS) return;
  heldPrintedAt.set(model, Date.now());
  process.stderr.write(`llm-ext: waiting for the calibration of '${model}' (${engine}); llm-ext models calibration-status shows its progress\n`);
}

/** Calls cancelling their own job (the finally of brokerExchange), and the job ids whose DELETE failed once the command was stopping (follow-up review m1). */
const selfCancels = new Set<Promise<void>>();
const uncancelled: string[] = [];

/**
 * --command_timeout expiry (USER ruling 2026-10-28): stop submitting (the
 * shared command-stop flag) and cancel (DELETE) every job this command still
 * has queued or polling, so none of them is left in the broker queue.
 * Follow-up review m1: `cancelled` counts only DELETEs the broker confirmed;
 * `failed` names every job whose DELETE it did not (broker down or slow),
 * including those a stopping call tried to cancel itself; they are left to
 * the broker's abandon rule. Never a silent "N cancelled".
 */
export async function cancelAllBrokerJobs(reason: string): Promise<{ cancelled: number; failed: string[] }> {
  stopCommand(reason);
  // Review m1: wait (bounded) for submissions still in flight, so their jobs are in `active` before the snapshot.
  await Promise.race([Promise.allSettled([...submitting]), new Promise((r) => setTimeout(r, SUBMIT_DRAIN_MS).unref())]);
  const jobs = [...active.entries()];
  active.clear();
  const ok = await Promise.all(jobs.map(([id, ep]) => cancel(ep, id)));
  // Each own-cancel DELETE is bounded (3 s), so this wait is too.
  await Promise.allSettled([...selfCancels]);
  return { cancelled: ok.filter(Boolean).length, failed: [...jobs.filter((_, i) => !ok[i]).map(([id]) => id), ...uncancelled] };
}

/** DELETE one job; true when the broker no longer holds it (2xx, or 404 = already gone). */
async function cancel(ep: BrokerEndpoint, id: string): Promise<boolean> {
  const res = await fetch(`${ep.url}/v1/jobs/${id}`, { method: "DELETE", headers: { [TOKEN_HEADER]: ep.token }, signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (res === null) return false;
  await res.text().catch(() => undefined);
  return res.ok || res.status === 404;
}

/**
 * One request through the broker: submit (or reuse a pending job), then
 * long-poll until it finishes. Returns the server's reply as a Response so
 * the caller's handling is the same as for a direct fetch. Time spent queued
 * is excluded from the retry clock (spec 4): its deadline moves by the queue
 * time the broker reports. On abort, and on any exit other than a network
 * failure, a still-pending job is cancelled (DELETE); a network failure keeps
 * it, so a retry polls the same job instead of queueing a twin.
 */
export async function brokerExchange(
  ep: BrokerEndpoint,
  req: BrokerJobRequest,
  opts: {
    signal?: AbortSignal;
    onDispatched?: (at: number) => void;
    onQueued?: (ms: number) => void;
    scope?: object;
    /** P6 (review F1): find or start the current broker after this one gave a held job back (`requeued`). */
    reconnect?: () => Promise<BrokerEndpoint>;
  } = {},
): Promise<Response> {
  const reuseKey = createHash("sha256").update(`${ep.url}\u0000${req.engine}\u0000${req.model}\u0000${req.ctx}\u0000${req.body}`).digest("hex");
  // Reuse is scoped to ONE logical call (its retries): two concurrent calls with an identical body (two identical files, a benchmark repeating a prompt) must each get their own sampled result. No scope = no reuse.
  let pending = opts.scope ? pendingByScope.get(opts.scope) : undefined;
  if (opts.scope && !pending) pendingByScope.set(opts.scope, (pending = new Map()));
  pending ??= new Map<string, string>();
  let id = pending.get(reuseKey);
  let networkFailure = false;
  // P6: the broker this call talks to; a `requeued` reply moves it to the current one.
  let cur = ep;
  let requeues = 0;
  /** P6 (review F4): the model this call is waiting on calibration for, or null; named in a --command_timeout stop. */
  let heldOn: string | null = null;
  const noteHeld = (): void => {
    heldOn = req.model;
    printHeld(req.model, req.engine);
  };
  try {
    for (let resubmits = 0; ; ) {
      opts.signal?.throwIfAborted();
      throwIfStopped();
      const headers = { [TOKEN_HEADER]: cur.token };
      if (id === undefined) {
        const h: Record<string, string> = {
          ...headers,
          "content-type": "application/json",
          [COMMAND_HEADER]: COMMAND_ID,
          [CTX_HEADER]: String(req.ctx),
          [ENGINE_HEADER]: req.engine,
          [TIMEOUT_HEADER]: String(req.timeoutMs),
        };
        if (req.queueTimeoutMs !== undefined) h[QUEUE_TIMEOUT_HEADER] = String(req.queueTimeoutMs);
        // Review m1: the job is tracked from the START of its POST. The submission
        // promise is in `submitting` until the id is in `active`, so a
        // --command_timeout firing mid-POST waits for it and cancels the job,
        // instead of leaving it queued until the abandon rule drops it.
        const target = cur;
        const post = (async (): Promise<string> => {
          const res = await fetch(`${target.url}/v1/jobs`, { method: "POST", headers: h, body: req.body, signal: opts.signal }).catch((e: unknown) => {
            networkFailure = true;
            throw e;
          });
          const text = await res.text();
          if (res.status !== 202) throw new BrokerUnavailableError(`broker refused the job: HTTP ${res.status} ${text.slice(0, 200)}`);
          const accepted = JSON.parse(text) as { job: string; state?: string };
          active.set(accepted.job, target);
          // Review F4: say at once that the request waits for calibration, not after the first long-poll (60 s).
          if (accepted.state === "held") noteHeld();
          return accepted.job;
        })();
        submitting.add(post);
        try {
          id = await post;
        } finally {
          submitting.delete(post);
        }
        pending.set(reuseKey, id);
      }
      const res = await fetch(`${cur.url}/v1/jobs/${id}?wait=${POLL_WAIT_S}`, { headers, signal: opts.signal }).catch((e: unknown) => {
        networkFailure = !opts.signal?.aborted;
        throw e;
      });
      if (res.status === 204) {
        const at = res.headers.get(DISPATCHED_HEADER);
        const state = res.headers.get(STATE_HEADER);
        if (at !== null && state === "running") opts.onDispatched?.(Number(at));
        // P6: a job held for calibration waits (never an error, bounded only by --command_timeout).
        if (state === "held" && res.headers.get(HELD_HEADER) !== null) noteHeld();
        else heldOn = null;
        continue;
      }
      if (res.status === 404) {
        // The broker restarted and lost the job: submit again, once.
        pending.delete(reuseKey);
        active.delete(id);
        id = undefined;
        if (++resubmits > 1) throw new BrokerUnavailableError("the broker lost the job twice");
        continue;
      }
      // Review m4: only 200 carries a job result. Any other status (401, 500, …) or
      // a body that is not a JobReply is the BROKER failing (endpoint), never a
      // model-scoped BrokerJobError ("… undefined: …") nor a bare SyntaxError.
      if (res.status !== 200) throw new BrokerUnavailableError(`broker poll failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const replyText = await res.text();
      let reply: JobReply;
      try {
        reply = JSON.parse(replyText) as JobReply;
      } catch {
        throw new BrokerUnavailableError(`broker poll reply is not JSON: ${replyText.slice(0, 200)}`);
      }
      if (typeof reply?.state !== "string" || typeof reply.submittedAt !== "number") {
        throw new BrokerUnavailableError(`broker poll reply is not a job result: ${replyText.slice(0, 200)}`);
      }
      pending.delete(reuseKey);
      active.delete(id);
      id = undefined;
      // P6 (review F1, F7): the broker gave a held job back (it exited, or dropped
      // the job while this client was suspended). That is not a model failure:
      // submit it again to the current broker, where it is held again.
      if (reply.state === "requeued") {
        if (!opts.reconnect) throw new BrokerUnavailableError(`broker: ${reply.error ?? "the job was given back"}`);
        if (++requeues > MAX_REQUEUES) throw new BrokerUnavailableError(`broker: the job was given back ${requeues} times (${reply.error ?? "no detail"})`);
        cur = await opts.reconnect();
        continue;
      }
      // Queue time (dispatch - submit, broker clock) goes to the caller's CALL, never to a shared clock (review M10).
      // P6: time held for calibration counts as queue time too (submittedAt restarted at release).
      opts.onQueued?.((reply.dispatchedAt ?? reply.finishedAt ?? reply.submittedAt) - reply.submittedAt + (reply.heldMs ?? 0));
      // A job cancelled by --command_timeout ends this call as a command stop, not as a model failure.
      const stopWhy = commandStopReason();
      if (stopWhy !== null && reply.state === "cancelled") throw stoppedError(stopWhy);
      if (reply.state === "done") {
        return new Response(reply.body ?? "", { status: reply.status ?? 502, headers: { "content-type": reply.contentType ?? "application/json" } });
      }
      throw new BrokerJobError(`broker: model '${req.model}' ${reply.state}: ${reply.error ?? "no detail"}`);
    }
  } catch (err) {
    // Review F4: a --command_timeout that ends a wait for calibration says so.
    if (heldOn !== null && err instanceof CommandStoppedError) throw stoppedError(`${err.message} (the request was waiting for the calibration of '${heldOn}'; llm-ext models calibration-status)`);
    throw err;
  } finally {
    if (id !== undefined && !networkFailure) {
      pending.delete(reuseKey);
      active.delete(id);
      // Follow-up review m1: a call that ends because of the stop cancels its own
      // job here, possibly before cancelAllBrokerJobs takes its snapshot; a
      // DELETE the broker did not confirm is recorded for its report.
      const jobId = id;
      const own = cancel(cur, jobId).then((ok) => {
        if (!ok && commandStopReason() !== null) uncancelled.push(jobId);
      });
      selfCancels.add(own);
      await own;
      selfCancels.delete(own);
    }
  }
}
