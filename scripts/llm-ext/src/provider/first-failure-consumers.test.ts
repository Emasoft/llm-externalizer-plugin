/**
 * first-failure-consumers.test.ts — TRDD-YG72CYY7 inc 3 round B2: what the outer layers do with the first-failure
 * verdict fetchWithRetry429 stamps (the chatCompletionWithRetry gate, the breaker, classifyError, the 429 ledger).
 *
 * REAL node:http / node:https servers and real sockets; the code under test is never mocked. classifyError is
 * reached through its test export on a fresh index.ts import (the same recipe retry-clock-consumers.test.ts uses).
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCompletionWithRetry, chatCompletionSimple, resetServiceHealthForTests, serviceFailureCountForTests } from "./completion.js";
import { failureOf, type RetryClock } from "./http.js";
import { readModelEvents, getModelEventsPath } from "../model-events.js";
import type { BackendConfig, CompletionDeps, ChatMessage } from "./types.js";

let server: Server | undefined;
beforeEach(() => resetServiceHealthForTests());
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function startServer(handler: (n: number, res: ServerResponse) => void) {
  let count = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // GETs are the client's model-info probes, not completion requests.
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    const n = ++count;
    req.resume();
    req.on("end", () => handler(n, res));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, requestCount: () => count };
}

const reply = (status: number, body = "{}") => (_n: number, res: ServerResponse) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
};

function depsFor(url: string): CompletionDeps {
  const backend: BackendConfig = { type: "local", billable: false, isLocal: false, baseUrl: url, apiKey: "k", model: "m", __version: 1 };
  return {
    getBackend: () => backend,
    apiHeaders: () => ({ "Content-Type": "application/json" }),
    routeForModel: () => null,
    routeHeaders: () => ({ "Content-Type": "application/json" }),
    getSoftTimeoutMs: () => 30_000,
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

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e) as Promise<Error | undefined>;
/** A SHARED clock ({} given) lets the test read clock.attempts: total HTTP attempts across the whole outer loop. */
const outer = (url: string, clock: RetryClock = {}) => caught(chatCompletionWithRetry(MESSAGES, { model: "m", retryClock: clock }, depsFor(url)));

async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

describe("the outer gate reads the verdict: the whole call is one budget, not one per outer retry", () => {
  it("a 504-always server gets exactly 3 requests in total (HEAD: 12), breaker +1", async () => {
    const { url, requestCount } = await startServer(reply(504));
    const clock: RetryClock = {};
    const err = await outer(url, clock);
    expect(err?.message).toMatch(/^API error 504 \(local\)/);
    expect(requestCount()).toBe(3);
    expect(failureOf(err)?.final).toBe("budget");
    expect(serviceFailureCountForTests()).toBe(1);
  }, 60_000);

  it("a refused endpoint gets exactly 2 connection attempts in total (HEAD: 8) and the breaker counts it", async () => {
    const clock: RetryClock = {};
    const err = await outer(await closedPortUrl(), clock);
    expect(err?.message).toBe("fetch failed");
    expect(clock.attempts).toBe(2);
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
    expect(serviceFailureCountForTests()).toBe(1);
  }, 60_000);

  it("pin: a reset connection (no verdict) is still retried by the outer loop (more than 2 attempts)", async () => {
    server = createServer((req) => { req.socket.destroy(); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const clock: RetryClock = { deadlineAt: Date.now() + 4000 };
    const err = await outer(`http://127.0.0.1:${port}`, clock);
    expect(failureOf(err)?.final).toBeUndefined();
    expect(clock.attempts).toBeGreaterThan(2);
  }, 60_000);
});

describe("TLS stop: one request, never breaker food", () => {
  let cert: string;
  let key: string;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "llm-ext-tls-b2-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe" });
    cert = readFileSync(join(dir, "c.pem"), "utf8");
    key = readFileSync(join(dir, "k.pem"), "utf8");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a self-signed endpoint: 1 attempt in total and the breaker count does not increase", async () => {
    const https = createHttpsServer({ cert, key }, (_req, res) => { res.end("{}"); });
    await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
    const { port } = https.address() as { port: number };
    try {
      const clock: RetryClock = {};
      const err = await outer(`https://127.0.0.1:${port}`, clock);
      expect(failureOf(err)?.final).toBe("stop");
      expect(clock.attempts).toBe(1);
      expect(serviceFailureCountForTests()).toBe(0);
    } finally {
      https.closeAllConnections();
      https.close();
    }
  }, 60_000);
});

describe("pins: verdicts that keep their own handling (the gate must not touch them)", () => {
  it("402 (payment): requests and thrown error as today", async () => {
    const { url, requestCount } = await startServer(reply(402, JSON.stringify({ error: { message: "Insufficient credits", code: 402 } })));
    const err = await outer(url);
    expect(err?.message).toMatch(/^API error 402/);
    expect(requestCount()).toBe(1);
    expect(failureOf(err)?.final).toBeUndefined();
  }, 60_000);

  it("a gone model (classifyUnavailable): requests and thrown error as today", async () => {
    const { url, requestCount } = await startServer(reply(404, JSON.stringify({ error: { message: "No endpoints found for m.", code: 404 } })));
    const err = await outer(url);
    expect(err?.message).toMatch(/^API error 404/);
    expect(requestCount()).toBe(1);
  }, 60_000);

  it("a daily-quota error: requests and thrown error as today", async () => {
    const { url, requestCount } = await startServer(reply(400, JSON.stringify({ error: { message: "daily quota exceeded for this model", code: 400 } })));
    const err = await outer(url);
    expect(err?.message).toMatch(/^API error 400/);
    expect(requestCount()).toBe(1);
  }, 60_000);

  it("401 (owner ruling 2026-10-23, TRDD-YG72CYY7 Q1): one request, no same-model retry, breaker untouched, on a real always-401 server", async () => {
    const { url, requestCount } = await startServer(reply(401, JSON.stringify({ error: { message: "User not found.", code: 401 } })));
    const err = await outer(url);
    expect(err?.message).toMatch(/^API error 401/);
    expect(requestCount()).toBe(1);
    expect(serviceFailureCountForTests()).toBe(0);
    expect(failureOf(err)?.final).toBeUndefined();
  }, 120_000);
});

describe("429 ledger detail", () => {
  async function ledgerFor(body: string): Promise<string> {
    const cfg = mkdtempSync(join("/tmp", "llm-ext-ledger-"));
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    try {
      const { url } = await startServer(reply(429, body));
      // The call's FINAL attempt is a 429 (the window closes), so clock.lastProvider is that response's provider.
      await caught(chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), { deadlineAt: Date.now() + 1500 }));
      const events = readModelEvents({ path: getModelEventsPath() }).filter((e) => e.kind === "rate_limit_429");
      expect(events).toHaveLength(1);
      return events[0].detail;
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      rmSync(cfg, { recursive: true, force: true });
    }
  }

  it("names the provider when the 429 body carries one", async () => {
    expect(await ledgerFor(JSON.stringify({ error: { message: "rate limited", code: 429, metadata: { provider_name: "Venice" } } }))).toBe("429 during call from Venice");
  }, 60_000);

  it("is the old text when no provider is known", async () => {
    expect(await ledgerFor("{}")).toBe("429 during call");
  }, 60_000);
});

const YAML = `active: bare
allow_paid_models: true
profiles:
  bare:
    mode: remote
    api: openrouter-remote
    model: vendor/whatever
    api_key: "sk-test-fake-openrouter-key"
`;

async function loadFreshIndex() {
  const cfgDir = mkdtempSync(join("/tmp", "llm-ext-ffc-cfg-"));
  writeFileSync(join(cfgDir, "settings.yaml"), YAML, "utf-8");
  const prev = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  const idx = await import("../index.js");
  const { ProfileExhaustedError } = await import("../profile-fallback.js");
  return {
    idx,
    ProfileExhaustedError,
    cleanup: () => {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      rmSync(cfgDir, { recursive: true, force: true });
    },
  };
}

describe("classifyError reads the verdict (D3)", () => {
  // Real stamped errors: a 504 budget error from a real server; the refusal from a real closed port.
  async function real504(): Promise<Error> {
    const { url } = await startServer(reply(504));
    const err = await caught(chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), {}));
    server?.closeAllConnections();
    server?.close();
    return err!;
  }

  it("a final error is unrecoverable, counts as a failure, and the reason carries the hint", async () => {
    const { idx, cleanup } = await loadFreshIndex();
    try {
      const err = await real504();
      const v = idx.__classifyErrorForTests(err);
      expect(v).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
      expect(v.reason).toBe(`${err.message} (${failureOf(err)!.hint})`);
      expect(v.reason).toContain("too large or too slow");
    } finally {
      cleanup();
    }
  }, 60_000);

  it("a STATIC exhaustion whose causes are ALL final takes the same branch", async () => {
    const { idx, ProfileExhaustedError, cleanup } = await loadFreshIndex();
    try {
      const err = await real504();
      const v = idx.__classifyErrorForTests(new ProfileExhaustedError("p", "static", [err, err]));
      expect(v).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
      expect(v.reason).toContain("too large or too slow");
    } finally {
      cleanup();
    }
  }, 60_000);

  it("two different final causes: both hints appear once each, in cause order", async () => {
    const { idx, ProfileExhaustedError, cleanup } = await loadFreshIndex();
    try {
      const gateway = await real504();
      const refused = (await caught(chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(await closedPortUrl()), {})))!;
      const v = idx.__classifyErrorForTests(new ProfileExhaustedError("p", "static", [gateway, refused, gateway]));
      expect(v).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
      const hints = [failureOf(gateway)!.hint!, failureOf(refused)!.hint!];
      expect(hints[0]).not.toBe(hints[1]);
      for (const h of hints) expect(v.reason.split(h).length - 1).toBe(1);
      expect(v.reason.indexOf(hints[0])).toBeLessThan(v.reason.indexOf(hints[1]));
      // " | " joins the hints: "; " also occurs inside the off-OpenRouter ECONNREFUSED hint.
      expect(v.reason).toContain(`${hints[0]} | ${hints[1]}`);
    } finally {
      cleanup();
    }
  }, 60_000);
  it("a static exhaustion with a NON-final cause is unchanged (recoverable default)", async () => {
    const { idx, ProfileExhaustedError, cleanup } = await loadFreshIndex();
    try {
      const err = await real504();
      const v = idx.__classifyErrorForTests(new ProfileExhaustedError("p", "static", [err, new Error("API error 503 (local): overloaded")]));
      expect(v.unrecoverable).toBeFalsy();
      expect(v.countsAsFailure).toBeUndefined();
    } finally {
      cleanup();
    }
  }, 60_000);

  it("pin: a mixed [402, final] static exhaustion keeps today's classification (all causes means all)", async () => {
    const { idx, ProfileExhaustedError, cleanup } = await loadFreshIndex();
    try {
      const err = await real504();
      const v = idx.__classifyErrorForTests(new ProfileExhaustedError("p", "static", [new Error("API error 402 (openrouter): Insufficient credits"), err]));
      expect(v.unrecoverable).toBeFalsy(); // today: 402 plus a transient cause is the recoverable default, not the batch abort
      expect(v.reason).not.toContain("too large or too slow");
    } finally {
      cleanup();
    }
  }, 60_000);

  it("a DYNAMIC exhaustion with all-final causes keeps today's path (failDynamicProfile already ran, 7f87b85): service-level abort with its own message", async () => {
    const { idx, ProfileExhaustedError, cleanup } = await loadFreshIndex();
    try {
      const err = await real504();
      const dyn = new ProfileExhaustedError("free", "dynamic", [err]);
      expect(idx.__classifyErrorForTests(dyn)).toEqual({ unrecoverable: true, serviceLevel: true, reason: dyn.message });
    } finally {
      cleanup();
    }
  }, 60_000);

  it("401 batch abort, today's way (SERVICE_LEVEL_STATUS_RE on a plain 401 error; no verdict is read)", async () => {
    const { idx, cleanup } = await loadFreshIndex();
    try {
      const v = idx.__classifyErrorForTests(new Error("API error 401 (openrouter): User not found."));
      expect(v.unrecoverable).toBe(true);
      expect(v.serviceLevel).toBe(true);
    } finally {
      cleanup();
    }
  });
});
