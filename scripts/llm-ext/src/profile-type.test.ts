// PT-01 (TRDD-QRF04JVJ): the `profile-type` field, the per-type field table,
// BUILTIN_PROFILE_NAMES and the load errors E81d / E81g / E113. Pure functions
// over plain objects: nothing here touches disk or the network.

import { describe, it, expect } from "vitest";

import {
  BUILTIN_PROFILE_NAMES,
  DYNAMIC_GENERATED_KEYS,
  DYNAMIC_PROFILE_NAMES,
  PROFILE_TYPES,
  PROFILE_TYPE_FIELDS,
  builtinProfileType,
  inferProfileType,
  isPaidGatedProfileType,
  resolveProfile,
  settingsLevelErrors,
  shouldForceFreeMode,
  unpopulatedFreeProfile,
  unpopulatedLocalProfile,
  unpopulatedPaidProfile,
  validateProfile,
  validateSettings,
  type Profile,
  type Settings,
} from "./config.js";
import { isShippedPlaceholder } from "./benchmark/pick.js";

// A literal api_key keeps these tests independent of $OPENROUTER_API_KEY in the environment.
const withType = (p: Profile, type: unknown): Profile =>
  ({ ...p, ...(p.mode === "local" ? {} : { api_key: "test-key" }), "profile-type": type } as Profile);

const staticRemote = (): Profile => ({
  mode: "remote",
  api: "openrouter-remote",
  model: "vendor/some-model",
  api_key: "test-key",
});

describe("profile-type enum (E81d)", () => {
  it("has exactly the five types", () => {
    expect([...PROFILE_TYPES]).toEqual(["local", "free", "paid", "scouting", "classifier"]);
  });

  it("accepts each of the five values on a custom profile", () => {
    for (const t of ["local", "free", "paid", "scouting", "classifier"]) {
      const r = validateProfile("my-profile", withType(staticRemote(), t));
      // PT-06: the field-issue errors mention "profile-type" in their fix text; E81d errors quote the rejected value, so match that form.
      expect(r.errors.filter((e) => e.includes("profile-type '"))).toEqual([]);
    }
  });

  it("rejects a value outside the five, naming the field and the allowed values", () => {
    const r = validateProfile("my-profile", withType(staticRemote(), "turbo"));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/profile-type .turbo. is not one of local, free, paid, scouting, classifier/);
  });

  it("rejects a non-string value", () => {
    const r = validateProfile("my-profile", withType(staticRemote(), 3));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/profile-type/);
  });
});

describe("built-in names have a fixed type (E113)", () => {
  it("lists five built-ins beside the unchanged three dynamic names", () => {
    expect([...BUILTIN_PROFILE_NAMES].sort()).toEqual(["free", "local", "or-jev", "paid", "scouting"]);
    expect([...DYNAMIC_PROFILE_NAMES]).toEqual(["free", "paid", "local"]);
  });

  it("maps each built-in name to its type", () => {
    expect(builtinProfileType("free")).toBe("free");
    expect(builtinProfileType("paid")).toBe("paid");
    expect(builtinProfileType("local")).toBe("local");
    expect(builtinProfileType("scouting")).toBe("scouting");
    expect(builtinProfileType("or-jev")).toBe("classifier");
    expect(builtinProfileType("my-profile")).toBeUndefined();
    expect(builtinProfileType("constructor")).toBeUndefined();
  });

  it("rejects scouting carrying profile-type classifier", () => {
    const r = validateProfile("scouting", withType(staticRemote(), "classifier"));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/built-in profile .scouting. has the fixed profile-type .scouting., not .classifier./);
  });

  it("rejects a dynamic section carrying another type, and accepts its own", () => {
    const bad = validateProfile("free", withType(unpopulatedFreeProfile(), "paid"));
    expect(bad.errors.join("\n")).toMatch(/fixed profile-type .free./);
    const good = validateProfile("free", withType({ ...unpopulatedFreeProfile(), free_models: ["a/b:free"] }, "free"));
    expect(good.errors).toEqual([]);
  });

  it("lets a custom name carry any of the five types", () => {
    expect(validateProfile("mine", withType(staticRemote(), "scouting")).errors).toEqual([]);
  });
});

describe("missing profile-type after migration (E81g)", () => {
  const settings = (migrated: boolean | undefined): Settings => ({
    active: "mine",
    profiles: { mine: staticRemote() },
    allow_paid_models: false,
    ...(migrated === undefined ? {} : { profileTypesMigrated: migrated }),
  });

  it("is not an error before the migration has run", () => {
    expect(validateSettings(settings(undefined)).errors).toEqual([]);
    expect(validateSettings(settings(false)).errors).toEqual([]);
  });

  it("fails after the migration, naming the field and the hand edit", () => {
    const r = validateSettings(settings(true));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/Profile 'mine' has no profile-type\. Add the line 'profile-type: <type>' to it by hand \(one of [a-z, ]+\)\./);
  });

  it("is reported for a profile that is not the active one, and by settingsLevelErrors", () => {
    const s: Settings = { ...settings(true), active: "free", profiles: { free: withType(unpopulatedFreeProfile(), "free"), mine: staticRemote() } };
    expect(validateSettings(s).errors.join("\n")).toMatch(/Profile .mine. has no profile-type/);
    expect(settingsLevelErrors(s).join("\n")).toMatch(/Profile .mine. has no profile-type/);
  });

  it("reports an invalid value on a profile that is not the active one", () => {
    const s: Settings = { ...settings(undefined), active: "free", profiles: { free: withType(unpopulatedFreeProfile(), "free"), mine: withType(staticRemote(), "x") } };
    expect(validateSettings(s).errors.join("\n")).toMatch(/Profile .mine.: profile-type .x. is not one of/);
  });
});

describe("per-type field table", () => {
  it("names the template and the type-only fields of each type (plan section 8)", () => {
    expect(PROFILE_TYPE_FIELDS.local.template).toBe("local");
    expect(PROFILE_TYPE_FIELDS.classifier.template).toBe("or-jev");
    expect(PROFILE_TYPE_FIELDS.local.own).toEqual(["api_token", "detected_providers"]);
    expect(PROFILE_TYPE_FIELDS.free.own).toEqual(["free_only"]);
    expect(PROFILE_TYPE_FIELDS.paid.own).toEqual(["selection", "ensemble"]);
    expect(PROFILE_TYPE_FIELDS.classifier.own).toEqual([
      "endpoint", "max_requests_per_call", "concurrency", "timeout_ms", "max_attempts",
      "context_tokens", "provider", "session_id", "user", "trace",
    ]);
  });

  it("covers every key llm-ext generates in a dynamic section", () => {
    for (const name of DYNAMIC_PROFILE_NAMES) {
      const type = builtinProfileType(name)!;
      const known = new Set<string>([...PROFILE_TYPE_FIELDS[type].own, ...PROFILE_TYPE_FIELDS[type].shared]);
      for (const key of DYNAMIC_GENERATED_KEYS[name]) expect(known.has(key), `${name}.${key}`).toBe(true);
    }
  });

  it("has no field owned by two types", () => {
    const seen = new Map<string, string>();
    for (const t of PROFILE_TYPES) {
      for (const f of PROFILE_TYPE_FIELDS[t].own) {
        expect(seen.get(f), `${f} owned by ${seen.get(f)} and ${t}`).toBeUndefined();
        seen.set(f, t);
      }
    }
  });
});

describe("spend rules (D36)", () => {
  it("gates paid and scouting on allow_paid_models; free, local and classifier have no such gate", () => {
    expect(isPaidGatedProfileType("paid")).toBe(true);
    expect(isPaidGatedProfileType("scouting")).toBe(true);
    expect(isPaidGatedProfileType("free")).toBe(false);
    expect(isPaidGatedProfileType("local")).toBe(false);
    expect(isPaidGatedProfileType("classifier")).toBe(false);
    expect(PROFILE_TYPE_FIELDS.free.spend).toBe("never-bills");
    expect(PROFILE_TYPE_FIELDS.local.spend).toBe("never-bills");
    expect(PROFILE_TYPE_FIELDS.classifier.spend).toBe("ungated");
  });
});


describe("spend gate wiring (D36)", () => {
  it("a paid-type custom remote profile is still forced free while allow_paid_models is false", () => {
    const type = inferProfileType("mine", staticRemote());
    expect(shouldForceFreeMode(false, "remote", type)).toBe(true);
    expect(shouldForceFreeMode(true, "remote", type)).toBe(false);
  });
  it("a scouting-type profile is gated like paid", () => {
    expect(shouldForceFreeMode(false, "remote", "scouting")).toBe(true);
    expect(shouldForceFreeMode(true, "remote", "scouting")).toBe(false);
  });
  it("a free-type remote profile never bills, whatever the flag says", () => {
    expect(shouldForceFreeMode(false, "remote", "free")).toBe(true);
    expect(shouldForceFreeMode(true, "remote", "free")).toBe(true);
  });
  it("a local profile is never forced", () => {
    expect(shouldForceFreeMode(false, "local", "local")).toBe(false);
  });
  // PF-01 (D2): a classifier with a chat `mode` is a relabelled chat profile and stays gated; a real one has no mode.
  it("a classifier-type profile that still carries a chat mode stays gated like paid", () => {
    expect(shouldForceFreeMode(false, "remote", "classifier")).toBe(true);
    expect(shouldForceFreeMode(true, "remote", "classifier")).toBe(false);
  });
  it("one added `profile-type: classifier` line does not let a paid profile bypass the gate", () => {
    const relabelled = withType(staticRemote(), "classifier");
    const resolved = resolveProfile("mine", relabelled);
    expect(resolved.profileType).toBe("classifier");
    expect(shouldForceFreeMode(false, resolved.mode, resolved.profileType)).toBe(true);
  });
  it("resolveProfile carries the inferred type for the gate", () => {
    expect(resolveProfile("mine", staticRemote()).profileType).toBe("paid");
  });
  it("a bogus profile-type fails with the load error instead of reaching the gate", () => {
    const bogus = withType(staticRemote(), "bogus");
    expect(() => inferProfileType("mine", bogus)).toThrow(/profile-type 'bogus' is not one of/);
    expect(() => resolveProfile("mine", bogus)).toThrow(/profile-type 'bogus' is not one of/);
  });
});

describe("inference before the migration (plan section 8)", () => {
  it("uses the explicit field when present", () => {
    expect(inferProfileType("mine", withType(staticRemote(), "classifier"))).toBe("classifier");
  });
  it("then the built-in name, free_only, mode local, else paid", () => {
    expect(inferProfileType("scouting", staticRemote())).toBe("scouting");
    expect(inferProfileType("mine", { ...staticRemote(), free_only: true })).toBe("free");
    expect(inferProfileType("mine", { ...staticRemote(), mode: "local", api: "lmstudio-local" })).toBe("local");
    expect(inferProfileType("mine", staticRemote())).toBe("paid");
  });
});

describe("typed dynamic sections stay adoptable and allowed", () => {
  it("accepts profile-type in a dynamic section (closed-key check)", () => {
    const r = validateProfile("paid", withType({ ...unpopulatedPaidProfile(), model: "a/b" }, "paid"));
    expect(r.errors).toEqual([]);
  });

  it("adopts a shipped placeholder with or without its fixed profile-type, and nothing else", () => {
    for (const [name, make] of [["free", unpopulatedFreeProfile], ["paid", unpopulatedPaidProfile], ["local", unpopulatedLocalProfile]] as const) {
      expect(isShippedPlaceholder(name, make())).toBe(true);
      expect(isShippedPlaceholder(name, { ...make(), "profile-type": builtinProfileType(name) })).toBe(true);
      expect(isShippedPlaceholder(name, { ...make(), "profile-type": "classifier" })).toBe(false);
      expect(isShippedPlaceholder(name, { ...make(), "profile-type": builtinProfileType(name), model: "a/b" })).toBe(false);
    }
  });
});
