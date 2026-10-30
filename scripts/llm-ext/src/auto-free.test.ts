// Auto-free pure helpers (TRDD-542bdbef), plus the TRDD-N0S2UL0K describe at the
// end, which boots index.ts against real settings and fetches the live
// OpenRouter catalog. Importing ./index is safe — the entry-point guard
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

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./test-tmp-root.js";
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

// TRDD-N0S2UL0K: every `llm-ext models ...` tool reaches dispatchCallToolInner's
// MASS_SCOUT_TOOL_NAMES branch, which called activeFreePool() even when free mode
// was NOT active. A managed local profile (profile-type local, mode local,
// server: managed) is never in free mode and has no free pool, so that eager call
// threw "free mode is active but the active profile defines no free models" and
// every model tool failed. Real boot + dispatch against a real settings.yaml in a
// throwaway config dir, HOME and output dir; no mocks.
describe("model tools on a managed local profile (TRDD-N0S2UL0K)", () => {
  const FREE_MODE_ERROR = "free mode is active but the active profile defines no free models";
  /** The built-in managed local profiles (builtinLocalProfiles), allow_paid_models
   *  left at its fresh-install default (false). */
  const PROFILES = [
    { name: "local_llama", api: "llamacpp-local", url: "http://127.0.0.1:8181", model: "AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K" },
    { name: "locals-mlx", api: "locals-local", url: "http://127.0.0.1:9090", model: "LiquidAI/LFM3-1.7B-MLX-4bit" },
  ];
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  /** index.ts reads settings once at import: re-import it fresh per scenario
   *  (the dispatch-reload.test.ts recipe) against its own config dir + HOME. */
  async function bootOn(settingsYaml: string) {
    const root = mkdtempSync(join(tmpdir(), "llm-ext-n0s2-"));
    const dirs = { LLM_EXT_CONFIG_DIR: join(root, "cfg"), HOME: join(root, "home"), LLM_EXT_OUTPUT_DIR: join(root, "out") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    writeFileSync(join(dirs.LLM_EXT_CONFIG_DIR, "settings.yaml"), settingsYaml, "utf-8");
    const prev = { ...process.env };
    Object.assign(process.env, dirs, { LLM_EXT_INSTALL_RULE: "0" });
    cleanups.push(() => {
      for (const k of [...Object.keys(dirs), "LLM_EXT_INSTALL_RULE"]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      rmSync(root, { recursive: true, force: true });
    });
    vi.resetModules();
    const idx = await import("./index.js");
    await idx.boot();
    return idx;
  }
  const localYaml = (p: (typeof PROFILES)[number]): string =>
    [`active: ${p.name}`, "profiles:", `  ${p.name}:`, "    profile-type: local", "    mode: local", `    api: ${p.api}`, `    url: ${p.url}`, "    server: managed", `    model: ${p.model}`, ""].join("\n");
  const textOf = (r: { content: Array<{ text?: string }> }): string => r.content.map((c) => c.text ?? "").join("\n");

  for (const p of PROFILES) {
    it(`${p.name}: the free-model override never throws and never swaps the local model for a remote id`, async () => {
      const idx = await bootOn(localYaml(p));
      await expect(idx.resolveMassScoutFreeModelOverride(p.model)).resolves.toBeUndefined();
      await expect(idx.resolveMassScoutFreeModelOverride("")).resolves.toBeUndefined();
    });

    // LIVE: check_model_health, discover_new_models and assess_model fetch the public OpenRouter catalog.
    it(`${p.name}: models health, discover, assess and replacements run (live catalog fetch)`, async () => {
      const idx = await bootOn(localYaml(p));
      // Each tool's own success line, so a failure for any other reason is not mistaken for a pass.
      // check_model_health flags the local id as missing from the OpenRouter catalog (isError), and assess_model
      // reports it not found: both are their real output for a local id, after the dispatch got through.
      for (const [tool, args, marker] of [
        ["check_model_health", {}, `Model health — profile '${p.name}'`],
        ["discover_new_models", {}, "New model arrivals"],
        // The model it was given, not a free-pool substitute.
        ["assess_model", { model: p.model }, `Model '${p.model}'`],
        ["check_tool_replacements", {}, "tool(s) checked"],
      ] as const) {
        const text = textOf(await idx.dispatchCallTool(tool, { ...args }));
        expect(text, tool).not.toContain(FREE_MODE_ERROR);
        expect(text, tool).toContain(marker);
      }
    }, 120_000);
  }

  // Controls: remote profiles keep their behaviour. In free mode with no pool the refusal still fires (Rule 5).
  const REMOTE = (allowPaid: boolean): string =>
    [`active: bare`, `allow_paid_models: ${allowPaid}`, "profiles:", "  bare:", "    mode: remote", "    api: openrouter-remote", "    model: vendor/whatever", '    api_key: "sk-test-fake-openrouter-key"', ""].join("\n");
  it("a remote profile forced free with no pool still refuses", async () => {
    const idx = await bootOn(REMOTE(false));
    await expect(idx.resolveMassScoutFreeModelOverride("")).rejects.toThrow(FREE_MODE_ERROR);
  });
  it("a funded remote profile (allow_paid_models: true, not free mode) keeps the caller's model", async () => {
    const idx = await bootOn(REMOTE(true));
    await expect(idx.resolveMassScoutFreeModelOverride("vendor/whatever")).resolves.toBeUndefined();
  });
});
