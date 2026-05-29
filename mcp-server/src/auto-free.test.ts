// Auto-free-on-low-balance pure helpers (TRDD-542bdbef).
// Pure, offline, free. Importing ./index is safe — the entry-point guard
// (TRDD-e82f2c49) stops it booting the server during tests.

import { describe, it, expect } from "vitest";
import {
  parseFreeBelowUsd,
  resolveFreeModelId,
  resolveAutoFreePool,
  FREE_FLOOR_MIN_CONTEXT_TOKENS,
  selectFreeEnsembleModels,
} from "./index";
import { FREE_POOL_SEED } from "./config";

describe("parseFreeBelowUsd — low-balance threshold (TRDD-542bdbef)", () => {
  it("defaults to $1.00 when the env var is unset", () => {
    expect(parseFreeBelowUsd(undefined)).toBe(1.0);
  });

  it("honours a valid positive override", () => {
    expect(parseFreeBelowUsd("2")).toBe(2);
    expect(parseFreeBelowUsd("0.5")).toBe(0.5);
    expect(parseFreeBelowUsd("10.25")).toBe(10.25);
  });

  it("rejects zero, negative, and non-numeric values → $1.00", () => {
    expect(parseFreeBelowUsd("0")).toBe(1.0);
    expect(parseFreeBelowUsd("-5")).toBe(1.0);
    expect(parseFreeBelowUsd("abc")).toBe(1.0);
    expect(parseFreeBelowUsd("")).toBe(1.0);
    expect(parseFreeBelowUsd("NaN")).toBe(1.0);
    expect(parseFreeBelowUsd("Infinity")).toBe(1.0);
  });

  it("the $0.10-balance / $1-threshold case engages (balance < threshold)", () => {
    // Regression guard for the live bug: balance $0.10 must be below the
    // default threshold so auto-free fires.
    expect(0.10214525300000332 < parseFreeBelowUsd(undefined)).toBe(true);
  });
});

describe("resolveFreeModelId — single working free model (TRDD-542bdbef)", () => {
  // Default is the most-available validated free model across 4 benchmark runs
  // (valid output 4/4 + top security-triage PASS 0.966).
  it("defaults to poolside/laguna-m.1:free (most available + best triage)", () => {
    expect(resolveFreeModelId(undefined)).toBe("poolside/laguna-m.1:free");
  });

  it("never returns the broken nvidia default the bug shipped", () => {
    expect(resolveFreeModelId(undefined)).not.toBe(
      "nvidia/nemotron-3-super-120b-a12b:free",
    );
  });

  it("honours a valid ':free' override (trimmed)", () => {
    expect(resolveFreeModelId("qwen/qwen3-coder:free")).toBe(
      "qwen/qwen3-coder:free",
    );
    expect(resolveFreeModelId("  z-ai/glm-4.5-air:free  ")).toBe(
      "z-ai/glm-4.5-air:free",
    );
  });

  it("rejects a non-':free' override (cost-safety) → default", () => {
    expect(resolveFreeModelId("deepseek/deepseek-v4-pro")).toBe(
      "poolside/laguna-m.1:free",
    );
    expect(resolveFreeModelId("openai/gpt-5.4-nano")).toBe(
      "poolside/laguna-m.1:free",
    );
    expect(resolveFreeModelId("")).toBe("poolside/laguna-m.1:free");
  });
});

describe("resolveAutoFreePool — engaged pool (TRDD-542bdbef)", () => {
  it("falls back to FREE_POOL_SEED when the profile pins no free_models", () => {
    expect(resolveAutoFreePool([])).toEqual([...FREE_POOL_SEED]);
  });

  it("prefers the profile's pinned free_models when present", () => {
    const pinned = ["z-ai/glm-4.5-air:free", "poolside/laguna-m.1:free"];
    expect(resolveAutoFreePool(pinned)).toEqual(pinned);
  });

  it("returns a fresh mutable copy (no aliasing of FREE_POOL_SEED)", () => {
    const a = resolveAutoFreePool([]);
    a.push("x");
    const b = resolveAutoFreePool([]);
    expect(b).toEqual([...FREE_POOL_SEED]); // unaffected by mutating a
    expect(Object.isFrozen(a)).toBe(false);
  });

  it("the fallback pool is entirely ':free' (cost-safety)", () => {
    const pool = resolveAutoFreePool([]);
    expect(pool.every((id) => id.endsWith(":free"))).toBe(true);
    expect(pool.length).toBeGreaterThan(0);
  });
});

describe("getEnsembleModels auto-free pool selection — selectFreeEnsembleModels over FREE_POOL_SEED", () => {
  // getEnsembleModels (internal) routes through selectFreeEnsembleModels(pool)
  // under auto-free. Exercise that selector the way the auto-free path does,
  // to confirm the result is non-empty and ':free'-only on a cold catalog.
  it("yields a non-empty ':free'-only top-3 from FREE_POOL_SEED with a cold catalog", () => {
    const cold = new Map();
    const models = selectFreeEnsembleModels([...FREE_POOL_SEED], cold);
    expect(models.length).toBe(3);
    expect(models.every((id) => id.endsWith(":free"))).toBe(true);
  });

  it("drops a benchmark-failed free model from the engaged pool", () => {
    const cold = new Map();
    const failed = new Set([FREE_POOL_SEED[0]]);
    const models = selectFreeEnsembleModels([...FREE_POOL_SEED], cold, failed);
    expect(models).not.toContain(FREE_POOL_SEED[0]);
    expect(models.every((id) => id.endsWith(":free"))).toBe(true);
  });

  it("FREE_FLOOR is the lenient context floor (sanity)", () => {
    expect(FREE_FLOOR_MIN_CONTEXT_TOKENS).toBe(32_000);
  });
});
