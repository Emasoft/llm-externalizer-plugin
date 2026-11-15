/**
 * ensemble-all-failed.test.ts: TRDD-OKK9JVK6 + TRDD-KP4DWUF9.
 *  1. An ensemble slot that flattens a provider-side give-up to text keeps the provider-state line.
 *  2. ensembleStreaming (REAL, via __ensembleStreamingForTests) wires its "no slot answered" outcome through
 *     pickEnsembleAllFailedError, and a breaker abort verdict counts as a failed slot, not an answer.
 * REAL node:http servers, REAL chatCompletionWithRetry; no mocks. Retry windows are seeded to ~1.5 s.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatCompletionWithRetry, resetServiceHealthForTests } from "./provider/completion.js";
import { slotErrorContent } from "./index.js";
import { RetryDeadlineError } from "./provider/http.js";
import type { BackendConfig, ChatMessage, CompletionDeps } from "./provider/types.js";

const FIXTURES = new URL("./classifiers/__fixtures__/p02/", import.meta.url);
const rawFixture = JSON.parse(readFileSync(new URL("target-endpoints.json", FIXTURES), "utf8")) as { body: string };
const fixtureBody = JSON.parse(rawFixture.body) as { data: { endpoints: Array<Record<string, unknown>> } & Record<string, unknown> };
const recorded = fixtureBody.data.endpoints[0];
const DEGRADED = {
  data: {
    ...fixtureBody.data,
    endpoints: [
      { ...recorded, provider_name: "Bad", status: -1, uptime_last_30m: 41.2, supported_parameters: ["temperature"] },
      { ...recorded, provider_name: "Good", status: 0, uptime_last_30m: 100, supported_parameters: ["temperature"] },
    ],
  },
};
const LINE = /1 of 2 providers degraded: Bad \(status -1, uptime 41\.2%\)/;
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

const servers: Server[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const c of cleanups.splice(0)) c();
  resetServiceHealthForTests();
});

/** Answers GET /endpoints with `endpoints` (404 when null) and every POST with 503. */
async function serve(endpoints: unknown | null): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      if (endpoints !== null && req.url?.endsWith("/endpoints")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(endpoints));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
      }
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Provider returned error", code: 503, metadata: { provider_name: "Bad" } } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return `http://127.0.0.1:${addr.port}`;
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

describe("ensemble slot error text (OKK9JVK6)", () => {
  /** One real give-up (503 until a 1.5 s window closes): the RetryDeadlineError a non-free ensemble slot catches. */
  async function giveUp(model: string, endpoints: unknown | null): Promise<unknown> {
    const deps = depsFor(await serve(endpoints));
    return chatCompletionWithRetry(MESSAGES, { model, deadlineAt: Date.now() + 1500 }, deps).then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  it("a provider-side give-up in a slot shows the same provider-state line as a single-model call", async () => {
    const err = await giveUp("vendor/slot-state", DEGRADED);
    expect(err).toBeInstanceOf(RetryDeadlineError);
    // Fails without the fix: the slot text was built from the error message alone and dropped the line.
    expect(slotErrorContent(err)).toMatch(LINE);
  }, 30_000);

  it("nothing degraded cached: the slot text carries no provider-state line", async () => {
    const err = await giveUp("vendor/slot-plain", null);
    expect(err).toBeInstanceOf(RetryDeadlineError);
    expect(slotErrorContent(err)).not.toContain("providers degraded");
  }, 30_000);
});

describe("ensembleStreaming all-failed wiring (KP4DWUF9)", () => {
  /** Fresh index.ts against a throwaway `local` profile whose two reserved slots both ride a real local server. */
  async function loadEnsemble(url: string) {
    const cfgDir = mkdtempSync(join("/tmp", "llm-ext-ens-allfailed-"));
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    cleanups.push(() => {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      rmSync(cfgDir, { recursive: true, force: true });
    });
    writeFileSync(
      join(cfgDir, "settings.yaml"),
      `active: local
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  local:
    mode: local
    api: generic-local
    url: ${url}
    model: ens-a
    free_models: [ens-a, ens-b]
    ensemble:
      reserved:
        - model: ens-a
        - model: ens-b
`,
      "utf-8",
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const [idx, completion, fallback] = await Promise.all([import("./index.js"), import("./provider/completion.js"), import("./profile-fallback.js")]);
    await idx.boot();
    expect(idx.__getEnsembleModelsForTests().map((m) => m.id)).toEqual(["ens-a", "ens-b"]);
    return { idx, completion, ProfileExhaustedError: fallback.ProfileExhaustedError };
  }

  it("every slot retry window closing surfaces the static exhaustion, not the plain all-failed error", async () => {
    const { idx, ProfileExhaustedError } = await loadEnsemble(await serve(null));
    const err = await idx
      .__ensembleStreamingForTests(MESSAGES, {}, { deadlineAt: Date.now() + 1500 })
      .then(() => undefined, (e: unknown) => e);
    // Removing the pickEnsembleAllFailedError wiring would throw the plain Error("All ensemble models failed: ...").
    expect(err).toBeInstanceOf(ProfileExhaustedError);
    expect((err as InstanceType<typeof ProfileExhaustedError>).kind).toBe("static");
    expect((err as InstanceType<typeof ProfileExhaustedError>).causes.length).toBe(2);
  }, 30_000);

  it("a circuit-breaker abort verdict is a failed slot: no slot answered, the call rejects", async () => {
    const { idx, completion } = await loadEnsemble(await serve(null));
    completion.setServiceFailuresForTests(1000);
    const err = await idx
      .__ensembleStreamingForTests(MESSAGES, {}, { deadlineAt: Date.now() + 1500 })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/all failing/);
  }, 30_000);
});
