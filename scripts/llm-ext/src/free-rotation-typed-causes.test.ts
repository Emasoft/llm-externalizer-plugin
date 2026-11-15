/**
 * free-rotation-typed-causes.test.ts — TRDD-3CG178O7 (increment 1a of TRDD-WSPV40Y5): the typed failure causes of the free rotation.
 *
 * REAL node:http servers and a REAL closed port; the code under test is never mocked. The server ignores GET model-info
 * probes (they answer 404) so request counts are exact.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatCompletionWithRetry, resetServiceHealthForTests } from "./provider/completion.js";
import { failureOf, type RetryClock } from "./provider/http.js";
import { callWithFreeRotation, memoryRotationStore } from "./free-rotation.js";
import { FreeRotationNetworkError, isNetworkIsolation } from "./free-failure-cause.js";
import type { BackendConfig, CompletionDeps, ChatMessage } from "./provider/types.js";

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

async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

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
const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const reply503 = (_n: number, res: ServerResponse) => {
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "upstream unavailable", code: 503 } }));
};

describe("a real closed port through callWithFreeRotation (the raw rethrow, now typed)", () => {
  it("throws a FreeRotationNetworkError naming ECONNREFUSED, with the typed cause, and stops after the FIRST model", async () => {
    const url = await closedPortUrl();
    const clock: RetryClock = {};
    const tried: string[] = [];
    const err = await caught(
      callWithFreeRotation(
        { id: "vendor/free-a:free", maxOutput: 256 },
        [{ id: "vendor/free-b:free", maxOutput: 256 }, { id: "vendor/free-c:free", maxOutput: 256 }],
        (model, maxOutput) => {
          tried.push(model);
          return chatCompletionWithRetry(MESSAGES, { model, maxTokens: maxOutput, retryClock: clock }, depsFor(url));
        },
        { retryClock: clock, store: memoryRotationStore() },
      ),
    );
    expect(err).toBeInstanceOf(FreeRotationNetworkError);
    const e = err as FreeRotationNetworkError;
    // The exit point is unchanged: one model called, no rotation to the two fallbacks.
    expect(tried).toEqual(["vendor/free-a:free"]);
    // The original text still leads (classifyError and endpointFailureKind match on it); the code is named after it.
    expect(e.message.startsWith("fetch failed")).toBe(true);
    expect(e.message).toContain("ECONNREFUSED");
    expect(e.message).toContain("vendor/free-a:free");
    // The typed cause list and the failure fields every downstream reader uses.
    expect(e.causes).toHaveLength(1);
    expect(e.causes[0].modelId).toBe("vendor/free-a:free");
    expect(e.causes[0].failure?.networkCode).toBe("ECONNREFUSED");
    expect(failureOf(e)?.networkCode).toBe("ECONNREFUSED");
    expect(isNetworkIsolation(e.causes)).toBe(true);
  }, 60_000);
});

const YAML = `active: bare
allow_paid_models: true
profiles:
  bare:
    mode: remote
    api: openrouter-remote
    model: vendor/whatever
    api_key: "test-key-not-a-secret" # ubs:ignore (test fixture, not a key)
`;

/**
 * index.ts reads settings once at import; re-import fresh against a throwaway config dir. The rotation, the error classes and
 * index.ts must come from the SAME module registry, or instanceof sees two different classes.
 */
async function withFreshModules<T>(
  body: (m: {
    idx: typeof import("./index.js");
    rotation: typeof import("./free-rotation.js");
    completion: typeof import("./provider/completion.js");
    http: typeof import("./provider/http.js");
    fallback: typeof import("./profile-fallback.js");
    foreground: typeof import("./foreground-repair.js");
  }) => Promise<T>,
): Promise<T> {
  const cfgDir = mkdtempSync(join("/tmp", "llm-ext-frtc-cfg-"));
  writeFileSync(join(cfgDir, "settings.yaml"), YAML, "utf-8");
  const prev = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  try {
    return await body({
      idx: await import("./index.js"),
      rotation: await import("./free-rotation.js"),
      completion: await import("./provider/completion.js"),
      http: await import("./provider/http.js"),
      fallback: await import("./profile-fallback.js"),
      foreground: await import("./foreground-repair.js"),
    });
  } finally {
    if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prev;
    rmSync(cfgDir, { recursive: true, force: true });
  }
}

describe("pool exhaustion with real servers answering 503", () => {
  it("AllFreeModelsExhaustedError carries one typed cause per model tried; freeRotationExhausted passes them on", async () => {
    await withFreshModules(async ({ idx, rotation, completion, http, fallback, foreground }) => {
      const { url, requestCount } = await startServer(reply503);
      const models = ["vendor/free-a:free", "vendor/free-b:free", "vendor/free-c:free"];
      const err = await caught(
        rotation.callWithFreeRotation(
          { id: models[0], maxOutput: 256 },
          models.slice(1).map((id) => ({ id, maxOutput: 256 })),
          // A PRIVATE 3 s window per model (deadlineAt, no shared clock): a 503 is retried for the whole window, then the call ends in a
          // RetryDeadlineError with dispatchClosed false, an ordinary availability failure of that model, so the rotation moves on.
          (model, maxOutput) => completion.chatCompletionWithRetry(MESSAGES, { model, maxTokens: maxOutput, deadlineAt: Date.now() + 3000 }, depsFor(url)),
          { store: rotation.memoryRotationStore() },
        ),
      );
      expect(err).toBeInstanceOf(rotation.AllFreeModelsExhaustedError);
      const exhausted = err as InstanceType<typeof rotation.AllFreeModelsExhaustedError>;
      expect(exhausted.tried).toEqual(models);
      expect(requestCount()).toBeGreaterThanOrEqual(3);
      expect(exhausted.causes.map((c) => c.modelId)).toEqual(models);
      for (const c of exhausted.causes) {
        expect(c.failure?.status).toBe(503);
        expect(c.failure?.networkCode).toBeUndefined();
        expect(c.detail).toMatch(/API error 503/);
      }
      // The message is unchanged by 1a: it still ends on the last detail.
      expect(exhausted.message).toContain(`Last error: ${exhausted.lastDetail}`);
      expect(exhausted.lastDetail).toBe(exhausted.causes[2].detail);
      // the routing decision reads the last cause, so it must equal the old lastDetail (TRDD-3CG178O7 review).
      expect(exhausted.causes.at(-1)?.detail).toBe(exhausted.lastDetail);
      expect(isNetworkIsolation(exhausted.causes)).toBe(false);

      // freeRotationExhausted on a dynamic profile: the retry flag makes failDynamicProfile return the dynamic exhaustion
      // WITHOUT starting a background updater, so the causes it was handed can be read.
      const out = await foreground.dynamicExhaustionStore.run({ retry: true }, async () => idx.__freeRotationExhaustedForTests("free", exhausted));
      expect(out).toBeInstanceOf(fallback.ProfileExhaustedError);
      const exhaustion = out as InstanceType<typeof fallback.ProfileExhaustedError>;
      expect(exhaustion.kind).toBe("dynamic");
      expect(exhaustion.causes).toHaveLength(3);
      exhaustion.causes.forEach((cause, i) => {
        expect(cause).toBeInstanceOf(Error);
        expect((cause as Error).message).toBe(exhausted.causes[i].detail);
        expect(http.failureOf(cause)?.status).toBe(503);
        expect(http.failureOf(cause)?.modelId).toBe(models[i]);
        // No base URL rides on a cause: the free path never knows it (the probe URL comes from the profile or route).
        expect(http.failureOf(cause)?.baseUrl).toBeUndefined();
      });
      // A static profile or no profile keeps the exhaustion untouched.
      expect(idx.__freeRotationExhaustedForTests(undefined, exhausted)).toBe(exhausted);
    });
  }, 300_000);
});

describe("the routing decision of a free-pool exhaustion still comes from the LAST model only", () => {
  // TRDD-3CG178O7 is a message-only increment: failDynamicProfile must route exactly as before the typed causes existed, when it
  // saw one cause (the last model detail). Whether every cause should drive routing is a 1d decision (TRDD-WSPV40Y5).
  // The card example [429, 401] cannot reach this path: classifyUnavailable never rotates past a 401, so a 401 leaves the
  // rotation raw. The reachable analogue is a certain 402 (payment errors advance the rotation, D1): on `paid`, a last 402 alone is
  // the credit verdict (the exhaustion itself, no update), while [429, 402] taken together would fall through to the update branch.
  it("paid profile, tried [429 refusal, then 402 no credit]: the credit verdict (the exhaustion itself) is returned, no updater", async () => {
    await withFreshModules(async ({ idx, rotation, completion, fallback, foreground }) => {
      const { url, requestCount } = await startServer((n, res) => {
        if (n === 1) {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "600" });
          res.end(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-min. ", code: 429 } }));
          return;
        }
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Insufficient credits", code: 402 } }));
      });
      const models = ["vendor/free-a:free", "vendor/free-b:free"];
      const err = await caught(
        rotation.callWithFreeRotation(
          { id: models[0], maxOutput: 256 },
          [{ id: models[1], maxOutput: 256 }],
          // A private 4 s window per model: the 429 Retry-After lies beyond it, so it is one model refusal (the rotation moves on).
          (model, maxOutput) => completion.chatCompletionWithRetry(MESSAGES, { model, maxTokens: maxOutput, deadlineAt: Date.now() + 4000 }, depsFor(url)),
          { store: rotation.memoryRotationStore() },
        ),
      );
      expect(err).toBeInstanceOf(rotation.AllFreeModelsExhaustedError);
      const exhausted = err as InstanceType<typeof rotation.AllFreeModelsExhaustedError>;
      expect(requestCount()).toBe(2);
      expect(exhausted.tried).toEqual(models);
      expect(exhausted.causes).toHaveLength(2);
      expect(exhausted.causes[0].detail).toMatch(/API error 429/);
      expect(exhausted.causes[1].failure?.status).toBe(402);

      // retry:true stops the update branch from spawning an updater (it returns the dynamic ProfileExhaustedError instead); the
      // credit branch comes first and returns the exhaustion error itself, so identity proves which branch decided.
      const out = await foreground.dynamicExhaustionStore.run({ retry: true }, async () => idx.__freeRotationExhaustedForTests("paid", exhausted));
      expect(out).not.toBeInstanceOf(fallback.ProfileExhaustedError);
      expect(out).toBe(exhausted);
      // The typed causes of every model still ride on that error.
      expect((out as typeof exhausted).causes.map((c) => c.modelId)).toEqual(models);
    });
  }, 120_000);
});
