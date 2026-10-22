/**
 * failure-fields.test.ts — TRDD-YG72CYY7 inc 3 round A: typed failure fields.
 *
 * REAL calls against REAL node:http / node:net servers; no mocks of the code under test.
 * The identity block pins the thrown messages byte-for-byte to what the UNCHANGED code
 * (git HEAD before round A, run from a pristine `git archive` copy) produced.
 * Bodies not recorded from a real provider are in `synthetic:` tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chatCompletionSimple, chatCompletionJSON } from "./completion.js";
import {
  RetryDeadlineError,
  attachFailure,
  failureOf,
  fetchWithRetry429,
  httpFailureFields,
  networkCodeOf,
  parseErrorBody,
  retryAfterMsOf,
} from "./http.js";
import { replayFixture, type RecordedReply } from "../classifiers/l0/test-fetch.js";
import type { BackendConfig, CompletionDeps, ChatMessage } from "./types.js";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

interface Reply { status: number; body: string; type?: string; headers?: Record<string, string> }

async function startServer(reply: Reply) {
  let count = 0;
  server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    count++;
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.status, { "Content-Type": reply.type ?? "application/json", ...reply.headers });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, requestCount: () => count };
}

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
// A 100 ms window refuses every backoff wait, so a retryable 5xx / network error is returned after ONE request.
const CLOCK = () => ({ deadlineAt: Date.now() + 100 });

const ENVELOPE_BODY = JSON.stringify({
  error: {
    message: "Provider returned error",
    code: 503,
    metadata: { raw: "upstream is temporarily rate-limited", provider_name: "Google AI Studio" },
  },
});
const LONG_BODY = JSON.stringify({ error: { message: "x".repeat(500), code: 400 } });
const HTML_BODY = "<html>\n<head><title>502 Bad Gateway</title></head>\n<body><center><h1>502 Bad Gateway</h1></center></body>\n</html>";

// Expected messages captured from the unchanged code (see the file header).
const IDENTITY: Array<[string, Reply, string]> = [
  ["synthetic: json envelope with metadata", { status: 400, body: ENVELOPE_BODY },
    "API error 400 (local): Provider returned error [Google AI Studio]: upstream is temporarily rate-limited"],
  ["synthetic: empty body", { status: 404, body: "" }, "API error 404 (local): (no response body)"],
  ["synthetic: html 502 page", { status: 502, body: HTML_BODY, type: "text/html" },
    "API error 502 (local): <html> <head><title>502 Bad Gateway</title></head> <body><center><h1>502 Bad Gateway</h1></center></body> </html>"],
  ["synthetic: body longer than the sanitizer cap", { status: 400, body: LONG_BODY },
    `API error 400 (local): ${"x".repeat(199)}…`],
];

describe("zero behaviour change: thrown messages, keys, request count", () => {
  for (const [name, reply, message] of IDENTITY) {
    it(`${name}: chatCompletionSimple`, async () => {
      const { url, requestCount } = await startServer(reply);
      const err = (await chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), CLOCK()).then(() => undefined, (e: unknown) => e)) as Error;
      expect(err.message).toBe(message);
      expect(Object.keys(err)).toEqual([]);
      expect(JSON.stringify(err)).toBe("{}");
      expect(requestCount()).toBe(1);
    });
    it(`${name}: chatCompletionJSON`, async () => {
      const { url, requestCount } = await startServer(reply);
      const err = (await chatCompletionJSON(MESSAGES, { model: "m", retryClock: CLOCK() }, depsFor(url)).then(() => undefined, (e: unknown) => e)) as Error;
      expect(err.name).toBe("Error");
      expect(err.message).toBe(message);
      expect(Object.keys(err)).toEqual([]);
      expect(requestCount()).toBe(1);
    });
  }

  it("a destroyed socket: fetchWithRetry429 rethrows the fetch TypeError unchanged", async () => {
    let count = 0;
    server = createServer((req) => { count++; req.socket.destroy(); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const err = (await fetchWithRetry429(`http://127.0.0.1:${port}/x`, { method: "POST", body: "{}" }, 30_000, Date.now(), undefined, CLOCK()).then(() => undefined, (e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("fetch failed");
    expect(Object.keys(err)).toEqual([]);
    expect(count).toBe(1);
  });
});

describe("failure fields on the real throw sites", () => {
  it("synthetic: chatCompletionSimple HTTP error carries every field, non-enumerable", async () => {
    const { url } = await startServer({ status: 400, body: ENVELOPE_BODY, headers: { "Retry-After": "7" } });
    const err = (await chatCompletionSimple(MESSAGES, { model: "m" }, depsFor(url), CLOCK()).then(() => undefined, (e: unknown) => e)) as Error;
    expect(failureOf(err)).toEqual({
      status: 400,
      openrouterCode: "503",
      providerName: "Google AI Studio",
      providerRaw: "upstream is temporarily rate-limited",
      retryAfterMs: 7000,
    });
    expect(Object.getOwnPropertyDescriptor(err, "failure")?.enumerable).toBe(false);
  });

  it("synthetic: chatCompletionJSON HTTP error carries the fields", async () => {
    const { url } = await startServer({ status: 404, body: "" });
    const err = (await chatCompletionJSON(MESSAGES, { model: "m", retryClock: CLOCK() }, depsFor(url)).then(() => undefined, (e: unknown) => e)) as Error;
    expect(failureOf(err)).toMatchObject({ status: 404 });
    expect(failureOf(err)?.openrouterCode).toBeUndefined();
  });

  it("attaching twice keeps message and keys, and failureOf returns the second fields", () => {
    const err = new Error("boom");
    attachFailure(err, { status: 500 });
    attachFailure(err, { networkCode: "ECONNRESET" });
    expect(err.message).toBe("boom");
    expect(Object.keys(err)).toEqual([]);
    expect(failureOf(err)).toEqual({ networkCode: "ECONNRESET" });
  });
  it("failureOf reads a RetryDeadlineError's cause and is undefined for foreign errors", () => {
    const cause = new Error("c");
    attachFailure(cause, { status: 503 });
    const deadline = new RetryDeadlineError({ attempts: 1, elapsedMs: 0 }, cause);
    expect(failureOf(deadline)).toEqual({ status: 503 });
    expect(failureOf(new Error("plain"))).toBeUndefined();
    expect(failureOf("text")).toBeUndefined();
  });
});

describe("parseErrorBody / httpFailureFields on real recorded bodies", () => {
  const fixture = (name: string): RecordedReply =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../classifiers/__fixtures__/p01/${name}`, import.meta.url)), "utf8")) as RecordedReply;

  it("dec-err401.json: code and message, no provider", () => {
    const rec = fixture("dec-err401.json");
    expect(parseErrorBody(rec.body)).toEqual({ code: "401", message: "User not found.", providerName: undefined, providerRaw: undefined });
    expect(httpFailureFields(replayFixture(rec), rec.body)).toEqual({
      status: 401, openrouterCode: "401", providerName: undefined, providerRaw: undefined, retryAfterMs: undefined,
    });
  });

  it("dec-err404.json (recorded as status 400): status and numeric code taken from the recording", () => {
    const rec = fixture("dec-err404.json");
    const f = httpFailureFields(replayFixture(rec), rec.body);
    expect(f.status).toBe(rec.status);
    expect(f.openrouterCode).toBe("400");
  });
  it("dec-err400-malformed.json and dec-err400-notjson.json: code 400", () => {
    for (const name of ["dec-err400-malformed.json", "dec-err400-notjson.json"]) {
      const rec = fixture(name);
      expect(httpFailureFields(replayFixture(rec), rec.body).openrouterCode).toBe("400");
    }
  });

  it("synthetic: metadata.raw that is an object is stringified and sanitized (no user_id, no key)", () => {
    const body = JSON.stringify({
      error: { code: "upstream", message: "m", metadata: { provider_name: " Acme ", raw: { detail: "bad", user_id: "user_abc123", key: "sk-abcdefghijkl" } } },
    });
    const parsed = parseErrorBody(body);
    expect(parsed.code).toBe("upstream");
    expect(parsed.providerName).toBe("Acme");
    expect(parsed.providerRaw).not.toContain("user_abc123");
    expect(parsed.providerRaw).not.toContain("sk-abcdefghijkl");
    expect(parsed.providerRaw).toContain("bad");
  });

  it("synthetic: metadata.raw longer than the sanitizer cap is capped", () => {
    const body = JSON.stringify({ error: { code: 1, metadata: { raw: "y".repeat(1000) } } });
    expect(parseErrorBody(body).providerRaw).toHaveLength(200);
  });

  it("synthetic: malformed, non-JSON and non-envelope bodies give empty fields and never throw", () => {
    for (const raw of ["", "not json", "<html></html>", "null", "[]", '{"error":"text"}', '{"error":null}', '{"error":{"code":{}}}']) {
      expect(parseErrorBody(raw)).toEqual({ code: undefined, message: undefined, providerName: undefined, providerRaw: undefined });
    }
  });
});

describe("retryAfterMsOf", () => {
  it("synthetic: seconds, HTTP-date, absent and garbage", () => {
    expect(retryAfterMsOf(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMsOf(new Headers())).toBeUndefined();
    expect(retryAfterMsOf(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    const ms = retryAfterMsOf(new Headers({ "retry-after": new Date(Date.now() + 30_000).toUTCString() }));
    expect(ms).toBeGreaterThan(25_000);
    expect(ms).toBeLessThanOrEqual(30_000);
    expect(retryAfterMsOf(new Headers({ "retry-after": new Date(Date.now() - 30_000).toUTCString() }))).toBe(0);
  });
});

describe("networkCodeOf with real sockets", () => {
  async function failureOfFetch(url: string, timeout = 30_000): Promise<Error> {
    return (await fetchWithRetry429(url, { method: "POST", body: "{}" }, timeout, Date.now(), undefined, CLOCK()).then(() => undefined, (e: unknown) => e)) as Error;
  }

  it("a just-closed local port gives ECONNREFUSED on the thrown error", async () => {
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const err = await failureOfFetch(`http://127.0.0.1:${port}/x`);
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
  });

  it("a closed port on localhost gives ECONNREFUSED whether or not node returns an AggregateError", async () => {
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const err = await failureOfFetch(`http://localhost:${port}/x`);
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
  });

  it("a server that destroys the socket gives a reset-class code", async () => {
    server = createServer((req) => { req.socket.destroy(); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const err = await failureOfFetch(`http://127.0.0.1:${port}/x`);
    // undici reports a peer close after the request as UND_ERR_SOCKET, a hard reset as ECONNRESET.
    expect(failureOf(err)?.networkCode).toMatch(/^(ECONNRESET|UND_ERR_SOCKET)$/);
  });

  it("the request's own timeout abort gives ETIMEDOUT-LOCAL", async () => {
    server = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const err = await failureOfFetch(`http://127.0.0.1:${port}/x`, 1000);
    expect(failureOf(err)?.networkCode).toBe("ETIMEDOUT-LOCAL");
  }, 15_000);
});

describe("networkCodeOf on hand-built errors", () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  const aggregate = (...codes: string[]) => new AggregateError(codes.map(coded), "connect failed");
  const LOCAL = "http://localhost:1234/v1";
  const OPENROUTER = "https://openrouter.ai/api/v1";

  it("synthetic: AggregateError members are read before the aggregate's own code", () => {
    const err = Object.assign(aggregate("ETIMEDOUT"), { code: "ECONNREFUSED" });
    expect(networkCodeOf(err, LOCAL)).toBe("ETIMEDOUT");
  });

  it("synthetic: mixed [ENETUNREACH, ECONNREFUSED] is ECONNREFUSED off the OpenRouter host (D6)", () => {
    const err = new TypeError("fetch failed", { cause: aggregate("ENETUNREACH", "ECONNREFUSED") });
    expect(networkCodeOf(err, LOCAL)).toBe("ECONNREFUSED");
  });

  it("synthetic: mixed members on the OpenRouter host keep the non-refused code; unanimous refusal is ECONNREFUSED", () => {
    const mixed = new TypeError("fetch failed", { cause: aggregate("ENETUNREACH", "ECONNREFUSED") });
    expect(networkCodeOf(mixed, OPENROUTER)).toBe("ENETUNREACH");
    expect(networkCodeOf(mixed, "https://api.openrouter.ai/v1")).toBe("ENETUNREACH");
    expect(networkCodeOf(new TypeError("x", { cause: aggregate("ECONNREFUSED", "ECONNREFUSED") }), OPENROUTER)).toBe("ECONNREFUSED");
    // A look-alike host is not the OpenRouter host.
    expect(networkCodeOf(mixed, "https://evilopenrouter.ai/v1")).toBe("ECONNREFUSED");
  });

  it("synthetic: on the OpenRouter host [ECONNREFUSED, member without a code] falls through to ECONNREFUSED (pinned as today's behaviour)", () => {
    const err = new TypeError("fetch failed", { cause: new AggregateError([coded("ECONNREFUSED"), new Error("no code")], "connect failed") });
    expect(networkCodeOf(err, OPENROUTER)).toBe("ECONNREFUSED");
  });
  it("synthetic: the walk follows .cause to depth 5 and stops there", () => {
    const chain = (links: number): Error => {
      let e: Error = coded("EDEEP");
      for (let i = 0; i < links; i++) e = new Error("wrap", { cause: e });
      return e;
    };
    expect(networkCodeOf(chain(5), LOCAL)).toBe("EDEEP");
    expect(networkCodeOf(chain(6), LOCAL)).toBeUndefined();
  });

  it("synthetic: no code anywhere gives undefined", () => {
    expect(networkCodeOf(new Error("plain"), LOCAL)).toBeUndefined();
    expect(networkCodeOf("text", LOCAL)).toBeUndefined();
  });
});
