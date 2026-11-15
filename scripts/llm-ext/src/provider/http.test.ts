/**
 * provider/http.test.ts — the request-deadline contract (TRDD-0H5N1V9W).
 *
 * These are REGRESSION tests for a real shipped bug: `fetchWithTimeout` cleared
 * its abort timer the instant response HEADERS arrived, so the timeout bounded
 * time-to-first-byte only and the body read ran unbounded. A model that answered
 * headers promptly and then stalled hung the whole run forever.
 *
 * The seam is `globalThis.fetch` — the NETWORK boundary, not the unit under
 * test. The deadline logic itself is exercised for real, including real
 * ReadableStreams and real AbortSignal propagation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "./http.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/**
 * Build a Response whose body emits `head`, then STALLS until the caller's
 * AbortSignal fires (or forever if it never does). This reproduces the exact
 * failure shape: headers land immediately, generation never finishes.
 */
function stallingResponse(signal: AbortSignal, head = "partial"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      // Never close. Only an abort ends this stream — which is precisely what
      // the fix must make happen.
      signal.addEventListener("abort", () => {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

describe("fetchWithTimeout — the deadline must cover the BODY, not just the headers", () => {
  it("aborts a response whose body stalls past the deadline instead of hanging forever", async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Resolve on HEADERS immediately, exactly like a real slow-generating model.
      return stallingResponse(init!.signal as AbortSignal);
    }) as unknown as typeof fetch;

    const res = await fetchWithTimeout("https://example.invalid/v1/chat", {}, 150);

    // The bug: this read never settled. The fix: it rejects at the deadline.
    await expect(res.text()).rejects.toThrow();
  });

  it("returns a response whose body completes within the deadline fully intact", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("hello body", {
        status: 201,
        statusText: "Created",
        headers: { "x-custom": "kept" },
      });
    }) as unknown as typeof fetch;

    const res = await fetchWithTimeout("https://example.invalid/v1/chat", {}, 5_000);

    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("kept");
    expect(await res.text()).toBe("hello body");
  });

  it("disarms the deadline once the body settles, so a finished read is never killed afterwards", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("done quickly", { status: 200 });
    }) as unknown as typeof fetch;

    // A SHORT deadline, fully consumed well inside it.
    const res = await fetchWithTimeout("https://example.invalid/v1/chat", {}, 120);
    expect(await res.text()).toBe("done quickly");

    // Wait past the original deadline. If the timer were still armed it would
    // fire here; the body is already consumed, so nothing may explode.
    await new Promise((r) => setTimeout(r, 250));
    expect(res.bodyUsed).toBe(true);
  });

  it("clears the deadline and rethrows when the request itself fails, leaking no timer", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      fetchWithTimeout("https://example.invalid/v1/chat", {}, 5_000),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("returns a bodyless response (204) unchanged rather than rebuilding it", async () => {
    // Load-bearing: the Response constructor REJECTS a body for 204, so the
    // rebuild path must not be taken here.
    globalThis.fetch = vi.fn(async () => {
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const res = await fetchWithTimeout("https://example.invalid/v1/models", {}, 5_000);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("propagates the abort to the underlying request, not merely to the caller's await", async () => {
    // Bounding the wait without aborting the socket would leak a connection per
    // stalled chunk — under concurrency 12 that is 12 leaked sockets.
    let observed: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      observed = init!.signal as AbortSignal;
      return stallingResponse(observed);
    }) as unknown as typeof fetch;

    const res = await fetchWithTimeout("https://example.invalid/v1/chat", {}, 150);
    await expect(res.text()).rejects.toThrow();

    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(true);
  });
});

describe("fetchWithTimeout — a caller-supplied signal cancels the request (issue 19 / TRDD-3SNQAGIC)", () => {
  it("an external abort ends a stalled body read AND clears the deadline timer at once", async () => {
    // A losing session-summary racer is cancelled by its winner. The 600 s deadline timer must not
    // outlive that cancellation: an armed timer is what kept the CLI process alive after the summary.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        return stallingResponse(init!.signal as AbortSignal);
      }) as unknown as typeof fetch;
      const external = new AbortController();

      const res = await fetchWithTimeout("https://example.invalid/v1/chat", { signal: external.signal }, 600_000);
      expect(vi.getTimerCount()).toBe(1); // the deadline is armed while the body is being read

      external.abort();
      await expect(res.text()).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0); // disarmed by the abort, not left to fire 600 s later
    } finally {
      vi.useRealTimers();
    }
  });

  it("a signal that is already aborted never starts a request and leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        init!.signal!.throwIfAborted();
        return new Response("never reached");
      }) as unknown as typeof fetch;
      const external = new AbortController();
      external.abort();

      await expect(
        fetchWithTimeout("https://example.invalid/v1/chat", { signal: external.signal }, 600_000),
      ).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
