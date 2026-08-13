// Regression tests for the SETTINGS_TEMPLATE removal: the on-disk default
// settings.yaml is now GENERATED from generateDefaultSettings() via
// renderDefaultSettingsYaml() (config.ts), rather than being a second,
// hand-maintained string literal that could (and did) drift from the
// in-memory defaults. These tests pin the round-trip and the first-run /
// corrupt-file recovery behaviour that depends on it.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  generateDefaultSettings,
  renderDefaultSettingsYaml,
  validateSettings,
  ensureSettingsExist,
  getSettingsPath,
  getConfigDir,
  isUnpopulatedDefaultProfile,
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

  it("marks every default profile as an UNPOPULATED MACHINE-OWNED profile, which is what lets the boot path route it to population instead of to an error", () => {
    const settings = generateDefaultSettings();
    for (const [name, profile] of Object.entries(settings.profiles)) {
      expect(
        isUnpopulatedDefaultProfile(name, profile),
        `${name} must be recognisable as an unpopulated default profile`,
      ).toBe(true);
    }
  });

  it("does NOT classify a USER profile with an empty free pool as self-healing — only the 5 machine-managed default profiles populate themselves", () => {
    // The name check is the whole point: an arbitrary profile with an empty
    // free_models list is a genuine misconfiguration and must keep failing.
    const userProfile = generateDefaultSettings().profiles.free;
    expect(isUnpopulatedDefaultProfile("my-own-profile", userProfile)).toBe(false);
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

  const FIVE_DEFAULT_PROFILE_NAMES = [
    "free",
    "free-ensemble",
    "paid",
    "paid-ensemble",
    "paid-mass-scout",
  ].sort();

  it("on an empty config dir, creates settings.yaml declaring exactly the five machine-managed profiles (free, free-ensemble, paid, paid-ensemble, paid-mass-scout)", () => {
    ensureSettingsExist();
    const raw = readFileSync(getSettingsPath(), "utf-8");
    const parsed = parseYaml(raw) as { profiles: Record<string, unknown> };
    expect(Object.keys(parsed.profiles).sort()).toEqual(FIVE_DEFAULT_PROFILE_NAMES);
    for (const retired of RETIRED_PROFILE_NAMES) {
      expect(parsed.profiles).not.toHaveProperty(retired);
    }
  });

  it("regresses the actual shipped bug: recovers a corrupt settings.yaml by backing it up verbatim and regenerating the current 5 default profiles (not the old 3 or the older 5)", () => {
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
    expect(Object.keys(regenerated.profiles).sort()).toEqual(FIVE_DEFAULT_PROFILE_NAMES);
    for (const retired of RETIRED_PROFILE_NAMES) {
      expect(regenerated.profiles).not.toHaveProperty(retired);
    }
  });
});
