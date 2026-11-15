// TRDD-O93LFMF3 (mirrors 23726401, which did this for run-decision): a command stop (--command_timeout or --stop_on_errors, the shared state in
// command-stop.ts) must end classify ping's local decider tier and ping must say it was stopped, not report the remote error.
// WHY a file of its own and a fresh module graph per test: the stop flag is module state with no reset (a command stops once).
// Real governor in a /tmp dir (never the real one); the decider and the remote service are the one fetch seam, so no network and
// never the real mlx-decision server on 127.0.0.1:8123.
// WHY wide time bounds: machine load stretches timers (TRDD-CBOTP0DY); only an order of magnitude is asserted.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../../config.js";
import type { GlobalFetch } from "../l0/transport.js";
import { badResponseError } from "../l0/errors.js";
import { exitCodeForError } from "../l2/attention.js";

const KEY = "ping-stop-test-key-not-real";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const DECIDER = "http://127.0.0.1:8000";
const STOP = "--command_timeout: the command ran longer than 1 s and was stopped";
const STOPPED_LINE = "llm-ext: classify ping was stopped (--command_timeout)";
const GOV_ENV = ["LLM_EXT_GOVERNOR_ENABLED", "LLM_EXT_GOVERNOR_DIR", "LLM_EXT_GOVERNOR_MAX_INFERENCES", "LLM_EXT_GOVERNOR_SETTLE_MS"];

let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join("/tmp", "llm-ext-ping-stop-"));
  prev = Object.fromEntries(["LLM_EXT_CONFIG_DIR", "PING_STOP_KEY", ...GOV_ENV].map((k) => [k, process.env[k]]));
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.PING_STOP_KEY = KEY;
  process.env.LLM_EXT_GOVERNOR_DIR = `${tmp}/gov`;
  process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
  process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "100";
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Resolves after ms, or rejects with an AbortError as soon as signal aborts (what a real fetch does). */
const abortableSleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });

/** When the command stop is fired: while the escalation waits for the governor lease, 300 ms into the first local POST, or inside the first remote 500 reply. */
type StopAt = "lease-wait" | "local-post" | "remote";

async function drive(o: { governor: boolean; stopAt: StopAt; maxAttempts: number; localPostMs?: number; attemptMs?: number }) {
  process.env.LLM_EXT_GOVERNOR_ENABLED = String(o.governor);
  const { runPing } = await import("./ping.js");
  const cs = await import("../../command-stop.js");
  const gov = await import("../../governor/client.js");
  let stopFired = false;
  const stop = () => { stopFired = true; cs.stopCommand(STOP); };
  const ev = { remoteCalls: 0, healthTotal: 0, postsStarted: 0, postAborted: false };
  const fetchImpl: GlobalFetch = async (url, init) => {
    if (url === KEY_URL) return new Response(JSON.stringify({ data: { usage: 1, limit: 10, limit_remaining: 9 } }), { status: 200 });
    if (url.startsWith(DECIDER) || url.includes("127.0.0.1")) {
      if (url.endsWith("/health")) {
        ev.healthTotal++;
        return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
      }
      ev.postsStarted++;
      if (o.localPostMs !== undefined) {
        if (o.stopAt === "local-post" && ev.postsStarted === 1) setTimeout(stop, 300);
        try { await abortableSleep(o.localPostMs, init.signal); } catch (e) { ev.postAborted = true; throw e; }
      }
      return new Response(JSON.stringify({ model: "elephant-1", answers: { ping: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
    }
    ev.remoteCalls++;
    if (o.stopAt === "remote" && ev.remoteCalls === 1) stop();
    return new Response(JSON.stringify({ error: { code: 500, message: "remote-marker-boom" } }), { status: 500 });
  };
  const profile = { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$PING_STOP_KEY", max_attempts: o.maxAttempts, timeout_ms: 120_000, concurrency: 1 };
  const out: string[] = [];
  const err: string[] = [];
  let held: Awaited<ReturnType<typeof gov.acquire>> | undefined;
  const started = Date.now();
  try {
    if (o.governor && o.stopAt === "lease-wait") held = await gov.acquire({ timeoutMs: 120_000 });
    const p = runPing([], undefined, {
      settings: { active: "c", active_classifier: "c", profiles: { c: profile as unknown as Profile } },
      fetch: fetchImpl,
      sigint: new EventEmitter(),
      stdout: (t) => out.push(t),
      stderr: (line) => err.push(line),
      localFallback: { attemptTimeoutMs: o.attemptMs ?? 2000, startTimeoutMs: 1000, maxAttempts: 1 },
      localFallbackDeps: { discover: async () => [{ pid: 23342, urls: [DECIDER] }], singletonInstalled: () => true, platform: "darwin" },
    });
    if (o.governor && o.stopAt === "lease-wait") {
      // Wait until the escalation is queued in the governor, then stop while it waits for the lease.
      const end = Date.now() + 15_000;
      while (gov.snapshot().waiters.length < 1 && Date.now() < end) await sleep(20);
      expect(gov.snapshot().waiters.length).toBeGreaterThanOrEqual(1);
      await sleep(300);
      stop();
    }
    const exitCode = await p;
    return { exitCode, ev, out, err, wallMs: Date.now() - started, stopFired };
  } finally {
    if (held) gov.release(held);
    gov.withdraw();
  }
}


type DeciderMode = "ok" | "500" | "unusable" | "slow-ok" | "slow-unusable";

/**
 * TRDD-O93LFMF3, remote timeout escalation: the remote service hangs until the 1 s deadline or answers a fast 500, and the decider answers as the mode says
 * (slow-ok = a usable reply after 1.5 s, i.e. after the deadline). Governor off; the hang and the slow reply abort on init.signal like a real fetch.
 */
async function driveRemoteFailure(o: { remote: "hang" | "500"; decider: DeciderMode; sigintAtMs?: number }) {
  process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
  const { runPing } = await import("./ping.js");
  const sigint = new EventEmitter();
  const ev = { remoteCalls: 0, healthTotal: 0, postsStarted: 0 };
  const okReply = () => new Response(JSON.stringify({ model: "elephant-1", answers: { ping: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
  const fetchImpl: GlobalFetch = async (url, init) => {
    if (url === KEY_URL) return new Response(JSON.stringify({ data: { usage: 1, limit: 10, limit_remaining: 9 } }), { status: 200 });
    if (url.includes("127.0.0.1")) {
      if (url.endsWith("/health")) {
        ev.healthTotal++;
        return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
      }
      ev.postsStarted++;
      if (o.decider === "500") return new Response(JSON.stringify({ error: { code: 500, message: "decider-marker-boom" } }), { status: 500 });
      if (o.decider === "slow-unusable" || o.decider === "slow-ok") await abortableSleep(1500, init.signal);
      if (o.decider === "unusable" || o.decider === "slow-unusable") return new Response(JSON.stringify({ model: "elephant-1", answers: { ping: { type: "noul" } }, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
      return okReply();
    }
    ev.remoteCalls++;
    if (o.remote === "hang") {
      if (o.sigintAtMs !== undefined) setTimeout(() => sigint.emit("SIGINT"), o.sigintAtMs);
      await abortableSleep(60_000, init.signal);
    }
    return new Response(JSON.stringify({ error: { code: 500, message: "remote-marker-boom" } }), { status: 500 });
  };
  const profile = { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$PING_STOP_KEY", max_attempts: 1, timeout_ms: 1000, concurrency: 1 };
  const out: string[] = [];
  const err: string[] = [];
  const started = Date.now();
  const exitCode = await runPing([], undefined, {
    settings: { active: "c", active_classifier: "c", profiles: { c: profile as unknown as Profile } },
    fetch: fetchImpl,
    sigint,
    stdout: (t) => out.push(t),
    stderr: (line) => err.push(line),
    localFallback: { attemptTimeoutMs: 5000, startTimeoutMs: 1000, maxAttempts: 1 },
    localFallbackDeps: { discover: async () => [{ pid: 23342, urls: [DECIDER] }], singletonInstalled: () => true, platform: "darwin" },
  });
  return { exitCode, ev, out, err, wallMs: Date.now() - started };
}

describe("classify ping and a command stop (TRDD-O93LFMF3)", () => {
  it("a stop during a held governor lease ends ping as stopped, exit 124, not as the remote failure", async () => {
    const r = await drive({ governor: true, stopAt: "lease-wait", maxAttempts: 1 });
    expect(r.stopFired).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(r.err.filter((l) => l.startsWith("llm-ext: classify ping was stopped ("))).toEqual([STOPPED_LINE]);
    expect(r.err.some((l) => l.includes("did not answer either"))).toBe(false);
    expect(r.err.some((l) => l.includes("API error 500"))).toBe(false);
  }, 60_000);

  it("governor off: a stop 300 ms into an 8 s local POST aborts that POST and ping returns promptly, exit 124", async () => {
    const r = await drive({ governor: false, stopAt: "local-post", maxAttempts: 1, localPostMs: 8000, attemptMs: 20_000 });
    expect(r.ev.postsStarted).toBe(1);
    expect(r.ev.postAborted).toBe(true);
    expect(r.wallMs).toBeLessThan(5000);
    expect(r.exitCode).toBe(124);
    expect(r.err).toContain(STOPPED_LINE);
  }, 60_000);

  it("a stop inside the only remote reply: the decider is never probed nor called, exit 124", async () => {
    const r = await drive({ governor: false, stopAt: "remote", maxAttempts: 1 });
    expect(r.ev.remoteCalls).toBe(1);
    expect(r.ev.healthTotal).toBe(0);
    expect(r.ev.postsStarted).toBe(0);
    expect(r.exitCode).toBe(124);
    expect(r.err).toEqual([STOPPED_LINE]);
  }, 60_000);

  it("a stop after the first of three remote attempts: no second attempt, no escalation, exit 124 and the stopped line", async () => {
    const r = await drive({ governor: false, stopAt: "remote", maxAttempts: 3 });
    expect(r.ev.remoteCalls).toBe(1);
    expect(r.ev.healthTotal).toBe(0);
    expect(r.ev.postsStarted).toBe(0);
    expect(r.exitCode).toBe(124);
    expect(r.err).toEqual([STOPPED_LINE]);
  }, 60_000);
});


// TRDD-O93LFMF3: a remote TIMEOUT is the common case for the local fallback (run-decision.ts:455-463), so ping escalates on it too; Ctrl-C never does.
describe("classify ping falls back to the local decider when the remote call times out (TRDD-O93LFMF3)", () => {
  it("a remote call that hangs to the deadline is answered by the local decider: exit 0, one decider POST, and stderr says the remote call failed", async () => {
    const r = await driveRemoteFailure({ remote: "hang", decider: "ok" });
    expect(r.exitCode).toBe(0);
    expect(r.ev.postsStarted).toBe(1);
    expect(r.out.join("\n")).toContain("the local decider");
    expect(r.err.some((l) => l.startsWith("llm-ext: the remote call failed: deadline exceeded") && l.endsWith("; answered by the local decider"))).toBe(true);
  }, 60_000);

  it("a remote timeout and a decider that refuses: exit 5, the decider was tried, the outcome stays deadline exceeded and no \"failed before the deadline\" line is printed", async () => {
    const r = await driveRemoteFailure({ remote: "hang", decider: "500" });
    expect(r.exitCode).toBe(5);
    expect(r.ev.healthTotal + r.ev.postsStarted).toBeGreaterThanOrEqual(1);
    const text = r.err.join("\n");
    expect(text).toContain("did not answer either");
    expect(text).toContain("classify ping failed: deadline exceeded");
    expect(text).not.toContain("failed before the deadline");
  }, 60_000);

  it("a remote timeout and a decider reply with no usable ping answer: exit 5 as a bad response, not relabelled deadline exceeded", async () => {
    const r = await driveRemoteFailure({ remote: "hang", decider: "unusable" });
    expect(r.exitCode).toBe(exitCodeForError(badResponseError("x")));
    const text = r.err.join("\n");
    expect(text).toContain("bad response");
    expect(text).not.toContain("deadline exceeded");
  }, 60_000);

  it("Ctrl-C during the remote hang ends ping as interrupted, exit 130, and the decider is never probed nor called", async () => {
    const r = await driveRemoteFailure({ remote: "hang", decider: "ok", sigintAtMs: 300 });
    expect(r.exitCode).toBe(130);
    expect(r.ev.healthTotal).toBe(0);
    expect(r.ev.postsStarted).toBe(0);
    expect(r.err).toContain("llm-ext: interrupted by Ctrl-C");
  }, 60_000);

  it("a fast remote 500 whose local answer arrives after the deadline still succeeds, exit 0, and says the local decider answered", async () => {
    const r = await driveRemoteFailure({ remote: "500", decider: "slow-ok" });
    expect(r.exitCode).toBe(0);
    expect(r.ev.postsStarted).toBe(1);
    expect(r.err.some((l) => l.startsWith("llm-ext: the remote call failed: ") && l.endsWith("; answered by the local decider"))).toBe(true);
  }, 60_000);

  it("a fast remote 500 whose late local reply has no usable answer ends as a bad response, exit 5, not relabelled deadline exceeded", async () => {
    const r = await driveRemoteFailure({ remote: "500", decider: "slow-unusable" });
    expect(r.exitCode).toBe(exitCodeForError(badResponseError("x")));
    expect(r.ev.postsStarted).toBe(1);
    const text = r.err.join("\n");
    expect(text).toContain("bad response");
    expect(text).not.toContain("deadline exceeded");
  }, 60_000);
});
