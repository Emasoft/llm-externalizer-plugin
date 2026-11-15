// Review of 4856f009, finding 4: classify honours --command_timeout like every other request path. Once the command is
// stopping (cli/main.ts armCommandTimeout calls stopCommand at expiry), no new request and no retry is sent, the answers
// already received are kept as a partial result, and the run exits 124. Real catalog, endpoints and decisions replies
// recorded by P-01/P-02, served through the GlobalFetch seam; no network.
// WHY a file of its own and a fresh module graph per test: the stop flag is module state with no reset (a command stops
// once), so it must not leak into the other classify tests or into the next test here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../config.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import type { RunDeps } from "./run-decision.js";

const KEY = "sk-or-v1-CTSECRETKEYVALUE0123456789abcdef0123";
const STOP = "--command_timeout: the command ran longer than 1 s and was stopped";
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

/** The real P-01 noul reply, re-labeled to the question keys of the request. */
function relabeled(questions: Record<string, unknown>): Response {
  const rec = fx("p01", "dec-noul");
  const body = JSON.parse(rec.body) as { answers: Record<string, unknown> };
  const real = body.answers.is_bug!;
  body.answers = Object.fromEntries(Object.keys(questions).map((k) => [k, real]));
  return replayFixture({ ...rec, body: JSON.stringify(body) });
}

/** Catalog and endpoints from P-02 (Jev the only System One model, so no fallback is tried); `onDecision` answers each decisions request. */
function serve(onDecision: (n: number, questions: Record<string, unknown>) => Response): { fetch: GlobalFetch; decisions: number } {
  const s = { decisions: 0, fetch: (async () => new Response()) as GlobalFetch };
  s.fetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) {
      const body = JSON.parse(fx("p02", "models-decisions").body) as { data: { id: string; description?: string }[] };
      body.data = body.data.filter((m) => m.id.includes("typesafe/") || !/system\s*one/i.test(m.description ?? ""));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    s.decisions++;
    return onDecision(s.decisions, (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
  };
  return s;
}

let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join("/tmp", "llm-ext-cmd-timeout-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, CT_TEST_KEY: process.env.CT_TEST_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.CT_TEST_KEY = KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

const deps = (fetch: GlobalFetch, over: Record<string, unknown> = {}): RunDeps => ({
  settings: { active: "c", active_classifier: "c", profiles: { c: { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$CT_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 1, ...over } as unknown as Profile } },
  fetch,
  catalogOptions: { path: join(tmp, "catalog.json") },
  sigint: new EventEmitter(),
  // WHY the local decider is OFF here: these tests pin what --command_timeout does to REMOTE requests, and a
  // local answer would hide the stop. WHY off explicitly and not merely left out: an absent section means
  // ENABLED by default, so a failing remote call would reach — or start — the real 15 GB decider.
  localFallback: { enabled: false },
});
const input = (n: number) => ({ input: { question: "Does it fail?", items: Array.from({ length: n }, (_, k) => ({ id: `f.log:${k + 1}`, text: `line number ${k}` })) } });

describe("classify and --command_timeout", () => {
  it("after the stop no new request is sent: the answers received are kept, the rest are not_sent_timeout, stopped timeout, exit 124", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { stopCommand } = await import("../command-stop.js");
    const { spec } = await import("./catalog/filter.js");
    // The timeout expires while the first request is in flight: that request is answered, the next two never start.
    const s = serve((_n, q) => {
      stopCommand(STOP);
      return relabeled(q);
    });
    const out = await runDecision(spec, input(3), deps(s.fetch));
    expect(s.decisions).toBe(1);
    expect(out.exitCode).toBe(124);
    const env = out.envelope!;
    expect(env.stopped).toBe("timeout");
    expect((env.decision as { matched_count: number }).matched_count).toBe(1);
    const invalid = (env.decision as { invalid: { reason: string }[] }).invalid;
    expect(invalid.map((i) => i.reason)).toEqual([`not_sent_timeout: ${STOP}`, `not_sent_timeout: ${STOP}`]);
    expect(env.warnings.find((w) => w.code === "command-timeout-stop")?.message).toBe("--command_timeout stopped the run: 2 of 3 requests not sent; the answers already received are kept");
    // The partial result is printed: the stdout text is the envelope.
    expect(JSON.parse(out.text!)).toEqual(JSON.parse(JSON.stringify(env)));
  });

  it("a retry is not sent after the stop: a 503 during the timeout ends that request, no second send", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { stopCommand } = await import("../command-stop.js");
    const { spec } = await import("./catalog/filter.js");
    const s = serve(() => {
      stopCommand(STOP);
      return syntheticResponse(503, JSON.stringify({ error: { code: 503, message: "busy" } }), { "content-type": "application/json", "retry-after-ms": "1" });
    });
    const out = await runDecision(spec, input(1), deps(s.fetch, { max_attempts: 3 }));
    expect(s.decisions).toBe(1);
    expect(out.exitCode).toBe(124);
    expect(out.envelope!.stopped).toBe("timeout");
  });

  it("a run that is never stopped is unchanged: every request is sent, stopped null, exit 0", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { spec } = await import("./catalog/filter.js");
    const s = serve((_n, q) => relabeled(q));
    const out = await runDecision(spec, input(3), deps(s.fetch));
    expect(s.decisions).toBe(3);
    expect(out.exitCode).toBe(0);
    expect(out.envelope!.stopped).toBeNull();
  });
});


// TRDD-O93LFMF3: the local decider tier (answerWithLocalDecider) must end with the command stop like the remote path. WHY a
// describe of its own: these tests turn the local fallback ON (the tests above keep it off) and drive a real governor in a /tmp dir
// (never the real one); the decider is a fetch + discover seam, so no real server is contacted.
describe("classify, --command_timeout and the local decider tier", () => {
  const DECIDER = "http://127.0.0.1:8000";
  const GOV_ENV = ["LLM_EXT_GOVERNOR_ENABLED", "LLM_EXT_GOVERNOR_DIR", "LLM_EXT_GOVERNOR_MAX_INFERENCES", "LLM_EXT_GOVERNOR_SETTLE_MS"];
  let govPrev: Record<string, string | undefined>;
  beforeEach(() => {
    govPrev = Object.fromEntries(GOV_ENV.map((k) => [k, process.env[k]]));
    process.env.LLM_EXT_GOVERNOR_DIR = `${tmp}/gov`;
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "100";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(govPrev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** Resolves after ms, or rejects with an AbortError as soon as signal aborts (what a real fetch does). */
  const abortableSleep = (ms: number, signal?: AbortSignal | null) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });

  type StopAt = "lease-wait" | "remote" | "local-post" | "after-local-reply";
  async function run(o: { governor: boolean; n: number; concurrency: number; stopAt: StopAt; localPostMs?: number }) {
    process.env.LLM_EXT_GOVERNOR_ENABLED = String(o.governor);
    const { runDecision } = await import("./run-decision.js");
    const cs = await import("../command-stop.js");
    const { spec } = await import("./catalog/filter.js");
    const gov = await import("../governor/client.js");
    let stopFired = false;
    let tStop = 0;
    const stop = () => { stopFired = true; tStop = Date.now(); cs.stopCommand(STOP); };
    const ev = { healthAfterStop: 0, postsStarted: 0, postsAfterStop: 0, postAborted: false, discoverCalls: 0, discoverAfterStop: 0 };
    const stderr: string[] = [];
    const fetch: GlobalFetch = async (url, init) => {
      if (url.startsWith(DECIDER) || url.includes("127.0.0.1")) {
        if (url.endsWith("/health")) {
          if (stopFired) ev.healthAfterStop++;
          return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
        }
        ev.postsStarted++;
        if (stopFired) ev.postsAfterStop++;
        const q = (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;
        if (o.stopAt === "local-post" && ev.postsStarted === 1) {
          setTimeout(stop, 300);
          try { await abortableSleep(o.localPostMs ?? 3000, init.signal); } catch (e) { ev.postAborted = true; throw e; }
        }
        const real = (JSON.parse(fx("p01", "dec-noul").body) as { answers: Record<string, unknown> }).answers.is_bug;
        return new Response(JSON.stringify({ model: "elephant-1", answers: Object.fromEntries(Object.keys(q).map((k) => [k, real])), usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
      }
      if (url.includes("output_modalities=decisions")) {
        const body = JSON.parse(fx("p02", "models-decisions").body) as { data: { id: string; description?: string }[] };
        body.data = body.data.filter((m) => m.id.includes("typesafe/") || !/system\s*one/i.test(m.description ?? ""));
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
      if (o.stopAt === "remote") stop();
      return syntheticResponse(503, JSON.stringify({ error: { code: 503, message: "busy" } }), { "content-type": "application/json" });
    };
    const d = deps(fetch, { concurrency: o.concurrency });
    const full: RunDeps = {
      ...d,
      // WHY the stop fires from here for "after-local-reply": the only stderr line of a governor-off run is the local_decider notice, which exec says AFTER answerWithLocalDecider returned ok and before it returns the reply, so the stop lands exactly in the window a wrongly added throwIfStopped on the success path would break (deterministic, no timers).
      stderr: (l: string) => { stderr.push(l); if (o.stopAt === "after-local-reply" && !stopFired) stop(); },
      localFallback: { requestTimeoutMs: 20_000, attemptTimeoutMs: 2000, startTimeoutMs: 1000, maxAttempts: 1 },
      localFallbackDeps: { discover: async () => { ev.discoverCalls++; if (stopFired) ev.discoverAfterStop++; return [{ pid: 23342, urls: [DECIDER] }]; }, singletonInstalled: () => true, platform: "darwin" },
    };
    let held: Awaited<ReturnType<typeof gov.acquire>> | undefined;
    if (o.governor && o.stopAt === "lease-wait") held = await gov.acquire({ timeoutMs: 120_000 });
    const p = runDecision(spec, input(o.n), full);
    if (o.governor && o.stopAt === "lease-wait") {
      // Wait until the first escalation is queued in the governor, then stop while it waits for the lease.
      const end = Date.now() + 15_000;
      while (gov.snapshot().waiters.length < 1 && Date.now() < end) await sleep(20);
      expect(gov.snapshot().waiters.length).toBeGreaterThanOrEqual(1);
      await sleep(300);
      stop();
    }
    const out = await p;
    const returnedAfterStopMs = Date.now() - tStop;
    if (held) gov.release(held);
    gov.withdraw();
    return { out, ev, stderr, returnedAfterStopMs };
  }
  const reasons = (env: { decision: unknown }) => (env.decision as { invalid: { reason: string }[] }).invalid.map((i) => i.reason);

  it("a stop during a held governor lease ends the request as stopped, not as the remote failure", async () => {
    const { out, stderr } = await run({ governor: true, n: 1, concurrency: 1, stopAt: "lease-wait" });
    const env = out.envelope!;
    expect(out.exitCode).toBe(124);
    expect(env.stopped).toBe("timeout");
    expect(env.warnings.some((w) => w.code === "command-timeout-stop")).toBe(true);
    expect(reasons(env).some((r) => r.startsWith("invalid_response"))).toBe(false);
    expect(stderr.some((l) => l.includes("did not answer either"))).toBe(false);
  });

  it("two concurrent escalations behind a held lease: after the stop no /health probe is sent and the queued request ends stopped", async () => {
    const { out, ev, returnedAfterStopMs } = await run({ governor: true, n: 2, concurrency: 2, stopAt: "lease-wait" });
    const env = out.envelope!;
    expect(ev.healthAfterStop).toBe(0);
    expect(ev.postsAfterStop).toBe(0);
    expect(env.stopped).toBe("timeout");
    // Generous bound only (the oneAtATime queue wait is not signal-tied, TRDD-CBOTP0DY): far under the 20 s request budget.
    expect(returnedAfterStopMs).toBeLessThan(10_000);
    const rs = reasons(env);
    expect(rs.length).toBe(2);
    expect(rs.some((r) => r.startsWith("invalid_response"))).toBe(false);
  });

  it("governor disabled: no POST starts after the stop, the in-flight POST is aborted and its request is stopped", async () => {
    const { out, ev } = await run({ governor: false, n: 2, concurrency: 2, stopAt: "local-post" });
    const env = out.envelope!;
    expect(ev.postsAfterStop).toBe(0);
    expect(ev.postAborted).toBe(true);
    expect(ev.postsStarted).toBe(1);
    expect(reasons(env).length).toBe(2);
    expect(out.exitCode).toBe(124);
    expect(env.stopped).toBe("timeout");
    expect((env.decision as { matched_count: number }).matched_count).toBe(0);
    expect(reasons(env).some((r) => r.startsWith("invalid_response"))).toBe(false);
  });

  it("a stop during the remote attempts: the request ends stopped and the decider is never looked up", async () => {
    const { out, ev } = await run({ governor: false, n: 1, concurrency: 1, stopAt: "remote" });
    const env = out.envelope!;
    expect(out.exitCode).toBe(124);
    expect(env.stopped).toBe("timeout");
    expect(reasons(env).some((r) => r.startsWith("invalid_response"))).toBe(false);
    expect(ev.discoverCalls).toBe(0);
    expect(ev.postsStarted).toBe(0);
  });

  it("a local reply that completed before the stop is kept: request answered, local_decider warning", async () => {
    const { out } = await run({ governor: false, n: 1, concurrency: 1, stopAt: "after-local-reply" });
    const env = out.envelope!;
    expect(env.warnings.some((w) => w.code === "local_decider")).toBe(true);
    expect((env.decision as { invalid: unknown[] }).invalid).toEqual([]);
    // Observed, deterministic: the one request was answered before anything was left unsent, so runDecision reports a clean run (cli/main.ts then forces 124 because the stop flag is set).
    expect(out.exitCode).toBe(0);
    expect(env.stopped).toBeNull();
  });
});
