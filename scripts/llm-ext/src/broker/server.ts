/**
 * broker/server.ts — the per-engine request broker process (TRDD-1OOAH3LD,
 * TRDD-ZGSGGHQG; design/specs/local-engine-broker-design.md).
 *
 * A detached llm-ext child (`llm-ext __broker llama`) that owns the engine's
 * single main llama-server. Every command process submits its finished
 * request bodies here (POST /v1/jobs) and long-polls for the result
 * (GET /v1/jobs/<id>?wait=60), so requests from all running commands are
 * grouped by model, each model batch runs on one server, and the model is
 * swapped (process-group stop + start) by the rotation rules in
 * scheduler.ts. It is a separate process on purpose: a command process must
 * hold no timer or open handle once it finishes (index.ts, launcher-boot.test.ts).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ManagedServerError,
  parseManagedModel,
  freePort,
  pidState,
  spawnLlamaServer,
  stopProcessGroup,
  totalSlots,
  waitReady,
  SPAWN_MARKER,
} from "../local-llama-server.js";
import { claimAndSpawn, releaseEntry, roleLogFile, SlotBusyError } from "./registry.js";
import { queueKey, Scheduler, timingsFromEnv, type BrokerTimings, type Job } from "./scheduler.js";
import { getConfigDir } from "../config.js";
import {
  COMMAND_HEADER,
  CTX_HEADER,
  DISPATCHED_HEADER,
  QUEUE_TIMEOUT_HEADER,
  STATE_HEADER,
  TIMEOUT_HEADER,
  TOKEN_HEADER,
  removeBrokerStateIfOwn,
  writeBrokerState,
  type BrokerEngine,
  type JobReply,
} from "./protocol.js";

export interface BrokerOptions {
  engine: BrokerEngine;
  dir: string;
  version: string;
  timings: BrokerTimings;
  log: (msg: string) => void;
}

/** Default execution timeout when a client sends none (the soft timeout's default, 300 s). */
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
/** How often the broker re-evaluates abandon, rotation and idle rules between events. */
const TICK_MS = 1000;
/** How long a finished job's result stays readable after it finished or was last polled. */
const FINISHED_KEEP_MS = 600_000;
/** A request body above this is refused: a local model's context bounds a real request far below it. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface RunningServer {
  key: string;
  model: string;
  ctx: number;
  port: number;
  pid: number;
  pgid: number;
  slots: number;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * POST to the llama-server with node:http, NOT fetch: a non-streamed
 * completion sends no header until it is finished, and undici's 300 s default
 * headers timeout (Node 26 global fetch, measured; node:undici is not
 * importable) would cut any generation longer than that. node:http has no
 * such timeout; the job's own execution timeout bounds it instead.
 */
function postJson(port: number, body: string, signal: AbortSignal): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, signal },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), contentType: String(res.headers["content-type"] ?? "application/json") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export async function runBroker(o: BrokerOptions): Promise<void> {
  const t = o.timings;
  const sched = new Scheduler();
  const jobs = new Map<string, Job>();
  const running = new Map<string, AbortController>();
  const waiters = new Map<string, Set<() => void>>();
  let server: RunningServer | null = null;
  let swapping = false;
  let draining = false;
  let exiting = false;
  let lastRequestAt = Date.now();
  let busyLogged = false;
  const token = randomBytes(24).toString("hex");
  mkdirSync(o.dir, { recursive: true });

  const notify = (job: Job): void => {
    for (const w of waiters.get(job.id) ?? []) w();
    waiters.delete(job.id);
  };
  const finish = (job: Job, state: "done" | "failed" | "cancelled", error?: string): void => {
    job.state = state;
    job.finishedAt = Date.now();
    if (error !== undefined) job.error = error;
    notify(job);
  };

  const stopServer = async (why: string): Promise<void> => {
    const s = server;
    if (!s) return;
    server = null;
    const how = await stopProcessGroup(s.pgid);
    await releaseEntry(o.dir, o.engine, s.pid);
    o.log(`stopped main llama-server pid ${s.pid} model '${s.model}' (${why}): ${how}`);
  };

  /** Fail every queued job of `key` (a model-scoped failure: other models are still served, spec 5). */
  const failQueued = (key: string, error: string): void => {
    for (const j of sched.allQueued(key)) {
      sched.remove(j);
      finish(j, "failed", error);
    }
  };

  const swapTo = async (key: string): Promise<void> => {
    swapping = true;
    let spawnedPgid: number | null = null;
    try {
      if (server) await stopServer(`swap to '${key.split("\u0000")[0]}'`);
      const first = sched.allQueued(key)[0];
      if (!first) return;
      const parsed = parseManagedModel(first.model);
      if ("error" in parsed) throw new ManagedServerError(parsed.error);
      const port = await freePort();
      const target = { port, model: first.model, ctx: first.ctx };
      const logFile = roleLogFile(o.dir, "main");
      let exited = false;
      const entry = await claimAndSpawn({
        dir: o.dir,
        engine: o.engine,
        role: "main",
        ownerPid: process.pid,
        log: o.log,
        spawn: async () => {
          const s = await spawnLlamaServer(target, parsed.argv, logFile);
          s.child.once("exit", () => {
            exited = true;
          });
          // Tests count spawns by this line in the broker log.
          o.log(`${SPAWN_MARKER} pid ${s.pid} model '${first.model}' ctx ${first.ctx} port ${port}`);
          return { pid: s.pid, pgid: s.pid, port, argv: s.argv, model: first.model, ctx: first.ctx };
        },
      });
      spawnedPgid = entry.pgid;
      busyLogged = false;
      await waitReady(target, entry.pid, () => exited, logFile);
      server = { key, model: first.model, ctx: first.ctx, port, pid: entry.pid, pgid: entry.pgid, slots: await totalSlots(port) };
      sched.startRun(key, Date.now());
      o.log(`main llama-server ready: pid ${entry.pid} model '${first.model}' port ${port} slots ${server.slots}`);
    } catch (err) {
      // A version handover: the OLD broker still owns the main slot while it
      // drains. Waiting is not an error (spec 6/11): keep the jobs queued and
      // retry on the next tick.
      if (err instanceof SlotBusyError && err.holder.ownerPid !== process.pid) {
        if (!busyLogged) o.log(`waiting for the main slot: ${err.message}`);
        busyLogged = true;
        return;
      }
      if (spawnedPgid !== null) {
        await stopProcessGroup(spawnedPgid).catch(() => undefined);
        await releaseEntry(o.dir, o.engine, spawnedPgid).catch(() => undefined);
      }
      const msg = (err as Error).message;
      o.log(`model '${key.split("\u0000")[0]}' failed to start: ${msg}`);
      failQueued(key, msg);
      if (sched.current === key) sched.current = null;
    } finally {
      swapping = false;
      setImmediate(pump);
    }
  };

  const dispatch = (job: Job, s: RunningServer): void => {
    job.state = "running";
    job.dispatchedAt = Date.now();
    sched.servedInRun++;
    const ac = new AbortController();
    running.set(job.id, ac);
    notify(job);
    let body: string;
    try {
      // Spec 2: bodies are unchanged except the model field, set to what this server serves (its --alias).
      body = JSON.stringify({ ...(JSON.parse(job.body) as Record<string, unknown>), model: s.model });
    } catch {
      body = job.body;
    }
    const timeout = AbortSignal.timeout(job.timeoutMs);
    postJson(s.port, body, AbortSignal.any([ac.signal, timeout]))
      .then((r) => {
        job.result = r;
        finish(job, "done");
      })
      .catch((err: Error) => {
        if (job.state === "cancelled") return;
        if (timeout.aborted) {
          finish(job, "failed", `llama-server did not answer within ${job.timeoutMs} ms of dispatch (model '${job.model}')`);
          return;
        }
        // The server died under the request: forget it so the next pump restarts it.
        if (server === s && pidState(s.pid) !== "alive") {
          server = null;
          void releaseEntry(o.dir, o.engine, s.pid).catch(() => undefined);
        }
        finish(job, "failed", `llama-server request failed (model '${job.model}'): ${err.message}`);
      })
      .finally(() => {
        running.delete(job.id);
        pump();
      });
  };

  const shutdown = async (why: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    clearInterval(tick);
    o.log(`broker exiting: ${why}`);
    for (const ac of running.values()) ac.abort();
    for (const j of sched.allQueued()) finish(j, "failed", `broker exiting: ${why}`);
    await stopServer(`broker exit: ${why}`).catch((e: Error) => o.log(`stop failed: ${e.message}`));
    removeBrokerStateIfOwn(o.dir, o.engine, process.pid);
    http.close();
    http.closeAllConnections();
  };

  function pump(): void {
    if (exiting || swapping) return;
    const now = Date.now();
    for (const j of sched.dropAbandoned(now, t.abandonMs)) {
      finish(j, "cancelled", "abandoned: not polled");
      o.log(`dropped abandoned job ${j.id} (model '${j.model}', not polled for ${t.abandonMs} ms)`);
    }
    // Forget finished jobs nobody came back for. Kept FINISHED_KEEP_MS after
    // they finished (not abandonMs): a client whose poll reply was lost, or
    // that asks after a cancel, must still read the final state, not a 404
    // that would make it submit the work again.
    for (const [id, j] of jobs) {
      const end = Math.max(j.lastPolledAt, j.finishedAt ?? 0);
      if ((j.state === "done" || j.state === "failed" || j.state === "cancelled") && j.pollers === 0 && now - end > FINISHED_KEEP_MS) jobs.delete(id);
    }
    if (server && server.key !== sched.current) sched.current = server.key;
    const next = sched.wantRotation(now, running.size, t);
    if (next !== null && running.size === 0 && (server === null || next !== server.key)) {
      void swapTo(next);
      return;
    }
    if (next === null && server && sched.current === server.key) {
      while (running.size < server.slots) {
        const job = sched.take(server.key);
        if (!job) break;
        dispatch(job, server);
      }
    }
    const idle = sched.queuedCount() === 0 && running.size === 0;
    if (idle && draining) {
      void shutdown("drained after a version handover");
      return;
    }
    if (idle && server && now - lastRequestAt > t.idleServerMs) {
      void stopServer(`no request for ${t.idleServerMs} ms`).catch((e: Error) => o.log(`stop failed: ${e.message}`));
      sched.current = null;
    } else if (idle && !server && now - lastRequestAt > t.idleExitMs) {
      void shutdown(`no server and no request for ${t.idleExitMs} ms`);
    }
  }

  const reply = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, body === undefined ? headers : { "content-type": "application/json", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const finishedReply = (j: Job): JobReply => ({
    state: j.state as JobReply["state"],
    status: j.result?.status,
    body: j.result?.body,
    contentType: j.result?.contentType,
    error: j.error,
    submittedAt: j.submittedAt,
    dispatchedAt: j.dispatchedAt,
    finishedAt: j.finishedAt,
  });

  const intHeader = (req: IncomingMessage, name: string, fallback: number): number => {
    const v = req.headers[name];
    return typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : fallback;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers[TOKEN_HEADER] !== token) return reply(res, 401, { error: "bad or missing broker token" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = /^\/v1\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (req.method === "GET" && url.pathname === "/v1/health") return reply(res, 200, { pid: process.pid, version: o.version, draining });
    if (req.method === "POST" && url.pathname === "/v1/shutdown") {
      draining = true;
      o.log("draining: a client of another version asked for a handover");
      reply(res, 200, { draining: true });
      pump();
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/jobs") {
      if (draining || exiting) return reply(res, 503, { error: "draining" });
      const body = await readBody(req);
      let model: unknown;
      try {
        model = (JSON.parse(body) as { model?: unknown }).model;
      } catch {
        return reply(res, 400, { error: "body is not JSON" });
      }
      if (typeof model !== "string" || model === "") return reply(res, 400, { error: "body has no model" });
      const ctx = intHeader(req, CTX_HEADER, 0);
      const now = Date.now();
      const job: Job = {
        id: randomUUID(),
        key: queueKey(model, ctx),
        model,
        ctx,
        commandId: String(req.headers[COMMAND_HEADER] ?? "anonymous"),
        body,
        timeoutMs: intHeader(req, TIMEOUT_HEADER, DEFAULT_EXEC_TIMEOUT_MS),
        queueTimeoutMs: intHeader(req, QUEUE_TIMEOUT_HEADER, t.starveMs),
        submittedAt: now,
        lastPolledAt: now,
        pollers: 0,
        state: "queued",
      };
      jobs.set(job.id, job);
      sched.enqueue(job);
      lastRequestAt = now;
      reply(res, 202, { job: job.id });
      pump();
      return;
    }
    if (m && req.method === "GET") {
      const job = jobs.get(m[1]);
      const jobId = m[1];
      if (!job) return reply(res, 404, { error: "no such job" });
      const asked = Number(url.searchParams.get("wait") ?? "0");
      const waitMs = Math.min(Number.isFinite(asked) && asked > 0 ? asked * 1000 : 0, t.pollWaitMs);
      job.pollers++;
      job.lastPolledAt = Date.now();
      try {
        if (job.state === "queued" || job.state === "running") {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, waitMs);
            function done(): void {
              clearTimeout(timer);
              waiters.get(jobId)?.delete(onChange);
              resolve();
            }
            // Wake on the transitions a client cares about: dispatch (its deadline starts) and the end.
            const onChange = (): void => done();
            let set = waiters.get(job.id);
            if (!set) waiters.set(job.id, (set = new Set()));
            set.add(onChange);
            res.once("close", done);
          });
        }
      } finally {
        job.pollers--;
        job.lastPolledAt = Date.now();
      }
      if (job.state === "queued" || job.state === "running") {
        const h: Record<string, string> = { [STATE_HEADER]: job.state };
        if (job.dispatchedAt !== undefined) h[DISPATCHED_HEADER] = String(job.dispatchedAt);
        return reply(res, 204, undefined, h);
      }
      return reply(res, 200, finishedReply(job));
    }
    if (m && req.method === "DELETE") {
      const job = jobs.get(m[1]);
      if (!job) return reply(res, 404, { error: "no such job" });
      if (job.state === "queued") {
        sched.remove(job);
        finish(job, "cancelled", "cancelled by the client");
      } else if (job.state === "running") {
        finish(job, "cancelled", "cancelled by the client");
        running.get(job.id)?.abort();
      }
      return reply(res, 200, { state: job.state });
    }
    reply(res, 404, { error: "not found" });
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (!res.headersSent) reply(res, 500, { error: err.message });
    });
  });
  // Long polls are bounded by pollWaitMs; never let Node's own request timeout cut one.
  http.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // No lock here: the CLIENT spawns under the broker spawn lock and waits for this file, so taking that lock here would deadlock.
  writeBrokerState(o.dir, o.engine, { pid: process.pid, port, token, version: o.version, startedAt: new Date().toISOString() });
  o.log(`broker ${o.engine} listening on 127.0.0.1:${port} (pid ${process.pid}, version ${o.version})`);
  const tick = setInterval(pump, TICK_MS);
  const onSignal = (sig: string): void => void shutdown(`signal ${sig}`);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await new Promise<void>((resolve) => http.once("close", () => resolve()));
}


/**
 * `llm-ext __broker <engine>` (cli/main.ts): run the broker until it exits,
 * then end the process explicitly: the broker is the only thing this process
 * does, and an exit that waited on a stray handle would leave a broker-less
 * zombie holding nothing but memory.
 */
export async function runBrokerMain(engine: string | undefined, version: string): Promise<never> {
  const log = (msg: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  };
  if (engine !== "llama") {
    log(`unknown broker engine '${String(engine)}' (this increment brokers llama only)`);
    process.exit(2);
  }
  try {
    await runBroker({ engine, dir: getConfigDir(), version, timings: timingsFromEnv(process.env), log });
    process.exit(0);
  } catch (err) {
    log(`broker failed: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  }
}
