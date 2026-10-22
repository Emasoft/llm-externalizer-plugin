// Regression tests for the SETTINGS_TEMPLATE removal: the on-disk default
// settings.yaml is now GENERATED from generateDefaultSettings() via
// renderDefaultSettingsYaml() (config.ts), rather than being a second,
// hand-maintained string literal that could (and did) drift from the
// in-memory defaults. These tests pin the round-trip and the first-run /
// corrupt-file recovery behaviour that depends on it.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";

import {
  generateDefaultSettings,
  renderDefaultSettingsYaml,
  validateSettings,
  ensureSettingsExist,
  getSettingsPath,
  getConfigDir,
  isUnpopulatedDefaultProfile,
  isInvalidOnlyBecauseUnpopulated,
  profileSectionMarkerState,
  profileExampleLines,
  profileExample,
  ensembleExample,
  ensembleExampleLines,
  profileTypeFieldIssues,
  validateProfile,
  PLACEHOLDER_MODEL_ID,
  type Profile,
  PROFILE_TYPES,
  PROFILE_TYPE_FIELDS,
} from "./config.js";

describe("renderDefaultSettingsYaml() — generated defaults never drift", () => {
  it("round-trips to exactly generateDefaultSettings() — the single source of truth for shipped defaults", () => {
    const parsed = parseYaml(renderDefaultSettingsYaml());
    expect(parsed).toEqual(generateDefaultSettings());
  });

  it("keeps the generated file human-readable with explanatory comments, including the master paid-spend switch", () => {
    const yaml = renderDefaultSettingsYaml();
    const commentLines = yaml.split("\n").filter((l) => l.trim().startsWith("#"));
    expect(commentLines.length).toBeGreaterThan(3);
    expect(yaml).toContain("Master paid-spend switch");
  });

  it("does NOT pretend an unpopulated default profile is valid — an empty pool cannot serve a request", () => {
    // Deliberate: validateSettings reports the truth. An earlier attempt made
    // validateProfile exempt placeholders so a fresh install would boot, and
    // that silently disabled two zero-spend invariants for EVERY profile —
    // an empty free_models list and a malformed (scalar) free_models both
    // started reporting VALID. Weakening the validator to solve a boot problem
    // is the wrong layer; see the next test for the right one.
    const result = validateSettings(generateDefaultSettings());
    expect(result.valid).toBe(false);
  });

  it("marks every self-populating default profile as an UNPOPULATED MACHINE-OWNED profile, which is what lets the boot path route it to population instead of to an error", () => {
    const settings = generateDefaultSettings();
    for (const [name, profile] of Object.entries(settings.profiles).filter(([n]) => n !== "scouting" && n !== "or-jev")) {
      expect(
        isUnpopulatedDefaultProfile(name, profile),
        `${name} must be recognisable as an unpopulated default profile`,
      ).toBe(true);
    }
    // PT-04: `scouting` is a marked placeholder but does NOT populate itself (only `benchmark scout-accuracy` fills it), so the boot exemption must not cover it.
    expect(isUnpopulatedDefaultProfile("scouting", settings.profiles.scouting)).toBe(false);
    // PF-03: `or-jev` is a complete, usable classifier profile, not a placeholder awaiting population.
    expect(isUnpopulatedDefaultProfile("or-jev", settings.profiles["or-jev"])).toBe(false);
  });

  it("every default profile stays EXEMPT under the error-scoped check — the necessary half of 'a fresh install still boots'", () => {
    // isInvalidOnlyBecauseUnpopulated tightened the boot exemption from "is
    // this a placeholder?" to "are ALL its errors population errors?". That is
    // strictly stricter, so the risk it introduces is the opposite of the bug
    // it fixed: a generated default whose shape trips some OTHER rule once its
    // pool is filled would now BLOCK boot on a clean install. This asserts all
    // five survive the substitution.
    // PAIRED with config.test.ts's "both self-healing conditions at once" —
    // this one catches a helper that got STRICTER, that one catches a helper
    // that got more permissive (a constant `true` passes HERE and fails THERE).
    // Dropping the needsAuthKey substitution reddens both, so do not read a
    // double failure as proof they are duplicates.
    //
    // The auth env var is UNSET for the duration, because that is what a first
    // run looks like and because leaving it to ambient env is how the first
    // version of this test passed while the code was broken: this shell exports
    // OPENROUTER_API_KEY, a fresh machine and a CI runner do not. Green here
    // must not depend on the developer's shell.
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const settings = generateDefaultSettings();
      // PT-04: `scouting` never populates itself and cannot be the active profile, so only the self-populating three are exempt (`or-jev` is a classifier, never the active chat profile).
      for (const [name, profile] of Object.entries(settings.profiles).filter(([n]) => n !== "scouting" && n !== "or-jev")) {
        expect(
          isInvalidOnlyBecauseUnpopulated(name, profile),
          `${name} must stay exempt — it can be the active profile`,
        ).toBe(true);
      }
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  // ── P6c-a item 4 (fix-queue 45): what a FRESH INSTALL now emits ──────────

  it("emits `active: free` — the default-profile pointer is live again (TRDD-G6XT3AY9)", () => {
    // WHY: `active:` selects the default profile once more (precedence:
    // --profile flag > active: > built-in). A fresh install must show its own
    // default explicitly rather than leaving it a fact only --help knows.
    expect(generateDefaultSettings()).toHaveProperty("active", "free");
    const parsed = parseYaml(renderDefaultSettingsYaml()) as Record<string, unknown>;
    expect(parsed).toHaveProperty("active", "free");
    expect(renderDefaultSettingsYaml()).toMatch(/^active: free$/m);
  });

  it("emits EXACTLY the five generated sections (three dynamic, scouting and or-jev), all carrying the generated marker", () => {
    // The marker is what the migration and writeDynamicProfileSection read to
    // tell "llm-ext wrote this" from "the user wrote this". Without it on a
    // fresh install, the very next run would treat these sections as
    // hand-authored: back the file up and regenerate it, with a notice.
    expect(Object.keys(generateDefaultSettings().profiles).sort()).toEqual(["free", "local", "or-jev", "paid", "scouting"]);
    const yaml = renderDefaultSettingsYaml();
    const doc = parseDocument(yaml);
    expect(profileSectionMarkerState(doc, "free")).toBe("marked");
    expect(profileSectionMarkerState(doc, "paid")).toBe("marked");
    expect(profileSectionMarkerState(doc, "local")).toBe("marked");
    // PT-04 (D19): the scouting placeholder is a marked built-in too.
    expect(profileSectionMarkerState(doc, "scouting")).toBe("marked");
    // PF-03 (D19, E112): the classifier template carries the marker too.
    expect(profileSectionMarkerState(doc, "or-jev")).toBe("marked");
  });

  it("carries a COMMENTED template for the user's own static profiles", () => {
    // A fresh install has five profiles (free, paid, local, scouting, or-jev) the user must
    // not touch and no example of one they may. The template is comments,
    // not YAML: a half-filled
    // example profile inside `profiles:` would be loaded and then fail
    // validateProfile on every command.
    const yaml = renderDefaultSettingsYaml();
    expect(yaml).toContain("YOUR OWN PROFILES");
    expect(yaml).toContain("--profile <name>");
    const parsed = parseYaml(yaml) as { profiles: Record<string, unknown> };
    expect(Object.keys(parsed.profiles).sort()).toEqual(["free", "local", "or-jev", "paid", "scouting"]);
  });

  it("does NOT classify a USER profile with an empty free pool as self-healing — only the 3 generated profiles populate themselves", () => {
    // The name check is the whole point: an arbitrary profile with an empty
    // free_models list is a genuine misconfiguration and must keep failing.
    const userProfile = generateDefaultSettings().profiles.free;
    expect(isUnpopulatedDefaultProfile("my-own-profile", userProfile)).toBe(false);
  });
});

describe("PT-07: the trailing example comment shows one example per profile type, copied from the templates", () => {
  const trailing = (): string => {
    const text = renderDefaultSettingsYaml();
    return text.slice(text.lastIndexOf("\n", text.indexOf("YOUR OWN PROFILES")) + 1);
  };

  it.each(PROFILE_TYPES)("the %s example parses back to exactly its template", (type) => {
    const lines = profileExampleLines(type);
    const parsed = parseYaml(lines.slice(1).join("\n")) as Record<string, unknown>;
    expect(parsed).toEqual({ [`my-${type}`]: profileExample(type) });
  });

  it("the written file carries every example, one per type plus the paid ensemble, as comment lines", () => {
    const comment = trailing();
    for (const type of PROFILE_TYPES) {
      for (const line of profileExampleLines(type)) expect(comment).toContain(`#   ${line}`);
      expect(comment).toContain(`my-${type}:`);
    }
    for (const line of ensembleExampleLines()) expect(comment).toContain(`#   ${line}`);
    expect(comment).toContain("my-ensemble:");
    expect(comment).toContain("mode: remote-ensemble");
    expect(comment.split("\n").every((l) => l === "" || l.startsWith("#"))).toBe(true);
  });


  it.each(PROFILE_TYPES)("the %s example equals the built-in template generateDefaultSettings() ships, not only profileExample()", (type) => {
    // WHY a second source: the round-trip test compares with profileExample(), the function that built the example, so it cannot see a wrong profileExample.
    const oracle = generateDefaultSettings().profiles[PROFILE_TYPE_FIELDS[type].template];
    expect(profileExample(type)).toEqual(oracle);
    expect((parseYaml(profileExampleLines(type).slice(1).join("\n")) as Record<string, unknown>)[`my-${type}`]).toEqual(oracle);
  });

});

describe("PT-07: every generated example is valid by construction", () => {
  // The templates are placeholders (an empty pool cannot serve), so validity is checked with the placeholder model replaced by a real-looking id; the field set is checked as written.
  const real = (p: Profile): Profile => JSON.parse(JSON.stringify(p).replaceAll(PLACEHOLDER_MODEL_ID, "vendor/model")) as Profile;
  const examples: Array<[string, Profile, ProfileTypeName]> = [...PROFILE_TYPES.map((t): [string, Profile, ProfileTypeName] => [t, profileExample(t), t]), ["ensemble", ensembleExample(), "paid"]];
  type ProfileTypeName = (typeof PROFILE_TYPES)[number];

  // WHY a dummy key set here: validateProfile also checks that the profile's `$OPENROUTER_API_KEY` env var is SET (a runtime fact, not the shape); without this the test passed only on a shell that exports the key.
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "dummy-key-for-shape-validation";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  it.each(PROFILE_TYPES)("profileExample(%s) builds without throwing", (type) => {
    expect(() => profileExample(type)).not.toThrow();
  });

  // WHY parsed from the written comment: the user copies the comment text, so that text (not the in-memory object) must validate once the user does what its caption says.
  const POOL_NOTE = "list at least one model under free_models";
  const blocks: Array<[string, string[]]> = [...PROFILE_TYPES.map((t): [string, string[]] => [t, profileExampleLines(t)]), ["ensemble", ensembleExampleLines()]];
  it.each(blocks)("the %s example in the default settings comment validates as written once the caption is followed", (label, lines) => {
    const comment = renderDefaultSettingsYaml();
    expect(comment).toContain(lines.map((l) => `#   ${l}`).join("\n"));
    const parsed = parseYaml(lines.slice(1).join("\n").replaceAll(PLACEHOLDER_MODEL_ID, "vendor/model")) as Record<string, Profile & { free_models?: string[] }>;
    const profile = parsed[`my-${label}`]!;
    // The verdict of the validator on the example with ONLY the placeholder replaced decides whether the caption must send the user to free_models; the code's own predicate is not repeated here.
    const asCopied = validateProfile(`my-${label}`, structuredClone(profile));
    const needsPool = !asCopied.valid;
    if (needsPool) expect(asCopied.errors.every((e) => /free_models/.test(e)), asCopied.errors.join("; ")).toBe(true);
    expect(lines[0]!.includes(POOL_NOTE)).toBe(needsPool);
    if (label !== "ensemble") expect(lines[0]).toContain("replace the placeholder model (if any)");
    // After doing what the caption says, the example validates.
    if (needsPool) profile.free_models = ["vendor/model:free"];
    // The fields are checked on the RENDERED comment text, not only on the template object.
    const type = label === "ensemble" ? "paid" : (label as (typeof PROFILE_TYPES)[number]);
    expect(profileTypeFieldIssues(`my-${label}`, parsed[`my-${label}`]!, type)).toEqual([]);
    expect(validateProfile(`my-${label}`, profile)).toEqual({ valid: true, errors: [] });
  });

  it.each(examples)("the %s example has only fields of its type", (_label, profile, type) => {
    expect(profileTypeFieldIssues(`my-${type}`, profile, type)).toEqual([]);
  });

  it("the classifier example validates as written, and the ensemble validates once its models are real", () => {
    expect(validateProfile("my-classifier", profileExample("classifier"))).toEqual({ valid: true, errors: [] });
    expect(validateProfile("my-ensemble", real(ensembleExample()))).toEqual({ valid: true, errors: [] });
  });

  it("a profile type whose template is not a marked built-in cannot render (no type ships without an example)", () => {
    const fields = PROFILE_TYPE_FIELDS as unknown as Record<string, { template: string }>;
    const original = fields.paid.template;
    fields.paid.template = "not-a-builtin";
    try {
      expect(() => profileExample("paid")).toThrow(/not a marked built-in/);
    } finally {
      fields.paid.template = original;
    }
  });
});

describe("ensureSettingsExist() — first run and corrupt-file recovery write the generated defaults", () => {
  let cfgDir: string;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    cfgDir = mkdtempSync(join("/tmp", "default-settings-cfg-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  const RETIRED_PROFILE_NAMES = [
    "local-lmstudio-qwen35",
    "local-ollama-qwen314",
    "remote-single-geminiflash",
    "remote-ensemble-geminigrok",
    "remote-free-ensemble",
  ];

  // P6c-a item 4 / TRDD-C9SXX7HO (D2): a fresh install declares EXACTLY the
  // three dynamic profiles plus the PT-04 `scouting` placeholder. The OLD extra
  // machine-owned names (a different, pre-14.0.0 set) are retired.
  const GENERATED_PROFILE_NAMES = ["free", "paid", "local", "scouting", "or-jev"].sort();

  it("on an empty config dir, creates settings.yaml declaring exactly the five generated profiles (free, paid, local, scouting, or-jev)", () => {
    ensureSettingsExist();
    const raw = readFileSync(getSettingsPath(), "utf-8");
    const parsed = parseYaml(raw) as { profiles: Record<string, unknown> };
    expect(Object.keys(parsed.profiles).sort()).toEqual(GENERATED_PROFILE_NAMES);
    for (const retired of RETIRED_PROFILE_NAMES) {
      expect(parsed.profiles).not.toHaveProperty(retired);
    }
  });

  it("regresses the actual shipped bug: recovers a corrupt settings.yaml by backing it up verbatim and regenerating the current 5 generated profiles (not any earlier set)", () => {
    const settingsPath = getSettingsPath();
    const corruptContents = "profiles: [\n";
    writeFileSync(settingsPath, corruptContents, "utf-8");

    const result = ensureSettingsExist();

    expect(result).not.toBeNull();

    const backups = readdirSync(getConfigDir()).filter((f) => f.includes(".corrupt-"));
    expect(backups.length).toBe(1);
    const backupRaw = readFileSync(join(getConfigDir(), backups[0]), "utf-8");
    expect(backupRaw).toBe(corruptContents);

    const regenerated = parseYaml(readFileSync(settingsPath, "utf-8")) as {
      profiles: Record<string, unknown>;
    };
    expect(Object.keys(regenerated.profiles).sort()).toEqual(GENERATED_PROFILE_NAMES);
    for (const retired of RETIRED_PROFILE_NAMES) {
      expect(regenerated.profiles).not.toHaveProperty(retired);
    }
  });
});
