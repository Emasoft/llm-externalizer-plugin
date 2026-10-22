/**
 * retry-clock.test.ts — TRDD-YG72CYY7 increment 1: the retry clock.
 *
 * REAL chatCompletionWithRetry against a REAL node:http server (no mocks).
 * The error body is the real OpenRouter envelope recorded in
 * provider-error-sanitize.test.ts (the dogfood-run 429 blob, "Provider
 * returned error" + metadata.provider_name/raw); the 503 case reuses that
 * envelope with code 503 because the repo holds no recorded 503 body.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { chatCompletionWithRetry, resetServiceHealthForTests } from "./completion.js";
import { RetryDeadlineError, fetchWithRetry429, waitFitsClock, type RetryClock } from "./http.js";
import { resetRunUnusableForTests } from "../free-rotation.js";
import type { BackendConfig, CompletionDeps, ChatMessage } from "./types.js";

import { chatCompletionJSON } from "./completion.js";

import { callWithFreeRotation, memoryRotationStore } from "../free-rotation.js";


import { checkServiceHealthForTests, serviceHealthSleepersForTests, tripServiceHealthForTests } from "./completion.js";
import { recordServiceSuccessForTests, setServiceFailuresForTests } from "./completion.js";

let server: Server | undefined;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  resetServiceHealthForTests();
});

const ENVELOPE = (code: number) =>
  JSON.stringify({
    error: {
      message: "Provider returned error",
      code,
      metadata: {
        raw: "google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations",
        provider_name: "Google AI Studio",
        is_byok: false,
      },
    },
  });

/** `handler(n, res)` answers the n-th POST; GET probes (LM Studio detection) get 404. */
async function startServer(handler: (n: number, res: import("node:http").ServerResponse) => void) {
  let count = 0;
  server = createServer((req, res) => {
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
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, requestCount: () => count };
}

function depsFor(url: string): CompletionDeps {
  const backend: BackendConfig = {
    type: "local",
    billable: false,
    isLocal: false,
    baseUrl: url,
    apiKey: "k",
    model: "m",
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


const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];


describe("retry clock — second review (TRDD-YG72CYY7 inc 1, N3 N6)", () => {
  it("N6: a Retry-After reply that arrives after the window closed still reports when to retry", async () => {
    const { url } = await startServer((n, res) => {
      if (n === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(ENVELOPE(503));
        return;
      }
      // Attempt 2 starts inside the window and answers 429 + Retry-After AFTER it closed.
      setTimeout(() => {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "600" });
        res.end(ENVELOPE(429));
      }, 1800);
    });
    const t0 = Date.now();
    const err = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: t0 + 1500 },
      depsFor(url),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const e = err as RetryDeadlineError;
    expect(e.retryAt).toBeGreaterThan(t0 + 500_000);
    expect(e.message).toMatch(/Rate limit/);
  }, 30_000);

  const emptyServer = (finish: string) =>
    startServer((_n, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: finish }] }));
    });

  it("N3: an empty reply that closes the window is labelled with the real attempt count, not the retry limit", async () => {
    const { url } = await emptyServer("stop");
    const result = await chatCompletionWithRetry(
      MESSAGES,
      { model: "n3-label-model", deadlineAt: Date.now() + 3000 },
      depsFor(url),
    );
    expect(result.content).toContain("retry window closed after 2 attempt(s)");
    expect(result.content).not.toMatch(/after 15 retries/);
  }, 30_000);

  it("N3: a window closure does not record the reasoning-cache downgrade of the reply that ended the call", async () => {
    const { url } = await emptyServer("stop");
    await chatCompletionWithRetry(
      MESSAGES,
      { model: "n3-ladder-model", deadlineAt: Date.now() + 3000 },
      depsFor(url),
    );
    const { reasoningLadderForModel } = await import("./completion.js");
    // Attempt 1 (a retry followed): xhigh -> high, so two rungs. Attempt 2 closed
    // the window with no retry after it: no second downgrade to "none" (one rung).
    expect(reasoningLadderForModel("n3-ladder-model", "xhigh")).toHaveLength(2);
  }, 30_000);

  it("N3: a length+empty reply that closes the window records no no-content strike", async () => {
    const fs = await import("node:fs");
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    const cfg = fs.mkdtempSync("/tmp/llm-ext-n3-strike-");
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    try {
      const { url } = await emptyServer("length");
      const result = await chatCompletionWithRetry(
        MESSAGES,
        { model: "n3-strike-model", deadlineAt: Date.now() + 3000 },
        depsFor(url),
      );
      expect(result.content).toContain("retry window closed after 2 attempt(s)");
      expect(fs.existsSync(`${cfg}/no-content-strikes.json`)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("chatCompletionWithRetry — retry clock (TRDD-YG72CYY7 inc 1)", () => {
  it("a persistent 503 stops near a 4 s deadline with RetryDeadlineError, its trail and the last error as cause", async () => {
    const { url, requestCount } = await startServer((_n, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(ENVELOPE(503));
    });
    const t0 = Date.now();
    const err = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: t0 + 4000 },
      depsFor(url),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const e = err as RetryDeadlineError;
    // Stopped by the clock, not by exhausting the 3-retry x 6-attempt counters
    // (that would take > 60 s): inside the window, and after at least 2 waits.
    expect(elapsed).toBeGreaterThan(2000);
    expect(elapsed).toBeLessThan(4000 + 1500);
    expect(e.trail.attempts).toBe(requestCount());
    expect(e.trail.attempts).toBeGreaterThanOrEqual(3);
    expect(e.trail.lastStatus).toBe(503);
    expect(e.trail.lastProvider).toBe("Google AI Studio");
    expect(e.trail.elapsedMs).toBeLessThanOrEqual(elapsed);
    expect((e.cause as Error).message).toMatch(/API error 503/);
    expect(e.message).not.toMatch(/transient|temporar/i);
  }, 30_000);

  it("never aborts a request in flight: a reply arriving after the deadline still succeeds", async () => {
    const { url } = await startServer((n, res) => {
      if (n === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(ENVELOPE(503));
        return;
      }
      // Attempt 2 starts inside the window but answers AFTER it closed.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "late but whole" }, finish_reason: "stop" }] }));
      }, 1800);
    });
    const t0 = Date.now();
    const result = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: t0 + 1500 },
      depsFor(url),
    );
    expect(result.content).toBe("late but whole");
    expect(Date.now() - t0).toBeGreaterThan(1500);
  }, 30_000);

  it("a Retry-After beyond the window stops at once with a rate-limit verdict and the time to retry", async () => {
    const { url, requestCount } = await startServer((_n, res) => {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "600" });
      res.end(ENVELOPE(429));
    });
    const t0 = Date.now();
    const err = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: t0 + 4000 },
      depsFor(url),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const e = err as RetryDeadlineError;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(requestCount()).toBe(1);
    expect(e.trail.lastStatus).toBe(429);
    expect(e.retryAt).toBeGreaterThan(t0 + 500_000);
    expect(e.message).toMatch(/Rate limit/);
    expect(e.message).toContain(new Date(e.retryAt!).toISOString());
  }, 30_000);
});


describe("retry clock — review findings (TRDD-YG72CYY7 inc 1 fixes)", () => {
  it("F1: a 5xx answered after the deadline is not reported as a rate limit", async () => {
    const { url } = await startServer((n, res) => {
      if (n === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(ENVELOPE(503));
        return;
      }
      // Attempt 2 starts inside the window and answers 503 AFTER it closed.
      setTimeout(() => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(ENVELOPE(503));
      }, 1800);
    });
    const t0 = Date.now();
    const err = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: t0 + 1500 },
      depsFor(url),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const e = err as RetryDeadlineError;
    expect(e.retryAt).toBeUndefined();
    expect(e.message).not.toMatch(/Rate limit/);
    expect(e.trail.lastStatus).toBe(503);
  }, 30_000);

  it("F2: the body returned on a Retry-After break belongs to the same attempt as its status", async () => {
    const { url } = await startServer((n, res) => {
      if (n === 1) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("attempt-1-marker");
        return;
      }
      res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "600" });
      res.end("attempt-2-marker");
    });
    const err = await chatCompletionWithRetry(MESSAGES, { model: "m" }, depsFor(url)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    const cause = (err as RetryDeadlineError).cause as Error;
    expect(cause.message).toContain("attempt-2-marker");
    expect(cause.message).not.toContain("attempt-1-marker");
  }, 30_000);

  it("F6: an empty reply that closes the window returns the labelled reply instead of throwing", async () => {
    const { url, requestCount } = await startServer((_n, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
    });
    const t0 = Date.now();
    const result = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: t0 + 3000 },
      depsFor(url),
    );
    expect(result.content).toContain("EMPTY RESPONSE");
    expect(result.truncated).toBe(true);
    expect(requestCount()).toBe(2);
  }, 30_000);

  it("F6: waitFitsClock refuses every wait once the clock is already expired", () => {
    const clock: RetryClock = { startedAt: Date.now(), deadlineAt: Date.now() + 100_000, expired: true };
    expect(waitFitsClock(clock, 1)).toBe(false);
  });

  it("F7: an uncertain payment error keeps its own error when the window is closed", async () => {
    const { url } = await startServer((_n, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Please check your credits balance" } }));
    });
    const err = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: Date.now() - 1 },
      depsFor(url),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryDeadlineError);
    expect((err as Error).message).toMatch(/API error 400/);
  }, 30_000);

  it("F7: a non-4xx model-gone verdict keeps its own error when the window is closed", async () => {
    const { url } = await startServer((_n, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("no endpoints found for this model");
    });
    const err = await chatCompletionWithRetry(
      MESSAGES,
      { model: "gone-model-f7", deadlineAt: Date.now() - 1 },
      depsFor(url),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    // The call marked the model run-unusable (process-wide); do not leak that.
    resetRunUnusableForTests();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryDeadlineError);
    expect((err as Error).message).toMatch(/no endpoints/i);
  }, 30_000);

  it("F8: a network error clears the last status so the trail cannot report a stale one", async () => {
    const { url } = await startServer((n, res) => {
      if (n === 1) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("x");
        return;
      }
      res.destroy();
    });
    const t0 = Date.now();
    const clock: RetryClock = { deadlineAt: t0 + 1800 };
    await expect(
      fetchWithRetry429(`${url}/v1/chat/completions`, { method: "POST", body: "{}" }, 30_000, t0, undefined, clock),
    ).rejects.toThrow();
    expect(clock.attempts).toBe(2);
    expect(clock.lastStatus).toBeUndefined();
  }, 30_000);

  it("F8: the provider in the trail is the sanitized provider tag, not any bracket in the text", async () => {
    const { url } = await startServer((_n, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Provider returned error at [0]",
            code: 503,
            metadata: { raw: "upstream down", provider_name: "Google AI Studio" },
          },
        }),
      );
    });
    const err = await chatCompletionWithRetry(
      MESSAGES,
      { model: "m", deadlineAt: Date.now() + 1500 },
      depsFor(url),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    expect((err as RetryDeadlineError).trail.lastProvider).toBe("Google AI Studio");
  }, 30_000);

  describe("shared retry clock across calls of one dispatch (TRDD-YG72CYY7 inc 2 round B1)", () => {
    /** Always-503 server that also records every POST body it received. */
    async function start503Recording() {
      const bodies: string[] = [];
      server = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          bodies.push(raw);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(ENVELOPE(503));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const addr = server!.address();
      if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
      return { url: `http://127.0.0.1:${addr.port}`, bodies };
    }

    it("a: a second chatCompletionWithRetry under the closed shared clock makes zero requests and throws RetryDeadlineError with a cause", async () => {
      const { url, bodies } = await start503Recording();
      const t0 = Date.now();
      // Window set through the clock's own deadlineAt (the mechanism the inc-1 tests set via options.deadlineAt).
      const clock: RetryClock = { deadlineAt: t0 + 3000 };
      const first = await chatCompletionWithRetry(MESSAGES, { model: "m", retryClock: clock }, depsFor(url)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(first).toBeInstanceOf(RetryDeadlineError);
      const afterFirst = bodies.length;
      expect(afterFirst).toBeGreaterThanOrEqual(2);
      const t1 = Date.now();
      const second = await chatCompletionWithRetry(MESSAGES, { model: "other", retryClock: clock }, depsFor(url)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(second).toBeInstanceOf(RetryDeadlineError);
      expect((second as RetryDeadlineError).cause).toBeDefined();
      expect(bodies.length).toBe(afterFirst);
      expect(Date.now() - t1).toBeLessThan(500);
      // One window (3000 ms) plus 1500 ms margin for the in-flight request and the last backoff check; never two windows.
      expect(Date.now() - t0).toBeLessThan(3000 + 1500);
      // The control field never reaches the provider.
      for (const b of bodies) expect(Object.keys(JSON.parse(b))).not.toContain("retryClock");
    }, 30_000);

    it("d: a second chatCompletionJSON under the closed shared clock makes zero requests and throws RetryDeadlineError with a cause", async () => {
      const { url, bodies } = await start503Recording();
      const t0 = Date.now();
      const clock: RetryClock = { deadlineAt: t0 + 3000 };
      // chatCompletionJSON has no retry wrapper: its first call ends with the plain
      // "API error 503" Error (fetchWithRetry429 returns the last 503 once the wait is refused).
      const first = await chatCompletionJSON(MESSAGES, { model: "m", retryClock: clock }, depsFor(url)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(first).toBeInstanceOf(Error);
      expect(first).not.toBeInstanceOf(RetryDeadlineError);
      expect((first as Error).message).toMatch(/API error 503/);
      const afterFirst = bodies.length;
      expect(afterFirst).toBeGreaterThanOrEqual(2);
      const second = await chatCompletionJSON(MESSAGES, { model: "other", retryClock: clock }, depsFor(url)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(second).toBeInstanceOf(RetryDeadlineError);
      expect(((second as RetryDeadlineError).cause as Error).message).toMatch(/API error 503/);
      expect(bodies.length).toBe(afterFirst);
      expect(Date.now() - t0).toBeLessThan(3000 + 1500);
      for (const b of bodies) expect(Object.keys(JSON.parse(b))).not.toContain("retryClock");
    }, 30_000);


    it("g: poisoning regression: after one model closes the shared clock the rotation ends, the untried model gets no request and no unavailable record", async () => {
      const { url, bodies } = await start503Recording();
      const store = memoryRotationStore();
      const t0 = Date.now();
      const clock: RetryClock = { deadlineAt: t0 + 3000 };
      const err = await callWithFreeRotation(
        { id: "m1:free", maxOutput: 100 },
        [{ id: "m2:free", maxOutput: 100 }],
        (model) => chatCompletionWithRetry(MESSAGES, { model, retryClock: clock }, depsFor(url)),
        { now: () => 0, store, retryClock: clock },
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RetryDeadlineError);
      expect(Date.now() - t0).toBeLessThan(3000 + 1500);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      for (const b of bodies) expect((JSON.parse(b) as { model?: string }).model).toBe("m1:free");
      // The first model's own deadline error is not an availability verdict, and the untried second model has no record.
      expect(Object.keys(store.get(0).models)).toEqual([]);
    }, 30_000);


    it("F1: a Retry-After beyond the window on model 1 ends only model 1: model 2 answers, model 1 is recorded unavailable, the shared clock stays open", async () => {
      const seen: string[] = [];
      server = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          const model = (JSON.parse(raw) as { model?: string }).model ?? "";
          seen.push(model);
          if (model === "m1:free") {
            res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "600" });
            res.end(ENVELOPE(429));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "from m2" }, finish_reason: "stop" }], model }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const addr = server!.address();
      if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${addr.port}`;
      const store = memoryRotationStore();
      const clock: RetryClock = { deadlineAt: Date.now() + 4000 };
      const result = await callWithFreeRotation(
        { id: "m1:free", maxOutput: 100 },
        [{ id: "m2:free", maxOutput: 100 }],
        (model) => chatCompletionWithRetry(MESSAGES, { model, retryClock: clock }, depsFor(url)),
        { now: () => 0, store, retryClock: clock },
      );
      expect(result.content).toBe("from m2");
      expect(seen).toEqual(["m1:free", "m2:free"]);
      expect(Object.keys(store.get(0).models)).toEqual(["m1:free"]);
      expect(clock.expired).toBeUndefined();
    }, 30_000);

    it("F1: a RetryDeadlineError with dispatchClosed false is classified and rotated; with true it is rethrown", async () => {
      const trail = { attempts: 1, elapsedMs: 10, lastStatus: 429 };
      const cause = new Error("API error 429 (openrouter): rate-limited upstream");
      const run = async (closed: boolean) => {
        const called: string[] = [];
        const store = memoryRotationStore();
        const dl = new RetryDeadlineError(trail, cause, Date.now() + 600_000, closed);
        const out = await callWithFreeRotation(
          { id: "a:free", maxOutput: 1 },
          [{ id: "b:free", maxOutput: 1 }],
          async (m) => {
            called.push(m);
            if (m === "a:free") throw dl;
            return "ok";
          },
          { now: () => 0, store },
        ).then(
          (v) => v as unknown,
          (e: unknown) => e,
        );
        return { out, called, recorded: Object.keys(store.get(0).models), dl };
      };
      const open = await run(false);
      expect(open.out).toBe("ok");
      expect(open.called).toEqual(["a:free", "b:free"]);
      expect(open.recorded).toEqual(["a:free"]);
      const closed = await run(true);
      expect(closed.out).toBe(closed.dl);
      expect(closed.called).toEqual(["a:free"]);
      expect(closed.recorded).toEqual([]);
    });


    it("round C0b item 1 (B4): the trail's provider is never regexed out of the finished text — a '[0]' in the message is not a provider", async () => {
      server = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        req.resume();
        req.on("end", () => {
          // The body carries NO provider_name (so clock.lastProvider stays
          // undefined and the sanitizer prints the plain message); the message
          // itself ends in "[0]". At HEAD the removed bracket regex read that
          // "[0]" as the provider; the snapshot path must fall back to the
          // backend type instead of trusting a bracket in the text.
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Provider returned error at [0]", code: 503, metadata: { raw: "upstream down" } },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const addr = server!.address();
      if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${addr.port}`;
      const clock: RetryClock = { deadlineAt: Date.now() + 1500 };
      const err = await chatCompletionWithRetry(MESSAGES, { model: "m", retryClock: clock }, depsFor(url)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RetryDeadlineError);
      const e = err as RetryDeadlineError;
      expect(((e.cause as Error).message)).toContain("Provider returned error at [0]");
      expect(e.trail.lastProvider).toBe("local");
      expect(e.trail.lastStatus).toBe(503);
    }, 30_000);
    it("round C0b item 3 (B7): a Retry-After 600 refusal on model 1 (dispatchClosed false) records a cooldown ending no earlier than the refusal's retryAt", async () => {
      server = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          const model = (JSON.parse(raw) as { model?: string }).model ?? "";
          if (model === "m1:free") {
            res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "600" });
            res.end(ENVELOPE(429));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "from m2" }, finish_reason: "stop" }], model }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const addr = server!.address();
      if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${addr.port}`;
      const store = memoryRotationStore();
      const clock: RetryClock = { deadlineAt: Date.now() + 4000 };
      // The refusal's retryAt is now + 600 s (http.ts parses the Retry-After
      // header as a delay from the response); the call and its rotation run
      // within a second or two, so capture the floor before the call and add
      // a 5 s slack for the retryAt the error actually carries.
      const refusedAt = Date.now();
      const result = await callWithFreeRotation(
        { id: "m1:free", maxOutput: 100 },
        [{ id: "m2:free", maxOutput: 100 }],
        (model) => chatCompletionWithRetry(MESSAGES, { model, retryClock: clock }, depsFor(url)),
        { now: Date.now, store, retryClock: clock },
      );
      expect(result.content).toBe("from m2");
      const recordedAt = Date.now();
      // Round C0b item 3 (B7): the rotation must honour the provider's
      // Retry-After. At HEAD the recorded cooldown is the generic 30 s
      // transient ladder, far below the 600 s the provider asked for; the
      // stored entry must now end no earlier than the refusal's retryAt
      // (and no later than the 24 h cap on it).
      const entry = store.get(recordedAt).models["m1:free"];
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe("transient");
      expect(entry?.until).toBeGreaterThanOrEqual(refusedAt + 600_000 - 5_000);
      expect(entry?.until).toBeLessThanOrEqual(recordedAt + 86_400_000);
 
    }, 30_000);

    it("F2: a call that starts under a window another call closed reports no rate limit and no retryAt, the status of its cause, and a foreign-cause label", async () => {
      const { url } = await start503Recording();
      const clock: RetryClock = { deadlineAt: Date.now() + 2500 };
      await chatCompletionWithRetry(MESSAGES, { model: "m", retryClock: clock }, depsFor(url)).catch(() => undefined);
      // Another slot's 429 must not leak into this call's error through the clock.
      clock.lastStatus = 429;
      const second = await chatCompletionWithRetry(MESSAGES, { model: "x", retryClock: clock }, depsFor(url)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(second).toBeInstanceOf(RetryDeadlineError);
      const e = second as RetryDeadlineError;
      expect(e.message).not.toMatch(/Rate limit/);
      expect(e.retryAt).toBeUndefined();
      expect(e.dispatchClosed).toBe(true);
      expect(e.trail.lastStatus).toBe(503);
      expect(e.causeLabel).toBe("Last error seen in this dispatch:");
    }, 30_000);

  describe("round C0a item 1 (B1): a private-clock deadline rotates instead of rethrowing", () => {
    it("model 1 closing its OWN window (no shared clock) ends only model 1: model 2 answers, model 1 is recorded unavailable", async () => {
      const seen: string[] = [];
      server = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          const model = (JSON.parse(raw) as { model?: string }).model ?? "";
          seen.push(model);
          if (model === "m1:free") {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(ENVELOPE(503));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "from m2" }, finish_reason: "stop" }], model }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const addr = server!.address();
      if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${addr.port}`;
      const store = memoryRotationStore();
      // NO retryClock option: each chatCompletionWithRetry owns a PRIVATE clock,
      // started at its first failure with a short deadlineAt. Model 1 closes its
      // own window; under the old semantics (dispatchClosed true for every
      // private-clock deadline) the rotation rethrew it and model 2 was never
      // tried. With shared being a property of the error, model 1's deadline
      // error is an ordinary failure: the rotation records m1 unavailable and
      // tries m2, which answers.
      const t0 = Date.now();
      const result = await callWithFreeRotation(
        { id: "m1:free", maxOutput: 100 },
        [{ id: "m2:free", maxOutput: 100 }],
        (model) =>
          chatCompletionWithRetry(MESSAGES, { model, deadlineAt: t0 + 2500 }, depsFor(url)),
        { now: () => 0, store },
      );
      expect(result.content).toBe("from m2");
      expect(seen[0]).toBe("m1:free");
      expect(seen).toContain("m2:free");
      expect(Object.keys(store.get(0).models)).toEqual(["m1:free"]);
    }, 30_000);

    it("B3: a first sequence that fails with a 503 and a second that succeeds leave clock.lastError undefined", async () => {
      let n = 0;
      server = createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        req.resume();
        req.on("end", () => {
          n++;
          if (n === 1) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(ENVELOPE(503));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const addr = server!.address();
      if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${addr.port}`;
      // SEQUENCE 1 only: the FIRST getSoftTimeoutMs read (resolveConnection of
      // the first chatCompletionSimple) returns 500ms — shorter than the 1s
      // backoff, so fetchWithRetry429 breaks ("backoff > waitRemaining") and
      // chatCompletionSimple throws "API error 503" with the clock still open.
      // Every later read returns 30s, so sequence 2 completes and the call
      // SUCCEEDS — the 503 was a recovered failure, never the call final error.
      const deps = depsFor(url);
      let timeout = 500;
      deps.getSoftTimeoutMs = () => {
        const v = timeout;
        timeout = 30_000;
        return v;
      };
      const clock: RetryClock = {};
      const result = await chatCompletionWithRetry(MESSAGES, { model: "m", retryClock: clock }, deps);
      expect(result.content).toBe("recovered");
      // The recovered 503 must NOT be recorded on the clock (round C0a item 3):
      // a recovered sequence is not the call final error, so a later call under
      // a closed window must never see it as its cause.
      expect(clock.lastError).toBeUndefined();
    }, 30_000);

  });

  });

});

// ── Round C items 1-2 (TRDD-YG72CYY7) ────────────────────────────────
describe("round C item 2 (N4): timer overshoot keeps the labelled reply", () => {
  it("an empty reply at the window edge RETURNS the labelled reply, never a RetryDeadlineError (invariant pin: init-refusal AND post-sleep paths both land in the labelled reply; the exact straddle race is unconstructible with real timers — see report)", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "x", model: "m", created: 0, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    server.unref();
    try {
      // Remote backend (isLocal false) + empty content → useEmptyBudget true,
      // so the 2s EMPTY_RESPONSE_RETRY_DELAY_MS wait runs.
      const backend: BackendConfig = { type: "local", billable: false, isLocal: false, baseUrl: url, apiKey: "k", model: "m", __version: 1 };
      const deps = { ...depsFor(url), getBackend: () => backend };
      const deadline = Date.now() + 1000; // init-refusal shape: waitFitsClock(2s) refuses immediately, closedByWindow true — the reply must come back labelled
      const result = await chatCompletionWithRetry(
        MESSAGES,
        { model: "m", retryClock: { deadlineAt: deadline } },
        deps,
      );
      expect(result.finishReason).not.toBe("error");
      expect(String(result.content)).toContain("**EMPTY RESPONSE**");
      expect(result.truncated).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);
});



// Review M1: a sleeper reset-under but whose service then healed must proceed (null), not report a false outage.
describe("round C review M1: a healed service is not reported as an outage", () => {
  it("a stale sleeper gets null when a success was recorded after the concurrent reset", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      resetServiceHealthForTests();
      tripServiceHealthForTests();
      const a = checkServiceHealthForTests(); // claims rung 1 (60 s)
      const b = checkServiceHealthForTests(); // claims rung 2 (120 s)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await checkServiceHealthForTests()).toMatch(/^SERVER ISSUE DETECTED:/); // C: resets the ladder
      recordServiceSuccessForTests(); // the service healed after the reset
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await a).toBeNull();
      expect(await b).toBeNull();
      expect(serviceHealthSleepersForTests()).toBe(0);
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});
// Round C item 1 (TRDD-YG72CYY7): the real checkServiceHealthOrWait under fake timers, no HTTP.
// At commit 7d1d28b a stale sleeper resolved to null (a fresh attempt on a just-reset breaker).
describe("round C item 1 (N2): the breaker reset under sleeping callers", () => {
  it("a stale sleeper aborts after a concurrent reset, and a fresh caller then gets one real attempt", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true); // silence the breaker's progress line only
    try {
      resetServiceHealthForTests();
      tripServiceHealthForTests();
      const settled: Record<string, string | null | undefined> = {};
      const run = (name: string) =>
        checkServiceHealthForTests().then((v) => {
          settled[name] = v;
          return v;
        });

      // A claims rung 1 (60 s), B claims rung 2 (120 s): both sleep.
      const a = run("A");
      const b = run("B");
      expect(serviceHealthSleepersForTests()).toBe(2);

      // Just before A wakes, C finds rung 3 (350 s) longer than the retry window:
      // it gets the abort verdict at once and resets the ladder (epoch bump).
      await vi.advanceTimersByTimeAsync(59_000);
      expect(settled.A).toBeUndefined();
      const c = await run("C");
      expect(c).toMatch(/^SERVER ISSUE DETECTED:/);
      expect(serviceHealthSleepersForTests()).toBe(2);

      // Past both wakes: A and B were reset under; they must abort, never get null.
      await vi.advanceTimersByTimeAsync(61_000);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra).toMatch(/^SERVER ISSUE DETECTED:/);
      expect(rb).toMatch(/^SERVER ISSUE DETECTED:/);
      expect(serviceHealthSleepersForTests()).toBe(0);

      // Livelock guarantee: after the reset a fresh caller gets one real attempt.
      expect(await checkServiceHealthForTests()).toBeNull();
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});


// Review M-B scenario: A and B sleep at epoch 0, C resets (epoch 1), a success heals epoch 1, then `failures` failures accumulate.
async function staleSleepersAfterHeal(failures: number): Promise<[string | null, string | null]> {
  vi.useFakeTimers();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    resetServiceHealthForTests();
    tripServiceHealthForTests();
    const a = checkServiceHealthForTests(); // claims rung 1 (60 s) at epoch 0
    const b = checkServiceHealthForTests(); // claims rung 2 (120 s) at epoch 0
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await checkServiceHealthForTests()).toMatch(/^SERVER ISSUE DETECTED:/); // C resets: epoch 1
    recordServiceSuccessForTests(); // healed: successEpoch = 1
    setServiceFailuresForTests(failures); // still epoch 1
    await vi.advanceTimersByTimeAsync(130_000);
    const result = await Promise.all([a, b]);
    expect(serviceHealthSleepersForTests()).toBe(0);
    return result;
  } finally {
    stderr.mockRestore();
    vi.useRealTimers();
  }
}
const RETRIP = (n: number) =>
  `SERVER ISSUE DETECTED: the service recovered while this call waited out its backoff rung but failed again (${n} consecutive failures); this call aborts instead of making a fresh attempt.`;


// Review M-B: successEpoch is a high-water mark; a breaker that re-tripped in the healed epoch must still stop a stale sleeper.
describe("round C1 review M-B: a stale sleeper does not proceed into a re-tripped breaker", () => {
  it("exactly failureThreshold failures after the heal: both stale sleepers abort with the re-trip sentence", async () => {
    expect(await staleSleepersAfterHeal(5)).toEqual([RETRIP(5), RETRIP(5)]);
  });


  it("failureThreshold - 1 failures after the heal: both stale sleepers proceed", async () => {
    expect(await staleSleepersAfterHeal(4)).toEqual([null, null]);
  });

});
