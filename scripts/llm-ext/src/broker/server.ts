/**
 * broker/server.ts — the local-model request broker process (TRDD-1OOAH3LD,
 * TRDD-ZGSGGHQG; design/specs/local-engine-broker-design.md).
 *
 * A detached llm-ext child (`llm-ext __broker`) that owns the single main
 * server of every local engine: llama-server for GGUF models, Locals for MLX
 * models, never both at once. Every command process submits its finished
 * request bodies here (POST /v1/jobs) and long-polls for the result
 * (GET /v1/jobs/<id>?wait=60), so requests from all running commands are
 * grouped by model, each model batch runs on one server, and the model is
 * swapped (process-group stop + start) by the rotation rules in
 * scheduler.ts. It is a separate process on purpose: a command process must
 * hold no timer or open handle once it finishes (index.ts, launcher-boot.test.ts).
 */

import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ManagedServerError,
  parseManagedModel,
  freePort,
  pidState,
  spawnLlamaServer,
  totalSlots,
  waitReady,
  SPAWN_MARKER,
} from "../local-llama-server.js";
import {
  LOCALS_MAIN_SLOTS,
  localsModelIds,
  localsOutgoingModel,
  memoryFreePercent,
  parseLocalsModel,
  spawnLocalsServer,
  waitLocalsReady,
} from "../local-locals-server.js";
import { claimAndSpawn, releaseEntry, roleLogFile, serverLabel, SlotBusyError, stopOwnServer, sweepEngine, type RegistryEntry } from "./registry.js";
import { queueKey, Scheduler, timingsFromEnv, type BrokerTimings, type Job } from "./scheduler.js";
import { getConfigDir } from "../config.js";
import {
  BROKER_ENGINES,
  COMMAND_HEADER,
  CTX_HEADER,
  DISPATCHED_HEADER,
  ENGINE_HEADER,
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

/**
 * The one main server the broker runs. ONE variable for every engine
 * (TRDD-ZGSGGHQG): the user's rule is one local model loaded at a time, so a
 * llama-server and a Locals server never run together; a swap stops this one
 * before it starts the next, whatever its engine. Two per-engine brokers with
 * a cross-engine lock were rejected: the rotation rule (spec 6, 3b) weighs
 * every model's deadline against the current one, which only a broker that
 * sees both engines' queues can do; a lock alone would let one engine starve
 * the other until its queue emptied.
 */
interface RunningServer {
  key: string;
  engine: BrokerEngine;
  model: string;
  ctx: number;
  port: number;
  pid: number;
  pgid: number;
  slots: number;
  /** The recorded argv: the identity checked before the broker signals it (review M8). */
  argv: string[];
  /** Review M13: the per-spawn key llama-server requires (LLAMA_API_KEY); Locals has no key. */
  apiKey: string;
  /** Locals: the ids its /v1/models lists (the outgoing model field picks one); [] for llama-server. */
  modelIds: string[];
  /** Locals: the fresh empty working directory it was started in, removed after it stops. */
  cwd?: string;
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
function postJson(port: number, apiKey: string, body: string, signal: AbortSignal): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${apiKey}` },
        signal,
      },
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
  /** Spec 10 "no server and no request": the idle exit also counts from the end of the last server stop. */
  let lastServerStopAt = 0;
  let stopping: Promise<void> | null = null;
  let busyLogged = false;
  let busyTries = 0;
  /** The spawn of a server that is not `server` yet (claimAndSpawn to ready), with its engine: shutdown stops it too (review M5). */
  let loading: { engine: BrokerEngine; promise: Promise<RegistryEntry> } | null = null;
  /**
   * Locals memory floor (TRDD-ZGSGGHQG L3.4): the last `memory_pressure` free
   * percentage, null = no fresh reading yet. One reading allows ONE further
   * dispatch (pump clears it), so memory is checked before every new request.
   */
  let memFree: number | null = null;
  let memAt = 0;
  let memReading: Promise<void> | null = null;
  let memWaitLoggedAt = 0;
  const refreshMemory = (): void => {
    if (memReading) return;
    memReading = memoryFreePercent()
      .then((v) => {
        memFree = v;
        memAt = Date.now();
        if (v === null && Date.now() - memWaitLoggedAt >= 30_000) {
          memWaitLoggedAt = Date.now();
          o.log("memory_pressure gave no reading: Locals runs one request at a time until it does");
        }
      })
      .finally(() => {
        memReading = null;
        // Re-pump at once only on a reading; an unreadable memory_pressure is retried by the 1 s tick, never in a loop.
        if (memFree !== null) pump();
      });
  };
  /** A fresh reading at or above the floor. Below it, the job waits (never an error); logged at most every 30 s. */
  const memoryAllows = (s: RunningServer): boolean => {
    // A reading older than 2 s is no reading: a leftover from a drained queue must not admit a new batch.
    if (memFree === null || Date.now() - memAt > 2000) {
      refreshMemory();
      return false;
    }
    if (memFree >= t.memoryFloorPct) return true;
    const now = Date.now();
    if (now - memWaitLoggedAt >= 30_000) {
      memWaitLoggedAt = now;
      o.log(`waiting for memory: ${memFree}% free < floor ${t.memoryFloorPct}% (${running.size} in flight on ${s.model}, ${sched.allQueued(s.key).length} queued)`);
    }
    memFree = null;
    return false;
  };
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
    job.body = ""; // review m5: a finished job never needs its request body again
    notify(job);
  };

  const stopServer = async (why: string): Promise<void> => {
    const s = server;
    if (!s) return;
    server = null;
    // Review C2: current never outlives the server it names.
    sched.current = null;
    // Review M8: identity-checked stop (dead pid = release only). Review M4:
    // the stop is tracked, so pump and shutdown wait for it; an idle exit 1 s
    // after an idle stop used to exit mid-stop and leave the server running.
    const p = stopOwnServer(o.dir, s.engine, s, o.log).then((how) => {
      o.log(`stopped main ${serverLabel(s.engine)} pid ${s.pid} model '${s.model}' (${why}): ${how}`);
      // The Locals server's fresh cwd (empty: Locals writes nothing there); rmdir, never a recursive delete.
      if (s.cwd !== undefined) {
        try {
          rmdirSync(s.cwd);
        } catch (e) {
          o.log(`left the Locals working directory ${s.cwd}: ${(e as Error).message}`);
        }
      }
    });
    stopping = p;
    try {
      await p;
    } finally {
      if (stopping === p) stopping = null;
      lastServerStopAt = Date.now();
    }
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
    let spawned: RegistryEntry | null = null;
    let spawnedEngine: BrokerEngine = "llama";
    // Hoisted so a failed start can remove the Locals cwd too.
    let cwd: string | undefined;
    let repump = true;
    try {
      if (server) await stopServer(`swap to '${key.split("\u0000")[0]}'`);
      const first = sched.allQueued(key)[0];
      if (!first) return;
      const engine = first.engine;
      spawnedEngine = engine;
      // One local model at a time ACROSS engines (TRDD-ZGSGGHQG): this broker's
      // single `server` guarantees it for its own servers. The other engine's
      // registry is swept first (claimAndSpawn sweeps only its own engine): a
      // main orphaned by a SIGKILLed broker is stopped here, or it would run
      // beside the new one. A main still owned by a live broker (an old one
      // draining during a version handover) is waited for, exactly as a busy
      // main slot of the same engine.
      for (const other of BROKER_ENGINES) {
        if (other === engine) continue;
        const held = (await sweepEngine(o.dir, other, "main", o.log)).find((e) => e.role === "main" && e.ownerPid !== process.pid);
        if (held) throw new SlotBusyError(`another broker (pid ${held.ownerPid}) still runs its main ${serverLabel(other)} (pid ${held.pid})`, held);
      }
      let llamaArgv: string[] = [];
      if (engine === "llama") {
        const parsed = parseManagedModel(first.model);
        if ("error" in parsed) throw new ManagedServerError(parsed.error);
        llamaArgv = parsed.argv;
      } else {
        const parsed = parseLocalsModel(first.model);
        if ("error" in parsed) throw new ManagedServerError(parsed.error);
      }
      const port = await freePort();
      const target = { port, model: first.model, ctx: first.ctx };
      const logFile = roleLogFile(o.dir, "main", engine);
      let exited = false;
      const loadStartedAt = Date.now();
      // Review M13 (hardening): a fresh key per spawn, so no other local process
      // can use the server behind the broker's back. Locals has no API key
      // (measured): its access control is loopback Host/Origin checks only.
      const apiKey = randomBytes(24).toString("hex");
      const loadingNow = claimAndSpawn({
        dir: o.dir,
        engine,
        role: "main",
        ownerPid: process.pid,
        log: o.log,
        spawn: async () => {
          let s: { pid: number; argv: string[]; child: ChildProcess };
          if (engine === "llama") s = await spawnLlamaServer(target, llamaArgv, logFile, apiKey);
          else {
            const l = await spawnLocalsServer(target, logFile, logFile);
            cwd = l.cwd;
            s = l;
          }
          s.child.once("exit", () => {
            exited = true;
          });
          // Tests count spawns by this line in the broker log.
          o.log(`${SPAWN_MARKER} pid ${s.pid} engine ${engine} model '${first.model}' ctx ${first.ctx} port ${port}`);
          return { pid: s.pid, pgid: s.pid, port, argv: s.argv, model: first.model, ctx: first.ctx };
        },
      });
      loading = { engine, promise: loadingNow };
      const entry = await loadingNow;
      spawned = entry;
      if (exiting) throw new ManagedServerError("broker exiting");
      // How often the slot was retried while busy: the 1 s tick paces it (review M3; tests bound it by the wait time).
      if (busyLogged) o.log(`main slot free after ${busyTries} busy attempts`);
      busyLogged = false;
      busyTries = 0;
      if (engine === "llama") {
        await waitReady(target, entry.pid, () => exited, logFile, apiKey);
        server = { key, engine, model: first.model, ctx: first.ctx, port, pid: entry.pid, pgid: entry.pgid, argv: entry.argv, apiKey, slots: await totalSlots(port, apiKey), modelIds: [] };
      } else {
        await waitLocalsReady(target, entry.pid, () => exited, logFile);
        // Locals exposes no slot count: C is the --slots value the broker passed.
        server = { key, engine, model: first.model, ctx: first.ctx, port, pid: entry.pid, pgid: entry.pgid, argv: entry.argv, apiKey, slots: LOCALS_MAIN_SLOTS, modelIds: await localsModelIds(port), cwd };
      }
      // Measured load time: rotation (b) counts a waiting model's deadline as near once it falls within its load time.
      sched.recordLoad(key, Date.now() - loadStartedAt);
      sched.startRun(key, Date.now());
      const sizing = engine === "llama" ? `; ${slotSizing(entry.argv, logFile)}` : `; ids ${server.modelIds.join(", ")}`;
      o.log(`main ${serverLabel(engine)} ready: pid ${entry.pid} model '${first.model}' port ${port} slots ${server.slots}${sizing}`);
    } catch (err) {
      // A version handover: the OLD broker still owns the main slot while it
      // drains. Waiting is not an error (spec 6/11): keep the jobs queued and
      // retry on the next tick.
      if (err instanceof SlotBusyError && err.holder.ownerPid !== process.pid) {
        if (!busyLogged) o.log(`waiting for the main slot: ${err.message}`);
        busyLogged = true;
        busyTries++;
        repump = false;
        return;
      }
      if (spawned !== null) {
        await stopOwnServer(o.dir, spawnedEngine, spawned, o.log).catch((e: Error) => o.log(`stop failed: ${e.message}`));
      }
      // A Locals server that failed before ready leaves its empty cwd: rmdir, never a recursive delete.
      if (cwd !== undefined) {
        try {
          rmdirSync(cwd);
        } catch (e) {
          o.log(`left the Locals working directory ${cwd}: ${(e as Error).message}`);
        }
      }
      const msg = (err as Error).message;
      o.log(`model '${key.split("\u0000")[0]}' failed to start: ${msg}`);
      failQueued(key, msg);
      if (sched.current === key) sched.current = null;
    } finally {
      swapping = false;
      // Review M3: never re-pump straight after a busy slot. That retried at
      // once, and every retry ran a full `ps` sweep: a busy loop for the whole
      // handover drain. The 1 s tick retries instead.
      if (repump) setImmediate(pump);
      loading = null;
    }
  };

  const dispatch = (job: Job, s: RunningServer): void => {
    job.state = "running";
    job.dispatchedAt = Date.now();
    // One line per job: the broker log is where a user (and the end-to-end tests) see which command's work ran, and how long it queued.
    o.log(`dispatch job ${job.id} model '${job.model}' command ${job.commandId} queued ${job.dispatchedAt - job.submittedAt} ms`);
    sched.servedInRun++;
    sched.touch(job.dispatchedAt);
    const ac = new AbortController();
    running.set(job.id, ac);
    notify(job);
    let body: string;
    try {
      // Spec 2: bodies are unchanged except the model field, set to what this
      // server serves: llama-server's --alias; for Locals the id it lists, its
      // -thinking variant when the request asks for thinking (TRDD-ZGSGGHQG).
      const parsed = JSON.parse(job.body) as Record<string, unknown>;
      const model = s.engine === "locals" ? (localsOutgoingModel(s.modelIds, parsed) ?? s.model) : s.model;
      body = JSON.stringify({ ...parsed, model });
    } catch {
      body = job.body;
    }
    // Review m5: the request body is no longer needed once the outgoing copy exists.
    job.body = "";
    const timeout = AbortSignal.timeout(job.timeoutMs);
    postJson(s.port, s.apiKey, body, AbortSignal.any([ac.signal, timeout]))
      .then((r) => {
        job.result = r;
        finish(job, "done");
      })
      .catch((err: Error) => {
        if (job.state === "cancelled") return;
        if (timeout.aborted) {
          finish(job, "failed", `${serverLabel(s.engine)} did not answer within ${job.timeoutMs} ms of dispatch (model '${job.model}')`);
          return;
        }
        // The server died under the request: forget it AND clear current
        // (review C2: with current still naming the dead model, its queued
        // jobs were skipped by every rotation rule and hung for ever), so the
        // next pump starts it again for the remaining work.
        if (server === s && pidState(s.pid) !== "alive") {
          server = null;
          sched.current = null;
          void releaseEntry(o.dir, s.engine, s.pid).catch(() => undefined);
        }
        finish(job, "failed", `${serverLabel(s.engine)} request failed (model '${job.model}'): ${err.message}`);
      })
      .finally(() => {
        running.delete(job.id);
        // The linger before an empty-queue rotation counts from the last reply (review M2).
        if (job.key === sched.current) sched.touch(Date.now());
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
    if (stopping) await stopping.catch(() => undefined);
    await stopServer(`broker exit: ${why}`).catch((e: Error) => o.log(`stop failed: ${e.message}`));
    // Review M5: a server spawned but not yet ready (swapTo inside waitReady)
    // is not `server` yet; without this it outlived the broker as an orphan.
    const l = loading;
    if (l) {
      const e = await l.promise.catch(() => null);
      if (e) await stopOwnServer(o.dir, l.engine, e, o.log).catch((err: Error) => o.log(`stop failed: ${err.message}`));
    }
    removeBrokerStateIfOwn(o.dir, process.pid);
    http.close();
    http.closeAllConnections();
  };

  function pump(): void {
    // A server stop in progress (review M4): nothing may start a new server or
    // decide to exit until it has finished and released its registry entry.
    if (exiting || swapping || stopping) return;
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
    // Review C2: a server that died while idle (no request in flight saw it)
    // is forgotten HERE, before a job goes to its dead port; current is
    // cleared with it, so its queued work makes wantRotation start it again.
    if (server && pidState(server.pid) === "dead") {
      const dead = server;
      server = null;
      sched.current = null;
      o.log(`main ${serverLabel(dead.engine)} pid ${dead.pid} (model '${dead.model}') exited on its own; it is restarted when work arrives`);
      void releaseEntry(o.dir, dead.engine, dead.pid).catch((e: Error) => o.log(`release failed: ${e.message}`));
    }
    if (server && server.key !== sched.current) sched.current = server.key;
    const next = sched.wantRotation(now, running.size, t);
    if (next !== null && running.size === 0 && (server === null || next !== server.key)) {
      void swapTo(next);
      return;
    }
    if (next === null && server && sched.current === server.key) {
      while (running.size < server.slots) {
        // TRDD-ZGSGGHQG L3.4: on Locals, a job beyond the first in flight needs a
        // fresh memory reading at or above the floor; one is always allowed, as
        // Locals' own prompt cache counts as used memory until it admits a request.
        if (server.engine === "locals" && running.size > 0 && !memoryAllows(server)) break;
        const job = sched.take(server.key);
        if (!job) break;
        dispatch(job, server);
        // Each further dispatch waits for a NEW reading: memory is checked before every new request.
        if (server.engine === "locals") {
          memFree = null;
          refreshMemory();
        }
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
    } else if (idle && !server && now - Math.max(lastRequestAt, lastServerStopAt) > t.idleExitMs) {
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
    // queued/running: what this broker still holds (tests and --command_timeout checks read "no job left queued" here).
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return reply(res, 200, { pid: process.pid, version: o.version, draining, queued: sched.allQueued().length, running: running.size });
    }
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
      // TRDD-ZGSGGHQG: the engine is required, never guessed (a GGUF and an MLX id can look alike).
      const engine = req.headers[ENGINE_HEADER];
      if (engine !== "llama" && engine !== "locals") return reply(res, 400, { error: `bad or missing ${ENGINE_HEADER}: '${String(engine)}'` });
      const now = Date.now();
      const job: Job = {
        id: randomUUID(),
        key: queueKey(model, ctx, engine),
        engine,
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
      if (job.key === sched.current) sched.touch(now);
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
      // Review m5: once the result reached its caller, forget the job and its bodies
      // (up to 64 MB each) at once instead of FINISHED_KEEP_MS later. Only after
      // the reply was fully flushed: a reply lost in transit leaves the job
      // readable for a re-poll. A later poll of a delivered job gets 404.
      res.once("finish", () => jobs.delete(job.id));
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
  writeBrokerState(o.dir, { pid: process.pid, port, token, version: o.version, startedAt: new Date().toISOString() });
  o.log(`broker listening on 127.0.0.1:${port} (pid ${process.pid}, version ${o.version}, engines ${BROKER_ENGINES.join(", ")})`);
  const tick = setInterval(pump, TICK_MS);
  const onSignal = (sig: string): void => void shutdown(`signal ${sig}`);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  // Review M5: a crash of the broker itself must not orphan the llama-server it
  // started (the server runs in its own process group and outlives us).
  let crashed: unknown = null;
  const onCrash = (err: unknown): void => {
    crashed = err;
    void shutdown("crash");
  };
  process.once("uncaughtException", onCrash);
  process.once("unhandledRejection", onCrash);
  await new Promise<void>((resolve) => http.once("close", () => resolve()));
  // runBrokerMain logs it and exits 1, after shutdown stopped the server.
  if (crashed !== null) throw crashed;
}


/**
 * `llm-ext __broker` (cli/main.ts): run the broker until it exits, then end
 * the process explicitly: the broker is the only thing this process does, and
 * an exit that waited on a stray handle would leave a broker-less zombie
 * holding nothing but memory. One broker serves every local engine.
 */
export async function runBrokerMain(version: string): Promise<never> {
  const log = (msg: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  };
  try {
    await runBroker({ dir: getConfigDir(), version, timings: timingsFromEnv(process.env), log });
    process.exit(0);
  } catch (err) {
    log(`broker failed: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  }
}

/**
 * Follow-up review M4: what the slot sizing actually gave, for the ready log
 * line. The computed -np and -c come from the spawned argv; llama.cpp's own
 * verdict (n_slots, n_ctx_slot, kv_unified) and its KV buffer size come from
 * the server's log. The KV figure is llama.cpp's reported one, never a
 * formula of ours (a per-layer formula is wrong for GQA/MLA/SWA models, and a
 * -hf model has no local file to read); at the default log verbosity
 * llama-server does not report it, and the line says so. Slot-count
 * calibration from these figures belongs to P6.
 */
function slotSizing(argv: readonly string[], logFile: string): string {
  const flag = (name: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : "unset";
  };
  let log = "";
  try {
    log = readFileSync(logFile, "utf8");
  } catch {
    // An unreadable log only loses the llama.cpp figures; the argv ones still print.
  }
  const slots = /n_slots = \d+, n_ctx_slot = \d+(?:, kv_unified = '\w+')?/.exec(log)?.[0] ?? "llama.cpp slot line not in the log";
  const kv = /KV (?:buffer|cache)[^\n]*?size\s*=\s*[\d.]+ MiB/i.exec(log)?.[0] ?? "KV size not reported by llama-server at this log verbosity";
  return `-np ${flag("-np")} -c ${flag("-c")}; ${slots}; ${kv}`;
}
