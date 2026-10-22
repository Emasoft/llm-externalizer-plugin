/**
 * provider-state.test.ts — TRDD-YG72CYY7 increment 4, round A: the slim,
 * degraded rule, name cleaner and one-line formatter (pure), plus the store in
 * getModelSupportedParams exercised end to end against a REAL node:http server
 * (no fetch stub, no test seam). Fixtures: recorded p02 replies or data
 * labelled `synthetic`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import {
  PROVIDER_DEGRADED_UPTIME_PCT,
  cleanProviderName,
  formatProviderState,
  slimEndpoints,
} from "./provider-state.js";
import { chatCompletionSimple, providerStateLine } from "./completion.js";
import type { BackendConfig, ChatMessage, CompletionDeps } from "./types.js";

const FIXTURES = new URL("../classifiers/__fixtures__/p02/", import.meta.url);
const recordedEndpoints = (file: string): unknown[] => {
  const raw = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as { body: string };
  return (JSON.parse(raw.body) as { data: { endpoints: unknown[] } }).data.endpoints;
};

const FETCHED = Date.UTC(2026, 9, 10, 10, 42, 7);
const NOW = FETCHED + 7 * 60_000;
const line = (endpoints: unknown, now = NOW) =>
  formatProviderState("vendor/model-a", { fetchedAt: FETCHED, endpoints: slimEndpoints(endpoints) }, now);

describe("formatProviderState", () => {
  it("recorded target fixture (status 0, uptime 100): 0 of 1 degraded -> undefined", () => {
    expect(line(recordedEndpoints("target-endpoints.json"))).toBeUndefined();
  });

  it("recorded alias fixture (empty endpoints) -> undefined", () => {
    expect(line(recordedEndpoints("alias-endpoints.json"))).toBeUndefined();
  });

  it("synthetic: exact line, lowest uptime first, status and uptime parts", () => {
    expect(
      line([
        { provider_name: "Fireworks", status: 0, uptime_last_30m: 88 },
        { provider_name: "DeepInfra", status: -1, uptime_last_30m: 41.27 },
        { provider_name: "Healthy", status: 0, uptime_last_30m: 100 },
      ]),
    ).toBe(
      "provider state for vendor/model-a as of 10:42:07Z (cached 7 min ago): 2 of 3 providers degraded: DeepInfra (status -1, uptime 41.2%), Fireworks (uptime 88.0%)",
    );
  });

  it("synthetic: under a minute prints 'cached under 1 min ago'", () => {
    expect(line([{ provider_name: "A", status: -1 }], FETCHED + 59_000)).toContain(
      "(cached under 1 min ago)",
    );
  });

  it("synthetic: null uptime, missing status, status -1 without uptime", () => {
    expect(line([{ provider_name: "A", status: -1, uptime_last_30m: null }])).toContain(
      "1 of 1 providers degraded: A (status -1)",
    );
    expect(line([{ provider_name: "B", uptime_last_30m: 10 }])).toContain("B (uptime 10.0%)");
    expect(line([{ provider_name: "C" }])).toBeUndefined();
  });

  it("synthetic: more than 3 degraded -> 3 names (unknown uptime last, then name) and 'and K more'", () => {
    const l = line([
      { provider_name: "E", status: -1 },
      { provider_name: "D", uptime_last_30m: 50 },
      { provider_name: "C", uptime_last_30m: 40 },
      { provider_name: "B", uptime_last_30m: 30 },
      { provider_name: "A", status: -2 },
    ]);
    expect(l).toContain(
      "5 of 5 providers degraded: B (uptime 30.0%), C (uptime 40.0%), D (uptime 50.0%), and 2 more",
    );
  });

  it("synthetic: uptime is floored to one decimal, never scaled", () => {
    expect(line([{ provider_name: "A", status: -1, uptime_last_30m: 99.96 }])).toContain("99.9%");
    expect(line([{ provider_name: "A", status: -1, uptime_last_30m: 99.7 }])).toContain("99.7%");
  });

  it("the degraded threshold is the exported constant (pending owner question Q3)", () => {
    expect(PROVIDER_DEGRADED_UPTIME_PCT).toBe(90);
    expect(line([{ provider_name: "A", uptime_last_30m: 89.9 }])).toBeDefined();
    expect(line([{ provider_name: "A", uptime_last_30m: 90 }])).toBeUndefined();
  });

  it("the formatter's own text has no 3-digit number that looks like an HTTP status", () => {
    const l = line([
      { provider_name: "Alpha", status: -10, uptime_last_30m: 41.2 },
      { provider_name: "Beta", status: -1, uptime_last_30m: 12 },
    ])!;
    expect(l).not.toMatch(/\b[1-5]\d{2}\b/);
  });
});

describe("cleanProviderName", () => {
  it("replaces '|' and control characters, collapses whitespace", () => {
    expect(cleanProviderName("a|b")).toBe("a b");
    expect(cleanProviderName("x\ny")).toBe("x y");
  });
  it("cuts to 40 characters", () => {
    expect(cleanProviderName("z".repeat(200))).toBe("z".repeat(40));
  });
  it("masks an sk- token", () => {
    const out = cleanProviderName("Prov sk-abcdefghijkl");
    expect(out).not.toContain("abcdefghijkl");
    expect(out.startsWith("Prov sk-")).toBe(true);
  });
  it("keeps a numeric string, falls back to 'unnamed' for empty or non-string", () => {
    expect(cleanProviderName("123")).toBe("123");
    expect(cleanProviderName("")).toBe("unnamed");
    expect(cleanProviderName({ x: 1 })).toBe("unnamed");
  });
});

// ── End to end: real server, real chatCompletionSimple ────────────────

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

/** Serves /v1/models/<id>/endpoints with `endpointsBody` (counted) and answers every POST 200. */
async function startServer(endpointsBody: unknown) {
  let endpointGets = 0;
  const postBodies: Array<Record<string, unknown>> = [];
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/endpoints")) {
      endpointGets++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(endpointsBody));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      postBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, endpointGets: () => endpointGets, postBodies };
}

function depsFor(type: BackendConfig["type"], url: string, model: string): CompletionDeps {
  const backend: BackendConfig = {
    type,
    billable: false,
    isLocal: false,
    baseUrl: url,
    apiKey: "key",
    model,
    __version: 1,
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

/** synthetic: the recorded target body with its endpoints replaced. */
function syntheticBody(endpoints: unknown[]) {
  const raw = JSON.parse(readFileSync(new URL("target-endpoints.json", FIXTURES), "utf8")) as {
    body: string;
  };
  const body = JSON.parse(raw.body) as { data: Record<string, unknown> };
  return { data: { ...body.data, endpoints } };
}

const recorded = recordedEndpoints("target-endpoints.json")[0] as Record<string, unknown>;
const AGE_LINE = /as of \d\d:\d\d:\d\dZ \(cached under 1 min ago\)/;

describe("getModelSupportedParams stores provider state (end to end)", () => {
  it("one call stores the entry with exactly one /endpoints GET; a second call makes no extra GET", async () => {
    const model = "vendor/e2e-model-a";
    const { url, endpointGets } = await startServer(
      syntheticBody([
        { ...recorded, provider_name: "Bad", status: -1, uptime_last_30m: 41.2, supported_parameters: ["temperature"] },
        { ...recorded, provider_name: "Good", status: 0, uptime_last_30m: 100, supported_parameters: ["seed"] },
      ]),
    );
    const deps = depsFor("openrouter", url, model);
    expect(providerStateLine(model)).toBeUndefined();
    await chatCompletionSimple(MESSAGES, { model }, deps);
    expect(endpointGets()).toBe(1);
    const got = providerStateLine(model)!;
    expect(got).toMatch(AGE_LINE);
    expect(got).toContain(`provider state for ${model} as of`);
    expect(got).toContain("1 of 2 providers degraded: Bad (status -1, uptime 41.2%)");
    await chatCompletionSimple(MESSAGES, { model }, deps);
    expect(endpointGets()).toBe(1);
  });

  it("a model with supported_parameters [] still stores its provider state", async () => {
    const model = "vendor/e2e-model-b";
    const { url } = await startServer(
      syntheticBody([{ ...recorded, provider_name: "Bad", status: -2, uptime_last_30m: 12.5, supported_parameters: [] }]),
    );
    await chatCompletionSimple(MESSAGES, { model }, depsFor("openrouter", url, model));
    expect(providerStateLine(model)).toContain("1 of 1 providers degraded: Bad (status -2, uptime 12.5%)");
  });

  it("a backend of type local stores nothing and never asks /endpoints", async () => {
    const model = "vendor/e2e-model-c";
    const { url, endpointGets } = await startServer(
      syntheticBody([{ ...recorded, provider_name: "Bad", status: -1, supported_parameters: [] }]),
    );
    await chatCompletionSimple(MESSAGES, { model }, depsFor("local", url, model));
    expect(endpointGets()).toBe(0);
    expect(providerStateLine(model)).toBeUndefined();
  });

  it("an entry the supported-params loop accepts but a naive slim could choke on: same Set, no throw", async () => {
    const model = "vendor/e2e-model-d";
    const { url, postBodies } = await startServer(
      syntheticBody([
        { provider_name: { not: "a string" }, status: "-1", uptime_last_30m: "41", supported_parameters: ["temperature", "seed"] },
        { ...recorded, provider_name: "Bad", status: -1, supported_parameters: ["seed"] },
      ]),
    );
    const deps = depsFor("openrouter", url, model);
    await expect(chatCompletionSimple(MESSAGES, { model }, deps)).resolves.toBeDefined();
    // A non-null Set filtered the body: temperature is supported and kept, the unlisted reasoning field is dropped.
    expect(postBodies[0]).toHaveProperty("temperature");
    expect(postBodies[0]).not.toHaveProperty("reasoning");
    expect(providerStateLine(model)).toContain("1 of 2 providers degraded: Bad (status -1, uptime 100.0%)");
  });
});
