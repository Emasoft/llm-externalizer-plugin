/**
 * broker.test.ts — the local-model broker, real and unmocked (TRDD-1OOAH3LD,
 * TRDD-ZGSGGHQG; spec point 14). A real llama-server serves two tiny GGUF models
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
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { builtinModules } from "node:module";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "../test-tmp-root.js";
import { extractTimeoutFlags, MAX_TIMEOUT_S } from "../cli/timeout-flags.js";
import { Scheduler, queueKey, DEFAULT_TIMINGS, type Job } from "./scheduler.js";
import { BROKER_ARGV, CALIBRATE_ARGV, calibratorStatePath, CTX_HEADER, ENGINE_HEADER, isBrokerProcess, isCalibratorProcess, readBrokerState, readCalibratorState, STATE_HEADER, TOKEN_HEADER, writeBrokerState } from "./protocol.js";
import { claimAndSpawn, hasLogFileMarker, readRegistry, registryPath, roleLogFile, stopOwnServer, sweepEngine, SlotBusyError } from "./registry.js";
import { FIXTURE_VERSION, HARNESS_VERSION, PRODUCTION_HARNESS_ID, readRecord, recordPath, writeRecord } from "../calibration/record.js";
import { recordFixture } from "../calibration/record-fixture.js";
import { loadedIdentity, type LoadedIdentity } from "../calibration/fingerprint.js";
import { calibratorLogPath, startCalServer } from "../calibration/runner.js";
import { enqueueUnlocked, loadProgress, progressPath, readQueue, saveProgress, withStateLock, type TrialRecord } from "../calibration/state.js";
import { freePort, isLocalsServerArgv, isPythonPath, llamaServerEnv, MAIN_SLOTS, ManagedServerError, parseManagedModel, processSnapshot, readCommandLine, spawnLlamaServer, SPAWN_MARKER, stopProcessGroup, withAsyncLock } from "../local-llama-server.js";
import { brokerExchange, BrokerJobError, BrokerUnavailableError, cancelAllBrokerJobs, endpointFailureKind, type BrokerEndpoint } from "./client.js";
import { buildLocalsArgv, hasLocalsMarker, LOCALS_MAIN_SLOTS, localsOutgoingModel, localsPython, parseLocalsModel, waitLocalsReady } from "../local-locals-server.js";
import { localsModelErrors, localsPlatformSupported } from "../config.js";
import { clockForCall, retryWindowClosed, startRetryClock, type RetryClock } from "../provider/http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LLAMA_CACHE = "/tmp/llm-ext-llama-cache";
const A = "ggml-org/tiny-llamas/stories15M-q4_0.gguf";
const B = "ggml-org/tiny-llamas/stories260K.gguf";
const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";\nconst require = __cjsCreateRequire(import.meta.url);\n`;

// One bundle is both the broker (`__broker`) and a client: the client's
// default broker entry is the bundle it runs from, exactly as dist/llm-ext.js
// in production.
const ENTRY = `
import { runBrokerMain } from "./server.ts";
import { runCalibratorMain } from "../calibration/runner.ts";
import { phaseA } from "../calibration/phase-a.ts";
import { setBrokerClientVersion, ensureBroker, brokerExchange, cancelAllBrokerJobs } from "./client.ts";
const [mode, arg] = process.argv.slice(2);
if (mode === "__broker") {
  await runBrokerMain(process.env.TEST_BROKER_VERSION ?? "t1");
} else if (mode === "__calibrate") {
  // The phase list a test selects by env (the runner inherits the broker's env):
  // TEST_SLOW_PHASE: a phase "A" that records one trial and then waits, so a test can SIGKILL the runner mid-model; resumed, it passes.
  // TEST_PHASE_A: the real Phase A. TEST_PASS_PHASE_A: a phase "A" that records one trial and passes.
  const env = process.env;
  const phases = env.TEST_SLOW_PHASE === "1"
    ? [{ name: "A", run: async (ctx) => {
        if (ctx.progress.trials.length === 0) {
          ctx.record({ step: "A/test", seed: 1, outcome: "pass", at: new Date().toISOString() });
          await new Promise((r) => setTimeout(r, 600000));
        }
        return { passed: true };
      } }]
    : env.TEST_PHASE_A === "1"
      ? [phaseA]
      : env.TEST_PASS_PHASE_A === "1"
        ? [{ name: "A", run: async (ctx) => {
            ctx.record({ step: "A/stub", seed: 1, outcome: "pass", at: new Date().toISOString() });
            return { passed: true };
          } }]
        : [];
  await runCalibratorMain(env.TEST_BROKER_VERSION ?? "t1", phases);
} else {
  const spec = JSON.parse(arg);
  setBrokerClientVersion(spec.version);
  const ep = await ensureBroker({ dir: spec.dir, version: spec.version });
  // P6: stopAfterMs plays --command_timeout (the same cancelAllBrokerJobs the CLI runs on expiry).
  let stopped = null;
  if (spec.stopAfterMs) setTimeout(() => void cancelAllBrokerJobs("--command_timeout (test)").then((s) => (stopped = s)), spec.stopAfterMs);
  const results = await Promise.all(spec.jobs.map(async (j, i) => {
    await new Promise((r) => setTimeout(r, j.delayMs ?? 0));
    const body = JSON.stringify({ model: j.model, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: j.maxTokens ?? 4 });
    try {
      // P6: reconnect as index.ts does, so a held job a broker gave back is resubmitted to the current broker.
      const res = await brokerExchange(ep, { engine: j.engine ?? "llama", body, model: j.model, ctx: 1024, timeoutMs: 120000, queueTimeoutMs: j.queueTimeoutMs }, { reconnect: () => ensureBroker({ dir: spec.dir, version: spec.version, fresh: true }) });
      await res.text();
      return { i, model: j.model, status: res.status, at: Date.now() };
    } catch (e) {
      return { i, model: j.model, error: String(e.message), at: Date.now() };
    }
  }));
  await new Promise((r) => setTimeout(r, spec.stopAfterMs ? 500 : 0));
  process.stdout.write(JSON.stringify({ pid: ep.pid, results, stopped }) + "\\n");
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
  // P6: the identities newDir's records carry (the GGUFs are downloaded into LLAMA_CACHE here on a fresh machine).
  for (const m of [A, B]) await measure("llama", m);
}, 300_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * P6 (spec section 2): the broker HOLDS a job for a managed model with no
 * complete calibration record. Tests that need the model served write a real
 * record for it (there is no bypass switch).
 */
function markCalibrated(dir: string, engine: "llama" | "locals", model: string): void {
  const id = identities.get(`${engine}\u0000${model}`);
  if (!id) throw new Error(`markCalibrated: measure ${engine} '${model}' first (its record must name the weights and engine build really loaded)`);
  writeRecord(dir, { ...recordFixture(engine, model), fingerprint: id.fingerprint, engine_version: id.engineVersion, engine_version_checked: id.engineVersion });
}

/**
 * P6 (review F3): the broker checks that a record names what a main server
 * really loaded (weights blob, RAM, engine build). Test records therefore
 * carry the identity measured from a real server of the same model, started
 * once here as a cal server in a scratch dir and stopped.
 */
const identities = new Map<string, LoadedIdentity>();
async function measure(engine: "llama" | "locals", model: string): Promise<LoadedIdentity> {
  const key = `${engine}\u0000${model}`;
  const known = identities.get(key);
  if (known) return known;
  const scratch = mkdtempSync(join(tmpdir(), "llm-ext-broker-measure-"));
  const saved = { LLAMA_CACHE: process.env.LLAMA_CACHE, HOME: process.env.HOME };
  process.env.LLAMA_CACHE = LLAMA_CACHE;
  // A Locals server never sees the user's ~/.locals: HOME is the scratch dir, as in every Locals test.
  if (engine === "locals") process.env.HOME = scratch;
  try {
    const s = await startCalServer(scratch, engine, model, 1024, 1, () => undefined);
    try {
      const id = await loadedIdentity(engine, s.baseUrl, s.apiKey, model, scratch);
      identities.set(key, id);
      return id;
    } finally {
      await s.stop("measured");
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A config dir whose test models (A, B, LOCALS_MODEL) are calibrated; cleaned up in afterEach. */
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-ext-broker-cfg-"));
  dirs.push(d);
  for (const m of [A, B]) markCalibrated(d, "llama", m);
  if (identities.has(`locals\u0000${LOCALS_MODEL}`)) markCalibrated(d, "locals", LOCALS_MODEL);
  return d;
}

/** Stop every process a test left: the broker (SIGTERM, then SIGKILL), every registry pgid, every process carrying this dir's marker. */
async function cleanup(dir: string): Promise<void> {
  // P6 (review F1): clients go FIRST. A client whose broker dies reconnects and
  // starts a new broker (whose argv does not name the dir), which then outlived
  // the test: the broker idle-exits only after 2 h. Clients name the dir in
  // their argv (the job spec / the CLI paths); servers are left to the pgid pass below.
  for (const row of await processSnapshot()) {
    if (row.pid === process.pid || !row.command.includes(dir)) continue;
    if (basename(row.argv[0] ?? "") === "llama-server" || isLocalsServerArgv(row.argv)) continue;
    killQuietly(row.pid);
  }
  // P6: a calibration runner this dir's broker started (`node <bundle> __calibrate`: its argv does not name the dir).
  const runner = readCalibratorState(dir);
  if (runner && (await isCalibratorProcess(runner.pid))) {
    try {
      process.kill(runner.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    for (let i = 0; i < 50 && alive(runner.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (await isCalibratorProcess(runner.pid)) killQuietly(runner.pid);
  }
  const st = readBrokerState(dir);
  // Follow-up review m7: a state-file pid is signalled only while it is STILL a
  // broker: the broker may have exited and its pid been reused by an unrelated process.
  if (st && (await isBrokerProcess(st.pid))) {
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
    if (await isBrokerProcess(st.pid)) {
      try {
        process.kill(st.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  const rows = await processSnapshot();
  // NEVER signal this runner's own process group: a CLI child the test spawned
  // (not detached) shares it, and `kill(-pgid)` on such a child killed vitest
  // and the shell running it. Those children are killed by pid instead.
  // Follow-up review m8: without our own pgid that guard is blind, so fail loudly.
  const ownPgid = rows.find((r) => r.pid === process.pid)?.pgid;
  if (ownPgid === undefined) throw new Error(`cleanup: this test runner (pid ${process.pid}) is not in the process snapshot; refusing to signal any group`);
  const registryPgids = new Set([...readRegistry(dir, "llama"), ...readRegistry(dir, "locals")].map((e) => e.pgid));
  // Follow-up review m7: a registry pgid alone is not proof (pgids are reused):
  // only a llama-server or a broker in it is signalled. A process carrying this
  // test's unique dir in its argv is this test's own by construction.
  const isServerOrBroker = (argv: readonly string[]): boolean => basename(argv[0] ?? "") === "llama-server" || isLocalsServerArgv(argv) || argv.includes(BROKER_ARGV);
  for (const row of rows) {
    // A Locals server names this dir only inside its -X marker token, so the unsplit command line is searched, not argv prefixes.
    const ownsDir = row.command.includes(dir);
    if (ownsDir || (registryPgids.has(row.pgid) && isServerOrBroker(row.argv))) {
      try {
        if (row.pgid === ownPgid || row.pgid <= 1) process.kill(row.pid, "SIGKILL");
        else process.kill(-row.pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  const left = (await processSnapshot()).filter((r) => r.command.includes(dir));
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
  /** P6: what cancelAllBrokerJobs reported when stopAfterMs fired (null when it did not). */
  stopped?: { cancelled: number; failed: string[] } | null;
}

/**
 * Every client run is bounded (default 240 s; `limitMs` raises it): a hang (a
 * job held with nothing to release it) fails the test with the client's
 * output instead of blocking the whole run. The client is SIGKILLed.
 */
function runClient(dir: string, jobs: object[], env: Record<string, string> = {}, version = "t1", extra: { stopAfterMs?: number; limitMs?: number } = {}): Promise<ClientResult> {
  const { limitMs = 240_000, ...spec } = extra;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, "client", JSON.stringify({ dir, version, jobs, ...spec })], {
      env: { ...process.env, LLAMA_CACHE, LLM_EXT_CONFIG_DIR: dir, TEST_BROKER_VERSION: version, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`client still running after ${limitMs} ms (killed): ${err}`));
    }, limitMs);
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`client exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim().split("\n").pop()!) as ClientResult);
    });
  });
}

const spawnLines = (dir: string): string[] => {
  const log = join(dir, "broker-local.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes(SPAWN_MARKER)) : [];
};

/** Count, over the whole run, the most main servers of this dir alive at once, llama-server and Locals together (process snapshots every 200 ms). */
function watchMains(dir: string): { stop: () => number } {
  let max = 0;
  let on = true;
  const marker = roleLogFile(dir, "main", "llama");
  const localsMarker = roleLogFile(dir, "main", "locals");
  let failure: unknown = null;
  // Caught and rethrown at stop(): a failed snapshot must fail THIS test, not surface as an unhandled rejection later.
  void (async () => {
    while (on) {
      const n = (await processSnapshot()).filter(
        (r) => (r.argv.indexOf("--log-file") >= 0 && r.argv[r.argv.indexOf("--log-file") + 1] === marker) || hasLocalsMarker(r.command, localsMarker),
      ).length;
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
    key: queueKey(model, 0, "llama"),
    engine: "llama",
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
    const order = [s.take(queueKey("m", 0, "llama"))!, s.take(queueKey("m", 0, "llama"))!].map((j) => j.commandId);
    expect(order).toEqual(["big", "small"]);
  });
  const T0 = { ...DEFAULT_TIMINGS, batch: 2, minRunMs: 1e9, lingerMs: 1000, defaultLoadMs: 5_000 };
  /** A scheduler whose current model "a" was loaded at t=0 with `queued` jobs of its own. */
  const running = (queued: number): Scheduler => {
    const s = new Scheduler();
    for (let i = 0; i < queued; i++) s.enqueue(job("a", "c1", i));
    s.startRun(queueKey("a", 0, "llama"), 0);
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
    expect(s.wantRotation(16_000, 1, T0)).toBe(queueKey("c", 0, "llama"));
    // A measured load time moves "near": c loading in 1 s is not due at 16 s.
    s.recordLoad(queueKey("c", 0, "llama"), 1_000);
    expect(s.wantRotation(16_000, 1, T0)).toBeNull();
    expect(s.wantRotation(19_500, 1, T0)).toBe(queueKey("c", 0, "llama"));
  });
  it("D also completes the minimum slice", () => {
    const s = running(10);
    s.enqueue(job("b", "c2", 0, 1));
    expect(s.wantRotation(5_000, 1, { ...T0, batch: 1000, minRunMs: 6_000 })).toBeNull();
    expect(s.wantRotation(6_000, 1, { ...T0, batch: 1000, minRunMs: 6_000 })).toBe(queueKey("b", 0, "llama"));
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
    expect(s.wantRotation(11_000, 0, T0)).toBe(queueKey("b", 0, "llama"));
  });
  it("review C1: two models with overdue jobs never swap without serving (the new model gets its slice first)", () => {
    const s = new Scheduler();
    for (let i = 0; i < 5; i++) s.enqueue(job("a", "c1", 0, 1));
    for (let i = 0; i < 5; i++) s.enqueue(job("b", "c2", 0, 1));
    s.startRun(queueKey("b", 0, "llama"), 10_000);
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
    // P6: calibrated on paper, so the job is queued and its start failure is what is tested (uncalibrated, it would be held).
    writeRecord(dir, recordFixture("llama", bad));
    const r = await runClient(dir, [{ model: bad }, { model: A, delayMs: 50 }]);
    expect(r.results[0].error).toMatch(/BrokerJobError|failed|exited/);
    expect(r.results[1].status).toBe(200);
  }, 300_000);

  it("an abandoned job and a cancelled job never run", async () => {
    const dir = newDir();
    const env = { LLM_EXT_BROKER_ABANDON_MS: "1500", LLM_EXT_BROKER_BATCH: "1000", LLM_EXT_BROKER_STARVE_MS: "600000" };
    await runClient(dir, jobsOf(A, 1), env);
    const st = readBrokerState(dir)!;
    const h = { [TOKEN_HEADER]: st.token, [ENGINE_HEADER]: "llama", "content-type": "application/json" };
    const submit = async (model: string): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${st.port}/v1/jobs`, { method: "POST", headers: h, body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }], max_tokens: 2 }) });
      return ((await res.json()) as { job: string }).job;
    };
    // Keep A busy so B's jobs stay queued, then never poll one and cancel the other.
    // A's server is FROZEN once the batch is on it: a timed batch finished too
    // fast on an idle machine, the server went idle and B was rotated in.
    const dispatched = (): number => readFileSync(join(dir, "broker-local.log"), "utf8").split("\n").filter((l) => l.includes("dispatch job")).length;
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
    const st = readBrokerState(dir)!;
    const orphan = readRegistry(dir, "llama").find((e) => e.role === "main")!;
    process.kill(st.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const r = await runClient(dir, jobsOf(B, 1));
    expect(r.results[0].status).toBe(200);
    expect(r.pid).not.toBe(st.pid);
    expect((await processSnapshot()).filter((p) => p.pgid === orphan.pgid)).toEqual([]);
    expect(readFileSync(join(dir, "broker-local.log"), "utf8")).toMatch(new RegExp(`stopped orphaned main llama-server pid ${orphan.pid}`));
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
    expect(readBrokerState(dir)?.version).toBe("t2");
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
    expect(readBrokerState(dir)).toBeNull();
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
    const marker = roleLogFile(dir, "main", "llama");
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

/**
 * P6 (design/specs/local-calibration-design.md section 2): a job for a managed
 * model with no complete calibration record is HELD. Real broker, real
 * llama-server, real records on disk: B starts uncalibrated, A is calibrated.
 */
describe("jobs held for calibration (P6)", () => {
  const uncalibrate = (dir: string, model: string): void => rmSync(recordPath(dir, "llama", model));
  const health = async (dir: string): Promise<{ queued: number; running: number; held: number; models: Array<{ engine: string; model: string; queued: number; running: number; held: number }> }> => {
    const st = readBrokerState(dir)!;
    return (await (await fetch(`http://127.0.0.1:${st.port}/v1/health`, { headers: { [TOKEN_HEADER]: st.token } })).json()) as never;
  };

  it("a held job never starts a main server, ignores deadline and starvation rotation, and is served once its record appears", async () => {
    const dir = newDir();
    uncalibrate(dir, B);
    // Deadlines of 300 ms and a starvation T of 300 ms: a QUEUED B would be rotated in within a second.
    const env = { LLM_EXT_BROKER_STARVE_MS: "300", LLM_EXT_BROKER_ABANDON_MS: "600000", LLM_EXT_BROKER_LINGER_MS: "1" };
    await runClient(dir, jobsOf(A, 1), env);
    const st = readBrokerState(dir)!;
    const h = { [TOKEN_HEADER]: st.token, [ENGINE_HEADER]: "llama", [CTX_HEADER]: "1024", "content-type": "application/json", "x-llm-ext-queue-timeout-ms": "300" };
    const res = await fetch(`http://127.0.0.1:${st.port}/v1/jobs`, { method: "POST", headers: h, body: JSON.stringify({ model: B, messages: [{ role: "user", content: "x" }], max_tokens: 2 }) });
    const accepted = (await res.json()) as { job: string; state?: string };
    // Review F4: the 202 says at once that the job is held.
    expect(accepted.state).toBe("held");
    const id = accepted.job;
    // A keeps working meanwhile: its jobs are served while B waits.
    const a = await runClient(dir, jobsOf(A, 3), env);
    expect(a.results.filter((x) => x.status !== 200)).toEqual([]);
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await fetch(`http://127.0.0.1:${st.port}/v1/jobs/${id}?wait=1`, { headers: h });
    expect(poll.status).toBe(204);
    expect(poll.headers.get(STATE_HEADER)).toBe("held");
    expect(poll.headers.get("x-llm-ext-held")).toBe("1");
    const hb = await health(dir);
    expect(hb.held).toBe(1);
    expect(hb.queued).toBe(0);
    expect(hb.models.find((m) => m.model === B)).toEqual({ engine: "llama", model: B, queued: 0, running: 0, held: 1 });
    // Never started: no spawn of B, after well over its 300 ms deadline and T.
    expect(spawnLines(dir).filter((l) => l.includes(`model '${B}'`))).toEqual([]);
    markCalibrated(dir, "llama", B);
    let reply: { state: string; heldMs?: number; status?: number } | null = null;
    for (let i = 0; i < 60 && reply === null; i++) {
      const r = await fetch(`http://127.0.0.1:${st.port}/v1/jobs/${id}?wait=1`, { headers: h });
      if (r.status === 200) reply = (await r.json()) as { state: string; heldMs?: number; status?: number };
      else await r.text();
    }
    expect(reply?.state).toBe("done");
    expect(reply?.status).toBe(200);
    expect(reply!.heldMs!).toBeGreaterThan(4000);
    expect(spawnLines(dir).filter((l) => l.includes(`model '${B}'`))).toHaveLength(1);
    expect((await health(dir)).held).toBe(0);
  }, 300_000);

  it("a held job is bounded by --command_timeout: the stop cancels it, and nothing starts", async () => {
    const dir = newDir();
    uncalibrate(dir, B);
    const env = { LLM_EXT_BROKER_STARVE_MS: "300", LLM_EXT_BROKER_ABANDON_MS: "600000" };
    await runClient(dir, jobsOf(A, 1), env);
    const r = await runClient(dir, jobsOf(B, 2), env, "t1", { stopAfterMs: 3000 });
    expect(r.stopped).toEqual({ cancelled: 2, failed: [] });
    expect(r.results.every((x) => x.error !== undefined)).toBe(true);
    const hb = await health(dir);
    expect(hb.held).toBe(0);
    expect(hb.models.find((m) => m.model === B)).toBeUndefined();
    expect(spawnLines(dir).filter((l) => l.includes(`model '${B}'`))).toEqual([]);
  }, 300_000);

  it("a failed calibration record fails the job at once with the record's message (a model error, so the client falls back)", async () => {
    const dir = newDir();
    writeRecord(dir, recordFixture("llama", B, { step: "phase-a/thinking-off", message: "thinking cannot be turned off" }));
    await runClient(dir, jobsOf(A, 1));
    const r = await runClient(dir, jobsOf(B, 1));
    expect(r.results[0].error).toMatch(/calibration-failed at phase-a\/thinking-off: thinking cannot be turned off/);
    expect(spawnLines(dir).filter((l) => l.includes(`model '${B}'`))).toEqual([]);
  }, 300_000);

  // ── P6 step 2: the review fixes of 9a4ee2c8 (F1-F7) and trigger 1 ──

  const post = async (dir: string, model: string): Promise<{ job: string; state?: string }> => {
    const st = readBrokerState(dir)!;
    const h = { [TOKEN_HEADER]: st.token, [ENGINE_HEADER]: "llama", [CTX_HEADER]: "1024", "content-type": "application/json" };
    const res = await fetch(`http://127.0.0.1:${st.port}/v1/jobs`, { method: "POST", headers: h, body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }], max_tokens: 2 }) });
    expect(res.status).toBe(202);
    return (await res.json()) as { job: string; state?: string };
  };
  const poll = async (dir: string, id: string): Promise<Response> => {
    const st = readBrokerState(dir)!;
    return fetch(`http://127.0.0.1:${st.port}/v1/jobs/${id}?wait=1`, { headers: { [TOKEN_HEADER]: st.token } });
  };
  type Reply = { state: string; status?: number; dispatchedAt?: number; error?: string };
  const pollDone = async (dir: string, id: string, tries = 120): Promise<Reply> => {
    for (let i = 0; i < tries; i++) {
      const r = await poll(dir, id);
      if (r.status === 200) return (await r.json()) as Reply;
      await r.text();
    }
    throw new Error(`job ${id} did not finish`);
  };
  const waitFor = async (what: string, cond: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await cond()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const brokerLog = (dir: string): string => readFileSync(join(dir, "broker-local.log"), "utf8");
  const runnerLog = (dir: string): string => (existsSync(calibratorLogPath(dir)) ? readFileSync(calibratorLogPath(dir), "utf8") : "");
  const gguf260K = (): string => {
    const repo = join(LLAMA_CACHE, "models--ggml-org--tiny-llamas", "snapshots");
    for (const rev of readdirSync(repo)) if (existsSync(join(repo, rev, "stories260K.gguf"))) return realpathSync(join(repo, rev, "stories260K.gguf"));
    throw new Error(`stories260K.gguf is not in ${repo}`);
  };

  it("trigger 1: the first held request queues the model and starts a detached runner; the skeleton writes no record, so the job stays held", async () => {
    const dir = newDir();
    uncalibrate(dir, B);
    await runClient(dir, jobsOf(A, 1));
    const { job, state } = await post(dir, B);
    expect(state).toBe("held");
    await waitFor("the runner to finish", () => runnerLog(dir).includes("calibration runner exiting: done"), 120_000);
    expect(runnerLog(dir)).toMatch(/phases A, B, C are not in this runner; no record written, the model stays queued/);
    expect(existsSync(recordPath(dir, "llama", B))).toBe(false);
    expect(readQueue(dir).map((q) => [q.model, q.reason])).toEqual([[B, "first-use"]]);
    // The runner's cal server is gone with it; the main server (A) was never touched.
    expect(readRegistry(dir, "llama").filter((e) => e.role === "cal")).toEqual([]);
    const p = await poll(dir, job);
    expect(p.status).toBe(204);
    expect(p.headers.get(STATE_HEADER)).toBe("held");
    expect((await health(dir)).held).toBe(1);
  }, 300_000);

  it("review F2: a held model whose GGUF path is not Latin-1 is held and polled cleanly (the held header is a fixed ASCII marker)", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1));
    const sub = join(dir, "模型-łódź");
    mkdirSync(sub);
    const model = join(sub, "m.gguf");
    writeFileSync(model, readFileSync(gguf260K()));
    const { job, state } = await post(dir, model);
    expect(state).toBe("held");
    const p = await poll(dir, job);
    expect(p.status).toBe(204);
    expect(p.headers.get("x-llm-ext-held")).toBe("1");
    // The real client: held, ended by --command_timeout with the model named in the stop, never a header crash.
    const r = await runClient(dir, jobsOf(model, 1), {}, "t1", { stopAfterMs: 3000 });
    expect(r.stopped).toEqual({ cancelled: 1, failed: [] });
    expect(r.results[0].error).toContain(`waiting for the calibration of '${model}'`);
  }, 300_000);

  it("review F3: a record naming other weights, or another engine build, re-holds the jobs and queues the model; a rewritten record releases them", async () => {
    const id = identities.get(`llama\u0000${B}`)!;
    const cases = [
      { why: "its weights, the machine's RAM or the calibration method changed", rec: { ...recordFixture("llama", B), engine_version: id.engineVersion, engine_version_checked: id.engineVersion } },
      { why: "the engine build changed", rec: { ...recordFixture("llama", B), fingerprint: id.fingerprint, engine_version: "b1-old", engine_version_checked: "b1-old" } },
    ];
    for (const c of cases) {
      const dir = newDir();
      await runClient(dir, jobsOf(A, 1));
      writeRecord(dir, c.rec);
      const { job, state } = await post(dir, B);
      // The record parses as complete: the job is queued, and the check happens on the loaded server.
      expect(state).toBeUndefined();
      await waitFor("the stale verdict", () => brokerLog(dir).includes(`model '${B}' (llama): ${c.why}`));
      // More than one 5 s release check: the stale record does not reload the model in a loop.
      await new Promise((r) => setTimeout(r, 7000));
      expect(spawnLines(dir).filter((l) => l.includes(`model '${B}'`))).toHaveLength(1);
      const p = await poll(dir, job);
      expect(p.status).toBe(204);
      expect(p.headers.get(STATE_HEADER)).toBe("held");
      expect((await health(dir)).held).toBe(1);
      expect(readQueue(dir).find((q) => q.model === B)?.reason).toMatch(/^(stale|first-use)$/);
      markCalibrated(dir, "llama", B);
      const reply = await pollDone(dir, job);
      expect(reply.state).toBe("done");
      expect(reply.status).toBe(200);
    }
  }, 300_000);

  it("review F1: a broker that exits while a job is held gives it back; the client resubmits it to the next broker (never a model error) and it is served once calibrated", async () => {
    const dir = newDir();
    uncalibrate(dir, B);
    await runClient(dir, jobsOf(A, 1));
    const first = readBrokerState(dir)!;
    const client = runClient(dir, jobsOf(B, 1));
    await waitFor("the job to be held", async () => (await health(dir)).held === 1);
    await fetch(`http://127.0.0.1:${first.port}/v1/shutdown`, { method: "POST", headers: { [TOKEN_HEADER]: first.token } });
    await waitFor("a new broker holding the resubmitted job", async () => {
      const st = readBrokerState(dir);
      return st !== null && st.pid !== first.pid && (await health(dir).catch(() => ({ held: 0 }))).held === 1;
    });
    await waitFor("the old broker to exit", () => !alive(first.pid));
    markCalibrated(dir, "llama", B);
    const r = await client;
    expect(r.results[0].error).toBeUndefined();
    expect(r.results[0].status).toBe(200);
  }, 300_000);

  it("review F7: a held job nobody polls is given back as requeued, never cancelled or failed", async () => {
    const dir = newDir();
    uncalibrate(dir, B);
    await runClient(dir, jobsOf(A, 1), { LLM_EXT_BROKER_ABANDON_MS: "1500" });
    const { job } = await post(dir, B);
    await new Promise((r) => setTimeout(r, 5000));
    const reply = await pollDone(dir, job, 5);
    expect(reply.state).toBe("requeued");
    expect(reply.error).toMatch(/abandoned: not polled while held/);
  }, 120_000);

  it("review F6b: a request arriving after the record appears does not overtake the older held request", async () => {
    const dir = newDir();
    uncalibrate(dir, B);
    await runClient(dir, jobsOf(A, 1));
    const old = await post(dir, B);
    expect(old.state).toBe("held");
    markCalibrated(dir, "llama", B);
    const neu = await post(dir, B);
    expect(neu.state).toBeUndefined();
    const [ro, rn] = await Promise.all([pollDone(dir, old.job), pollDone(dir, neu.job)]);
    expect([ro.state, rn.state]).toEqual(["done", "done"]);
    expect(ro.dispatchedAt!).toBeLessThanOrEqual(rn.dispatchedAt!);
  }, 300_000);
});

/** P6 step 2: the runner survives a SIGKILL mid-model, and the CLI commands of trigger 3. */
describe("calibration runner (P6 step 2)", () => {
  const spawnRunner = (dir: string, env: Record<string, string> = {}): number => {
    const child = spawn(process.execPath, [bundle, CALIBRATE_ARGV], {
      env: { ...process.env, LLAMA_CACHE, LLM_EXT_CONFIG_DIR: dir, ...env },
      // Its output goes where ensureCalibrator sends it, so a failure shows the runner's own log.
      stdio: ["ignore", openSync(calibratorLogPath(dir), "a"), openSync(calibratorLogPath(dir), "a")],
      detached: true,
    });
    child.unref();
    return child.pid!;
  };
  const waitFor = async (what: string, cond: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await cond()) return;
    throw new Error(`timed out waiting for ${what}`);
  };

  it("a runner SIGKILLed mid-model leaves its cal server; the next runner sweeps it and resumes from the saved trials", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1)); // the GGUFs are in LLAMA_CACHE from here on
    rmSync(recordPath(dir, "llama", B)); // newDir calibrated B; this runner must work on it
    withStateLock(dir, 5000, () => {
      enqueueUnlocked(dir, { engine: "llama", model: B, reason: "manual" });
      return true;
    });
    const first = spawnRunner(dir, { TEST_SLOW_PHASE: "1" });
    await waitFor("the first trial", () => existsSync(progressPath(dir, "llama", B)) && loadProgress(dir, "llama", B, null).trials.length === 1).catch((e: Error) => {
      throw new Error(`${e.message}; runner log:\n${existsSync(calibratorLogPath(dir)) ? readFileSync(calibratorLogPath(dir), "utf8") : "(none)"}`);
    });
    const cal = readRegistry(dir, "llama").find((e) => e.role === "cal")!;
    expect(cal.ownerPid).toBe(first);
    process.kill(first, "SIGKILL");
    await waitFor("the runner to die", () => !alive(first));
    expect(alive(cal.pid)).toBe(true);
    const second = spawnRunner(dir, { TEST_SLOW_PHASE: "1" });
    await waitFor("the second runner to finish", () => !alive(second), 120_000);
    expect(alive(cal.pid)).toBe(false);
    const prog = loadProgress(dir, "llama", B, null);
    // Resumed: the trial of the killed run is kept, phase A completes without a second trial.
    expect(prog.trials.map((t) => t.step)).toEqual(["A/test"]);
    expect(prog.phases.A).toBe("passed");
    expect(existsSync(recordPath(dir, "llama", B))).toBe(false);
    expect(readRegistry(dir, "llama").filter((e) => e.role === "cal")).toEqual([]);
    expect(readCalibratorState(dir)).toBeNull();
  }, 300_000);

  const runnerLogOf = (dir: string): string => (existsSync(calibratorLogPath(dir)) ? readFileSync(calibratorLogPath(dir), "utf8") : "");
  const queueB = (dir: string): void => {
    withStateLock(dir, 5000, () => {
      enqueueUnlocked(dir, { engine: "llama", model: B, reason: "manual" });
      return true;
    });
  };

  it("step 3: the real Phase A on a tiny GGUF fails at its context check with the reason, and the calibration-failed record fails a request at once", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1));
    rmSync(recordPath(dir, "llama", B));
    queueB(dir);
    const pid = spawnRunner(dir, { TEST_PHASE_A: "1" });
    await waitFor("the runner to finish", () => !alive(pid), 180_000);
    const log = runnerLogOf(dir);
    // The tiny GGUFs are trained on 128 tokens and llama-server caps -c there: Phase A cannot run its 8k prompt.
    expect(log, log).toMatch(/Phase A FAIL: the server's context is 128 tokens; Phase A needs 16384/);
    const rec = readRecord(dir, "llama", B);
    expect(rec?.status).toBe("calibration-failed");
    expect(rec?.failed_step).toBe("phase-a/context");
    expect(loadProgress(dir, "llama", B, null).trials.map((t) => t.step)).toEqual(["A/capabilities"]);
    expect(readQueue(dir)).toEqual([]);
    expect(readRegistry(dir, "llama").filter((e) => e.role === "cal")).toEqual([]);
    const r = await runClient(dir, jobsOf(B, 1));
    expect(r.results[0].error).toMatch(/calibration-failed at phase-a\/context/);
  }, 300_000);

  /** A record of B calibrated on an older engine build, with progress from that build (A and B passed). */
  const oldBuild = (dir: string): LoadedIdentity => {
    const id = identities.get(`llama\u0000${B}`)!;
    writeRecord(dir, { ...recordFixture("llama", B), fingerprint: id.fingerprint, engine_version: "b1-old", engine_version_checked: "b1-old" });
    const t = (step: string): TrialRecord => ({ step, seed: 0, outcome: "pass", at: new Date().toISOString() });
    saveProgress(dir, "llama", B, { harness_version: HARNESS_VERSION, fixture_version: FIXTURE_VERSION, harness: PRODUCTION_HARNESS_ID, fingerprint: id.fingerprint, trials: [t("A/old"), t("B/old")], phases: { A: "passed", B: "passed" } });
    return id;
  };

  it("an engine build change re-runs only Phase A (step 3): on a pass the record vouches for the new build and the held request is served", async () => {
    const dir = newDir();
    const env = { TEST_PASS_PHASE_A: "1" };
    await runClient(dir, jobsOf(A, 1), env);
    const id = oldBuild(dir);
    const r = await runClient(dir, jobsOf(B, 1), env);
    expect(r.results[0].error).toBeUndefined();
    expect(r.results[0].status).toBe(200);
    const rec = readRecord(dir, "llama", B)!;
    expect(rec.status).toBe("ok");
    expect(rec.engine_version_checked).toBe(id.engineVersion);
    expect(rec.engine_version).toBe("b1-old");
    const prog = loadProgress(dir, "llama", B, null);
    // The old build's Phase A trial is dropped; B's results stay.
    expect(prog.trials.map((x) => x.step)).toEqual(["B/old", "A/stub"]);
    expect(prog.phases).toEqual({ A: "passed", B: "passed" });
    expect(runnerLogOf(dir)).toMatch(/the engine quick check passed on /);
    expect(readQueue(dir)).toEqual([]);
  }, 300_000);

  it("an engine build change whose Phase A fails gives engine-check-failed: the record keeps its body and the held request fails with the reason", async () => {
    const dir = newDir();
    const env = { TEST_PHASE_A: "1" };
    await runClient(dir, jobsOf(A, 1), env);
    oldBuild(dir);
    const r = await runClient(dir, jobsOf(B, 1), env);
    expect(r.results[0].error).toMatch(/engine-check-failed at phase-a\/context/);
    const rec = readRecord(dir, "llama", B)!;
    expect(rec.status).toBe("engine-check-failed");
    expect(rec.engine_version_checked).toBe("b1-old");
    expect(rec.main).toEqual(recordFixture("llama", B).main);
  }, 300_000);

  // ── Review of ea8e3869: C1, M1, M2, M3 through a real broker and runner ──
  const brokerLogOf = (dir: string): string => (existsSync(join(dir, "broker-local.log")) ? readFileSync(join(dir, "broker-local.log"), "utf8") : "");
  const copy260K = (dir: string, name: string): string => {
    const repo = join(LLAMA_CACHE, "models--ggml-org--tiny-llamas", "snapshots");
    const rev = readdirSync(repo).find((r) => existsSync(join(repo, r, "stories260K.gguf")))!;
    const to = join(dir, name);
    writeFileSync(to, readFileSync(realpathSync(join(repo, rev, "stories260K.gguf"))));
    return to;
  };

  it("review C1: a loaded server whose identity cannot be read fails its jobs with the reason after bounded retries; they never wait", async () => {
    const dir = newDir();
    const model = copy260K(dir, "m.gguf");
    writeRecord(dir, recordFixture("llama", model));
    // The digest cache path is a directory: hashing the plain GGUF cannot store its digest, so every identity read throws.
    mkdirSync(join(dir, "calibration", "digests.json"), { recursive: true });
    const t0 = Date.now();
    const r = await runClient(dir, jobsOf(model, 1), {}, "t1", { limitMs: 120_000 });
    expect(r.results[0].error).toMatch(/could not read what its server loaded/);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(brokerLogOf(dir)).toMatch(/could not be read after 3 attempts/);
  }, 180_000);

  it("review M1: a held model whose enqueue failed (state lock busy) is queued by the next runner re-check", async () => {
    const dir = newDir();
    rmSync(recordPath(dir, "llama", B));
    await runClient(dir, jobsOf(A, 1));
    const lock = join(dir, "calibration", "state.lock");
    mkdirSync(lock, { recursive: true });
    const client = runClient(dir, jobsOf(B, 1), {}, "t1", { stopAfterMs: 80_000, limitMs: 150_000 });
    await waitFor("the failed enqueue", () => brokerLogOf(dir).includes(`could not queue '${B}' for calibration`), 30_000);
    rmdirSync(lock);
    expect(readQueue(dir)).toEqual([]);
    await waitFor("the re-check to queue B", () => readQueue(dir).some((q) => q.model === B), 90_000);
    const r = await client;
    expect(r.stopped).toEqual({ cancelled: 1, failed: [] });
  }, 240_000);

  it("review M2: a model whose cal server cannot start gets a calibration-failed record after 3 crashes, and its held request fails with the error", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1));
    const bad = join(dir, "bad.gguf");
    writeFileSync(bad, "not a gguf");
    const r = await runClient(dir, jobsOf(bad, 1), {}, "t1", { limitMs: 180_000 });
    expect(r.results[0].error).toMatch(/calibration-failed at runner\/error: calibration stopped 3 times/);
    expect(readRecord(dir, "llama", bad)?.status).toBe("calibration-failed");
    const log = runnerLogOf(dir);
    for (const n of [1, 2, 3]) expect(log).toContain(`calibration stopped (${n} of 3)`);
  }, 240_000);

  it("review M3: the broker's periodic sweep stops a cal server whose runner was SIGKILLed, with no new runner", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1)); // a broker is running from here on
    rmSync(recordPath(dir, "llama", B));
    queueB(dir);
    const first = spawnRunner(dir, { TEST_SLOW_PHASE: "1" });
    await waitFor("the first trial", () => existsSync(progressPath(dir, "llama", B)) && loadProgress(dir, "llama", B, null).trials.length === 1);
    const cal = readRegistry(dir, "llama").find((e) => e.role === "cal")!;
    process.kill(first, "SIGKILL");
    // The log line is written after the stop completes: wait for it, then the server is gone.
    await waitFor("the broker's sweep to stop the orphaned cal server", () => /stopped orphaned cal llama-server/.test(brokerLogOf(dir)), 90_000);
    expect(alive(cal.pid)).toBe(false);
  }, 180_000);
  it("trigger 3: `models calibrate` queues a profile model and starts the runner; `models calibration-status` reports it; an unknown model is refused", async () => {
    const cli = await cliBundle();
    const cfg = newDir();
    const model = join(cfg, "m.gguf");
    writeFileSync(model, readFileSync(realpathSync(join(LLAMA_CACHE, "models--ggml-org--tiny-llamas", "snapshots", readdirSync(join(LLAMA_CACHE, "models--ggml-org--tiny-llamas", "snapshots"))[0], "stories260K.gguf"))));
    writeFileSync(join(cfg, "settings.yaml"), ["active: tiny", "profiles:", "  tiny:", "    profile-type: local", "    mode: local", "    api: llamacpp-local", "    url: http://127.0.0.1:18431", `    model: ${model}`, "    context_window: 1024", "    server: managed", ""].join("\n"));
    const run = (args: string[]): { code: number; out: string } => {
      try {
        const out = execFileSync(process.execPath, [cli, ...args], {
          env: { ...process.env, HOME: cfg, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLAMA_CACHE },
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
    const unknown = run(["models", "calibrate", "--model", "nope.gguf"]);
    expect(unknown.code, unknown.out).not.toBe(0);
    expect(unknown.out).toMatch(/no managed local profile .* names the model 'nope.gguf'/);
    const q = run(["models", "calibrate", "--model", model]);
    expect(q.code, q.out).toBe(0);
    expect(q.out).toMatch(/queued '.*m\.gguf' \(llama, profiles tiny\) for calibration; calibration runner (started|running)/);
    await waitFor("the runner to finish", () => existsSync(calibratorLogPath(cfg)) && readFileSync(calibratorLogPath(cfg), "utf8").includes("calibration runner exiting: done"), 120_000);
    const s = run(["models", "calibration-status"]);
    expect(s.code, s.out).toBe(0);
    expect(s.out).toMatch(/calibration runner: not running/);
    // Step 3: the runner runs the real Phase A, and the tiny GGUF fails its context check (128 tokens).
    expect(s.out).toMatch(/tiny llama '.*m\.gguf': calibration-failed at phase-a\/context: the model's context is 128 tokens/);
  }, 300_000);
});

/** P6 (round-1 review F20): a cal server whose owner is not a live calibration runner is swept like an orphaned main. */
describe("the cal-server orphan sweep (P6)", () => {
  const spawnCal = async (dir: string, ownerPid: number): Promise<number> => {
    const parsed = parseManagedModel(A);
    if ("error" in parsed) throw new Error(parsed.error);
    const target = { port: await freePort(), model: A, ctx: 1024 };
    const saved = process.env.LLAMA_CACHE;
    process.env.LLAMA_CACHE = LLAMA_CACHE;
    try {
      const e = await claimAndSpawn({
        dir,
        engine: "llama",
        role: "cal",
        ownerPid,
        spawn: async () => {
          const s = await spawnLlamaServer(target, parsed.argv, roleLogFile(dir, "cal", "llama"), "k");
          return { pid: s.pid, pgid: s.pid, port: target.port, argv: s.argv, model: A, ctx: 1024 };
        },
      });
      return e.pid;
    } finally {
      if (saved === undefined) delete process.env.LLAMA_CACHE;
      else process.env.LLAMA_CACHE = saved;
    }
  };

  it("a cal server owned by a dead or non-calibrator process is stopped; one owned by a live __calibrate is kept and blocks a second", async () => {
    const dir = newDir();
    await runClient(dir, jobsOf(A, 1)); // the GGUF is in LLAMA_CACHE from here on
    const notRunner = foreignProcess();
    const runner = foreignProcess([CALIBRATE_ARGV]);
    const runner2 = foreignProcess([CALIBRATE_ARGV]);
    try {
      await new Promise((r) => setTimeout(r, 200));
      const orphan = await spawnCal(dir, notRunner);
      expect(alive(orphan)).toBe(true);
      const log: string[] = [];
      // The broker's own main (from the warm-up client) is kept: only the cal role is judged here.
      expect((await sweepEngine(dir, "llama", "cal", (m) => log.push(m))).filter((e) => e.role === "cal")).toEqual([]);
      expect(log.join("\n")).toMatch(/stopped orphaned cal llama-server pid \d+ .*is not a live calibration runner/);
      expect(alive(orphan)).toBe(false);
      // Review F6a: a live process with __calibrate in its argv is not an owner unless this dir's runner state names it.
      const stranger = await spawnCal(dir, runner);
      await sweepEngine(dir, "llama", "cal", () => undefined);
      expect(alive(stranger)).toBe(false);
      const runnerState = (pid: number): void => writeFileSync(calibratorStatePath(dir), JSON.stringify({ pid, version: "t1", startedAt: new Date().toISOString() }));
      runnerState(runner);
      const kept = await spawnCal(dir, runner);
      await expect(spawnCal(dir, runner)).rejects.toBeInstanceOf(SlotBusyError);
      expect(alive(kept)).toBe(true);
      // The runner dies (SIGKILL): the next claim sweeps its server and starts a new one.
      killQuietly(runner);
      await new Promise((r) => setTimeout(r, 200));
      runnerState(runner2);
      const fresh = await spawnCal(dir, runner2);
      expect(alive(kept)).toBe(false);
      expect(alive(fresh)).toBe(true);
    } finally {
      killQuietly(notRunner);
      killQuietly(runner);
      killQuietly(runner2);
    }
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

/**
 * Review F-1 (TRDD-ZGSGGHQG): a broker from before the one-broker change
 * (`__broker llama`, state in broker-llama.json) must never stay alive beside
 * the new broker-local one. The test runs the REAL pre-change broker: the
 * dist/llm-ext.js of commit fd7c3862, read from git (a shallow clone fetches
 * that one commit; if it cannot, the test fails: never a skip).
 */
const LEGACY_COMMIT = "fd7c3862";
let legacyBuildDir: string | null = null;
function legacyBundle(): string {
  const repo = join(HERE, "..", "..", "..", "..");
  const git = (args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    git(["cat-file", "-e", `${LEGACY_COMMIT}^{commit}`]);
  } catch {
    git(["fetch", "--no-tags", "--depth=1", "origin", LEGACY_COMMIT]);
  }
  // Under the package node_modules (a gitignored cache), like cliBundle: the bundle keeps better-sqlite3 external.
  legacyBuildDir ??= mkdtempSync(join(HERE, "..", "..", "node_modules", ".cache-llm-ext-legacy-broker-"));
  const out = join(legacyBuildDir, "llm-ext.mjs");
  if (!existsSync(out)) writeFileSync(out, git(["show", `${LEGACY_COMMIT}:scripts/llm-ext/dist/llm-ext.js`]));
  return out;
}
afterAll(() => {
  if (legacyBuildDir) rmSync(legacyBuildDir, { recursive: true, force: true });
});

describe("a pre-ZGSGGHQG broker is drained, never left beside the new one (review F-1)", () => {
  it("an old `__broker llama` holding a llama main is asked to drain; the new broker starts nothing until it exited; never two mains", async () => {
    const dir = newDir();
    const old = spawn(process.execPath, [legacyBundle(), "__broker", "llama"], {
      env: { ...process.env, LLAMA_CACHE, LLM_EXT_CONFIG_DIR: dir },
      detached: true,
      stdio: "ignore",
    });
    try {
      const legacyState = join(dir, "broker-llama.json");
      for (let i = 0; i < 300 && !existsSync(legacyState); i++) await new Promise((r) => setTimeout(r, 100));
      const st = JSON.parse(readFileSync(legacyState, "utf8")) as { pid: number; port: number; token: string };
      expect(st.pid).toBe(old.pid);
      // Give the old broker a llama main: one job, polled to its end.
      const sub = await fetch(`http://127.0.0.1:${st.port}/v1/jobs`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: st.token, [CTX_HEADER]: "1024", "content-type": "application/json" },
        body: JSON.stringify({ model: A, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: 2 }),
      });
      expect(sub.status).toBe(202);
      const { job } = (await sub.json()) as { job: string };
      let status = 204;
      for (let i = 0; i < 20 && status === 204; i++) status = (await fetch(`http://127.0.0.1:${st.port}/v1/jobs/${job}?wait=30`, { headers: { [TOKEN_HEADER]: st.token } })).status;
      expect(status).toBe(200);
      const oldMain = readRegistry(dir, "llama").find((e) => e.role === "main")!;
      expect(oldMain.ownerPid).toBe(old.pid);
      expect(alive(oldMain.pid)).toBe(true);

      const w = watchMains(dir);
      const r = await runClient(dir, jobsOf(B, 1));
      const max = w.stop();
      expect(r.results[0].status).toBe(200);
      expect(r.pid).not.toBe(old.pid);
      expect(alive(old.pid!)).toBe(false);
      expect((await processSnapshot()).filter((p) => p.pgid === oldMain.pgid)).toEqual([]);
      expect(readFileSync(join(dir, "broker-local.log"), "utf8")).toMatch(new RegExp(`an older broker \\(pid ${old.pid}, .*asked it to drain`));
      expect(max).toBe(1);
    } finally {
      // The old broker is this test's own child: stopped by its pid if it is still there.
      killQuietly(old.pid!);
    }
  }, 300_000);
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
      writeBrokerState(dir, { pid: foreign, port: 1, token: "x", version: "t1", startedAt: new Date().toISOString() });
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
      expect(readBrokerState(dir)?.pid).toBe(first.pid);
      const listening = readFileSync(join(dir, "broker-local.log"), "utf8").split("\n").filter((l) => l.includes(" listening on "));
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
    const lines = readFileSync(join(dir, "broker-local.log"), "utf8").split("\n");
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
    expect(readFileSync(join(dir, "broker-local.log"), "utf8")).not.toMatch(/failed to start/);
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
    const log = (): string => readFileSync(join(dir, "broker-local.log"), "utf8");
    expect(log()).not.toMatch(new RegExp(`ready: pid ${pid} `));
    const broker = readBrokerState(dir)!.pid;
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
    const st = readBrokerState(dir)!;
    const base = `http://127.0.0.1:${st.port}`;
    const sub = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: st.token, [CTX_HEADER]: "1024", [ENGINE_HEADER]: "llama", "content-type": "application/json" },
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
    markCalibrated(dir, "llama", A);
    dirs.push(dir);
    await runClient(dir, jobsOf(A, 1));
    const st = readBrokerState(dir)!;
    const orphan = mainEntry(dir);
    process.kill(st.pid, "SIGKILL");
    // Unrecorded: only the --log-file marker can find it now.
    rmSync(registryPath(dir, "llama"));
    await new Promise((r) => setTimeout(r, 300));
    const r = await runClient(dir, jobsOf(A, 1));
    expect(r.results[0].status).toBe(200);
    expect(readFileSync(join(dir, "broker-local.log"), "utf8")).toMatch(new RegExp(`stopped unrecorded main llama-server pid ${orphan.pid} `));
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
  const req = { engine: "llama" as const, body: JSON.stringify({ model: "m" }), model: "m", ctx: 0, timeoutMs: 5000 };

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

  it("m1: --command_timeout cancels a job whose POST was still in flight; follow-up m1: only confirmed DELETEs are counted, a refused one is named", async () => {
    const deleted: string[] = [];
    const s = await serve((rq, rs) => {
      if (rq.method === "POST") {
        setTimeout(() => { rs.writeHead(202, { "content-type": "application/json" }); rs.end(JSON.stringify({ job: "slow-job" })); }, 600);
        return;
      }
      if (rq.method === "DELETE") { deleted.push(rq.url ?? ""); rs.writeHead(204); rs.end(); return; }
      rs.writeHead(204, { [STATE_HEADER]: "queued" }); setTimeout(() => rs.end(), 200);
    });
    // A second broker endpoint that refuses the DELETE (500): its job must not be counted as cancelled.
    const bad = await serve((rq, rs) => {
      if (rq.method === "POST") { rs.writeHead(202, { "content-type": "application/json" }); rs.end(JSON.stringify({ job: "stuck-job" })); return; }
      if (rq.method === "DELETE") { rs.writeHead(500); rs.end("no"); return; }
      rs.writeHead(204, { [STATE_HEADER]: "queued" }); setTimeout(() => rs.end(), 200);
    });
    try {
      const call = brokerExchange(s.ep, req).catch((e: unknown) => e);
      const stuck = brokerExchange(bad.ep, req).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 100));
      const result = await cancelAllBrokerJobs("test stop");
      expect(result).toEqual({ cancelled: 1, failed: ["stuck-job"] });
      expect(deleted).toContain("/v1/jobs/slow-job");
      expect(await call).toBeInstanceOf(Error);
      expect(await stuck).toBeInstanceOf(Error);
    } finally {
      await s.close();
      await bad.close();
    }
  });
});

/**
 * Follow-up review M3 + M2: a --command_timeout stop on a profile with NO
 * broker (a non-managed OpenAI-compatible endpoint, the transport every remote
 * profile shares: sendChat -> fetchWithRetry429). The endpoint is a local fake
 * HTTP server in this process, never a real or paid API; it answers each chat
 * request after REPLY_MS. Asserted: no chat request reaches it after the stop,
 * the command exits 124, and its output lists every finished report path and
 * every unfinished file as "FAILED: <file> — <timeout>" (the per-file path and
 * the grouped, one-batch-per-file path).
 */
describe("a stopped command on a non-broker profile starts no new request (follow-up review M3, M2)", () => {
  const REPLY_MS = 2500;
  const TIMEOUT_S = 8;
  const N = 6;
  const STOP_TEXT = `--command_timeout: the command ran longer than ${TIMEOUT_S} s and was stopped`;

  const run = async (answerMode: "0" | "2"): Promise<{ code: number | null; out: string; stopSeenAt: number; chatAt: number[]; dir: string; files: string[] }> => {
    const chatAt: number[] = [];
    const srv = createServer((rq, rs) => {
      rq.resume();
      rq.on("end", () => {
        if (rq.url?.startsWith("/v1/models")) {
          rs.writeHead(200, { "content-type": "application/json" });
          rs.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
          return;
        }
        if (rq.method === "POST" && rq.url?.startsWith("/v1/chat/completions")) {
          chatAt.push(Date.now());
          setTimeout(() => {
            rs.writeHead(200, { "content-type": "application/json" });
            rs.end(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: "fake-model", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "The file tells of a numbered cat." } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }));
          }, REPLY_MS);
          return;
        }
        rs.writeHead(404);
        rs.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const cli = await cliBundle();
      const dir = newDir();
      const src = join(dir, "src");
      mkdirSync(src);
      // ~6 KB per file: with the 10 KB minimum payload budget, the grouped path makes one batch per file.
      const files = Array.from({ length: N }, (_, i) => join(src, `f${i + 1}.txt`));
      files.forEach((f, i) => writeFileSync(f, `Once upon a time there was cat number ${i + 1}. `.repeat(150)));
      writeFileSync(join(dir, "settings.yaml"), ["active: fake", "profiles:", "  fake:", "    profile-type: local", "    mode: local", "    api: generic-local", `    url: http://127.0.0.1:${port}`, "    model: fake-model", "    context_window: 8192", ""].join("\n"));
      let stopSeenAt = 0;
      const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [cli, `--command_timeout=${TIMEOUT_S}`, "llm", "ask", "--folder_path", src, "--instructions", "describe", "--answer_mode", answerMode, "--max_payload_kb", "10", "-o", join(dir, "out")], {
          cwd: dir,
          env: { ...process.env, HOME: dir, LLM_EXT_CONFIG_DIR: dir, LLM_EXT_INSTALL_RULE: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        const take = (c: Buffer): void => {
          text += c;
          if (stopSeenAt === 0 && text.includes(STOP_TEXT)) stopSeenAt = Date.now();
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        const kill = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.on("exit", (c) => {
          clearTimeout(kill);
          resolve({ code: c, out: text });
        });
      });
      return { code, out, stopSeenAt, chatAt, dir: join(dir, "out"), files };
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  };

  const failedLine = (f: string): RegExp => new RegExp(`FAILED: ${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — ${STOP_TEXT}`);

  it("per-file path (answer_mode 0): exit 124, no request after the stop, every finished report path printed, the rest FAILED with the timeout", async () => {
    const r = await run("0");
    expect(r.code, r.out).toBe(124);
    expect(r.stopSeenAt, r.out).toBeGreaterThan(0);
    expect(r.chatAt.length).toBeGreaterThanOrEqual(1);
    expect(r.chatAt.length).toBeLessThan(N);
    for (const at of r.chatAt) expect(at).toBeLessThan(r.stopSeenAt);
    const written = readdirSync(r.dir).filter((f) => f.endsWith(".md"));
    expect(written.length).toBeGreaterThanOrEqual(1);
    for (const f of written) expect(r.out).toContain(join(r.dir, f));
    const unfinished = r.files.filter((f) => !written.some((w) => w.includes(`-${basename(f)}-`)));
    expect(unfinished.length).toBe(N - written.length);
    for (const f of unfinished) expect(r.out).toMatch(failedLine(f));
  }, 180_000);

  it("grouped path (answer_mode 2, one batch per file): exit 124, no request after the stop, the merged report holds the answered batches, the rest FAILED with the timeout", async () => {
    const r = await run("2");
    expect(r.code, r.out).toBe(124);
    expect(r.stopSeenAt, r.out).toBeGreaterThan(0);
    expect(r.chatAt.length).toBeGreaterThanOrEqual(1);
    expect(r.chatAt.length).toBeLessThan(N);
    for (const at of r.chatAt) expect(at).toBeLessThan(r.stopSeenAt);
    const written = readdirSync(r.dir).filter((f) => f.endsWith(".md"));
    expect(written).toHaveLength(1);
    expect(r.out).toContain(join(r.dir, written[0]));
    const merged = readFileSync(join(r.dir, written[0]), "utf8");
    const answered = r.files.filter((f) => merged.includes(`Files: ${f}\n`));
    expect(answered.length).toBeGreaterThanOrEqual(1);
    const unfinished = r.files.filter((f) => !answered.includes(f));
    expect(unfinished.length).toBeGreaterThanOrEqual(1);
    for (const f of unfinished) expect(r.out).toMatch(failedLine(f));
  }, 180_000);
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
      await measure("llama", join(modelsDir, `ctx-${file}`));
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
    for (const m of [modelA(), modelB()]) markCalibrated(cfg, "llama", m);
  };

  /** One real CLI command, in its own process; resolves with its exit code and output. */
  const runCli = (cfg: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        env: { ...process.env, HOME: cfg, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLAMA_CACHE, ...env },
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

  const brokerLog = (cfg: string): string[] => readFileSync(join(cfg, "broker-local.log"), "utf8").split("\n");
  /** Every dispatch in the broker log: model, command, dispatch time, and submit time (dispatch time minus its queue time), in ms. */
  const dispatches = (cfg: string): Array<{ model: string; command: string; at: number; submitted: number }> =>
    brokerLog(cfg).flatMap((l) => {
      const m = /^(\S+) dispatch job \S+ model '([^']+)' command (\S+) queued (\d+) ms/.exec(l);
      if (!m) return [];
      const at = Date.parse(m[1]);
      return [{ model: m[2], command: m[3], at, submitted: at - Number(m[4]) }];
    });
  const brokerHealth = async (cfg: string): Promise<{ queued: number; running: number }> => {
    const st = readBrokerState(cfg)!;
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
    // Follow-up review m9: REAL overlap, from the broker's own timestamps: each
    // command's span at the broker (first submit to last dispatch) intersects the
    // other's, so both commands had jobs at the broker at the same time.
    const span = (cmd: string): [number, number] => {
      const mine = d.filter((x) => x.command === cmd);
      return [Math.min(...mine.map((x) => x.submitted)), Math.max(...mine.map((x) => x.at))];
    };
    const [s1, s2] = [...new Set(d.map((x) => x.command))].map(span);
    expect(s1[0] < s2[1] && s2[0] < s1[1], JSON.stringify({ s1, s2 })).toBe(true);
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

  it("--command_timeout on a multi-file command (spec 15, review m3, follow-up M1): finished reports are written, EVERY unfinished file is named (those that never started too), exit 124, nothing left queued", async () => {
    const cfg = newDir();
    writeSettings(cfg);
    // Follow-up review M1: more files (10) than the submission window (W = 2 x
    // LLM_EXT_BROKER_BATCH = 4), so some files never start before the stop.
    const env = { LLM_EXT_BROKER_BATCH: "2" };
    const n = 10;
    const w = workDir(n);
    // Follow-up review m10: load the model first (a warm-up command), and leave
    // wide limits, so a slow model load can never eat the timeout before the
    // first report: the test is about the stop, not about load time.
    const warm = await runCli(cfg, ["llm", "ask", w.files[0], "--instructions", "go on", "-o", join(w.dir, "warm")], w.dir, env);
    expect(warm.code, warm.out).toBe(0);
    const warmDispatches = dispatches(cfg).length;
    const out = join(w.dir, "scan");
    const scanP = runCli(cfg, ["--command_timeout=90", "scan", "folder", w.src, "--instructions", "continue the story", "--answer_mode", "0", "-o", out], w.dir, env);
    // Freeze the server once the first report is on disk: the rest can then never finish before the timeout.
    for (let i = 0; i < 1200 && reports(out).length < 1; i++) await new Promise((r) => setTimeout(r, 50));
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
    expect(done.length).toBeLessThan(n);
    // Some files never started: the frozen server got only the files dispatched before the freeze.
    expect(dispatches(cfg).length - warmDispatches).toBeLessThan(n);
    // Every file is either finished (a report) or named as unfinished, with the timeout as its reason.
    const unfinished = w.files.filter((f) => !done.some((r) => r.includes(`-${basename(f)}-`)));
    expect(unfinished.length).toBe(n - done.length);
    expect(scan.out).toContain(`UNFINISHED (${unfinished.length}, stopped by --command_timeout):`);
    for (const f of unfinished) expect(scan.out).toMatch(new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: --command_timeout`));
    // Follow-up review m2: the abort reason is the timeout, never a "3 of the last 3 failed" outage text.
    expect(scan.out).not.toMatch(/ABORTED: 3 /);
    expect(scan.out).toMatch(/--command_timeout: the command ran longer than 90 s and was stopped/);
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
    const before = readBrokerState(cfg)!.pid;
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
    expect(readBrokerState(cfg)!.pid).not.toBe(before);
    expect(brokerLog(cfg).join("\n")).toMatch(new RegExp(`stopped orphaned main llama-server pid ${orphan.pid}`));
    expect((await processSnapshot()).filter((p) => p.pgid === orphan.pgid)).toEqual([]);
    expect(await brokerHealth(cfg)).toMatchObject({ queued: 0, running: 0 });
  }, 600_000);
});

/**
 * TRDD-ZGSGGHQG: the Locals engine (MLX models) in the same broker. The pure
 * helpers run everywhere; the real-server tests need macOS on Apple silicon
 * and the `locals` tool. There, a missing `locals` FAILS the tests (beforeAll
 * throws): a missing dependency is never a silent skip. The tiny model is
 * mlx-community/SmolLM-135M-Instruct-4bit (~75 MB, read from the user's
 * Hugging Face cache, HF_HOME). Every Locals server here is started by the
 * broker as `<locals python> -I -X llm-ext-server=<marker> -m locals.server`
 * in a fresh empty cwd, with HOME set to the test's dir, so the user's
 * ~/.locals is never read or written; the user's own Locals server (no
 * marker) is never signalled.
 */
const LOCALS_MODEL = "mlx-community/SmolLM-135M-Instruct-4bit";
const ON_APPLE_SILICON = localsPlatformSupported(process.platform, process.arch);

describe("Locals engine helpers (pure)", () => {
  it("buildLocalsArgv: -I, the marker, the module, loopback, --slots, --max-context only when known", () => {
    const t = { port: 50123, model: LOCALS_MODEL, ctx: 2048 };
    expect(buildLocalsArgv("/v/bin/python", t, "/c/locals-server-main.log")).toEqual([
      "/v/bin/python", "-I", "-X", "llm-ext-server=/c/locals-server-main.log", "-m", "locals.server",
      "--host", "127.0.0.1", "--port", "50123", "--model", LOCALS_MODEL, "--slots", String(LOCALS_MAIN_SLOTS), "--max-context", "2048",
    ]);
    expect(buildLocalsArgv("/v/bin/python", { ...t, ctx: 0 }, "/m")).not.toContain("--max-context");
  });

  it("isLocalsServerArgv: only a Python running locals.server WITH llm-ext's marker", () => {
    const ours = buildLocalsArgv("/v/bin/python", { port: 1, model: LOCALS_MODEL, ctx: 0 }, "/c/m.log");
    expect(isLocalsServerArgv(ours)).toBe(true);
    // The user's own server (e.g. port 8321) carries no marker: never ours.
    expect(isLocalsServerArgv(["/v/bin/python", "-m", "locals.server", "--port", "8321", "--model", "x/y"])).toBe(false);
    // Another program that only carries the tokens as arguments.
    expect(isLocalsServerArgv(["/usr/bin/node", "-e", "", "-X", "llm-ext-server=/c/m.log", "-m", "locals.server"])).toBe(false);
    // Another module under the marker.
    expect(isLocalsServerArgv(["/v/bin/python", "-X", "llm-ext-server=/c/m.log", "-m", "http.server"])).toBe(false);
  });

  it("hasLocalsMarker: exact marker on the unsplit line, a path with spaces included, never a prefix", () => {
    const m = "/x/My Config/locals-server-main.log";
    const line = `/v/bin/python -I -X llm-ext-server=${m} -m locals.server --port 1`;
    expect(hasLocalsMarker(line, m)).toBe(true);
    expect(hasLocalsMarker(line, "/x/My Config/locals-server-main")).toBe(false);
    expect(hasLocalsMarker(`/v/bin/python -m locals.server --port 8321`, m)).toBe(false);
  });

  it("parseLocalsModel: a Hugging Face repo id, never a GGUF file or a path", () => {
    expect(parseLocalsModel(LOCALS_MODEL)).toEqual({ ok: true });
    expect(parseLocalsModel("ggml-org/tiny-llamas/stories15M-q4_0.gguf")).toHaveProperty("error");
    expect(parseLocalsModel("org/model.gguf")).toHaveProperty("error");
    expect(parseLocalsModel("/abs/path/model")).toHaveProperty("error");
  });

  it("localsOutgoingModel: the -thinking id only when thinking is asked AND listed (recorded LFM3 and SmolLM /v1/models)", () => {
    const lfm = ["locals/lfm3-1.7b-mlx-4bit", "locals/lfm3-1.7b-mlx-4bit-thinking"];
    expect(localsOutgoingModel(lfm, { chat_template_kwargs: { enable_thinking: true } })).toBe("locals/lfm3-1.7b-mlx-4bit-thinking");
    expect(localsOutgoingModel(lfm, { chat_template_kwargs: { enable_thinking: false } })).toBe("locals/lfm3-1.7b-mlx-4bit");
    expect(localsOutgoingModel(lfm, {})).toBe("locals/lfm3-1.7b-mlx-4bit");
    expect(localsOutgoingModel(["locals/smollm-135m-instruct"], { chat_template_kwargs: { enable_thinking: true } })).toBe("locals/smollm-135m-instruct");
    expect(localsOutgoingModel([], {})).toBeNull();
  });

  it("isPythonPath: python interpreters only (review F-5)", () => {
    for (const p of ["/v/bin/python", "/usr/bin/python3", "/x/python3.12", "C:\\py\\python.exe"]) expect(isPythonPath(p)).toBe(true);
    for (const p of ["/usr/bin/env", "/x/pypy3", "/x/node", "/x/python-config", ""]) expect(isPythonPath(p)).toBe(false);
  });

  it("localsPython: a `#!/usr/bin/env python3` shim on PATH is never taken as the interpreter (review F-5)", async () => {
    const shimDir = mkdtempSync(join(tmpdir(), "llm-ext-locals-shim-"));
    try {
      writeFileSync(join(shimDir, "locals"), "#!/usr/bin/env python3\nprint('x')\n", { mode: 0o755 });
      // Falls through to `uv tool dir` (where uv and Locals exist) or reports Locals missing; never /usr/bin/env.
      const got = await localsPython({ PATH: shimDir }).then(
        (p) => p,
        (e: Error) => e.message,
      );
      expect(got === "" || got.includes("/usr/bin/env")).toBe(false);
      expect(isPythonPath(got) || /Locals is not installed/.test(got)).toBe(true);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("localsModelErrors: GGUF and mlx/ always refused; a managed profile also needs an org/name repo id (review F-8)", () => {
    expect(localsModelErrors("P", [LOCALS_MODEL, "locals/smollm-135m-instruct"], true)).toEqual([]);
    expect(localsModelErrors("P", ["org/m.gguf"], false)[0]).toMatch(/GGUF/);
    expect(localsModelErrors("P", ["mlx/org/m"], false)[0]).toMatch(/stock mlx/);
    expect(localsModelErrors("P", ["smollm"], false)).toEqual([]);
    expect(localsModelErrors("P", ["smollm"], true)[0]).toMatch(/must be a Hugging Face repo id .*server: managed/);
    expect(localsModelErrors("P", ["/models/smollm"], true)).toHaveLength(1);
  });

  it("waitLocalsReady: a silent load that keeps using CPU is waited for; only a process doing nothing at all stalls (review F-3)", async () => {
    // Real processes, a closed port and a 2 s stall window (production: STALL_MS).
    // The busy one writes no log and downloads nothing, like a Locals load
    // reading weights from disk (measured: port closed, log silent, CPU rising).
    const target = { port: await freePort(), model: "llm-ext-test/no-such-model", ctx: 0 };
    const log = join(newDir(), "silent.log");
    writeFileSync(log, "");
    const busy = spawn(process.execPath, ["-e", "const end = Date.now() + 60000; while (Date.now() < end) {}"], { detached: true, stdio: "ignore" });
    const idle = foreignProcess();
    try {
      const outcome = await Promise.race([
        waitLocalsReady(target, busy.pid!, () => false, log, 2000).then(
          () => "ready",
          (e: Error) => `error: ${e.message}`,
        ),
        new Promise<string>((r) => setTimeout(() => r("still waiting"), 7000)),
      ]);
      expect(outcome).toBe("still waiting");
      await expect(waitLocalsReady(target, idle, () => false, log, 2000)).rejects.toThrow(/made no progress for 2 s/);
    } finally {
      killQuietly(busy.pid!);
      killQuietly(idle);
    }
  }, 60_000);

  it("localsPlatformSupported: macOS on Apple silicon only", () => {
    expect(localsPlatformSupported("darwin", "arm64")).toBe(true);
    expect(localsPlatformSupported("darwin", "x64")).toBe(false);
    expect(localsPlatformSupported("linux", "arm64")).toBe(false);
    expect(localsPlatformSupported("win32", "arm64")).toBe(false);
  });
});

describe.skipIf(!ON_APPLE_SILICON)("broker with a real Locals server (MLX, macOS on Apple silicon)", () => {
  let python: string;
  beforeAll(async () => {
    // Missing `locals` on a Mac fails here, by design (never a skip).
    python = await localsPython();
    await measure("locals", LOCALS_MODEL);
  }, 600_000);

  /** The client env of a Locals test: HOME is the test's dir, so Locals never sees the user's ~/.locals. */
  const localsEnv = (dir: string, extra: Record<string, string> = {}): Record<string, string> => ({ HOME: dir, ...extra });
  const localsJobs = (n: number, extra: object = {}): object[] => jobsOf(LOCALS_MODEL, n, { engine: "locals", ...extra });
  const localsCwds = (): string[] => readdirSync(osTmpdir()).filter((f) => f.startsWith("llm-ext-locals-"));

  /** The most requests Locals itself held at once (its /stats.active lists running AND queued ones), sampled every 100 ms. */
  const watchLocalsActive = (dir: string): { stop: () => number } => {
    let max = 0;
    let on = true;
    void (async () => {
      while (on) {
        const main = readRegistry(dir, "locals").find((e) => e.role === "main");
        if (main) {
          try {
            const res = await fetch(`http://127.0.0.1:${main.port}/stats`);
            const s = (await res.json()) as { active?: unknown[] };
            max = Math.max(max, s.active?.length ?? 0);
          } catch {
            /* loading or stopped */
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    return {
      stop: () => {
        on = false;
        return max;
      },
    };
  };

  it("start, reuse and readiness: one load for two clients, every reply 200, the main is an llm-ext Locals server in an empty cwd", async () => {
    const dir = newDir();
    const env = localsEnv(dir);
    const first = await runClient(dir, localsJobs(2), env);
    const second = await runClient(dir, localsJobs(3), env);
    expect([...first.results, ...second.results].filter((r) => r.status !== 200)).toEqual([]);
    expect(second.pid).toBe(first.pid);
    const spawns = spawnLines(dir);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain("engine locals");
    const main = readRegistry(dir, "locals").find((e) => e.role === "main")!;
    expect(main.argv[0]).toBe(python);
    expect(isLocalsServerArgv(main.argv)).toBe(true);
    expect(main.argv).toContain(`llm-ext-server=${roleLogFile(dir, "main", "locals")}`);
    const row = (await processSnapshot()).find((r) => r.pid === main.pid)!;
    expect(hasLocalsMarker(row.command, roleLogFile(dir, "main", "locals"))).toBe(true);
    expect(readFileSync(join(dir, "broker-local.log"), "utf8")).toMatch(/main Locals server ready: .* slots 4; ids locals\/smollm-135m-instruct/);
    expect(readRegistry(dir, "llama")).toEqual([]);
  }, 300_000);

  it("end to end through real llm-ext commands: llm ask and scan folder on a `api: locals-local` + `server: managed` profile run through one broker and one Locals load", async () => {
    const cli = await cliBundle();
    const cfg = newDir();
    writeFileSync(
      join(cfg, "settings.yaml"),
      [
        "active: smol",
        "profiles:",
        "  smol:",
        "    profile-type: local",
        "    mode: local",
        "    api: locals-local",
        // Binds nothing under the broker; required by the preset (its natural default would collide with a user's Locals port).
        "    url: http://127.0.0.1:18433",
        `    model: ${LOCALS_MODEL}`,
        "    context_window: 2048",
        "    server: managed",
        "",
      ].join("\n"),
    );
    const work = newDir();
    const src = join(work, "src");
    mkdirSync(src);
    const files = [1, 2, 3].map((i) => join(src, `f${i}.txt`));
    files.forEach((f, i) => writeFileSync(f, `Once upon a time there was cat number ${i + 1}.\n`));
    const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [cli, ...args], {
          cwd: work,
          env: { ...process.env, HOME: cfg, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0" },
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
    const mains = watchMains(cfg);
    const [ask, scan] = await Promise.all([
      run(["llm", "ask", files[0], "--instructions", "continue the story", "-o", join(work, "ask")]),
      run(["scan", "folder", src, "--instructions", "continue the story", "--answer_mode", "0", "-o", join(work, "scan")]),
    ]);
    expect(mains.stop()).toBe(1);
    expect(ask.code, ask.out).toBe(0);
    expect(scan.code, scan.out).toBe(0);
    const md = (d: string): string[] => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : []);
    expect(md(join(work, "ask"))).toHaveLength(1);
    expect(md(join(work, "scan"))).toHaveLength(3);
    const log = readFileSync(join(cfg, "broker-local.log"), "utf8").split("\n");
    const d = log.filter((l) => / dispatch job \S+ model '([^']+)' command /.test(l));
    expect(d.length).toBeGreaterThanOrEqual(4);
    expect(new Set(d.map((l) => / command (\S+)/.exec(l)?.[1])).size).toBe(2);
    expect(spawnLines(cfg)).toHaveLength(1);
    expect(spawnLines(cfg)[0]).toContain("engine locals");
    const st = readBrokerState(cfg)!;
    const health = (await (await fetch(`http://127.0.0.1:${st.port}/v1/health`, { headers: { [TOKEN_HEADER]: st.token } })).json()) as object;
    expect(health).toMatchObject({ queued: 0, running: 0 });
  }, 600_000);

  it("memory floor: forced above 100% (proves the gate, not real pressure), Locals never holds more than one request and every job completes; at the default floor it holds several", async () => {
    // Control: at the default floor (10%, the machine has far more free) the
    // sampler DOES see several requests at once, so the forced run's 1 is the
    // gate's doing, not a sampler that cannot see overlap.
    const ctl = newDir();
    const cw = watchLocalsActive(ctl);
    const c = await runClient(ctl, localsJobs(8, { maxTokens: 200 }), localsEnv(ctl));
    expect(c.results.filter((r) => r.status !== 200)).toEqual([]);
    expect(cw.stop()).toBeGreaterThanOrEqual(2);

    const dir = newDir();
    const w = watchLocalsActive(dir);
    const r = await runClient(dir, localsJobs(6, { maxTokens: 64 }), localsEnv(dir, { LLM_EXT_BROKER_MEMORY_FLOOR: "101" }));
    expect(r.results.filter((x) => x.status !== 200)).toEqual([]);
    expect(w.stop()).toBe(1);
    expect(readFileSync(join(dir, "broker-local.log"), "utf8")).toMatch(/waiting for memory: \d+% free < floor 101%/);
  }, 600_000);

  it("kill safety: a real Locals server without llm-ext's marker (the user's kind) is never signalled; a non-Python process with the marker survives the sweep", async () => {
    const dir = newDir();
    const port = 50000 + Math.floor(Math.random() * 9000);
    const cwd = mkdtempSync(join(osTmpdir(), "llm-ext-locals-test-"));
    // Started exactly as the broker does, minus the marker (the user's server has none).
    const user = spawn(python, ["-I", "-m", "locals.server", "--host", "127.0.0.1", "--port", String(port), "--model", LOCALS_MODEL, "--slots", "1"], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: dir, HF_HOME: process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface") },
      detached: true,
      stdio: "ignore",
    });
    const fake = foreignProcess(["-X", `llm-ext-server=${roleLogFile(dir, "main", "locals")}`, "-m", "locals.server"]);
    try {
      await new Promise((r) => setTimeout(r, 1000));
      const row = (await processSnapshot()).find((p) => p.pid === user.pid)!;
      expect(row.argv).toContain("locals.server");
      expect(isLocalsServerArgv(row.argv)).toBe(false);
      await expect(stopProcessGroup(user.pid!, 100)).rejects.toThrow(/leader is not a llama-se/);
      await expect(stopProcessGroup(fake, 100)).rejects.toThrow(/leader is not a llama-se/);
      await expect(
        claimAndSpawn({ dir, engine: "locals", role: "main", ownerPid: process.pid, spawn: () => Promise.reject(new Error("no spawn in this test")) }),
      ).rejects.toThrow(/no spawn in this test/);
      // Even recorded under its own argv, the unmarked server is refused (an error, never a signal).
      await expect(stopOwnServer(dir, "locals", { pid: user.pid!, pgid: user.pid!, argv: row.argv }, () => undefined)).rejects.toThrow(/leader is not a llama-se/);
      expect(alive(user.pid!)).toBe(true);
      expect(alive(fake)).toBe(true);
    } finally {
      killQuietly(fake);
      // Our own test process, by its pid (never by pattern).
      try {
        process.kill(-user.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      for (let i = 0; i < 50 && alive(user.pid!); i++) await new Promise((r) => setTimeout(r, 100));
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it("a live main recorded as this broker's own (an earlier stop failed) is stopped before a main of the other engine starts (review F-2)", async () => {
    const dir = newDir();
    // The broker runs with a llama main.
    const first = await runClient(dir, jobsOf(A, 1), localsEnv(dir));
    expect(first.results[0].status).toBe(200);
    // A real llm-ext Locals server (this dir's marker) recorded in the Locals
    // registry as owned by THAT broker: what a failed stop leaves behind
    // (stopOwnServer throws before releaseEntry, while `server` is already null).
    const port = await freePort();
    const cwd = mkdtempSync(join(osTmpdir(), "llm-ext-locals-test-"));
    const argv = buildLocalsArgv(python, { port, model: LOCALS_MODEL, ctx: 0 }, roleLogFile(dir, "main", "locals"));
    const leftover = spawn(argv[0], argv.slice(1), { cwd, env: { PATH: process.env.PATH ?? "", HOME: dir, HF_HOME: process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface") }, detached: true, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const row = (await processSnapshot()).find((p) => p.pid === leftover.pid)!;
      expect(isLocalsServerArgv(row.argv)).toBe(true);
      const entry = { role: "main", pid: leftover.pid!, pgid: leftover.pid!, port, argv: row.argv, model: LOCALS_MODEL, ctx: 0, ownerPid: first.pid, startedAt: new Date().toISOString() };
      writeFileSync(registryPath(dir, "locals"), JSON.stringify({ entries: [entry] }));
      expect(readRegistry(dir, "locals")).toHaveLength(1);
      // A job for the other llama model: the swap must stop the leftover first.
      const r = await runClient(dir, jobsOf(B, 1), localsEnv(dir));
      expect(r.results[0].status).toBe(200);
      expect(r.pid).toBe(first.pid);
      expect(alive(leftover.pid!)).toBe(false);
      expect(readFileSync(join(dir, "broker-local.log"), "utf8")).toMatch(new RegExp(`stopped this broker's leftover main Locals server pid ${leftover.pid}`));
      expect(readRegistry(dir, "locals")).toEqual([]);
    } finally {
      try {
        process.kill(-leftover.pid!, "SIGKILL");
      } catch {
        /* stopped by the broker, as expected */
      }
      for (let i = 0; i < 50 && alive(leftover.pid!); i++) await new Promise((r) => setTimeout(r, 100));
      rmdirSync(cwd);
    }
  }, 300_000);

  it("cross-engine orphan: after a broker SIGKILL with a Locals main up, a llama job stops the orphaned Locals main first, never two mains", async () => {
    const dir = newDir();
    const before = new Set(localsCwds());
    await runClient(dir, localsJobs(1), localsEnv(dir));
    const st = readBrokerState(dir)!;
    const orphan = readRegistry(dir, "locals").find((e) => e.role === "main")!;
    process.kill(st.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const w = watchMains(dir);
    const r = await runClient(dir, jobsOf(A, 1), localsEnv(dir));
    const max = w.stop();
    expect(r.results[0].status).toBe(200);
    expect(r.pid).not.toBe(st.pid);
    expect((await processSnapshot()).filter((p) => p.pgid === orphan.pgid)).toEqual([]);
    expect(readFileSync(join(dir, "broker-local.log"), "utf8")).toMatch(new RegExp(`stopped orphaned main Locals server pid ${orphan.pid}`));
    expect(max).toBe(1);
    // A SIGKILLed broker cannot remove its Locals server's empty cwd (disclosed); this test removes the one it caused.
    for (const d of localsCwds().filter((x) => !before.has(x))) rmdirSync(join(osTmpdir(), d));
  }, 300_000);

  it("one model at a time across engines: llama and MLX jobs queued together never run two main servers at once, all succeed, and the Locals cwd is removed when it stops", async () => {
    const dir = newDir();
    const before = new Set(localsCwds());
    const w = watchMains(dir);
    // MLX first, then GGUF while MLX still has work, then MLX again: two swaps across engines.
    const r = await runClient(
      dir,
      [...localsJobs(4, { maxTokens: 32 }), ...jobsOf(A, 3, { delayMs: 100 }), ...localsJobs(2, { delayMs: 200 })],
      localsEnv(dir, { LLM_EXT_BROKER_BATCH: "2", LLM_EXT_BROKER_STARVE_MS: "600000" }),
    );
    const engines = spawnLines(dir).map((l) => /engine (\w+)/.exec(l)?.[1]);
    // Stop the broker before counting cwds: the last Locals main is stopped (and its cwd removed) on exit.
    await cleanup(dirs.splice(dirs.indexOf(dir), 1)[0]);
    const max = w.stop();
    expect(r.results.filter((x) => x.status !== 200)).toEqual([]);
    expect(engines).toContain("locals");
    expect(engines).toContain("llama");
    expect(max).toBe(1);
    expect(localsCwds().filter((d) => !before.has(d))).toEqual([]);
  }, 600_000);
});

/**
 * P5: one real `llm ask` per built-in local profile, through the broker, on
 * the profile's MAIN model, with the user's real models (AtomicChat LFM3 GGUF
 * on llama.cpp, LiquidAI LFM3 MLX on Locals). The profiles come from a fresh
 * install (the add-once step), never hand-written. Opt-in with
 * RUN_REAL_LOCAL_MODELS=1: the models are 1-5 GB and load for seconds to a
 * minute, too heavy for every run. The model caches are the user's own
 * (HF_HOME, never LLAMA_CACHE here); HOME and LLM_EXT_CONFIG_DIR are temp.
 */
describe.skipIf(process.env.RUN_REAL_LOCAL_MODELS !== "1")("real models of the built-in local profiles (opt-in, RUN_REAL_LOCAL_MODELS=1)", () => {
  const cases = [
    { profile: "local_llama", engine: "llama", main: "AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K" },
    ...(localsPlatformSupported(process.platform, process.arch) ? [{ profile: "locals-mlx", engine: "locals", main: "LiquidAI/LFM3-1.7B-MLX-4bit" }] : []),
  ];
  for (const c of cases) {
    it(`llm ask on '${c.profile}' runs through the broker on its main model ${c.main}`, async () => {
      const cli = await cliBundle();
      const cfg = newDir();
      await measure(c.engine as "llama" | "locals", c.main);
      markCalibrated(cfg, c.engine as "llama" | "locals", c.main);
      const work = newDir();
      const file = join(work, "story.txt");
      writeFileSync(file, "Once upon a time a cat named Tom lived in a red house by the sea.\n");
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: cfg, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0" };
      delete env.LLAMA_CACHE;
      const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [cli, ...args], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          child.stdout.on("data", (d: Buffer) => (out += d));
          child.stderr.on("data", (d: Buffer) => (out += d));
          const kill = setTimeout(() => child.kill("SIGKILL"), 840_000);
          child.on("exit", (code) => {
            clearTimeout(kill);
            resolve({ code, out });
          });
        });
      // The fresh install writes the defaults and adds the built-in local profiles.
      const boot = await run(["--help"]);
      expect(boot.code, boot.out).toBe(0);
      const mains = watchMains(cfg);
      const ask = await run(["--profile", c.profile, "llm", "ask", file, "--instructions", "In one sentence, who is the main character?", "-o", join(work, "out")]);
      expect(mains.stop()).toBe(1);
      expect(ask.code, ask.out).toBe(0);
      const reports = readdirSync(join(work, "out")).filter((f) => f.endsWith(".md"));
      expect(reports).toHaveLength(1);
      expect(readFileSync(join(work, "out", reports[0]), "utf8").length).toBeGreaterThan(0);
      const spawns = spawnLines(cfg);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]).toContain(`engine ${c.engine} model '${c.main}'`);
    }, 900_000);
  }
});
