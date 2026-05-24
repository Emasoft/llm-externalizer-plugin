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
    toolModels: {},
    timeout: 600,
    contextWindow: 0,
    appName: "",
    httpReferer: "",
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
