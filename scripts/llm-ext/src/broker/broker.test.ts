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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "../test-tmp-root.js";
import { extractTimeoutFlags } from "../cli/timeout-flags.js";
import { Scheduler, queueKey, DEFAULT_TIMINGS, type Job } from "./scheduler.js";
import { readBrokerState, TOKEN_HEADER } from "./protocol.js";
import { claimAndSpawn, readRegistry, registryPath, roleLogFile, stopOwnServer } from "./registry.js";
import { processSnapshot, readCommandLine, SPAWN_MARKER, stopProcessGroup, withAsyncLock } from "../local-llama-server.js";

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
  for (const row of await processSnapshot()) {
    if (row.argv.some((t) => t.startsWith(dir)) || readRegistry(dir, "llama").some((e) => e.pgid === row.pgid)) {
      try {
        process.kill(-row.pgid, "SIGKILL");
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

afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
}, 60_000);

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
  void (async () => {
    while (on) {
      const n = (await processSnapshot()).filter((r) => r.argv[r.argv.indexOf("--log-file") + 1] === marker && r.argv.indexOf("--log-file") >= 0).length;
      max = Math.max(max, n);
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  return {
    stop: () => {
      on = false;
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
  it("forces a rotation at the EARLIEST passed per-job deadline, not before", () => {
    const s = new Scheduler();
    s.startRun(queueKey("a", 0), 0);
    s.enqueue(job("a", "c1", 0));
    s.enqueue(job("b", "c2", 0, 10_000));
    s.enqueue(job("c", "c3", 5, 1_000));
    const t = { ...DEFAULT_TIMINGS, batch: 1000, maxRunMs: 1e9 };
    expect(s.wantRotation(500, 1, t)).toBeNull();
    expect(s.wantRotation(2_000, 1, t)).toBe(queueKey("c", 0));
  });
  it("rotates after B requests when another model has work", () => {
    const s = new Scheduler();
    s.startRun(queueKey("a", 0), 0);
    s.enqueue(job("a", "c1", 0));
    s.enqueue(job("b", "c2", 0));
    const t = { ...DEFAULT_TIMINGS, batch: 2 };
    s.servedInRun = 1;
    expect(s.wantRotation(1, 1, t)).toBeNull();
    s.servedInRun = 2;
    expect(s.wantRotation(1, 1, t)).toBe(queueKey("b", 0));
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
    const env = { LLM_EXT_BROKER_BATCH: "1000", LLM_EXT_BROKER_STARVE_MS: "600000" };
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

  it("rotates after B requests, and a short --queue_timeout forces an earlier rotation than the default", async () => {
    const dir = newDir();
    const env = { LLM_EXT_BROKER_BATCH: "1000", LLM_EXT_BROKER_STARVE_MS: "600000" };
    await runClient(dir, jobsOf(A, 1), env);
    const longA = jobsOf(A, 40, { maxTokens: 120 });
    // Default queue timeout: B waits until A's queue is empty.
    const [a1, b1] = await Promise.all([runClient(dir, longA, env), runClient(dir, jobsOf(B, 1, { delayMs: 100 }), env)]);
    expect([...a1.results, ...b1.results].filter((r) => r.status !== 200)).toEqual([]);
    expect(b1.results[0].at).toBeGreaterThanOrEqual(Math.max(...a1.results.map((r) => r.at)));
    // A 1 s queue timeout on B's job: rotation is forced while A still has work.
    const [a2, b2] = await Promise.all([runClient(dir, longA, env), runClient(dir, jobsOf(B, 1, { delayMs: 100, queueTimeoutMs: 1000 }), env)]);
    expect(b2.results[0].status).toBe(200);
    expect(b2.results[0].at).toBeLessThan(Math.max(...a2.results.map((r) => r.at)));
    // B = 2 (a fresh broker reads the new value): B is served after two of A's requests at most.
    const dir2 = newDir();
    const envB = { LLM_EXT_BROKER_BATCH: "2", LLM_EXT_BROKER_STARVE_MS: "600000" };
    await runClient(dir2, jobsOf(A, 1), envB);
    const [a3, b3] = await Promise.all([runClient(dir2, longA, envB), runClient(dir2, jobsOf(B, 1, { delayMs: 100 }), envB)]);
    expect([...a2.results, ...a3.results, ...b3.results].filter((r) => r.status !== 200)).toEqual([]);
    expect(b3.results[0].at).toBeLessThan(Math.max(...a3.results.map((r) => r.at)));
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
    // 80 jobs: A must still be busy when the abandon rule fires 1.5 s after B's submit, or an idle server would take B first.
    const busy = runClient(dir, jobsOf(A, 80, { maxTokens: 120 }), env);
    // Long enough for the busy client to have its jobs queued, so B never finds an idle server to rotate in.
    await new Promise((r) => setTimeout(r, 1500));
    const abandoned = await submit(B);
    const cancelled = await submit(B);
    await fetch(`http://127.0.0.1:${st.port}/v1/jobs/${cancelled}`, { method: "DELETE", headers: h });
    await busy;
    await new Promise((r) => setTimeout(r, 2500));
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
    const [a, b] = await Promise.all([runClient(dir, jobsOf(A, 40, { maxTokens: 120 }), env), runClient(dir, jobsOf(B, 1, { delayMs: 50 }), env)]);
    expect([...a.results, ...b.results].filter((r) => r.status !== 200)).toEqual([]);
    // B waited for A's whole queue, far longer than one 1 s poll window, and still completed.
    expect(b.results[0].at - Math.min(...a.results.map((r) => r.at))).toBeGreaterThan(1000);
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

// Ensure the bundled CLI (not stale dist) accepts the global flags on a generic and a classify command.
describe("global timeout flags through the real CLI entry", () => {
  let cli: string;
  let cliDir: string;
  afterAll(() => rmSync(cliDir, { recursive: true, force: true }));
  beforeAll(async () => {
    // Under the package node_modules (a gitignored cache), not /tmp: the bundle keeps better-sqlite3 external, and an ESM import resolves it only from a node_modules folder above the importing file.
    cliDir = mkdtempSync(join(HERE, "..", "..", "node_modules", ".cache-llm-ext-broker-cli-"));
    cli = join(cliDir, "llm-ext.mjs");
    await build({
      entryPoints: [join(HERE, "..", "cli", "main.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: `import { createRequire as __cjsCreateRequire } from "node:module";\nimport { fileURLToPath as __cjsFileURLToPath } from "node:url";\nimport { dirname as __cjsDirname } from "node:path";\nconst require = __cjsCreateRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);\n` },
      external: [...nodeExternals, "better-sqlite3"],
      outfile: cli,
    });
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
    const batch = runClient(dir, jobsOf(A, 60, { maxTokens: 120 }));
    await new Promise((r) => setTimeout(r, 1200));
    process.kill(pid, "SIGKILL");
    const r = await batch;
    expect(r.results.filter((x) => x.status === 200).length).toBeGreaterThan(0);
    expect(r.results.every((x) => x.status === 200 || /BrokerJobError|llama-server request failed/.test(x.error ?? ""))).toBe(true);
    expect(spawnLines(dir)).toHaveLength(2);
  }, 300_000);
});
