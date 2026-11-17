/**
 * network-give-up-dispatch.test.ts — TRDD-PN0N4290 (increment 1b of TRDD-WSPV40Y5): the give-up window through the real completion layer
 * (chatCompletionWithRetry, the call every dispatch funnels through) and through index.ts, which builds the window onto the dispatch clock.
 *
 * REAL node:http servers, a REAL closed port and a REAL `.invalid` name; nothing is mocked. The readiness fixture is real files (see
 * network-give-up.test.ts). The window is set small through the settings key (index test, closed port) and the flag (`.invalid`) so each
 * case keeps the under-5 s bound of Required test 3 even though the default is 30 s.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordFixture } from "./calibration/test-record.js";
import { writeRecord } from "./calibration/record.js";
import { loadSettings, type Settings } from "./config.js";
import { makeNetworkGiveUp, setNetworkGiveUpOverrideS } from "./network-give-up.js";
import { chatCompletionWithRetry, resetServiceHealthForTests } from "./provider/completion.js";
import { failureOf, type RetryClock } from "./provider/http.js";
import type { BackendConfig, ChatMessage, CompletionDeps } from "./provider/types.js";
// TRDD-FC2TX9VU: the governor switch as this file found it; the afterEach of the governor-off describe restores it.
const GOVERNOR_ENABLED_BEFORE = process.env.LLM_EXT_GOVERNOR_ENABLED;

const MODEL = "ggml-org/tiny-llamas/stories15M-q4_0.gguf";
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
const LINUX = { platform: "linux", arch: "x64" };

const servers: Server[] = [];
const dirs: string[] = [];
beforeEach(() => {
  resetServiceHealthForTests();
  setNetworkGiveUpOverrideS(undefined);
});
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setNetworkGiveUpOverrideS(undefined);
  vi.unstubAllEnvs();
});

function tempDir(kind: string): string {
  const d = mkdtempSync(join("/tmp", `llm-ext-ngud-${kind}-`));
  dirs.push(d);
  return d;
}

async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

async function resetServer(): Promise<string> {
  const server = createServer();
  server.on("connection", (socket) => socket.resetAndDestroy());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A ready local_llama (binary on a throwaway PATH, model in a hub-layout cache, ok record) so the window can arm. */
function readyFixture(withRecord = true): { settings: Settings; cfgDir: string; env: NodeJS.ProcessEnv } {
  const cfgDir = tempDir("cfg");
  const binDir = tempDir("bin");
  const cache = tempDir("cache");
  writeFileSync(
    join(cfgDir, "settings.yaml"),
    ["active: local_llama", "profiles:", "  local_llama:", "    profile-type: local", "    mode: local", "    api: llamacpp-local", "    url: http://127.0.0.1:8181", "    server: managed", `    model: ${MODEL}`, ""].join("\n"),
    "utf-8",
  );
  writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(join(binDir, "llama-server"), 0o755);
  const repo = join(cache, "models--ggml-org--tiny-llamas");
  mkdirSync(join(repo, "refs"), { recursive: true });
  writeFileSync(join(repo, "refs", "main"), "rev1", "utf-8");
  mkdirSync(join(repo, "snapshots", "rev1"), { recursive: true });
  writeFileSync(join(repo, "snapshots", "rev1", "stories15M-q4_0.gguf"), "not real weights: readiness only checks that the file exists", "utf-8");
  if (withRecord) writeRecord(cfgDir, recordFixture("llama", MODEL));
  vi.stubEnv("LLM_EXT_CONFIG_DIR", cfgDir);
  const settings = loadSettings();
  if (settings === null) throw new Error("fixture settings.yaml did not load");
  return { settings, cfgDir, env: { PATH: binDir, LLAMA_CACHE: cache } };
}

function depsFor(url: string): CompletionDeps {
  const backend: BackendConfig = { type: "local", billable: false, isLocal: false, baseUrl: url, apiKey: "k", model: "m", __version: 1 };
  return {
    getBackend: () => backend,
    apiHeaders: () => ({ "Content-Type": "application/json" }),
    routeForModel: () => null,
    routeHeaders: () => ({ "Content-Type": "application/json" }),
    getSoftTimeoutMs: () => 60_000,
    isFreeOnly: () => false,
    isLMStudioProvider: () => false,
    getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.5 }),
    getEnsemblePriceCeilingUsd: () => 1.3,
    defaultTemperature: 0.7,
    getDefaultMaxTokens: () => 256,
    getRequestOptions: () => null,
  };
}

const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Required test 3: time-bound at the completion layer with a ready local profile, window armed small (2 s)", () => {
  // WHY (TRDD-FC2TX9VU): these tests assert the network give-up bound from t0. Every send to 127.0.0.1 first takes a local-governor
  // lease (completion.ts:619, directAttemptGate), and a lease wait before attempt 0 is not part of the network window and can last any
  // time ("requests queue, nothing fails"). Measured 2026-11-17: with a forced governor denial the 5_000 ms bound failed 3 of 3 runs
  // (7073, 7418, 7346 ms), and the release gate failed with 9442 ms. These tests are about the network window, not queueing, so the
  // governor is off for them; the afterEach below restores the variable.
  beforeEach(() => {
    process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
  });
  afterEach(() => {
    if (GOVERNOR_ENABLED_BEFORE === undefined) delete process.env.LLM_EXT_GOVERNOR_ENABLED;
    else process.env.LLM_EXT_GOVERNOR_ENABLED = GOVERNOR_ENABLED_BEFORE;
  });
  it("a real closed port: the typed network error is thrown in under 5 s", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(2);
    const url = await closedPortUrl();
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const t0 = Date.now();
    const err = await caught(chatCompletionWithRetry(MESSAGES, { model: "vendor/m", maxTokens: 64, retryClock: clock }, depsFor(url)));
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 60_000);

  it("a real unresolvable `.invalid` host: the typed network error is thrown in under 5 s", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(2);
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const t0 = Date.now();
    const err = await caught(chatCompletionWithRetry(MESSAGES, { model: "vendor/m", maxTokens: 64, retryClock: clock }, depsFor("http://no-such-host.invalid")));
    expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(failureOf(err)?.networkCode);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 60_000);

  it("a server that resets every connection (31 s of retries without the window): the typed ECONNRESET error in under 5 s, and the completion layer does NOT re-run the call", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(2);
    const url = await resetServer();
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const t0 = Date.now();
    const err = await caught(chatCompletionWithRetry(MESSAGES, { model: "vendor/m", maxTokens: 64, retryClock: clock }, depsFor(url)));
    expect(failureOf(err)?.networkCode).toBe("ECONNRESET");
    // final: budget is what stops the model-level retry loop of completion.ts from re-entering a fresh window.
    expect(failureOf(err)?.final).toBe("budget");
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 60_000);

  it("UNARMED (no ready local profile) the same reset server is still being retried past the window", async () => {
    const f = readyFixture(false);
    setNetworkGiveUpOverrideS(2);
    const url = await resetServer();
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const ac = new AbortController();
    let settled = false;
    const pending = caught(chatCompletionWithRetry(MESSAGES, { model: "vendor/m", maxTokens: 64, retryClock: clock, signal: ac.signal }, depsFor(url))).then((e) => {
      settled = true;
      return e;
    });
    await sleep(4_000);
    expect(settled, "no ready local target: the window never arms, the retries run on").toBe(false);
    ac.abort();
    await pending;
  }, 60_000);
});

describe("index.ts builds the window onto the dispatch clock", () => {
  const closed = (): RetryClock => ({ startedAt: Date.now() - 10, expired: true });

  /** index.ts reads settings once at import: re-import fresh over a throwaway config dir so every module shares one registry. */
  async function withIndex<T>(yaml: string, body: (idx: typeof import("./index.js")) => Promise<T>): Promise<T> {
    const cfgDir = tempDir("idx");
    writeFileSync(join(cfgDir, "settings.yaml"), yaml, "utf-8");
    vi.stubEnv("LLM_EXT_CONFIG_DIR", cfgDir);
    vi.stubEnv("LLM_EXT_INSTALL_RULE", "0");
    vi.stubEnv("HOME", tempDir("home"));
    vi.stubEnv("LLM_EXT_DISABLE_AUTO_RECONCILE", "1");
    vi.stubEnv("LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION", "1");
    vi.resetModules();
    return body(await import("./index.js"));
  }

  // TRDD-WSPV40Y5 F1: the window is armed only for a built-in dynamic profile (the only ones tryLocalFallback falls back for), so the
  // fixture is the generated `free` profile; the old fixture, a static user profile, is STATIC_REMOTE and must get no window.
  const REMOTE = (extra = "") =>
    `active: free\nallow_paid_models: true\n${extra}profiles:\n  # <-- do not touch, generated by llm-ext -->\n  free:\n    mode: remote\n    api: openrouter-remote\n    free_only: true\n    free_models: [vendor/whatever:free]\n    model: vendor/whatever:free\n    api_key: "test-key-not-a-secret" # ubs:ignore (test fixture, not a key)\n`;
  const STATIC_REMOTE = `active: bare\nallow_paid_models: true\nnetwork_give_up_seconds: 7\nprofiles:\n  bare:\n    mode: remote\n    api: openrouter-remote\n    model: vendor/whatever\n    api_key: "test-key-not-a-secret" # ubs:ignore (test fixture, not a key)\n`;
  const LOCAL = `active: lc\nprofiles:\n  lc:\n    mode: local\n    api: llamacpp-local\n    url: http://127.0.0.1:1\n    model: m\n`;

  it("a remote active profile: the clock gets the window from settings.yaml network_give_up_seconds (default 30 s without it)", async () => {
    await withIndex(REMOTE("network_give_up_seconds: 7\n"), async (idx) => {
      const clock = closed();
      await caught(idx.__ensembleStreamingForTests(MESSAGES, { modelOverride: "vendor/whatever:free" }, clock));
      expect(clock.networkGiveUp?.windowMs).toBe(7_000);
    });
    await withIndex(REMOTE(), async (idx) => {
      const clock = closed();
      await caught(idx.__ensembleStreamingForTests(MESSAGES, { modelOverride: "vendor/whatever:free" }, clock));
      expect(clock.networkGiveUp?.windowMs).toBe(30_000);
    });
  });

  it("the flag wins over the settings key", async () => {
    await withIndex(REMOTE("network_give_up_seconds: 7\n"), async (idx) => {
      const gu = await import("./network-give-up.js");
      gu.setNetworkGiveUpOverrideS(3);
      const clock = closed();
      await caught(idx.__ensembleStreamingForTests(MESSAGES, { modelOverride: "vendor/whatever:free" }, clock));
      expect(clock.networkGiveUp?.windowMs).toBe(3_000);
      gu.setNetworkGiveUpOverrideS(undefined);
    });
  });

  it("a STATIC user-defined remote profile gets no window (TRDD-WSPV40Y5 F1: no local fallback follows it, so the retry budget stays whole)", async () => {
    await withIndex(STATIC_REMOTE, async (idx) => {
      const clock = closed();
      await caught(idx.__ensembleStreamingForTests(MESSAGES, { modelOverride: "vendor/whatever" }, clock));
      expect(clock.networkGiveUp).toBeUndefined();
    });
  });

  it("a LOCAL active profile has no remote to give up on: no window on the clock", async () => {
    await withIndex(LOCAL, async (idx) => {
      const clock = closed();
      await caught(idx.__ensembleStreamingForTests(MESSAGES, { modelOverride: "m" }, clock));
      expect(clock.networkGiveUp).toBeUndefined();
    });
  });

  it("a clock a caller seeded with its own window keeps it", async () => {
    await withIndex(REMOTE(), async (idx) => {
      const own = { windowMs: 1_234, arm: () => Promise.resolve(false) };
      const clock: RetryClock = { ...closed(), networkGiveUp: own };
      await caught(idx.__ensembleStreamingForTests(MESSAGES, { modelOverride: "vendor/whatever:free" }, clock));
      expect(clock.networkGiveUp).toBe(own);
    });
  });
});
