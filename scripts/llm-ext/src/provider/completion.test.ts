/**
 * completion.test.ts — item D2/A4 (open-items-design 2026-09-16): D2's
 * `useEmptyBudget` used to gate BOTH the retry/backoff STRATEGY (a transport
 * question — is this endpoint remote, so cold-start blanks are expected?) AND
 * the run-level billable spend stop (a COST question) off the same
 * `backend.type === "openrouter"` check. A remote openai_api preset (b.ai)
 * resolves `type` to "local" (the D1 shape), so it silently got neither the
 * forgiving retry ladder NOR (for a hypothetical future PAID openai_api
 * preset) the spend-stop ceiling.
 *
 * These tests exercise the REAL chatCompletionWithRetry against a REAL
 * node:http server (no mocked fetch of the code under test) that always
 * returns an empty-content, 200 OK completion — the exact shape that used to
 * be misrouted by `backend.type`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import {
  chatCompletionWithRetry,
  resetServiceHealthForTests,
  serviceFailureCountForTests,
  type SimpleCompletionOptions,
} from "./completion.js";
import type { BackendConfig, CompletionDeps, ChatMessage } from "./types.js";
import type { ResolvedRoute } from "../config.js";
import {
  isRunUnusable,
  markCredentialSucceeded,
  resetCredentialSuccessForTests,
  resetGeneric403ForTests,
  resetRunUnusableForTests,
  runUnusableKind,
} from "../free-rotation.js";
import { getModelEventsPath } from "../model-events.js";
import { IRON_RULE_REFUSAL_PREFIX } from "../benchmark/validated.js";
import { withUsageContext } from "../usage-history.js";
import { RetryDeadlineError } from "./http.js";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  // runUnusable AND the circuit breaker are process-wide module state —
  // vitest isolates per FILE, not per test, so a mark/trip from one test
  // would leak into the next (escalating 60s/120s/350s backoff) without this
  // (P2 amendment, 2026-09-16).
  resetRunUnusableForTests();
  resetServiceHealthForTests();
  // TRDD-W9XLU1HD: the distinct-generic-403 quorum is process-wide module
  // state — without this reset, one test's 403s arm the quorum for every
  // later test in this file (vitest isolates per FILE, not per test).
  resetGeneric403ForTests();
});

/** A local OpenAI-compatible server that always answers 200 OK with an
 *  EMPTY message.content — the "cold-start blank" shape the D2 retry ladder
 *  exists for. `onRequest` lets a test observe/react per request (e.g. answer
 *  with real content after N empty replies) without touching the code under
 *  test's own retry logic. */
async function startEmptyContentServer(onRequest?: (n: number) => { content: string } | null) {
  let count = 0;
  server = createServer((req, res) => {
    // LM Studio native-API detection (provider/lmstudio.ts's detectLMStudio)
    // probes GET /api/v1/models on every "local"-typed backend before the
    // first real call — answer it 404 so this test's backend is NOT
    // misdetected as LM Studio (which would route through the native
    // chatCompletionNative parser instead of the OpenAI-compat path this
    // test targets).
    if (req.method === "GET" && req.url === "/api/v1/models") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not LM Studio" }));
      return;
    }
    count++;
    const override = onRequest?.(count);
    const body = JSON.stringify({
      choices: [
        {
          message: { content: override?.content ?? "" },
          finish_reason: "stop",
        },
      ],
    });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, requestCount: () => count };
}

function baseDeps(backend: BackendConfig, route: ResolvedRoute | null): CompletionDeps {
  return {
    getBackend: () => backend,
    apiHeaders: () => ({ "Content-Type": "application/json" }),
    routeForModel: () => route,
    routeHeaders: () => ({ "Content-Type": "application/json" }),
    getSoftTimeoutMs: () => 30_000,
    isFreeOnly: () => false,
    isLMStudioProvider: () => false,
    // No provenance-exempt model in this suite's fixtures — every model here
    // is treated as auto-picked, same as before manualModels existed.
    getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    // TRDD-FDI9NYAS D3c: a recorded, well-under-ceiling price so the NEW
    // send-time price check never blocks this suite's transport/retry
    // scenarios (their subject is completion plumbing, not pricing).
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.5 }),
    getEnsemblePriceCeilingUsd: () => 1.3,
    defaultTemperature: 0.7,
    getDefaultMaxTokens: () => 256,
  };
}

/** A server that always answers a fixed error status with a fixed message
 *  body (JSON-shaped, like a real OpenRouter error) — the deterministic-4xx
 *  and generic-failure fixtures below. */
async function startErrorServer(status: number, message: string) {
  let count = 0;
  server = createServer((req, res) => {
    // Two GET probes precede the real POST for an "openrouter"-typed backend
    // and must NOT inflate the request count this helper exists to check:
    // the LM Studio native-API detection probe (/api/v1/models) and
    // getModelSupportedParams's per-model endpoint lookup
    // (/v1/models/<id>/endpoints, completion.ts:238). Answer both 404 —
    // "not LM Studio" / "no supported-params info" — without counting.
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    count++;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, requestCount: () => count };
}

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("chatCompletionWithRetry — D2 split (item D2/A4)", () => {
  it(
    "a non-billable REMOTE backend (b.ai-shaped) gets the empty-response retry ladder, not the stricter truncation budget",
    async () => {
      // b.ai's actual shape (D1): type "local" (transport format), billable
      // false (free-by-nature), isLocal false (it's a real internet endpoint).
      // The server answers empty for the first 4 requests, then real content
      // on the 5th — past MAX_TRUNCATION_RETRIES(3), inside
      // MAX_EMPTY_RESPONSE_RETRIES(15). The OLD code (`backend.type ===
      // "openrouter"`) never applied the empty-response ladder here (type is
      // "local"), so it gave up after 3 attempts and NEVER reached request 5 —
      // this is a behavioural RED, not a type error.
      const { url, requestCount } = await startEmptyContentServer((n) =>
        n >= 5 ? { content: "real answer" } : null,
      );
      const backend: BackendConfig = {
        type: "local",
        billable: false,
        isLocal: false,
        baseUrl: url,
        apiKey: "bai-key",
        model: "glm-5.3-flash",
        __version: 1,
      };
      const deps = baseDeps(backend, null);
      const options: SimpleCompletionOptions = { model: "glm-5.3-flash" };
      const result = await chatCompletionWithRetry(MESSAGES, options, deps);
      expect(result.content).toBe("real answer");
      expect(requestCount()).toBeGreaterThan(3);
    },
    60_000,
  );

  it(
    "a billable backend returning empty content repeatedly hits the run-level spend-stop, not just the per-call budget",
    async () => {
      // A hypothetical PAID openai_api preset (same "local"-typed, billable
      // shape D1 warns about) that never answers. RUN_PAID_EMPTY_RETRY_BUDGET
      // is 30 and MAX_EMPTY_RESPONSE_RETRIES caps ONE call's ladder at 15, so
      // the spend stop can only fire once the SAME model has burned through
      // more than 30 billable empty attempts across multiple calls — call
      // three times (15 + 15 + 1 = 31 > 30). The OLD code never even entered
      // the spend-stop's counting branch for this backend (`backend.type !==
      // "openrouter"` short-circuited `useEmptyBudget` to false), so
      // `used` never incremented and the spend-stop text never appeared no
      // matter how many times it was called — a behavioural RED.
      const { url } = await startEmptyContentServer();
      const backend: BackendConfig = {
        type: "local",
        billable: true, // the hypothetical paid non-openrouter preset
        isLocal: false,
        baseUrl: url,
        apiKey: "paid-remote-key",
        model: "paid/remote-empty-model",
        __version: 1,
      };
      const deps = baseDeps(backend, null);
      const options: SimpleCompletionOptions = { model: "paid/remote-empty-model" };

      // Only the FINAL call's result matters (the spend stop needs the
      // accumulated `used` count from the prior two), but each call must
      // still run to completion to advance that count.
      await chatCompletionWithRetry(MESSAGES, options, deps);
      await chatCompletionWithRetry(MESSAGES, options, deps);
      const last = await chatCompletionWithRetry(MESSAGES, options, deps);

      expect(last.content).toContain("run budget");
      expect(last.content).toContain("billable empty response");
    },
    180_000,
  );
});

describe("chatCompletionWithRetry — no same-model retry on a deterministic 4xx (TRDD-W9XLU1HD AC2, P2 amendment)", () => {
  it("a 403 with a model-specific body ('agentic harnesses') on a :free model is not retried — one HTTP call, immediate throw, model marked run-unusable", async () => {
    const { url, requestCount } = await startErrorServer(
      403,
      "thinkingmachines/inkling:free is only available on agentic harnesses.",
    );
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "thinkingmachines/inkling:free",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "thinkingmachines/inkling:free" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow(
      /agentic harnesses/,
    );
    // RED on pre-P2 HEAD: the old code retried the same model
    // 1 + MAX_TRUNCATION_RETRIES(3) = 4 times before giving up.
    expect(requestCount()).toBe(1);
    expect(isRunUnusable("thinkingmachines/inkling:free")).toBe(true);
    // The registry carries the REAL verdict kind, not a bare boolean (review
    // of da917e9, TRDD-W9XLU1HD) — completion.ts's markRunUnusable call must
    // pass the classified kind through, not a hardcoded "gone".
    expect(runUnusableKind("thinkingmachines/inkling:free")).toBe("gone");
  }, 30_000);

  it("a daily-quota error marks the model run-unusable with kind 'daily-quota', not a hardcoded 'gone' (S4, review of 527d5e8 — fails if completion.ts's markRunUnusable call drops the classified kind argument or hardcodes it)", async () => {
    // Status 403, not 429: a 429 is in http.ts's RETRYABLE_STATUS, so
    // fetchWithRetry429 would amplify it into several HTTP-layer retries
    // before ever reaching chatCompletionWithRetry's catch block — the
    // request-count-1 assertion below needs a status that layer does NOT
    // retry (403/404/410, same reasoning as the "an ordinary non-
    // deterministic-4xx" test's comment above). classifyUnavailable reads
    // the daily-quota verdict from `detail`'s TEXT, not the HTTP status, so
    // the mismatch between "403" and "daily quota" phrasing is harmless here.
    const { url, requestCount } = await startErrorServer(
      403,
      "Daily rate limit exceeded for free models",
    );
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "quota/model:free",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "quota/model:free" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow(
      /Daily rate limit/,
    );
    // A daily-quota verdict stops the same-model retry loop just like
    // gone/deterministic-4xx does (unavailableKind !== "daily-quota" gates
    // the retry condition) — one HTTP call, immediate throw.
    expect(requestCount()).toBe(1);
    expect(isRunUnusable("quota/model:free")).toBe(true);
    expect(runUnusableKind("quota/model:free")).toBe("daily-quota");
  }, 30_000);

  it("a 404 'no endpoints' marks the model run-unusable — isRunUnusable true after the call", async () => {
    const { url, requestCount } = await startErrorServer(
      404,
      "No endpoints found for model dead/model:free",
    );
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "dead/model:free",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "dead/model:free" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow(
      /No endpoints/,
    );
    expect(requestCount()).toBe(1);
    expect(isRunUnusable("dead/model:free")).toBe(true);
    expect(runUnusableKind("dead/model:free")).toBe("gone");
    // Step 3: the ledger's non_retryable_failure detail carries the sanitized
    // body, not just the bare status — this is what lets §5's persistence
    // verdict (and a human) tell a model-specific 404 from a generic 403.
    // model-events.log is shared across every test in this file (one isolated
    // config dir per FILE, not per test) — filter by model id, not just kind.
    const log = readFileSync(getModelEventsPath(), "utf-8");
    const line = log
      .trim()
      .split("\n")
      .find((l) => l.includes("dead/model:free") && l.includes("non_retryable_failure"));
    expect(line).toBeDefined();
    expect(line).toContain("HTTP 404");
    expect(line).toContain("No endpoints found for model");
  }, 30_000);

  it("an ordinary non-deterministic-4xx failure is still retried the existing number of times — regression guard", async () => {
    // 400 (not 403/404/410, not in http.ts's RETRYABLE_STATUS so this test
    // measures ONLY chatCompletionWithRetry's own outer retry loop, not
    // fetchWithRetry429's separate internal 5xx/429 amplification — a real
    // 500 here would be retried again at the HTTP layer before ever reaching
    // this function's catch block, making the request count assert the WRONG
    // layer's retry budget).
    const { url, requestCount } = await startErrorServer(400, "malformed request, try again");
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "some/model:free",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "some/model:free" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow();
    // Unchanged: 1 initial attempt + MAX_TRUNCATION_RETRIES(3) retries = 4.
    expect(requestCount()).toBe(4);
    expect(isRunUnusable("some/model:free")).toBe(false);
  }, 60_000);

  it("a 410 'model retired' is not retried and marks the model run-unusable (review finding: 410 was skipped-but-never-marked before this)", async () => {
    const { url, requestCount } = await startErrorServer(410, "model retired");
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "retired/model:free",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "retired/model:free" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow(/retired/);
    expect(requestCount()).toBe(1);
    expect(isRunUnusable("retired/model:free")).toBe(true);
  }, 30_000);

  it("a ROUTED billable endpoint reporting empty content repeatedly runs the remote/cold-start retry ladder driven by the ROUTE, not backend.billable", async () => {
    // billableForRoute derives billability from the ROUTE when one exists —
    // this backend claims billable:false (would otherwise pick the stricter
    // truncation budget's transport path — see the D2 comment in
    // completion.ts), but the route says isLocal:false, so isRemoteBackend
    // must come from the route and the model gets the forgiving empty-
    // response ladder (MAX_EMPTY_RESPONSE_RETRIES=15), not the stricter one.
    const { url, requestCount } = await startEmptyContentServer((n) =>
      n >= 5 ? { content: "real answer" } : null,
    );
    const backend: BackendConfig = {
      type: "local",
      billable: false,
      isLocal: true, // backend alone would say "not remote" — the ROUTE must override this
      baseUrl: "http://unused.invalid",
      apiKey: "key",
      model: "routed/model",
      __version: 1,
    };
    const route: ResolvedRoute = {
      name: "chat-b-ai-remote",
      api: "chat-b-ai-remote",
      protocol: "openai_api",
      url,
      authToken: "route-key",
      keyRef: "none",
      isLocal: false,
      isFreeProvider: false,
      models: ["routed/model"],
    };
    const deps = baseDeps(backend, route);
    const options: SimpleCompletionOptions = { model: "routed/model" };
    const result = await chatCompletionWithRetry(MESSAGES, options, deps);
    expect(result.content).toBe("real answer");
    // RED on the old backend.type-only derivation: backend.type is "local",
    // so the old code would have given up after MAX_TRUNCATION_RETRIES(3)
    // and never reached request 5.
    expect(requestCount()).toBeGreaterThan(3);
  }, 60_000);
});

describe("classifyUnavailable's 403 gate — auth/key vs model-specific (P2 amendment, 2026-09-16)", () => {
  // TRDD-W9XLU1HD coordinator mitigation (2026-10-04): 2+ DISTINCT models
  // bare-403-ing in the SAME run is now read as pool-level rejection — the
  // second distinct refusal arms the quorum and later bare 403s classify
  // "gone" (so the model is marked run-unusable). The old contract (never
  // mark on a bare 403) left a novel-wording DEAD model unmarkable forever;
  // the quorum trades that hole for one extra failed round-trip of evidence.
  it("two DISTINCT models both returning a generic 403: the first surfaces the raw error unmarked, the second is marked 'gone' (quorum armed)", async () => {
    const server1 = await startErrorServer(403, "No auth credentials found");
    const backendA: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: server1.url,
      apiKey: "bad-key",
      model: "model/a:free",
      __version: 1,
    };
    const depsA = baseDeps(backendA, null);
    await expect(
      chatCompletionWithRetry(MESSAGES, { model: "model/a:free" }, depsA),
    ).rejects.toThrow(/No auth credentials/);

    server?.close();
    const server2 = await startErrorServer(403, "No auth credentials found");
    const backendB: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: server2.url,
      apiKey: "bad-key",
      model: "model/b:free",
      __version: 1,
    };
    const depsB = baseDeps(backendB, null);
    await expect(
      chatCompletionWithRetry(MESSAGES, { model: "model/b:free" }, depsB),
    ).rejects.toThrow(/No auth credentials/);

    // The FIRST refusal marks nothing (below the quorum); the SECOND
    // distinct bare 403 arms the pool-level verdict and marks model B.
    expect(isRunUnusable("model/a:free")).toBe(false);
    expect(isRunUnusable("model/b:free")).toBe(true);
    expect(runUnusableKind("model/b:free")).toBe("gone");
  }, 30_000);
});

/** A local server that answers DIFFERENTLY per requested model, on ONE fixed
 *  baseUrl — the shape a real credential actually has: one endpoint, many
 *  models. `responses` maps model id -> either a 200/content shape or a
 *  [status, message] error shape. */
async function startModelRoutedServer(
  responses: Record<string, { content: string } | [number, string]>,
) {
  let count = 0;
  server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    count++;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { model?: string };
      const route = parsed.model ? responses[parsed.model] : undefined;
      if (!route) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `no fixture for model ${parsed.model}` } }));
        return;
      }
      if (Array.isArray(route)) {
        const [status, message] = route;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { content: route.content }, finish_reason: "stop" }] }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, requestCount: () => count };
}

describe("the credential-success discriminator on a generic 403 (TRDD-90DM5YHO item 1)", () => {
  afterEach(() => {
    resetCredentialSuccessForTests();
  });

  it("(a) generic 403 on model A with NO prior success on this credential — not marked, raw error surfaces", async () => {
    const { url } = await startErrorServer(403, "No auth credentials found");
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "sk-shared-credential",
      model: "model/a:free",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    await expect(
      chatCompletionWithRetry(MESSAGES, { model: "model/a:free" }, deps),
    ).rejects.toThrow(/No auth credentials/);
    expect(isRunUnusable("model/a:free")).toBe(false);
  }, 30_000);

  it("(b) success on model B, THEN a generic 403 on model A (same credential, same endpoint) — A is marked run-unusable", async () => {
    // ONE server, ONE baseUrl — the credential fingerprint includes baseUrl
    // (review finding, 2026-09-16), so both requests must hit the SAME
    // endpoint to exercise "same real-world credential, different model".
    const { url } = await startModelRoutedServer({
      "model/b:free": { content: "real answer" },
      "model/a:free": [403, "No auth credentials found"],
    });
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "sk-shared-credential",
      model: "model/b:free",
      __version: 1,
    };
    const depsB = baseDeps(backend, null);
    const okResult = await chatCompletionWithRetry(MESSAGES, { model: "model/b:free" }, depsB);
    expect(okResult.content).toBe("real answer");

    const depsA = baseDeps({ ...backend, model: "model/a:free" }, null);
    await expect(
      chatCompletionWithRetry(MESSAGES, { model: "model/a:free" }, depsA),
    ).rejects.toThrow(/No auth credentials/);
    expect(isRunUnusable("model/a:free")).toBe(true);
    expect(runUnusableKind("model/a:free")).toBe("gone");
  }, 30_000);

  it("(c) a generic 403 on the SAME model that just succeeded is NOT marked (key revoked mid-run)", async () => {
    const { url } = await startModelRoutedServer({
      "model/a:free": [403, "No auth credentials found"],
    });
    const backend: BackendConfig = {
      type: "openrouter",
      billable: false,
      isLocal: false,
      baseUrl: url,
      apiKey: "sk-shared-credential",
      model: "model/a:free",
      __version: 1,
    };
    // Simulate the credential having ALREADY succeeded on model/a:free
    // earlier this run (e.g. before the key was revoked mid-run) without a
    // second server round-trip: markCredentialSucceeded is the same function
    // completion.ts's own success path calls, so calling it directly here is
    // equivalent to a prior real successful call.
    markCredentialSucceeded(backend.type, backend.baseUrl, backend.apiKey, "model/a:free");
    const deps = baseDeps(backend, null);
    await expect(
      chatCompletionWithRetry(MESSAGES, { model: "model/a:free" }, deps),
    ).rejects.toThrow(/No auth credentials/);
    expect(isRunUnusable("model/a:free")).toBe(false);
  }, 30_000);
});

describe("mid-flight 402 never routes to another model — no cross-profile borrow (TRDD-OE27RD7I addendum 4, was TRDD-90DM5YHO item 2)", () => {
  it("a static profile with no free pool: exactly one POST, the honest 402 propagates, no request for FREE_MODEL_ID", async () => {
    const { url, requestCount } = await startErrorServer(402, "Insufficient credits");
    const backend: BackendConfig = {
      type: "openrouter",
      billable: true,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "paid/model",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "paid/model" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow(
      /API error 402/,
    );
    // Exactly one attempt — no free-pool rotation call, so no second POST for
    // FREE_MODEL_ID. There is no `deps.engageAutoFree`/`deps.getFreeModelId`
    // anymore either (TRDD-OE27RD7I 14.1-C2c-ENV deleted both from
    // CompletionDeps) — the completion layer has nothing left to borrow through.
    expect(requestCount()).toBe(1);
  }, 30_000);

  it("was 'control: a static profile WITH a free pool still falls back' — addendum 4 deletes that fallback: same 402, same one attempt, no free-pool POST regardless of the profile's own free pool", async () => {
    // RED on pre-C1 HEAD: this used to complete on "free/model:free" via
    // the paid->free rotation body (count >= 2). Addendum 4 (USER, no exceptions) bans
    // that cross-profile borrow outright — completion.ts never reads a
    // free-engagement decision at all anymore (engageAutoFree/getFreeModelId
    // are deleted, not just uncalled), so every profile shape gets the same
    // one-request honest 402.
    const { url, requestCount } = await startErrorServer(402, "Insufficient credits");
    const backend: BackendConfig = {
      type: "openrouter",
      billable: true,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "paid/model",
      __version: 1,
    };
    const deps: CompletionDeps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "paid/model" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow(
      /API error 402/,
    );
    expect(requestCount()).toBe(1);
  }, 30_000);
});

describe("a 402 is not retried against the SAME model on a non-openrouter backend (TRDD-90DM5YHO item 3)", () => {
  it("a local/non-openrouter backend returning 402: exactly one POST, no retries", async () => {
    const { url, requestCount } = await startErrorServer(402, "payment required");
    const backend: BackendConfig = {
      type: "local",
      billable: true,
      isLocal: false,
      baseUrl: url,
      apiKey: "key",
      model: "some/model",
      __version: 1,
    };
    const deps = baseDeps(backend, null);
    const options: SimpleCompletionOptions = { model: "some/model" };
    await expect(chatCompletionWithRetry(MESSAGES, options, deps)).rejects.toThrow(
      /API error 402/,
    );
    expect(requestCount()).toBe(1);
  }, 30_000);
});

// D1 (USER 2026-09-18, verbatim: "it should retry once, but if the payment
// required or credits exhausted error is certain, it should of course skip to
// the next provider"). A chain walk calls chatCompletionWithRetry once per
// entry, so "skip" here means: throw at once so the caller advances. The
// breaker (SERVICE_HEALTH) is for systemic outages (e0688b6); a payment error
// is the server correctly refusing THIS model or key, so it must never feed or
// trigger the breaker's 60s pause.
describe("payment errors — skip when certain, retry once when not, never a breaker pause (D1)", () => {
  function captureStderr() {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    return { text: () => lines.join(""), restore: () => spy.mockRestore() };
  }
  const backendAt = (url: string): BackendConfig => ({
    type: "openrouter",
    billable: true,
    isLocal: false,
    baseUrl: url,
    apiKey: "key",
    model: "chain/m1",
    __version: 1,
  });

  it("six consecutive certain 402s across a six-model chain: one POST per model and no circuit-breaker pause", async () => {
    // Six, because the breaker trips at 5 consecutive failures: counting the
    // 402s made the 6th entry sleep 60s before a guaranteed 402 (the Row 27
    // paid test measured 60.1s for exactly this).
    const { url, requestCount } = await startErrorServer(402, "Insufficient credits");
    const deps = baseDeps(backendAt(url), null);
    const stderr = captureStderr();
    const t0 = Date.now();
    try {
      for (let i = 1; i <= 6; i++) {
        await expect(chatCompletionWithRetry(MESSAGES, { model: `chain/m${i}` }, deps)).rejects.toThrow(
          /API error 402/,
        );
        expect(requestCount(), `model ${i} must be asked exactly once`).toBe(i);
      }
      expect(stderr.text()).not.toContain("[circuit-breaker]");
    } finally {
      stderr.restore();
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("an explicit 'insufficient credits' body on a non-402 status (HTTP 400) is certain too: one POST, no retry", async () => {
    const { url, requestCount } = await startErrorServer(400, "insufficient credits on this account");
    const deps = baseDeps(backendAt(url), null);
    await expect(chatCompletionWithRetry(MESSAGES, { model: "chain/m1" }, deps)).rejects.toThrow(
      /insufficient credits/,
    );
    // Before D1 a 400 got 1 + MAX_TRUNCATION_RETRIES(3) = 4 POSTs.
    expect(requestCount()).toBe(1);
  }, 30_000);

  it("an uncertain payment-like error is retried exactly once per model (2 POSTs, then thrown), and three such models never pause on the breaker", async () => {
    // 3 models x 2 POSTs = 6 consecutive failures: past the breaker's
    // threshold of 5, so a counted failure would sleep 60s before a retry.
    const { url, requestCount } = await startErrorServer(400, "your payment method was declined");
    const deps = baseDeps(backendAt(url), null);
    const stderr = captureStderr();
    const t0 = Date.now();
    try {
      for (let i = 1; i <= 3; i++) {
        await expect(chatCompletionWithRetry(MESSAGES, { model: `chain/m${i}` }, deps)).rejects.toThrow(
          /payment method was declined/,
        );
        expect(requestCount(), `model ${i}: one retry, then give way to the next entry`).toBe(2 * i);
      }
      expect(stderr.text()).not.toContain("[circuit-breaker]");
    } finally {
      stderr.restore();
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("HTTP 500 with API error 400 in its body still counts as an outage", async () => {
    const { url } = await startErrorServer(500, "upstream reports API error 400");
    const deps = { ...baseDeps(backendAt(url), null), getSoftTimeoutMs: () => 700 };
    await expect(chatCompletionWithRetry(MESSAGES, { model: "chain/body-status", deadlineAt: Date.now() + 3000 }, deps)).rejects.toThrow(/API error 500/);
    expect(serviceFailureCountForTests()).toBeGreaterThan(0);
  }, 10_000);
  it("an IRON RULE refusal caught after the retry window closed is thrown as itself, not as RetryDeadlineError (TRDD-VAORGKVF)", async () => {
    resetServiceHealthForTests();
    // Real path, no mock: a tool usage-context + a billable backend + a non-:free model makes resolveConnection's assertModelValidated refuse before the wire. The deadline is already past, so the retry window is closed when the catch block runs; the mutation check (removing isIronRuleRefusal from keepsOwnError turns this test red) shows closedWindowError() is what decides it.
    const deps = baseDeps(backendAt("http://127.0.0.1:1"), null);
    const error = await withUsageContext({ tool: "scan_folder", params: "", project: "/p" }, () =>
      chatCompletionWithRetry(MESSAGES, { model: "vendor/x", deadlineAt: Date.now() - 1000 }, deps),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.startsWith(IRON_RULE_REFUSAL_PREFIX)).toBe(true);
    expect((error as Error).message).toContain("Validate it");
    expect(error).not.toBeInstanceOf(RetryDeadlineError);
  }, 10_000);
  it.each([[400, 4, 2], [401, 1, 6]])("HTTP %i makes %i request(s) per call over %i calls, keeps the raw status, and does not poison the breaker", async (status, perCall, calls) => {
    const { url, requestCount } = await startErrorServer(status, status === 400 ? "malformed request" : "invalid credentials");
    const deps = baseDeps(backendAt(url), null);
    // Enough calls to exceed the breaker threshold of 5 if these refusals were counted (400 retries 4x, so 2 calls; 401 stops at once, so 6 calls). Owner ruling 2026-10-23 TRDD-YG72CYY7 Q1.
    for (let i = 1; i <= calls; i++) {
      const model = `chain/refused-${status}-${i}`;
      await expect(chatCompletionWithRetry(MESSAGES, { model, deadlineAt: Date.now() + 5000 }, deps)).rejects.toThrow(`API error ${status}`);
      expect(requestCount()).toBe(i * perCall);
      expect(isRunUnusable(model)).toBe(false);
    }
    await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
    server = undefined;
    const transient = await startErrorServer(500, "upstream exploded");
    const transientDeps = { ...baseDeps(backendAt(transient.url), null), getSoftTimeoutMs: () => 1500 };
    const started = Date.now();
    await expect(chatCompletionWithRetry(MESSAGES, { model: "chain/transient", deadlineAt: started + 5000 }, transientDeps)).rejects.toThrow(/upstream exploded|API error 500/);
    expect(transient.requestCount()).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);
  it("six consecutive deterministic 403s: one POST per model and no circuit-breaker pause (GitHub-15, D4)", async () => {
    // GitHub-15 finding 2: the breaker exists for outages; a permanent 403
    // ("only available on agentic harnesses") cannot succeed by asking again,
    // so counting it parked the walk in 60/120/350 s sleeps before a
    // guaranteed refusal (measured: 530 of 941 s were breaker sleeps).
    // Six 403-models on one server, THEN one transient-failing model: the
    // 7th call is the discriminator — with the old counting the poisoned
    // streak (6 >= threshold 5) made its first generic retry sleep 60 s and
    // print "[circuit-breaker]"; fixed, the streak stays 0 and it retries
    // instantly.
    const { url, requestCount } = await startErrorServer(
      403,
      "thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent",
    );
    const deps = baseDeps(backendAt(url), null);
    const stderr = captureStderr();
    const t0 = Date.now();
    try {
      for (let i = 1; i <= 6; i++) {
        await expect(chatCompletionWithRetry(MESSAGES, { model: `chain/m${i}` }, deps)).rejects.toThrow(
          /API error 403/,
        );
        expect(requestCount(), `deterministic 403: model ${i} must be asked exactly once`).toBe(i);
      }
      // The discriminator: a transient 500 AFTER the 403 streak reaches the
      // generic-retry branch, which consults the breaker — with the old
      // counting the poisoned streak (6 >= threshold 5) made its first
      // generic retry sleep 60 s and print "[circuit-breaker]"; fixed, the
      // streak stays 0 and it retries instantly. The 1500 ms soft timeout
      // caps fetchWithRetry429's internal 5xx ladder at ~1 retry (budget
      // check `remaining < 2000`), so the whole probe stays inside the
      // test's 20 s limit; the breaker's own 60 s sleep would blow it.
      const { url: url5xx, requestCount: count5xx } = await startErrorServer(500, "upstream exploded");
      const deps5xx = { ...baseDeps(backendAt(url5xx), null), getSoftTimeoutMs: () => 1500 };
      await expect(chatCompletionWithRetry(MESSAGES, { model: "chain/t1" }, deps5xx)).rejects.toThrow(
        /upstream exploded|API error 500/,
      );
      expect(count5xx()).toBeGreaterThanOrEqual(1);
      expect(stderr.text()).not.toContain("[circuit-breaker]");
    } finally {
      stderr.restore();
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("a transient 5xx streak trips the circuit breaker (60s, then 120s) and the 350s rung is skipped for the abort verdict, never deferred to the next call", async () => {
    const { url, requestCount } = await startErrorServer(500, "upstream exploded");
    // A 700 ms budget: fetchWithRetry429's first back-off (>= 750 ms) no longer
    // fits it, so each request is exactly ONE POST and this test measures only
    // chatCompletionWithRetry's own loop and the breaker, not the HTTP layer's
    // separate 5xx retries.
    const deps: CompletionDeps = { ...baseDeps(backendAt(url), null), getSoftTimeoutMs: () => 700 };
    const stderr = captureStderr();
    // Only setTimeout/clearTimeout are faked: the breaker's pauses become
    // instant to advance, while Date and the real loopback sockets stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Call 1: 1 + MAX_TRUNCATION_RETRIES(3) = 4 failures, below the
      // threshold of 5 at every check -- no pause.
      await expect(chatCompletionWithRetry(MESSAGES, { model: "chain/m1" }, deps)).rejects.toThrow(
        /API error 500/,
      );
      expect(requestCount()).toBe(4);
      expect(stderr.text()).not.toContain("[circuit-breaker]");
      // Call 2: its first failure is the 5th in a row -- the breaker pauses
      // before each of its first two retries. TRDD-YG72CYY7 F4: the third rung
      // (350 s) is longer than the 300 s retry window and can never fit it, so
      // the breaker skips it and goes straight to its abort verdict -- it does
      // not sleep, and it does not leave the ladder armed for the NEXT call.
      const second = chatCompletionWithRetry(MESSAGES, { model: "chain/m2" }, deps);
      for (const [seconds, ms] of [
        ["60s", 60_000],
        ["120s", 120_000],
      ] as const) {
        await vi.waitFor(
          () => expect(stderr.text()).toContain(`consecutive failures detected — waiting ${seconds}`),
          { timeout: 10_000, interval: 5 },
        );
        await vi.advanceTimersByTimeAsync(ms);
      }
      // The abort verdict is a RETURNED label (finishReason "error"), not a
      // throw, so there is no error object whose .cause/trail could be read:
      // the assertion is on the verdict itself and on how long the ladder ran.
      const verdict = await second;
      expect(verdict.finishReason).toBe("error");
      expect(verdict.serviceAbort).toBe(true);
      expect(verdict.truncated).toBe(true);
      expect(verdict.content).toContain("SERVER ISSUE DETECTED");
      // Both rungs were waited and the next (350 s) is longer than the window:
      // the verdict says it was cut short, not that the ladder ran to the end.
      expect(verdict.content).toContain("Backoff waits already used in this process: 60s, 120s;");
      expect(verdict.content).toContain("longer than the retry window");
      expect(verdict.content).not.toContain("Tried waiting");
      expect(stderr.text()).not.toContain("waiting 350s");
      expect(requestCount()).toBe(7);
      expect(stderr.text()).toContain("[circuit-breaker] 5 consecutive failures detected — waiting 60s");
      // Call 3 (an unrelated call): the breaker was half-opened by the abort,
      // so it is NOT stuck behind a 350 s sleep -- it makes real requests
      // (4 failures, below the threshold) and ends with its own error.
      await expect(chatCompletionWithRetry(MESSAGES, { model: "chain/m3" }, deps)).rejects.toThrow(
        /API error 500/,
      );
      expect(requestCount()).toBe(11);
      expect(stderr.text()).not.toContain("waiting 350s");
    } finally {
      vi.useRealTimers();
      stderr.restore();
    }
  }, 30_000);
});
