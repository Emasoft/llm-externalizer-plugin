/**
 * classify-failure.test.ts — TRDD-YG72CYY7 inc 3 round B1: the first-failure verdict
 * (classifyFailure) and its consumption in fetchWithRetry429.
 *
 * REAL node:http / node:https / node:net servers and real sockets; nothing under test is mocked and
 * dns.lookup / fetch are never stubbed. Status bodies not recorded from a provider are `synthetic:`.
 * Assertions are request counts and error classes, never durations (except the pure D8 floor test).
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCompletionSimple, chatCompletionJSON } from "./completion.js";
import {
  classifyFailure,
  computeBackoffMs,
  consumesAttempt,
  failureOf,
  fetchWithRetry429,
  networkCodeOf,
  type RetryClock,
} from "./http.js";
import type { BackendConfig, CompletionDeps, ChatMessage } from "./types.js";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

type Handler = (n: number, req: IncomingMessage, res: ServerResponse) => void;

async function startServer(handler: Handler) {
  let count = 0;
  server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    const n = ++count;
    req.resume();
    req.on("end", () => handler(n, req, res));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, requestCount: () => count };
}

const reply = (status: number, body = "{}") => (_n: number, _req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
};

function depsFor(url: string): CompletionDeps {
  const backend: BackendConfig = {
    type: "local", billable: false, isLocal: false, baseUrl: url, apiKey: "k", model: "m", __version: 1,
  };
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
  };
}

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
const OK_BODY = JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "m" });
const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e) as Promise<Error | undefined>;

async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/x`;
}

describe("computeBackoffMs: the Retry-After floor (D8)", () => {
  it("a Retry-After of 45 s is never undercut by the cap or the jitter", () => {
    for (let i = 0; i < 500; i++) expect(computeBackoffMs(0, 45_000)).toBeGreaterThanOrEqual(45_000);
  });
  it("a negative Retry-After clamps to no floor", () => {
    for (let i = 0; i < 200; i++) {
      const wait = computeBackoffMs(0, -5000);
      expect(wait).toBeGreaterThanOrEqual(750);
      expect(wait).toBeLessThanOrEqual(1250);
    }
  });
  it("the exponential term alone stays capped at 30 s plus jitter", () => {
    expect(computeBackoffMs(20, 0)).toBeLessThanOrEqual(37_500);
  });
});

describe("classifyFailure verdict table", () => {
  const OR = "openrouter.ai";
  it("statuses with no verdict of their own: 401, 402, 403, 404, 410, 408, 409, 429, 500, 502, 503, 529", () => {
    for (const status of [401, 402, 403, 404, 408, 409, 410, 429, 500, 502, 503, 529]) {
      expect(classifyFailure({ status }, OR)).toEqual({});
    }
  });
  it("504 gets a budget of 3 and the too-large-or-slow hint", () => {
    const v = classifyFailure({ status: 504 }, OR);
    expect(v.budget).toEqual({ key: "504", tries: 3 });
    expect(v.hint).toContain("too large or too slow");
  });
  it("ECONNREFUSED gets a budget of 2 refusals and a hint naming the host", () => {
    const v = classifyFailure({ networkCode: "ECONNREFUSED" }, "localhost");
    expect(v.budget).toEqual({ key: "ECONNREFUSED", tries: 2 });
    expect(v.hint).toBe("nothing is listening at localhost; is the local runner started?");
  });

  it("the ECONNREFUSED hint asks about the local runner only off the OpenRouter host, and never prints an empty host", () => {
    expect(classifyFailure({ networkCode: "ECONNREFUSED" }, "openrouter.ai").hint).toBe("nothing is listening at openrouter.ai");
    expect(classifyFailure({ networkCode: "ECONNREFUSED" }, "").hint).toBe("nothing is listening at the configured endpoint; is the local runner started?");
  });

  it("TLS codes stop at once", () => {
    for (const code of ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"]) {
      expect(classifyFailure({ networkCode: code }, OR).stop).toBe(true);
    }
  });
  it("resets, timeouts and unknown codes keep today full-window retry", () => {
    for (const networkCode of ["ECONNRESET", "ETIMEDOUT", "ETIMEDOUT-LOCAL", "EPIPE", "UND_ERR_SOCKET", "SOMETHING_NEW"]) {
      expect(classifyFailure({ networkCode }, OR)).toEqual({});
    }
    expect(classifyFailure({}, OR)).toEqual({});
  });
  it("synthetic: a name-lookup failure on the OpenRouter host is neverSent with no budget (full window, D7)", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND openrouter.ai"), { code: "ENOTFOUND" }) });
    const url = "https://openrouter.ai/api/v1/chat/completions";
    const code = networkCodeOf(err, url);
    expect(code).toBe("ENOTFOUND");
    expect(classifyFailure({ networkCode: code }, "openrouter.ai")).toEqual({ neverSent: true });
    expect(classifyFailure({ networkCode: "EAI_AGAIN" }, "api.openrouter.ai")).toEqual({ neverSent: true });
  });

  it("D7 gives an attempt back only when a clock bounds the call", () => {
    const lookup = classifyFailure({ networkCode: "ENOTFOUND" }, "openrouter.ai");
    expect(consumesAttempt(lookup, undefined)).toBe(true);
    expect(consumesAttempt(lookup, {})).toBe(false);
    expect(consumesAttempt(classifyFailure({ networkCode: "ECONNRESET" }, "openrouter.ai"), {})).toBe(true);
    expect(consumesAttempt(classifyFailure({ status: 504 }, "openrouter.ai"), {})).toBe(true);
  });

  it("a name-lookup failure off the OpenRouter host (also a lookalike) gets a budget of 2", () => {
    for (const host of ["localhost", "nonexistent.invalid", "notopenrouter.ai", "openrouter.ai.evil.example"]) {
      expect(classifyFailure({ networkCode: "ENOTFOUND" }, host).budget).toEqual({ key: "dns", tries: 2 });
    }
  });
});

describe("fetchWithRetry429 consumes the verdict at the first failure", () => {
  it("synthetic: 408 is retried (2 requests, then success)", async () => {
    const { url, requestCount } = await startServer((n, _q, res) => reply(n === 1 ? 408 : 200, n === 1 ? "{}" : OK_BODY)(n, _q, res));
    const res = await fetchWithRetry429(url, { method: "POST", body: "{}" }, 30_000, Date.now());
    expect(res.status).toBe(200);
    expect(requestCount()).toBe(2);
  });

  it("synthetic: a 504 stops after exactly 3 requests with final=budget and the hint on the thrown error", async () => {
    const { url, requestCount } = await startServer(reply(504, JSON.stringify({ error: { message: "Gateway Timeout", code: 504 } })));
    const err = await caught(chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), {} as RetryClock));
    expect(err?.message).toMatch(/^API error 504 \(local\)/);
    expect(requestCount()).toBe(3);
    expect(failureOf(err)?.final).toBe("budget");
    expect(failureOf(err)?.hint).toContain("too large or too slow");
    expect(Object.keys(err!)).toEqual([]);
  });

  it("synthetic: a 504 followed by a 200 still succeeds (the budget counts failures)", async () => {
    const { url, requestCount } = await startServer((n, _q, res) => reply(n === 1 ? 504 : 200, n === 1 ? "{}" : OK_BODY)(n, _q, res));
    const res = await chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), {} as RetryClock);
    expect(res.content).toBe("ok");
    expect(requestCount()).toBe(2);
  });

  it("synthetic: a 504 under a 100 ms deadline is still one request (chatCompletionSimple and chatCompletionJSON)", async () => {
    const { url, requestCount } = await startServer(reply(504));
    const simple = await caught(chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), { deadlineAt: Date.now() + 100 }));
    expect(simple?.message).toMatch(/^API error 504/);
    expect(requestCount()).toBe(1);
    const json = await caught(chatCompletionJSON(MESSAGES, { model: "m", retryClock: { deadlineAt: Date.now() + 100 } }, depsFor(url)));
    expect(json?.message).toMatch(/^API error 504/);
    expect(requestCount()).toBe(2);
  });

  it("synthetic: 529 and 409 are not retried (today behaviour pinned)", async () => {
    for (const status of [529, 409]) {
      const { url, requestCount } = await startServer(reply(status));
      const err = await caught(chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), {} as RetryClock));
      expect(err?.message).toMatch(new RegExp(`^API error ${status}`));
      expect(requestCount()).toBe(1);
      expect(failureOf(err)?.final).toBeUndefined();
      server?.closeAllConnections();
      server?.close();
    }
  });

  it("synthetic: 401, 402, 403, 404 are one request with no verdict stamped (the same-model stop for 401 lives in completion.ts)", async () => {
    for (const status of [401, 402, 403, 404]) {
      const { url, requestCount } = await startServer(reply(status, JSON.stringify({ error: { message: "synthetic", code: status } })));
      const err = await caught(chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), {} as RetryClock));
      expect(err?.message).toMatch(new RegExp(`^API error ${status}`));
      expect(requestCount()).toBe(1);
      expect(failureOf(err)?.final).toBeUndefined();
      server?.closeAllConnections();
      server?.close();
    }
  });

  it("ECONNREFUSED: 2 attempts, final=budget, the host named in the hint, original message unchanged", async () => {
    const clock: RetryClock = {};
    const err = await caught(fetchWithRetry429(await closedPortUrl(), { method: "POST", body: "{}" }, 60_000, Date.now(), undefined, clock));
    expect(clock.attempts).toBe(2);
    expect(err?.message).toBe("fetch failed");
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
    expect(failureOf(err)?.final).toBe("budget");
    expect(failureOf(err)?.hint).toContain("nothing is listening at 127.0.0.1");
    expect(clock.lastError).toBe(err);
  });

  it("ECONNREFUSED budget counts refusals, not attempts: a 503 then two refusals is 3 attempts", async () => {
    const { url } = await startServer((_n, _q, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end("{}", () => { server?.closeAllConnections(); server?.close(); });
    });
    const clock: RetryClock = {};
    const err = await caught(fetchWithRetry429(url, { method: "POST", body: "{}" }, 60_000, Date.now(), undefined, clock));
    expect(clock.attempts).toBe(3);
    expect(failureOf(err)?.final).toBe("budget");
  });

  it("DNS off the OpenRouter host (nonexistent.invalid): 2 attempts then final=budget", async () => {
    const clock: RetryClock = {};
    const err = await caught(fetchWithRetry429("http://nonexistent.invalid/x", { method: "POST", body: "{}" }, 60_000, Date.now(), undefined, clock));
    expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(failureOf(err)?.networkCode);
    expect(clock.attempts).toBe(2);
    expect(failureOf(err)?.final).toBe("budget");
  });

  it("a reset connection is still retried to the end of the window (no verdict)", async () => {
    server = createServer((req) => { req.socket.destroy(); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const clock: RetryClock = { deadlineAt: Date.now() + 3500 };
    const err = await caught(fetchWithRetry429(`http://127.0.0.1:${port}/x`, { method: "POST", body: "{}" }, 60_000, Date.now(), undefined, clock));
    expect(clock.attempts).toBeGreaterThanOrEqual(2);
    // undici reports a destroyed socket as UND_ERR_SOCKET on current node, ECONNRESET on others.
    expect(["ECONNRESET", "UND_ERR_SOCKET"]).toContain(failureOf(err)?.networkCode);
    expect(failureOf(err)?.final).toBeUndefined();
  });


  // No stubbing: a real reset server, and a 2.5 s call budget so the loop-head time check (remaining < 2 s) ends the loop
  // after the first backoff (>= 750 ms) with no response in hand. The same exit is what a D7 name-lookup retry reaches on
  // the OpenRouter host, which cannot be driven for real (openrouter.ai cannot be made to fail resolution).
  it("a loop that ends on the time check rethrows the network error, not the generic text", async () => {
    server = createServer((req) => { req.socket.destroy(); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const clock: RetryClock = {};
    const err = await caught(fetchWithRetry429(`http://127.0.0.1:${port}/x`, { method: "POST", body: "{}" }, 2500, Date.now(), undefined, clock));
    expect(err?.message).toBe("fetch failed");
    expect(["ECONNRESET", "UND_ERR_SOCKET"]).toContain(failureOf(err)?.networkCode);
    expect(clock.lastError).toBe(err);
  });


  it("a network error newer than an earlier 503 is thrown, not the stale 503 response", async () => {
    const { url } = await startServer((_n, _q, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end("{}", () => { server?.closeAllConnections(); server?.close(); });
    });
    const err = await caught(fetchWithRetry429(url, { method: "POST", body: "{}" }, 4500, Date.now(), undefined, {}));
    expect(err?.message).toBe("fetch failed");
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
  });

});

describe("TLS errors stop at the first failure", () => {
  let dir: string;
  let cert: string;
  let key: string;
  beforeAll(() => {
    // No skip: a missing openssl must fail this test, not hide the TLS row.
    dir = mkdtempSync(join(tmpdir(), "llm-ext-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe" });
    cert = readFileSync(join(dir, "c.pem"), "utf8");
    key = readFileSync(join(dir, "k.pem"), "utf8");
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("a self-signed certificate: 1 request, final=stop, no retry", async () => {
    let handshakes = 0;
    const https = createHttpsServer({ cert, key }, (_req, res) => { res.end("{}"); });
    https.on("secureConnection", () => { handshakes++; });
    await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
    const { port } = https.address() as { port: number };
    try {
      const clock: RetryClock = {};
      const err = await caught(fetchWithRetry429(`https://127.0.0.1:${port}/x`, { method: "POST", body: "{}" }, 60_000, Date.now(), undefined, clock));
      expect(failureOf(err)?.networkCode).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
      expect(failureOf(err)?.final).toBe("stop");
      expect(failureOf(err)?.hint).toContain("TLS certificate error");
      expect(clock.attempts).toBe(1);
      expect(handshakes).toBe(0);
    } finally {
      https.closeAllConnections();
      https.close();
    }
  });
});
