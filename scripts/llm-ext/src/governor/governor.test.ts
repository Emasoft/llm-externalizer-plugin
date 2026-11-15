/**
 * Governor core (design/specs/local-inference-governor-design.md, unit 1).
 *
 * Controller rules are pure tables with a fake clock. Everything else is real:
 * real files, real child processes through `acquire`, bundled from the current
 * source with esbuild because dist/ may be stale and a test must never rebuild
 * it. Assertions are invariants read from recorded data, never timings, so the
 * file stays stable on a loaded machine (TRDD-CBOTP0DY). The real governor dir
 * is never touched: the default names are checked on the pure function alone.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { platform, totalmem, freemem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pidState } from "../local-llama-server.js";
import { memoryFreePercent } from "../local-locals-server.js";
import { acquire, release, snapshot, tryAcquire, waitBehindHead, withdraw } from "./client.js";
import { decide, GovernorConfigError, pollDelayMs, resolveConfig, stepWindow, threadBudget, threadsInUse, type GrantRequest } from "./controller.js";
import { freeFloorPct, governorConfig } from "./settings.js";
import { cpuBusyPercent, emptyMetrics, needsReading, nextMetrics, readMemory, type Metrics } from "./metrics.js";
import { emptyState, governorDirFor, LOCK_STALE_MS, ownStart, reap, readStarts, readState, withStateLock, type GovernorLimits, type GovernorState, type GovernorWindow, type Lease, type Waiter } from "./state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIMITS: GovernorLimits = { ramLimitPct: 90, cpuLimitPct: 85, maxInferences: 8 };
const CONFIG = { cores: 8, totalBytes: 64 * 1024 ** 3, settleMs: 2_000, cpuFloorWaitMs: 30_000, loadYieldMs: 120_000 };
const NOW = 1_000_000;
const COOL = { cpuPct: 20, freePct: 60 };

function metrics(cpuPct: number, freePct: number, at = NOW): Metrics {
  return { at, cpuSample: null, cpuPct, freePct };
}

function waiter(id: string, over: Partial<Waiter> = {}): Waiter {
  return { id, kind: "inference", weight: 1, holder: { pid: 1, start: "" }, since: NOW, polledAt: NOW, queueTimeoutMs: null, limits: LIMITS, ...over };
}

function request(over: Partial<GrantRequest> = {}): GrantRequest {
  return { ...waiter("r"), threads: 0, serverPid: null, ...over };
}

function lease(over: Partial<Lease> = {}): Lease {
  return { id: "l", kind: "inference", weight: 1, threads: 0, serverPid: null, bytes: 0, holder: { pid: 1, start: "" }, at: NOW, expiresAt: NOW + 1000, ...over };
}

function windowOf(w: number, over: Partial<GovernorWindow> = {}): GovernorWindow {
  return { w, changedAt: 0, lastRunAt: NOW, lastDecreaseAt: 0, ...over };
}

describe("controller: grant table", () => {
  const over = { cpuPct: 90, freePct: 60 };
  const hotRam = { cpuPct: 20, freePct: 5 };
  const longWait = { since: NOW - 30_000 };
  it.each([
    { name: "cool machine, free window", m: COOL, leases: [], req: {}, grant: true, floor: false, denial: null },
    { name: "no reading yet", m: emptyMetrics(), leases: [], req: {}, grant: false, floor: false, denial: "stale" },
    { name: "reading older than 2 s", m: metrics(20, 60, NOW - 2_001), leases: [], req: {}, grant: false, floor: false, denial: "stale" },
    { name: "reading exactly 2 s old", m: metrics(20, 60, NOW - 2_000), leases: [], req: {}, grant: true, floor: false, denial: null },
    { name: "RAM over, however long it waited, with nothing running: no floor", m: hotRam, leases: [], req: longWait, grant: false, floor: false, denial: "ram" },
    { name: "RAM exactly at the limit counts as over", m: { cpuPct: 20, freePct: 10 }, leases: [], req: {}, grant: false, floor: false, denial: "ram" },
    { name: "CPU over, floor wait not done", m: over, leases: [], req: { since: NOW - 29_999 }, grant: false, floor: false, denial: "cpu" },
    { name: "CPU over, floor wait done, nothing running: floor grant", m: over, leases: [], req: longWait, grant: true, floor: true, denial: null },
    { name: "CPU over, --queue_timeout shortens the floor wait", m: over, leases: [], req: { since: NOW - 5_000, queueTimeoutMs: 5_000 }, grant: true, floor: true, denial: null },
    { name: "CPU over, floor wait done, something running: no floor", m: over, leases: [lease()], req: longWait, grant: false, floor: false, denial: "cpu" },
    { name: "CPU over, floor wait done, a load running: no floor", m: over, leases: [lease({ kind: "load" })], req: longWait, grant: false, floor: false, denial: "cpu" },
    { name: "floor grant refused when its server alone exceeds the thread budget", m: over, leases: [], req: { ...longWait, threads: 7 }, grant: false, floor: false, denial: "threads" },
    { name: "floor grant inside the thread budget", m: over, leases: [], req: { ...longWait, threads: 6 }, grant: true, floor: true, denial: null },
    { name: "window full", m: COOL, leases: [lease({ weight: 2 })], req: {}, w: 2, changedAt: NOW, grant: false, floor: false, denial: "window" },
    { name: "a released lease is replaced at once", m: COOL, leases: [lease()], req: {}, w: 2, changedAt: NOW, grant: true, floor: false, denial: null },
    { name: "weight above the window runs alone", m: COOL, leases: [], req: { weight: 5 }, w: 2, changedAt: NOW, grant: true, floor: false, denial: null },
    { name: "weight above the window waits while anything runs", m: COOL, leases: [lease()], req: { weight: 5 }, w: 2, changedAt: NOW, grant: false, floor: false, denial: "window" },
    { name: "thread budget filled by another server", m: COOL, leases: [lease({ threads: 4, serverPid: 10 })], req: { threads: 3, serverPid: 11 }, w: 4, changedAt: NOW, grant: false, floor: false, denial: "threads" },
    { name: "thread budget filled exactly", m: COOL, leases: [lease({ threads: 4, serverPid: 10 })], req: { threads: 2, serverPid: 11 }, w: 4, changedAt: NOW, grant: true, floor: false, denial: null },
    { name: "a second inference on a running server adds no threads", m: COOL, leases: [lease({ threads: 6, serverPid: 10 })], req: { threads: 6, serverPid: 10 }, w: 4, changedAt: NOW, grant: true, floor: false, denial: null },
    { name: "unknown threads are outside the budget", m: COOL, leases: [lease({ threads: 6, serverPid: 10 })], req: { threads: 0 }, w: 4, changedAt: NOW, grant: true, floor: false, denial: null },
    // A load of known size (an unknown one, bytes 0, runs alone since round 2 of unit 4 and would wait for the inference).
    { name: "a load is not an inference: it passes a full window", m: COOL, leases: [lease()], req: { kind: "load" as const, bytes: 1024 ** 3 }, w: 1, changedAt: NOW, grant: true, floor: false, denial: null },
    { name: "one load at a time", m: COOL, leases: [lease({ kind: "load" })], req: { kind: "load" as const }, grant: false, floor: false, denial: "load" },
    { name: "a running load does not fill the window", m: COOL, leases: [lease({ kind: "load" })], req: {}, grant: true, floor: false, denial: null },
  ])("$name", ({ m, leases, req, w, changedAt, grant, floor, denial }) => {
    const r = request(req);
    const d = decide({ metrics: metrics(m.cpuPct as number, m.freePct as number, "at" in m ? m.at : NOW), window: windowOf(w ?? 1, { changedAt: changedAt ?? 0 }), waiters: [r], leases, servers: [] }, r, NOW, CONFIG);
    expect({ grant: d.grant, floor: d.floor, denial: d.denial }).toEqual({ grant, floor, denial });
  });

  it("only the head of a kind is judged, and a non-head leaves the window alone", () => {
    const window = windowOf(3);
    const r = request();
    const d = decide({ metrics: metrics(20, 60), window, waiters: [waiter("first"), r], leases: [], servers: [] }, r, NOW, CONFIG);
    expect(d).toEqual({ window, grant: false, floor: false, denial: "queued", yields: false });
    const load = request({ id: "x", kind: "load" });
    expect(decide({ metrics: metrics(20, 60), window, waiters: [waiter("first"), load], leases: [], servers: [] }, load, NOW, CONFIG).grant).toBe(true);
  });

  it("cpu_limit_pct 100 switches the ceiling off: a reading of 100 is not over", () => {
    const r = request({ limits: { ...LIMITS, cpuLimitPct: 100 } });
    const d = decide({ metrics: metrics(100, 60), window: windowOf(1), waiters: [r], leases: [], servers: [] }, r, NOW, CONFIG);
    expect(d.grant).toBe(true);
    expect(d.floor).toBe(false);
  });

  describe("a limit binds only its own request (D13)", () => {
    const strict = { ramLimitPct: 50, cpuLimitPct: 50, maxInferences: 1 };
    const judge = (m: Metrics, head: GrantRequest, behind: Waiter[], leases: Lease[] = [], w = 1) => decide({ metrics: m, window: windowOf(w, { changedAt: NOW }), waiters: [head, ...behind], leases, servers: [] }, head, NOW, CONFIG);

    it("a strict waiter behind the head binds nobody: the head is judged by its own limits", () => {
      const d = judge(metrics(70, 40), request(), [waiter("s", { limits: strict })]);
      expect({ grant: d.grant, denial: d.denial }).toEqual({ grant: true, denial: null });
    });

    it("a head over its own RAM limit yields when a waiter behind it is not, and moves no window", () => {
      const d = judge(metrics(20, 40), request({ limits: strict }), [waiter("lax")], [], 8);
      expect(d).toMatchObject({ grant: false, denial: "ram", yields: true, window: { w: 8 } });
    });

    it("a head over its own CPU limit yields the same way", () => {
      expect(judge(metrics(70, 60), request({ limits: strict }), [waiter("lax")])).toMatchObject({ grant: false, denial: "cpu", yields: true });
    });

    it("nobody yields when the limit binds the waiters behind as well", () => {
      expect(judge(metrics(20, 5), request({ limits: strict }), [waiter("lax")])).toMatchObject({ denial: "ram", yields: false });
    });

    it("a head at its own max_inferences yields to a higher one, even while the window is smaller than that one", () => {
      expect(judge(metrics(20, 60), request({ limits: { ...LIMITS, maxInferences: 1 } }), [waiter("lax")], [lease()])).toMatchObject({ denial: "window", yields: true });
    });

    it("max_inferences lower than the window binds this request at once", () => {
      const r = request({ limits: { ...LIMITS, maxInferences: 2 } });
      expect(judge(metrics(20, 60), r, [], [lease({ weight: 2 })], 8)).toMatchObject({ grant: false, denial: "window", yields: false, window: { w: 8 } });
    });

    it("a head stopped by a full window keeps its turn: only its own limit makes it yield", () => {
      expect(judge(metrics(20, 60), request({ weight: 3 }), [waiter("light")], [lease()], 3)).toMatchObject({ denial: "window", yields: false });
    });

    it("a head over its own thread budget yields to a larger budget", () => {
      const r = request({ threads: 5, limits: { ...LIMITS, cpuLimitPct: 50 } });
      expect(judge(metrics(20, 60), r, [waiter("lax")], [], 4)).toMatchObject({ denial: "threads", yields: true });
    });
  });

  it("the thread budget is a floor of cores times the limit, at least 1, and a server counts once", () => {
    expect([threadBudget(14, 85), threadBudget(8, 50), threadBudget(1, 10)]).toEqual([11, 4, 1]);
    expect(threadsInUse([lease({ threads: 3, serverPid: 1 }), lease({ threads: 3, serverPid: 1 }), lease({ threads: 2, serverPid: 2 }), lease({ kind: "load", threads: 9, serverPid: 3 })])).toBe(5);
  });
});

describe("controller: window table", () => {
  const cool = { cpuPct: 20, ramUsedPct: 40 };
  const settle = 2_000;
  it.each([
    { name: "over halves", w: 8, changedAt: 0, reading: { cpuPct: 85, ramUsedPct: 40 }, running: 8, want: 4 },
    { name: "RAM over halves", w: 7, changedAt: 0, reading: { cpuPct: 20, ramUsedPct: 90 }, running: 1, want: 3 },
    { name: "over halves at most once per settle", w: 8, changedAt: NOW - settle + 1, reading: { cpuPct: 90, ramUsedPct: 40 }, running: 8, want: 8 },
    { name: "never below 1", w: 1, changedAt: 0, reading: { cpuPct: 90, ramUsedPct: 40 }, running: 1, want: 1 },
    { name: "under and full rises", w: 3, changedAt: 0, reading: cool, running: 3, want: 4 },
    { name: "under but not full holds", w: 3, changedAt: 0, reading: cool, running: 2, want: 3 },
    { name: "under and full, changed within the settle interval, holds", w: 3, changedAt: NOW - settle + 1, reading: cool, running: 3, want: 3 },
    { name: "never above max_inferences", w: 8, changedAt: 0, reading: cool, running: 8, want: 8 },
    { name: "CPU between the marks holds", w: 3, changedAt: 0, reading: { cpuPct: 75, ramUsedPct: 40 }, running: 3, want: 3 },
    { name: "just under the CPU mark rises", w: 3, changedAt: 0, reading: { cpuPct: 74.9, ramUsedPct: 40 }, running: 3, want: 4 },
    { name: "RAM between the marks holds", w: 3, changedAt: 0, reading: { cpuPct: 20, ramUsedPct: 85 }, running: 3, want: 3 },
    { name: "just under the RAM mark rises", w: 3, changedAt: 0, reading: { cpuPct: 20, ramUsedPct: 84.9 }, running: 3, want: 4 },
    { name: "a tighter max_inferences leaves the shared window alone", w: 8, changedAt: NOW, reading: cool, running: 1, want: 8, limits: { maxInferences: 2 } },
    { name: "just under the limit rises with no decrease in the last 30 s", w: 1, changedAt: 0, reading: { cpuPct: 81.7, ramUsedPct: 40 }, running: 1, want: 2, lastDecreaseAt: NOW - 30_000 },
    { name: "just under the limit holds within 30 s of a decrease", w: 1, changedAt: 0, reading: { cpuPct: 81.7, ramUsedPct: 40 }, running: 1, want: 1, lastDecreaseAt: NOW - 29_999 },
    { name: "RAM just under the limit holds within 30 s of a decrease", w: 2, changedAt: 0, reading: { cpuPct: 20, ramUsedPct: 89 }, running: 2, want: 2, lastDecreaseAt: NOW - 29_999 },
  ])("$name", ({ w, changedAt, reading, running, want, limits, lastDecreaseAt }) => {
    expect(stepWindow(windowOf(w, { changedAt, lastDecreaseAt: lastDecreaseAt ?? NOW }), reading, running, { ...LIMITS, ...limits }, NOW, settle).w).toBe(want);
  });

  it("a decrease is stamped, and a rise or a held window is not", () => {
    const hot = { cpuPct: 90, ramUsedPct: 40 };
    expect(stepWindow(windowOf(8), hot, 8, LIMITS, NOW, settle).lastDecreaseAt).toBe(NOW);
    expect(stepWindow(windowOf(1), hot, 1, LIMITS, NOW, settle).lastDecreaseAt).toBe(0);
    expect(stepWindow(windowOf(3), cool, 3, LIMITS, NOW, settle).lastDecreaseAt).toBe(0);
  });

  it("returns to 1 after 60 s with no lease, and not before", () => {
    expect(stepWindow(windowOf(5, { lastRunAt: NOW - 60_000 }), cool, 0, LIMITS, NOW, settle).w).toBe(1);
    expect(stepWindow(windowOf(5, { lastRunAt: NOW - 59_999 }), cool, 0, LIMITS, NOW, settle).w).toBe(5);
  });

  it("a running inference keeps the idle clock current", () => {
    expect(stepWindow(windowOf(5, { lastRunAt: 0 }), cool, 1, LIMITS, NOW, settle)).toMatchObject({ w: 5, lastRunAt: NOW });
  });
});

describe("controller: polling and settings", () => {
  it.each([
    [0, 200, 250],
    [3, 200, 250],
    [4, 1_000, 2_000],
    [50, 1_000, 2_000],
  ])("rank %i polls every %i to %i ms", (rank, low, high) => {
    expect(pollDelayMs(rank, () => 0)).toBe(low);
    expect(pollDelayMs(rank, () => 1)).toBe(high);
  });

  it("the defaults are the spec's, and a valid override applies", () => {
    // WHY: LIMITS (90/85) is a judge() fixture, not the default. The owner-ruled defaults are 80/80 (51cbf755, TRDD-ZTO9K8EK),
    // so the expectation spells them out instead of reusing the fixture.
    expect(resolveConfig({}, null, 8)).toEqual({ enabled: true, limits: { ramLimitPct: 80, cpuLimitPct: 80, maxInferences: 8 }, serverThreads: 0, settleMs: 2_000, cpuFloorWaitMs: 30_000, loadYieldMs: 120_000 });
    const cfg = resolveConfig({ LLM_EXT_GOVERNOR_ENABLED: "false", LLM_EXT_GOVERNOR_RAM_LIMIT_PCT: "70", LLM_EXT_GOVERNOR_CPU_LIMIT_PCT: "100", LLM_EXT_GOVERNOR_MAX_INFERENCES: "3", LLM_EXT_GOVERNOR_SERVER_THREADS: "2", LLM_EXT_GOVERNOR_SETTLE_MS: "5", LLM_EXT_GOVERNOR_CPU_FLOOR_WAIT_MS: "6", LLM_EXT_GOVERNOR_LOAD_YIELD_MS: "7" }, null, 8);
    expect(cfg).toEqual({ enabled: false, limits: { ramLimitPct: 70, cpuLimitPct: 100, maxInferences: 3 }, serverThreads: 2, settleMs: 5, cpuFloorWaitMs: 6, loadYieldMs: 7 });
  });

  it("D13: env over settings.yaml over the defaults, key by key", () => {
    const section = { enabled: false, ram_limit_pct: 60, cpu_limit_pct: 50, max_inferences: 4, server_threads: 2 };
    expect(resolveConfig({}, section, 8)).toMatchObject({ enabled: false, limits: { ramLimitPct: 60, cpuLimitPct: 50, maxInferences: 4 }, serverThreads: 2 });
    const env = { LLM_EXT_GOVERNOR_ENABLED: "true", LLM_EXT_GOVERNOR_RAM_LIMIT_PCT: "70", LLM_EXT_GOVERNOR_SERVER_THREADS: "1" };
    expect(resolveConfig(env, section, 8)).toMatchObject({ enabled: true, limits: { ramLimitPct: 70, cpuLimitPct: 50, maxInferences: 4 }, serverThreads: 1 });
    expect(resolveConfig({}, { ram_limit_pct: 75 }, 8)).toMatchObject({ enabled: true, limits: { ramLimitPct: 75, cpuLimitPct: 80, maxInferences: 8 }, serverThreads: 0 });
  });

  it("server_threads above the thread budget fails, naming where it came from; the budget uses the resolved cpu limit", () => {
    // 8 cores at 50 % is a budget of 4.
    expect(resolveConfig({}, { cpu_limit_pct: 50, server_threads: 4 }, 8).serverThreads).toBe(4);
    expect(() => resolveConfig({}, { cpu_limit_pct: 50, server_threads: 5 }, 8, "/x/settings.yaml")).toThrow("local_governor.server_threads in /x/settings.yaml");
    expect(() => resolveConfig({ LLM_EXT_GOVERNOR_SERVER_THREADS: "5" }, { cpu_limit_pct: 50 }, 8)).toThrow("LLM_EXT_GOVERNOR_SERVER_THREADS");
    expect(() => resolveConfig({ LLM_EXT_GOVERNOR_CPU_LIMIT_PCT: "25" }, { server_threads: 3 }, 8)).toThrow(GovernorConfigError);
  });

  it.each([
    ["LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", "49"],
    ["LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", "100"],
    ["LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", "9"],
    ["LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", "85.5"],
    ["LLM_EXT_GOVERNOR_MAX_INFERENCES", "0"],
    ["LLM_EXT_GOVERNOR_MAX_INFERENCES", "257"],
    ["LLM_EXT_GOVERNOR_SERVER_THREADS", "x"],
    ["LLM_EXT_GOVERNOR_ENABLED", "yes"],
    ["LLM_EXT_GOVERNOR_ENABLED", "1"],
    ["LLM_EXT_GOVERNOR_SETTLE_MS", "soon"],
    ["LLM_EXT_GOVERNOR_CPU_FLOOR_WAIT_MS", "-1"],
  ])("%s=%s fails fast and names the variable", (name, value) => {
    expect(() => resolveConfig({ [name]: value }, null, 8)).toThrow(name);
    expect(() => resolveConfig({ [name]: value }, null, 8)).toThrow(GovernorConfigError);
  });

  it("governorConfig reads settings.yaml again when it changes, and a malformed section fails fast", () => {
    const path = join(process.env.LLM_EXT_CONFIG_DIR as string, "settings.yaml");
    expect(existsSync(path)).toBe(false);
    const saved = process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT;
    delete process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT;
    // Each write moves the mtime on, so a same-size edit inside one clock tick is still a new stamp.
    let at = Date.now() / 1000;
    const write = (text: string): void => {
      writeFileSync(path, text);
      at += 2;
      utimesSync(path, at, at);
    };
    try {
      expect(governorConfig().limits.ramLimitPct).toBe(80);
      write("local_governor:\n  ram_limit_pct: 70\n");
      expect(governorConfig().limits.ramLimitPct).toBe(70);
      expect(freeFloorPct()).toBe(30);
      write("local_governor:\n  ram_limit_pct: 80\n");
      expect(governorConfig().limits.ramLimitPct).toBe(80);
      write("local_governor:\n  ram_limit_pct: 49\n");
      expect(() => governorConfig()).toThrow("local_governor.ram_limit_pct must be an integer from 50 to 99");
      write("local_governor:\n  ram_limt_pct: 80\n");
      expect(() => governorConfig()).toThrow("local_governor.ram_limt_pct is not a known key");
      write("local_governor:\n  enabled: false\n");
      expect(governorConfig().enabled).toBe(false);
      process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT = "75";
      expect(governorConfig().limits.ramLimitPct).toBe(75);
    } finally {
      rmSync(path, { force: true });
      if (saved === undefined) delete process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT;
      else process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT = saved;
    }
    expect(governorConfig().limits.ramLimitPct).toBe(saved === undefined ? 80 : Number(saved));
  });
});

describe("metrics", () => {
  const sample = (at: number, busyMs: number, totalMs: number) => ({ at, busyMs, totalMs });
  it("CPU is the busy share of the delta", () => {
    expect(cpuBusyPercent(sample(0, 100, 1000), sample(1, 150, 1100))).toBe(50);
  });

  it("counters that did not move are an error, not a NaN that would read as stale forever", () => {
    expect(() => cpuBusyPercent(sample(0, 0, 0), sample(1, 0, 0))).toThrow("os.cpus()");
  });

  it("a first sample is stored and is not yet a reading", () => {
    const m = nextMetrics(emptyMetrics(), 60, sample(NOW, 0, 0), NOW);
    expect(m).toMatchObject({ at: 0, cpuPct: null, freePct: 60, cpuSample: sample(NOW, 0, 0) });
  });

  it("a stored sample under 0.5 s old is left alone", () => {
    const m = { ...emptyMetrics(), cpuSample: sample(NOW - 499, 0, 0) };
    expect(nextMetrics(m, 60, sample(NOW, 50, 100), NOW)).toBe(m);
  });

  it("a stored sample over 10 s old is replaced, and the reading stays stale", () => {
    const m = { ...metrics(30, 60, NOW - 10_001), cpuSample: sample(NOW - 10_001, 0, 0) };
    expect(nextMetrics(m, 55, sample(NOW, 50, 100), NOW)).toMatchObject({ at: NOW - 10_001, cpuPct: 30, freePct: 55 });
  });

  it("a stored sample in the band gives a reading at once, smoothed once", () => {
    const m = { ...metrics(30, 60, NOW - 1_000), cpuSample: sample(NOW - 1_000, 0, 0) };
    expect(nextMetrics(m, 55, sample(NOW, 50, 100), NOW)).toMatchObject({ at: NOW, cpuPct: 40, freePct: 55 });
  });

  it("a figure too old to describe this load is not smoothed in", () => {
    const m = { ...metrics(90, 60, NOW - 60_000), cpuSample: sample(NOW - 1_000, 0, 0) };
    expect(nextMetrics(m, 55, sample(NOW, 10, 100), NOW).cpuPct).toBe(10);
  });

  it("a reading is due after 1 s, and only when a CPU delta can be taken", () => {
    expect(needsReading(emptyMetrics(), NOW)).toBe(true);
    expect(needsReading(metrics(1, 1, NOW - 999), NOW)).toBe(false);
    expect(needsReading({ ...metrics(1, 1, NOW - 1_000), cpuSample: sample(NOW - 400, 0, 0) }, NOW)).toBe(false);
    expect(needsReading({ ...metrics(1, 1, NOW - 1_000), cpuSample: sample(NOW - 500, 0, 0) }, NOW)).toBe(true);
  });

  it("the used figure is 100 minus free from one reading, and free agrees with the machine's own reader", async () => {
    const { freePct, usedPct } = await readMemory();
    expect(usedPct).toBe(100 - freePct);
    expect(freePct).toBeGreaterThan(0);
    expect(freePct).toBeLessThanOrEqual(100);
    if (platform() === "darwin") {
      const direct = await memoryFreePercent();
      expect(direct).not.toBeNull();
      // Two readings of a live machine, not one: they may differ, but not by much.
      expect(Math.abs((direct as number) - freePct)).toBeLessThanOrEqual(5);
    } else {
      expect(Math.abs((100 * freemem()) / totalmem() - freePct)).toBeLessThanOrEqual(5);
    }
  });

  it.runIf(platform() === "linux")("on Linux, free is MemAvailable, the figure that counts reclaimable cache", async () => {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    expect(m).not.toBeNull();
    const available = (100 * Number((m as RegExpExecArray)[1]) * 1024) / totalmem();
    expect(Math.abs(available - (await readMemory()).freePct)).toBeLessThanOrEqual(5);
  });
});

describe("the state directory", () => {
  const user = () => ({ uid: 501, username: "A User\\x" });
  const tmp = () => "C:\\Temp";
  let dir: string;
  let saved: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "govtest-"));
    saved = process.env.LLM_EXT_GOVERNOR_DIR;
  });
  afterEach(() => {
    process.env.LLM_EXT_GOVERNOR_DIR = saved;
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the POSIX default comes from the uid alone: TMPDIR and HOME do not move it", () => {
    expect(governorDirFor({ TMPDIR: "/elsewhere", HOME: "/h" }, "darwin", user, tmp)).toBe("/tmp/llm-ext-governor-501");
    expect(governorDirFor({}, "linux", user, tmp)).toBe("/tmp/llm-ext-governor-501");
  });

  it("the Windows default uses a filename-safe user name under the temp dir", () => {
    expect(governorDirFor({}, "win32", user, tmp)).toBe(join("C:\\Temp", "llm-ext-governor-A_User_x"));
  });

  it("LLM_EXT_GOVERNOR_DIR overrides, and needs no account entry", () => {
    const noUser = (): never => {
      throw new Error("no passwd entry");
    };
    expect(governorDirFor({ LLM_EXT_GOVERNOR_DIR: "/x" }, "linux", noUser, tmp)).toBe("/x");
  });

  it("a user with no account entry gets an error naming the override, not a bare crash", () => {
    const noUser = (): never => {
      throw new Error("no passwd entry");
    };
    expect(() => governorDirFor({}, "linux", noUser, tmp)).toThrow("LLM_EXT_GOVERNOR_DIR");
  });

  it("is created private, with its parents", () => {
    const target = join(dir, "a", "gov");
    process.env.LLM_EXT_GOVERNOR_DIR = target;
    withStateLock(target, () => undefined);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it.each(["tryAcquire", "snapshot"])("a symlinked dir is refused by %s, naming the path and the variable", (call) => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    process.env.LLM_EXT_GOVERNOR_DIR = link;
    const run = () => (call === "snapshot" ? snapshot() : tryAcquire({ timeoutMs: 1000 }));
    expect(run).toThrow(link);
    expect(run).toThrow("LLM_EXT_GOVERNOR_DIR");
    expect(existsSync(join(real, "state-1.json"))).toBe(false);
  });

  it("a file in the dir's place is refused the same way", () => {
    const file = join(dir, "file");
    writeFileSync(file, "x");
    process.env.LLM_EXT_GOVERNOR_DIR = file;
    expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow(file);
    expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow("LLM_EXT_GOVERNOR_DIR");
  });

  it("an unwritable dir is refused, not passed through", () => {
    const target = join(dir, "gov");
    mkdirSync(target, { mode: 0o500 });
    process.env.LLM_EXT_GOVERNOR_DIR = target;
    try {
      expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow(target);
      expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow("LLM_EXT_GOVERNOR_DIR");
    } finally {
      chmodSync(target, 0o700);
    }
  });

  it("an unwritable parent is refused too", () => {
    chmodSync(dir, 0o500);
    const target = join(dir, "gov");
    process.env.LLM_EXT_GOVERNOR_DIR = target;
    expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow(target);
  });

  it("a status read of a missing dir creates nothing", () => {
    const target = join(dir, "never");
    process.env.LLM_EXT_GOVERNOR_DIR = target;
    expect(snapshot().leases).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it("a corrupt state file is replaced by an empty state", () => {
    writeFileSync(join(dir, "state-1.json"), "{ not json");
    expect(readState(dir)).toEqual(emptyState());
    expect(withStateLock(dir, (s) => s.waiters.length)).toEqual({ locked: true, value: 0 });
    expect(JSON.parse(readFileSync(join(dir, "state-1.json"), "utf8"))).toEqual(emptyState());
  });

  it("a state file without the current fields counts as corrupt, never as a window with NaN clocks", () => {
    const old = { ...emptyState(), window: { w: 3, changedAt: 0, lastRunAt: 0 } };
    writeFileSync(join(dir, "state-1.json"), JSON.stringify(old));
    expect(readState(dir).window.w).toBe(1);
    const { polledAt: _dropped, ...oldWaiter } = waiter("w");
    writeFileSync(join(dir, "state-1.json"), JSON.stringify({ ...emptyState(), waiters: [oldWaiter] }));
    expect(readState(dir).waiters).toEqual([]);
  });
  it("a busy lock is reported at once, and nothing runs", () => {
    mkdirSync(join(dir, "lock"));
    let ran = false;
    expect(
      withStateLock(dir, () => {
        ran = true;
      }),
    ).toEqual({ locked: false });
    expect(ran).toBe(false);
    process.env.LLM_EXT_GOVERNOR_DIR = dir;
    expect(tryAcquire({ timeoutMs: 1000 })).toBeNull();
  });

  it("a lock older than 5 s is taken over", () => {
    const lock = join(dir, "lock");
    mkdirSync(lock);
    const old = (Date.now() - LOCK_STALE_MS - 1_000) / 1000;
    utimesSync(lock, old, old);
    expect(withStateLock(dir, () => "ran")).toEqual({ locked: true, value: "ran" });
    expect(existsSync(lock)).toBe(false);
  });

  it("a state nobody changed is not rewritten", () => {
    withStateLock(dir, () => undefined);
    const file = join(dir, "state-1.json");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(file, old, old);
    const before = statSync(file).mtimeMs;
    withStateLock(dir, () => undefined);
    expect(statSync(file).mtimeMs).toBe(before);
  });
});

describe("reaping", () => {
  const state = (over: Partial<GovernorState>): GovernorState => ({ ...emptyState(), ...over });
  const dead = lease({ id: "dead", holder: { pid: 2, start: "s" } });
  const reused = lease({ id: "reused", holder: { pid: 3, start: "old" } });
  const live = lease({ id: "live", holder: { pid: 4, start: "s" } });

  it("a dead holder goes at once; a reused pid goes on a start-time verdict; a live one stays", () => {
    const s = state({ leases: [dead, reused, live], waiters: [waiter("w", { holder: { pid: 2, start: "s" } })] });
    reap(s, NOW, null, (pid) => pid !== 2);
    expect(s.leases.map((l) => l.id)).toEqual(["reused", "live"]);
    expect(s.waiters).toEqual([]);
    reap(s, NOW, new Map([[3, "new"], [4, "s"]]), () => true);
    expect(s.leases.map((l) => l.id)).toEqual(["live"]);
  });

  it("a pid the verdict does not name is left to the liveness check, and Windows's empty start never matches", () => {
    const windows = lease({ id: "win", holder: { pid: 5, start: "" } });
    const s = state({ leases: [live, windows] });
    reap(s, NOW, new Map([[5, "anything"]]), () => true);
    expect(s.leases.map((l) => l.id)).toEqual(["live", "win"]);
  });

  it("a lease past expiresAt goes even with a live holder", () => {
    const s = state({ leases: [lease({ id: "x", expiresAt: NOW })] });
    reap(s, NOW, null, () => true);
    expect(s.leases).toEqual([]);
  });
});

// One bundle, one job per mode: real processes, each its own requester.
// The CJS shim of esbuild.config.mjs: bundled CJS deps (yaml) call require().
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";\nconst require = __cjsCreateRequire(import.meta.url);\n`;

const ENTRY = `
import { appendFileSync, writeFileSync } from "node:fs";
import { acquire, release, snapshot } from "./client.ts";
const [mode, out] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (mode === "turns") {
  const holdMs = Number(process.argv[4]);
  for (const round of [1, 2]) {
    const lease = await acquire({ timeoutMs: 120000 });
    appendFileSync(out, JSON.stringify({ event: "start", round, at: lease.at, t: Date.now() }) + "\\n");
    await sleep(holdMs);
    appendFileSync(out, JSON.stringify({ event: "end", round, t: Date.now() }) + "\\n");
    release(lease);
  }
  await sleep(300);
  appendFileSync(out, JSON.stringify({ event: "exit", resources: process.getActiveResourcesInfo() }) + "\\n");
} else if (mode === "hold") {
  const lease = await acquire({ timeoutMs: 120000 });
  writeFileSync(out, JSON.stringify(lease));
  setTimeout(() => {}, 120000);
} else if (mode === "wait-and-go") {
  const lease = await acquire({ timeoutMs: 120000 });
  release(lease);
  writeFileSync(out, "got it");
} else if (mode === "wait-then-abort") {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("gave up")), Number(process.argv[4]));
  const answer = await acquire({ timeoutMs: 120000 }, { signal: controller.signal }).catch((err) => err.message);
  appendFileSync(out, JSON.stringify({ answer, waiters: snapshot().waiters.length }) + "\\n");
}
`;

describe("real processes", () => {
  const DEADLINE_MS = 180_000;
  const SAVED_KEYS = ["LLM_EXT_GOVERNOR_DIR", "LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", "LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", "LLM_EXT_GOVERNOR_MAX_INFERENCES", "LLM_EXT_GOVERNOR_SETTLE_MS"];
  const saved = new Map<string, string | undefined>();
  const children: ChildProcess[] = [];
  let workDir: string;
  let bundle: string;
  let root: string;
  let dir: string;

  beforeAll(async () => {
    // Under node_modules, not /tmp: better-sqlite3 stays external (a native addon), found by walking up from the bundle.
    const cache = join(HERE, "..", "..", "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    workDir = mkdtempSync(join(cache, "govtest-bundle-"));
    bundle = join(workDir, "governor-entry.mjs");
    // Unit 6: client.ts reads settings.yaml (governor/settings.ts, config.ts), whose bundled CJS deps (yaml) call require():
    // the same require shim and externals as every other CLI bundle of the suite.
    await build({ stdin: { contents: ENTRY, resolveDir: HERE, sourcefile: "entry.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", outfile: bundle, logLevel: "error", external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"], banner: { js: REQUIRE_SHIM } });
    for (const key of SAVED_KEYS) saved.set(key, process.env[key]);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    root = mkdtempSync(join("/tmp", "govtest-"));
    dir = join(root, "gov");
    // The CPU ceiling is off so these tests do not depend on what else the machine is doing; RAM stays at its highest.
    Object.assign(process.env, {
      LLM_EXT_GOVERNOR_DIR: dir,
      LLM_EXT_GOVERNOR_CPU_LIMIT_PCT: "100",
      LLM_EXT_GOVERNOR_RAM_LIMIT_PCT: "99",
      LLM_EXT_GOVERNOR_MAX_INFERENCES: "3",
      LLM_EXT_GOVERNOR_SETTLE_MS: "100",
    });
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(child.pid, "SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  });

  function start(...args: string[]): ChildProcess {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env } });
    children.push(child);
    return child;
  }

  function exited(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
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

  function within<T>(ms: number, work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`nothing after ${ms} ms`)), ms);
      void work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
  it("20 processes through acquire never exceed max_inferences, take turns, and end on their own", async () => {
    const maxInferences = 3;
    const holdMs = 300;
    const count = 20;
    const t0 = Date.now();
    // A gate lease fills the machine until all 20 are queued, so the order of grants is the queue's, not the spawn race's.
    const gate = await acquire({ timeoutMs: DEADLINE_MS, weight: maxInferences });
    const files = Array.from({ length: count }, (_, i) => join(root, `child-${i}.jsonl`));
    const procs = files.map((file) => start("turns", file, String(holdMs)));
    const exits = procs.map(exited);
    await until("20 waiters", () => snapshot().waiters.length === count);
    release(gate);

    // An independent witness: what the shared state itself says is running, sampled while the children work.
    let finished = false;
    let peakRunning = 0;
    let peakWindow = 0;
    const watch = (async () => {
      while (!finished) {
        const s = snapshot();
        peakRunning = Math.max(peakRunning, s.running);
        peakWindow = Math.max(peakWindow, s.w);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const codes = await Promise.all(exits);
    finished = true;
    await watch;
    const elapsedMs = Date.now() - t0;

    expect(codes).toEqual(Array(count).fill(0));
    type Event = { event: string; round: number; at: number; t: number; resources: string[]; child: number };
    const events = files.flatMap((file, child) =>
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => ({ ...(JSON.parse(line) as Event), child })),
    );

    // Each start is logged after its grant and each end before its release, so this overlap never exceeds the real one.
    const timeline = events.filter((e) => e.event !== "exit").sort((a, b) => a.t - b.t || (a.event === "end" ? -1 : 1));
    let inside = 0;
    let peak = 0;
    for (const e of timeline) {
      inside += e.event === "start" ? 1 : -1;
      peak = Math.max(peak, inside);
    }
    expect(peak).toBeLessThanOrEqual(maxInferences);
    expect(peakRunning).toBeLessThanOrEqual(maxInferences);
    expect(peakWindow).toBeLessThanOrEqual(maxInferences);
    // With the CPU ceiling off only RAM can hold the window down; below its mark the bound above was really under test.
    if ((snapshot().ramUsedPct as number) < 94) expect(peak).toBeGreaterThan(1);

    // Turns: every child had its first grant before any child had its second. `at` is stamped inside the lock.
    const grants = events.filter((e) => e.event === "start");
    expect(grants).toHaveLength(2 * count);
    const lastFirst = Math.max(...grants.filter((e) => e.round === 1).map((e) => e.at));
    const firstSecond = Math.min(...grants.filter((e) => e.round === 2).map((e) => e.at));
    expect(firstSecond).toBeGreaterThanOrEqual(lastFirst);

    // No stray handle: a Timeout may be listed only beside the vm_stat child whose execFile timeout it is.
    for (const e of events.filter((x) => x.event === "exit")) {
      if (!e.resources.includes("ProcessWrap")) expect(e.resources).not.toContain("Timeout");
    }
    const end = snapshot();
    expect(end.leases).toEqual([]);
    expect(end.waiters).toEqual([]);
    process.stdout.write(`governor: 20 children, ${elapsedMs} ms, peak overlap ${peak}, peak window ${peakWindow}\n`);
  });

  it("a SIGKILLed holder's lease is reclaimed and the next waiter proceeds", async () => {
    const file = join(root, "lease.json");
    const child = start("hold", file);
    await until("the holder's lease", () => existsSync(file) && statSync(file).size > 0);
    expect(snapshot().leases).toHaveLength(1);
    const code = exited(child);
    process.kill(child.pid as number, "SIGKILL");
    await code;
    const next = await acquire({ timeoutMs: 1000, weight: 3 });
    expect(snapshot().leases.map((l) => l.id)).toEqual([next.id]);
    release(next);
    await until("the release", () => snapshot().leases.length === 0);
  });

  it("a head waiter that dies is reaped by the next rank, even when that rank polls slowly", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const gate = await acquire({ timeoutMs: DEADLINE_MS });
    const child = start("hold", join(root, "never.json"));
    await until("the head waiter", () => snapshot().waiters.length === 1);
    let got: Lease | null = null;
    const next = acquire({ timeoutMs: DEADLINE_MS }).then((l) => (got = l));
    await until("the second waiter", () => snapshot().waiters.length === 2);
    const code = exited(child);
    process.kill(child.pid as number, "SIGKILL");
    await code;
    release(gate);
    await until("the next rank to reap the dead head", () => got !== null);
    release(await next);
    await until("the release", () => snapshot().leases.length === 0);
  });

  it("a change the directory refuses is not lost and reaches the next caller as an error, never as a crash", async () => {
    const gate = await acquire({ timeoutMs: DEADLINE_MS });
    chmodSync(dir, 0o500);
    try {
      expect(() => release(gate)).not.toThrow();
      expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow(dir);
    } finally {
      chmodSync(dir, 0o700);
    }
    tryAcquire({ timeoutMs: 1000 });
    expect(snapshot().leases.map((l) => l.id)).not.toContain(gate.id);
    withdraw();
  });
  it("a live pid with the wrong start time is reclaimed, and one with the right start time is not", async () => {
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
    children.push(sleeper);
    const pid = sleeper.pid as number;
    const right = (await readStarts([pid])).get(pid);
    expect(right).toBeTruthy();
    const future = Date.now() + DEADLINE_MS;
    withStateLock(dir, (s) => {
      s.leases.push(lease({ id: "right", holder: { pid, start: right as string }, expiresAt: future }));
      s.leases.push(lease({ id: "wrong", holder: { pid, start: "Thu Jan  1 00:00:00 1970" }, expiresAt: future }));
    });
    // The first head of a fresh state runs the check at once; this real waiter is that head.
    await until("the reused pid's lease to go", () => {
      const got = tryAcquire({ timeoutMs: 1000, weight: 1 });
      if (got) release(got);
      return !snapshot().leases.some((l) => l.id === "wrong");
    });
    withdraw();
    expect(snapshot().leases.map((l) => l.id)).toContain("right");
  });

  it("the start string of this process agrees with what the check reads", async () => {
    expect((await readStarts([process.pid])).get(process.pid)).toBe(ownStart());
  });

  it("an aborted wait leaves no waiter, and the process ends at once on its own", async () => {
    const gate = await acquire({ timeoutMs: DEADLINE_MS, weight: 3 });
    const file = join(root, "abort.jsonl");
    const child = start("wait-then-abort", file, "1500");
    expect(await exited(child)).toBe(0);
    release(gate);
    const { answer, waiters } = JSON.parse(readFileSync(file, "utf8")) as { answer: string; waiters: number };
    expect(answer).toBe("gave up");
    expect(waiters).toBe(0);
  });

  it("an aborted signal rejects at once and takes no place", async () => {
    await expect(acquire({ timeoutMs: 1000 }, { signal: AbortSignal.abort(new Error("already")) })).rejects.toThrow("already");
    expect(snapshot().waiters).toEqual([]);
  });

  it("one process holds one place in the queue whatever its depth, and all its acquires are served", async () => {
    const gate = await acquire({ timeoutMs: DEADLINE_MS, weight: 3 });
    const pending = Array.from({ length: 5 }, () => acquire({ timeoutMs: DEADLINE_MS }));
    await until("the waiter", () => snapshot().waiters.length === 1);
    expect(snapshot().waiters).toHaveLength(1);
    release(gate);
    for (const p of pending) release(await p);
    await until("the releases", () => snapshot().leases.length === 0);
    expect(snapshot().waiters).toEqual([]);
  });

  it("a process granted with acquires still pending keeps its place, at the tail behind the others (D7)", async () => {
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    children.push(sleeper);
    const pid = sleeper.pid as number;
    const start = (await readStarts([pid])).get(pid) as string;
    const gate = await acquire({ timeoutMs: DEADLINE_MS, weight: 3 });
    const first = acquire({ timeoutMs: DEADLINE_MS });
    const second = acquire({ timeoutMs: DEADLINE_MS });
    await until("this process's waiter", () => snapshot().waiters.length === 1);
    // Another process queues behind it, and stays fresh so it is never passed as a stopped head.
    const other = waiter("other", { holder: { pid, start }, since: Date.now(), polledAt: Date.now() });
    withStateLock(dir, (s) => void s.waiters.push(other));
    const keepFresh = setInterval(() => withStateLock(dir, (s) => s.waiters.filter((w) => w.id === "other").forEach((w) => (w.polledAt = Date.now()))), 1000);
    try {
      const queuedSince = snapshot().waiters[0].since;
      await new Promise((r) => setTimeout(r, 50));
      const grantedAfter = Date.now();
      release(gate);
      const lease = await first;
      // Read before this process polls again: a waiter dropped at the grant would be missing here until its next poll.
      const ids = snapshot().waiters.map((w) => w.id);
      expect(ids).toEqual(["other", `${process.pid}:inference`]);
      // `since` restarts at the grant: the waiter queued earlier than that, so the old stamp would be below it.
      expect(snapshot().waiters[1].since).toBeGreaterThan(queuedSince);
      expect(snapshot().waiters[1].since).toBeGreaterThanOrEqual(grantedAfter);
      withStateLock(dir, (s) => void (s.waiters = s.waiters.filter((w) => w.id !== "other")));
      release(lease);
      release(await second);
    } finally {
      clearInterval(keepFresh);
    }
    await until("the releases", () => snapshot().leases.length === 0);
    expect(snapshot().waiters).toEqual([]);
  });

  it("a weight above max_inferences runs alone once nothing else does, and nothing runs beside it (D9)", async () => {
    const heavy = await acquire({ timeoutMs: DEADLINE_MS, weight: 5 });
    expect(snapshot().running).toBe(5);
    expect(tryAcquire({ timeoutMs: 1000 })).toBeNull();
    withdraw("inference");
    release(heavy);
    await until("the release", () => snapshot().leases.length === 0);
  });
  it("a denied tryAcquire keeps its place until withdrawn", async () => {
    const gate = await acquire({ timeoutMs: DEADLINE_MS, weight: 3 });
    expect(tryAcquire({ timeoutMs: 1000 })).toBeNull();
    expect(snapshot().waiters).toHaveLength(1);
    withdraw("inference");
    expect(snapshot().waiters).toEqual([]);
    release(gate);
  });

  it("a poll waits behind a live head, and acts on a dead one or one stopped for 10 s per rank", () => {
    const head = waiter("h", { holder: { pid: process.pid, start: "" } });
    const dead = waiter("d", { holder: { pid: 99_999_999, start: "" } });
    expect(waitBehindHead([head], 0, NOW + 99_999)).toBe(false);
    expect(waitBehindHead([head], 1, NOW + 10_000)).toBe(true);
    expect(waitBehindHead([head], 1, NOW + 10_001)).toBe(false);
    expect(waitBehindHead([head], 2, NOW + 10_001)).toBe(true);
    expect(waitBehindHead([head], 2, NOW + 20_001)).toBe(false);
    expect(waitBehindHead([dead], 1, NOW)).toBe(false);
  });

  it("a waiter that becomes head starts with a fresh stamp: it never polled the lock, and that is not a stopped process", () => {
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    children.push(sleeper);
    withStateLock(dir, (s) => {
      s.waiters.push(waiter("dead", { holder: { pid: 99_999_999, start: "" }, since: Date.now(), polledAt: Date.now() }));
      s.waiters.push(waiter("promoted", { holder: { pid: sleeper.pid as number, start: "" }, since: Date.now(), polledAt: Date.now() - 60_000 }));
    });
    expect(tryAcquire({ timeoutMs: 1000 })).toBeNull();
    const [head, self] = snapshot().waiters;
    expect(head.id).toBe("promoted");
    expect(Date.now() - head.polledAt).toBeLessThan(5_000);
    expect(self.holder.pid).toBe(process.pid);
    withdraw();
  });
  it("a live head that stops polling loses its turn after 10 s, and still has a place when it resumes", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const gate = await acquire({ timeoutMs: DEADLINE_MS });
    const out = join(root, "resumed.json");
    const pid = start("hold", out).pid as number;
    await until("the head waiter", () => snapshot().waiters.length === 1);
    const giveUp = new AbortController();
    const next = acquire({ timeoutMs: DEADLINE_MS }, { signal: giveUp.signal });
    await until("the second waiter", () => snapshot().waiters.length === 2);
    process.kill(pid, "SIGSTOP");
    try {
      const stoppedAt = Date.now();
      release(gate);
      const lease = await within(90_000, next);
      expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(9_000);
      expect(pidState(pid)).toBe("alive");
      expect(snapshot().waiters.map((w) => w.holder.pid)).toEqual([pid]);
      release(lease);
      process.kill(pid, "SIGCONT");
      await until("the resumed process to get its lease", () => existsSync(out));
    } finally {
      giveUp.abort(new Error("test over"));
      await next.catch(() => undefined);
      process.kill(pid, "SIGCONT");
      process.kill(pid, "SIGKILL");
    }
  }, DEADLINE_MS);

  it("a zombie reads as alive, and is passed like any stopped head", async () => {
    const parent = spawn("perl", ["-e", '$| = 1; my $p = fork(); if (!$p) { exit 0 } print "$p\\n"; sleep 120;'], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(parent);
    const pid = await new Promise<number>((resolve) => parent.stdout?.once("data", (d: Buffer) => resolve(Number(String(d).trim()))));
    await until("the child to be a zombie", () => execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).startsWith("Z"));
    expect(pidState(pid)).toBe("alive");
    withStateLock(dir, (s) => {
      s.waiters.push(waiter("zombie", { holder: { pid, start: "" }, since: Date.now(), polledAt: Date.now() - 60_000 }));
    });
    const giveUp = new AbortController();
    const next = acquire({ timeoutMs: DEADLINE_MS }, { signal: giveUp.signal });
    try {
      release(await within(90_000, next));
      expect(snapshot().waiters.map((w) => w.id)).toEqual(["zombie"]);
    } finally {
      giveUp.abort(new Error("test over"));
      await next.catch(() => undefined);
    }
  }, DEADLINE_MS);

  it("a stopped first waiter of the other kind does not leave every head without a reading", async () => {
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    children.push(sleeper);
    withStateLock(dir, (s) => {
      s.waiters.push(waiter("stopped", { kind: "load", holder: { pid: sleeper.pid as number, start: "" }, since: Date.now(), polledAt: Date.now() - 60_000 }));
    });
    const giveUp = new AbortController();
    const next = acquire({ timeoutMs: DEADLINE_MS }, { signal: giveUp.signal });
    try {
      release(await within(90_000, next));
    } finally {
      giveUp.abort(new Error("test over"));
      await next.catch(() => undefined);
    }
  }, DEADLINE_MS);

  it("a process at its own max_inferences steps aside for one with a higher limit", async () => {
    const gate = await acquire({ timeoutMs: DEADLINE_MS });
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const child = start("hold", join(root, "strict.json"));
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "3";
    await until("the strict head", () => snapshot().waiters.length === 1);
    const giveUp = new AbortController();
    const next = acquire({ timeoutMs: DEADLINE_MS }, { signal: giveUp.signal });
    try {
      const lease = await within(90_000, next);
      expect(snapshot().leases.map((l) => l.id).sort()).toEqual([gate.id, lease.id].sort());
      expect(snapshot().waiters.map((w) => w.holder.pid)).toEqual([child.pid]);
      release(lease);
      release(gate);
    } finally {
      giveUp.abort(new Error("test over"));
      await next.catch(() => undefined);
    }
  }, DEADLINE_MS);

  it("a process with nothing else to do stays alive through a denial and gets its lease", async () => {
    const gate = await acquire({ timeoutMs: DEADLINE_MS, weight: 3 });
    const out = join(root, "got.txt");
    const child = start("wait-and-go", out);
    await until("the waiter", () => snapshot().waiters.length === 1);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(child.exitCode).toBeNull();
    const code = exited(child);
    release(gate);
    expect(await code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("got it");
  }, DEADLINE_MS);

  it("a release whose state write fails stays queued until a write succeeds", async () => {
    const gate = await acquire({ timeoutMs: DEADLINE_MS });
    // A directory at the temp path: the lock works, and only the write itself fails.
    const blocker = join(dir, `state-1.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    expect(() => release(gate)).not.toThrow();
    expect(snapshot().leases.map((l) => l.id)).toContain(gate.id);
    rmSync(blocker, { recursive: true });
    expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow(dir);
    const again = tryAcquire({ timeoutMs: 1000 });
    if (again) release(again);
    expect(snapshot().leases.map((l) => l.id)).not.toContain(gate.id);
    withdraw();
  });

  describe.runIf(platform() === "darwin")("failed readings (vm_stat is in /usr/bin, ps in /bin)", () => {
    const fullPath = process.env.PATH;
    const pass = async (): Promise<void> => {
      expect(tryAcquire({ timeoutMs: 1000 })).toBeNull();
      await new Promise((r) => setTimeout(r, 200));
    };
    const failingPasses = async (count: number): Promise<void> => {
      process.env.PATH = "/bin";
      for (let i = 0; i < count; i++) await pass();
      process.env.PATH = fullPath;
    };
    afterEach(() => {
      process.env.PATH = fullPath;
    });

    it("two in a row are only a stale reading, and a good one starts the count again", async () => {
      const gate = await acquire({ timeoutMs: DEADLINE_MS, weight: 3 });
      await new Promise((r) => setTimeout(r, 1_100));
      await failingPasses(2);
      await until("a good reading", () => {
        expect(tryAcquire({ timeoutMs: 1000 })).toBeNull();
        return (snapshot().readingAgeMs ?? Infinity) < 500;
      });
      await new Promise((r) => setTimeout(r, 1_100));
      await failingPasses(2);
      expect(tryAcquire({ timeoutMs: 1000 })).toBeNull();
      withdraw();
      release(gate);
    });

    it("three in a row reach the next caller as an error", async () => {
      process.env.PATH = "/bin";
      await pass();
      await pass();
      await pass();
      expect(() => tryAcquire({ timeoutMs: 1000 })).toThrow(/vm_stat/);
      withdraw();
    });
  });
});

describe("hermetic setup", () => {
  it("every test runs against a private governor dir, never the default", () => {
    const hermetic = process.env.LLM_EXT_GOVERNOR_DIR as string;
    expect(hermetic).toBeTruthy();
    expect(hermetic).not.toMatch(/llm[-_]?ext/i);
    expect(statSync(hermetic).isDirectory()).toBe(true);
  });

  it("the limits default to out of reach: a test about them sets its own", () => {
    expect(governorConfig().limits).toMatchObject({ cpuLimitPct: 100, ramLimitPct: 99 });
  });
});
