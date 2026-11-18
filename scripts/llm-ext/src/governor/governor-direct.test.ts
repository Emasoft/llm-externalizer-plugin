/**
 * Governor unit 3 (design/specs/local-inference-governor-design.md D9): every
 * send that reaches a loopback model server without the broker holds a lease.
 *
 * Real throughout: a real node:http server counts the requests it is serving at
 * once, and the senders are real child processes running the real direct path
 * (chatCompletionSimple, resolveConnection, sendChat, fetchWithRetry429),
 * bundled from the current source with esbuild because dist/ may be stale and a
 * test must never rebuild it. The --command_timeout test runs the whole CLI,
 * bundled the same way. Assertions are invariants read from recorded data
 * (a maximum, a count), not timings, so the file holds on a loaded machine
 * (TRDD-CBOTP0DY). Every child is killed by pid in afterEach; no pattern kill.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { builtinModules } from "node:module";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalUrl, isLoopbackUrl } from "../config.js";
import { chatCompletionJSON, chatCompletionSimple } from "../provider/completion.js";
import type { BackendConfig, CompletionDeps } from "../provider/types.js";
import { acquire, release, snapshot, withdraw, type Lease } from "./client.js";
import { leasedResponse, takeDirectLease } from "./direct.js";
import { governorDir, ownerPids, readStarts, readState, reap } from "./state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEADLINE_MS = 180_000;
const GOV_KEYS = ["LLM_EXT_GOVERNOR_DIR", "LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", "LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", "LLM_EXT_GOVERNOR_MAX_INFERENCES", "LLM_EXT_GOVERNOR_SETTLE_MS"];

function depsFor(url: string, timeoutMs = 30_000): CompletionDeps {
  const backend: BackendConfig = { type: "local", billable: false, isLocal: true, baseUrl: url, apiKey: "k", model: "m", __version: 1 };
  return {
    getBackend: () => backend,
    apiHeaders: () => ({ "Content-Type": "application/json" }),
    routeForModel: () => null,
    routeHeaders: () => ({ "Content-Type": "application/json" }),
    getSoftTimeoutMs: () => timeoutMs,
    isFreeOnly: () => false,
    isLMStudioProvider: () => false,
    getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }),
    getEnsemblePriceCeilingUsd: () => 1,
    defaultTemperature: 0,
    getDefaultMaxTokens: () => 16,
    getRequestOptions: () => null,
  };
}

// The child: the same deps, one real chatCompletionSimple through the direct path. Exit 0 only on the expected answer.
const ENTRY = `
import { chatCompletionSimple } from "../provider/completion.ts";
const url = process.argv[2];
const backend = { type: "local", billable: false, isLocal: true, baseUrl: url, apiKey: "k", model: "m", __version: 1 };
const h = () => ({ "Content-Type": "application/json" });
const deps = {
  getBackend: () => backend, apiHeaders: h, routeForModel: () => null, routeHeaders: h, getSoftTimeoutMs: () => 120000,
  isFreeOnly: () => false, isLMStudioProvider: () => false, getActiveProtocol: () => "openai_api", isManualModel: () => false,
  getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }), getEnsemblePriceCeilingUsd: () => 1,
  defaultTemperature: 0, getDefaultMaxTokens: () => 16, getRequestOptions: () => null,
};
try {
  const r = await chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, deps);
  if (r.content !== "ok") { process.stderr.write("unexpected answer " + r.content); process.exitCode = 2; }
} catch (err) {
  process.stderr.write(String(err && err.message));
  process.exitCode = 1;
}
`;

const COMPLETION = JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

interface Counting {
  url: string;
  peak: () => number;
  posts: () => number;
  server: Server;
}

/** A chat server that answers every POST after `holdMs` and records how many it was serving at once. GETs (probes) get 404. */
async function countingServer(holdMs: number, answer: (res: ServerResponse) => void = (res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(COMPLETION);
}): Promise<Counting> {
  let now = 0;
  let peak = 0;
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    posts++;
    now++;
    peak = Math.max(peak, now);
    req.resume();
    req.on("end", () =>
      setTimeout(() => {
        now--;
        answer(res);
      }, holdMs),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, peak: () => peak, posts: () => posts, server };
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

async function until(what: string, done: () => boolean): Promise<void> {
  const end = Date.now() + DEADLINE_MS;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const saved = new Map<string, string | undefined>();
const children: ChildProcess[] = [];
const servers: Server[] = [];
const held: Lease[] = [];
let workDir: string;
let root: string;
let dir: string;

beforeAll(() => {
  for (const key of GOV_KEYS) saved.set(key, process.env[key]);
  // Under node_modules, not /tmp: the CLI bundle keeps better-sqlite3 external (a native addon), and Node resolves it
  // by walking up from the bundle to this package's node_modules. node_modules/.cache is regenerable scratch space.
  const cache = join(HERE, "..", "..", "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  workDir = mkdtempSync(join(cache, "govdirect-bundle-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  root = mkdtempSync("/tmp/govdirect-");
  dir = join(root, "gov");
  // The CPU ceiling is off so the result does not depend on what else the machine runs; RAM stays at its highest.
  Object.assign(process.env, {
    LLM_EXT_GOVERNOR_DIR: dir,
    LLM_EXT_GOVERNOR_CPU_LIMIT_PCT: "100",
    LLM_EXT_GOVERNOR_RAM_LIMIT_PCT: "99",
    LLM_EXT_GOVERNOR_MAX_INFERENCES: "4",
    LLM_EXT_GOVERNOR_SETTLE_MS: "100",
  });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(child.pid, "SIGKILL");
  }
  for (const lease of held.splice(0)) release(lease);
  withdraw();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  rmSync(root, { recursive: true, force: true });
});

/** A lease the test holds, so a sender behind it must wait. */
async function gate(): Promise<Lease> {
  const lease = await acquire({ timeoutMs: DEADLINE_MS });
  held.push(lease);
  return lease;
}

function free(lease: Lease): void {
  held.splice(held.indexOf(lease), 1);
  release(lease);
}

describe("isLoopbackUrl", () => {
  // Hosts the false rows use: a machine whose own address is one of them would turn a row true, so that is checked first.
  const FOREIGN = ["192.168.1.5", "10.0.0.2", "mymac.local"];
  const own = [hostname().toLowerCase(), ...Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address.toLowerCase()))];

  it("the hosts of the false rows are not this machine's own", () => {
    for (const host of FOREIGN) expect(own).not.toContain(host);
  });

  it.each([
    ["http://localhost:1234", true],
    ["http://LOCALHOST.:1234", true],
    ["http://llm.localhost:1234", true],
    ["http://127.0.0.1:8080/v1", true],
    ["http://127.4.5.6", true],
    ["http://127.1:8080", true],
    // The decimal spelling of 127.0.0.1, as src/remote-ensemble-fanout.test.ts uses it.
    ["http://2130706433:8080", true],
    ["http://0:8080", true],
    ["http://[::1]:11434", true],
    ["http://[0:0:0:0:0:0:0:1]:11434", true],
    ["http://[::ffff:127.0.0.1]:11434", true],
    ["http://[::ffff:127.9.9.9]:11434", true],
    ["http://[::]:11434", true],
    ["http://[::ffff:0.0.0.0]:11434", true],
    ["http://0.0.0.0:8000", true],
    ["http://192.168.1.5:1234", false],
    ["http://10.0.0.2:8080", false],
    ["http://mymac.local:1234", false],
    ["http://[::ffff:192.168.1.5]:1234", false],
    ["http://127.0.0.1.evil.com", false],
    ["http://localhost.evil.com", false],
    ["http://localhost-evil.com", false],
    ["http://evil.com//localhost/v1", false],
    ["http://evil.com/?u=http://127.0.0.1", false],
    ["https://openrouter.ai/api/v1", false],
    ["not a url", false],
  ])("%s is loopback: %s", (url, loopback) => {
    expect(isLoopbackUrl(url)).toBe(loopback);
  });

  it("this machine's own host name and every interface address count: a send there spends this machine's RAM", () => {
    expect(isLoopbackUrl(`http://${hostname()}:1234`)).toBe(true);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        const host = a.family === "IPv6" ? `[${a.address.split("%")[0]}]` : a.address;
        expect(isLoopbackUrl(`http://${host}:1234/v1/chat/completions`), host).toBe(true);
      }
    }
  });

  it("a LAN url is local but not loopback: the gap the governor needs (D9, fact 4)", () => {
    expect(isLocalUrl("http://192.168.1.5:1234")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:1234")).toBe(false);
  });
});

describe("the direct path", () => {
  it("a LAN url and a remote url never touch the governor dir", async () => {
    for (const url of ["http://192.168.1.5:1234/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions", "http://mymac.local:1234"]) {
      expect(await takeDirectLease(url, 1000)).toBeNull();
    }
    expect(existsSync(dir)).toBe(false);
  });

  it("a request that waited does not use up conn.timeout, in chatCompletionSimple and chatCompletionJSON", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    // Each answer takes 1.5 s against a 2 s timeout; the governor wait before it lasts 2.5 s. Counted from before the
    // wait, the attempt would get 1 s (fetchWithRetry429 floors a spent budget at 1 s) and time out.
    const srv = await countingServer(1500);
    servers.push(srv.server);
    const deps = depsFor(srv.url, 2000);
    for (const send of [
      () => chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, deps).then((r) => r.content),
      () => chatCompletionJSON([{ role: "user", content: "hi" }], { model: "m", retryClock: { deadlineAt: Date.now() + 2000 } }, deps).then(() => "ok"),
    ]) {
      const lease = await gate();
      const answer = send();
      setTimeout(() => free(lease), 2500);
      // JSON: the reply "ok" is not JSON, so the call fails in the parse, after a successful send; only a timeout matters here.
      const result = await answer.catch((err: Error) => (/malformed JSON/.test(err.message) ? "ok" : err.message));
      expect(result).toBe("ok");
    }
    expect(srv.posts()).toBe(2);
    expect(srv.peak()).toBe(1);
  }, DEADLINE_MS);

  it("a failed send releases its lease", async () => {
    const srv = await countingServer(0, (res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    });
    servers.push(srv.server);
    await expect(chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, depsFor(srv.url))).rejects.toThrow(/400/);
    expect(srv.posts()).toBe(1);
    await until("the release to be recorded", () => snapshot().leases.length === 0);
    // The released slot is usable at once: with max_inferences 1 a leaked lease would hold this forever.
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const destroyed = await countingServer(0, (res) => res.socket?.destroy());
    servers.push(destroyed.server);
    await expect(chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, depsFor(destroyed.url, 3000))).rejects.toThrow();
    await until("the release after a dropped connection", () => snapshot().leases.length === 0);
  }, DEADLINE_MS);

  it("an aborted wait ends at once, sends nothing, and leaves no waiter", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    await gate();
    const controller = new AbortController();
    const waiting = takeDirectLease("http://127.0.0.1:9/v1/chat/completions", 1000, { signal: controller.signal });
    await until("the waiter to queue", () => snapshot().waiters.length === 1);
    const t0 = Date.now();
    controller.abort(new Error("gave up"));
    await expect(waiting).rejects.toThrow("gave up");
    expect(Date.now() - t0).toBeLessThan(150);
    await until("the waiter to be withdrawn", () => snapshot().waiters.length === 0);
    expect(snapshot().leases).toHaveLength(1);
  }, DEADLINE_MS);

  it("a --command_timeout stop ends a wait at once, before the next poll, as a final stop error", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    await gate();
    // A fresh module graph: the stop is one-way module state, and it must not leak into the other tests of this file.
    vi.resetModules();
    const stop = await import("../command-stop.js");
    const direct = await import("./direct.js");
    const freshClient = await import("./client.js");
    let settled: unknown = null;
    const waiting = direct.takeDirectLease("http://127.0.0.1:9/v1/chat/completions", 1000).then(
      () => "lease",
      (err: unknown) => err,
    );
    void waiting.then((v) => (settled = v));
    await until("the waiter to queue", () => snapshot().waiters.length === 1);
    stop.stopCommand("--command_timeout: test stop");
    // One macrotask, far less than the 200 ms poll: only the abort signal can have ended the wait by now.
    await new Promise((r) => setImmediate(r));
    expect(settled).toBeInstanceOf(stop.CommandStoppedError);
    freshClient.withdraw();
    await until("the waiter to be withdrawn", () => snapshot().waiters.length === 0);
  }, DEADLINE_MS);
  // WHY: the user's ruling (TRDD-SWNIIFTF, 2026-10-28): "not having enough memory is not a failure, it only put the requests in a
  // queue, waiting fot the memory to be freed enough to run another request pending." The real governor wait (a held lease, the
  // same mechanism as the --command_timeout test below) must therefore not trigger --stop_on_errors, and the request must complete.
  it("with --stop_on_errors set, a request waiting in the real governor queue is not a failure: it completes with its answer and stops nothing", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const srv = await countingServer(0);
    servers.push(srv.server);
    const lease = await gate();
    // A fresh module graph: the stop state and the flag are module state, and must not leak into the other tests of this file.
    vi.resetModules();
    const stop = await import("../command-stop.js");
    const onStop = vi.fn();
    stop.enableStopOnErrors(onStop);
    const completion = await import("../provider/completion.js");
    const answer = completion.chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, depsFor(srv.url)).then((r) => r.content);
    await until("the request to queue behind the held lease", () => snapshot().waiters.length === 1);
    expect(stop.isStopOnErrors()).toBe(true);
    // The wait has begun: nothing was sent, and the memory-style wait has not stopped the command.
    expect(srv.posts()).toBe(0);
    expect(stop.commandStopReason()).toBeNull();
    // Let several 200 ms governor polls pass while the request waits: the flag must stay quiet for the whole wait, not just its start.
    // Covers several governor polls (FAST_POLL_MS 200 ms, src/governor/controller.ts:70; a rank-0 waiter polls every 200 to 250 ms). If the poll period grows past this wait, the "whole wait" check weakens without failing.
    await new Promise((r) => setTimeout(r, 700));
    expect(stop.commandStopReason()).toBeNull();
    free(lease);
    expect(await answer).toBe("ok");
    expect(srv.posts()).toBe(1);
    expect(stop.commandStopReason()).toBeNull();
    expect(stop.isCommandStopped()).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
    await until("the lease to be released", () => snapshot().leases.length === 0);
  }, DEADLINE_MS);
  it("a governor that cannot answer fails the send naming its dir, and nothing is sent", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(dir, "not a directory");
    const srv = await countingServer(0);
    servers.push(srv.server);
    const err = await chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, depsFor(srv.url)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(dir);
    expect(err?.message).toContain("request not sent");
    expect(srv.posts()).toBe(0);
  }, DEADLINE_MS);

  it("a 429 backoff holds no lease: the lease is per attempt, returned before the sleep", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    let answered = 0;
    const srv = await countingServer(0, (res) => {
      answered++;
      if (answered === 1) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "8" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(COMPLETION);
    });
    servers.push(srv.server);
    const answer = chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, depsFor(srv.url));
    await until("the first attempt", () => srv.posts() === 1);
    // max_inferences is 1: this lease is granted only while the sender holds none, so within its 8 s backoff. A lease
    // held across the retries would grant it only after the second POST.
    const lease = await gate();
    expect(srv.posts()).toBe(1);
    free(lease);
    expect((await answer).content).toBe("ok");
    expect(srv.posts()).toBe(2);
    await until("the release", () => snapshot().leases.length === 0);
  }, DEADLINE_MS);

  it("the response comes back at the headers, and its lease lasts until the caller's body read ends, errs or is cancelled", async () => {
    let bodySent = false;
    let mode: "end" | "drop" = "end";
    const srv = await countingServer(0, (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      // A server still generating after its headers: the lease must cover this stall.
      setTimeout(() => {
        bodySent = true;
        if (mode === "drop") res.socket?.destroy();
        else res.end(COMPLETION);
      }, 1500);
    });
    servers.push(srv.server);
    const url = `${srv.url}/v1/chat/completions`;
    const post = (): Promise<Response> => leasedResponse(url, 30_000, () => fetch(url, { method: "POST", body: "{}" }));
    // Well inside the 90 s backstop (30 s plus the 60 s expiry margin): a release seen only there is not the body-end one.
    const releasedSoon = async (what: string, done: () => boolean): Promise<void> => {
      const end = Date.now() + 20_000;
      while (!done()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    const res = await post();
    expect(bodySent).toBe(false);
    expect(snapshot().leases).toHaveLength(1);
    expect((JSON.parse(await res.text()) as { choices: [{ message: { content: string } }] }).choices[0].message.content).toBe("ok");
    await releasedSoon("the release at the end of the body", () => snapshot().leases.length === 0);

    const cancelled = await post();
    expect(snapshot().leases).toHaveLength(1);
    await cancelled.body?.cancel();
    await releasedSoon("the release at a cancel", () => snapshot().leases.length === 0);

    mode = "drop";
    const dropped = await post();
    expect(snapshot().leases).toHaveLength(1);
    await expect(dropped.text()).rejects.toThrow();
    await releasedSoon("the release at a read error", () => snapshot().leases.length === 0);
  }, DEADLINE_MS);

  it("a managed profile goes through the broker and takes no direct lease, so its own loopback port is never leased twice", async () => {
    const seen: string[] = [];
    const broker = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    });
    servers.push(broker);
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
    const addr = broker.address();
    if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
    const url = `http://127.0.0.1:${addr.port}`;
    const deps: CompletionDeps = {
      ...depsFor(url),
      localBroker: () => Promise.resolve({ url, token: "t", pid: process.pid, engine: "llama", ctx: 0, reconnect: () => Promise.reject(new Error("no broker")) }),
    };
    await expect(chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, deps)).rejects.toThrow();
    expect(seen.some((s) => s.startsWith("POST /v1/jobs"))).toBe(true);
    expect(seen.some((s) => s.includes("/chat/completions"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  }, DEADLINE_MS);
});

describe("real processes", () => {
  let entry: string;
  let cli: string;

  beforeAll(async () => {
    entry = join(workDir, "direct-entry.mjs");
    await build({ stdin: { contents: ENTRY, resolveDir: HERE, sourcefile: "entry.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", outfile: entry, logLevel: "error", external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"], banner: { js: BANNER } });
    cli = join(workDir, "cli.mjs");
    await build({ entryPoints: [join(HERE, "..", "cli", "main.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: cli, logLevel: "error", external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"], banner: { js: BANNER } });
  }, DEADLINE_MS);

  it("🐌 100 processes through the direct path: the server never serves more than max_inferences at once, and all finish", async () => {
    const count = 100;
    const maxInferences = 4;
    const srv = await countingServer(100);
    servers.push(srv.server);
    const codes = await Promise.all(
      Array.from({ length: count }, (_, i) => {
        const cfg = join(root, `cfg-${i}`);
        mkdirSync(cfg, { recursive: true });
        const child = spawn(process.execPath, [entry, srv.url], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LLM_EXT_CONFIG_DIR: cfg } });
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
        return exited(child).then((code) => ({ code, stderr }));
      }),
    );
    const failed = codes.filter((c) => c.code !== 0);
    expect(failed, failed.map((f) => f.stderr).join("\n")).toEqual([]);
    expect(srv.posts()).toBe(count);
    process.stdout.write(`governor-direct: ${count} processes, peak ${srv.peak()} concurrent at the server, max_inferences ${maxInferences}\n`);
    expect(srv.peak()).toBeLessThanOrEqual(maxInferences);
    expect(srv.peak()).toBeGreaterThanOrEqual(1);
    // WHY: a child may exit with its release still deferred behind a busy lock (client.ts commit/flush, unref'd retry timer).
    // Such a lease belongs to a dead holder. The next critical section reaps dead holders (client.ts:258-262) with a start-time check,
    // so this applies that same reap and asserts no lease survives it. A leak from a dead holder is therefore not detected here.
    const state = readState(governorDir());
    reap(state, Date.now(), await readStarts(ownerPids(state)));
    expect(state.leases).toEqual([]);
  }, 60_000);

  // WHY: the user's ruling (TRDD-SWNIIFTF, 2026-10-28): "not having enough memory is not a failure, it only put the requests in a
  // queue, waiting fot the memory to be freed enough to run another request pending." The whole CLI, --stop_on_errors set, queued
  // behind a held lease: once the memory (the lease) is free the command must finish normally, exit 0, with no stop notice.
  it("--stop_on_errors does not fire on a governor wait: the command waits in the queue, then completes with exit 0 and its report", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const srv = await countingServer(0);
    servers.push(srv.server);
    const lease = await gate();
    const cfg = join(root, "cfg");
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    const out = join(root, "out");
    for (const d of [cfg, home, tmp, out]) mkdirSync(d, { recursive: true });
    writeFileSync(join(cfg, "settings.yaml"), ["active: prof-a", "profiles:", "  prof-a:", "    mode: local", "    api: generic-local", "    model: model-a", `    url: ${srv.url}`, "    timeout: 60", ""].join("\n"));
    const file = join(root, "a.txt");
    writeFileSync(file, "hello\n");
    const child = spawn(process.execPath, [cli, "--stop_on_errors", "llm", "ask", "--input_files_paths", file, "--instructions", "say hi", "-o", out], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, TMPDIR: tmp, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLM_EXT_DISABLE_AUTO_RECONCILE: "1", LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1" },
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    await until("the CLI to queue behind the held lease", () => snapshot().waiters.some((w) => w.holder.pid === child.pid) || child.exitCode !== null);
    expect(child.exitCode, stderr).toBeNull();
    // Several 200 ms polls of waiting with the flag set: still alive, still nothing sent.
    // Covers several governor polls (FAST_POLL_MS 200 ms, src/governor/controller.ts:70; a rank-0 waiter polls every 200 to 250 ms). If the poll period grows past this wait, the "whole wait" check weakens without failing.
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode, stderr).toBeNull();
    expect(srv.posts()).toBe(0);
    free(lease);
    const code = await exited(child);
    expect(code, stderr).toBe(0);
    expect(srv.posts()).toBe(1);
    expect(stderr).not.toContain("--stop_on_errors: model");
    expect(stderr).not.toContain("did not end within");
    // One file in answer_mode 0 is saved by processFileCheck (src/index.ts:4007, tool name "code_task"), named by the scheme at src/index.ts:2153.
    const reports = readdirSync(out).filter((f) => /^\d{8}_\d{6}[+-]\d{4}-code_task-a\.txt-[0-9a-f]{6}\.md$/.test(f));
    expect(reports).toHaveLength(1);
    expect(readFileSync(join(out, reports[0]), "utf-8")).toMatch(/^ok$/m);
  }, DEADLINE_MS);
  it("--command_timeout ends a governor wait with exit 124, sends nothing, and --stop_on_errors does not fire on it", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const srv = await countingServer(0);
    servers.push(srv.server);
    await gate();
    const cfg = join(root, "cfg");
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    const out = join(root, "out");
    for (const d of [cfg, home, tmp, out]) mkdirSync(d, { recursive: true });
    writeFileSync(join(cfg, "settings.yaml"), ["active: prof-a", "profiles:", "  prof-a:", "    mode: local", "    api: generic-local", "    model: model-a", `    url: ${srv.url}`, "    timeout: 60", ""].join("\n"));
    const file = join(root, "a.txt");
    writeFileSync(file, "hello\n");
    const child = spawn(process.execPath, [cli, "--command_timeout", "4", "--stop_on_errors", "llm", "ask", "--input_files_paths", file, "--instructions", "say hi", "-o", out], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, TMPDIR: tmp, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLM_EXT_DISABLE_AUTO_RECONCILE: "1", LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1" },
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    await until("the CLI to queue behind the held lease", () => snapshot().waiters.some((w) => w.holder.pid === child.pid) || child.exitCode !== null);
    // WHY tq and not t0 (flake seen once in a loaded full-suite run, 37.5 s): t0 precedes the spawn, so node boot and module load, unbounded on a
    // loaded host, counted against the bound. From the moment the child is queued, the stop at 4 s plus exit takes about 4 s. A real 30 s
    // bounded-exit fallback (STOP_FLUSH_GRACE_MS, main.ts:180) would give about 34 s from tq. NOTE the 20 s bound alone does NOT catch that
    // fallback when queueing happened late; the stderr check `did not end within` below is the fallback guard, the bound only catches a slow exit.
    // stderr rides in the failure message so a failing run shows which of the two happened.
    const tq = Date.now();
    const code = await exited(child);
    expect(code, stderr).toBe(124);
    // Ended by the stop itself, not by the 30 s bounded-exit fallback.
    expect(stderr).not.toContain("did not end within");
    expect(Date.now() - tq, stderr).toBeLessThan(20_000);
    expect(srv.posts()).toBe(0);
    expect(stderr).not.toContain("--stop_on_errors: model");
    await until("the stopped waiter to leave the queue", () => !snapshot().waiters.some((w) => w.holder.pid === child.pid));
  }, DEADLINE_MS);
});

// The CJS shim of esbuild.config.mjs: bundled CJS deps (yaml) call require().
const BANNER = `import { createRequire as __cjsCreateRequire } from "node:module";
import { fileURLToPath as __cjsFileURLToPath } from "node:url";
import { dirname as __cjsDirname } from "node:path";
const require = __cjsCreateRequire(import.meta.url);
const __filename = __cjsFileURLToPath(import.meta.url);
const __dirname = __cjsDirname(__filename);
`;
