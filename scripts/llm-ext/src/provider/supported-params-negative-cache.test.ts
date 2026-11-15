/**
 * supported-params-negative-cache.test.ts — TRDD-0ICSRZ0K.
 *
 * REAL chatCompletionWithRetry against a REAL node:http server that counts
 * /endpoints GETs. A non-ok, empty or unparseable /endpoints reply must be
 * remembered (negative cache with a TTL) instead of re-fetched on every call.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { chatCompletionWithRetry, resetServiceHealthForTests } from "./completion.js";
import type { BackendConfig, ChatMessage, CompletionDeps } from "./types.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
const servers: Server[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  resetServiceHealthForTests();
});

/** `endpointsReply` answers each /endpoints GET (status + body); chat POSTs succeed. */
async function serve(endpointsReply: { status: number; body: unknown }) {
  let gets = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/endpoints")) {
      gets++;
      res.writeHead(endpointsReply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(endpointsReply.body));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, endpointGets: () => gets };
}

function depsFor(url: string): CompletionDeps {
  const backend: BackendConfig = { type: "openrouter", billable: false, isLocal: false, baseUrl: url, apiKey: "k", model: "unused", __version: 1 };
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

async function call(model: string, deps: CompletionDeps): Promise<void> {
  await chatCompletionWithRetry(MESSAGES, { model }, deps);
}

describe("getModelSupportedParams negative cache (TRDD-0ICSRZ0K)", () => {
  it("a 404 /endpoints reply is fetched once across two calls", async () => {
    const s = await serve({ status: 404, body: {} });
    const deps = depsFor(s.url);
    await call("vendor/neg-404", deps);
    await call("vendor/neg-404", deps);
    expect(s.endpointGets()).toBe(1);
  }, 30_000);

  it("an empty supported_parameters list is fetched once across two calls", async () => {
    const s = await serve({ status: 200, body: { data: { endpoints: [{ provider_name: "P", supported_parameters: [] }] } } });
    const deps = depsFor(s.url);
    await call("vendor/neg-empty-params", deps);
    await call("vendor/neg-empty-params", deps);
    expect(s.endpointGets()).toBe(1);
  }, 30_000);

  it("an empty endpoints array is fetched once across two calls", async () => {
    const s = await serve({ status: 200, body: { data: { endpoints: [] } } });
    const deps = depsFor(s.url);
    await call("vendor/neg-no-endpoints", deps);
    await call("vendor/neg-no-endpoints", deps);
    expect(s.endpointGets()).toBe(1);
  }, 30_000);

  it("the negative result expires: a call after the TTL fetches again (only Date is faked)", async () => {
    const s = await serve({ status: 404, body: {} });
    const deps = depsFor(s.url);
    // Date only, but one that keeps running: a frozen fake Date makes the governor lease wait (loopback send, 28f9e9a0)
    // read two CPU samples at the same instant, never get a second usable one, and hang. Timers stay real.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    await call("vendor/neg-ttl", deps);
    vi.setSystemTime(Date.now() + 299_000);
    await call("vendor/neg-ttl", deps);
    expect(s.endpointGets()).toBe(1);
    vi.setSystemTime(Date.now() + 2_000);
    await call("vendor/neg-ttl", deps);
    expect(s.endpointGets()).toBe(2);
  }, 30_000);

  it("a different model id is not covered by another model's negative entry", async () => {
    const s = await serve({ status: 404, body: {} });
    const deps = depsFor(s.url);
    await call("vendor/neg-a", deps);
    await call("vendor/neg-b", deps);
    expect(s.endpointGets()).toBe(2);
  }, 30_000);
});
