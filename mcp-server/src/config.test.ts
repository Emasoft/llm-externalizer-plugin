// Unit tests for the per-tool model map (TRDD-f45eeaa0) added to config.ts:
// resolveModelForTool's resolution order, resolveProfile's toolModels
// population (defensive copy + back-compat default), and validateProfile's
// tool_models validation (known-tool keys + non-empty model-id values,
// treated as untrusted YAML). Pure — no network, no filesystem.

import { describe, it, expect } from "vitest";

import {
  resolveModelForTool,
  resolveProfile,
  validateProfile,
  resolveHighQualityModel,
  HIGH_QUALITY_MODEL_DEFAULTS,
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
