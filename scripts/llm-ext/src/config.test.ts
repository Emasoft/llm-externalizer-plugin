// Unit tests for the per-tool model map (TRDD-f45eeaa0) added to config.ts:
// resolveModelForTool's resolution order, resolveProfile's toolModels
// population (defensive copy + back-compat default), and validateProfile's
// tool_models validation (known-tool keys + non-empty model-id values,
// treated as untrusted YAML). Pure — no network, no filesystem.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  API_PRESETS,
  resolveModelForTool,
  resolveModelChain,
  resolveProfile,
  resolveGroups,
  validateProfile,
  validateUserOwnedKeys,
  validateSettings,
  settingsLevelErrors,
  isInvalidOnlyBecauseUnpopulated,
  resolveHighQualityModel,
  HIGH_QUALITY_MODEL_DEFAULTS,
  buildHighQualityProvider,
  highQualityScanRefusal,
  shouldForceFreeMode,
  loadSettings,
  getSettingsPath,
  setAllowPaidModels,
  getAllowPaidModels,
  assertFreeOnlyModel,
  getActiveFreeOnly,
  setActiveFreeOnly,
  resetActiveFreeOnlyForTests,
  isLocalUrl,
  isDynamicProfileName,
  DYNAMIC_PROFILE_NAMES,
  reservedDynamicProfileNameError,
  DYNAMIC_USER_OWNED_KEYS,
  DEFAULT_PROFILE_NAME,
  paidDailyCapUsd,
  DEFAULT_PAID_DAILY_CAP_USD,
  withinPriceCeiling,
  DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M,
  getEnsemblePriceCeiling,
  type Profile,
  type ResolvedProfile,
  type ResolvedRoute,
  type Settings,
} from "./config.js";
import { registeredTools } from "./model-qualification/registry.js";

function mkResolved(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: "test",
    profileType: "paid",
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
    requestOptions: null,
    appName: "",
    httpReferer: "",
    highQualityModel: HIGH_QUALITY_MODEL_DEFAULTS,
    // Default fixture is an OpenRouter profile: remote, billable, not free.
    isLocal: false,
    isFreeProvider: false,
    routes: [],
    routesFor: (): ResolvedRoute[] => [],
    routeForModel: (): null => null,
    // P1: STATIC by default (matches every pre-existing test in this file,
    // none of which name a profile "free"/"paid") — dynamic-specific tests
    // override both explicitly via mkResolved({ dynamic: true, ... }).
    dynamic: false,
    paidModels: [],
    ...overrides,
  };
}

// TRDD-FDI9NYAS D3c-2 (C4d): getActiveFreeOnly() before the first
// setActiveFreeOnly() must fail CLOSED — unset means "free_only", never
// "paid allowed". The old `false` default let a spend-site read that raced
// ahead of settings load bill paid models on a free_only machine.
describe("getActiveFreeOnly — unset state fails closed (D3c-2 C4d)", () => {
  it("reads TRUE before any setActiveFreeOnly call, then reflects each explicit set", () => {
    // Reset the module-global to its UNSET posture for this process.
    resetActiveFreeOnlyForTests();
    expect(getActiveFreeOnly()).toBe(true);
    setActiveFreeOnly(false);
    expect(getActiveFreeOnly()).toBe(false);
    setActiveFreeOnly(true);
    expect(getActiveFreeOnly()).toBe(true);
    resetActiveFreeOnlyForTests();
    expect(getActiveFreeOnly()).toBe(true);
    // Leave an explicit value so this process never leaks the unset posture.
    setActiveFreeOnly(false);
  });
});

describe("fix-queue 74: loadSettings copies paid_benchmark_daily_cap_usd from the real YAML", () => {
  let cfg: string;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "cap74-cfg-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
  });

  const write = (yaml: string) => writeFileSync(getSettingsPath(), yaml, "utf-8");
  const BASE =
    "active: p\nprofiles:\n  p:\n    mode: remote\n    api: openrouter-remote\n    model: x/y\n";

  // Before the fix: loadSettings() built its returned object field-by-field and
  // never read paid_benchmark_daily_cap_usd out of the parsed YAML at all, so a
  // user-configured 0.25 cap was silently discarded and paidDailyCapUsd() fell
  // back to DEFAULT_PAID_DAILY_CAP_USD (0.5) on every real load -- the gate a
  // user set to be MORE conservative was silently loosened to the library
  // default. Red on HEAD (a `git archive HEAD` scratch copy of this file with
  // the pre-fix config.ts): loadSettings()?.paid_benchmark_daily_cap_usd was
  // undefined and paidDailyCapUsd(loadSettings()) was 0.5, not 0.25.
  it("a configured 0.25 cap in settings.yaml is honoured through the real load path", () => {
    write(`${BASE}paid_benchmark_daily_cap_usd: 0.25\n`);
    const settings = loadSettings();
    expect(settings?.paid_benchmark_daily_cap_usd).toBe(0.25);
    expect(paidDailyCapUsd(settings)).toBe(0.25);
  });

  it("an absent cap still falls back to DEFAULT_PAID_DAILY_CAP_USD (back-compat)", () => {
    write(BASE);
    const settings = loadSettings();
    expect(settings?.paid_benchmark_daily_cap_usd).toBeUndefined();
    expect(paidDailyCapUsd(settings)).toBe(DEFAULT_PAID_DAILY_CAP_USD);
  });

  // appendCapErrors (validateSettings' cap check) is reachable through the
  // real load path now that loadSettings actually copies the raw value --
  // previously it could never fire outside a hand-constructed Settings object
  // in a unit test (S-C / row 75's own premise).
  it("an invalid cap in settings.yaml now reaches validateSettings as a real error", () => {
    write(`${BASE}paid_benchmark_daily_cap_usd: -1\n`);
    const settings = loadSettings();
    expect(settings).not.toBeNull();
    const res = validateSettings(settings!);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes("paid_benchmark_daily_cap_usd must be a finite number >= 0")),
    ).toBe(true);
  });
});

describe("fix-queue 75: settingsLevelErrors — every settings-level error validateSettings can produce", () => {
  const baseProfiles: Settings["profiles"] = {
    p: { mode: "remote", api: "openrouter-remote", model: "x/y" } as Settings["profiles"][string],
  };

  it("returns [] when neither the reserved-name nor the cap error applies", () => {
    const settings = { profiles: baseProfiles } as Settings;
    expect(settingsLevelErrors(settings)).toEqual([]);
  });

  it("returns only the reserved-name error when unmarkedDynamicProfiles is non-empty (early-return shape, same as validateSettings)", () => {
    const settings = {
      profiles: baseProfiles,
      unmarkedDynamicProfiles: ["paid"],
    } as Settings;
    expect(settingsLevelErrors(settings)).toEqual([validateSettings(settings).errors[0]]);
    expect(settingsLevelErrors(settings)).toHaveLength(1);
  });

  it("returns only the cap error when the cap is invalid and there is no reserved-name collision", () => {
    const settings = {
      profiles: baseProfiles,
      paid_benchmark_daily_cap_usd: -1,
    } as Settings;
    const errs = settingsLevelErrors(settings);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("paid_benchmark_daily_cap_usd must be a finite number >= 0");
  });

  // Unlike validateSettings (which early-returns the reserved-name error
  // alone and never even inspects the cap), settingsLevelErrors concatenates
  // both, in order, so a caller checking "any settings-level error at all"
  // sees the full set.
  it("when both apply, returns the reserved-name error followed by the cap error, in order", () => {
    const settings = {
      profiles: baseProfiles,
      unmarkedDynamicProfiles: ["paid"],
      paid_benchmark_daily_cap_usd: -1,
    } as Settings;
    const errs = settingsLevelErrors(settings);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toEqual(validateSettings(settings).errors[0]);
    expect(errs[1]).toContain("paid_benchmark_daily_cap_usd must be a finite number >= 0");
  });
});

describe("fix-queue 52/54: chainModelIds widened + Remote-auth route exemption (P6c-a2c)", () => {
  // A single providers[] binding that fully serves "glm-5.3-flash" with its own
  // literal credential -- no base api_key resolves, on purpose, in every test
  // below (savedOr save/restore mirrors the existing OPENROUTER_API_KEY pattern
  // above so this suite is deterministic regardless of the ambient env / which
  // of the three isolation legs it runs under).
  const bAiRoute = {
    api: "chat-b-ai-remote",
    api_key: "bai-literal-not-a-real-key",
    models: ["glm-5.3-flash"],
  };
  let savedOr: string | undefined;
  beforeEach(() => {
    savedOr = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (savedOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOr;
  });

  // fix-queue 52 (a): before the widening, chainModelIds never looked at
  // tool_models, so a profile fully served by providers[] on its ensemble
  // slots but with an UNCOVERED tool_models head was wrongly exempted from
  // the base api_key requirement -- it could boot and then send that tool's
  // requests to the base api with no Authorization header at all.
  it("(a) an explicit tool_models head with no route, no base credential -> invalid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "glm-5.3-flash",
      providers: [bAiRoute],
      tool_models: { security_scan: "some-vendor/uncovered-model" },
    } as unknown as Profile;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("requires 'api_key'"))).toBe(true);
  });

  // fix-queue 52 (b): the exact same profile once that head is removed -- the
  // remaining chain (just `model`) is fully route-served, so no base
  // credential is required.
  it("(b) the same profile with the tool_models head removed -> valid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "glm-5.3-flash",
      providers: [bAiRoute],
    } as unknown as Profile;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // fix-queue 52 (c): high_quality_model.id defaults to an OpenRouter id
  // (HIGH_QUALITY_MODEL_DEFAULTS) on EVERY profile whether or not the user
  // wrote one -- counting the default would demand a route/credential for a
  // model most profiles never configured, re-bricking the b.ai-only machine
  // fix4 unbricked. A fully route-served profile that never sets
  // high_quality_model must stay valid with no base credential.
  it("(c) a defaulted high_quality_model alone never invalidates a fully route-served profile", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "glm-5.3-flash",
      providers: [bAiRoute],
    } as unknown as Profile;
    expect(p.high_quality_model).toBeUndefined();
    const res = validateProfile("p", p);
    expect(res.valid).toBe(true);
    expect(resolveHighQualityModel(p.high_quality_model).id).toBe(
      HIGH_QUALITY_MODEL_DEFAULTS.id,
    );
  });

  // fix-queue 54: the three-case unit test for the route exemption fix4's own
  // review found missing (S-C) -- each leg isolates ONE way the chain can fail
  // to be fully route-served, plus the positive control.
  it("(54-i) an empty chain (free_only, no free_models) -> invalid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: [],
      model: "placeholder/unused",
    } as unknown as Profile;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("requires 'api_key'"))).toBe(true);
  });

  it("(54-ii) one chain entry with no providers[] route at all -> invalid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "glm-5.3-flash",
      second_model: "uncovered/second-model",
      providers: [bAiRoute],
    } as unknown as Profile;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("requires 'api_key'"))).toBe(true);
  });

  it("(54-iii) a route whose own credential does not resolve -> invalid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "glm-5.3-flash",
      providers: [
        { api: "chat-b-ai-remote", api_key: "$LLM_EXT_TEST_UNSET_BAI_KEY_ITEM54", models: ["glm-5.3-flash"] },
      ],
    } as unknown as Profile;
    delete process.env.LLM_EXT_TEST_UNSET_BAI_KEY_ITEM54;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("requires 'api_key'"))).toBe(true);
  });

  it("(54-iv positive) fully route-served -> valid without the base key", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "glm-5.3-flash",
      providers: [bAiRoute],
    } as unknown as Profile;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // R-1 (review round 1): the free_only branch of chainModelIds must union the
  // SAME shared surfaces (tool_models, explicit high_quality_model) as the
  // general branch -- resolveProfile serves tool_models under DYNAMIC
  // free_only too (`toolModels: freeOnly && !dynamic ? {} : ...`), and
  // resolveModelChain uses toolModels[tool] as the chain head, so a DYNAMIC
  // free_only profile whose free_models pool is fully route-served but whose
  // explicit tool_models head is not was wrongly exempted from the base
  // api_key requirement. Red on the pre-R-1 free_only branch (returns ONLY
  // the free_models pool, never looks at tool_models): (d) was valid there,
  // wrongly. Uses the DYNAMIC name "free" (config.ts DYNAMIC_PROFILE_NAMES)
  // deliberately -- a STATIC name would have resolveProfile blank tool_models
  // to {} regardless, see (f) below (R-1 review round 2's own finding: the
  // review that caught this test using a static name here first).
  it("(d) dynamic free_only, pool fully route-served, uncovered tool_models head -> invalid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: ["glm-5.3-flash:free"],
      providers: [{ ...bAiRoute, models: ["glm-5.3-flash:free"] }],
      tool_models: { security_scan: "some/uncovered:free" },
      model: "placeholder/unused",
    } as unknown as Profile;
    const res = validateProfile("free", p);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("requires 'api_key'"))).toBe(true);
  });

  it("(e) the same dynamic profile without tool_models -> valid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: ["glm-5.3-flash:free"],
      providers: [{ ...bAiRoute, models: ["glm-5.3-flash:free"] }],
      model: "placeholder/unused",
    } as unknown as Profile;
    const res = validateProfile("free", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // R-1 review round 2 (adversarial review caught this): a STATIC (non-
  // dynamic-named) free_only profile has resolveProfile blank tool_models to
  // `{}` unconditionally -- `toolModels: freeOnly && !dynamic ? {} : ...` --
  // so an uncovered tool_models entry there is NEVER actually dispatched.
  // Counting it in chainModelIds would be a false-rejection regression in the
  // opposite direction from the bug R-1 fixed. Same profile shape as (d), but
  // named "p" (not one of DYNAMIC_PROFILE_NAMES = ["free", "paid", "local"]).
  it("(f) static free_only, pool fully route-served, uncovered tool_models head -> valid (tool_models is dead there)", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: ["glm-5.3-flash:free"],
      providers: [{ ...bAiRoute, models: ["glm-5.3-flash:free"] }],
      tool_models: { security_scan: "some/uncovered:free" },
      model: "placeholder/unused",
    } as unknown as Profile;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // Row 79: explicit high_quality_model.id has its own predicate now --
  // highQualityScanRefusal refuses high_quality_scan unconditionally under
  // ANY free_only profile (static or dynamic; index.ts feeds it the RUNTIME
  // isFreeModeActive(), which reads the resolved profile's own free_only
  // field regardless of the static/dynamic name), so a STATIC free_only
  // profile's explicit hq is exactly as dead as its tool_models is. Same
  // shape as (f), but the uncovered head is high_quality_model.id instead of
  // tool_models. RED before the row 79 fix (chainModelIds counted explicit
  // hq unconditionally).
  it("(g) static free_only, pool fully route-served, uncovered explicit high_quality_model.id -> valid (hq is dead there too)", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: ["glm-5.3-flash:free"],
      providers: [{ ...bAiRoute, models: ["glm-5.3-flash:free"] }],
      high_quality_model: { id: "some/uncovered:free" },
      model: "placeholder/unused",
    } as unknown as Profile;
    const res = validateProfile("p", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // Unlike tool_models, a DYNAMIC free_only profile ("free") does NOT dispatch
  // its explicit hq either -- highQualityScanRefusal is refused for any
  // free_only profile regardless of the static/dynamic distinction that
  // matters for tool_models (see explicitHq JSDoc in chainModelIds), so an
  // uncovered head is not a real send surface here. Fails if hqBlanked goes
  // back through blanksToolModelsUnderFreeOnly(freeOnly, dynamic) instead of
  // reading profile.free_only directly: "free" is dynamic, so that predicate
  // evaluates to false, explicitHq gets counted, and the profile is wrongly
  // rejected.
  it("(h) dynamic free_only, pool fully route-served, uncovered explicit high_quality_model.id -> valid (hq is dead there too)", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: ["glm-5.3-flash:free"],
      providers: [{ ...bAiRoute, models: ["glm-5.3-flash:free"] }],
      high_quality_model: { id: "some/uncovered:free" },
      model: "placeholder/unused",
    } as unknown as Profile;
    const res = validateProfile("free", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // Mutation-tested guard that blanksToolModelsUnderFreeOnly continues to
  // count tool_models for a DYNAMIC free_only profile ("free").
  // If blanksToolModelsUnderFreeOnly were mutated to `return freeOnly;` (dropping
  // the `!dynamic` term), this case's toolModelsBlanked would flip to true, the
  // uncovered tool_models head below would stop being counted, and the profile
  // would wrongly validate -- silently re-opening the R-1 bug (d) above already
  // guards, but pinned again here with an uncovered `chat` head (not
  // `security_scan`) and no high_quality_model, so this case fails on its own
  // even if (d) were ever deleted.
  it("(h') dynamic free_only, pool fully route-served, uncovered tool_models head, no high_quality_model -> invalid", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: ["glm-5.3-flash:free"],
      providers: [{ ...bAiRoute, models: ["glm-5.3-flash:free"] }],
      tool_models: { chat: "some/uncovered:free" },
      model: "placeholder/unused",
    } as unknown as Profile;
    const res = validateProfile("free", p);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("requires 'api_key'"))).toBe(true);
  });
});

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
    expect(shouldForceFreeMode(false, "remote", "paid")).toBe(true);
    expect(shouldForceFreeMode(false, "remote-ensemble", "paid")).toBe(true);
  });

  it("never forces a LOCAL profile ($0/offline)", () => {
    expect(shouldForceFreeMode(false, "local", "paid")).toBe(false);
  });

  it("does not force when paid is allowed (the opt-in restores normal behavior)", () => {
    expect(shouldForceFreeMode(true, "remote", "paid")).toBe(false);
    expect(shouldForceFreeMode(true, "remote-ensemble", "paid")).toBe(false);
    expect(shouldForceFreeMode(true, "local", "paid")).toBe(false);
  });

  it("does not force a null mode (invalid/absent active profile — nothing to run)", () => {
    expect(shouldForceFreeMode(false, null, "paid")).toBe(false);
    expect(shouldForceFreeMode(true, null, "paid")).toBe(false);
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

// ── chat.b.ai remote preset ─────────────────────────────────────────
// b.ai is the second remote provider. Its preset carries one invariant that is
// easy to "tidy" into a bug: protocol MUST stay "openai_api". Switching it to
// "openrouter_api" would flip backend.type to "openrouter", and the master
// free-by-default switch would then require every model id to end in ':free' —
// which no b.ai id does — refusing every request before the wire.
describe("chat-b-ai-remote preset", () => {
  const preset = API_PRESETS["chat-b-ai-remote"]!;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = saved;
  });

  it("is a remote, OpenAI-compat preset — never openrouter_api", () => {
    expect(preset).toBeDefined();
    expect(preset.protocol).toBe("openai_api");
    expect(preset.isLocal).toBe(false);
    expect(preset.defaultAuthEnv).toBe("$BAI_API_KEY");
  });

  it("defaultUrl omits /v1 — resolveConnection appends /v1/chat/completions", () => {
    expect(preset.defaultUrl).toBe("https://api.b.ai");
    expect(preset.defaultUrl.endsWith("/v1")).toBe(false);
    expect(preset.defaultUrl.endsWith("/")).toBe(false);
  });

  it("validateProfile accepts a remote b.ai profile when BAI_API_KEY is set", () => {
    const p: Profile = { mode: "remote", api: "chat-b-ai-remote", model: "glm-5.3-flash" };
    expect(validateProfile("bai", p)).toEqual({ valid: true, errors: [] });
  });

  it("validateProfile rejects it when BAI_API_KEY is absent", () => {
    delete process.env.BAI_API_KEY;
    const p: Profile = { mode: "remote", api: "chat-b-ai-remote", model: "glm-5.3-flash" };
    const res = validateProfile("bai", p);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toContain("BAI_API_KEY");
  });

  it("resolveProfile resolves url, model and the env-referenced key", () => {
    const r = resolveProfile("bai", {
      mode: "remote",
      api: "chat-b-ai-remote",
      model: "glm-5.3-flash",
    });
    expect(r.url).toBe("https://api.b.ai");
    expect(r.model).toBe("glm-5.3-flash");
    expect(r.authToken).toBe("test-key");
    expect(r.protocol).toBe("openai_api");
  });
});

// ── resolveGroups: the free-provider claim vs a redirected host ──────
// The exemption must survive a URL that merely RESTATES the preset default
// (linters and generated YAML write it out), and must NOT survive a host
// redirect — the shape that would carry "this provider cannot bill" to an
// arbitrary endpoint holding a real key.
// D6a: routes[0] is now the PRIMARY (group #0); a profile's first binding is
// routes[1]. The `withBindingRoute` helper below picks the first NON-primary
// route, preserving every assertion's original subject.
describe("resolveGroups isFreeProvider host check", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = saved;
  });

  const withUrl = (url?: string): boolean => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [
        {
          api: "chat-b-ai-remote",
          models: ["glm-5.3-flash"],
          ...(url === undefined ? {} : { url }),
        },
      ],
    };
    return resolveGroups(p).routes.find((r) => !r.primary)!.isFreeProvider;
  };

  it("keeps the exemption when no url is given", () => {
    expect(withUrl(undefined)).toBe(true);
  });

  it("keeps it when the url restates the preset default", () => {
    expect(withUrl("https://api.b.ai")).toBe(true);
    expect(withUrl("https://api.b.ai/")).toBe(true);
  });

  it("keeps it for an empty url, and still resolves to the preset default", () => {
    // Asserts BOTH axes deliberately. `overridesHost` and `route.url` consult
    // `binding.url` in two unrelated expressions, and both happen to treat ""
    // as absent. A plausible refactor (`binding.url !== undefined`) would split
    // them: the exemption would vanish while the route still pointed at b.ai.
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [{ api: "chat-b-ai-remote", models: ["glm-5.3-flash"], url: "" }],
    };
    const route = resolveGroups(p).routes.find((r) => !r.primary)!;
    expect(route.isFreeProvider).toBe(true);
    expect(route.url).toBe(API_PRESETS["chat-b-ai-remote"]!.defaultUrl);
  });

  it("VOIDS it when the host is redirected — the spend-guard case", () => {
    expect(withUrl("https://api.openai.com")).toBe(false);
  });

  it("VOIDS it on a cleartext downgrade to the SAME host", () => {
    // Same host, so a host-only comparison would keep the exemption and send a
    // real bearer token over plaintext. Scheme must be part of the check.
    expect(withUrl("http://api.b.ai")).toBe(false);
  });

  it("keeps it when an explicit default port is written out", () => {
    // WHATWG URL elides a scheme's default port, so this is not an override.
    expect(withUrl("https://api.b.ai:443")).toBe(true);
  });

  it("VOIDS it on an unparseable url — an unverifiable claim fails closed", () => {
    expect(withUrl("not a url")).toBe(false);
  });

  it("indexes each binding's models to its route", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [{ api: "chat-b-ai-remote", models: ["glm-5.3-flash"] }],
    };
    const { routeForModel } = resolveGroups(p);
    expect(routeForModel("glm-5.3-flash")?.api).toBe("chat-b-ai-remote");
    expect(routeForModel("glm-5.3-flash")?.authToken).toBe("test-key");
  });

  // ⚠ THE TWO TESTS BELOW PIN A DEFECT, NOT A SPEC. They assert today's SILENT
  // drop. When the fix lands (a poisoned route that refuses at send time, or a
  // loud warning), these WILL go red — that is them doing their job, and the
  // correct response is to UPDATE them, not to "restore" the behaviour they
  // describe. Without this warning the next person reads a red test as their own
  // regression and reverts the fix.
  it("REGRESSION LOCK (update me when fixed): unknown preset is dropped silently", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [{ api: "chat-bai-remote", models: ["glm-5.3-flash"] }], // typo
    };
    const { routes } = resolveGroups(p);
    // The message goes on the FIRST assertion: when the poison-route fix lands,
    // `routes` becomes non-empty and THIS throws, so the second one never runs.
    // A message on the later assertion would never print — which is the whole
    // failure it exists to prevent. Vitest PREFIXES this string to the assertion
    // error, so it lands first on the error line, ahead of the expected/received
    // text and the diff (verified by forcing this assertion to fail and reading
    // the output). Kept short so the signal is the part that survives IF a
    // reporter truncates the line — that part is intent, not a measured claim.
    // D6a: the primary group is routes[0] even on a poisoned binding, so the
    // lock is on the BINDING routes (everything after group #0).
    expect(routes.slice(1), "REGRESSION LOCK: pins a defect — UPDATE, do not restore").toEqual([]);
  });

  it("DOCUMENTS (not a lock): scalar `models:` is dropped silently by resolveGroups", () => {
    // The likelier user mistake: `models: glm-5.3-flash` instead of a list.
    // Nothing survives coercion, so no model list exists to poison — this case
    // needs a validate-time rejection or a resolve-time warning, unlike the
    // unknown-preset case above.
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [
        { api: "chat-b-ai-remote", models: "glm-5.3-flash" as unknown as string[] },
      ],
    };
    const { routes } = resolveGroups(p);
    // NOT a tripwire, unlike the lock above — and the difference is worth stating
    // because the name says LOCK. resolveGroups never calls validateProfile, so
    // when the `models:`-must-be-a-list rejection lands there, this function
    // still drops the binding and these assertions still pass. Nothing here will
    // go red to tell you the hole closed.
    //
    // So this only DOCUMENTS resolveGroups' silent drop. The rejection itself
    // belongs in validateProfile and must be tested in the validateProfile
    // section — if you are implementing it, add the test there; do not expect
    // this one to react.
    // D6a: the primary group survives (routes[0]), so the lock is on the
    // BINDING routes only.
    expect(routes.slice(1)).toEqual([]);
  });
});

// ── D1: the primary-provider cost-guard bypass, closed ───────────────
// The original hole: `chat-b-ai-remote` uses protocol "openai_api", which
// makeBackendFromProfile maps to backend.type "local". The free_only guard read
// that type, concluded "local ⟹ $0", and waved everything through — so a profile
// keeping the preset NAME while pointing `url:` at a paid host disabled the
// spend guard entirely. These tests pin the fix at the resolver, which is where
// the claim is decided.
describe("D1 — a redirected free preset must not look free", () => {
  const bypass: Profile = {
    mode: "remote",
    api: "chat-b-ai-remote",
    url: "https://api.openai.com",
    api_key: "direct-key",
    model: "gpt-4o",
  };

  it("voids the primary provider's free claim when url: redirects the host", () => {
    const r = resolveProfile("sneaky", bypass);
    expect(r.isFreeProvider).toBe(false);
    // isLocal comes from the PRESET (remote), so billable = !isLocal && !free.
    expect(r.isLocal).toBe(false);
  });

  it("so the resulting backend is BILLABLE and the guard refuses gpt-4o", () => {
    const r = resolveProfile("sneaky", bypass);
    const billable = !r.isLocal && !r.isFreeProvider;
    expect(billable).toBe(true);
    expect(() => assertFreeOnlyModel(true, billable, r.model, r.isFreeProvider)).toThrow(
      /cost-safety/,
    );
  });

  it("keeps the claim for an honest b.ai profile, so it still works", () => {
    const honest = resolveProfile("bai", {
      mode: "remote",
      api: "chat-b-ai-remote",
      api_key: "direct-key",
      model: "glm-5.3-flash",
    });
    expect(honest.isFreeProvider).toBe(true);
    const billable = !honest.isLocal && !honest.isFreeProvider;
    expect(billable).toBe(false);
    expect(() =>
      assertFreeOnlyModel(true, billable, honest.model, honest.isFreeProvider),
    ).not.toThrow();
  });

  it("refuses a suffix-less model on a genuinely billable remote profile", () => {
    const paid = resolveProfile("paid", {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "openai/gpt-4o",
    });
    const billable = !paid.isLocal && !paid.isFreeProvider;
    expect(billable).toBe(true);
    expect(() => assertFreeOnlyModel(true, billable, paid.model, paid.isFreeProvider)).toThrow(
      /cost-safety/,
    );
  });
});

// ── "local" must mean the ENDPOINT is local, not that the preset says so ──
// preset.isLocal is a claim about the preset's DEFAULT url. `url:` can move a
// local preset to a remote host — generic-local exists to be pointed anywhere —
// and a remote host can bill. So isLocal is preset.isLocal AND isLocalUrl(url).
describe("isLocal reflects the resolved endpoint, not just the preset", () => {
  // D6a: the first binding is routes[1] (routes[0] is the primary group).
  const routeFor = (api: string, url?: string) =>
    resolveGroups({
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [{ api, models: ["m"], ...(url === undefined ? {} : { url }) }],
    }).routes.find((r) => !r.primary)!;

  it("keeps isLocal for a local preset on its default (localhost) url", () => {
    expect(routeFor("ollama-local").isLocal).toBe(true);
  });

  it("keeps isLocal for a LAN address (a local server need not be on localhost)", () => {
    expect(routeFor("ollama-local", "http://192.168.1.50:11434").isLocal).toBe(true);
  });

  it("DROPS isLocal when a local preset is pointed at a remote host", () => {
    // The hole: this would otherwise read as non-billable, and free_only would
    // wave every model through to an internet server.
    expect(routeFor("ollama-local", "https://ollama.example.com").isLocal).toBe(false);
  });

  it("keeps isLocal for generic-local pointed at a local address", () => {
    // generic-local has defaultUrl "", so it REQUIRES an explicit url. Deriving
    // this from overridesEndpoint instead of isLocalUrl would mark every
    // generic-local route billable and refuse it under free_only.
    expect(routeFor("generic-local", "http://127.0.0.1:9000").isLocal).toBe(true);
  });

  it("DROPS isLocal for generic-local pointed at a remote host", () => {
    expect(routeFor("generic-local", "https://api.example.com").isLocal).toBe(false);
  });

  it("applies the same rule to the PRIMARY provider", () => {
    const remote = resolveProfile("p", {
      mode: "local",
      api: "ollama-local",
      url: "https://ollama.example.com",
      model: "qwen3:14b",
    });
    expect(remote.isLocal).toBe(false);
    const local = resolveProfile("p", {
      mode: "local",
      api: "ollama-local",
      model: "qwen3:14b",
    });
    expect(local.isLocal).toBe(true);
  });
});

// ── D6a: provider groups — routesFor, names, E-P1..E-P4 ──────────────
// One model id served by two groups is the D6a headline shape (two accounts
// of one provider): routesFor returns BOTH, in group order, and the
// cross-group duplicate refusal that D0 used to raise is GONE.
describe("D6a provider groups", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = savedKey;
  });

  it("routesFor returns every serving group in group order (two accounts of one model)", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [
        { name: "bai", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["glm-5.3-flash"] },
        { name: "bai-2", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY_2", models: ["glm-5.3-flash"] },
      ],
    };
    const { routesFor } = resolveGroups(p);
    const serving = routesFor("glm-5.3-flash");
    expect(serving.map((r) => r.name)).toEqual(["bai", "bai-2"]);
    // Same id, two DIFFERENT routes (different keys) — the whole point.
    expect(serving[0]).not.toBe(serving[1]);
  });

  it("a catch-all group (no models:) serves every id no named group claims", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [{ name: "or-backup", api: "openrouter-remote", api_key: "$BAI_API_KEY" }],
    };
    const { routesFor, routeForModel } = resolveGroups(p);
    const serving = routesFor("z-ai/glm-5.2");
    // Group #0 (primary) plus the catch-all, in group order.
    expect(serving.map((r) => r.name)).toEqual(["openrouter-remote", "or-backup"]);
    expect(routeForModel("z-ai/glm-5.2")?.name).toBe("openrouter-remote");
  });

  it("derives names from api with -2 on repeats; an explicit name wins", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [
        { api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["a"] },
        { name: "custom", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["b"] },
        { api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["c"] },
      ],
    };
    const { routes } = resolveGroups(p);
    expect(routes.map((r) => r.name)).toEqual([
      "openrouter-remote",
      "chat-b-ai-remote",
      "custom",
      "chat-b-ai-remote-2",
    ]);
  });

  it("E-P1: a duplicate explicit name is refused", () => {
    const errors = validateProfile("p", {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [
        { name: "bai", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["a"] },
        { name: "bai", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["b"] },
      ],
    });
    expect(errors.valid).toBe(false);
    expect(errors.errors.join("\n")).toMatch(/names must be unique within the profile/);
  });

  it("E-P3: two groups with the same endpoint AND key are refused", () => {
    const errors = validateProfile("p", {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [
        { name: "one", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["a"] },
        { name: "two", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["b"] },
      ],
    });
    expect(errors.valid).toBe(false);
    expect(errors.errors.join("\n")).toMatch(/same endpoint AND key; credit is per key/);
  });

  it("E-P2: a group without api needs name and url", () => {
    const errors = validateProfile("p", {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [{ api_key: "$BAI_API_KEY", models: ["a"] }],
    });
    expect(errors.valid).toBe(false);
    expect(errors.errors.join("\n")).toMatch(/a group without 'api' needs 'name' and 'url'/);
  });

  it("THE D6A HEADLINE: the same model id in two groups is NOT an error (the D0 cross-group duplicate refusal is gone)", () => {
    const errors = validateProfile("p", {
      mode: "remote",
      api: "openrouter-remote",
      // Literal key, not $OPENROUTER_API_KEY: leg-1 of the suite runs with the
      // real env vars unset, and group #0's key-existence check fires on an
      // unset primary key — a verdict about the ENV, not about groups.
      api_key: "literal-primary-key",
      model: "x",
      providers: [
        { name: "one", api: "chat-b-ai-remote", api_key: "literal-key-one", models: ["glm-5.3-flash"] },
        { name: "two", api: "chat-b-ai-remote", api_key: "literal-key-two", models: ["glm-5.3-flash"] },
      ],
    });
    // Literal keys, not $BAI_API_KEY: with the env var unset both groups'
    // keyRefs collapse to "none" and E-P3's same-(endpoint,key) refusal fires
    // — a correct fail-closed verdict for THAT config, not the cross-group
    // duplicate refusal this test proves is gone.
    expect(errors.errors, JSON.stringify(errors.errors)).toEqual([]);
    expect(errors.valid).toBe(true);
  });

  it("billability of a served id is ANY serving group billable (getActiveBillableForModel)", () => {
    // One non-billable group + one billable catch-all serving the same id:
    // the id is billable, fail-closed. (The reverse — one billable + one
    // free — is pinned by the free_only validator tests above.)
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "x",
      providers: [{ name: "or-2", api: "openrouter-remote", api_key: "$BAI_API_KEY" }],
    };
    const { routesFor } = resolveGroups(p);
    const serving = routesFor("some/paid-model");
    expect(serving.length).toBe(2); // primary + catch-all
    expect(serving.every((r) => !r.isLocal && !r.isFreeProvider)).toBe(true);
  });
});

// ── isLocalUrl: the private-IP alternatives must be ANCHORED ─────────
// isLocalUrl now decides BILLABILITY (ResolvedProfile/ResolvedRoute isLocal),
// where "local" means "cannot charge me". A false positive therefore marks a
// billable host free and free_only permits the send — the unsafe direction.
describe("isLocalUrl does not match a private IP used as a subdomain", () => {
  it("still recognises genuine local addresses", () => {
    for (const u of [
      "http://localhost:1234",
      "http://127.0.0.1:11434",
      "http://192.168.1.50:8000",
      "http://10.0.0.5:8080",
      "http://172.16.0.9:9000",
      "http://[::1]:1234",
      "http://0.0.0.0:8000",
      "http://localhost",
    ]) {
      expect(isLocalUrl(u), `expected LOCAL: ${u}`).toBe(true);
    }
  });

  it("REJECTS a private IP that is only a prefix of a routable host", () => {
    // Each of these matched before the anchors were added.
    for (const u of [
      "http://127.0.0.1.evil.com",
      "http://192.168.1.1.evil.com",
      "http://10.0.0.1.attacker.net",
      "http://172.16.0.1.evil.com",
    ]) {
      expect(isLocalUrl(u), `expected NOT local: ${u}`).toBe(false);
    }
  });

  it("rejects hosts that merely start with 'localhost'", () => {
    expect(isLocalUrl("http://localhost.evil.com")).toBe(false);
  });

  it("treats remote endpoints as non-local", () => {
    expect(isLocalUrl("https://api.b.ai")).toBe(false);
    expect(isLocalUrl("https://openrouter.ai/api")).toBe(false);
  });

  // item A3c/D3: mDNS .local hostnames (e.g. a local LM Studio addressed as
  // mymac.local) were previously NOT matched — isLocalUrl returned false, so
  // such a host was treated as remote/billable (the SAFE direction, but wrong:
  // a genuinely local server got labeled Remote in status output, and a
  // free_only profile pointed at one would wrongly refuse it).
  it("recognises mDNS .local hostnames as local", () => {
    expect(isLocalUrl("http://mymac.local:1234")).toBe(true);
    expect(isLocalUrl("http://mymac.local/")).toBe(true);
  });

  it("does NOT treat a .local suffix used as a subdomain as local", () => {
    expect(isLocalUrl("http://mymac.local.evil.com")).toBe(false);
    expect(isLocalUrl("http://evil.com/x.local")).toBe(false);
  });
});

// Anchoring must terminate on ?/# too, and every alternative must be anchored.
describe("isLocalUrl anchoring covers query, fragment and IPv6", () => {
  it("keeps a local URL local when a query or fragment follows the host", () => {
    // Anchoring on [:/] alone regressed these to REMOTE.
    expect(isLocalUrl("http://127.0.0.1?x=1")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1#f")).toBe(true);
    expect(isLocalUrl("http://localhost?a=b")).toBe(true);
  });

  it("REJECTS an IPv6 loopback used as a prefix of a routable host", () => {
    // [::1] was the one alternative left unanchored by the first pass.
    expect(isLocalUrl("http://[::1].evil.com")).toBe(false);
  });

  it("still accepts a real IPv6 loopback with a port", () => {
    expect(isLocalUrl("http://[::1]:8080")).toBe(true);
    expect(isLocalUrl("http://[::1]")).toBe(true);
  });

  it("rejects 0.0.0.0 used as a prefix", () => {
    expect(isLocalUrl("http://0.0.0.0.evil.com")).toBe(false);
  });
});

// ── validateProfile: providers (multi-provider bindings) ─────────────
// Every case here is a binding that WOULD be dropped silently — by
// coerceProviderBindings or by resolveRoutes — and would then read as "that
// provider is never used" while its models quietly went to the PRIMARY provider
// with the PRIMARY's key. The point of the block is that none of them boot.
describe("validateProfile providers validation", () => {
  const base: Profile = {
    mode: "remote",
    api: "openrouter-remote",
    model: "google/gemini-2.5-flash",
    api_key: "direct-key",
  };
  const withProviders = (providers: unknown): Profile =>
    ({ ...base, providers }) as unknown as Profile;

  it("accepts two well-formed bindings with their own keys", () => {
    const res = validateProfile("p", withProviders([
      { api: "chat-b-ai-remote", api_key: "bai-key", models: ["glm-5.3-flash"] },
      { api: "ollama-local", url: "http://localhost:11434", models: ["qwen3:14b"] },
    ]));
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("is valid when providers is absent or null (back-compat)", () => {
    expect(validateProfile("p", base).valid).toBe(true);
    expect(validateProfile("p", withProviders(null)).valid).toBe(true);
  });

  it("rejects a non-list providers", () => {
    const res = validateProfile("p", withProviders({ api: "chat-b-ai-remote" }));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/providers must be a YAML list/);
  });

  it("rejects an unknown preset in a binding", () => {
    const res = validateProfile("p", withProviders([
      { api: "chat-b-ai", models: ["glm-5.3-flash"] }, // real preset is chat-b-ai-remote
    ]));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/unknown api preset 'chat-b-ai'/);
  });

  it("rejects models written as a scalar — the silent-drop case", () => {
    // coerceProviderBindings drops this whole binding, so validating the
    // COERCED list would see nothing wrong. This is why validation reads raw.
    const res = validateProfile("p", withProviders([
      { api: "chat-b-ai-remote", api_key: "k", models: "glm-5.3-flash" },
    ]));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/models must be a YAML list/);
  });

  it("rejects an empty models list", () => {
    const res = validateProfile("p", withProviders([
      { api: "chat-b-ai-remote", api_key: "k", models: [] },
    ]));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/at least one model id/);
  });

  it("D6a: a model bound to two providers is VALID — tried in group order (the D0 refusal is gone)", () => {
    const res = validateProfile("p", withProviders([
      { name: "one", api: "chat-b-ai-remote", api_key: "k1", models: ["glm-5.3-flash"] },
      { name: "two", api: "openrouter-remote", api_key: "k2", models: ["glm-5.3-flash"] },
    ]));
    expect(res.valid).toBe(true);
  });

  it("rejects lmstudio-local as a binding (its native API is unreachable via a route)", () => {
    const res = validateProfile("p", withProviders([
      { api: "lmstudio-local", models: ["local-model"] },
    ]));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/cannot use 'lmstudio-local'/);
  });

  it("rejects a generic-local binding without an explicit url", () => {
    const res = validateProfile("p", withProviders([
      { api: "generic-local", models: ["m"] },
    ]));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/requires an explicit 'url'/);
  });

  it("rejects a remote binding whose key env var is unset", () => {
    delete process.env.LLM_EXT_TEST_ABSENT_KEY;
    const res = validateProfile("p", withProviders([
      {
        api: "chat-b-ai-remote",
        api_key: "$LLM_EXT_TEST_ABSENT_KEY",
        models: ["glm-5.3-flash"],
      },
    ]));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/is not set/);
  });

  it("does NOT demand a key for a local binding", () => {
    const res = validateProfile("p", withProviders([
      { api: "ollama-local", url: "http://localhost:11434", models: ["qwen3:14b"] },
    ]));
    expect(res.errors).toEqual([]);
  });
});

// The example profile printed in
// skills/llm-externalizer-config/references/configuration-guide.md — a doc
// example that does not validate is worse than no example, because the reader
// copies it and blames their own YAML. The first draft used
// `mode: remote-ensemble` with a single free_models entry and would have been
// refused on sight.
// SCOPE: this checks the example VALIDATES, not that it ROUTES. Model selection
// runs upstream of routing and can still substitute a different model — see the
// "Known limitation" note in the guide. Green here is not a claim about
// behaviour at runtime.
describe("configuration-guide providers example validates", () => {
  let savedOr: string | undefined;
  let savedBai: string | undefined;
  beforeEach(() => {
    savedOr = process.env.LLM_EXT_DOC_OR_KEY;
    savedBai = process.env.LLM_EXT_DOC_BAI_KEY;
  });
  afterEach(() => {
    if (savedOr === undefined) delete process.env.LLM_EXT_DOC_OR_KEY;
    else process.env.LLM_EXT_DOC_OR_KEY = savedOr;
    if (savedBai === undefined) delete process.env.LLM_EXT_DOC_BAI_KEY;
    else process.env.LLM_EXT_DOC_BAI_KEY = savedBai;
  });

  it("the documented bai-and-openrouter profile is accepted verbatim", () => {
    process.env.LLM_EXT_DOC_OR_KEY = "or-key";
    process.env.LLM_EXT_DOC_BAI_KEY = "bai-key";
    const res = validateProfile("bai-and-openrouter", {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "$LLM_EXT_DOC_OR_KEY",
      model: "deepseek/deepseek-v4-flash:free",
      free_only: true,
      free_models: ["deepseek/deepseek-v4-flash:free"],
      providers: [
        {
          api: "chat-b-ai-remote",
          api_key: "$LLM_EXT_DOC_BAI_KEY",
          models: ["glm-5.3-flash"],
        },
      ],
      tool_models: { code_task: "glm-5.3-flash" },
    } as unknown as Profile);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("REJECTS the draft that shipped first (remote-ensemble + one free model)", () => {
    process.env.LLM_EXT_DOC_OR_KEY = "or-key";
    const res = validateProfile("bad", {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      api_key: "$LLM_EXT_DOC_OR_KEY",
      model: "deepseek/deepseek-v4-flash:free",
      second_model: "x:free",
      free_only: true,
      free_models: ["deepseek/deepseek-v4-flash:free"],
    } as unknown as Profile);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/needs at least 2 ensemble members/);
  });
});

// ── the boot exemption is ERROR-scoped, not PROFILE-scoped ───────────
// shouldBootDespiteInvalidActiveProfile DISCARDS the whole error list when this
// returns true. Keyed on "is this a placeholder profile?", one self-healing
// condition suppressed every unrelated rule: a YAML typo in `providers:` on a
// default profile booted silently, the binding was dropped, and its models went
// to the primary provider with the primary's key — reported to the user as
// "has not been benchmarked yet".
describe("isInvalidOnlyBecauseUnpopulated", () => {
  const freePlaceholder = {
    mode: "remote",
    api: "openrouter-remote",
    api_key: "direct-key",
    free_only: true,
    free_models: [],
    model: "PLACEHOLDER",
  } as unknown as Profile;

  it("permits the genuine unpopulated state (empty pool, nothing else wrong)", () => {
    expect(isInvalidOnlyBecauseUnpopulated("free", freePlaceholder)).toBe(true);
  });

  it("REFUSES when the SAME profile also has a malformed binding", () => {
    // The regression: before this, the empty pool excused the providers typo.
    const withTypo = {
      ...freePlaceholder,
      providers: [{ api: "chat-b-ai-remote", api_key: "k", models: "glm-5.3-flash" }],
    } as unknown as Profile;
    expect(isInvalidOnlyBecauseUnpopulated("free", withTypo)).toBe(false);
  });

  it("REFUSES a non-population error on a paid default, where population raises none of its own", () => {
    const paid = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "PLACEHOLDER",
      providers: [{ api: "not-a-preset", models: ["m"] }],
    } as unknown as Profile;
    expect(isInvalidOnlyBecauseUnpopulated("paid", paid)).toBe(false);
  });

  it("REFUSES a non-default profile name, populated or not", () => {
    expect(isInvalidOnlyBecauseUnpopulated("my-own-profile", freePlaceholder)).toBe(false);
  });
});

describe("validateProfile providers — wrong-typed optional fields", () => {
  const mk = (b: unknown) =>
    validateProfile("p", {
      mode: "remote",
      api: "openrouter-remote",
      model: "m",
      api_key: "direct-key",
      providers: [b],
    } as unknown as Profile);

  it("rejects a non-string url (silently dropped by the coercer otherwise)", () => {
    const res = mk({ api: "chat-b-ai-remote", api_key: "k", url: 8080, models: ["m"] });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/url must be a string/);
  });

  it("rejects a non-string api_key — it would resolve a DIFFERENT account", () => {
    const res = mk({ api: "chat-b-ai-remote", api_key: 12345, models: ["m"] });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/api_key must be a string/);
  });
});

// The joint guarantee, and the one that says the auth substitution did not
// re-open the hole: with the key ALSO unset — both self-healing conditions
// firing at once — an unrelated YAML error must still fail boot. Every other
// test here supplies a direct key, so none of them exercises this shape.
// PAIRED with config-default-settings.test.ts's boot-lock test — do not delete
// either as "redundant". A helper that returns true unconditionally PASSES the
// boot-lock test and FAILS the first test below: that asymmetry is what the
// pair buys. Dropping the needsAuthKey substitution is NOT the mirror image —
// it reddens tests in BOTH files. Seeing both red does not mean they are
// duplicates.
describe("isInvalidOnlyBecauseUnpopulated — both self-healing conditions at once", () => {
  it("still REFUSES a malformed binding when the auth env var is ALSO unset", () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const p = {
        mode: "remote",
        api: "openrouter-remote",
        api_key: "$OPENROUTER_API_KEY",
        free_only: true,
        free_models: [],
        model: "PLACEHOLDER",
        providers: [{ api: "chat-b-ai-remote", api_key: "k", models: "glm-5.3-flash" }],
      } as unknown as Profile;
      expect(isInvalidOnlyBecauseUnpopulated("free", p)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it("and PERMITS the same profile once the binding is well-formed", () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const p = {
        mode: "remote",
        api: "openrouter-remote",
        api_key: "$OPENROUTER_API_KEY",
        free_only: true,
        free_models: [],
        model: "PLACEHOLDER",
        providers: [{ api: "chat-b-ai-remote", api_key: "k", models: ["glm-5.3-flash"] }],
      } as unknown as Profile;
      expect(isInvalidOnlyBecauseUnpopulated("free", p)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });
});

// ── P1: dynamic profiles — names, schema, model chain, validation (TRDD-90DM5YHO) ──
// resolveModelChain/resolveModelForTool's dynamic-vs-static split, the new
// paid_models/ensemble_pins schema, free_only's route exemption, and the
// paid-benchmark daily cap. See the design report + addendum cited in the
// TRDD for the full spec; these tests pin only what P1 implements.

describe("isDynamicProfileName / DYNAMIC_PROFILE_NAMES / DEFAULT_PROFILE_NAME", () => {
  it("recognizes exactly the three built-in dynamic names", () => {
    expect(DYNAMIC_PROFILE_NAMES).toEqual(["free", "paid", "local"]);
    expect(isDynamicProfileName("free")).toBe(true);
    expect(isDynamicProfileName("paid")).toBe(true);
    expect(isDynamicProfileName("local")).toBe(true);
    expect(isDynamicProfileName("free-pool")).toBe(false);
    expect(isDynamicProfileName("my-own-profile")).toBe(false);
  });

  it("DEFAULT_PROFILE_NAME is the dynamic 'free' profile", () => {
    expect(DEFAULT_PROFILE_NAME).toBe("free");
    expect(isDynamicProfileName(DEFAULT_PROFILE_NAME)).toBe(true);
  });
});

// T-P1-1: resolveModelForTool on a DYNAMIC "free" profile returns the
// tool_models entry, not the head `model` — red on pre-phase HEAD because the
// unconditional `if (resolved.freeOnly) return resolved.model` short-circuit
// ran BEFORE tool_models was ever consulted, for every freeOnly profile
// including a dynamic one.
describe("T-P1-1 resolveModelForTool: dynamic free keeps its per-tool override", () => {
  it("returns the tool_models entry, not the head model", () => {
    const r = mkResolved({
      dynamic: true,
      freeOnly: true,
      model: "head/model:free",
      freeModels: ["head/model:free", "second/model:free"],
      toolModels: { code_task: "override/model:free" },
    });
    expect(resolveModelForTool(r, "code_task")).toBe("override/model:free");
  });

  it("still falls through to the head model when no override is set", () => {
    const r = mkResolved({
      dynamic: true,
      freeOnly: true,
      model: "head/model:free",
      freeModels: ["head/model:free"],
      toolModels: {},
    });
    expect(resolveModelForTool(r, "code_task")).toBe("head/model:free");
  });

  it("a STATIC free_only profile keeps the old short-circuit (unchanged)", () => {
    const r = mkResolved({
      dynamic: false,
      freeOnly: true,
      model: "static/head:free",
      freeModels: ["static/head:free"],
      toolModels: { code_task: "ignored/override:free" },
    });
    expect(resolveModelForTool(r, "code_task")).toBe("static/head:free");
  });
});

// T-P1-2: resolveModelChain — static yields exactly [head]; dynamic free
// yields head then the pool (excluding head), filtered by the validated set
// when non-empty. resolveModelChain is a brand-new symbol on pre-phase HEAD,
// so its "red" is a missing export, not a behavioural regression — T-P1-1
// above is the behavioural test for this same change.
describe("T-P1-2 resolveModelChain", () => {
  it("STATIC profile: exactly [head], no fallback pool", () => {
    const r = mkResolved({
      dynamic: false,
      model: "static/model",
      toolModels: {},
      freeModels: ["a:free", "b:free"],
    });
    expect(resolveModelChain(r, "code_task")).toEqual(["static/model"]);
  });

  it("DYNAMIC free: head then the free pool, excluding the head", () => {
    const r = mkResolved({
      dynamic: true,
      freeOnly: true,
      model: "head:free",
      freeModels: ["head:free", "second:free", "third:free"],
    });
    expect(resolveModelChain(r, "code_task")).toEqual([
      "head:free",
      "second:free",
      "third:free",
    ]);
  });

  it("DYNAMIC free: an empty validated set means no filtering", () => {
    const r = mkResolved({
      dynamic: true,
      freeOnly: true,
      model: "head:free",
      freeModels: ["head:free", "second:free"],
    });
    expect(resolveModelChain(r, "code_task", new Set())).toEqual([
      "head:free",
      "second:free",
    ]);
  });

  it("DYNAMIC free: a non-empty validated set filters the fallback pool", () => {
    const r = mkResolved({
      dynamic: true,
      freeOnly: true,
      model: "head:free",
      freeModels: ["head:free", "validated:free", "unvalidated:free"],
    });
    expect(
      resolveModelChain(r, "code_task", new Set(["head:free", "validated:free"])),
    ).toEqual(["head:free", "validated:free"]);
  });

  it("DYNAMIC paid: head then paidModels, excluding the head", () => {
    const r = mkResolved({
      dynamic: true,
      freeOnly: false,
      model: "head/paid-model",
      paidModels: ["head/paid-model", "second/paid-model"],
    });
    expect(resolveModelChain(r, "code_task")).toEqual([
      "head/paid-model",
      "second/paid-model",
    ]);
  });

  it("a per-tool override becomes the head of the dynamic chain", () => {
    const r = mkResolved({
      dynamic: true,
      freeOnly: true,
      model: "default/head:free",
      toolModels: { code_task: "picked/head:free" },
      freeModels: ["default/head:free", "picked/head:free", "third:free"],
    });
    expect(resolveModelChain(r, "code_task")).toEqual([
      "picked/head:free",
      "default/head:free",
      "third:free",
    ]);
  });
});

// T-P1-3 / T-P1-4: free_only's route exemption (addendum item 5 + B). A
// route-served id with no ':free' suffix (chat.b.ai's ids carry none) is
// accepted in free_models IFF its OWN providers[] route is non-billable —
// red today because the old rule rejected every non-':free' id outright.
describe("T-P1-3 / T-P1-4 free_only route exemption (addendum items 5 and B)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = saved;
  });

  it("T-P1-3: accepts glm-5.3-flash served by a chat-b-ai-remote route", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "deepseek/deepseek-v4-flash:free",
      free_only: true,
      free_models: ["deepseek/deepseek-v4-flash:free", "glm-5.3-flash"],
      providers: [{ api: "chat-b-ai-remote", models: ["glm-5.3-flash"] }],
    };
    const res = validateProfile("free", p);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("T-P1-4: rejects the same shape once the route's url is redirected off b.ai", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "deepseek/deepseek-v4-flash:free",
      free_only: true,
      free_models: ["deepseek/deepseek-v4-flash:free", "glm-5.3-flash"],
      providers: [
        {
          api: "chat-b-ai-remote",
          models: ["glm-5.3-flash"],
          url: "https://api.openai.com",
        },
      ],
    };
    const res = validateProfile("free", p);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/forbids non-':free' models/);
    expect(res.errors.join(" ")).toContain("glm-5.3-flash");
  });

  it("still rejects a non-':free' id with no route at all", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "deepseek/deepseek-v4-flash:free",
      free_only: true,
      free_models: ["deepseek/deepseek-v4-flash:free", "unrouted-model"],
    };
    const res = validateProfile("free", p);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toContain("unrouted-model");
  });
});

// T-P1-6: Settings.paid_benchmark_daily_cap_usd validation + paidDailyCapUsd().
describe("T-P1-6 paid_benchmark_daily_cap_usd", () => {
  const validProfile: Profile = {
    mode: "remote",
    api: "openrouter-remote",
    api_key: "direct-key",
    model: "x/y",
  };
  const mkSettings = (cap: unknown): Settings =>
    ({
      active: "p",
      profiles: { p: validProfile },
      paid_benchmark_daily_cap_usd: cap,
    }) as unknown as Settings;

  it("rejects -1", () => {
    const res = validateSettings(mkSettings(-1));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toContain("paid_benchmark_daily_cap_usd");
  });

  it("rejects NaN", () => {
    const res = validateSettings(mkSettings(NaN));
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toContain("paid_benchmark_daily_cap_usd");
  });

  it("accepts 0", () => {
    expect(validateSettings(mkSettings(0)).valid).toBe(true);
  });

  it("accepts 0.5", () => {
    expect(validateSettings(mkSettings(0.5)).valid).toBe(true);
  });

  it("accepts an absent cap (no field at all)", () => {
    const s: Settings = { active: "p", profiles: { p: validProfile } };
    expect(validateSettings(s).valid).toBe(true);
  });

  it("paidDailyCapUsd defaults to DEFAULT_PAID_DAILY_CAP_USD (0.5) when absent/invalid", () => {
    expect(DEFAULT_PAID_DAILY_CAP_USD).toBe(0.5);
    expect(paidDailyCapUsd(undefined)).toBe(0.5);
    expect(paidDailyCapUsd({ active: "p", profiles: {} } as Settings)).toBe(0.5);
    expect(paidDailyCapUsd(mkSettings(-1))).toBe(0.5);
    expect(paidDailyCapUsd(mkSettings(NaN))).toBe(0.5);
  });

  it("paidDailyCapUsd returns the configured value when valid", () => {
    expect(paidDailyCapUsd(mkSettings(0))).toBe(0);
    expect(paidDailyCapUsd(mkSettings(1.25))).toBe(1.25);
  });
});

// D5 (TRDD-90DM5YHO): `ensemble_pins` is removed outright — E-D2 refuses it on
// ANY profile (it never had a runtime reader). The replacement is
// `ensemble: {reserved: [...]}` (E-E1..E-E6), covered in its own describe below.
describe("E-D2 ensemble_pins refusal (D5)", () => {
  it("a dynamic profile carrying ensemble_pins is refused with the removal notice", () => {
    const p: Profile = {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "a/model",
      second_model: "b/model",
      ensemble_pins: { "0": "a/model" },
    } as unknown as Profile;
    const res = validateProfile("free", p);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/'ensemble_pins' was removed in 14\.1\.0/);
    expect(res.errors.join(" ")).toMatch(/ensemble: \{reserved:/);
  });

  it("a static profile carrying ensemble_pins is refused too (static profiles are never migrated)", () => {
    const p: Profile = {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "a/model",
      second_model: "b/model",
      ensemble_pins: { "3": "a/model" },
    } as unknown as Profile;
    const res = validateProfile("my-profile", p);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/'ensemble_pins' was removed in 14\.1\.0/);
  });
});

// D5: `ensemble.reserved` validation (E-E1..E-E6).
describe("E-E1..E-E6 ensemble.reserved validation (D5)", () => {
  const base: Profile = {
    mode: "remote-ensemble",
    api: "openrouter-remote",
    api_key: "direct-key",
    model: "a/model",
    second_model: "b/model",
  };

  it("accepts a reserved slot naming a providers[] group that serves the model", () => {
    const res = validateProfile("paid", {
      ...base,
      providers: [{ name: "bai", api: "chat-b-ai-remote", api_key: "direct-bai-key", models: ["glm-5.3-flash"] }],
      ensemble: { reserved: [{ provider: "bai", model: "glm-5.3-flash" }] },
    });
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("E-E1: a non-map ensemble, or an unknown key inside it, is refused", () => {
    const res = validateProfile("paid", { ...base, ensemble: "reserved" } as unknown as Profile);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/ensemble must be a map with 'reserved'/);
    const res2 = validateProfile("paid", {
      ...base,
      ensemble: { reserved: [], typo: true },
    } as unknown as Profile);
    expect(res2.valid).toBe(false);
    expect(res2.errors.join(" ")).toMatch(/ensemble must be a map with 'reserved'/);
  });

  it("E-E2: more than 2 reserved members is refused", () => {
    const res = validateProfile("paid", {
      ...base,
      ensemble: { reserved: [{ model: "a/model" }, { model: "b/model" }, { model: "c/model" }] },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/ensemble\.reserved holds at most 2 members/);
  });

  it("E-E3: an entry without a non-empty string model is refused", () => {
    const res = validateProfile("paid", {
      ...base,
      ensemble: { reserved: [{ provider: "bai" }] },
    } as unknown as Profile);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/ensemble\.reserved\[0\]\.model must be a model id/);
  });

  it("E-E4: a provider that names no group of this profile is refused", () => {
    const res = validateProfile("paid", {
      ...base,
      ensemble: { reserved: [{ provider: "nope", model: "a/model" }] },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/provider 'nope' is not a provider group of this profile/);
  });

  it("E-E5: a named group that does not serve the model is refused", () => {
    const res = validateProfile("paid", {
      ...base,
      providers: [{ name: "bai", api: "chat-b-ai-remote", api_key: "direct-bai-key", models: ["glm-5.3-flash"] }],
      ensemble: { reserved: [{ provider: "bai", model: "other/model" }] },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/provider 'bai' does not serve 'other\/model'/);
  });

  it("E-E6: a duplicate (provider, model) pair is refused", () => {
    const res = validateProfile("paid", {
      ...base,
      providers: [{ name: "bai", api: "chat-b-ai-remote", api_key: "direct-bai-key", models: ["glm-5.3-flash"] }],
      ensemble: {
        reserved: [
          { provider: "bai", model: "glm-5.3-flash" },
          { provider: "bai", model: "glm-5.3-flash" },
        ],
      },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/duplicates an earlier ensemble\.reserved entry/);
  });

  it("E-E6 free_only arm: a reserved slot reaching a billable group with a non-':free' id is refused", () => {
    const res = validateProfile("free", {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "a/model",
      free_only: true,
      free_models: ["a/model:free", "b/model:free"],
      ensemble: { reserved: [{ model: "a/paid-model" }] },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/free_only forbids non-':free' models/);
  });

  it("E-S1: ensemble is refused on a static profile", () => {
    const res = validateProfile("my-mix", {
      ...base,
      ensemble: { reserved: [{ model: "a/model" }] },
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/'ensemble' only applies to free\/paid\/local/);
  });
});

// T-P1-8: paid_models must never carry a ':free' id (that pool is free_models).
describe("T-P1-8 paid_models rejects ':free' ids", () => {
  it("rejects a paid_models entry ending in ':free'", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "a/paid-model",
      paid_models: ["a/paid-model", "sneaky/model:free"],
    };
    const res = validateProfile("paid", p);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/paid_models must not contain ':free' ids/);
    expect(res.errors.join(" ")).toContain("sneaky/model:free");
  });

  it("accepts a clean paid_models pool", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "a/paid-model",
      paid_models: ["a/paid-model", "b/paid-model"],
    };
    const res = validateProfile("paid", p);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("rejects a non-string / empty-string entry", () => {
    const p = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "direct-key",
      model: "a/paid-model",
      paid_models: ["a/paid-model", ""],
    } as unknown as Profile;
    const res = validateProfile("paid", p);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/paid_models entries must be non-empty/);
  });
});

// resolveProfile: dynamic + paidModels are populated correctly.
describe("resolveProfile populates dynamic + paidModels (P1)", () => {
  it("marks a profile named 'free' or 'paid' as dynamic; anything else static", () => {
    const p: Profile = { mode: "remote", api: "openrouter-remote", api_key: "k", model: "x" };
    expect(resolveProfile("free", p).dynamic).toBe(true);
    expect(resolveProfile("paid", p).dynamic).toBe(true);
    expect(resolveProfile("my-own-profile", p).dynamic).toBe(false);
  });

  it("carries paid_models into paidModels (default [])", () => {
    const withPool: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "k",
      model: "x",
      paid_models: ["x", "y"],
    };
    expect(resolveProfile("paid", withPool).paidModels).toEqual(["x", "y"]);
    const withoutPool: Profile = { mode: "remote", api: "openrouter-remote", api_key: "k", model: "x" };
    expect(resolveProfile("paid", withoutPool).paidModels).toEqual([]);
  });
});

// USER 2026-09-18 "one ceiling, <=" (TRDD d3a-price-ceiling): withinPriceCeiling
// is the single predicate every ensemble price gate now calls (default-profiles.ts,
// benchmark/pick.ts) instead of re-deriving the inequality (some summed both
// components, some compared with strict `<`). These are the four boundary
// cases the spec names explicitly.
describe("withinPriceCeiling — the one price gate every comparison site shares", () => {
  it("exactly at the ceiling on both components is admitted (<=, not <)", () => {
    expect(withinPriceCeiling({ inputDollarsPerMillion: 1.3, outputDollarsPerMillion: 1.3 }, 1.3)).toBe(true);
  });

  it("$1.31 on either component is rejected, even when the other is $0", () => {
    expect(withinPriceCeiling({ inputDollarsPerMillion: 1.31, outputDollarsPerMillion: 0 }, 1.3)).toBe(false);
    expect(withinPriceCeiling({ inputDollarsPerMillion: 0, outputDollarsPerMillion: 1.31 }, 1.3)).toBe(false);
  });

  it("the old flip-flop model (in $0.50 / out $0.95, sum $1.45) is now KEPT — each component is under the ceiling even though the SUM is not", () => {
    expect(withinPriceCeiling({ inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.95 }, 1.3)).toBe(true);
  });

  it("a custom $2.00 ceiling admits a $1.80/$1.80 model — proves no hidden $1.3 default remains", () => {
    expect(withinPriceCeiling({ inputDollarsPerMillion: 1.8, outputDollarsPerMillion: 1.8 }, 2.0)).toBe(true);
    // ...and still rejects it against the built-in default, so the ceiling
    // argument is genuinely what decides the outcome, not a side effect.
    expect(withinPriceCeiling({ inputDollarsPerMillion: 1.8, outputDollarsPerMillion: 1.8 }, DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M)).toBe(false);
  });

  it("getEnsemblePriceCeiling resolves the paid profile's selection override, falling back to the 1.3 default (D0, TRDD-AL8GIZYA)", () => {
    expect(getEnsemblePriceCeiling(undefined)).toBe(1.3);
    expect(
      getEnsemblePriceCeiling({
        profiles: { paid: { selection: { price_ceiling_usd_per_million: 2.0 } } },
      } as unknown as Settings),
    ).toBe(2.0);
  });
});

// ── D0 (TRDD-AL8GIZYA): the ownership boundary (E-D1) + selection (E-L1/E-S1) ──

describe("D0: validateProfile's closed-key check (E-D1)", () => {
  const dynamicBase: Profile = {
    mode: "remote",
    api: "openrouter-remote",
    model: "vendor/one",
    api_key: "sk-test-fake-key",
  };

  it("refuses a misspelt key on a dynamic profile ('free') with a message naming the generated/user-owned sets", () => {
    const p = { ...dynamicBase, ensembel: { reserved: [] } } as unknown as Profile;
    const res = validateProfile("free", p);
    expect(res.valid).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("Profile 'free': 'ensembel' is not allowed in a generated profile");
    expect(res.errors[0]).toContain("llm-ext writes mode, api, url, api_key");
    expect(res.errors[0]).toContain("you may add selection, high_quality_model");
  });

  it("a static profile still IGNORES the same unknown key, exactly as before D0", () => {
    const p = { ...dynamicBase, ensembel: { reserved: [] } } as unknown as Profile;
    const res = validateProfile("my-own-profile", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("accepts the same profile on 'free' once the misspelling is fixed away entirely — the GENERATED keys alone are enough", () => {
    const res = validateProfile("free", { ...dynamicBase });
    expect(res.valid).toBe(true);
  });

  it("accepts a dynamic profile's own user-owned 'selection' key ('paid' only) — E-D1 does not refuse what E-L1 already governs", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/one",
      api_key: "sk-test-fake-key",
      selection: { price_ceiling_usd_per_million: 0.9 },
    };
    const res = validateProfile("paid", p);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

// D0 fix-up 2 (TRDD-AL8GIZYA): reservedDynamicProfileNameError used to
// hardcode 'providers'/'ensemble'/'selection'/'high_quality_model' for
// EVERY profile, which is false in D0 -- 'ensemble' is refused everywhere
// until a later slice, and 'providers' is user-owned only on 'paid'. This
// walks the text the function actually returns and proves, via a real
// validateProfile call, that every key it names is one E-D1 truly accepts
// on that profile -- so the wording can never silently drift from the
// check again.
describe("D0 fix-up 2: reservedDynamicProfileNameError names only keys validateProfile accepts", () => {
  const dynamicBase: Record<string, Profile> = {
    free: { mode: "remote", api: "openrouter-remote", model: "vendor/one", api_key: "sk-test-fake-key" },
    paid: { mode: "remote", api: "openrouter-remote", model: "vendor/one", api_key: "sk-test-fake-key" },
    local: { mode: "local", api: "openai-compatible", url: "http://localhost:1234", model: "vendor/one" },
  };
  const sampleValueFor: Record<string, unknown> = {
    selection: {},
    high_quality_model: "vendor/high-quality-model",
    providers: [],
    ensemble: {},
    request_options: { default: { max_output_tokens: 512 } },
  };

  for (const name of DYNAMIC_PROFILE_NAMES) {
    it(`'${name}': every key named in the parenthetical is accepted there by validateProfile (E-D1)`, () => {
      const msg = reservedDynamicProfileNameError([name]);
      const match = msg.match(new RegExp(`'${name}' \\(([^)]*)\\)`));
      expect(match).not.toBeNull();
      const keys = match![1].split("/").map((k) => k.replace(/'/g, ""));
      expect(keys.length).toBeGreaterThan(0);
      // REVIEW mitigation (D0 fix-up 2): the two checks above only prove the
      // TEXT is internally consistent with validateProfile -- they cannot
      // catch a message-building bug that silently DROPS a key the table
      // actually grants (e.g. an off-by-one in the .map/.join). Compare
      // against DYNAMIC_USER_OWNED_KEYS[name] directly, the independent
      // source of truth, so a drop or an extra key both fail loudly.
      expect([...keys].sort()).toEqual([...DYNAMIC_USER_OWNED_KEYS[name]].sort());
      for (const key of keys) {
        const p = { ...dynamicBase[name], [key]: sampleValueFor[key] } as Profile;
        const res = validateProfile(name, p);
        expect(res.errors.some((e) => e.includes(`'${key}' is not allowed in a generated profile`))).toBe(
          false,
        );
      }
    });
  }

  it("D5: 'providers' is user-owned on ALL three dynamic profiles, and 'ensemble' on all three too", () => {
    expect(reservedDynamicProfileNameError(["paid"])).toContain("'providers'");
    expect(reservedDynamicProfileNameError(["local"])).toContain("'providers'");
    expect(reservedDynamicProfileNameError(["free"])).toContain("'providers'");
    for (const n of ["free", "paid", "local"] as const) {
      expect(reservedDynamicProfileNameError([n])).toContain("'ensemble'");
    }
  });
});

describe("D0: selection validation (E-L1, E-S1)", () => {
  it("E-L1: a non-positive ceiling on 'paid' is refused", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/one",
      api_key: "sk-test-fake-key",
      selection: { price_ceiling_usd_per_million: 0 },
    };
    const res = validateProfile("paid", p);
    expect(res.valid).toBe(false);
    expect(res.errors).toEqual([
      "Profile 'paid': selection.price_ceiling_usd_per_million must be a number > 0 (USD per million tokens, input and output each)",
    ]);
  });

  it("E-L1: a negative ceiling is refused too, and a positive one is accepted", () => {
    const negative: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/one",
      api_key: "sk-test-fake-key",
      selection: { price_ceiling_usd_per_million: -1 },
    };
    expect(validateProfile("paid", negative).valid).toBe(false);
    const positive: Profile = { ...negative, selection: { price_ceiling_usd_per_million: 0.5 } };
    expect(validateProfile("paid", positive).valid).toBe(true);
  });

  it("E-L1: an unknown key inside selection is refused, even on 'free'/'local' where NO key is recognized yet", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/one:free",
      api_key: "sk-test-fake-key",
      free_only: true,
      free_models: ["vendor/one:free"],
      selection: { price_ceiling_usd_per_million: 0.5 },
    };
    const res = validateProfile("free", p);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain(
      "Profile 'free': selection.price_ceiling_usd_per_million must be a number > 0 (USD per million tokens, input and output each)",
    );
  });

  it("E-S1: 'selection' on a static profile is refused, naming the static ensemble fields", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/one",
      api_key: "sk-test-fake-key",
      selection: { price_ceiling_usd_per_million: 0.5 },
    };
    const res = validateProfile("my-static-profile", p);
    expect(res.valid).toBe(false);
    expect(res.errors).toEqual([
      "Profile 'my-static-profile': 'selection' only applies to free/paid/local. Your profile's ensemble is model/second_model/third_model, and nothing in it is auto-picked.",
    ]);
  });

  it("validateUserOwnedKeys reports the SAME selection defect, in isolation from any GENERATED-key problem", () => {
    // A profile that is ALSO structurally broken (no api_key at all) — the
    // regeneration gate (dynamic-maintainer.ts) must see ONLY the
    // user-owned-key defect here, never the generated one, or it would
    // treat a user's selection typo as an excuse to regenerate their data.
    const broken: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/one",
      selection: { price_ceiling_usd_per_million: -5 },
    };
    expect(validateProfile("paid", broken).valid).toBe(false); // GENERATED-key problem too
    const userOnly = validateUserOwnedKeys("paid", broken);
    expect(userOnly.valid).toBe(false);
    expect(userOnly.errors).toEqual([
      "Profile 'paid': selection.price_ceiling_usd_per_million must be a number > 0 (USD per million tokens, input and output each)",
    ]);
  });

  it("validateUserOwnedKeys passes a profile whose ONLY problem is a GENERATED-key defect", () => {
    const generatedOnlyBroken = { mode: "remote", api: "openrouter-remote" } as Profile; // missing `model`
    expect(validateProfile("paid", generatedOnlyBroken).valid).toBe(false);
    expect(validateUserOwnedKeys("paid", generatedOnlyBroken)).toEqual({ valid: true, errors: [] });
  });
});

// ── D3b (TRDD-FDI9NYAS): manualModels provenance ───────────────────────
// "Only auto-picked models" are gated by the benchmark-verdict / price
// checks (USER IRON RULE clarification, TRDD-DS6OM3KX); a STATIC profile's
// models are ALL manual, "no benchmarks or updates" (USER spec 3.1). This
// is what ResolvedProfile.manualModels / ProviderDeps.isManualModel read.
describe("resolveProfile — manualModels provenance set (D3b)", () => {
  it("a STATIC profile's manualModels is exactly its chainModelIds set", () => {
    const p: Profile = {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      api_key: "sk-test-fake-key",
      model: "vendor/one",
      second_model: "vendor/two",
      third_model: "vendor/three",
    };
    const r = resolveProfile("my-static-profile", p);
    expect([...r.manualModels!].sort()).toEqual(
      ["vendor/one", "vendor/two", "vendor/three"].sort(),
    );
  });

  it("a DYNAMIC profile ('free'/'paid') has an EMPTY manualModels under D3b — nothing manual yet", () => {
    const p: Profile = {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      api_key: "sk-test-fake-key",
      model: "vendor/one",
      second_model: "vendor/two",
    };
    const r = resolveProfile("paid", p);
    expect(r.manualModels!.size).toBe(0);
  });
});

// ── D3b: second_model / third_model honored in EVERY mode on a static
// profile ("static list Allow second/third_model in every mode", USER
// answer 18:15). Before this, validateProfile refused second_model in
// 'local'/'remote' mode and third_model outside 'remote-ensemble' — a
// restriction that made sense only for the DYNAMIC free/paid profiles,
// whose second/third are machine-written specifically for remote-ensemble.
describe("validateProfile — static second_model/third_model in every mode (D3b)", () => {
  it("a STATIC profile in mode 'remote' (single-model) may set second_model AND third_model", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "sk-test-fake-key",
      model: "vendor/one",
      second_model: "vendor/two",
      third_model: "vendor/three",
    };
    const res = validateProfile("my-static-profile", p);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("a STATIC profile in mode 'local' may set second_model — the manual fallback list", () => {
    const p: Profile = {
      // ollama-local, not lmstudio-local: the LM Studio NATIVE API has its
      // own real single-model protocol limit (unaffected by this change),
      // which would otherwise refuse second_model for an unrelated reason.
      mode: "local",
      api: "ollama-local",
      model: "vendor/one",
      second_model: "vendor/two",
    };
    const res = validateProfile("my-static-profile", p);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("a DYNAMIC profile ('paid') in mode 'remote' is STILL refused for second_model — the restriction is provenance-scoped, not lifted globally", () => {
    const p: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      api_key: "sk-test-fake-key",
      model: "vendor/one",
      second_model: "vendor/two",
    };
    const res = validateProfile("paid", p);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain(
      "Mode 'remote' does not support 'second_model'. Use 'remote-ensemble'",
    );
  });
});

// D6a-review F2 (TRDD-90DM5YHO D4): D6a deleted the cross-group duplicate
// refusal, so a free_only profile may now legally carry a BILLABLE group and
// the failure moved to send time (fail-closed, correct, but late). A
// boot-time stderr WARNING must name the billable group — advisory, never a
// validation error.
describe("validateProfile — free_only billable-group boot warning (D6a review F2)", () => {
  it("a free_only profile with a billable providers[] group validates cleanly but warns naming the group", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const p: Profile = {
        mode: "remote",
        api: "openrouter-remote",
        api_key: "sk-test-fake-key",
        free_only: true,
        free_models: ["vendor/one:free"],
        providers: [
          {
            name: "paid-acct",
            api: "openrouter-remote",
            api_key: "sk-test-fake-key",
            models: ["vendor/paid-one"],
          },
        ],
      } as Profile;
      const res = validateProfile("my-free-profile", p);
      expect(res.valid).toBe(true); // advisory — the send-time chokepoint enforces
      expect(res.errors).toEqual([]);
      const text = lines.join("");
      expect(text).toContain("free_only but its group 'paid-acct'");
      expect(text).toContain("can bill");
    } finally {
      spy.mockRestore();
    }
  });

  it("a free_only profile with only non-billable groups warns about nothing", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const p: Profile = {
        mode: "remote",
        api: "openrouter-remote",
        api_key: "sk-test-fake-key",
        free_only: true,
        free_models: ["vendor/one:free"],
        providers: [
          {
            name: "bai",
            api: "chat-b-ai-remote",
            api_key: "sk-test-fake-key",
            models: ["glm-5.3-flash"],
          },
        ],
      } as Profile;
      const res = validateProfile("my-free-profile", p);
      expect(res.valid).toBe(true);
      expect(lines.join("")).not.toContain("can bill");
    } finally {
      spy.mockRestore();
    }
  });
});
