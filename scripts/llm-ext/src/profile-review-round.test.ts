// Review round on PT-06 (TRDD-W57VQ346) and PF-03 (TRDD-W418LXJK): real /tmp settings files through the real load path
// (migrate, then load and validate). No mocks; the config dir is a throwaway under /tmp, never the user's.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { tmpdir } from "./test-tmp-root.js";
import { migrateSettingsTo141 } from "./benchmark/pick.js";
import { isMigrationStepApplied, markMigrationStepApplied } from "./default-profiles-state.js";
import {
  GENERATED_MARKER,
  getSettingsPath,
  inferProfileType,
  loadSettings,
  profileTypeFieldIssues,
  profileTypesSettingsErrors,
  renderDefaultSettingsYaml,
  settingsLevelErrors,
  validateProfile,
  validateSettings,
  type Profile,
  type ProfileType,
} from "./config.js";

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBai: string | undefined;
let notices: string[];

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevBai = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY;
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-review-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  notices = [];
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevBai === undefined) delete process.env.BAI_API_KEY;
  else process.env.BAI_API_KEY = prevBai;
  rmSync(cfgDir, { recursive: true, force: true });
});

const migrate = (): void => {
  migrateSettingsTo141(getSettingsPath(), { notify: (m) => notices.push(m), isApplied: isMigrationStepApplied, markApplied: markMigrationStepApplied });
};
const write = (yaml: string): void => writeFileSync(getSettingsPath(), yaml, "utf-8");
const count = (list: readonly string[], needle: string): number => list.filter((e) => e.includes(needle)).length;

describe("review 1: the migration names what it wrote and what will be rejected", () => {
  const FILE = [
    "profiles:",
    "  legacy:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    api_key: k",
    "    model: vendor/x:free",
    "    free_models: [vendor/x:free]",
    "",
  ].join("\n");

  it("end to end: free_models without free_only is typed paid, the notice names profile, field, type and the one-line fix, and the load then fails naming field and type", () => {
    write(FILE);
    migrate();
    const notice = notices.join("\n");
    expect(notice).toContain("profiles.legacy: profile-type 'paid' (inferred)");
    expect(notice).toContain("profiles.legacy.free_models belongs to type local/free, not 'paid'");
    expect(notice).toMatch(/profiles\.legacy\.free_models[^\n]*Fix: delete the key, or set profile-type to local or free/);
    const errors = profileTypesSettingsErrors(loadSettings()!);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("profiles.legacy.free_models belongs to type local/free, not 'paid'");
  });

  it("a field no type knows gets the delete-it fix", () => {
    write(FILE.replace("free_models: [vendor/x:free]", "turbo: 1"));
    migrate();
    expect(notices.join("\n")).toMatch(/profiles\.legacy\.turbo is unknown to every profile type[^\n]*Fix: delete the key/);
  });

  it("every field the old loader accepted that the inferred type rejects (the list the notice and the docs rely on)", () => {
    const base = { api: "openrouter-remote", model: "m" };
    const shapes: Record<string, Record<string, unknown>> = {
      free: { ...base, mode: "remote", free_only: true },
      paid: { ...base, mode: "remote" },
      local: { ...base, mode: "local", api: "lmstudio-local" },
    };
    const keys = ["api_key", "api_token", "providers", "second_model", "third_model", "free_models", "paid_models", "ensemble", "tool_models", "high_quality_model", "selection", "detected_providers", "timeout", "context_window", "app_name", "http_referer"];
    const rejected: Record<string, string[]> = {};
    for (const [expected, shape] of Object.entries(shapes)) {
      rejected[expected] = [];
      for (const key of keys) {
        const profile = { ...shape, [key]: 1 } as unknown as Profile;
        expect(inferProfileType("custom", profile)).toBe(expected as ProfileType);
        if (profileTypeFieldIssues("custom", profile, expected as ProfileType).length > 0) rejected[expected].push(key);
      }
    }
    expect(rejected).toEqual({
      free: ["api_token", "paid_models", "ensemble", "selection", "detected_providers"],
      paid: ["api_token", "free_models", "detected_providers"],
      local: ["api_key", "second_model", "third_model", "paid_models", "ensemble", "high_quality_model", "selection"],
    });
  });
});

describe("review 2: user-owned selection on generated free and local sections", () => {
  it("loads: the field check admits DYNAMIC_USER_OWNED_KEYS of a marked section", () => {
    write(
      [
        `# ${GENERATED_MARKER}`,
        "profiles:",
        `  # ${GENERATED_MARKER}`,
        "  free:",
        "    profile-type: free",
        "    mode: remote",
        "    api: openrouter-remote",
        "    selection: {}",
        "    high_quality_model: { id: a/b }",
        "    ensemble: {}",
        `  # ${GENERATED_MARKER}`,
        "  local:",
        "    profile-type: local",
        "    mode: local",
        "    api: lmstudio-local",
        "    selection: {}",
        "",
      ].join("\n"),
    );
    const all = [...profileTypesSettingsErrors(loadSettings()!), ...settingsLevelErrors(loadSettings()!)];
    expect(all.filter((e) => e.includes("selection") || e.includes("ensemble") || e.includes("high_quality_model"))).toEqual([]);
  });
});

describe("review 3: the marked or-jev section is tunable with its own type's fields", () => {
  const orJev = (extra: string[]): string =>
    ["active: or-jev", "profiles:", `  # ${GENERATED_MARKER}`, "  or-jev:", "    profile-type: classifier", "    api: openrouter-remote", "    api_key: $OPENROUTER_API_KEY", "    model: ~typesafe/jev-latest", ...extra, ""].join("\n");

  it("concurrency and timeout_ms load with no error from validateSettings, settingsLevelErrors or the reserved-name check", () => {
    write(orJev(["    concurrency: 4", "    timeout_ms: 5000"]));
    const s = loadSettings()!;
    expect(s.unmarkedDynamicProfiles).toEqual([]);
    expect(validateSettings(s).errors).toEqual([]);
    expect(settingsLevelErrors(s)).toEqual([]);
  });

  it("a chat field such as timeout is rejected naming the field and the types it belongs to", () => {
    write(orJev(["    timeout: 5"]));
    const errors = validateSettings(loadSettings()!).errors;
    expect(errors.join("\n")).toMatch(/profiles\.or-jev\.timeout belongs to type local\/free\/paid, not 'classifier'/);
  });
});

describe("review 4: one error text, once", () => {
  it("a bad field on the effective chat profile appears once in validateSettings and once in settingsLevelErrors", () => {
    write(["active: mine", "profiles:", "  mine:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    api_key: k", "    model: vendor/m", "    free_only: true", ""].join("\n"));
    const s = loadSettings()!;
    expect(count(validateSettings(s).errors, "profiles.mine.free_only")).toBe(1);
    expect(count(settingsLevelErrors(s), "profiles.mine.free_only")).toBe(1);
  });

  it("a bad field on the effective classifier profile appears once in each", () => {
    write(["active: c1", "profiles:", "  c1:", "    profile-type: classifier", "    api: openrouter-remote", "    api_key: k", "    model: a/b", "    selection: {}", ""].join("\n"));
    const s = loadSettings()!;
    expect(count(validateSettings(s).errors, "profiles.c1.selection")).toBe(1);
    expect(count(settingsLevelErrors(s), "profiles.c1.selection")).toBe(1);
  });

  it("a dangling active_classifier appears once in each", () => {
    write(["active: mine", "active_classifier: nope", "profiles:", "  mine:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    api_key: k", "    model: vendor/m", ""].join("\n"));
    const s = loadSettings()!;
    expect(count(validateSettings(s).errors, "active_classifier names profile 'nope'")).toBe(1);
    expect(count(settingsLevelErrors(s), "active_classifier names profile 'nope'")).toBe(1);
  });
});

describe("review 5: active_classifier naming an existing non-classifier profile", () => {
  it("is not an E82 error (E82 is only 'missing'; the type check is PT-03 / L2-17)", () => {
    write(["active: mine", "active_classifier: mine", "profiles:", "  mine:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    api_key: k", "    model: vendor/m", ""].join("\n"));
    expect(validateSettings(loadSettings()!).errors).toEqual([]);
  });
});

describe("review 6: the generated banner is true for or-jev", () => {
  it("says only the four chat/scouting profiles start empty, and that or-jev is complete as written and never rewritten", () => {
    const yaml = renderDefaultSettingsYaml();
    expect(yaml).toMatch(/'free', 'paid', 'local' and 'scouting' start EMPTY/);
    expect(yaml).toMatch(/'or-jev' is complete as written and llm-ext never rewrites it/);
  });
});

// validateProfile is exercised through validateSettings above; keep the import honest.
void validateProfile;
