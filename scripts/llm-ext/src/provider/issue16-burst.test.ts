/**
 * issue16-burst.test.ts — TRDD-YG72CYY7 inc 3 round C: the free-tier per-minute 429 burst (GitHub issue 16 item 3
 * part A) and the golden snapshot of the unavailable/payment classifiers over real ledger details.
 *
 * REAL node:http servers; the code under test is never mocked. The server ignores GET model-info probes so counts are exact.
 * The 429 body is `synthetic:` (hand-built in the "free-models-per-min" form src/provider-error-sanitize.test.ts:52-62 also
 * builds by hand); no recorded free-tier 429 body exists in the repo fixtures.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { chatCompletionWithRetry, resetServiceHealthForTests } from "./completion.js";
import { RetryDeadlineError, type RetryClock } from "./http.js";
import { AllFreeModelsExhaustedError, callWithFreeRotation, classifyUnavailable, memoryRotationStore } from "../free-rotation.js";
import { paymentErrorCertainty } from "../benchmark/free-mode.js";
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

const PER_MIN_429 = JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-min. ", code: 429 } });

/** synthetic: 429 three times with Retry-After 1 (a free-tier per-minute cap), then a normal 200. */
const burstThenOk = (n: number, res: ServerResponse) => {
  if (n <= 3) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(PER_MIN_429);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "ok after burst" }, finish_reason: "stop" }] }));
};

const always429 = (retryAfter?: string) => (_n: number, res: ServerResponse) => {
  res.writeHead(429, { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) });
  res.end(PER_MIN_429);
};

describe("synthetic: issue 16 item 3 part A, a free-tier per-minute 429 burst is retried inside the window", () => {
  it("pin, paid path: chatCompletionWithRetry, 3 x 429 (Retry-After 1) then 200 succeeds with 4 requests, default window", async () => {
    const { url, requestCount } = await startServer(burstThenOk);
    const result = await chatCompletionWithRetry(MESSAGES, { model: "m" }, depsFor(url));
    expect(result.content).toBe("ok after burst");
    expect(requestCount()).toBe(4);
  }, 60_000);

  // What happens: callOne (chatCompletionWithRetry, as callSingleWithFreeRotation index.ts:2868 wires it) retries the
  // 429 itself (http.ts fetchWithRetry429), so callWithFreeRotation (free-rotation.ts:1338) never sees a failure: its
  // catch (1446-1472, classifyUnavailable "transient" -> cooldown + rotate) is not reached. Same-model retry, no rotation.
  it("free path: callWithFreeRotation succeeds on the SAME model after the burst (same-model retry, no rotation, no cooldown)", async () => {
    const { url, requestCount } = await startServer(burstThenOk);
    const clock: RetryClock = {};
    const tried: string[] = [];
    const store = memoryRotationStore();
    const result = await callWithFreeRotation(
      { id: "vendor/free-a:free", maxOutput: 256 },
      [{ id: "vendor/free-b:free", maxOutput: 256 }],
      (model, maxOutput) => chatCompletionWithRetry(MESSAGES, { model, maxTokens: maxOutput, retryClock: clock }, depsFor(url)),
      { retryClock: clock, store, onAttempt: (id) => tried.push(id) },
    );
    expect(result.content).toBe("ok after burst");
    expect(requestCount()).toBe(4);
    expect(tried).toEqual(["vendor/free-a:free"]);
  }, 60_000);
});

describe("synthetic: after the window the file fails with the rate-limit cause", () => {
  // The observable "cause rate-limit" is RetryDeadlineError (http.ts:201): trail.lastStatus 429, and retryAt set with the
  // message "Rate limit: the provider asked to wait until <ISO>..." when a Retry-After lies beyond the window; with no
  // Retry-After the window just closes: retryAt undefined, message "Retry window closed ... last status 429", and
  // `.cause` is the last `API error 429` error.
  it("pin, paid path: Retry-After beyond a 4 s window stops at once, trail status 429, retryAt set, rate-limit message", async () => {
    const { url, requestCount } = await startServer(always429("600"));
    const t0 = Date.now();
    const err = await caught(chatCompletionWithRetry(MESSAGES, { model: "m", deadlineAt: t0 + 4000 }, depsFor(url)));
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const e = err as RetryDeadlineError;
    expect(e.trail.lastStatus).toBe(429);
    expect(e.retryAt).toBeGreaterThan(t0 + 500_000);
    expect(e.message).toMatch(/^Rate limit: /);
    expect(requestCount()).toBe(1);
  }, 60_000);

  it("pin, paid path: a permanent 429 without Retry-After closes the 4 s window: trail status 429, last error is the API error 429", async () => {
    const { url, requestCount } = await startServer(always429());
    const err = await caught(chatCompletionWithRetry(MESSAGES, { model: "m", deadlineAt: Date.now() + 4000 }, depsFor(url)));
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const e = err as RetryDeadlineError;
    expect(e.trail.lastStatus).toBe(429);
    expect(e.retryAt).toBeUndefined();
    expect(e.message).toContain("last status 429");
    expect((e.cause as Error).message).toMatch(/^API error 429 /);
    expect(requestCount()).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("free path: a permanent 429 on the shared 4 s clock rethrows the closed-window RetryDeadlineError from the rotation (free-rotation.ts:1446)", async () => {
    const { url } = await startServer(always429());
    const clock: RetryClock = { deadlineAt: Date.now() + 4000 };
    const err = await caught(
      callWithFreeRotation(
        { id: "vendor/free-a:free", maxOutput: 256 },
        [],
        (model, maxOutput) => chatCompletionWithRetry(MESSAGES, { model, maxTokens: maxOutput, retryClock: clock }, depsFor(url)),
        { retryClock: clock, store: memoryRotationStore() },
      ),
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const e = err as RetryDeadlineError;
    expect(e.dispatchClosed).toBe(true);
    expect(e.trail.lastStatus).toBe(429);
    expect((e.cause as Error).message).toMatch(/^API error 429 /);
  }, 60_000);

  it("free path: a Retry-After beyond the window is one model's refusal: cooldown with retryAt, pool exhausted (no other model to try)", async () => {
    const { url, requestCount } = await startServer(always429("600"));
    const clock: RetryClock = { deadlineAt: Date.now() + 4000 };
    const store = memoryRotationStore();
    const err = await caught(
      callWithFreeRotation(
        { id: "vendor/free-a:free", maxOutput: 256 },
        [],
        (model, maxOutput) => chatCompletionWithRetry(MESSAGES, { model, maxTokens: maxOutput, retryClock: clock }, depsFor(url)),
        { retryClock: clock, store },
      ),
    );
    expect(err).toBeInstanceOf(AllFreeModelsExhaustedError);
    expect(requestCount()).toBe(1);
  }, 60_000);
});

describe("golden snapshot: classifyUnavailable and paymentErrorCertainty over real ledger details (scan-path message form)", () => {
  // This pins CURRENT behaviour (results recorded from the code at 0be95d5f), NOT verified-correct behaviour. Known
  // questionable entries, pinned only so a change is deliberate: the 403 "not found" family (a 403 "No auth credentials
  // found" is null but any 403/404 text containing "not found" is "gone"); the unanchored STATUS_CODE_RE
  // (free-rotation.ts:701, a bare "API error 404" with no detail is "gone"); a 402 reads null from classifyUnavailable and
  // "certain" from paymentErrorCertainty, while a text merely mentioning credits/payment is only "uncertain".
  // Details are the real model-events ledger fragments (brief section 6).
  const rows: Array<[number, string, ReturnType<typeof classifyUnavailable>, ReturnType<typeof paymentErrorCertainty>]> = [
    [402, "Insufficient credits", null, "certain"],
    [402, "payment required", null, "certain"],
    [403, "No auth credentials found", null, null],
    [403, "google/x:free is only available on agentic harnesses", "gone", null],
    [403, "Daily rate limit exceeded for free models", "daily-quota", null],
    [404, "No endpoints found for model google/x:free", "gone", null],
    [401, "", null, null],
    [403, "", null, null],
    [404, "", "gone", null],
    [429, "", "transient", null],
  ];
  it.each(rows)("API error %i (openrouter): %s", (status, detail, unavailable, payment) => {
    const msg = `API error ${status} (openrouter): ${detail}`;
    expect(classifyUnavailable(msg)).toBe(unavailable);
    expect(paymentErrorCertainty(msg)).toBe(payment);
  });
});
