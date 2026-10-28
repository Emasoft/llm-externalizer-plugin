/**
 * provider-state-render.test.ts — TRDD-YG72CYY7 increment 4, round B: the provider-state line
 * reaches classifyError's reason through FailureFields.providerState. REAL chatCompletionWithRetry
 * against REAL node:http servers (no mocks, no store seam); /endpoints bodies are synthetic
 * (the recorded target body with its endpoints replaced).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { chatCompletionWithRetry, resetServiceHealthForTests, providerStateLine } from "./completion.js";
import { RetryDeadlineError, attachFailure } from "./http.js";
import { ProfileExhaustedError } from "../profile-fallback.js";
import { __classifyErrorForTests } from "../index.js";
import type { ResolvedRoute } from "../config.js";
import type { BackendConfig, ChatMessage, CompletionDeps } from "./types.js";

const FIXTURES = new URL("../classifiers/__fixtures__/p02/", import.meta.url);
const recorded = (() => {
  const raw = JSON.parse(readFileSync(new URL("target-endpoints.json", FIXTURES), "utf8")) as { body: string };
  return (JSON.parse(raw.body) as { data: { endpoints: Array<Record<string, unknown>> } }).data.endpoints[0];
})();
function syntheticBody(endpoints: unknown[]) {
  const raw = JSON.parse(readFileSync(new URL("target-endpoints.json", FIXTURES), "utf8")) as { body: string };
  const body = JSON.parse(raw.body) as { data: Record<string, unknown> };
  return { data: { ...body.data, endpoints } };
}
const DEGRADED = syntheticBody([
  { ...recorded, provider_name: "Bad", status: -1, uptime_last_30m: 41.2, supported_parameters: ["temperature"] },
  { ...recorded, provider_name: "Good", status: 0, uptime_last_30m: 100, supported_parameters: ["temperature"] },
]);
const HEALTHY = syntheticBody([
  { ...recorded, provider_name: "Good", status: 0, uptime_last_30m: 100, supported_parameters: ["temperature"] },
]);
const LINE = /1 of 2 providers degraded: Bad \(status -1, uptime 41\.2%\)/;
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  resetServiceHealthForTests();
});

interface Served {
  url: string;
  port: number;
  endpointGets: () => number;
  hangEndpoints: () => void;
  requests: string[];
}
/** Serves /endpoints (counted; `endpoints` null = 404; hangEndpoints() makes it never answer) and answers every POST with `postStatus`. */
async function serve(endpoints: unknown | null, postStatus = 503, host = "127.0.0.1"): Promise<Served> {
  let gets = 0;
  let hang = false;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url?.endsWith("/endpoints")) {
      gets++;
      if (hang) return;
      if (endpoints === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(endpoints));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(postStatus, { "Content-Type": "application/json", ...(postStatus === 429 ? { "Retry-After": "600" } : {}) });
      res.end(JSON.stringify({ error: { message: "Provider returned error", code: postStatus, metadata: { provider_name: "Bad" } } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://${host}:${addr.port}`, port: addr.port, endpointGets: () => gets, hangEndpoints: () => (hang = true), requests };
}

function depsFor(url: string, route?: ResolvedRoute): CompletionDeps {
  const backend: BackendConfig = { type: "openrouter", billable: false, isLocal: false, baseUrl: url, apiKey: "k", model: "unused", __version: 1 };
  return {
    getBackend: () => backend,
    apiHeaders: () => ({ "Content-Type": "application/json" }),
    routeForModel: () => route ?? null,
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

/** One real call that gives up inside ~1.5 s; resolves to the thrown error. */
async function giveUp(model: string, deps: CompletionDeps): Promise<RetryDeadlineError> {
  const err = await chatCompletionWithRetry(MESSAGES, { model, deadlineAt: Date.now() + 1500 }, deps).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RetryDeadlineError);
  return err as RetryDeadlineError;
}
const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, "g")) ?? []).length;

describe("provider-state line in the per-file reason (end to end)", () => {
  it("a 503 give-up on a degraded cached model shows the line; the store key is conn.model", async () => {
    const model = "vendor/render-a";
    const { url } = await serve(DEGRADED);
    const err = await giveUp(model, depsFor(url));
    // The same string keys the store (getModelSupportedParams) and the carrier (conn.model).
    expect(providerStateLine(model)).toMatch(LINE);
    const verdict = __classifyErrorForTests(err);
    expect(verdict.reason).toMatch(LINE);
    expect(verdict.reason.startsWith(err.message)).toBe(true);
    expect(verdict.unrecoverable).toBe(true);
    expect(verdict.countsAsFailure).toBe(true);
  }, 30_000);

  it("message, trail and JSON of the error are byte-identical with and without a degraded entry", async () => {
    const a = await serve(DEGRADED);
    const b = await serve(HEALTHY);
    const ea = await giveUp("vendor/render-b1", depsFor(a.url));
    const eb = await giveUp("vendor/render-b2", depsFor(b.url));
    expect(ea.message).toBe(eb.message);
    const strip = (e: RetryDeadlineError) => JSON.stringify(e, (k, v) => (k === "elapsedMs" ? 0 : v));
    expect(strip(ea)).toBe(strip(eb));
    expect(Object.keys(ea)).toEqual(Object.keys(eb));
    expect(Object.keys(ea.cause as object)).toEqual(Object.keys(eb.cause as object));
    expect(JSON.stringify(ea.cause)).toBe(JSON.stringify(eb.cause));
    expect((ea.cause as Error).message).toBe((eb.cause as Error).message);
    expect(ea.trail.attempts).toBe(eb.trail.attempts);
    expect(ea.trail.lastStatus).toBe(eb.trail.lastStatus);
    expect(JSON.stringify(ea)).not.toContain("degraded");
    expect(ea.message).not.toContain("degraded");
    expect(String((ea.cause as Error).message)).not.toContain("degraded");
  }, 30_000);

  it("nothing degraded, or no entry cached: the reason is exactly the message", async () => {
    const healthy = await serve(HEALTHY);
    const noEntry = await serve(null);
    const e1 = await giveUp("vendor/render-c1", depsFor(healthy.url));
    const e2 = await giveUp("vendor/render-c2", depsFor(noEntry.url));
    expect(__classifyErrorForTests(e1).reason).toBe(e1.message);
    expect(__classifyErrorForTests(e2).reason).toBe(e2.message);
  }, 30_000);


  it("two failing calls make no /endpoints GET beyond the one that filled the store, and no other request", async () => {
    const s = await serve(DEGRADED);
    const first = await giveUp("vendor/render-d", depsFor(s.url));
    const second = await giveUp("vendor/render-d", depsFor(s.url));
    expect(first.trail.attempts).toBeGreaterThanOrEqual(2);
    // EVERY request the server saw: the two pre-existing endpoint-flavor probes (once per base URL), the one /endpoints GET that filled the store, and exactly the calls' chat POSTs; nothing else.
    expect(s.requests.filter((r) => r.startsWith("GET ")).sort()).toEqual([
      "GET /props",
      "GET /v1/models",
      "GET /v1/models/vendor/render-d/endpoints",
    ]);
    expect(s.requests.filter((r) => !r.startsWith("GET "))).toEqual(
      Array<string>(first.trail.attempts + second.trail.attempts).fill("POST /v1/chat/completions"),
    );
    expect(s.endpointGets()).toBe(1);
  }, 60_000);
  it("an /endpoints route that never answers cannot hold up a give-up once the store is filled", async () => {
    const model = "vendor/render-e";
    const s = await serve(DEGRADED);
    await giveUp(model, depsFor(s.url));
    expect(s.endpointGets()).toBe(1);
    s.hangEndpoints();
    const t0 = Date.now();
    const err = await giveUp(model, depsFor(s.url));
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(s.endpointGets()).toBe(1); // the hanging route was never asked
    expect(__classifyErrorForTests(err).reason).toMatch(LINE);
  }, 30_000);

  it("a routed call (request on a different host than the primary) gets no line", async () => {
    const model = "vendor/render-f";
    const primary = await serve(DEGRADED, 200); // fills the store through the primary host
    const routed = await serve(null, 503, "127.0.0.1");
    const route = {
      name: "other", api: "other", protocol: "openai_api", url: `http://localhost:${routed.port}`,
      authToken: "k", keyRef: "none", isLocal: true, isFreeProvider: false, models: [model],
    } as unknown as ResolvedRoute;
    const err = await giveUp(model, depsFor(primary.url, route));
    expect(primary.endpointGets()).toBe(1);
    expect(providerStateLine(model)).toMatch(LINE);
    expect(__classifyErrorForTests(err).reason).toBe(err.message);
  }, 30_000);

  it("a 429 give-up is not provider-side: no line", async () => {
    const s = await serve(DEGRADED, 429);
    const err = await giveUp("vendor/render-g", depsFor(s.url));
    expect(__classifyErrorForTests(err).reason).toBe(err.message);
  }, 30_000);

  it("a same-hostname, different-port route gets no line (the gate compares host and port)", async () => {
    const model = "vendor/render-i";
    const primary = await serve(DEGRADED, 200);
    const routed = await serve(null, 503);
    const route = {
      name: "other", api: "other", protocol: "openai_api", url: routed.url,
      authToken: "k", keyRef: "none", isLocal: true, isFreeProvider: false, models: [model],
    } as unknown as ResolvedRoute;
    const err = await giveUp(model, depsFor(primary.url, route));
    expect(providerStateLine(model)).toMatch(LINE);
    expect(__classifyErrorForTests(err).reason).toBe(err.message);
  }, 30_000);

  // 🐌 slow: default 5-minute window, so the generic retries end the call with the RAW 503 error (not a RetryDeadlineError).
  it("🐌 a give-up that throws the raw 503 error (no short deadline) shows the line, alone and inside a static exhaustion", async () => {
    const s = await serve(DEGRADED);
    const err = await chatCompletionWithRetry(MESSAGES, { model: "vendor/render-j" }, depsFor(s.url)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryDeadlineError);
    expect((err as Error).message).toMatch(/API error 503/);
    expect((err as Error).message).not.toContain("degraded");
    const reason = __classifyErrorForTests(err).reason;
    expect(reason).toMatch(LINE);
    expect(reason.startsWith((err as Error).message)).toBe(true);
    expect(count(__classifyErrorForTests(new ProfileExhaustedError("p", "static", [err, err])).reason, /providers degraded/)).toBe(1);
  }, 600_000);
});

describe("classifyError render sites", () => {
  const fail = (providerState?: string, extra: object = {}) => {
    const e = new Error("API error 504 (openrouter): gateway timeout");
    attachFailure(e, { status: 504, ...extra, ...(providerState === undefined ? {} : { providerState }) });
    return e;
  };

  it("final (D3) errors: the line follows the hint, joined with ' | '", () => {
    const e = fail("provider state for m as of 10:00:00Z (cached under 1 min ago): 1 of 2 providers degraded: Bad", { final: "stop", hint: "HINT" });
    const reason = __classifyErrorForTests(e).reason;
    expect(reason.endsWith("(HINT | provider state for m as of 10:00:00Z (cached under 1 min ago): 1 of 2 providers degraded: Bad)")).toBe(true);
    expect(__classifyErrorForTests(fail(undefined, { final: "stop", hint: "HINT" })).reason).toBe(`${e.message} (HINT)`);
  });

  it("a profile exhaustion prints the line exactly once per model", async () => {
    const s = await serve(DEGRADED);
    const deadline = await giveUp("vendor/render-h", depsFor(s.url));
    const once = new ProfileExhaustedError("p", "static", [deadline, deadline]);
    expect(count(__classifyErrorForTests(once).reason, /providers degraded/)).toBe(1);
    const final = new ProfileExhaustedError("p", "static", [fail("provider state for m: 1 of 2 providers degraded: Bad", { final: "stop", hint: "H" })]);
    expect(count(__classifyErrorForTests(final).reason, /providers degraded/)).toBe(1);
  }, 30_000);

  it("a RetryDeadlineError nested inside another still yields its line", () => {
    const inner = new RetryDeadlineError({ attempts: 1, elapsedMs: 1 }, fail("provider state for nested as of 10:00:00Z (cached under 1 min ago): 1 of 2 providers degraded: Bad"));
    const outer = new RetryDeadlineError({ attempts: 1, elapsedMs: 1 }, inner);
    expect(__classifyErrorForTests(outer).reason).toContain("provider state for nested");
    expect(count(__classifyErrorForTests(new ProfileExhaustedError("p", "static", [outer])).reason, /providers degraded/)).toBe(1);
  });
  it("distinct models give one line each, at most 3", () => {
    const causes = [1, 2, 3, 4].map((i) => new RetryDeadlineError({ attempts: 1, elapsedMs: 1 }, fail(`line for model-${i}: 1 of 2 providers degraded: Bad`)));
    const reason = __classifyErrorForTests(new ProfileExhaustedError("p", "static", causes)).reason;
    expect(count(reason, /providers degraded/)).toBe(3);
    expect(reason).not.toContain("model-4");
  });

  it("two lines for one model built a minute apart print once (the model is the key, not the age)", () => {
    const a = new RetryDeadlineError({ attempts: 1, elapsedMs: 1 }, fail("provider state for m as of 10:00:00Z (cached under 1 min ago): 1 of 2 providers degraded: Bad"));
    const b = new RetryDeadlineError({ attempts: 1, elapsedMs: 1 }, fail("provider state for m as of 10:00:00Z (cached 1 min ago): 1 of 2 providers degraded: Bad"));
    const reason = __classifyErrorForTests(new ProfileExhaustedError("p", "static", [a, b])).reason;
    expect(count(reason, /providers degraded/)).toBe(1);
    expect(reason).toContain("cached under 1 min ago");
  });
});
