import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLocalFallbackForTests, answerWithLocalDecider, DECIDER_SINGLETON_PORT, LOCAL_FALLBACK_DEFAULTS, type LocalEscalation } from "./local-fallback.js";
import type { GlobalFetch } from "../l0/transport.js";
import type { LocalDeciderDeps } from "./local-decider.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { acquire, release, snapshot, withdraw, type Lease } from "../../governor/client.js";

/**
 * The retry policy of the local decider tier (TRDD-O93LFMF3): a fixed rescan pause for a not-ready singleton, the
 * per-process fast-fail memo, and the outer request deadline bounding the wait for a loading singleton.
 * Nothing here touches the real machine and nothing sleeps for real: fetch, the process scan, the platform and
 * the install check are injected, and the clock (setTimeout, Date) is fake, advanced by hand. WHY fake timers
 * and not a seam: createDeadline owns real timers, so the budget logic under test is only reachable through them.
 */

const SINGLETON = `http://127.0.0.1:${DECIDER_SINGLETON_PORT}`;
// WHY a short timeout: fake timers mean a broken memo or deadline shows up as a promise that never settles, which would otherwise sit out the 15 minute default.
vi.setConfig({ testTimeout: 10_000 });
const REPLY = { model: "elephant-1", answers: { q: true }, usage: { input_tokens: 5, output_tokens: 1 } };

/** A fetch answering the singleton: refused while `up.value` is false, a loaded decider that answers decisions once true. */
function singletonFetch(up: { value: boolean }, seen: string[] = []): GlobalFetch {
  return async (url) => {
    seen.push(url);
    if (!up.value) throw new Error("connect ECONNREFUSED");
    if (url === `${SINGLETON}/health`) return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
    if (url === `${SINGLETON}/v1/systemone`) return new Response(JSON.stringify(REPLY), { status: 200 });
    throw new Error(`unexpected url ${url}`);
  };
}

function run(settings: Record<string, unknown>, fetchImpl: GlobalFetch, decider: Partial<LocalDeciderDeps>, extra: { requestTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<LocalEscalation> {
  return answerWithLocalDecider({
    settings: { local_fallback: settings },
    ...(extra.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: extra.requestTimeoutMs }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    fetchImpl,
    call: { state: { text: "x" }, questions: { q: { type: "yes_no" } } },
    decider: { platform: "darwin", ...decider },
  });
}

/** Counts scans; an empty scan means "no mlx-decision server is running". */
function scanCounter(): { discover: () => Promise<[]>; count: () => number } {
  let n = 0;
  return {
    discover: async () => {
      n++;
      return [];
    },
    count: () => n,
  };
}

const GOVERNOR_KEYS = ["LLM_EXT_GOVERNOR_ENABLED", "LLM_EXT_GOVERNOR_DIR", "LLM_EXT_GOVERNOR_MAX_INFERENCES", "LLM_EXT_GOVERNOR_SETTLE_MS"];
const savedGovernorEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  __resetLocalFallbackForTests();
  for (const key of GOVERNOR_KEYS) savedGovernorEnv.set(key, process.env[key]);
  // WHY the governor is off for every test but the governor group: the retry-policy tests run on a fake clock, and a
  // real lease wait (file lock, CPU sampling) does not advance on it. The governor group turns it on with real timers.
  process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
});
afterEach(() => {
  vi.useRealTimers();
  __resetLocalFallbackForTests();
  for (const [key, value] of savedGovernorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("local fallback defaults", () => {
  it("the default url is the singleton login agent port, and the retired start-path keys are gone", () => {
    expect(LOCAL_FALLBACK_DEFAULTS.url).toBe("http://127.0.0.1:8123");
    expect(DECIDER_SINGLETON_PORT).toBe(8123);
    expect(Object.keys(LOCAL_FALLBACK_DEFAULTS).sort()).toEqual(["attemptTimeoutMs", "enabled", "maxAttempts", "requestTimeoutMs", "startTimeoutMs", "url"]);
  });
});

describe("answerWithLocalDecider — a not-ready singleton", () => {
  it("rescans every 2000 ms and ends within requestTimeoutMs, then answers a retryable refusal", async () => {
    const scans = scanCounter();
    const up = { value: false };
    let done = false;
    const p = run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), { discover: scans.discover, singletonInstalled: () => true });
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(true);
    const r = await p;
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("no mlx-decision server is running yet");
    // Looks at t=0, 2000 and 4000; the next 2000 ms pause would end past the 5000 ms budget, so the loop stops.
    expect(scans.count()).toBe(3);
  });

  it("the second escalation of the process looks ONCE and returns at once (fast-fail memo)", async () => {
    const scans = scanCounter();
    const up = { value: false };
    const deps = { discover: scans.discover, singletonInstalled: () => true };
    const first = run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), deps);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    expect(scans.count()).toBe(3);
    // No timer advance: if the memo did not short-circuit the loop, this would wait on a fake 2000 ms sleep forever.
    const second = await run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), deps);
    expect(second.ok).toBe(false);
    expect(scans.count()).toBe(4);
  });

  it("the memo expires after 60 s: the next escalation searches the whole budget again", async () => {
    const scans = scanCounter();
    const up = { value: false };
    const deps = { discover: scans.discover, singletonInstalled: () => true };
    const first = run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), deps);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    await vi.advanceTimersByTimeAsync(61_000);
    const before = scans.count();
    const again = run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), deps);
    await vi.advanceTimersByTimeAsync(5000);
    await again;
    expect(scans.count() - before).toBe(3);
  });

  it("the test reset hook clears the memo", async () => {
    const scans = scanCounter();
    const up = { value: false };
    const deps = { discover: scans.discover, singletonInstalled: () => true };
    const first = run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), deps);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    __resetLocalFallbackForTests();
    const before = scans.count();
    const again = run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), deps);
    await vi.advanceTimersByTimeAsync(5000);
    await again;
    expect(scans.count() - before).toBe(3);
  });

  it("a success resets the memo, so a later outage is searched for the whole budget again", async () => {
    const scans = scanCounter();
    const up = { value: false };
    const deps = { discover: scans.discover, singletonInstalled: () => true };
    const settings = { requestTimeoutMs: 5000, attemptTimeoutMs: 1000 };
    const down = run(settings, singletonFetch(up), deps);
    await vi.advanceTimersByTimeAsync(5000);
    await down;
    // The memo is live, but the singleton is up now: the single look succeeds and the answer is the local reply.
    up.value = true;
    const ok = await run(settings, singletonFetch(up), deps);
    expect(ok.ok).toBe(true);
    up.value = false;
    const before = scans.count();
    const again = run(settings, singletonFetch(up), deps);
    await vi.advanceTimersByTimeAsync(5000);
    await again;
    expect(scans.count() - before).toBe(3);
  });

  /** A fetch that always answers /health with nothing loaded (a singleton stuck loading), counting every request. */
  function loadingFetch(seen: string[]): GlobalFetch {
    return async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ status: "ok", loaded: [] }), { status: 200 });
    };
  }

  it("the outer request deadline aborts the wait for a loading singleton and the message keeps the real cause", async () => {
    // The singleton answers /health forever with nothing loaded and startTimeoutMs is its default 300000, so only
    // the signal derived from the outer deadline can end the wait at the 1000 ms budget. WHY the budget comes from
    // the override and not requestTimeoutMs: config.ts now refuses a startTimeoutMs above requestTimeoutMs.
    const seen: string[] = [];
    let done = false;
    const p = run({}, loadingFetch(seen), { discover: scanCounter().discover, singletonInstalled: () => true }, { requestTimeoutMs: 1000 });
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(true);
    const r = await p;
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain("ran out of its 1000 ms budget");
    // WHY: the user must read WHY (the singleton is up but still loading), not "the lookup was aborted".
    expect(reason).toContain("was still loading its model");
    expect(reason).not.toContain("lookup was aborted");
    // Polls every 500 ms: a handful of probes, never the 600 a 5 minute wait would make.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThanOrEqual(5);
  });

  /** The configured budget of the memo tests: 1 s, with the default 300 s load wait that the budget has to cut. */
  const SHORT_BUDGET = { requestTimeoutMs: 1000, attemptTimeoutMs: 1000 };

  it("a configured budget that ends while the singleton is still loading ARMS the fast-fail memo, and the memo expires after 60 s", async () => {
    const seen: string[] = [];
    const deps = { discover: scanCounter().discover, singletonInstalled: () => true };
    const first = run(SHORT_BUDGET, loadingFetch(seen), deps);
    await vi.advanceTimersByTimeAsync(1500);
    await first;
    const afterFirst = seen.length;
    // 30 s later the memo is still live: no timer advance, one /health probe, and the refusal still names the cause.
    await vi.advanceTimersByTimeAsync(30_000);
    const second = await run(SHORT_BUDGET, loadingFetch(seen), deps);
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toContain("is still loading its model");
    expect(seen.length - afterFirst).toBe(1);
    // 62 s after the memo was armed it has expired: the next escalation waits out its budget again.
    await vi.advanceTimersByTimeAsync(32_000);
    const before = seen.length;
    const third = run(SHORT_BUDGET, loadingFetch(seen), deps);
    await vi.advanceTimersByTimeAsync(1500);
    await third;
    expect(seen.length - before).toBeGreaterThan(1);
  });

  it("an escalation with a SHORTENED budget (ping) that finds nothing does not arm the memo: a following full escalation still searches", async () => {
    const seen: string[] = [];
    const deps = { discover: scanCounter().discover, singletonInstalled: () => true };
    // Ping style: the caller shortens the 1000 ms configured budget to 500 ms and the singleton is still loading.
    const short = run(SHORT_BUDGET, loadingFetch(seen), deps, { requestTimeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await short).ok).toBe(false);
    const before = seen.length;
    // The full escalation must wait (poll /health) for its whole configured budget, not fast-fail on one probe.
    const full = run(SHORT_BUDGET, loadingFetch(seen), deps);
    await vi.advanceTimersByTimeAsync(1500);
    await full;
    expect(seen.length - before).toBeGreaterThan(1);
  });

  it("the request budget override is clamped to the configured requestTimeoutMs, never longer", async () => {
    const seen: string[] = [];
    let done = false;
    const p = run({ requestTimeoutMs: 1000, attemptTimeoutMs: 1000, startTimeoutMs: 1000 }, loadingFetch(seen), { discover: scanCounter().discover, singletonInstalled: () => true }, { requestTimeoutMs: 30000 });
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(true);
    const r = await p;
    expect((r as { reason: string }).reason).toContain("1000 ms");
  });

  it("a load wait longer than attemptTimeoutMs does not eat the budget of the first POST", async () => {
    // The singleton loads for 1500 ms; attemptTimeoutMs is 1000 and the POST itself takes 800 ms. With the attempt
    // timer started BEFORE the lookup it would already be spent when the POST begins (1500 > 1000) and the POST would
    // be aborted at once; started after the lookup the POST has its whole 1000 ms.
    const t0 = Date.now();
    let posted = false;
    const f: GlobalFetch = (url, init) => {
      if (url === `${SINGLETON}/health`) {
        const loaded = Date.now() - t0 >= 1500 ? ["elephant-1"] : [];
        return Promise.resolve(new Response(JSON.stringify({ status: "ok", loaded }), { status: 200 }));
      }
      if (url !== `${SINGLETON}/v1/systemone`) return Promise.reject(new Error(`unexpected url ${url}`));
      posted = true;
      return new Promise<Response>((resolve, reject) => {
        if (init.signal?.aborted) return reject(new Error("the POST got an already aborted signal"));
        const timer = setTimeout(() => resolve(new Response(JSON.stringify(REPLY), { status: 200 })), 800);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("the POST was aborted"));
        }, { once: true });
      });
    };
    const p = run({ requestTimeoutMs: 8000, attemptTimeoutMs: 1000, startTimeoutMs: 4000, maxAttempts: 1 }, f, { discover: scanCounter().discover, singletonInstalled: () => true });
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(posted).toBe(true);
    expect(r.ok).toBe(true);
    // Every deadline, probe timer and poll sleep of the whole escalation was cleared.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lookups do not consume maxAttempts: a singleton ready after more rescans than maxAttempts is still reached", async () => {
    // maxAttempts is 2 and the singleton shows up on the 5th look (t = 8000 ms, inside the 30 s budget). Counting
    // lookups as attempts would have given up after the 2nd.
    const up = { value: false };
    let looks = 0;
    const discover = async (): Promise<{ pid: number; urls: string[] }[]> => {
      looks++;
      if (looks >= 5) up.value = true;
      return up.value ? [{ pid: 23342, urls: [SINGLETON] }] : [];
    };
    const p = run({ requestTimeoutMs: 30000, attemptTimeoutMs: 1000, startTimeoutMs: 1000, maxAttempts: 2 }, singletonFetch(up), { discover, singletonInstalled: () => true });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(looks).toBe(5);
  });
});

describe("answerWithLocalDecider — a refusal time cannot heal", () => {
  it("not installed: one look, no retry, no memo", async () => {
    const scans = scanCounter();
    const up = { value: false };
    // No timer advance: a retry would sit on a fake 2000 ms sleep and this await would never return.
    const r = await run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), { discover: scans.discover, singletonInstalled: () => false });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("mlx-decision is not installed");
    expect(scans.count()).toBe(1);
    const again = await run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch(up), { discover: scans.discover, singletonInstalled: () => false });
    expect(again.ok).toBe(false);
    expect(scans.count()).toBe(2);
  });

  it("a non-macOS platform: one look, the scan is never run", async () => {
    const scans = scanCounter();
    const r = await run({ requestTimeoutMs: 5000, attemptTimeoutMs: 1000 }, singletonFetch({ value: false }), { discover: scans.discover, platform: "linux" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("runs only on macOS");
    expect(scans.count()).toBe(0);
  });
});

describe("answerWithLocalDecider — the machine-wide governor lease", () => {
  // Real timers and the real governor in a temp dir: the lease wait is file-lock and CPU-sampling work that a fake clock
  // cannot advance. max_inferences 1 makes a lease held by the test block the escalation exactly as another process would.
  const GOVERNED = { requestTimeoutMs: 20_000, attemptTimeoutMs: 1000, startTimeoutMs: 1000, maxAttempts: 1 };
  const held: Lease[] = [];
  let root: string;
  let govDir: string;

  beforeEach(() => {
    vi.useRealTimers();
    root = mkdtempSync("/tmp/govfb-");
    govDir = `${root}/gov`;
    Object.assign(process.env, {
      LLM_EXT_GOVERNOR_ENABLED: "true",
      LLM_EXT_GOVERNOR_DIR: govDir,
      LLM_EXT_GOVERNOR_MAX_INFERENCES: "1",
      LLM_EXT_GOVERNOR_SETTLE_MS: "100",
    });
  });
  afterEach(() => {
    for (const lease of held.splice(0)) release(lease);
    withdraw();
    rmSync(root, { recursive: true, force: true });
  });

  const deps = { discover: async () => [{ pid: 23342, urls: [SINGLETON] }], singletonInstalled: () => true };

  /** A live singleton whose decision POST counts itself, takes postMs (100 ms by default), and fails or hangs on demand. */
  function postingFetch(mode: "ok" | "throw" | "hang" = "ok", postMs = 100): { fetchImpl: GlobalFetch; posts: () => number } {
    let posts = 0;
    const fetchImpl: GlobalFetch = (url, init) => {
      if (url === `${SINGLETON}/health`) return Promise.resolve(new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 }));
      if (url !== `${SINGLETON}/v1/systemone`) return Promise.reject(new Error(`unexpected url ${url}`));
      posts++;
      if (init.signal?.aborted) return Promise.reject(new Error("the POST got an already aborted signal"));
      if (mode === "throw") return Promise.reject(new Error("connect ECONNRESET"));
      return new Promise<Response>((resolve, reject) => {
        const timer = mode === "hang" ? undefined : setTimeout(() => resolve(new Response(JSON.stringify(REPLY), { status: 200 })), postMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("the POST was aborted"));
        }, { once: true });
      });
    };
    return { fetchImpl, posts: () => posts };
  }

  async function until(what: string, cond: () => boolean): Promise<void> {
    const end = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("a lease held elsewhere makes the escalation wait, it proceeds after release, and the wait does not eat attemptTimeoutMs", async () => {
    held.push(await acquire({ timeoutMs: 60_000 }));
    const srv = postingFetch();
    let done = false;
    const p = run(GOVERNED, srv.fetchImpl, deps);
    void p.then(() => (done = true));
    await until("the escalation to queue for the lease", () => snapshot().waiters.length === 1);
    // Wait well past attemptTimeoutMs (1000 ms): were the attempt timer started before the lease, the POST would be aborted at once.
    await new Promise((r) => setTimeout(r, 1500));
    expect(done).toBe(false);
    expect(srv.posts()).toBe(0);
    release(held.pop() as Lease);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(srv.posts()).toBe(1);
    expect(snapshot().leases).toHaveLength(0);
  });

  it("the lease is given back after a success, after a POST failure and after an attempt timeout", async () => {
    for (const mode of ["ok", "throw", "hang"] as const) {
      __resetLocalFallbackForTests();
      const srv = postingFetch(mode);
      const r = await run(GOVERNED, srv.fetchImpl, deps);
      expect(r.ok).toBe(mode === "ok");
      expect(srv.posts()).toBe(1);
      expect(snapshot().leases).toHaveLength(0);
    }
  });

  // TRDD-O93LFMF3 Q4 (decided on TRDD-WSPV40Y5, 2026-11-14): a full machine queues, it never fails the request. USER 2026-10-28
  // "not having enough memory is not a failure, requests queue"; USER 2026-11-10 "just wait until the previous tool completed the
  // request to the server"; USER 2026-11-11 request budget 400 s, attempt 200 s. The request budget covers the server request only.
  it("a lease wait longer than the request budget is not cut: the slot is granted after the budget has passed and the request is sent", async () => {
    held.push(await acquire({ timeoutMs: 60_000 }));
    const srv = postingFetch();
    let done = false;
    const p = run({ ...GOVERNED, requestTimeoutMs: 1500 }, srv.fetchImpl, deps);
    void p.then(() => (done = true));
    await until("the escalation to queue for the lease", () => snapshot().waiters.length === 1);
    // Past the 1500 ms budget: the old behaviour failed the request here as "ran out of its 1500 ms budget".
    await new Promise((r) => setTimeout(r, 2200));
    expect(done).toBe(false);
    expect(srv.posts()).toBe(0);
    expect(snapshot().waiters).toHaveLength(1);
    release(held.pop() as Lease);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(srv.posts()).toBe(1);
    expect(snapshot().waiters).toHaveLength(0);
    expect(snapshot().leases).toHaveLength(0);
  });

  it("after a decider lookup that used nearly the whole request budget and a longer lease wait, the POST still gets a full attempt", async () => {
    // WHY: the rebuilt request deadline is max(budget left, attemptTimeoutMs). With only the ~300 ms the lookup left, a 600 ms POST would be aborted
    // right after the grant, so a machine that merely queued the request would fail it.
    held.push(await acquire({ timeoutMs: 60_000 }));
    const srv = postingFetch("ok", 600);
    const slowDiscover = async (): Promise<{ pid: number; urls: string[] }[]> => {
      await new Promise((r) => setTimeout(r, 2700));
      return [{ pid: 23342, urls: [SINGLETON] }];
    };
    let done = false;
    const p = run({ ...GOVERNED, requestTimeoutMs: 3000 }, srv.fetchImpl, { discover: slowDiscover, singletonInstalled: () => true });
    void p.then(() => (done = true));
    await until("the escalation to queue for the lease", () => snapshot().waiters.length === 1);
    // Past the 3000 ms request budget in total (2700 ms lookup + this wait).
    await new Promise((r) => setTimeout(r, 1000));
    expect(done).toBe(false);
    release(held.pop() as Lease);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(srv.posts()).toBe(1);
    expect(snapshot().leases).toHaveLength(0);
  });

  it("a command stop during the lease wait ends it at once as the stop: nothing is sent, no waiter is left, the reason is the stop", async () => {
    held.push(await acquire({ timeoutMs: 60_000 }));
    const srv = postingFetch();
    // WHY fresh modules: the command stop is a one-way module flag with no reset, and a stop left set would fail every later test of this file.
    vi.resetModules();
    try {
      const stop = await import("../../command-stop.js");
      const fresh = await import("./local-fallback.js");
      const p = fresh.answerWithLocalDecider({
        settings: { local_fallback: GOVERNED },
        fetchImpl: srv.fetchImpl,
        call: { state: { text: "x" }, questions: { q: { type: "yes_no" } } },
        decider: { platform: "darwin", ...deps },
      });
      await until("the escalation to queue for the lease", () => snapshot().waiters.length === 1);
      const t0 = Date.now();
      stop.stopCommand("stopped by the lease-wait test");
      const r = await p;
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).toContain("stopped by the lease-wait test");
      expect(stop.isCommandStopped()).toBe(true);
      expect(srv.posts()).toBe(0);
      expect(snapshot().waiters).toHaveLength(0);
    } finally {
      vi.resetModules();
    }
  });

  it("a 'no decider' memo does not touch the lease wait: the decider lookup is one look, and the lease wait still runs past the request budget until the slot is free", async () => {
    const budget = { ...GOVERNED, requestTimeoutMs: 3000 };
    const up = { value: false };
    const seen: string[] = [];
    const fetchImpl = singletonFetch(up, seen);
    const discover = async (): Promise<{ pid: number; urls: string[] }[]> => (up.value ? [{ pid: 23342, urls: [SINGLETON] }] : []);
    // First escalation: no decider for the whole configured budget (looks at t = 0 and 2000 ms), so it arms unavailableUntil.
    const first = await run(budget, fetchImpl, { discover, singletonInstalled: () => true });
    expect((first as { reason: string }).reason).toContain("no mlx-decision server is running yet");
    // The decider is up now, the lease is held: with the memo live the lookup is a single look that succeeds.
    up.value = true;
    held.push(await acquire({ timeoutMs: 60_000 }));
    let done = false;
    const second = run(budget, fetchImpl, { discover, singletonInstalled: () => true });
    void second.then(() => (done = true));
    await until("the escalation to queue for the lease", () => snapshot().waiters.length === 1);
    // Past the 3000 ms request budget (and the 2000 ms rescan interval): the wait is not cut by either.
    await new Promise((r) => setTimeout(r, 3500));
    expect(done).toBe(false);
    expect(seen).not.toContain(`${SINGLETON}/v1/systemone`);
    release(held.pop() as Lease);
    expect((await second).ok).toBe(true);
    expect(seen).toContain(`${SINGLETON}/v1/systemone`);
  });

  it("a governor that cannot answer fails the escalation at once, naming its directory, without a send", async () => {
    // The governor dir sits under a regular file, so it cannot be created.
    const blocker = `${root}/blocker`;
    writeFileSync(blocker, "x");
    process.env.LLM_EXT_GOVERNOR_DIR = `${blocker}/gov`;
    const srv = postingFetch();
    const r = await run(GOVERNED, srv.fetchImpl, deps);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("local inference governor");
    expect(srv.posts()).toBe(0);
  });

  it("governor disabled: the POST goes out directly and the governor dir is never touched", async () => {
    process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
    const srv = postingFetch();
    const r = await run(GOVERNED, srv.fetchImpl, deps);
    expect(r.ok).toBe(true);
    expect(srv.posts()).toBe(1);
    expect(existsSync(govDir)).toBe(false);
  });
});
