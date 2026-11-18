/**
 * broker/broker-governor.test.ts — the broker as a client of the local-inference
 * governor (design/specs/local-inference-governor-design.md D8, unit 2): real
 * brokers, real llama-servers on the two tiny GGUF models of broker.test.ts, one
 * real governor directory per test, and leases held by this process as the only
 * way a denial is produced. Assertions read recorded data (the job timestamps the
 * brokers report, the governor file), never timings.
 */

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordFixture } from "../calibration/test-record.js";
import { writeRecord } from "../calibration/record.js";
import { loadedIdentity, type LoadedIdentity } from "../calibration/fingerprint.js";
import { startCalServer } from "../calibration/runner.js";
import { spawn } from "node:child_process";
import * as gov from "../governor/client.js";
import { withStateLock } from "../governor/state.js";
import { isLocalsServerArgv, processSnapshot, SPAWN_MARKER } from "../local-llama-server.js";
import { tmpdir } from "../test-tmp-root.js";
import { ensureBroker, type BrokerEndpoint } from "./client.js";
import { COMMAND_HEADER, CTX_HEADER, ENGINE_HEADER, GOVERNOR_WAIT_HEADER, isBrokerProcess, QUEUE_TIMEOUT_HEADER, readBrokerState, TIMEOUT_HEADER, TOKEN_HEADER } from "./protocol.js";
import { readRegistry } from "./registry.js";
import { DEFAULT_TIMINGS, queueKey, Scheduler, type Job } from "./scheduler.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LLAMA_CACHE = "/tmp/llm-ext-llama-cache";
const A = "ggml-org/tiny-llamas/stories15M-q4_0.gguf";
const B = "ggml-org/tiny-llamas/stories260K.gguf";
const DEADLINE_MS = 180_000;
const TEST_MS = 300_000;
const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";\nconst require = __cjsCreateRequire(import.meta.url);\n`;
const ENTRY = `import { runBrokerMain } from "./server.ts";\nawait runBrokerMain("t1");\n`;
/** A real client process: one request through brokerExchange, which prints its own wait lines on stderr (argv: url, token, pid, model). */
const CLIENT_ENTRY = `import { brokerExchange } from "./client.ts";
const [url, token, pid, model] = process.argv.slice(2);
const res = await brokerExchange({ url, token, pid: Number(pid) }, { engine: "llama", body: JSON.stringify({ model, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: 4 }), model, ctx: 1024, timeoutMs: 120000 });
process.exit(res.status === 200 ? 0 : 1);
`;

interface Reply {
  state: string;
  status?: number;
  error?: string;
  dispatchedAt?: number;
  finishedAt?: number;
}

let workDir: string;
let bundle: string;
let clientBundle: string;
let governorDir: string;
const dirs: string[] = [];
const identities = new Map<string, LoadedIdentity>();
const savedGovernorEnv = { ...process.env };

async function measure(model: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "llm-ext-brgov-measure-"));
  const saved = process.env.LLAMA_CACHE;
  process.env.LLAMA_CACHE = LLAMA_CACHE;
  try {
    const s = await startCalServer(scratch, "llama", model, 1024, 1, () => undefined);
    try {
      identities.set(model, await loadedIdentity("llama", s.baseUrl, s.apiKey, model, scratch));
    } finally {
      await s.stop("measured");
    }
  } finally {
    if (saved === undefined) delete process.env.LLAMA_CACHE;
    else process.env.LLAMA_CACHE = saved;
    rmSync(scratch, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "llm-ext-brgov-bundle-"));
  bundle = join(workDir, "broker-entry.mjs");
  await build({
    stdin: { contents: ENTRY, resolveDir: HERE, sourcefile: "entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: REQUIRE_SHIM },
    external: nodeExternals,
    outfile: bundle,
  });
  clientBundle = join(workDir, "client-entry.mjs");
  await build({
    stdin: { contents: CLIENT_ENTRY, resolveDir: HERE, sourcefile: "client-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: REQUIRE_SHIM },
    external: [...nodeExternals, "better-sqlite3"],
    outfile: clientBundle,
  });
  for (const m of [A, B]) await measure(m);
}, TEST_MS);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-ext-brgov-cfg-"));
  dirs.push(d);
  for (const m of [A, B]) {
    const id = identities.get(m)!;
    writeRecord(d, { ...recordFixture("llama", m), fingerprint: id.fingerprint, engine_version: id.engineVersion, engine_version_checked: id.engineVersion });
  }
  return d;
}

/** The limits come only from these leases: CPU off, RAM out of reach, so the machine's own load cannot deny anything. */
function governorLimits(maxInferences: number): void {
  process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT = "100";
  process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT = "99";
  process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "100";
  process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = String(maxInferences);
}

const startBroker = (dir: string, env: Record<string, string> = {}): Promise<BrokerEndpoint> =>
  ensureBroker({ dir, version: "t1", entry: bundle, env: { ...process.env, LLAMA_CACHE, ...env } });

async function submit(ep: BrokerEndpoint, model: string, o: { queueTimeoutMs?: number; maxTokens?: number } = {}): Promise<string> {
  const res = await fetch(`${ep.url}/v1/jobs`, {
    method: "POST",
    headers: {
      [TOKEN_HEADER]: ep.token,
      [ENGINE_HEADER]: "llama",
      [CTX_HEADER]: "1024",
      [COMMAND_HEADER]: "test",
      [TIMEOUT_HEADER]: "120000",
      ...(o.queueTimeoutMs === undefined ? {} : { [QUEUE_TIMEOUT_HEADER]: String(o.queueTimeoutMs) }),
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: o.maxTokens ?? 4 }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { job: string }).job;
}

/** The job's final reply. A 204 is a long poll that ended with the job still open, so it is polled again. */
async function outcome(ep: BrokerEndpoint, id: string): Promise<Reply> {
  for (;;) {
    const res = await fetch(`${ep.url}/v1/jobs/${id}?wait=5`, { headers: { [TOKEN_HEADER]: ep.token } });
    if (res.status === 204) continue;
    expect(res.status).toBe(200);
    return (await res.json()) as Reply;
  }
}

async function health(ep: BrokerEndpoint): Promise<{ queued: number; running: number; governor: { error?: string; maxInferences?: number; dir?: string } }> {
  const res = await fetch(`${ep.url}/v1/health`, { headers: { [TOKEN_HEADER]: ep.token } });
  expect(res.status).toBe(200);
  return (await res.json()) as { queued: number; running: number; governor: { error?: string; maxInferences?: number; dir?: string } };
}

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const brokerLog = (dir: string): string => {
  const log = join(dir, "broker-local.log");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
};
const spawnCount = (dir: string): number => brokerLog(dir).split("\n").filter((l) => l.includes(SPAWN_MARKER)).length;
const isReady = (dir: string): boolean => /main llama-server ready/.test(brokerLog(dir));

/** The most jobs running at one instant. An end sorts before a start at the same ms: a release that frees a place comes first. */
function peakOverlap(replies: Reply[]): number {
  const edges = replies.flatMap((r) => [
    { at: r.dispatchedAt!, delta: 1 },
    { at: r.finishedAt!, delta: -1 },
  ]);
  edges.sort((x, y) => x.at - y.at || x.delta - y.delta);
  let now = 0;
  let peak = 0;
  for (const e of edges) {
    now += e.delta;
    peak = Math.max(peak, now);
  }
  return peak;
}

async function stopBroker(dir: string): Promise<void> {
  const st = readBrokerState(dir);
  if (st && (await isBrokerProcess(st.pid))) {
    process.kill(st.pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await isBrokerProcess(st.pid))) await new Promise((r) => setTimeout(r, 100));
    if (await isBrokerProcess(st.pid)) process.kill(st.pid, "SIGKILL");
  }
}

afterEach(async () => {
  try {
    while (dirs.length) {
      const dir = dirs.pop()!;
      await stopBroker(dir);
      const rows = await processSnapshot();
      for (const entry of readRegistry(dir, "llama")) {
        const row = rows.find((r) => r.pid === entry.pid);
        if (row && (basename(row.argv[0] ?? "") === "llama-server" || isLocalsServerArgv(row.argv))) process.kill(-entry.pgid, "SIGKILL");
      }
      await until("the servers of this dir to be gone", async () => !(await processSnapshot()).some((r) => r.command.includes(dir)), 15_000);
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("LLM_EXT_GOVERNOR_")) delete process.env[key];
    for (const [key, value] of Object.entries(savedGovernorEnv)) if (key.startsWith("LLM_EXT_GOVERNOR_")) process.env[key] = value;
    rmSync(governorDir, { recursive: true, force: true });
  }
}, TEST_MS);

beforeEach(() => {
  // A name without the /llm[-_]?ext/ leak marker, as test-hermetic-config.ts does for its own.
  governorDir = mkdtempSync(join(tmpdir(), "govbr-"));
  process.env.LLM_EXT_GOVERNOR_DIR = governorDir;
});

describe("noteDenied (pure)", () => {
  const job = (key: string, model: string, submittedAt: number, queueTimeoutMs: number): Job => ({
    id: `${model}-${submittedAt}`,
    key,
    engine: "llama",
    model,
    ctx: 0,
    commandId: "c",
    body: "{}",
    timeoutMs: 1000,
    queueTimeoutMs,
    submittedAt,
    lastPolledAt: submittedAt,
    pollers: 0,
    state: "queued",
  });
  const timings = { ...DEFAULT_TIMINGS, batch: 100, minRunMs: 1000 };
  const a = queueKey("a", 0, "llama");
  const b = queueKey("b", 0, "llama");

  it("denied time is not run time: the time rule fires only after minRunMs of real run", () => {
    const s = new Scheduler();
    for (const n of [1, 2, 3]) s.enqueue(job(a, "a", n, 600_000));
    s.startRun(a, 0);
    s.enqueue(job(b, "b", 4, 1));
    expect(s.wantRotation(1000, 0, timings)).toBe(b);
    s.noteDenied(900);
    expect(s.wantRotation(1000, 0, timings)).toBeNull();
    expect(s.wantRotation(1900, 0, timings)).toBe(b);
  });

  it("the count half of the minimum slice still rotates a near deadline in while denied", () => {
    const s = new Scheduler();
    s.enqueue(job(a, "a", 1, 600_000));
    s.startRun(a, 0);
    s.servedInRun = 1;
    s.enqueue(job(a, "a", 2, 600_000));
    s.enqueue(job(b, "b", 3, 1));
    s.noteDenied(10_000);
    expect(s.wantRotation(100, 0, timings)).toBe(b);
  });

  it("a fresh run: a denial as long as the minimum run gives a near deadline the next grant, and keeps its credit until then", () => {
    const s = new Scheduler();
    for (const n of [1, 2, 3]) s.enqueue(job(a, "a", n, 600_000));
    s.startRun(a, 0);
    s.enqueue(job(b, "b", 4, 1));
    s.noteDenied(1000);
    expect(s.wantRotation(1000, 0, timings)).toBeNull();
    expect(s.endDenial(1000, timings)).toBe(true);
    expect(s.wantRotation(1000, 0, timings)).toBe(b);
  });

  it("a denial shorter than the minimum run changes nothing: the current model is served first", () => {
    const s = new Scheduler();
    for (const n of [1, 2, 3]) s.enqueue(job(a, "a", n, 600_000));
    s.startRun(a, 0);
    s.enqueue(job(b, "b", 4, 1));
    s.noteDenied(999);
    expect(s.endDenial(999, timings)).toBe(false);
    expect(s.wantRotation(999, 0, timings)).toBeNull();
  });

  it("with no near deadline a long denial keeps its credit, and the time rule stays quiet after the grant", () => {
    const s = new Scheduler();
    for (const n of [1, 2, 3]) s.enqueue(job(a, "a", n, 600_000));
    s.startRun(a, 0);
    s.enqueue(job(b, "b", 4, 600_000));
    s.noteDenied(5000);
    expect(s.endDenial(5000, timings)).toBe(false);
    expect(s.wantRotation(5000, 0, timings)).toBeNull();
  });
});

describe("the broker through a real governor (two tiny GGUF models)", () => {
  it("8 config dirs: the jobs running at once across all brokers never exceed the limit, nor the window of the moment", async () => {
    const limit = 2;
    governorLimits(limit);
    const configs = Array.from({ length: 8 }, () => newDir());
    const eps = await Promise.all(configs.map((d) => startBroker(d)));
    // Load first: all 8 servers ready before the burst, so every broker competes for the same leases at once.
    await Promise.all(eps.map(async (ep) => outcome(ep, await submit(ep, A))));

    let peakSampled = 0;
    let loadsAtOnce = 0;
    let breach: string | null = null;
    const sampler = setInterval(() => {
      const s = gov.snapshot();
      peakSampled = Math.max(peakSampled, s.running);
      loadsAtOnce = Math.max(loadsAtOnce, s.leases.filter((l) => l.kind === "load").length);
      if (s.running > s.w) breach = `running ${s.running} above window ${s.w}`;
    }, 10);
    let replies: Reply[];
    try {
      const ids = await Promise.all(eps.map(async (ep) => ({ ep, ids: await Promise.all(Array.from({ length: 6 }, () => submit(ep, A, { maxTokens: 100 }))) })));
      replies = await Promise.all(ids.flatMap(({ ep, ids: own }) => own.map((id) => outcome(ep, id))));
    } finally {
      clearInterval(sampler);
    }
    expect(replies.filter((r) => r.state !== "done" || r.status !== 200)).toEqual([]);
    expect(breach).toBeNull();
    expect(peakSampled).toBeGreaterThanOrEqual(1);
    expect(peakSampled).toBeLessThanOrEqual(limit);
    expect(loadsAtOnce).toBeLessThanOrEqual(1);
    expect(peakOverlap(replies)).toBeLessThanOrEqual(limit);
    await until("every lease and waiter to go", () => {
      const s = gov.snapshot();
      return s.leases.length === 0 && s.waiters.length === 0;
    });
    for (const d of configs) expect(spawnCount(d)).toBe(1);
  }, TEST_MS);

  it("a denial of 3 x minRunMs causes no swap, and the near deadline wins the grant that ends it", async () => {
    const minRunMs = 1000;
    governorLimits(1);
    const dir = newDir();
    const ep = await startBroker(dir, { LLM_EXT_BROKER_MIN_RUN_MS: String(minRunMs), LLM_EXT_BROKER_BATCH: "1000", LLM_EXT_BROKER_STARVE_MS: "600000" });
    const denial = await gov.acquire({ timeoutMs: DEADLINE_MS });
    const a = await Promise.all([1, 2, 3].map(() => submit(ep, A)));
    await until("model A to load", () => isReady(dir));
    // B's deadline is past from the start: only the minimum run of A stands between it and a swap.
    const b = await submit(ep, B, { queueTimeoutMs: 1 });
    await new Promise((r) => setTimeout(r, 3 * minRunMs));
    expect(spawnCount(dir)).toBe(1);
    expect(await health(ep)).toMatchObject({ queued: 4, running: 0, governor: { dir: governorDir, maxInferences: 1 } });
    gov.release(denial);
    const aReplies = await Promise.all(a.map((id) => outcome(ep, id)));
    const bReply = await outcome(ep, b);
    expect([...aReplies, bReply].filter((r) => r.state !== "done")).toEqual([]);
    // A run with nothing served has no count half to satisfy: B wins the grant that ends the denial, not a slice later (D8).
    expect(bReply.dispatchedAt).toBeLessThan(Math.min(...aReplies.map((r) => r.dispatchedAt!)));
  }, TEST_MS);

  it("a near-deadline model wins the next grant, even though the denial began before its job arrived", async () => {
    governorLimits(1);
    const dir = newDir();
    const ep = await startBroker(dir, { LLM_EXT_BROKER_BATCH: "1", LLM_EXT_BROKER_STARVE_MS: "600000" });
    await outcome(ep, await submit(ep, A));
    const denial = await gov.acquire({ timeoutMs: DEADLINE_MS });
    const a = await Promise.all([1, 2, 3, 4].map(() => submit(ep, A)));
    const b = await submit(ep, B, { queueTimeoutMs: 1 });
    // The swap takes a load lease, which an inference denial does not refuse: B is loaded and first in line.
    await until("model B to load during the denial", () => spawnCount(dir) === 2 && /main llama-server ready[^\n]*stories260K/.test(brokerLog(dir)));
    gov.release(denial);
    const bReply = await outcome(ep, b);
    const aReplies = await Promise.all(a.map((id) => outcome(ep, id)));
    expect([...aReplies, bReply].filter((r) => r.state !== "done")).toEqual([]);
    expect(bReply.dispatchedAt).toBeLessThan(Math.min(...aReplies.map((r) => r.dispatchedAt!)));
  }, TEST_MS);

  it("a swap that cannot get a load grant stops nothing, and goes ahead at the grant", async () => {
    governorLimits(2);
    const dir = newDir();
    const ep = await startBroker(dir, { LLM_EXT_BROKER_LINGER_MS: "50" });
    await outcome(ep, await submit(ep, A));
    const serverPid = readRegistry(dir, "llama").find((e) => e.role === "main")!.pid;
    // A load of known size: one without bytes is of unknown size since round 2 of unit 4, runs alone, and would have
    // the broker's idle server asked back.
    const block = await gov.acquire({ kind: "load", timeoutMs: DEADLINE_MS, bytes: 1024 ** 3, minBytes: 1024 ** 3 });
    const b = await submit(ep, B);
    await until("the broker to ask for a load", () => gov.snapshot().waiters.some((w) => w.kind === "load" && w.holder.pid === ep.pid));
    await new Promise((r) => setTimeout(r, 500));
    expect(brokerLog(dir)).not.toMatch(/stopped main/);
    expect((await processSnapshot()).some((r) => r.pid === serverPid)).toBe(true);
    gov.release(block);
    expect(await outcome(ep, b)).toMatchObject({ state: "done", status: 200 });
    expect(brokerLog(dir)).toMatch(/stopped main/);
    await until("the load lease to go", () => gov.snapshot().leases.length === 0);
  }, TEST_MS);

  it("a lease taken once the queue is empty is released in the same pass", async () => {
    governorLimits(2);
    const dir = newDir();
    const ep = await startBroker(dir);
    await outcome(ep, await submit(ep, A));
    // The extra lease is granted only with room in the window, so two jobs at a time raise it to the limit first.
    await until("the window to open", async () => {
      await Promise.all([submit(ep, A, { maxTokens: 60 }), submit(ep, A, { maxTokens: 60 })].map(async (id) => outcome(ep, await id)));
      return gov.snapshot().w === 2;
    });
    expect(await outcome(ep, await submit(ep, A))).toMatchObject({ state: "done" });
    await until("every lease and waiter to go", () => {
      const s = gov.snapshot();
      return s.leases.length === 0 && s.waiters.length === 0;
    }, 10_000);
    // An idle broker has no business in the governor: its 1 s tick neither takes a place nor rewrites the state file.
    await new Promise((r) => setTimeout(r, 300));
    const stateFile = join(governorDir, "state-1.json");
    const before = statSync(stateFile).mtimeMs;
    await new Promise((r) => setTimeout(r, 2500));
    expect(statSync(stateFile).mtimeMs).toBe(before);
    expect(gov.snapshot().waiters).toEqual([]);
  }, TEST_MS);

  it("shutdown leaves no waiter: a denied broker gives up its place, without anyone reaping it", async () => {
    governorLimits(1);
    const dir = newDir();
    const ep = await startBroker(dir);
    expect(await outcome(ep, await submit(ep, A))).toMatchObject({ state: "done" });
    const denial = await gov.acquire({ timeoutMs: DEADLINE_MS });
    await submit(ep, A);
    await until("the broker to wait in the queue", () => gov.snapshot().waiters.some((w) => w.holder.pid === ep.pid));
    process.kill(ep.pid, "SIGTERM");
    await until("the broker to exit", async () => !(await isBrokerProcess(ep.pid)));
    // snapshot is lockless and reaps nothing, so what it shows is what shutdown itself did.
    expect(gov.snapshot().waiters).toEqual([]);
    gov.release(denial);
  }, TEST_MS);

  it("shutdown leaves no lease: jobs running at the signal give theirs back, without anyone reaping it", async () => {
    governorLimits(2);
    const dir = newDir();
    const ep = await startBroker(dir);
    expect(await outcome(ep, await submit(ep, A))).toMatchObject({ state: "done" });
    await Promise.all(Array.from({ length: 8 }, () => submit(ep, A, { maxTokens: 120 })));
    await until("the broker to hold a lease", () => gov.snapshot().leases.some((l) => l.holder.pid === ep.pid));
    process.kill(ep.pid, "SIGTERM");
    await until("the broker to exit", async () => !(await isBrokerProcess(ep.pid)));
    expect(gov.snapshot().leases).toEqual([]);
    expect(gov.snapshot().waiters).toEqual([]);
  }, TEST_MS);

  it("shutdown during a load gives the load lease back: the swap that holds it does not get to finish", async () => {
    governorLimits(2);
    const dir = newDir();
    const ep = await startBroker(dir);
    await submit(ep, A);
    await until("the broker to hold a load lease", () => gov.snapshot().leases.some((l) => l.kind === "load" && l.holder.pid === ep.pid), 30_000);
    process.kill(ep.pid, "SIGTERM");
    await until("the broker to exit", async () => !(await isBrokerProcess(ep.pid)));
    expect(gov.snapshot().leases).toEqual([]);
  }, TEST_MS);

  it.runIf(platform() === "darwin")("readings that keep failing on a healthy dir fail the jobs and leave no place in the queue", async () => {
    governorLimits(1);
    const dir = newDir();
    // vm_stat is in /usr/bin, ps in /bin: only the reading breaks.
    const ep = await startBroker(dir, { PATH: "/bin" });
    const reply = await outcome(ep, await submit(ep, A));
    expect(reply.state).toBe("failed");
    expect(reply.error).toContain("vm_stat");
    expect(spawnCount(dir)).toBe(0);
    await until("the broker to give up its place", () => gov.snapshot().waiters.length === 0, 5_000);
    expect(await health(ep)).toMatchObject({ running: 0 });
  }, TEST_MS);

  it("a broker behind a live head that stopped polling moves it to the tail and runs its job", async () => {
    governorLimits(1);
    const dir = newDir();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    try {
      const ep = await startBroker(dir);
      // Not stale yet at the broker's first pass, which takes the lock whatever the rank: the stamp has to run out while
      // the broker only polls the file.
      withStateLock(governorDir, (s) => {
        const limits = { ramLimitPct: 99, cpuLimitPct: 100, maxInferences: 1 };
        s.waiters.push({ id: "stopped", kind: "load", weight: 1, holder: { pid: sleeper.pid as number, start: "" }, since: Date.now(), polledAt: Date.now() - 7_000, queueTimeoutMs: null, limits });
      });
      const id = await submit(ep, A);
      await until("the broker to wait behind the head", () => gov.snapshot().waiters.some((w) => w.holder.pid === ep.pid), 2_500);
      await until("the broker to pass the stopped head", () => gov.snapshot().waiters[0]?.id !== "stopped", 20_000);
      expect(await outcome(ep, id)).toMatchObject({ state: "done" });
      expect(gov.snapshot().waiters.map((w) => w.id)).toEqual(["stopped"]);
    } finally {
      sleeper.kill("SIGKILL");
    }
  }, TEST_MS);
  it("TRDD-ZTO9K8EK: a job the governor denies says why on its poll reply, and a real client prints one stderr wait line naming it", async () => {
    // With no CPU floor a governed wait is bounded only by --command_timeout, so a brokered client must not wait silently.
    // The denial is a real one: this process holds the only inference lease (max_inferences 1), the way the other tests here deny.
    governorLimits(1);
    const dir = newDir();
    const ep = await startBroker(dir);
    expect(await outcome(ep, await submit(ep, A))).toMatchObject({ state: "done" });
    const denial = await gov.acquire({ timeoutMs: DEADLINE_MS });
    let released = false;
    const release = (): void => {
      if (!released) gov.release(denial);
      released = true;
    };
    try {
      // The channel: the 204 poll reply of the queued job carries the governor reason, as the held header carries a hold.
      const id = await submit(ep, A);
      let reason: string | null = null;
      await until("the poll reply to name the governor denial", async () => {
        const res = await fetch(`${ep.url}/v1/jobs/${id}?wait=5`, { headers: { [TOKEN_HEADER]: ep.token } });
        expect(res.status).toBe(204);
        reason = res.headers.get(GOVERNOR_WAIT_HEADER);
        return reason !== null;
      }, 60_000);
      expect(reason).toContain("inferences are running");
      // The client: a real process running brokerExchange, its own stderr.
      const child = spawn(process.execPath, [clientBundle, ep.url, ep.token, String(ep.pid), A], { stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr.on("data", (c: Buffer) => (said += c.toString()));
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      try {
        await until("the client to say why it waits", () => said.includes("local inference waiting: ") && said.includes("inferences are running"), 60_000);
        expect(said).toContain("bound the wait with --command_timeout");
        expect(child.exitCode).toBeNull();
        release();
        expect(await exited).toBe(0);
        expect(said.match(/local inference waiting/g)).toHaveLength(1);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      expect(await outcome(ep, id)).toMatchObject({ state: "done" });
    } finally {
      release();
    }
  }, TEST_MS);
  it("an unusable governor dir fails the jobs naming the path; nothing runs ungoverned and the broker stays up", async () => {
    governorLimits(2);
    // No start at all: the load is refused before anything is spawned.
    const dir = newDir();
    const unusable = join(governorDir, "not-a-dir");
    writeFileSync(unusable, "");
    const ep = await startBroker(dir, { LLM_EXT_GOVERNOR_DIR: unusable });
    const first = await outcome(ep, await submit(ep, A));
    expect(first.state).toBe("failed");
    expect(first.error).toContain(unusable);
    expect(spawnCount(dir)).toBe(0);
    expect(await health(ep)).toMatchObject({ running: 0, governor: { error: expect.stringContaining(unusable) } });

    // The dir going bad under a loaded server: the job fails and is never sent to the server.
    const dir2 = newDir();
    const usable = join(governorDir, "usable");
    const ep2 = await startBroker(dir2, { LLM_EXT_GOVERNOR_DIR: usable });
    expect(await outcome(ep2, await submit(ep2, A))).toMatchObject({ state: "done" });
    await until("the lease to go", () => {
      process.env.LLM_EXT_GOVERNOR_DIR = usable;
      return gov.snapshot().leases.length === 0;
    });
    process.env.LLM_EXT_GOVERNOR_DIR = governorDir;
    renameSync(usable, `${usable}.moved`);
    writeFileSync(usable, "");
    const second = await outcome(ep2, await submit(ep2, A));
    expect(second.state).toBe("failed");
    expect(second.error).toContain(usable);
    expect(second.dispatchedAt).toBeUndefined();
    expect(spawnCount(dir2)).toBe(1);
    expect((await fetch(`${ep2.url}/v1/health`, { headers: { [TOKEN_HEADER]: ep2.token } })).status).toBe(200);
  }, TEST_MS);
});

