/**
 * broker.test.ts — the per-engine broker, real and unmocked (TRDD-1OOAH3LD,
 * spec point 14, llama part). A real llama-server serves two tiny GGUF models
 * (ggml-org/tiny-llamas stories15M-q4_0.gguf and stories260K.gguf, cached in
 * the persistent LLAMA_CACHE /tmp/llm-ext-llama-cache); the broker and every
 * client are SEPARATE node processes, bundled from the current source with
 * esbuild (dist/ may be stale and a test must never regenerate it). Timing
 * parameters are shortened through the LLM_EXT_BROKER_* environment.
 * Every test gets its own config dir, so its broker, registry and --log-file
 * marker never match a server the user runs; every process started is
 * stopped in afterEach and a process snapshot confirms it.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { builtinModules } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "../test-tmp-root.js";
import { extractTimeoutFlags, MAX_TIMEOUT_S } from "../cli/timeout-flags.js";
import { Scheduler, queueKey, DEFAULT_TIMINGS, type Job } from "./scheduler.js";
import { CTX_HEADER, readBrokerState, STATE_HEADER, TOKEN_HEADER, writeBrokerState } from "./protocol.js";
import { claimAndSpawn, hasLogFileMarker, readRegistry, registryPath, roleLogFile, stopOwnServer } from "./registry.js";
import { llamaServerEnv, MAIN_SLOTS, ManagedServerError, processSnapshot, readCommandLine, SPAWN_MARKER, stopProcessGroup, withAsyncLock } from "../local-llama-server.js";
import { brokerExchange, BrokerJobError, BrokerUnavailableError, cancelAllBrokerJobs, endpointFailureKind, type BrokerEndpoint } from "./client.js";
import { clockForCall, retryWindowClosed, startRetryClock, type RetryClock } from "../provider/http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LLAMA_CACHE = "/tmp/llm-ext-llama-cache";
const A = "ggml-org/tiny-llamas/stories15M-q4_0.gguf";
const B = "ggml-org/tiny-llamas/stories260K.gguf";
const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";\nconst require = __cjsCreateRequire(import.meta.url);\n`;

// One bundle is both the broker (`__broker llama`) and a client: the client's
// default broker entry is the bundle it runs from, exactly as dist/llm-ext.js
// in production.
const ENTRY = `
import { runBrokerMain } from "./server.ts";
import { setBrokerClientVersion, ensureBroker, brokerExchange } from "./client.ts";
const [mode, arg] = process.argv.slice(2);
if (mode === "__broker") {
  await runBrokerMain(arg, process.env.TEST_BROKER_VERSION ?? "t1");
} else {
  const spec = JSON.parse(arg);
  setBrokerClientVersion(spec.version);
  const ep = await ensureBroker({ engine: "llama", dir: spec.dir, version: spec.version });
  const results = await Promise.all(spec.jobs.map(async (j, i) => {
    await new Promise((r) => setTimeout(r, j.delayMs ?? 0));
    const body = JSON.stringify({ model: j.model, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: j.maxTokens ?? 4 });
    try {
      const res = await brokerExchange(ep, { body, model: j.model, ctx: 1024, timeoutMs: 120000, queueTimeoutMs: j.queueTimeoutMs });
      await res.text();
      return { i, model: j.model, status: res.status, at: Date.now() };
    } catch (e) {
      return { i, model: j.model, error: String(e.message), at: Date.now() };
    }
  }));
  process.stdout.write(JSON.stringify({ pid: ep.pid, results }) + "\\n");
}
`;

let workDir: string;
let bundle: string;
const dirs: string[] = [];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "llm-ext-broker-bundle-"));
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
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-ext-broker-cfg-"));
  dirs.push(d);
  return d;
}

/** Stop every process a test left: the broker (SIGTERM, then SIGKILL), every registry pgid, every process carrying this dir's marker. */
async function cleanup(dir: string): Promise<void> {
  const st = readBrokerState(dir, "llama");
  if (st) {
    try {
      process.kill(st.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(st.pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      process.kill(st.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  const rows = await processSnapshot();
  // NEVER signal this runner's own process group: a CLI child the test spawned
  // (not detached) shares it, and `kill(-pgid)` on such a child killed vitest
  // and the shell running it. Those children are killed by pid instead.
  const ownPgid = rows.find((r) => r.pid === process.pid)?.pgid;
  for (const row of rows) {
    if (row.argv.some((t) => t.startsWith(dir)) || readRegistry(dir, "llama").some((e) => e.pgid === row.pgid)) {
      try {
        if (row.pgid === ownPgid || row.pgid <= 1) process.kill(row.pid, "SIGKILL");
        else process.kill(-row.pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  const left = (await processSnapshot()).filter((r) => r.argv.some((t) => t.startsWith(dir)));
  rmSync(dir, { recursive: true, force: true });
  expect(left.map((r) => r.argv.join(" "))).toEqual([]);
}

// 300 s: one cleanup per dir (2 process snapshots + a settle wait each), and the CLI-flag test makes 30 dirs; 60 s was borderline on a loaded machine.
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
}, 300_000);

interface ClientResult {
  pid: number;
  results: Array<{ i: number; model: string; status?: number; error?: string; at: number }>;
}

function runClient(dir: string, jobs: object[], env: Record<string, string> = {}, version = "t1"): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, "client", JSON.stringify({ dir, version, jobs })], {
      env: { ...process.env, LLAMA_CACHE, LLM_EXT_CONFIG_DIR: dir, TEST_BROKER_VERSION: version, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`client exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim().split("\n").pop()!) as ClientResult);
    });
  });
}

const spawnLines = (dir: string): string[] => {
  const log = join(dir, "broker-llama.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes(SPAWN_MARKER)) : [];
};

/** Count, over the whole run, the most main servers of this dir alive at once (process snapshots every 200 ms). */
function watchMains(dir: string): { stop: () => number } {
  let max = 0;
  let on = true;
  const marker = roleLogFile(dir, "main");
  let failure: unknown = null;
  // Caught and rethrown at stop(): a failed snapshot must fail THIS test, not surface as an unhandled rejection later.
  void (async () => {
    while (on) {
      const n = (await processSnapshot()).filter((r) => r.argv[r.argv.indexOf("--log-file") + 1] === marker && r.argv.indexOf("--log-file") >= 0).length;
      max = Math.max(max, n);
      await new Promise((r) => setTimeout(r, 200));
    }
  })().catch((e: unknown) => {
    failure = e;
  });
  return {
    stop: () => {
      on = false;
      if (failure) throw failure;
      return max;
    },
  };
}

const jobsOf = (model: string, n: number, extra: object = {}): object[] => Array.from({ length: n }, () => ({ model, ...extra }));

describe("timeout flags (pure parser)", () => {
  it("accepts every spelling in both the = and the space form, in seconds", () => {
    for (const f of ["--command_timeout", "--command-timeout", "--timeout"]) {
      expect(extractTimeoutFlags([`${f}=7`, "llm", "ask"])).toEqual({ argv: ["llm", "ask"], commandTimeoutS: 7 });
      expect(extractTimeoutFlags(["llm", f, "7", "ask"])).toEqual({ argv: ["llm", "ask"], commandTimeoutS: 7 });
    }
    for (const f of ["--queue_timeout", "--queue-timeout"]) {
      expect(extractTimeoutFlags([`${f}=99990`])).toEqual({ argv: [], queueTimeoutS: 99990 });
      expect(extractTimeoutFlags([f, "99990", "x"])).toEqual({ argv: ["x"], queueTimeoutS: 99990 });
    }
  });
  it("refuses a non-numeric, zero or missing value", () => {
    expect(() => extractTimeoutFlags(["--timeout=abc"])).toThrow(/whole number of seconds/);
    expect(() => extractTimeoutFlags(["--queue_timeout", "0"])).toThrow(/whole number of seconds/);
    expect(() => extractTimeoutFlags(["--command-timeout"])).toThrow(/got nothing/);
  });
});

describe("scheduler (pure rules)", () => {
  const job = (model: string, commandId: string, at: number, queueTimeoutMs = DEFAULT_TIMINGS.starveMs): Job => ({
    id: `${model}-${commandId}-${at}`,
    key: queueKey(model, 0),
    model,
    ctx: 0,
    commandId,
    body: "{}",
    timeoutMs: 1000,
    queueTimeoutMs,
    submittedAt: at,
    lastPolledAt: at,
    pollers: 0,
    state: "queued",
  });
  it("serves commands of one model round-robin", () => {
    const s = new Scheduler();
    for (let i = 0; i < 5; i++) s.enqueue(job("m", "big", i));
    s.enqueue(job("m", "small", 10));
    const order = [s.take(queueKey("m", 0))!, s.take(queueKey("m", 0))!].map((j) => j.commandId);
    expect(order).toEqual(["big", "small"]);
  });
  const T0 = { ...DEFAULT_TIMINGS, batch: 2, minRunMs: 1e9, lingerMs: 1000, defaultLoadMs: 5_000 };
  /** A scheduler whose current model "a" was loaded at t=0 with `queued` jobs of its own. */
  const running = (queued: number): Scheduler => {
    const s = new Scheduler();
    for (let i = 0; i < queued; i++) s.enqueue(job("a", "c1", i));
    s.startRun(queueKey("a", 0), 0);
    return s;
  };
  it("rotates only after the minimum slice AND a near deadline, to the earliest deadline", () => {
    const s = running(10);
    s.enqueue(job("b", "c2", 0, 100_000));
    s.enqueue(job("c", "c3", 0, 20_000));
    // Minimum slice not served yet: no rotation, even with c's deadline passed.
    expect(s.wantRotation(50_000, 1, T0)).toBeNull();
    s.servedInRun = 2;
    // Slice served; c's deadline (20 s) is within its load estimate (5 s) of t = 16 s, b's is not.
    expect(s.wantRotation(10_000, 1, T0)).toBeNull();
    expect(s.wantRotation(16_000, 1, T0)).toBe(queueKey("c", 0));
    // A measured load time moves "near": c loading in 1 s is not due at 16 s.
    s.recordLoad(queueKey("c", 0), 1_000);
    expect(s.wantRotation(16_000, 1, T0)).toBeNull();
    expect(s.wantRotation(19_500, 1, T0)).toBe(queueKey("c", 0));
  });
  it("D also completes the minimum slice", () => {
    const s = running(10);
    s.enqueue(job("b", "c2", 0, 1));
    expect(s.wantRotation(5_000, 1, { ...T0, batch: 1000, minRunMs: 6_000 })).toBeNull();
    expect(s.wantRotation(6_000, 1, { ...T0, batch: 1000, minRunMs: 6_000 })).toBe(queueKey("b", 0));
  });
  it("a job with --queue_timeout=99990 does not pull its model in after B requests of other work", () => {
    const s = running(100);
    s.enqueue(job("b", "c2", 0, 99_990_000));
    s.servedInRun = 50;
    expect(s.wantRotation(3_600_000, 1, T0)).toBeNull();
  });
  it("lingers before an empty-queue rotation so a sequential caller can submit again", () => {
    const s = running(0);
    s.enqueue(job("b", "c2", 0));
    s.touch(10_000);
    expect(s.wantRotation(10_500, 0, T0)).toBeNull();
    expect(s.wantRotation(11_000, 0, T0)).toBe(queueKey("b", 0));
  });
  it("review C1: two models with overdue jobs never swap without serving (the new model gets its slice first)", () => {
    const s = new Scheduler();
    for (let i = 0; i < 5; i++) s.enqueue(job("a", "c1", 0, 1));
    for (let i = 0; i < 5; i++) s.enqueue(job("b", "c2", 0, 1));
    s.startRun(queueKey("b", 0), 10_000);
    expect(s.wantRotation(10_000, 0, T0)).toBeNull();
  });
  it("invariant over a randomised multi-model simulation: every swap is followed by a dispatch before the next swap, and every job is served", () => {
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 50; run++) {
      const s = new Scheduler();
      const t = { ...DEFAULT_TIMINGS, batch: 1 + Math.floor(rnd() * 6), minRunMs: 2_000 + Math.floor(rnd() * 20_000), lingerMs: 1000, defaultLoadMs: 3_000 };
      const models = ["m0", "m1", "m2", "m3"].slice(0, 2 + Math.floor(rnd() * 3));
      let now = 0;
      let submitted = 0;
      let served = 0;
      let current: string | null = null;
      let dispatchesSinceSwap = 1;
      let swaps = 0;
      const inFlight: number[] = [];
      // Arrivals (about 1 per second for 150 s) stay below the service capacity (2 in flight, about 0.85 s each), then the queue drains.
      for (let step = 0; step < 20_000 && (step < 1500 || served < submitted); step++) {
        now += 100;
        if (step < 1500 && rnd() < 0.1) {
          const m = models[Math.floor(rnd() * models.length)];
          s.enqueue(job(m, `c${Math.floor(rnd() * 3)}`, now, rnd() < 0.5 ? 1_000 + Math.floor(rnd() * 5_000) : 300_000));
          submitted++;
        }
        for (let i = inFlight.length - 1; i >= 0; i--) {
          if (inFlight[i] <= now) {
            inFlight.splice(i, 1);
            served++;
            s.touch(now);
          }
        }
        const next = s.wantRotation(now, inFlight.length, t);
        if (next !== null && inFlight.length === 0 && next !== current) {
          expect(dispatchesSinceSwap).toBeGreaterThan(0);
          current = next;
          s.startRun(next, now);
          dispatchesSinceSwap = 0;
          swaps++;
          continue;
        }
        if (next === null && current !== null) {
          while (inFlight.length < 2) {
            const j = s.take(current);
            if (!j) break;
            s.servedInRun++;
            s.touch(now);
            dispatchesSinceSwap++;
            inFlight.push(now + 100 + Math.floor(rnd() * 1_500));
          }
        }
      }
      expect(served).toBe(submitted);
      expect(swaps).toBeGreaterThan(0);
    }
  });
  it("drops abandoned jobs before dispatch, never one with a poll waiting", () => {
    const s = new Scheduler();
    const gone = job("a", "c1", 0);
    const kept = { ...job("a", "c2", 0), pollers: 1 };
    s.enqueue(gone);
    s.enqueue(kept);
    expect(s.dropAbandoned(200_000, 120_000)).toEqual([gone]);
    expect(s.allQueued()).toEqual([kept]);
  });
});

describe("broker with a real llama-server (two tiny GGUF models)", () => {
  it("two client processes: one load per model, A before B, never two main servers", async () => {
    const dir = newDir();
    const w = watchMains(dir);
    // Linger 5 s: the two client processes start together, and on a loaded run B's may submit seconds before A's;
    // with A still current and A's work arriving within the linger, A is served first by design, not by luck.
    const env = { LLM_EXT_BROKER_BATCH: "1000", LLM_EXT_BROKER_STARVE_MS: "600000", LLM_EXT_BROKER_LINGER_MS: "5000" };
    const first = await runClient(dir, jobsOf(A, 1), env);
    const [c1, c2] = await Promise.all([runClient(dir, jobsOf(A, 6), env), runClient(dir, jobsOf(B, 3, { delayMs: 50 }), env)]);
    const max = w.stop();
    const all = [...first.results, ...c1.results, ...c2.results];
    expect(all.filter((r) => r.status !== 200)).toEqual([]);
    expect(c1.pid).toBe(first.pid);
    expect(c2.pid).toBe(first.pid);
    expect(spawnLines(dir)).toHaveLength(2);
    expect(Math.max(...c1.results.map((r) => r.at))).toBeLessThanOrEqual(Math.min(...c2.results.map((r) => r.at)));
    expect(max).toBe(1);
  }, 300_000);

  it("rotation: the default waits for the queue, a short --queue_timeout preempts after the minimum slice, --queue_timeout=99990 waits", async () => {
    const dir = newDir();
    // B = 2 is the minimum slice; T = 600 s keeps the default deadline far away.
    const env = { LLM_EXT_BROKER_BATCH: "2", LLM_EXT_BROKER_STARVE_MS: "600000" };
    // One client submits A's 40 requests at once and B's request 500 ms later, so A's queue is always
    // there first (two processes would race on start-up time under a loaded test run).
    const scenario = async (bExtra: object): Promise<{ a: number; b: number }> => {
      await runClient(dir, jobsOf(A, 1), env);
      const r = await runClient(dir, [...jobsOf(A, 40, { maxTokens: 120 }), { model: B, delayMs: 500, ...bExtra }], env);
      expect(r.results.filter((x) => x.status !== 200)).toEqual([]);
      return { a: Math.max(...r.results.filter((x) => x.model === A).map((x) => x.at)), b: r.results.find((x) => x.model === B)!.at };
    };
    // Default queue timeout: B waits until A's queue is empty.
    const d = await scenario({});
    expect(d.b).toBeGreaterThanOrEqual(d.a);
    // A 1 s queue timeout: once A served its minimum slice, the near deadline rotates B in while A still has work.
    const s = await scenario({ queueTimeoutMs: 1000 });
    expect(s.b).toBeLessThan(s.a);
    // The user's --queue_timeout=99990: the job may wait, so B and many requests of A never pull it in early.
    const l = await scenario({ queueTimeoutMs: 99_990_000 });
    expect(l.b).toBeGreaterThanOrEqual(l.a);
  }, 600_000);

  it("a model that fails to start does not skip the next model", async () => {
    const dir = newDir();
    const bad = "ggml-org/llm-ext-no-such-repo-zz/none.gguf";
    const r = await runClient(dir, [{ model: bad }, { model: A, delayMs: 50 }]);
    expect(r.results[0].error).toMatch(/BrokerJobError|failed|exited/);
    expect(r.results[1].status).toBe(200);
  }, 300_000);

  it("an abandoned job and a cancelled job never run", async () => {
    const dir = newDir();
    const env = { LLM_EXT_BROKER_ABANDON_MS: "1500", LLM_EXT_BROKER_BATCH: "1000", LLM_EXT_BROKER_STARVE_MS: "600000" };
    await runClient(dir, jobsOf(A, 1), env);
    const st = readBrokerState(dir, "llama")!;
    const h = { [TOKEN_HEADER]: st.token, "content-type": "application/json" };
    const submit = async (model: string): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${st.port}/v1/jobs`, { method: "POST", headers: h, body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }], max_tokens: 2 }) });
      return ((await res.json()) as { job: string }).job;
    };
    // Keep A busy so B's jobs stay queued, then never poll one and cancel the other.
    // A's server is FROZEN once the batch is on it: a timed batch finished too
    // fast on an idle machine, the server went idle and B was rotated in.
    const dispatched = (): number => readFileSync(join(dir, "broker-llama.log"), "utf8").split("\n").filter((l) => l.includes("dispatch job")).length;
    const seen = dispatched();
    const busy = runClient(dir, jobsOf(A, 8, { maxTokens: 120 }), env);
    for (let i = 0; i < 300 && dispatched() <= seen; i++) await new Promise((r) => setTimeout(r, 50));
    const main = readRegistry(dir, "llama").find((e) => e.role === "main")!.pid;
    process.kill(main, "SIGSTOP");
    const abandoned = await submit(B);
    const cancelled = await submit(B);
    await fetch(`http://127.0.0.1:${st.port}/v1/jobs/${cancelled}`, { method: "DELETE", headers: h });
    // The abandon rule (1.5 s, checked on the 1 s tick) runs while A still holds the server.
    await new Promise((r) => setTimeout(r, 3000));
    process.kill(main, "SIGCONT");
    await busy;
    for (const id of [abandoned, cancelled]) {
      const res = await fetch(`http://127.0.0.1:${st.port}/v1/jobs/${id}?wait=1`, { headers: h });
      const reply = (await res.json()) as { state: string; dispatchedAt?: number };
      expect(reply.state).toBe("cancelled");
      // Never dispatched to a server: that is what "never runs" means.
      expect(reply.dispatchedAt).toBeUndefined();
    }
    expect((await busy).results.filter((r) => r.status !== 200)).toEqual([]);
  }, 300_000);

  it("long-polls repeatedly while queued (poll window shortened to 1 s)", async () => {
    const dir = newDir();
    const env = { LLM_EXT_BROKER_POLL_WAIT_MS: "1000", LLM_EXT_BROKER_BATCH: "1000", LLM_EXT_BROKER_STARVE_MS: "600000" };
    await runClient(dir, jobsOf(A, 1), env);
    // One client: A's 40 requests at once, B's 500 ms later, so A's queue is always there first (two processes race on start-up time under a loaded test run).
    const r = await runClient(dir, [...jobsOf(A, 40, { maxTokens: 120 }), { model: B, delayMs: 500 }], env);
    expect(r.results.filter((x) => x.status !== 200)).toEqual([]);
    // B waited for A's whole queue, far longer than one 1 s poll window, and still completed.
    const aFirst = Math.min(...r.results.filter((x) => x.model === A).map((x) => x.at));
    expect(r.results.find((x) => x.model === B)!.at - aFirst).toBeGreaterThan(1000);
  }, 300_000);

  it("after a broker SIGKILL the next broker kills the orphaned main by its pgid", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1));
    const st = readBrokerState(dir, "llama")!;
    const orphan = readRegistry(dir, "llama").find((e) => e.role === "main")!;
    process.kill(st.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const r = await runClient(dir, jobsOf(B, 1));
    expect(r.results[0].status).toBe(200);
    expect(r.pid).not.toBe(st.pid);
    expect((await processSnapshot()).filter((p) => p.pgid === orphan.pgid)).toEqual([]);
    expect(readFileSync(join(dir, "broker-llama.log"), "utf8")).toMatch(new RegExp(`stopped orphaned main llama-server pid ${orphan.pid}`));
  }, 300_000);

  it("a client of another version hands over: the old broker drains and exits, the new one serves", async () => {
    const dir = newDir();
    const old = await runClient(dir, jobsOf(A, 1), {}, "t1");
    const next = await runClient(dir, jobsOf(A, 2), {}, "t2");
    expect(next.results.every((r) => r.status === 200)).toBe(true);
    expect(next.pid).not.toBe(old.pid);
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(old.pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(() => process.kill(old.pid, 0)).toThrow();
    expect(readBrokerState(dir, "llama")?.version).toBe("t2");
  }, 300_000);

  it("idle: stops its server, then exits, with short windows", async () => {
    const dir = newDir();
    const r = await runClient(dir, jobsOf(A, 1), { LLM_EXT_BROKER_IDLE_SERVER_MS: "1500", LLM_EXT_BROKER_IDLE_EXIT_MS: "3000" });
    expect(r.results[0].status).toBe(200);
    const main = readRegistry(dir, "llama").find((e) => e.role === "main")!;
    for (let i = 0; i < 150; i++) {
      try {
        process.kill(r.pid, 0);
      } catch {
        break;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(() => process.kill(r.pid, 0)).toThrow();
    expect((await processSnapshot()).filter((p) => p.pgid === main.pgid)).toEqual([]);
    expect(readBrokerState(dir, "llama")).toBeNull();
  }, 300_000);
});

/**
 * The CLI the command-level tests run, built once per file from src (not a
 * stale dist). LLM_EXT_E2E_CLI=<path> runs them against another bundle
 * instead, e.g. the shipped dist/llm-ext.js after a build.
 */
let cliBuild: Promise<string> | null = null;
let cliBuildDir: string | null = null;
function cliBundle(): Promise<string> {
  const given = process.env.LLM_EXT_E2E_CLI;
  if (given) return Promise.resolve(given);
  cliBuild ??= (async () => {
    // Under the package node_modules (a gitignored cache), not /tmp: the bundle keeps better-sqlite3 external, and an ESM import resolves it only from a node_modules folder above the importing file.
    cliBuildDir = mkdtempSync(join(HERE, "..", "..", "node_modules", ".cache-llm-ext-broker-cli-"));
    const out = join(cliBuildDir, "llm-ext.mjs");
    await build({
      entryPoints: [join(HERE, "..", "cli", "main.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: `import { createRequire as __cjsCreateRequire } from "node:module";\nimport { fileURLToPath as __cjsFileURLToPath } from "node:url";\nimport { dirname as __cjsDirname } from "node:path";\nconst require = __cjsCreateRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);\n` },
      external: [...nodeExternals, "better-sqlite3"],
      outfile: out,
    });
    return out;
  })();
  return cliBuild;
}
afterAll(() => {
  if (cliBuildDir) rmSync(cliBuildDir, { recursive: true, force: true });
});

// Ensure the bundled CLI (not stale dist) accepts the global flags on a generic and a classify command.
describe("global timeout flags through the real CLI entry", () => {
  let cli: string;
  beforeAll(async () => {
    cli = await cliBundle();
  }, 180_000);
  const run = (args: string[]): { code: number; out: string } => {
    const cfg = newDir();
    try {
      const out = execFileSync(process.execPath, [cli, ...args], {
        env: { ...process.env, HOME: cfg, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      return { code: 0, out };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: `${x.stdout}${x.stderr}` };
    }
  };
  it("accepts all three command-timeout spellings and both queue-timeout spellings, = and space forms", () => {
    for (const f of ["--command_timeout", "--command-timeout", "--timeout", "--queue_timeout", "--queue-timeout"]) {
      for (const form of [[`${f}=99999`], [f, "99999"]]) {
        expect(run([...form, "--version"]).code).toBe(0);
        const classify = run(["classify", ...form, "--help"]);
        expect(classify.code, classify.out).toBe(0);
        const generic = run(["llm", "ask", ...form, "--help"]);
        expect(generic.code, generic.out).toBe(0);
      }
    }
  }, 600_000);
  it("refuses a non-numeric value", () => {
    const r = run(["--timeout=abc", "--version"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--timeout expects a whole number of seconds/);
  }, 60_000);
});

// ── Review group 1: kill safety (M6, M7, M8, M12) and the dead-server hang (C2) ──

/** A detached child that is NOT a llama-server; killed by the caller. */
function foreignProcess(extraArgs: string[] = []): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "--", ...extraArgs], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

describe("kill safety (review M6, M7, M8, M12)", () => {
  it("stopProcessGroup refuses pgid 0, 1 and negative values", async () => {
    for (const g of [0, 1, -5]) await expect(stopProcessGroup(g, 100)).rejects.toThrow(/not a valid llama-server group/);
  });

  it("stopProcessGroup refuses a group whose leader is not a llama-server, and the process survives", async () => {
    const pid = foreignProcess();
    try {
      await new Promise((r) => setTimeout(r, 200));
      await expect(stopProcessGroup(pid, 100)).rejects.toThrow(/leader is not a llama-server/);
      expect(alive(pid)).toBe(true);
    } finally {
      killQuietly(pid);
    }
  });

  it("invariant: a non-llama-server process whose argv carries the marker survives the sweep", async () => {
    const dir = newDir();
    const marker = roleLogFile(dir, "main");
    const pid = foreignProcess(["--log-file", marker]);
    try {
      await new Promise((r) => setTimeout(r, 200));
      const row = (await processSnapshot()).find((r) => r.pid === pid)!;
      expect(row.argv[row.argv.indexOf("--log-file") + 1]).toBe(marker);
      await expect(
        claimAndSpawn({ dir, engine: "llama", role: "main", ownerPid: process.pid, spawn: () => Promise.reject(new Error("no spawn in this test")) }),
      ).rejects.toThrow(/no spawn in this test/);
      expect(alive(pid)).toBe(true);
    } finally {
      killQuietly(pid);
    }
  });

  it("stopOwnServer: a dead pid is only released; a live pid with another argv is released, never signalled", async () => {
    const dir = newDir();
    const log: string[] = [];
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => dead.once("exit", r));
    expect(await stopOwnServer(dir, "llama", { pid: dead.pid!, pgid: dead.pid!, argv: ["llama-server", "--port", "1"] }, (m) => log.push(m))).toBe("already exited");
    const pid = foreignProcess();
    try {
      await new Promise((r) => setTimeout(r, 200));
      const how = await stopOwnServer(dir, "llama", { pid, pgid: pid, argv: ["llama-server", "--port", "1"] }, (m) => log.push(m));
      expect(how).toMatch(/nothing was signalled/);
      expect(alive(pid)).toBe(true);
    } finally {
      killQuietly(pid);
    }
  });

  it("a failed ps is an error, never 'no process'", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/llm-ext-no-such-dir";
    try {
      await expect(processSnapshot()).rejects.toThrow(/ps .* failed/);
      // This process is alive: an unreadable argv must throw, not read as "gone".
      await expect(readCommandLine(process.pid)).rejects.toThrow(/failed/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("the registry drops corrupt entries (pgid 0/1, pgid != pid, not a llama-server)", () => {
    const dir = newDir();
    const ok = { role: "main", pid: 4242, pgid: 4242, port: 1, argv: ["/x/llama-server", "-m", "a"], model: "a", ctx: 0, ownerPid: 4243, startedAt: "" };
    const entries = [ok, { ...ok, pid: 1, pgid: 1 }, { ...ok, pgid: 0 }, { ...ok, pgid: 4241 }, { ...ok, argv: ["bash"] }];
    writeFileSync(registryPath(dir, "llama"), JSON.stringify({ entries }));
    expect(readRegistry(dir, "llama")).toEqual([ok]);
  });

  it("a held lock keeps a fresh mtime, so a waiter never takes it over as stale", async () => {
    const dir = newDir();
    const lock = join(dir, "x.lock");
    await withAsyncLock(
      lock,
      async () => {
        const old = new Date(Date.now() - 3_600_000);
        utimesSync(lock, old, old);
        await new Promise((r) => setTimeout(r, 700));
        expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(1000);
      },
      200,
    );
  });
});

describe("a dead server never hangs its model's jobs (review C2)", () => {
  const mainPid = async (dir: string): Promise<number> => {
    const e = readRegistry(dir, "llama").find((x) => x.role === "main")!;
    const row = (await processSnapshot()).find((r) => r.pid === e.pid)!;
    expect(row.argv[0]).toMatch(/llama-server$/);
    return e.pid;
  };

  it("a server that died while idle is restarted by the next request", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1));
    process.kill(await mainPid(dir), "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const r = await runClient(dir, jobsOf(A, 2));
    expect(r.results.filter((x) => x.status !== 200)).toEqual([]);
    expect(spawnLines(dir)).toHaveLength(2);
  }, 300_000);

  it("a server that dies under a batch: the batch ends (no hang) and the rest is served by a restarted server", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1));
    const pid = await mainPid(dir);
    // Frozen first, so the batch is surely dispatched to it and still running
    // when it dies: on an idle machine 60 short jobs finished inside any fixed
    // delay, and the kill then hit an idle server (no restart, flaky).
    process.kill(pid, "SIGSTOP");
    const batch = runClient(dir, jobsOf(A, 60, { maxTokens: 120 }));
    await new Promise((r) => setTimeout(r, 1500));
    process.kill(pid, "SIGKILL");
    const r = await batch;
    expect(r.results.filter((x) => x.status === 200).length).toBeGreaterThan(0);
    expect(r.results.every((x) => x.status === 200 || /BrokerJobError|llama-server request failed/.test(x.error ?? ""))).toBe(true);
    expect(spawnLines(dir)).toHaveLength(2);
  }, 300_000);
});

describe("retry clock and walker classification (review M10, M11)", () => {
  it("M10: a call's broker queue time extends ITS deadline only; the shared clock is never changed", () => {
    const shared: RetryClock = {};
    const a = { brokerQueuedMs: 0 };
    const b = { brokerQueuedMs: 0 };
    const va = clockForCall(shared, a);
    const vb = clockForCall(shared, b);
    startRetryClock(va);
    const base = shared.deadlineAt!;
    expect(base).toBeGreaterThan(Date.now());
    // 64 slots each queued for 10 minutes: the shared deadline used to grow by the SUM.
    a.brokerQueuedMs = 600_000;
    b.brokerQueuedMs = 600_000;
    expect(shared.deadlineAt).toBe(base);
    expect(va.deadlineAt).toBe(base + 600_000);
    expect(vb.deadlineAt).toBe(base + 600_000);
    // Past the shared deadline: a call with no queue time is closed, the queued call is not.
    shared.deadlineAt = Date.now() - 1;
    expect(retryWindowClosed(clockForCall(shared, {}))).toBe(true);
    expect(retryWindowClosed(va)).toBe(false);
    // Writes go to the shared clock (one expiry flag for the dispatch, unchanged semantics).
    va.expired = true;
    expect(shared.expired).toBe(true);
    expect(retryWindowClosed(va)).toBe(true);
  });

  it("M11: a BrokerJobError quoting a network error marks only (URL, model) dead; other failures keep their kind", () => {
    expect(endpointFailureKind(new BrokerJobError("llama-server request failed: read ECONNRESET"), "read ECONNRESET")).toBe("endpoint-model");
    expect(endpointFailureKind(new BrokerUnavailableError("broker not reachable"), "broker not reachable")).toBe("endpoint");
    expect(endpointFailureKind(new ManagedServerError("spawn lock timeout"), "spawn lock timeout")).toBe("endpoint");
    expect(endpointFailureKind(new Error("fetch failed"), "fetch failed")).toBe("endpoint");
    expect(endpointFailureKind(new Error("HTTP 400 bad request"), "HTTP 400 bad request")).toBeNull();
  });
});

describe("broker identity and lifecycle (review M9, M3, M4, M5)", () => {
  const mainEntryOf = (dir: string) => readRegistry(dir, "llama").find((e) => e.role === "main")!;
  const waitGone = async (pid: number, ms: number): Promise<void> => {
    for (let i = 0; i < ms / 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  };

  it("M9: a state file naming a live process that is not a broker is stale: a new broker starts and serves", async () => {
    const dir = newDir();
    const foreign = foreignProcess();
    try {
      writeBrokerState(dir, "llama", { pid: foreign, port: 1, token: "x", version: "t1", startedAt: new Date().toISOString() });
      const r = await runClient(dir, jobsOf(A, 1));
      expect(r.results[0].status).toBe(200);
      expect(r.pid).not.toBe(foreign);
      expect(alive(foreign)).toBe(true);
    } finally {
      killQuietly(foreign);
    }
  }, 300_000);

  it("M9: a live broker that fails its health check gives BrokerUnavailableError after bounded retries, never a second broker", async () => {
    const dir = newDir();
    const first = await runClient(dir, jobsOf(A, 1));
    process.kill(first.pid, "SIGSTOP");
    try {
      const t0 = Date.now();
      await expect(runClient(dir, jobsOf(A, 1))).rejects.toThrow(/did not answer its health check 4 times; not starting a second broker/);
      expect(Date.now() - t0).toBeLessThan(60_000);
      expect(readBrokerState(dir, "llama")?.pid).toBe(first.pid);
      const listening = readFileSync(join(dir, "broker-llama.log"), "utf8").split("\n").filter((l) => l.includes(" listening on "));
      expect(listening).toHaveLength(1);
    } finally {
      process.kill(first.pid, "SIGCONT");
    }
  }, 300_000);

  it("M3: while the old broker drains, the new one retries the busy main slot about once per second, not in a loop", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1), {}, "t1");
    // Frozen, the old main ignores the drain's SIGTERM until the SIGKILL
    // escalation (STOP_GRACE_MS, 10 s), so the new broker surely waits for the
    // slot that long (a timed batch finished too fast on an idle machine).
    process.kill(mainEntryOf(dir).pid, "SIGSTOP");
    const next = await runClient(dir, jobsOf(B, 1), {}, "t2");
    expect(next.results[0].status).toBe(200);
    const lines = readFileSync(join(dir, "broker-llama.log"), "utf8").split("\n");
    const waitLine = lines.find((l) => l.includes("waiting for the main slot"));
    const freeLine = lines.find((l) => /main slot free after \d+ busy attempts/.test(l));
    expect(waitLine, "the handover never waited for the slot: the test did not exercise M3").toBeDefined();
    expect(freeLine).toBeDefined();
    const waitedS = (Date.parse(freeLine!.split(" ")[0]) - Date.parse(waitLine!.split(" ")[0])) / 1000;
    const tries = Number(/after (\d+) busy attempts/.exec(freeLine!)![1]);
    expect(tries).toBeLessThanOrEqual(Math.ceil(waitedS) + 2);
  }, 300_000);

  it("M4: requests arriving around an idle server stop are all served, by at most one main server", async () => {
    const dir = newDir();
    const env = { LLM_EXT_BROKER_IDLE_SERVER_MS: "1500", LLM_EXT_BROKER_IDLE_EXIT_MS: "120000" };
    await runClient(dir, jobsOf(A, 1), env);
    const w = watchMains(dir);
    // Separate client processes started across the idle-stop moment.
    const late = [1200, 1500, 1800, 2100, 2400].map((ms) => new Promise<ClientResult>((res, rej) => setTimeout(() => runClient(dir, jobsOf(A, 1), env).then(res, rej), ms)));
    const rs = await Promise.all(late);
    expect(w.stop()).toBeLessThanOrEqual(1);
    expect(rs.flatMap((r) => r.results).filter((x) => x.status !== 200)).toEqual([]);
    expect(readFileSync(join(dir, "broker-llama.log"), "utf8")).not.toMatch(/failed to start/);
  }, 300_000);

  it("M5: SIGTERM to the broker while its server is still loading leaves no llama-server behind", async () => {
    const dir = newDir();
    const client = runClient(dir, jobsOf(A, 1)).catch((e: Error) => e);
    let line: string | undefined;
    for (let i = 0; i < 600 && !line; i++) {
      line = spawnLines(dir)[0];
      if (!line) await new Promise((r) => setTimeout(r, 20));
    }
    const pid = Number(/pid (\d+)/.exec(line!)![1]);
    // Freeze the server so it can never become ready: the broker is held inside waitReady.
    process.kill(pid, "SIGSTOP");
    await new Promise((r) => setTimeout(r, 500));
    const log = (): string => readFileSync(join(dir, "broker-llama.log"), "utf8");
    expect(log()).not.toMatch(new RegExp(`ready: pid ${pid} `));
    const broker = readBrokerState(dir, "llama")!.pid;
    process.kill(broker, "SIGTERM");
    await waitGone(broker, 30_000);
    expect(alive(broker)).toBe(false);
    await client;
    expect((await processSnapshot()).filter((p) => p.pgid === pid)).toEqual([]);
  }, 300_000);
});

/** The environment of a live process of this user, as KEY=VALUE text (macOS `ps -E`, Linux /proc). */
function processEnvText(pid: number): string {
  if (process.platform === "linux") return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
  return execFileSync("ps", ["-E", "-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

describe("hardening and minors (review M13, m2, m5, m6, m7)", () => {
  const mainEntry = (dir: string) => readRegistry(dir, "llama").find((e) => e.role === "main")!;

  it("M13 + m7: the main server refuses a request without its per-spawn key, the key is not in its argv, and no client API key reaches it", async () => {
    const dir = newDir();
    const r = await runClient(dir, jobsOf(A, 1), { OPENROUTER_API_KEY: "sentinel-or-key-4711", LLAMA_API_KEY: "client-chosen-key" });
    expect(r.results[0].status).toBe(200);
    const e = mainEntry(dir);
    const res = await fetch(`http://127.0.0.1:${e.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: A, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    });
    await res.text();
    expect(res.status).toBe(401);
    const live = (await readCommandLine(e.pid))!;
    expect(live.join(" ")).not.toMatch(/api-key/);
    const env = processEnvText(e.pid);
    expect(env).not.toMatch(/sentinel-or-key-4711/);
    expect(env).not.toMatch(/client-chosen-key/);
    expect(env).toMatch(/LLAMA_API_KEY=[0-9a-f]{48}/);
  }, 300_000);

  it("m7: the llama-server environment is an allow-list with a fresh key", () => {
    const env = llamaServerEnv(
      { PATH: "/bin", HOME: "/h", LLAMA_CACHE: "/c", GGML_METAL: "1", LC_ALL: "C", OPENROUTER_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y", LLAMA_API_KEY: "old", LLAMA_ARG_API_KEY_FILE: "/k" },
      "k1",
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LLAMA_CACHE: "/c", GGML_METAL: "1", LC_ALL: "C", LLAMA_API_KEY: "k1" });
  });

  it("m2: a timeout above the Node timer limit is refused, never fired at once", () => {
    expect(extractTimeoutFlags([`--timeout=${MAX_TIMEOUT_S}`]).commandTimeoutS).toBe(2_147_483);
    expect(() => extractTimeoutFlags(["--timeout=2147484"])).toThrow(/at most 2147483 seconds/);
    expect(() => extractTimeoutFlags(["--command_timeout", "9".repeat(400)])).toThrow(/at most/);
    expect(() => extractTimeoutFlags(["--queue_timeout=99999999"])).toThrow(/at most/);
  });

  it("m5: a delivered job is forgotten at once (a second poll gets 404)", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1));
    const st = readBrokerState(dir, "llama")!;
    const base = `http://127.0.0.1:${st.port}`;
    const sub = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: st.token, [CTX_HEADER]: "1024", "content-type": "application/json" },
      body: JSON.stringify({ model: A, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: 4 }),
    });
    expect(sub.status).toBe(202);
    const { job } = (await sub.json()) as { job: string };
    let res: Response;
    do res = await fetch(`${base}/v1/jobs/${job}?wait=30`, { headers: { [TOKEN_HEADER]: st.token } });
    while (res.status === 204);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("done");
    await new Promise((r) => setTimeout(r, 100));
    const again = await fetch(`${base}/v1/jobs/${job}?wait=1`, { headers: { [TOKEN_HEADER]: st.token } });
    await again.text();
    expect(again.status).toBe(404);
  }, 300_000);

  it("m6: with a space in the config dir, the sweep still finds and stops an unrecorded main server", async () => {
    const parent = newDir();
    const dir = join(parent, "with space");
    dirs.push(dir);
    await runClient(dir, jobsOf(A, 1));
    const st = readBrokerState(dir, "llama")!;
    const orphan = mainEntry(dir);
    process.kill(st.pid, "SIGKILL");
    // Unrecorded: only the --log-file marker can find it now.
    rmSync(registryPath(dir, "llama"));
    await new Promise((r) => setTimeout(r, 300));
    const r = await runClient(dir, jobsOf(A, 1));
    expect(r.results[0].status).toBe(200);
    expect(readFileSync(join(dir, "broker-llama.log"), "utf8")).toMatch(new RegExp(`stopped unrecorded main llama-server pid ${orphan.pid} `));
    expect((await processSnapshot()).filter((p) => p.pgid === orphan.pgid)).toEqual([]);
  }, 300_000);

  it("m6: the marker matches the unsplit command line, never a longer name", () => {
    const m = "/a b/llama-server-main.log";
    expect(hasLogFileMarker(`llama-server -m x --log-file ${m}`, m)).toBe(true);
    expect(hasLogFileMarker(`llama-server --log-file ${m} --port 1`, m)).toBe(true);
    expect(hasLogFileMarker(`llama-server --log-file ${m}.1`, m)).toBe(false);
    expect(hasLogFileMarker(`llama-server --log-file /a`, m)).toBe(false);
  });
});

/**
 * A stand-in broker on loopback for the two client paths the real broker
 * cannot be made to take (a 500 or non-JSON poll reply, a slow 202): a real
 * HTTP server, the real client code. Runs LAST in the file: m1 calls
 * cancelAllBrokerJobs, which stops this process's client for good.
 */
describe("client against a misbehaving broker (review m4, m1)", () => {
  const serve = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ ep: BrokerEndpoint; close: () => Promise<void> }> => {
    const srv = createServer(handler);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    return {
      ep: { url: `http://127.0.0.1:${port}`, token: "t", pid: process.pid },
      close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
    };
  };
  const req = { body: JSON.stringify({ model: "m" }), model: "m", ctx: 0, timeoutMs: 5000 };

  it("m4: a poll reply other than 200/204/404, or one that is not a job result, is BrokerUnavailableError (endpoint)", async () => {
    for (const [status, body] of [[500, "boom"], [401, "{}"], [200, "not json"], [200, "{}"]] as const) {
      const s = await serve((rq, rs) => {
        if (rq.method === "POST") { rs.writeHead(202, { "content-type": "application/json" }); rs.end(JSON.stringify({ job: "j" })); return; }
        if (rq.method === "DELETE") { rs.writeHead(204); rs.end(); return; }
        rs.writeHead(status); rs.end(body);
      });
      try {
        const err = await brokerExchange(s.ep, req).then(() => null, (e: unknown) => e);
        expect(err, `${status} ${body}`).toBeInstanceOf(BrokerUnavailableError);
        expect(endpointFailureKind(err, (err as Error).message)).toBe("endpoint");
      } finally {
        await s.close();
      }
    }
  });

  it("m1: --command_timeout cancels a job whose POST was still in flight", async () => {
    const deleted: string[] = [];
    const s = await serve((rq, rs) => {
      if (rq.method === "POST") {
        setTimeout(() => { rs.writeHead(202, { "content-type": "application/json" }); rs.end(JSON.stringify({ job: "slow-job" })); }, 600);
        return;
      }
      if (rq.method === "DELETE") { deleted.push(rq.url ?? ""); rs.writeHead(204); rs.end(); return; }
      rs.writeHead(204, { [STATE_HEADER]: "queued" }); setTimeout(() => rs.end(), 200);
    });
    try {
      const call = brokerExchange(s.ep, req).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 100));
      const n = await cancelAllBrokerJobs("test stop");
      expect(n).toBe(1);
      expect(deleted).toContain("/v1/jobs/slow-job");
      expect(await call).toBeInstanceOf(Error);
    } finally {
      await s.close();
    }
  });
});

/**
 * P1' item 1: end to end through real llm-ext commands on a `server: managed`
 * profile, with HOME, LLM_EXT_CONFIG_DIR and LLM_EXT_INSTALL_RULE=0 in temp
 * dirs (the user's config is never read or written).
 *
 * Fixture: the tiny-llamas GGUFs declare llama.context_length = 128, and
 * llama-server caps every slot at the training context, so the ~710-token
 * prompt a real command sends cannot fit. The tests run on copies whose
 * context_length is patched (u32 metadata, same size, nothing else changed)
 * to 1024 / 2048, and each profile's context_window equals it. These models
 * never emit EOS, so every reply runs to its slot limit: every request fills a
 * whole context_window, which is what the slot-sizing test below relies on.
 * No request_options on the profiles:
 * with them a finish_reason=length reply is a hard OutputLimitError.
 */
describe("end to end through real llm-ext commands (P1' item 1)", () => {
  let cli: string;
  let modelsDir: string;
  const modelA = (): string => join(modelsDir, "ctx-stories15M-q4_0.gguf");
  const modelB = (): string => join(modelsDir, "ctx-stories260K.gguf");

  /** The cached `-hf` downloads of the two tiny models (LLAMA_CACHE layout: models--org--repo/snapshots/<rev>/<file>). */
  const cachedGguf = (file: string): string => {
    const repo = join(LLAMA_CACHE, "models--ggml-org--tiny-llamas", "snapshots");
    for (const rev of readdirSync(repo)) if (existsSync(join(repo, rev, file))) return join(repo, rev, file);
    throw new Error(`${file} is not in ${repo}`);
  };

  beforeAll(async () => {
    cli = await cliBundle();
    // Fill the model cache through the broker's own -hf path (CI starts empty).
    const warm = newDir();
    const r = await runClient(warm, [...jobsOf(A, 1), ...jobsOf(B, 1)]);
    expect(r.results.every((x) => x.status === 200)).toBe(true);
    modelsDir = mkdtempSync(join(tmpdir(), "llm-ext-broker-models-"));
    // stories260K has a 512-token vocabulary, so the same prompt is ~1,700 tokens there: it gets 2048-token slots.
    for (const [file, slot] of [["stories15M-q4_0.gguf", 1024], ["stories260K.gguf", 2048]] as const) {
      const b = readFileSync(realpathSync(cachedGguf(file)));
      const key = Buffer.from("llama.context_length");
      const at = b.indexOf(key);
      if (at < 0 || b.readUInt32LE(at + key.length) !== 4) throw new Error(`${file}: llama.context_length is not a u32`);
      b.writeUInt32LE(slot, at + key.length + 4);
      writeFileSync(join(modelsDir, `ctx-${file}`), b);
    }
  }, 600_000);
  afterAll(() => {
    if (modelsDir) rmSync(modelsDir, { recursive: true, force: true });
  });

  const writeSettings = (cfg: string): void => {
    // context_window = the patched training context: the broker gives each of its MAIN_SLOTS slots exactly this much.
    const profile = (model: string, ctx: number): string[] => [
      "    profile-type: local",
      "    mode: local",
      "    api: llamacpp-local",
      // The port binds nothing under the broker: the url is only the key the walker marks dead.
      "    url: http://127.0.0.1:18431",
      `    model: ${model}`,
      `    context_window: ${ctx}`,
      "    server: managed",
    ];
    writeFileSync(join(cfg, "settings.yaml"), ["active: tinya", "profiles:", "  tinya:", ...profile(modelA(), 1024), "  tinyb:", ...profile(modelB(), 2048), ""].join("\n"));
  };

  /** One real CLI command, in its own process; resolves with its exit code and output. */
  const runCli = (cfg: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        env: { ...process.env, HOME: cfg, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLAMA_CACHE },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c));
      child.stderr.on("data", (c: Buffer) => (out += c));
      const kill = setTimeout(() => child.kill("SIGKILL"), 240_000);
      child.on("exit", (code) => {
        clearTimeout(kill);
        resolve({ code, out });
      });
    });

  const brokerLog = (cfg: string): string[] => readFileSync(join(cfg, "broker-llama.log"), "utf8").split("\n");
  const dispatches = (cfg: string): Array<{ model: string; command: string }> =>
    brokerLog(cfg).flatMap((l) => {
      const m = /dispatch job \S+ model '([^']+)' command (\S+)/.exec(l);
      return m ? [{ model: m[1], command: m[2] }] : [];
    });
  const brokerHealth = async (cfg: string): Promise<{ queued: number; running: number }> => {
    const st = readBrokerState(cfg, "llama")!;
    const res = await fetch(`http://127.0.0.1:${st.port}/v1/health`, { headers: { [TOKEN_HEADER]: st.token } });
    return (await res.json()) as { queued: number; running: number };
  };
  const workDir = (files: number): { dir: string; src: string; files: string[] } => {
    const dir = newDir();
    const src = join(dir, "src");
    mkdirSync(src);
    const list = Array.from({ length: files }, (_, i) => join(src, `f${i + 1}.txt`));
    list.forEach((f, i) => writeFileSync(f, `Once upon a time there was cat number ${i + 1}.\n`));
    return { dir, src, files: list };
  };
  const reports = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []);

  it("llm ask (model B) and scan folder on 3 files (model A) run at once through one broker: replies via the broker, at most one main, nothing left queued", async () => {
    const cfg = newDir();
    writeSettings(cfg);
    const w = workDir(3);
    const mains = watchMains(cfg);
    const [ask, scan] = await Promise.all([
      runCli(cfg, ["--profile", "tinyb", "llm", "ask", w.files[0], "--instructions", "continue the story", "-o", join(w.dir, "ask")], w.dir),
      runCli(cfg, ["--profile", "tinya", "scan", "folder", w.src, "--instructions", "continue the story", "--answer_mode", "0", "-o", join(w.dir, "scan")], w.dir),
    ]);
    expect(mains.stop()).toBeLessThanOrEqual(1);
    expect(ask.code, ask.out).toBe(0);
    expect(scan.code, scan.out).toBe(0);
    expect(reports(join(w.dir, "ask"))).toHaveLength(1);
    expect(reports(join(w.dir, "scan"))).toHaveLength(3);
    const d = dispatches(cfg);
    expect(d.filter((x) => x.model === modelB()).length).toBeGreaterThanOrEqual(1);
    expect(d.filter((x) => x.model === modelA()).length).toBeGreaterThanOrEqual(3);
    expect(new Set(d.map((x) => x.command)).size).toBe(2);
    expect(spawnLines(cfg).some((l) => l.includes(modelA()))).toBe(true);
    expect(spawnLines(cfg).some((l) => l.includes(modelB()))).toBe(true);
    expect(await brokerHealth(cfg)).toMatchObject({ queued: 0, running: 0 });
  }, 600_000);

  it("slot sizing: MAIN_SLOTS concurrent requests that each fill a whole context_window all succeed, never a 500 (llama.cpp splits -c across slots)", async () => {
    const cfg = newDir();
    writeSettings(cfg);
    // 2 x MAIN_SLOTS files: the broker keeps every slot busy, each reply running to the slot limit.
    const w = workDir(2 * MAIN_SLOTS);
    const scan = await runCli(cfg, ["scan", "folder", w.src, "--instructions", "continue the story", "--answer_mode", "0", "-o", join(w.dir, "scan")], w.dir);
    expect(scan.code, scan.out).toBe(0);
    expect(scan.out).not.toMatch(/API error 500|Context size has been exceeded/);
    expect(reports(join(w.dir, "scan"))).toHaveLength(2 * MAIN_SLOTS);
    const main = readRegistry(cfg, "llama").find((e) => e.role === "main")!;
    const flag = (f: string): string => main.argv[main.argv.indexOf(f) + 1];
    expect(flag("-np")).toBe(String(MAIN_SLOTS));
    expect(flag("-c")).toBe(String(1024 * MAIN_SLOTS));
    expect(brokerLog(cfg).join("\n")).toMatch(new RegExp(`slots ${MAIN_SLOTS}\\b`));
    // Every reply filled its slot: the server log shows each task stopped at the full 1024-token context.
    const full = readFileSync(join(cfg, "llama-server-main.log"), "utf8").split("\n").filter((l) => /stop processing: n_tokens = 102[0-4]\b/.test(l));
    expect(full.length).toBeGreaterThanOrEqual(2 * MAIN_SLOTS);
  }, 600_000);

  it("--command_timeout on a multi-file command (spec 15, review m3): finished reports are written, unfinished files are listed, exit 124, nothing left queued", async () => {
    const cfg = newDir();
    writeSettings(cfg);
    const w = workDir(6);
    const out = join(w.dir, "scan");
    const scanP = runCli(cfg, ["--command_timeout=20", "scan", "folder", w.src, "--instructions", "continue the story", "--answer_mode", "0", "-o", out], w.dir);
    // Freeze the server once the first report is on disk: the rest can then never finish before the timeout.
    for (let i = 0; i < 300 && reports(out).length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    expect(reports(out).length).toBeGreaterThanOrEqual(1);
    const main = readRegistry(cfg, "llama").find((e) => e.role === "main")!.pid;
    process.kill(main, "SIGSTOP");
    let scan: { code: number | null; out: string };
    try {
      scan = await scanP;
    } finally {
      process.kill(main, "SIGCONT");
    }
    expect(scan.code, scan.out).toBe(124);
    const done = reports(out);
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done.length).toBeLessThan(6);
    // Every file is either finished (a report) or listed as unfinished, with the timeout as its reason.
    const unfinished = w.files.filter((f) => !done.some((r) => r.includes(`-${basename(f)}-`)));
    expect(unfinished.length).toBe(6 - done.length);
    for (const f of unfinished) expect(scan.out).toMatch(new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: --command_timeout`));
    expect(scan.out).toMatch(/--command_timeout: the command ran longer than 20 s and was stopped/);
    expect(await brokerHealth(cfg)).toMatchObject({ queued: 0, running: 0 });
  }, 600_000);
  it("chatCompletionJSON goes through the broker (check imports, whose extract step is a JSON-schema call)", async () => {
    const cfg = newDir();
    writeSettings(cfg);
    const w = workDir(1);
    const ts = join(w.src, "mod.ts");
    writeFileSync(ts, 'import { x } from "./missing.js";\nexport const y = x;\n');
    const r = await runCli(cfg, ["check", "imports", ts, "-o", join(w.dir, "out")], w.dir);
    // The story model never writes valid JSON, so only the route is asserted, not the verdict.
    expect(dispatches(cfg).length, r.out).toBeGreaterThanOrEqual(1);
    expect(await brokerHealth(cfg)).toMatchObject({ queued: 0, running: 0 });
  }, 600_000);

  it("broker SIGKILLed with jobs in flight: those requests fail, the retry starts a new broker that stops the orphaned main, and every file completes", async () => {
    const cfg = newDir();
    writeSettings(cfg);
    const w = workDir(3);
    const warm = await runCli(cfg, ["llm", "ask", w.files[0], "--instructions", "go on", "-o", join(w.dir, "warm")], w.dir);
    expect(warm.code, warm.out).toBe(0);
    const before = readBrokerState(cfg, "llama")!.pid;
    const orphan = readRegistry(cfg, "llama").find((e) => e.role === "main")!;
    // Frozen, so the scan's jobs are surely still running on it when the broker dies.
    process.kill(orphan.pid, "SIGSTOP");
    const seen = dispatches(cfg).length;
    const scanP = runCli(cfg, ["scan", "folder", w.src, "--instructions", "go on", "--answer_mode", "0", "-o", join(w.dir, "scan")], w.dir);
    // The broker dispatches at most MAIN_SLOTS at once; those are the jobs in flight when it dies.
    for (let i = 0; i < 300 && dispatches(cfg).length < seen + MAIN_SLOTS; i++) await new Promise((r) => setTimeout(r, 100));
    expect(dispatches(cfg).length).toBeGreaterThanOrEqual(seen + MAIN_SLOTS);
    process.kill(before, "SIGKILL");
    const scan = await scanP;
    expect(scan.code, scan.out).toBe(0);
    expect(scan.out).toMatch(/fetch failed — retrying/);
    expect(reports(join(w.dir, "scan"))).toHaveLength(3);
    expect(readBrokerState(cfg, "llama")!.pid).not.toBe(before);
    expect(brokerLog(cfg).join("\n")).toMatch(new RegExp(`stopped orphaned main llama-server pid ${orphan.pid}`));
    expect((await processSnapshot()).filter((p) => p.pgid === orphan.pgid)).toEqual([]);
    expect(await brokerHealth(cfg)).toMatchObject({ queued: 0, running: 0 });
  }, 600_000);
});
