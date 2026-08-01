// The HARD SPEND CAP (P4).
//
// Nothing here is mocked that is under test: the SpendLedger and both budgeted-fetch
// wrappers are the REAL ones. The only stub is the network itself (the injectable HTTP
// seam every benchmark already takes) — which is the boundary, not the subject.
//
// These tests exist because the thing they guard has already gone wrong once for real:
// commit 31ce212 fixed a cost-safety defect that drained $17.67 of a live OpenRouter
// balance in an hour. Every assertion below is a sentence from that post-mortem.

import { describe, it, expect } from "vitest";

import {
  SpendLedger,
  BudgetExceededError,
  makeBudgetedFetch,
  makeBudgetedGlobalFetch,
  estimateCostUsd,
  isZeroPriced,
  DEFAULT_BUDGET_USD,
  ASSUMED_MAX_OUTPUT_TOKENS,
  CONSERVATIVE_CHARS_PER_TOKEN,
  type ModelPrice,
  type PriceLookup,
} from "./budget.js";
import type { FetchImpl } from "../security_scan/judge.js";

const PAID: ModelPrice = { inputDollarsPerMillion: 1, outputDollarsPerMillion: 1 };
const FREE: ModelPrice = { inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 };

const priceOf: PriceLookup = (id) =>
  id === "v/paid" ? PAID : id === "v/free" ? FREE : undefined;

/** A chat request body of the shape every benchmark actually sends. */
function body(model: string, promptChars: number, maxTokens?: number): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "x".repeat(promptChars) }],
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  });
}

/** An OpenRouter-shaped success response carrying a real usage block. */
function reply(promptTokens: number, completionTokens: number): string {
  return JSON.stringify({
    choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

describe("SpendLedger — the running account", () => {
  it("admits a call that fits, and books its actual cost", () => {
    const l = new SpendLedger(1.0);
    l.reserve("v/paid", 0.4);
    l.record("v/paid", 0.25);
    expect(l.spentUsd).toBeCloseTo(0.25, 10);
    expect(l.remainingUsd).toBeCloseTo(0.75, 10);
    expect(l.tripped).toBeNull();
  });

  it("REFUSES a call whose worst case would cross the cap — before the money moves", () => {
    const l = new SpendLedger(1.0);
    l.record("v/paid", 0.8);
    expect(() => l.reserve("v/paid", 0.3)).toThrow(BudgetExceededError);
    // The refusal did NOT spend anything: the cap held.
    expect(l.spentUsd).toBeCloseTo(0.8, 10);
  });

  it("the refusal carries the numbers a caller needs to act (cap / spent / would-spend)", () => {
    const l = new SpendLedger(2.0);
    l.record("v/paid", 1.9);
    try {
      l.reserve("v/paid", 0.5);
      expect.unreachable("reserve must throw");
    } catch (err) {
      const e = err as BudgetExceededError;
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect(e.capUsd).toBe(2.0);
      expect(e.spentUsd).toBeCloseTo(1.9, 10);
      expect(e.wouldSpendUsd).toBeCloseTo(0.5, 10);
      expect(e.message).toContain("--budget-usd");
    }
  });

  it("TRIPS once tripped — every later reserve is refused instantly (no silent continue)", () => {
    const l = new SpendLedger(1.0);
    expect(() => l.reserve("v/paid", 5)).toThrow(BudgetExceededError);
    expect(l.tripped).not.toBeNull();
    // Even a call that WOULD have fit is now refused: the run is over.
    expect(() => l.reserve("v/paid", 0.000001)).toThrow(BudgetExceededError);
  });

  it("trips (but does not throw) when ACTUAL spend overruns the cap — you cannot un-spend", () => {
    const l = new SpendLedger(1.0);
    l.reserve("v/paid", 0.9);
    // The provider billed more than the bound we asked for.
    expect(() => l.record("v/paid", 1.5)).not.toThrow();
    expect(l.spentUsd).toBeCloseTo(1.5, 10);
    expect(l.tripped).toContain("exceeded");
    // …and the latch stops the NEXT call, which is what actually ends the bleeding.
    expect(() => l.reserve("v/paid", 0.01)).toThrow(BudgetExceededError);
  });

  it("refuses a nonsensical cap rather than pretending to protect", () => {
    expect(() => new SpendLedger(-1)).toThrow(/non-negative/);
    expect(() => new SpendLedger(NaN)).toThrow(/finite/);
  });

  it("ships a conservative default cap", () => {
    expect(DEFAULT_BUDGET_USD).toBe(2.0);
    expect(DEFAULT_BUDGET_USD).toBeLessThan(17.67); // the 31ce212 incident's burn
  });
});

describe("estimate math — errs HIGH, always", () => {
  it("prices a call from tokens × catalog price", () => {
    expect(estimateCostUsd(1_000_000, 0, PAID)).toBeCloseTo(1.0, 10);
    expect(estimateCostUsd(0, 1_000_000, PAID)).toBeCloseTo(1.0, 10);
  });

  it("uses a chars-per-token divisor that OVER-counts source code", () => {
    // 3, not 4: under-counting tokens would let through a call the cap should refuse.
    expect(CONSERVATIVE_CHARS_PER_TOKEN).toBe(3);
  });

  it("a zero-priced model is free at any volume", () => {
    expect(isZeroPriced(FREE)).toBe(true);
    expect(estimateCostUsd(10_000_000, 10_000_000, FREE)).toBe(0);
  });
});

describe("makeBudgetedFetch — the per-call chokepoint (FetchImpl seam)", () => {
  it("does NOT send a call that would cross the cap — the network is never touched", async () => {
    let sent = 0;
    const inner: FetchImpl = async () => {
      sent++;
      return { ok: true, status: 200, json: async () => ({}), text: async () => reply(1, 1) };
    };
    // Cap $0.01. One call at 1M output tokens ($1) cannot possibly fit.
    const l = new SpendLedger(0.01);
    const f = makeBudgetedFetch(inner, l, priceOf);

    await expect(f("u", { method: "POST", headers: {}, body: body("v/paid", 100, 1_000_000) })).rejects.toThrow(
      BudgetExceededError,
    );
    expect(sent).toBe(0); // ← the whole point: $0 spent, because nothing was sent
    expect(l.spentUsd).toBe(0);
  });

  it("books the ACTUAL cost from the provider's own usage block", async () => {
    const inner: FetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => reply(500_000, 250_000), // 0.5 + 0.25 = $0.75 at $1/M
    });
    const l = new SpendLedger(5.0);
    const f = makeBudgetedFetch(inner, l, priceOf);
    await f("u", { method: "POST", headers: {}, body: body("v/paid", 300, 1000) });
    expect(l.spentUsd).toBeCloseTo(0.75, 6);
  });

  it("re-serves the response body intact — the guard is transparent, never lossy", async () => {
    const raw = reply(10, 20);
    const inner: FetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(raw),
      text: async () => raw,
    });
    const f = makeBudgetedFetch(inner, new SpendLedger(5.0), priceOf);
    const resp = await f("u", { method: "POST", headers: {}, body: body("v/paid", 10, 100) });
    // Both accessors work, and both see byte-identical data to an unwrapped fetch.
    expect(await resp.text()).toBe(raw);
    expect((await resp.json()) as unknown).toEqual(JSON.parse(raw));
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
  });

  it("stops the sweep dead once tripped — later calls never reach the network", async () => {
    let sent = 0;
    const inner: FetchImpl = async () => {
      sent++;
      // Bill wildly more than the reservation, to trip the ledger on ACTUAL spend.
      return { ok: true, status: 200, json: async () => ({}), text: async () => reply(2_000_000, 0) };
    };
    const l = new SpendLedger(1.0);
    const f = makeBudgetedFetch(inner, l, priceOf);

    await f("u", { method: "POST", headers: {}, body: body("v/paid", 10, 100) }); // $2 actual
    expect(l.tripped).not.toBeNull();
    expect(sent).toBe(1);

    // A benchmark runner CATCHES fetch errors, so it would happily keep going. The
    // latch is what makes "keep going" cost nothing.
    await expect(f("u", { method: "POST", headers: {}, body: body("v/paid", 10, 100) })).rejects.toThrow(
      BudgetExceededError,
    );
    await expect(f("u", { method: "POST", headers: {}, body: body("v/paid", 10, 100) })).rejects.toThrow(
      BudgetExceededError,
    );
    expect(sent).toBe(1); // ← not one further cent left the account
  });

  it("FREE MODE IS $0: a zero-priced model passes even under a $0 cap", async () => {
    let sent = 0;
    const inner: FetchImpl = async () => {
      sent++;
      return { ok: true, status: 200, json: async () => ({}), text: async () => reply(900_000, 900_000) };
    };
    const l = new SpendLedger(0); // ← zero budget
    const f = makeBudgetedFetch(inner, l, priceOf);

    await f("u", { method: "POST", headers: {}, body: body("v/free", 5000) });
    await f("u", { method: "POST", headers: {}, body: body("v/free", 5000) });

    expect(sent).toBe(2); // free calls are allowed…
    expect(l.spentUsd).toBe(0); // …and cost nothing, so the cap is never approached
    expect(l.tripped).toBeNull();
  });

  it("and a PAID model under a $0 cap is refused outright", async () => {
    let sent = 0;
    const inner: FetchImpl = async () => {
      sent++;
      return { ok: true, status: 200, json: async () => ({}), text: async () => reply(1, 1) };
    };
    const f = makeBudgetedFetch(inner, new SpendLedger(0), priceOf);
    await expect(f("u", { method: "POST", headers: {}, body: body("v/paid", 10, 10) })).rejects.toThrow(
      BudgetExceededError,
    );
    expect(sent).toBe(0);
  });

  it("REFUSES an unpriced model — a bill we cannot predict is one we do not incur", async () => {
    let sent = 0;
    const inner: FetchImpl = async () => {
      sent++;
      return { ok: true, status: 200, json: async () => ({}), text: async () => reply(1, 1) };
    };
    const f = makeBudgetedFetch(inner, new SpendLedger(100), priceOf);
    await expect(f("u", { method: "POST", headers: {}, body: body("v/unknown", 10, 10) })).rejects.toThrow(
      /not in the OpenRouter catalog/,
    );
    expect(sent).toBe(0);
  });

  it("refuses a body it cannot parse or that names no model (cost cannot be bounded)", async () => {
    const inner: FetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => reply(1, 1),
    });
    const f = makeBudgetedFetch(inner, new SpendLedger(100), priceOf);
    await expect(f("u", { method: "POST", headers: {}, body: "not json" })).rejects.toThrow(/could not be parsed/);
    await expect(f("u", { method: "POST", headers: {}, body: "{}" })).rejects.toThrow(/no `model` field/);
  });

  it("assumes a bounded output when the request declares no max_tokens", async () => {
    // The keyword sweep is the one such request. Reserve = 1 × ASSUMED_MAX_OUTPUT_TOKENS
    // of output at $1/M = $0.016 — so a cap just under that must refuse it, and a cap
    // just over it must admit it. That pins the assumption to a real, checkable number.
    const inner: FetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => reply(0, 0),
    });
    const outCost = estimateCostUsd(0, ASSUMED_MAX_OUTPUT_TOKENS, PAID);

    const tight = new SpendLedger(outCost * 0.5);
    await expect(
      makeBudgetedFetch(inner, tight, priceOf)("u", { method: "POST", headers: {}, body: body("v/paid", 3) }),
    ).rejects.toThrow(BudgetExceededError);

    const roomy = new SpendLedger(outCost * 2);
    await expect(
      makeBudgetedFetch(inner, roomy, priceOf)("u", { method: "POST", headers: {}, body: body("v/paid", 3) }),
    ).resolves.toBeDefined();
  });
});

describe("makeBudgetedGlobalFetch — the same guard, for the keyword/ensemble runner", () => {
  it("refuses before sending, and preserves status + headers on the way back", async () => {
    let sent = 0;
    const inner = async (): Promise<Response> => {
      sent++;
      return new Response(reply(1000, 2000), {
        status: 429,
        headers: { "retry-after": "42" },
      });
    };

    // Refusal path: nothing sent.
    const tight = makeBudgetedGlobalFetch(new SpendLedger(0.0001), priceOf, inner);
    await expect(
      tight("u", { method: "POST", body: body("v/paid", 100, 1_000_000) }),
    ).rejects.toThrow(BudgetExceededError);
    expect(sent).toBe(0);

    // Success path: the runner still sees the real status and the retry-after header it
    // needs for its 429 backoff. A lossy stand-in would silently break free-tier retries.
    const l = new SpendLedger(5);
    const resp = await makeBudgetedGlobalFetch(l, priceOf, inner)("u", {
      method: "POST",
      body: body("v/paid", 100, 100),
    });
    expect(sent).toBe(1);
    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBe("42");
    expect(await resp.text()).toBe(reply(1000, 2000));
    expect(l.spentUsd).toBeCloseTo(estimateCostUsd(1000, 2000, PAID), 10);
  });

  it("survives a null-body status instead of crashing inside the guard", async () => {
    // The Response constructor THROWS if a body is passed with a 204. The guard must
    // never be the thing that breaks a run it was added to protect.
    const inner = async (): Promise<Response> => new Response(null, { status: 204 });
    const f = makeBudgetedGlobalFetch(new SpendLedger(5), priceOf, inner);
    const resp = await f("u", { method: "POST", body: body("v/paid", 10, 10) });
    expect(resp.status).toBe(204);
  });
});
