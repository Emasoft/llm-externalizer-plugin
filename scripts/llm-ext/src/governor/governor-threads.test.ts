/**
 * governor/governor-threads.test.ts — the thread budget (design/specs/local-inference-governor-design.md D10, unit 5):
 * the pure rule (T per engine from the cores and cpu_limit_pct, the server_threads override checked against the budget,
 * 0 at cpu_limit_pct 100), the llama-server argv, a real cal server whose log reports n_threads = T, whose governor entry
 * carries T and whose calibration requests lease with T and its pid, a broker at cpu_limit_pct 100 with no -t, a
 * malformed or out-of-budget server_threads ending a broker or a calibration run at start, and burn-broker: 8 config
 * dirs, 8 real brokers on the tiny GGUF model of broker.test.ts, one governor directory. A 200 ms sampler reads every
 * inference lease and each server's -t from its recorded argv (an independent source): the T of the servers with a
 * request running never sum above the budget, every lease carries its server's T, a server counts once however many
 * of its leases run, at most one load runs at a time. Real processes, no mocks; assertions read recorded data.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordFixture } from "../calibration/test-record.js";
import { writeRecord } from "../calibration/record.js";
import { loadedIdentity, type LoadedIdentity } from "../calibration/fingerprint.js";
import { runCalibrator, startCalServer, type CalServer, type PhaseContext } from "../calibration/runner.js";
import { makeSender } from "../calibration/phase-a.js";
import { ensureBroker, type BrokerEndpoint } from "../broker/client.js";
import { COMMAND_HEADER, CTX_HEADER, ENGINE_HEADER, isBrokerProcess, readBrokerState, TIMEOUT_HEADER, TOKEN_HEADER } from "../broker/protocol.js";
import { readRegistry, roleLogFile } from "../broker/registry.js";
import { buildServerArgv, isLocalsServerArgv, processSnapshot } from "../local-llama-server.js";
import { tmpdir } from "../test-tmp-root.js";
import * as gov from "./client.js";
import { LOCALS_THREADS, resolveConfig, serverThreads, threadBudget } from "./controller.js";
import { coreCount } from "./metrics.js";
import { governorDir as stateDir, readState } from "./state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LLAMA_CACHE = "/tmp/llm-ext-llama-cache";
const A = "ggml-org/tiny-llamas/stories15M-q4_0.gguf";
const DEADLINE_MS = 180_000;
const TEST_MS = 400_000;
const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";\nconst require = __cjsCreateRequire(import.meta.url);\n`;
const ENTRY = `import { runBrokerMain } from "../broker/server.ts";\nawait runBrokerMain("t1");\n`;

interface Reply {
  state: string;
  status?: number;
  error?: string;
}

let workDir: string;
let bundle: string;
let governorDir: string;
const dirs: string[] = [];
const identities = new Map<string, LoadedIdentity>();
const savedEnv = { ...process.env };

const flagOf = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Limits that only the thread budget can bind: by default the CPU ceiling off (budget = every core), RAM out of reach. */
function governorEnv(serverThreadsValue: string, maxInferences = 8, cpuLimitPct = 100): void {
  process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT = String(cpuLimitPct);
  process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT = "99";
  process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "100";
  process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = String(maxInferences);
  process.env.LLM_EXT_GOVERNOR_SERVER_THREADS = serverThreadsValue;
}

async function withLlamaCache<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LLAMA_CACHE;
  process.env.LLAMA_CACHE = LLAMA_CACHE;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LLAMA_CACHE;
    else process.env.LLAMA_CACHE = saved;
  }
}

async function measure(model: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "llm-ext-govth-measure-"));
  try {
    await withLlamaCache(async () => {
      const s = await startCalServer(scratch, "llama", model, 1024, 1, () => undefined);
      try {
        identities.set(model, await loadedIdentity("llama", s.baseUrl, s.apiKey, model, scratch));
      } finally {
        await s.stop("measured");
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The inference leases this process held while the real calibration sender (phase-a makeSender) sent 3 requests to `s`,
 * read from the governor file every 2 ms (each request runs about 0.5 s on stories15M).
 */
async function calibrationLeases(s: CalServer): Promise<gov.Lease[]> {
  const ctx = { server: s, waitForTurn: async () => undefined } as unknown as PhaseContext;
  const send = makeSender(ctx, []);
  const seen: gov.Lease[] = [];
  const sampler = setInterval(() => {
    for (const l of gov.snapshot().leases) if (l.kind === "inference" && l.holder.pid === process.pid && !seen.some((x) => x.id === l.id)) seen.push(l);
  }, 2);
  try {
    for (let i = 0; i < 3; i++) {
      const reply = await send.chat([{ role: "user", content: "Once upon a time" }], { thinking: "off", maxTokens: 600, timeoutMs: 60_000 });
      expect(reply.status).toBe(200);
    }
  } finally {
    clearInterval(sampler);
  }
  return seen;
}

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-ext-govth-cfg-"));
  dirs.push(d);
  const id = identities.get(A)!;
  writeRecord(d, { ...recordFixture("llama", A), fingerprint: id.fingerprint, engine_version: id.engineVersion, engine_version_checked: id.engineVersion });
  return d;
}

const startBroker = (dir: string): Promise<BrokerEndpoint> => ensureBroker({ dir, version: "t1", entry: bundle, env: { ...process.env, LLAMA_CACHE } });

async function submit(ep: BrokerEndpoint, maxTokens: number): Promise<string> {
  const res = await fetch(`${ep.url}/v1/jobs`, {
    method: "POST",
    headers: { [TOKEN_HEADER]: ep.token, [ENGINE_HEADER]: "llama", [CTX_HEADER]: "1024", [COMMAND_HEADER]: "test", [TIMEOUT_HEADER]: "120000" },
    // ignore_eos (a llama-server extension): every job runs its full max_tokens. A story that ends early finishes inside the
    // 200 ms grant poll, and the servers then almost never overlap, so the budget would never be put to the test.
    body: JSON.stringify({ model: A, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: maxTokens, ignore_eos: true }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { job: string }).job;
}

async function outcome(ep: BrokerEndpoint, id: string): Promise<Reply> {
  for (;;) {
    const res = await fetch(`${ep.url}/v1/jobs/${id}?wait=5`, { headers: { [TOKEN_HEADER]: ep.token } });
    if (res.status === 204) continue;
    expect(res.status).toBe(200);
    return (await res.json()) as Reply;
  }
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

describe("the thread rule (pure)", () => {
  it("llama: half the budget rounded down, at least 1; server_threads overrides; cpu_limit_pct 100 with no override is 0", () => {
    expect(threadBudget(14, 85)).toBe(11);
    expect(serverThreads("llama", 14, 85, 0)).toBe(5);
    expect(serverThreads("llama", 8, 90, 0)).toBe(3);
    expect(serverThreads("llama", 3, 90, 0)).toBe(1);
    expect(serverThreads("llama", 1, 10, 0)).toBe(1);
    expect(serverThreads("llama", 14, 85, 3)).toBe(3);
    expect(serverThreads("llama", 14, 100, 0)).toBe(0);
    expect(serverThreads("llama", 14, 100, 4)).toBe(4);
  });

  it("Locals: the measured 2 capped at the budget, 0 at cpu_limit_pct 100; server_threads does not apply", () => {
    expect(LOCALS_THREADS).toBe(2);
    expect(serverThreads("locals", 14, 85, 0)).toBe(2);
    expect(serverThreads("locals", 14, 10, 0)).toBe(1);
    expect(serverThreads("locals", 14, 100, 0)).toBe(0);
    expect(serverThreads("locals", 14, 85, 7)).toBe(2);
  });

  it("server_threads from the env: unset or empty is 0, 1 to the budget is taken, anything else fails naming the variable", () => {
    // resolveConfig (unit 6) holds the rule unit 5 had in its own env reader; 16 cores at 50 % is a budget of 8.
    const at = (v?: string): number => resolveConfig(v === undefined ? { LLM_EXT_GOVERNOR_CPU_LIMIT_PCT: "50" } : { LLM_EXT_GOVERNOR_CPU_LIMIT_PCT: "50", LLM_EXT_GOVERNOR_SERVER_THREADS: v }, null, 16).serverThreads;
    expect(at()).toBe(0);
    expect(at("")).toBe(0);
    expect(at("0")).toBe(0);
    expect(at("5")).toBe(5);
    expect(at("8")).toBe(8);
    for (const bad of ["9", "-1", "1.5", "abc", " 3", "3 "]) expect(() => at(bad)).toThrow("LLM_EXT_GOVERNOR_SERVER_THREADS");
  });

  it("spawnThreads reads this process's env: the rule per engine; server_threads above the budget or malformed throws", () => {
    const saved = { cpu: process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT, st: process.env.LLM_EXT_GOVERNOR_SERVER_THREADS };
    try {
      process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT = "100";
      delete process.env.LLM_EXT_GOVERNOR_SERVER_THREADS;
      expect(gov.spawnThreads("llama")).toBe(0);
      expect(gov.spawnThreads("locals")).toBe(0);
      process.env.LLM_EXT_GOVERNOR_SERVER_THREADS = "1";
      expect(gov.spawnThreads("llama")).toBe(1);
      process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT = "50";
      delete process.env.LLM_EXT_GOVERNOR_SERVER_THREADS;
      const budget = threadBudget(coreCount(), 50);
      expect(gov.spawnThreads("llama")).toBe(Math.max(1, Math.floor(budget / 2)));
      expect(gov.spawnThreads("locals")).toBe(Math.min(LOCALS_THREADS, budget));
      process.env.LLM_EXT_GOVERNOR_SERVER_THREADS = String(budget + 1);
      expect(() => gov.spawnThreads("llama")).toThrow("LLM_EXT_GOVERNOR_SERVER_THREADS");
      expect(() => gov.spawnThreads("locals")).toThrow("LLM_EXT_GOVERNOR_SERVER_THREADS");
      process.env.LLM_EXT_GOVERNOR_SERVER_THREADS = "x";
      expect(() => gov.spawnThreads("llama")).toThrow("LLM_EXT_GOVERNOR_SERVER_THREADS");
    } finally {
      for (const [k, v] of [["LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", saved.cpu], ["LLM_EXT_GOVERNOR_SERVER_THREADS", saved.st]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("the argv carries -t T and -tb T for T above 0, and neither at 0", () => {
    const argv = buildServerArgv({ port: 1, model: "m", ctx: 0, threads: 3 }, ["-m", "/x.gguf"], "/l.log");
    expect(flagOf(argv, "-t")).toBe("3");
    expect(flagOf(argv, "-tb")).toBe("3");
    const bare = buildServerArgv({ port: 1, model: "m", ctx: 0, threads: 0 }, ["-m", "/x.gguf"], "/l.log");
    expect(bare).not.toContain("-t");
    expect(bare).not.toContain("-tb");
  });
});

describe("real llama-servers under the thread budget (the tiny GGUF model of broker.test.ts)", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "llm-ext-govth-bundle-"));
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
    // The identity measurement registers a cal server, so it needs a governor dir of its own, removed here.
    const measureGov = mkdtempSync(join(tmpdir(), "govth-"));
    process.env.LLM_EXT_GOVERNOR_DIR = measureGov;
    try {
      await measure(A);
    } finally {
      rmSync(measureGov, { recursive: true, force: true });
    }
  }, TEST_MS);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A name without the /llm[-_]?ext/ leak marker, as test-hermetic-config.ts does for its own.
    governorDir = mkdtempSync(join(tmpdir(), "govth-"));
    process.env.LLM_EXT_GOVERNOR_DIR = governorDir;
  });

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
      for (const [key, value] of Object.entries(savedEnv)) if (key.startsWith("LLM_EXT_GOVERNOR_")) process.env[key] = value;
      rmSync(governorDir, { recursive: true, force: true });
    }
  }, TEST_MS);

  it("a cal server: -t T in its argv and log, T on its entry, and every calibration request's lease carries T and its pid; no -t at cpu_limit_pct 100", async () => {
    const cases: Array<{ cpu: number; setting: string; t: number }> = [
      { cpu: 100, setting: "3", t: 3 },
      { cpu: 90, setting: "", t: Math.max(1, Math.floor(threadBudget(coreCount(), 90) / 2)) },
      { cpu: 100, setting: "", t: 0 },
    ];
    for (const c of cases) {
      governorEnv(c.setting, 8, c.cpu);
      const scratch = mkdtempSync(join(tmpdir(), "llm-ext-govth-cal-"));
      try {
        await withLlamaCache(async () => {
          const s = await startCalServer(scratch, "llama", A, 1024, 1, () => undefined);
          try {
            if (c.t > 0) {
              expect(flagOf(s.entry.argv, "-t")).toBe(String(c.t));
              expect(flagOf(s.entry.argv, "-tb")).toBe(String(c.t));
              expect(readFileSync(roleLogFile(scratch, "cal", "llama"), "utf8")).toMatch(new RegExp(`llama threadpool init, n_threads = ${c.t}\\n`));
            } else {
              // The CPU limit is disabled (D13): llama.cpp keeps its own default thread count.
              expect(s.entry.argv).not.toContain("-t");
              expect(s.entry.argv).not.toContain("-tb");
            }
            expect(readState(stateDir()).servers.find((e) => e.pid === s.entry.pid)?.threads).toBe(c.t);
            const leases = await calibrationLeases(s);
            expect(leases.length).toBeGreaterThan(0);
            expect(leases.filter((l) => l.threads !== c.t || l.serverPid !== s.entry.pid)).toEqual([]);
          } finally {
            await s.stop("tested");
          }
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }, TEST_MS);

  it("burn-broker: 8 brokers; the T of servers with a request running never sum above the budget, each lease carries its server's T", async () => {
    const cores = coreCount();
    // At cpu_limit_pct 100 the budget is every core. T = floor(cores / 2) lets two servers run at once and, from 4 cores
    // up, never a third (3 x T > cores): here only the thread budget can deny.
    const t = Math.max(1, Math.floor(cores / 2));
    governorEnv(String(t));
    const budget = threadBudget(cores, 100);
    const configs = Array.from({ length: 8 }, () => newDir());
    const tOf = new Map<number, number>();
    const lookup = (pid: number): number | undefined => {
      if (!tOf.has(pid)) {
        for (const d of configs) {
          const e = readRegistry(d, "llama").find((r) => r.pid === pid);
          const v = e ? flagOf(e.argv, "-t") : undefined;
          if (v !== undefined) tOf.set(pid, Number(v));
        }
      }
      return tOf.get(pid);
    };
    let peakSum = 0;
    let peakServers = 0;
    let loadsAtOnce = 0;
    let samples = 0;
    const faults: string[] = [];
    const sampler = setInterval(() => {
      const s = gov.snapshot();
      samples++;
      loadsAtOnce = Math.max(loadsAtOnce, s.leases.filter((l) => l.kind === "load").length);
      const busy = new Map<number, number>();
      for (const l of s.leases) {
        if (l.kind !== "inference") continue;
        const own = l.serverPid === null ? undefined : lookup(l.serverPid);
        if (own === undefined) faults.push(`lease ${l.id} on server ${l.serverPid} with no recorded -t`);
        else if (l.threads !== own) faults.push(`lease ${l.id} carries threads ${l.threads}, its server runs -t ${own}`);
        if (own !== undefined && l.serverPid !== null) busy.set(l.serverPid, own);
      }
      const sum = [...busy.values()].reduce((a, b) => a + b, 0);
      peakSum = Math.max(peakSum, sum);
      peakServers = Math.max(peakServers, busy.size);
    }, 200);
    let replies: Reply[];
    try {
      const eps = await Promise.all(configs.map((d) => startBroker(d)));
      await Promise.all(eps.map(async (ep) => outcome(ep, await submit(ep, 4))));
      const ids = await Promise.all(eps.map(async (ep) => ({ ep, ids: await Promise.all(Array.from({ length: 6 }, () => submit(ep, 800))) })));
      replies = await Promise.all(ids.flatMap(({ ep, ids: own }) => own.map((id) => outcome(ep, id))));
    } finally {
      clearInterval(sampler);
    }
    expect(replies.filter((r) => r.state !== "done" || r.status !== 200)).toEqual([]);
    expect(faults.slice(0, 5)).toEqual([]);
    expect(samples).toBeGreaterThan(10);
    expect(peakSum).toBeLessThanOrEqual(budget);
    expect(peakServers).toBeGreaterThanOrEqual(2);
    // Two servers ran at once: the budget (2 x T) admits them. Per-server counting is pinned by the real-governor-file test below.
    expect(loadsAtOnce).toBeLessThanOrEqual(1);
    for (const d of configs) {
      const main = readRegistry(d, "llama").find((e) => e.role === "main")!;
      expect(flagOf(main.argv, "-t")).toBe(String(t));
      expect(flagOf(main.argv, "-tb")).toBe(String(t));
      const serverLog = roleLogFile(d, "main", "llama");
      expect(existsSync(serverLog)).toBe(true);
      expect(readFileSync(serverLog, "utf8")).toMatch(new RegExp(`llama threadpool init, n_threads = ${t}\\n`));
      // The broker's ready line reports both, from the argv and from the server's own log.
      expect(readFileSync(join(d, "broker-local.log"), "utf8")).toMatch(new RegExp(`-t ${t}; [^\\n]*; n_threads = ${t};`));
    }
  }, TEST_MS);

  it("a server counts once however many of its leases run: a second server starts beside one holding 2 (real governor file)", async () => {
    // T = floor(cores / 2), budget = cores. Two leases on server A, then the first on server B: 2 x T within the budget
    // under per-server counting, 3 x T over it (from 4 cores up) if every lease counted. Leases through the real client
    // and state file, so the order is fixed. A broker-level sample cannot pin this: an idle broker at the head of the
    // queue is granted at once, so a server's gap between leases is usually shorter than any sampling interval.
    const t = Math.max(1, Math.floor(coreCount() / 2));
    governorEnv(String(t));
    const held: gov.Lease[] = [];
    try {
      for (const serverPid of [900_001, 900_001, 900_002]) held.push(await gov.acquire({ timeoutMs: 60_000, threads: t, serverPid }, { signal: AbortSignal.timeout(20_000) }));
      expect(gov.snapshot().threadsInUse).toBe(2 * t);
      expect(held.map((l) => l.threads)).toEqual([t, t, t]);
    } finally {
      for (const l of held) gov.release(l);
    }
  }, TEST_MS);
  it("cpu_limit_pct 100 with no server_threads: the broker's server gets no -t and its leases carry 0 (the CPU limit is disabled, D13)", async () => {
    governorEnv("");
    const d = newDir();
    const ep = await startBroker(d);
    const seen: number[] = [];
    const sampler = setInterval(() => {
      for (const l of gov.snapshot().leases) if (l.kind === "inference") seen.push(l.threads);
    }, 20);
    let replies: Reply[];
    try {
      await outcome(ep, await submit(ep, 4));
      const ids = await Promise.all(Array.from({ length: 4 }, () => submit(ep, 800)));
      replies = await Promise.all(ids.map((id) => outcome(ep, id)));
    } finally {
      clearInterval(sampler);
    }
    expect(replies.filter((r) => r.state !== "done" || r.status !== 200)).toEqual([]);
    const main = readRegistry(d, "llama").find((e) => e.role === "main")!;
    expect(main.argv).not.toContain("-t");
    expect(main.argv).not.toContain("-tb");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((t) => t !== 0)).toEqual([]);
  }, TEST_MS);

  it("a malformed server_threads ends the broker at start, naming the variable, before any server is spawned (round 2 M5)", async () => {
    governorEnv("x");
    const d = newDir();
    await expect(startBroker(d)).rejects.toThrow(/did not start/);
    // Unit 6: the throw is a GovernorConfigError (its own name, so calibration keeps it off the crash path), logged by name.
    expect(readFileSync(join(d, "broker-local.log"), "utf8")).toMatch(/broker failed: GovernorConfigError: LLM_EXT_GOVERNOR_SERVER_THREADS must be an integer/);
    expect(readRegistry(d, "llama")).toEqual([]);
  }, TEST_MS);

  it("a server_threads above the budget ends a calibration run at start, before it claims the dir or writes anything (round 2 M5)", async () => {
    governorEnv(String(threadBudget(coreCount(), 100) + 1));
    const d = mkdtempSync(join(tmpdir(), "llm-ext-govth-calrun-"));
    dirs.push(d);
    await expect(runCalibrator({ dir: d, version: "t1", log: () => undefined, phases: [] })).rejects.toThrow("LLM_EXT_GOVERNOR_SERVER_THREADS");
    expect(readdirSync(d)).toEqual([]);
  }, TEST_MS);

  it("a running broker whose settings.yaml is made malformed fails its jobs with the GovernorConfigError, and runs them once it is fixed (review m7)", async () => {
    governorEnv("");
    const d = newDir();
    const settings = join(d, "settings.yaml");
    writeFileSync(settings, "local_governor:\n  max_inferences: 8\n");
    // Its own config dir, so the settings.yaml it re-reads is this one (the env limits of governorEnv still win; a
    // malformed section fails whatever the env says, governor/settings.ts).
    const ep = await ensureBroker({ dir: d, version: "t1", entry: bundle, env: { ...process.env, LLAMA_CACHE, LLM_EXT_CONFIG_DIR: d } });
    const ok = await outcome(ep, await submit(ep, 4));
    expect(ok.state).toBe("done");
    writeFileSync(settings, "local_governor:\n  ram_limit_pct: 10\n");
    const at = Date.now() / 1000 + 1;
    utimesSync(settings, at, at);
    const bad = await outcome(ep, await submit(ep, 4));
    expect(bad.state).toBe("failed");
    // The text of the GovernorConfigError settings.ts raises for this file, as govLease hands it to the job.
    expect(bad.error).toContain(`the local inference governor failed: ${settings}: local_governor.ram_limit_pct must be an integer from 50 to 99, got 10`);
    writeFileSync(settings, "local_governor:\n  max_inferences: 8\n");
    utimesSync(settings, at + 1, at + 1);
    const fixed = await outcome(ep, await submit(ep, 4));
    expect(fixed).toMatchObject({ state: "done", status: 200 });
  }, TEST_MS);
});
