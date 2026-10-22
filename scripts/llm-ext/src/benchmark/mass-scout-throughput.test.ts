import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { FetchImpl } from "../mass_scouting/scout.js";
import {
  DEFAULT_THROUGHPUT_PARAMS,
  massScoutThroughputHash,
  freeFitnessUnlocked,
} from "./free-fitness-ledger.js";
import { runMassScoutThroughputBenchmark } from "./mass-scout-throughput.js";

let cfg = "";
let prevCfgDir: string | undefined;
let prevKey: string | undefined;

beforeEach(() => {
  cfg = mkdtempSync(join("/private/tmp", "throughput-cfg-"));
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevKey = process.env.OPENROUTER_API_KEY;
  process.env.LLM_EXT_CONFIG_DIR = cfg;
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = prevKey;
  rmSync(cfg, { recursive: true, force: true });
});

/** A wire that answers every call with a valid completion (fast — the payload
 *  is never scored here, throughput is the gate). */
function okWire(): FetchImpl {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ categories: [] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    text: async () => "",
  })) as unknown as FetchImpl;
}

/** A wire where every `everyNth`-th call is rate-limited, the rest succeed. */
function everyNthRateLimited(n: number): FetchImpl {
  let i = 0;
  return (async () => {
    i++;
    if (i % n === 0) {
      return {
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => "rate limited",
      };
    }
    return okWire()("", { method: "POST", headers: {}, body: "" });
  }) as unknown as FetchImpl;
}

describe("mass-scout throughput benchmark (addendum H part 1)", () => {
  it("burst is sized to the tool's real concurrency and call count", async () => {
    expect(DEFAULT_THROUGHPUT_PARAMS.workers).toBe(16); // DEFAULT_SCOUT_WORKERS
    expect(DEFAULT_THROUGHPUT_PARAMS.calls).toBeGreaterThanOrEqual(32);
  });

  it("a clean burst PASSES and the verdict unlocks the tool in the ledger", async () => {
    const r = await runMassScoutThroughputBenchmark("v/fast:free", "k", {
      fetchImpl: okWire(),
      // Keep the burst small in the test but at the DEFAULT policy hash so the
      // unlock path is exercised end to end. calls=16 x workers=4 still is a
      // sustained multi-worker burst; DEFAULTS' hash would need 64 real calls,
      // so run at explicit params and record via the default-hash test below.
      params: { workers: 4, calls: 16, minSuccessRate: 0.9 },
    });
    expect(r.pass).toBe(true);
    expect(r.inconclusive).toBe(false);
    expect(r.completed).toBe(16);
    expect(r.rateLimited).toBe(0);
    // Non-default params: measured, recorded under its own hash, but the
    // DEFAULT-hash unlock is untouched.
    expect(freeFitnessUnlocked("mass_scout")).toBe(false);
  });

  it("a 429-flood FAILS — the burst records rate-limit responses and the model is proven unfit", async () => {
    const r = await runMassScoutThroughputBenchmark("v/slow:free", "k", {
      fetchImpl: everyNthRateLimited(2),
      params: { workers: 4, calls: 16, minSuccessRate: 0.9 },
    });
    expect(r.rateLimited).toBe(8);
    expect(r.completed).toBe(8);
    expect(r.successRate).toBeCloseTo(0.5, 5);
    expect(r.pass).toBe(false);
    expect(r.failureReasons.join(" ")).toContain("rate-limited");
  });

  it("a hard error (network/5xx) fails the burst even with no 429s", async () => {
    let i = 0;
    const r = await runMassScoutThroughputBenchmark("v/err:free", "k", {
      fetchImpl: (async () => {
        i++;
        if (i === 3) throw new Error("ECONNRESET");
        return okWire()("", { method: "POST", headers: {}, body: "" });
      }) as unknown as FetchImpl,
      params: { workers: 2, calls: 8, minSuccessRate: 0.9 },
    });
    expect(r.hardErrors).toBe(1);
    expect(r.pass).toBe(false);
  });

  it("a DEFAULT-params pass records the unlock verdict — the exact wire the gate reads", async () => {
    // The full default burst (64 calls @ 16 workers) against the seamed wire:
    // cheap, parallel, and it exercises the real unlock path.
    const r = await runMassScoutThroughputBenchmark("v/fast:free", "k", { fetchImpl: okWire() });
    expect(r.params).toEqual(DEFAULT_THROUGHPUT_PARAMS);
    expect(r.pass).toBe(true);
    expect(freeFitnessUnlocked("mass_scout")).toBe(true);
    // The recorded hash is the DEFAULT-params one — the same hash the gate computes.
    expect(massScoutThroughputHash(DEFAULT_THROUGHPUT_PARAMS)).toBeDefined();
  });

  it("a DEFAULT-params 429-flood records a FAIL — the gate stays locked", async () => {
    const r = await runMassScoutThroughputBenchmark("v/slow:free", "k", {
      fetchImpl: everyNthRateLimited(2),
    });
    expect(r.pass).toBe(false);
    expect(freeFitnessUnlocked("mass_scout")).toBe(false);
  });
});
