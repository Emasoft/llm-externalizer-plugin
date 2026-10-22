// Auto-free pure helpers (TRDD-542bdbef).
// Pure, offline, free. Importing ./index is safe — the entry-point guard
// (TRDD-e82f2c49) stops it booting the server during tests.
//
// parseFreeBelowUsd / resolveFreeModelId (env-override + cost-safety check)
// were DELETED outright (TRDD-OE27RD7I addendum 4, 14.1-C2c-ENV): the
// low-balance auto-free threshold and its two env-var overrides (the
// dollar-threshold one and the single-free-model-id one) no longer exist —
// no cross-profile switch, no env opt-out. FREE_MODEL_ID itself is ALSO
// gone now (fix-queue 98(2)): its last consumer resolves to the selected
// profile's own chain instead of a hard-coded id outside the profile. Their
// describe blocks are removed rather than inverted: there is nothing left
// to call.

import { describe, it, expect } from "vitest";
import {
  resolveAutoFreePool,
  resolveSubsystemFreeModel,
  FREE_FLOOR_MIN_CONTEXT_TOKENS,
  selectFreeEnsembleModels,
} from "./index";
import { FREE_POOL_SEED } from "./config";

describe("resolveAutoFreePool — the profile's own free_models, copied (Rule 5 TRDD-90DM5YHO)", () => {
  it("an empty profile pool resolves to [] and never falls back to FREE_POOL_SEED (Rule 5, never dark)", () => {
    const result = resolveAutoFreePool([]);
    expect(result).toEqual([]);
    expect(result.some((id) => (FREE_POOL_SEED as readonly string[]).includes(id))).toBe(false);
  });
  it("prefers the profile's pinned free_models when present", () => {
    const pinned = ["z-ai/glm-4.5-air:free", "poolside/laguna-m.1:free"];
    expect(resolveAutoFreePool(pinned)).toEqual(pinned);
  });

  it("returns a fresh mutable copy (no aliasing of the input array)", () => {
    const pinned = ["z-ai/glm-4.5-air:free"];
    const a = resolveAutoFreePool(pinned);
    a.push("x");
    const b = resolveAutoFreePool(pinned);
    expect(b).toEqual(pinned); // unaffected by mutating a
    expect(Object.isFrozen(a)).toBe(false);
  });

  it("a non-empty pinned pool is returned unmodified, entirely ':free' (cost-safety)", () => {
    const pinned = ["z-ai/glm-4.5-air:free", "poolside/laguna-m.1:free"];
    const pool = resolveAutoFreePool(pinned);
    expect(pool.every((id) => id.endsWith(":free"))).toBe(true);
    expect(pool.length).toBeGreaterThan(0);
  });
});

describe("resolveSubsystemFreeModel — security_scan / mass_scout free routing (Phase 2)", () => {
  const POOL = ["poolside/laguna-m.1:free", "z-ai/glm-4.5-air:free"];

  it("leaves the caller's model untouched when free mode is OFF", () => {
    expect(
      resolveSubsystemFreeModel(false, POOL, "qwen/qwen-2.5-7b-instruct"),
    ).toBeUndefined();
    expect(resolveSubsystemFreeModel(false, POOL, "")).toBeUndefined();
  });

  it("substitutes the pool's first model when free + caller's model is unset", () => {
    expect(resolveSubsystemFreeModel(true, POOL, "")).toBe(
      "poolside/laguna-m.1:free",
    );
  });

  it("substitutes when free + caller passed a PAID model (cost-safety)", () => {
    // The latent bug: security_scan defaults to qwen/qwen-2.5-7b-instruct (paid)
    // and would throw under free mode. Now it's replaced with a ':free' model.
    expect(
      resolveSubsystemFreeModel(true, POOL, "qwen/qwen-2.5-7b-instruct"),
    ).toBe("poolside/laguna-m.1:free");
    expect(resolveSubsystemFreeModel(true, POOL, "deepseek/deepseek-v4-pro")).toBe(
      "poolside/laguna-m.1:free",
    );
  });

  it("keeps the caller's model when it is already ':free'", () => {
    expect(
      resolveSubsystemFreeModel(true, POOL, "z-ai/glm-4.5-air:free"),
    ).toBeUndefined();
    expect(
      resolveSubsystemFreeModel(true, POOL, "  qwen/qwen3-coder:free  "),
    ).toBeUndefined();
  });

  // fix-queue 98(2): FREE_MODEL_ID (the hard-coded "poolside/laguna-m.1:free"
  // fallback this test used to pin) is DELETED -- an empty in-profile pool
  // is never patched with a model outside the profile (Rule 5, USER
  // addendum 4 "no exceptions"). undefined here leaves the caller's
  // (unset/paid) model untouched, which the mass-scout/security-scan
  // dispatch path already fails loudly on via its own getActiveFreeOnly
  // assertion downstream -- this test used to assert the borrow; it now
  // asserts the refusal half.
  it("refuses (undefined) rather than borrowing a hard-coded id when the pool is empty", () => {
    expect(resolveSubsystemFreeModel(true, [], "")).toBeUndefined();
    expect(
      resolveSubsystemFreeModel(true, [], "deepseek/deepseek-v4-pro"),
    ).toBeUndefined();
  });

  it("never returns a non-':free' model under free mode", () => {
    for (const req of ["", "paid/model", "x/y:free", "qwen/qwen-2.5-7b-instruct"]) {
      const out = resolveSubsystemFreeModel(true, POOL, req);
      if (out !== undefined) expect(out.endsWith(":free")).toBe(true);
    }
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
