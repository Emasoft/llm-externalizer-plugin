/**
 * remote-fallback.test.ts — TRDD-WSPV40Y5 (increment 1d): the one decision of whether a remote failure lets a general command
 * finish on a ready local profile, and the fixed warning texts. The causes are REAL errors: the HTTP-status ones are the texts the
 * completion layer throws ("API error <status> ..."), the network ones are what a real fetch to a real closed port or a real
 * `.invalid` name throws, with the typed fields the HTTP layer attaches (fetchWithRetry429 against the same targets).
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { fallbackVerdict, fallbackWarning } from "./remote-fallback.js";
import { attachFailure, fetchWithRetry429 } from "./provider/http.js";

const ARMED = { outageConfirmed: false, networkArmed: true };
const UNARMED = { outageConfirmed: false, networkArmed: false };
const api = (status: number, text = "error") => new Error(`API error ${status} (openrouter): ${text}`);
const CERTAIN_402 = api(402, "Insufficient credits. Add more using https://openrouter.ai/settings/credits");

async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/** The error a real request to `url` throws, typed by the HTTP layer (attempt budget spent quickly by the ECONNREFUSED / DNS verdicts). */
async function realNetworkError(url: string): Promise<unknown> {
  return fetchWithRetry429(`${url}/v1/chat/completions`, { method: "POST", body: "{}" }, 10_000, Date.now(), { saw429: false }, { }).then(
    () => {
      throw new Error("expected a network failure");
    },
    (e: unknown) => e,
  );
}

describe("fallbackVerdict: which remote failures fall back", () => {
  it("a confirmed outage falls back (the existing verdict order: outage first)", () => {
    expect(fallbackVerdict([api(503), api(504)], "paid", { outageConfirmed: true, networkArmed: false })).toBe("outage");
  });

  it("no network path: a real closed port, window armed, falls back; unarmed it does not", async () => {
    const err = await realNetworkError(await closedPortUrl());
    expect(fallbackVerdict([err], "free", ARMED)).toBe("network");
    expect(fallbackVerdict([err], "free", UNARMED)).toBeUndefined();
  }, 30_000);

  it("no network path: a real unresolvable `.invalid` host (RFC 6761), window armed, falls back", async () => {
    const err = await realNetworkError("http://llm-ext-no-such-host.invalid");
    expect(fallbackVerdict([err], "paid", ARMED)).toBe("network");
  }, 30_000);

  it("a mixed list (one network failure, one 404 of a healthy service) does not fall back", async () => {
    const err = await realNetworkError(await closedPortUrl());
    expect(fallbackVerdict([err, api(404, "No endpoints found")], "paid", ARMED)).toBeUndefined();
  }, 30_000);

  it("a local timeout (ETIMEDOUT-LOCAL, a slow model) is not network isolation", () => {
    const e = new Error("timed out");
    attachFailure(e, { networkCode: "ETIMEDOUT-LOCAL" });
    expect(fallbackVerdict([e], "paid", ARMED)).toBeUndefined();
  });

  it("refused keys fall back on free and paid: 401, 403, and 401 mixed with a certain 402 (Q3 REVISED)", () => {
    expect(fallbackVerdict([api(401, "User not found")], "paid", UNARMED)).toBe("key");
    expect(fallbackVerdict([api(403, "Forbidden")], "free", UNARMED)).toBe("key");
    expect(fallbackVerdict([api(401), CERTAIN_402], "paid", UNARMED)).toBe("key");
  });

  it("paid credit at zero (EVERY cause a certain 402) falls back; on free a 402 stays in-profile (the update is the fix)", () => {
    expect(fallbackVerdict([CERTAIN_402, CERTAIN_402], "paid", UNARMED)).toBe("credit");
    expect(fallbackVerdict([CERTAIN_402], "free", UNARMED)).toBeUndefined();
    expect(fallbackVerdict([CERTAIN_402, api(429)], "paid", UNARMED)).toBeUndefined();
  });

  it("request-specific and dead-model failures never fall back: 400, 413, 404, 410, 429, 5xx without an outage, empty", () => {
    for (const s of [400, 413, 404, 410, 429, 500, 503]) expect(fallbackVerdict([api(s)], "paid", ARMED), `status ${s}`).toBeUndefined();
    expect(fallbackVerdict([], "paid", { outageConfirmed: true, networkArmed: true })).toBeUndefined();
  });
});

describe("fallbackWarning: the one line printed at the switch", () => {
  it("paid credit and refused key carry the fixed texts of the card, and every line names the target, its model and the remote profile", () => {
    const credit = fallbackWarning("credit", "paid", "local_llama", "org/m");
    expect(credit).toContain("credit exhausted on the paid profile: top up; answered locally");
    expect(fallbackWarning("key", "free", "local_llama", "org/m")).toContain("the API key was refused (401/403): fix it; answered locally");
    for (const t of ["outage", "network", "credit", "key"] as const) {
      const line = fallbackWarning(t, "paid", "locals-mlx", "org/m");
      expect(line).toMatch(/^\[llm-externalizer\] .*profile 'locals-mlx' \(model org\/m\) instead of 'paid'.*degraded\n$/);
    }
  });
});
