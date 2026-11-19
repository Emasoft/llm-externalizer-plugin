// TRDD-VBAJX5A1: the boot path must not return the settings it read BEFORE the migrations when another process
// changed settings.yaml in between. Real files in a throwaway llm-ext-* config dir under /tmp, never the user's real one.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { tmpdir } from "./test-tmp-root.js";
import { localProfileStepIds, migrateSettingsTo141 } from "./benchmark/pick.js";
import { isMigrationStepApplied, markMigrationStepApplied, stampProfileMigrationDone } from "./default-profiles-state.js";
import { loadSettingsAfterMigrations } from "./boot-settings.js";
import {
  PROFILE_TYPE_STEP,
  ensureSettingsExist,
  getSettingsPath,
  loadSettings,
  profileTypesSettingsErrors,
  settingsLevelErrors,
} from "./config.js";

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBai: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevBai = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY; // the bai seed step would otherwise rewrite the free section
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-vbajx5a1-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  // The 14.0 stamp and every gated 14.1 step are recorded, as on an installed machine: only the two steps NOT gated
  // on the record (scouting-section-marked, profile-type-written) stay live, and they are recorded too, so a later
  // run reports a write only when THAT run made it.
  stampProfileMigrationDone(Date.now());
  for (const step of [
    ...localProfileStepIds(),
    "price-ceiling-into-paid",
    "local-detected-providers",
    "bai-binding-to-reserved-slot",
    "bai-reserved-seed",
    "dynamic-unknown-keys",
    "or-jev-section-added",
    "scouting-section-marked",
    PROFILE_TYPE_STEP,
  ]) {
    markMigrationStepApplied(step);
  }
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevBai === undefined) delete process.env.BAI_API_KEY;
  else process.env.BAI_API_KEY = prevBai;
  rmSync(cfgDir, { recursive: true, force: true });
});

// "Another process" running the same migrations against the same file.
const otherProcess = (): ReturnType<typeof migrateSettingsTo141> =>
  migrateSettingsTo141(getSettingsPath(), {
    notify: () => undefined,
    isApplied: isMigrationStepApplied,
    markApplied: markMigrationStepApplied,
  });

const UNTYPED = [
  "profiles:",
  "  mine:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/some-model",
  "  frugal:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/x:free",
  "    free_only: true",
  "",
].join("\n");

// Typed already, so only the scouting marker is missing.
const TYPED_UNMARKED_SCOUTING = [
  "profiles:",
  "  mine:",
  "    profile-type: paid",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/some-model",
  "  scouting:",
  "    profile-type: scouting",
  "    mode: remote",
  "    api: openrouter-remote",
  "    url: https://openrouter.ai/api",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: old/head",
  "",
].join("\n");

describe("TRDD-VBAJX5A1 boot returns the file as it is after the migrations", () => {
  it("returns typed profiles when another process wrote profile-type between the first read and the migrations", () => {
    writeFileSync(getSettingsPath(), UNTYPED, "utf-8");
    const loaded = ensureSettingsExist(); // the stale copy: untyped file, record says the step ran
    expect(profileTypesSettingsErrors(loaded).join("\n")).toContain("has no profile-type");
    expect(otherProcess().applied).toContain(PROFILE_TYPE_STEP);

    const result = loadSettingsAfterMigrations();

    expect(Object.fromEntries(Object.entries(result.profiles).map(([n, p]) => [n, p["profile-type"]]))).toEqual({ mine: "paid", frugal: "free" });
    expect(profileTypesSettingsErrors(result).join("\n")).not.toContain("has no profile-type");
  });

  it("returns a marked scouting section when another process marked it between the first read and the migrations", () => {
    writeFileSync(getSettingsPath(), TYPED_UNMARKED_SCOUTING, "utf-8");
    const loaded = ensureSettingsExist();
    expect(loaded.unmarkedDynamicProfiles).toEqual(["scouting"]);
    expect(otherProcess().applied).toContain("scouting-section-marked");

    const result = loadSettingsAfterMigrations();

    expect(result.unmarkedDynamicProfiles).toEqual([]);
    expect(settingsLevelErrors(result)).toEqual([]);
  });

  it("control: an unchanged, already migrated file gives the same settings as a fresh load", () => {
    writeFileSync(getSettingsPath(), UNTYPED.replace("  mine:\n", "  mine:\n    profile-type: paid\n").replace("  frugal:\n", "  frugal:\n    profile-type: free\n"), "utf-8");
    ensureSettingsExist();

    const result = loadSettingsAfterMigrations();

    expect(result).toEqual(loadSettings());
    expect(profileTypesSettingsErrors(result)).toEqual([]);
  });

  it("throws, naming settings.yaml, when the file stopped parsing after ensureSettingsExist read it", () => {
    writeFileSync(getSettingsPath(), UNTYPED, "utf-8");
    ensureSettingsExist();
    const garbage = "profiles: [unclosed\n  key: : :\n";
    writeFileSync(getSettingsPath(), garbage, "utf-8");

    expect(() => loadSettingsAfterMigrations()).toThrow(`settings.yaml could not be read again after the boot migrations (${getSettingsPath()}): it was deleted or no longer parses`);
    // The migrations leave an unparseable file alone: nothing is rewritten or regenerated over the user text.
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(garbage);
  });
});
