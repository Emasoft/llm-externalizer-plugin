// Unit tests for the per-tool model map (TRDD-f45eeaa0) added to config.ts:
// resolveModelForTool's resolution order, resolveProfile's toolModels
// population (defensive copy + back-compat default), and validateProfile's
// tool_models validation (known-tool keys + non-empty model-id values,
// treated as untrusted YAML). Pure — no network, no filesystem.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveModelForTool,
  resolveProfile,
  validateProfile,
  resolveHighQualityModel,
  HIGH_QUALITY_MODEL_DEFAULTS,
  buildHighQualityProvider,
  highQualityScanRefusal,
  shouldForceFreeMode,
  loadSettings,
  getSettingsPath,
  setAllowPaidModels,
  getAllowPaidModels,
  type Profile,
  type ResolvedProfile,
} from "./config.js";
import { registeredTools } from "./model-qualification/registry.js";

function mkResolved(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: "test",
    mode: "remote",
    protocol: "openrouter_api",
    url: "https://openrouter.ai/api",
    model: "profile/main-model",
    authToken: "tok",
    secondModel: "",
    thirdModel: "",
    freeOnly: false,
    freeModels: [],
    toolModels: {},
    timeout: 600,
    contextWindow: 0,
    appName: "",
    httpReferer: "",
    highQualityModel: HIGH_QUALITY_MODEL_DEFAULTS,
    ...overrides,
  };
}

describe("resolveModelForTool (per-tool model resolution, TRDD-f45eeaa0)", () => {
  it("returns the per-tool override when set", () => {
    const r = mkResolved({
      toolModels: { security_scan: "qwen/qwen-2.5-7b-instruct" },
    });
    expect(resolveModelForTool(r, "security_scan", "default/model")).toBe(
      "qwen/qwen-2.5-7b-instruct",
    );
  });

  it("returns the caller fallback when no override is set", () => {
    const r = mkResolved();
    expect(resolveModelForTool(r, "security_scan", "default/model")).toBe(
      "default/model",
    );
  });

  it("returns the profile main model when no override and no fallback (back-compat)", () => {
    const r = mkResolved();
    expect(resolveModelForTool(r, "security_scan")).toBe("profile/main-model");
  });

  it("ignores an empty-string override and falls through to the fallback", () => {
    const r = mkResolved({ toolModels: { security_scan: "" } });
    expect(resolveModelForTool(r, "security_scan", "default/model")).toBe(
      "default/model",
    );
  });

  it("does not let one tool's override leak into another tool", () => {
    const r = mkResolved({ toolModels: { security_scan: "x/y" } });
    expect(resolveModelForTool(r, "code_task", "ct/default")).toBe("ct/default");
    expect(resolveModelForTool(r, "code_task")).toBe("profile/main-model");
  });
});

describe("resolveProfile populates toolModels", () => {
  it("copies tool_models into toolModels (defensive copy)", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "google/gemini-2.5-flash",
      api_key: "direct-key",
      tool_models: { security_scan: "qwen/qwen-2.5-7b-instruct" },
    };
    const r = resolveProfile("p", p);
    expect(r.toolModels).toEqual({
      security_scan: "qwen/qwen-2.5-7b-instruct",
    });
    // Mutating the resolved copy must not mutate the source profile.
    r.toolModels.security_scan = "mutated";
    expect(p.tool_models?.security_scan).toBe("qwen/qwen-2.5-7b-instruct");
  });

  it("defaults toolModels to {} when tool_models is absent (back-compat)", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "google/gemini-2.5-flash",
      api_key: "direct-key",
    };
    const r = resolveProfile("p", p);
    expect(r.toolModels).toEqual({});
  });

  it("coerces a null tool_models (blank YAML key) to {}", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "google/gemini-2.5-flash",
      api_key: "direct-key",
      tool_models: null as unknown as Record<string, string>,
    };
    expect(resolveProfile("p", p).toolModels).toEqual({});
  });

  it("coerces a non-map tool_models (stray scalar) to {} instead of mangling it", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "google/gemini-2.5-flash",
      api_key: "direct-key",
      tool_models: "oops" as unknown as Record<string, string>,
    };
    // Must NOT spread the string into {0:'o',1:'o',2:'p',3:'s'}.
    expect(resolveProfile("p", p).toolModels).toEqual({});
  });
});

describe("validateProfile tool_models validation", () => {
  const base: Profile = {
    mode: "remote",
    api: "openrouter-remote",
    model: "google/gemini-2.5-flash",
    api_key: "direct-key",
  };

  it("accepts a valid tool_models map of known tools", () => {
    const res = validateProfile("p", {
      ...base,
      tool_models: { security_scan: "qwen/qwen-2.5-7b-instruct" },
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("is valid (back-compat) when tool_models is absent", () => {
    expect(validateProfile("p", base).valid).toBe(true);
  });

  it("treats a null tool_models (blank YAML key) as no overrides (valid)", () => {
    const res = validateProfile("p", {
      ...base,
      tool_models: null as unknown as Record<string, string>,
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("every registered tool is an accepted key", () => {
    const map: Record<string, string> = {};
    for (const t of registeredTools()) map[t] = "some/model";
    const res = validateProfile("p", { ...base, tool_models: map });
    expect(res.valid).toBe(true);
  });

  it("rejects an unknown tool name (typo guard)", () => {
    const res = validateProfile("p", {
      ...base,
      tool_models: { securty_scan: "m" },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("unknown tool 'securty_scan'"))).toBe(
      true,
    );
  });

  it("rejects an empty-string model id", () => {
    const res = validateProfile("p", {
      ...base,
      tool_models: { security_scan: "" },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("non-empty model-id"))).toBe(true);
  });

  it("rejects a non-string model id (untrusted YAML may yield a number)", () => {
    const res = validateProfile("p", {
      ...base,
      tool_models: { security_scan: 42 as unknown as string },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("non-empty model-id"))).toBe(true);
  });

  it("rejects tool_models that is not a map (e.g. an array)", () => {
    const res = validateProfile("p", {
      ...base,
      tool_models: ["security_scan"] as unknown as Record<string, string>,
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("must be a map"))).toBe(true);
  });
});

describe("resolveHighQualityModel (high-quality scan model, TRDD-DBUSM55E)", () => {
  it("returns built-in defaults for an absent block", () => {
    expect(resolveHighQualityModel(undefined)).toEqual(HIGH_QUALITY_MODEL_DEFAULTS);
  });

  it("returns built-in defaults for null / non-object (untrusted YAML)", () => {
    expect(resolveHighQualityModel(null)).toEqual(HIGH_QUALITY_MODEL_DEFAULTS);
    expect(resolveHighQualityModel("z-ai/glm-5.2")).toEqual(
      HIGH_QUALITY_MODEL_DEFAULTS,
    );
    expect(resolveHighQualityModel([1, 2])).toEqual(HIGH_QUALITY_MODEL_DEFAULTS);
  });

  it("maps reasoning_effort 'max' to the wire ceiling 'xhigh' (case-insensitive)", () => {
    expect(resolveHighQualityModel({ reasoning_effort: "max" }).reasoningEffort).toBe(
      "xhigh",
    );
    expect(resolveHighQualityModel({ reasoning_effort: "MAX" }).reasoningEffort).toBe(
      "xhigh",
    );
  });

  it("passes a valid explicit effort and defaults an unknown one to xhigh", () => {
    expect(
      resolveHighQualityModel({ reasoning_effort: "medium" }).reasoningEffort,
    ).toBe("medium");
    expect(
      resolveHighQualityModel({ reasoning_effort: "ludicrous" }).reasoningEffort,
    ).toBe("xhigh");
  });

  it("expands min_quantization to the this-precision-or-higher whitelist", () => {
    expect(resolveHighQualityModel({ min_quantization: "fp8" }).quantizations).toEqual(
      ["fp8", "fp16", "bf16", "fp32"],
    );
    expect(
      resolveHighQualityModel({ min_quantization: "bf16" }).quantizations,
    ).toEqual(["bf16", "fp32"]);
    expect(
      resolveHighQualityModel({ min_quantization: "int8" }).quantizations,
    ).toEqual(["int8", "fp6", "fp8", "fp16", "bf16", "fp32"]);
  });

  it("pins the provider into provider.order and honors allow_fallbacks", () => {
    const r = resolveHighQualityModel({
      provider: "deepinfra/fp8",
      allow_fallbacks: true,
    });
    expect(r.providerOrder).toEqual(["deepinfra/fp8"]);
    expect(r.allowFallbacks).toBe(true);
  });

  it("overrides only the provided fields, keeping defaults for the rest", () => {
    const r = resolveHighQualityModel({ id: "z-ai/glm-5.2", cache: false });
    expect(r.id).toBe("z-ai/glm-5.2");
    expect(r.cache).toBe(false);
    expect(r.reasoningEffort).toBe("xhigh");
    expect(r.providerOrder).toEqual(["gmicloud/fp8"]);
  });

  it("ignores an empty id and falls back to the default", () => {
    expect(resolveHighQualityModel({ id: "" }).id).toBe(
      HIGH_QUALITY_MODEL_DEFAULTS.id,
    );
  });
});

describe("resolveProfile + validateProfile high_quality_model (TRDD-DBUSM55E)", () => {
  // Direct (non-$) api_key so validation never depends on a live env var.
  const baseRemote: Profile = {
    mode: "remote",
    api: "openrouter-remote",
    model: "google/gemini-2.5-flash",
    api_key: "sk-or-test-direct",
  };

  it("resolveProfile fills highQualityModel with defaults when absent", () => {
    expect(resolveProfile("p", baseRemote).highQualityModel).toEqual(
      HIGH_QUALITY_MODEL_DEFAULTS,
    );
  });

  it("resolveProfile resolves a custom high_quality_model block", () => {
    const r = resolveProfile("p", {
      ...baseRemote,
      high_quality_model: {
        id: "x-ai/grok-4.1",
        reasoning_effort: "high",
        cache: false,
      },
    });
    expect(r.highQualityModel.id).toBe("x-ai/grok-4.1");
    expect(r.highQualityModel.reasoningEffort).toBe("high");
    expect(r.highQualityModel.cache).toBe(false);
  });

  it("validateProfile accepts an absent high_quality_model", () => {
    expect(validateProfile("p", baseRemote).valid).toBe(true);
  });

  it("validateProfile treats a null high_quality_model as absent (blank YAML key)", () => {
    const p: Profile = { ...baseRemote };
    (p as { high_quality_model: unknown }).high_quality_model = null;
    expect(validateProfile("p", p).valid).toBe(true);
  });

  it("validateProfile rejects a non-object high_quality_model", () => {
    const p: Profile = { ...baseRemote };
    (p as { high_quality_model: unknown }).high_quality_model = "z-ai/glm-5.2";
    const res = validateProfile("p", p);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes("high_quality_model must be a map")),
    ).toBe(true);
  });

  it("validateProfile rejects a bad reasoning_effort and a bad min_quantization", () => {
    const res = validateProfile("p", {
      ...baseRemote,
      high_quality_model: {
        reasoning_effort: "turbo",
        min_quantization: "fp99",
      },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("reasoning_effort"))).toBe(true);
    expect(res.errors.some((e) => e.includes("min_quantization"))).toBe(true);
  });

  it("validateProfile accepts a fully-specified valid high_quality_model", () => {
    const res = validateProfile("p", {
      ...baseRemote,
      high_quality_model: {
        id: "z-ai/glm-5.2",
        reasoning_effort: "max",
        cache: true,
        min_quantization: "fp8",
        provider: "gmicloud/fp8",
        allow_fallbacks: false,
      },
    });
    expect(res.valid).toBe(true);
  });
});

describe("buildHighQualityProvider (TRDD-DBUSM55E)", () => {
  it("builds the full provider block from the resolved defaults", () => {
    expect(buildHighQualityProvider(HIGH_QUALITY_MODEL_DEFAULTS)).toEqual({
      allow_fallbacks: false,
      order: ["gmicloud/fp8"],
      quantizations: ["fp8", "fp16", "bf16", "fp32"],
    });
  });

  it("omits an empty provider order (never sends an empty array)", () => {
    const provider = buildHighQualityProvider({
      ...HIGH_QUALITY_MODEL_DEFAULTS,
      providerOrder: [],
    });
    expect(provider).not.toHaveProperty("order");
    expect(provider).toHaveProperty("quantizations");
  });

  it("omits empty quantizations (never sends an empty array)", () => {
    const provider = buildHighQualityProvider({
      ...HIGH_QUALITY_MODEL_DEFAULTS,
      quantizations: [],
    });
    expect(provider).not.toHaveProperty("quantizations");
    expect(provider).toHaveProperty("order");
  });

  it("carries allow_fallbacks through verbatim", () => {
    expect(
      buildHighQualityProvider({
        ...HIGH_QUALITY_MODEL_DEFAULTS,
        allowFallbacks: true,
      }),
    ).toMatchObject({ allow_fallbacks: true });
  });
});

describe("highQualityScanRefusal (paid-model fail-fast gate, TRDD-DBUSM55E)", () => {
  it("allows an OpenRouter backend that is not free_only and has credit", () => {
    expect(highQualityScanRefusal("openrouter", false, false)).toBeNull();
  });

  it("refuses a non-OpenRouter backend", () => {
    expect(highQualityScanRefusal("local", false, false)).toContain(
      "OpenRouter backend",
    );
  });

  it("refuses free_only mode (the model is paid)", () => {
    expect(highQualityScanRefusal("openrouter", true, false)).toContain(
      "free_only",
    );
  });

  it("refuses when credit is exhausted", () => {
    expect(highQualityScanRefusal("openrouter", false, true)).toContain(
      "credit",
    );
  });

  it("checks the backend first when several conditions fail", () => {
    // Backend takes precedence — a local + free_only + no-credit profile still
    // reports the backend problem (the most fundamental blocker).
    expect(highQualityScanRefusal("local", true, true)).toContain(
      "OpenRouter backend",
    );
  });

  it("under the master switch (allow_paid_models=false), names the switch as the fix, not free_only (D2)", () => {
    // high_quality_scan is a REFUSAL, not a silent downgrade — its contract is
    // "ONE strong paid model". Under the master switch the actionable fix is the
    // switch itself, so the message must point there.
    const msg = highQualityScanRefusal("openrouter", true, false, /* allowPaidModels */ false);
    expect(msg).toContain("allow_paid_models");
    expect(msg).toContain("scan_folder");
    expect(msg).not.toContain("Disable free_only");
  });

  it("keeps the original 'disable free_only' wording when paid IS allowed (3-arg back-compat)", () => {
    // The 4th arg defaults true, so every pre-switch caller keeps its wording.
    expect(highQualityScanRefusal("openrouter", true, false)).toContain("free_only");
    expect(highQualityScanRefusal("openrouter", true, false, true)).toContain("free_only");
  });
});

describe("shouldForceFreeMode — the pure free-by-default decision (USER)", () => {
  it("FORCES free for a remote profile while paid is off", () => {
    expect(shouldForceFreeMode(false, "remote")).toBe(true);
    expect(shouldForceFreeMode(false, "remote-ensemble")).toBe(true);
  });

  it("never forces a LOCAL profile ($0/offline)", () => {
    expect(shouldForceFreeMode(false, "local")).toBe(false);
  });

  it("does not force when paid is allowed (the opt-in restores normal behavior)", () => {
    expect(shouldForceFreeMode(true, "remote")).toBe(false);
    expect(shouldForceFreeMode(true, "remote-ensemble")).toBe(false);
    expect(shouldForceFreeMode(true, "local")).toBe(false);
  });

  it("does not force a null mode (invalid/absent active profile — nothing to run)", () => {
    expect(shouldForceFreeMode(false, null)).toBe(false);
    expect(shouldForceFreeMode(true, null)).toBe(false);
  });
});

describe("allow_paid_models — the master switch parse + cache", () => {
  let cfg: string;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "aps-cfg-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
    setAllowPaidModels(false); // restore the free-safe default for sibling suites
  });

  const write = (yaml: string) => writeFileSync(getSettingsPath(), yaml, "utf-8");
  const BASE =
    "active: p\nprofiles:\n  p:\n    mode: remote\n    api: openrouter-remote\n    model: x/y\n";

  it("defaults to false when the key is absent (a pre-switch settings.yaml is free-safe)", () => {
    write(BASE);
    expect(loadSettings()?.allow_paid_models).toBe(false);
  });

  it("parses true only for the literal boolean true", () => {
    write(`${BASE}allow_paid_models: true\n`);
    expect(loadSettings()?.allow_paid_models).toBe(true);
  });

  it("treats any non-true value (a typo / string) as false — never accidentally enables paid", () => {
    write(`${BASE}allow_paid_models: "yes"\n`);
    expect(loadSettings()?.allow_paid_models).toBe(false);
  });

  it("get/set round-trips the process cache; default is false", () => {
    setAllowPaidModels(false);
    expect(getAllowPaidModels()).toBe(false);
    setAllowPaidModels(true);
    expect(getAllowPaidModels()).toBe(true);
  });
});
