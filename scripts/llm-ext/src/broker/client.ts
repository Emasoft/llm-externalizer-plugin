/**
 * broker/client.ts — the command-process side of the per-engine broker
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
import { attachFailure, type RetryClock } from "../provider/http.js";
import { ManagedServerError, pidState, withAsyncLock } from "../local-llama-server.js";
import {
  BROKER_ARGV,
  COMMAND_HEADER,
  CTX_HEADER,
  DISPATCHED_HEADER,
  QUEUE_TIMEOUT_HEADER,
  STATE_HEADER,
  TIMEOUT_HEADER,
  TOKEN_HEADER,
  brokerLogPath,
  brokerSpawnLockPath,
  readBrokerState,
  type BrokerEngine,
  type BrokerState,
  type JobReply,
} from "./protocol.js";

/** How long a client waits for a broker it started to write its state file. */
const START_WAIT_MS = 15_000;
/** The wait a client asks for on every poll; the broker caps it at its own pollWaitMs (spec 4: 60 s). */
const POLL_WAIT_S = 60;

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
 * this process submits carries it, and the broker forces a rotation to its
 * model once it waited longer. Undefined = the broker default T (5 min).
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
  engine: BrokerEngine;
  dir: string;
  version: string;
  /** The script started as `node <entry> __broker <engine>`; default: this bundle. */
  entry?: string;
  env?: NodeJS.ProcessEnv;
}

/** Last broker seen by this process, per config dir; re-validated with kill(pid,0) on every use. */
const known = new Map<string, BrokerEndpoint>();

/**
 * Find the live broker of this engine and version, or start one. One broker
 * per engine: the spawn happens under the broker spawn lock after a re-check
 * (spec 1). A broker of another version is asked to drain and exit, and a new
 * one is started at once (spec 11); the new one waits for the old one's main
 * server slot (registry), so the two never run two main servers.
 */
export async function ensureBroker(o: EnsureBrokerOptions): Promise<BrokerEndpoint> {
  const memo = known.get(`${o.dir}\u0000${o.engine}`);
  if (memo && pidState(memo.pid) === "alive") return memo;
  const usable = async (): Promise<BrokerEndpoint | null> => {
    const s = readBrokerState(o.dir, o.engine);
    if (!s || pidState(s.pid) !== "alive") return null;
    const h = await health(s);
    if (!h || h.draining) return null;
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
    (await withAsyncLock(brokerSpawnLockPath(o.dir, o.engine), async () => {
      const again = await usable();
      if (again) return again;
      const before = readBrokerState(o.dir, o.engine)?.pid;
      startBroker(o);
      const deadline = Date.now() + START_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const s = readBrokerState(o.dir, o.engine);
        if (s && s.pid !== before && (await health(s))?.version === o.version) return endpointOf(s);
      }
      throw new BrokerUnavailableError(`the ${o.engine} broker did not start within ${START_WAIT_MS / 1000} s; see ${brokerLogPath(o.dir, o.engine)}`);
    }));
  known.set(`${o.dir}\u0000${o.engine}`, ep);
  return ep;
}

/**
 * Start the detached broker (the spawnDetachedBench mechanics, bench-spawn.ts):
 * log fd opened before spawn and OUR copy closed after (a leaked fd per spawn
 * otherwise), an 'error' listener (an unlistened async spawn error would be an
 * uncaught exception), detached + unref so it outlives this command.
 */
/**
 * Start the detached broker through bench-spawn.ts (the one place detached
 * children are spawned): log fd lifetime, error listener and unref are owned
 * there; the broker outlives this command.
 */
function startBroker(o: EnsureBrokerOptions): void {
  spawnDetachedChild({
    command: process.execPath,
    args: [o.entry ?? defaultBrokerEntry(), BROKER_ARGV, o.engine],
    logPath: brokerLogPath(o.dir, o.engine),
    env: { ...(o.env ?? process.env), LLM_EXT_CONFIG_DIR: o.dir },
    onError: (e) => process.stderr.write(`[llm-externalizer] the ${o.engine} broker failed to start: ${e.message}\n`),
  });
}

export interface BrokerJobRequest {
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
/** Set once the command is being stopped: no further job is submitted. */
let stopped: string | null = null;

/**
 * --command_timeout expiry (USER ruling 2026-10-28): stop submitting and
 * cancel (DELETE) every job this command still has queued or polling, so none
 * of them is left in the broker queue. Returns how many were cancelled.
 */
export async function cancelAllBrokerJobs(reason: string): Promise<number> {
  stopped = reason;
  const jobs = [...active.entries()];
  active.clear();
  await Promise.all(jobs.map(([id, ep]) => cancel(ep, id)));
  return jobs.length;
}

async function cancel(ep: BrokerEndpoint, id: string): Promise<void> {
  await fetch(`${ep.url}/v1/jobs/${id}`, { method: "DELETE", headers: { [TOKEN_HEADER]: ep.token }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
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
  opts: { clock?: RetryClock; signal?: AbortSignal; onDispatched?: (at: number) => void; scope?: object } = {},
): Promise<Response> {
  const reuseKey = createHash("sha256").update(`${ep.url}\u0000${req.model}\u0000${req.ctx}\u0000${req.body}`).digest("hex");
  // Reuse is scoped to ONE logical call (its retries): two concurrent calls with an identical body (two identical files, a benchmark repeating a prompt) must each get their own sampled result. No scope = no reuse.
  let pending = opts.scope ? pendingByScope.get(opts.scope) : undefined;
  if (opts.scope && !pending) pendingByScope.set(opts.scope, (pending = new Map()));
  pending ??= new Map<string, string>();
  let id = pending.get(reuseKey);
  let networkFailure = false;
  const headers = { [TOKEN_HEADER]: ep.token };
  try {
    for (let resubmits = 0; ; ) {
      opts.signal?.throwIfAborted();
      if (stopped !== null) throw new Error(stopped);
      if (id === undefined) {
        const h: Record<string, string> = {
          ...headers,
          "content-type": "application/json",
          [COMMAND_HEADER]: COMMAND_ID,
          [CTX_HEADER]: String(req.ctx),
          [TIMEOUT_HEADER]: String(req.timeoutMs),
        };
        if (req.queueTimeoutMs !== undefined) h[QUEUE_TIMEOUT_HEADER] = String(req.queueTimeoutMs);
        const res = await fetch(`${ep.url}/v1/jobs`, { method: "POST", headers: h, body: req.body, signal: opts.signal }).catch((e: unknown) => {
          networkFailure = true;
          throw e;
        });
        const text = await res.text();
        if (res.status !== 202) throw new BrokerUnavailableError(`broker refused the job: HTTP ${res.status} ${text.slice(0, 200)}`);
        id = (JSON.parse(text) as { job: string }).job;
        pending.set(reuseKey, id);
        active.set(id, ep);
      }
      const res = await fetch(`${ep.url}/v1/jobs/${id}?wait=${POLL_WAIT_S}`, { headers, signal: opts.signal }).catch((e: unknown) => {
        networkFailure = !opts.signal?.aborted;
        throw e;
      });
      if (res.status === 204) {
        const at = res.headers.get(DISPATCHED_HEADER);
        if (at !== null && res.headers.get(STATE_HEADER) === "running") opts.onDispatched?.(Number(at));
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
      const reply = (await res.json()) as JobReply;
      pending.delete(reuseKey);
      active.delete(id);
      id = undefined;
      const clock = opts.clock;
      if (clock?.deadlineAt !== undefined) clock.deadlineAt += (reply.dispatchedAt ?? reply.finishedAt ?? reply.submittedAt) - reply.submittedAt;
      if (reply.state === "done") {
        return new Response(reply.body ?? "", { status: reply.status ?? 502, headers: { "content-type": reply.contentType ?? "application/json" } });
      }
      throw new BrokerJobError(`broker: model '${req.model}' ${reply.state}: ${reply.error ?? "no detail"}`);
    }
  } finally {
    if (id !== undefined && !networkFailure) {
      pending.delete(reuseKey);
      active.delete(id);
      await cancel(ep, id);
    }
  }
}
