/**
 * provider/connection.test.ts — the per-call deadline override.
 *
 * `resolveConnection` is the SINGLE point every request's (url, model, timeout)
 * tuple flows through, so this is where a caller-supplied deadline either takes
 * effect or is silently dropped. A dropped override would be invisible: the run
 * would simply keep using the 300s global and nobody would see a wrong number,
 * only a slow run. Hence a behavioural assertion, not a code reading.
 */
import { describe, it, expect } from "vitest";
import { resolveConnection } from "./connection.js";
import type { ProviderDeps } from "./types.js";

const GLOBAL_SOFT_TIMEOUT = 300_000;

function deps(): ProviderDeps {
  return {
    getBackend: () => ({
      type: "openrouter" as const,
      baseUrl: "https://openrouter.ai/api",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    }),
    apiHeaders: () => ({ authorization: "Bearer test" }),
    getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
    isFreeOnly: () => false,
  } as unknown as ProviderDeps;
}

describe("resolveConnection — per-call deadline", () => {
  it("uses the global soft timeout when the caller supplies none", async () => {
    const conn = await resolveConnection({ model: "m:free" }, deps());
    expect(conn.timeout).toBe(GLOBAL_SOFT_TIMEOUT);
  });

  it("honors a caller-supplied timeoutMs, so session_summary's tighter per-chunk deadline reaches the wire", async () => {
    const conn = await resolveConnection({ model: "m:free", timeoutMs: 120_000 }, deps());
    expect(conn.timeout).toBe(120_000);
    expect(conn.timeout).toBeLessThan(GLOBAL_SOFT_TIMEOUT); // the whole point: TIGHTER than global
  });

  it("honors an override LARGER than the global too — it is a deadline, not a cap", async () => {
    // The owner's standing rule: an explicit value is honored verbatim; the
    // caller decides how long they are willing to wait.
    const conn = await resolveConnection({ model: "m:free", timeoutMs: 900_000 }, deps());
    expect(conn.timeout).toBe(900_000);
  });
});
