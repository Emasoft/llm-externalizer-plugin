// PF-03 (TRDD-W418LXJK): the built-in `or-jev` classifier template and `active_classifier` (D19, D24, E82).
// Real files in a throwaway config dir under /tmp, never the user's real one; no module mocking.
// The fresh-HOME install test of E112 itself belongs to RL-06; here the generated file is checked directly.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { parse as parseYaml, parseDocument } from "yaml";
import { tmpdir } from "./test-tmp-root.js";
import {
  ensureSettingsExist,
  getSettingsPath,
  loadSettings,
  profileSectionMarkerState,
  renderDefaultSettingsYaml,
  settingsLevelErrors,
  validateProfile,
  validateSettings,
  type Profile,
} from "./config.js";

let cfgDir: string;
let prevCfgDir: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-pf03-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("PF-03 or-jev on a fresh install", () => {
  it("writes or-jev typed classifier, on the jev-latest alias, with the generated marker, and active_classifier: or-jev", () => {
    ensureSettingsExist();
    const raw = readFileSync(getSettingsPath(), "utf-8");
    const parsed = parseYaml(raw) as { active_classifier?: string; profiles: Record<string, Profile> };
    expect(parsed.active_classifier).toBe("or-jev");
    expect(parsed.profiles["or-jev"]).toEqual({ "profile-type": "classifier", api: "openrouter-remote", model: "~typesafe/jev-latest", api_key: "$OPENROUTER_API_KEY" });
    expect(profileSectionMarkerState(parseDocument(raw), "or-jev")).toBe("marked");
  });

  it("the written or-jev profile is a valid classifier profile and the fresh file has no active_classifier error", () => {
    ensureSettingsExist();
    const settings = loadSettings()!;
    expect(settings.active_classifier).toBe("or-jev");
    expect(validateProfile("or-jev", settings.profiles["or-jev"]).errors).toEqual([]);
    expect(settingsLevelErrors(settings).filter((e) => e.includes("active_classifier"))).toEqual([]);
    expect(settings.unmarkedDynamicProfiles).toEqual([]);
  });

  it("render and generated settings agree on active_classifier (one source)", () => {
    expect(renderDefaultSettingsYaml()).toMatch(/^active_classifier: or-jev$/m);
  });
});

describe("PF-03 E82: active_classifier naming a missing profile", () => {
  const write = (extra: string): void => {
    writeFileSync(
      getSettingsPath(),
      ["active: mine", extra, "profiles:", "  mine:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    api_key: k", "    model: vendor/m", ""].join("\n"),
      "utf-8",
    );
  };

  it("is an error naming the profile, from validateSettings and from settingsLevelErrors", () => {
    write("active_classifier: nope");
    const settings = loadSettings()!;
    expect(settings.active_classifier).toBe("nope");
    expect(validateSettings(settings).errors.join("\n")).toMatch(/active_classifier names profile 'nope', which settings\.yaml does not define\. Available: mine/);
    expect(settingsLevelErrors(settings).join("\n")).toMatch(/active_classifier names profile 'nope'/);
  });

  it("naming an existing profile, or no key at all, is not an error", () => {
    write("active_classifier: mine");
    expect(validateSettings(loadSettings()!).errors).toEqual([]);
    write("");
    expect(validateSettings(loadSettings()!).errors).toEqual([]);
  });
});
