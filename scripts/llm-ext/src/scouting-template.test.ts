// PT-04 (TRDD-N2L9BN1Q): `scouting` is the fifth built-in template. Real files in a throwaway
// config dir under /tmp, never the user's real one; no module mocking.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { tmpdir } from "./test-tmp-root.js";
import { localProfileStepIds, migrateSettingsTo141, addProfileToSettings } from "./benchmark/pick.js";
import { writeScoutingProfile } from "./benchmark/scout-accuracy.js";
import { setValidationBypassForTests } from "./benchmark/validated.js";
import { isMigrationStepApplied, markMigrationStepApplied } from "./default-profiles-state.js";
import { runMassScoutCli } from "./mass_scouting/cli.js";
import {
  GENERATED_MARKER,
  PLACEHOLDER_MODEL_ID,
  PROFILE_TYPE_STEP,
  getSettingsPath,
  loadSettings,
  profileSectionMarkerState,
  renderDefaultSettingsYaml,
  settingsLevelErrors,
  unpopulatedDefaultProfile,
  validateProfile,
  type Profile,
} from "./config.js";

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBai: string | undefined;
let notices: string[];

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevBai = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY; // the bai seed step would otherwise rewrite the free section
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-pt04-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  notices = [];
});

// P5: these tests exercise other steps; mark the built-in local-profile steps applied so their fixtures stay byte-exact. Those steps have their own tests in local-profiles-builtin.test.ts.
beforeEach(() => {
  for (const step of localProfileStepIds()) markMigrationStepApplied(step);
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevBai === undefined) delete process.env.BAI_API_KEY;
  else process.env.BAI_API_KEY = prevBai;
  rmSync(cfgDir, { recursive: true, force: true });
});

const run = (): ReturnType<typeof migrateSettingsTo141> =>
  migrateSettingsTo141(getSettingsPath(), {
    notify: (m) => notices.push(m),
    isApplied: isMigrationStepApplied,
    markApplied: markMigrationStepApplied,
  });


// PF-04: these tests exercise other steps; a settings.yaml that already went through the `or-jev-section-added` step keeps their fixtures byte-exact. That step has its own tests in or-jev-migration.test.ts.
beforeEach(() => {
  markMigrationStepApplied("or-jev-section-added");
});

const readProfiles = (): Record<string, Record<string, unknown>> =>
  (parseYaml(readFileSync(getSettingsPath(), "utf-8")) as { profiles: Record<string, Record<string, unknown>> }).profiles;

const backups = (): string[] => (existsSync(join(cfgDir, "backups")) ? readdirSync(join(cfgDir, "backups")) : []);

// What `benchmark scout-accuracy` wrote before PT-04: no marker, no type, a paid_models list nothing reads.
const OLD_SCOUTING = [
  "# my header",
  "profiles:",
  "  mine:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/mine",
  "  scouting:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    url: https://openrouter.ai/api",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: old/head",
  "    paid_models: [old/head, old/second]",
  "",
].join("\n");

describe("PT-04: scouting on a fresh install", () => {
  it("is written as a marked, typed placeholder without a paid_models list", () => {
    writeFileSync(getSettingsPath(), renderDefaultSettingsYaml(), "utf-8");
    const scouting = readProfiles().scouting;
    expect(scouting.model).toBe(PLACEHOLDER_MODEL_ID);
    expect(scouting["profile-type"]).toBe("scouting");
    expect(scouting).not.toHaveProperty("paid_models");
    expect(profileSectionMarkerState(parseDocument(readFileSync(getSettingsPath(), "utf-8")), "scouting")).toBe("marked");
  });

  it("loads without any settings-level error once the type migration is recorded", () => {
    writeFileSync(getSettingsPath(), renderDefaultSettingsYaml(), "utf-8");
    markMigrationStepApplied(PROFILE_TYPE_STEP);
    const s = loadSettings()!;
    expect(s.unmarkedDynamicProfiles).toEqual([]);
    expect(settingsLevelErrors(s)).toEqual([]);
  });
});

describe("PT-04: the closed key set and the writer guard cover scouting", () => {
  it("validateProfile refuses a key outside the scouting key set", () => {
    const p = { ...unpopulatedDefaultProfile("scouting"), timeout: 5 } as Profile;
    const r = validateProfile("scouting", p);
    expect(r.errors.join("\n")).toMatch(/Profile 'scouting': 'timeout' is not allowed in a generated profile/);
    // A profile of another name is not closed: the same key is fine there.
    expect(validateProfile("my-scouting", { ...p, "profile-type": "scouting" } as Profile).errors.join("\n")).not.toMatch(/not allowed in a generated profile/);
  });

  it("addProfileToSettings refuses the name scouting (one locked writer for a marked section)", () => {
    writeFileSync(getSettingsPath(), "profiles: {}\n", "utf-8");
    expect(() => addProfileToSettings(getSettingsPath(), "scouting", { mode: "remote", api: "openrouter-remote", model: "x/y" })).toThrow(/GENERATED profile/);
  });
});

describe("PT-04: an existing unmarked scouting section keeps loading through the migration", () => {
  it("without the migration the unmarked section is refused; after it the section is marked, backed up and cleaned", () => {
    writeFileSync(getSettingsPath(), OLD_SCOUTING, "utf-8");
    expect(loadSettings()!.unmarkedDynamicProfiles).toEqual(["scouting"]);
    expect(settingsLevelErrors(loadSettings()!).join("\n")).toMatch(/defines 'scouting' by hand/);

    run();

    const after = loadSettings()!;
    expect(after.unmarkedDynamicProfiles).toEqual([]);
    expect(settingsLevelErrors(after)).toEqual([]);
    const scouting = readProfiles().scouting;
    expect(scouting.model).toBe("old/head"); // the user's benchmarked head survives
    expect(scouting).not.toHaveProperty("paid_models");
    expect(scouting["profile-type"]).toBe("scouting"); // typed by the step that follows
    expect(readFileSync(getSettingsPath(), "utf-8")).toContain(GENERATED_MARKER);
    expect(readFileSync(getSettingsPath(), "utf-8")).toContain("# my header");
    expect(backups().length).toBeGreaterThan(0);
    expect(notices.join("\n")).toMatch(/marked profiles\.scouting as generated by llm-ext.*profiles\.scouting\.paid_models/s);
  });

  it("is idempotent: a second pass writes no backup and no notice", () => {
    writeFileSync(getSettingsPath(), OLD_SCOUTING, "utf-8");
    run();
    const before = readFileSync(getSettingsPath(), "utf-8");
    const nBackups = backups().length;
    notices.length = 0;
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(before);
    expect(backups().length).toBe(nBackups);
    expect(notices).toEqual([]);
  });

  it("a file with no scouting section only records the step", () => {
    writeFileSync(getSettingsPath(), "profiles:\n  mine:\n    mode: remote\n    api: openrouter-remote\n    api_key: $OPENROUTER_API_KEY\n    model: vendor/mine\n", "utf-8");
    run();
    expect(isMigrationStepApplied("scouting-section-marked")).toBe(true);
    expect(readProfiles()).not.toHaveProperty("scouting");
  });

  it("D1: restoring the pre-migration backup is marked and cleaned again, and the load succeeds", () => {
    writeFileSync(getSettingsPath(), OLD_SCOUTING, "utf-8");
    run();
    writeFileSync(getSettingsPath(), OLD_SCOUTING, "utf-8"); // the user restores the backup; the record still says migrated
    run();
    const after = loadSettings()!;
    expect(after.unmarkedDynamicProfiles).toEqual([]);
    expect(settingsLevelErrors(after)).toEqual([]);
    expect(readProfiles().scouting).not.toHaveProperty("paid_models");
    expect(readFileSync(getSettingsPath(), "utf-8")).toContain(GENERATED_MARKER);
  });

  it("D2: a file that keeps reverting leaves exactly one backup of that content", () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(getSettingsPath(), OLD_SCOUTING, "utf-8");
      // a minute apart, so a missing dedupe cannot hide behind one backup file name per second
      migrateSettingsTo141(getSettingsPath(), { notify: (m) => notices.push(m), isApplied: isMigrationStepApplied, markApplied: markMigrationStepApplied, nowMs: Date.now() + i * 60_000 });
    }
    const dir = join(cfgDir, "backups");
    const same = backups().filter((f) => readFileSync(join(dir, f), "utf-8") === OLD_SCOUTING);
    expect(same).toHaveLength(1);
    // the type step backs up the already-marked file once, not once per revert
    expect(backups()).toHaveLength(2);
  });
});

describe("PT-04: benchmark scout-accuracy writes through the locked, marked, backed-up writer", () => {
  it("fills the fresh-install placeholder: same marker, typed, no paid_models, no backup, no 'replaced' head", () => {
    writeFileSync(getSettingsPath(), renderDefaultSettingsYaml(), "utf-8");
    const r = writeScoutingProfile(getSettingsPath(), [{ modelId: "cheap/good" }, { modelId: "other/ok" }]);
    expect(r.previousHeadModelId).toBeUndefined();
    const scouting = readProfiles().scouting;
    expect(scouting.model).toBe("cheap/good");
    expect(scouting["profile-type"]).toBe("scouting");
    expect(scouting).not.toHaveProperty("paid_models");
    expect(profileSectionMarkerState(parseDocument(readFileSync(getSettingsPath(), "utf-8")), "scouting")).toBe("marked");
    expect(backups()).toEqual([]);
    markMigrationStepApplied(PROFILE_TYPE_STEP);
    expect(settingsLevelErrors(loadSettings()!)).toEqual([]);
  });

  it("replaces a previously benchmarked head and reports it; the file still loads", () => {
    writeFileSync(getSettingsPath(), renderDefaultSettingsYaml(), "utf-8");
    writeScoutingProfile(getSettingsPath(), [{ modelId: "cheap/good" }]);
    const r = writeScoutingProfile(getSettingsPath(), [{ modelId: "newer/better" }]);
    expect(r.previousHeadModelId).toBe("cheap/good");
    expect(readProfiles().scouting.model).toBe("newer/better");
    expect(backups()).toEqual([]); // marked, so nothing hand-authored is overwritten
  });

  it("on an unmarked legacy section: backs the file up, marks it and leaves no paid_models behind", () => {
    writeFileSync(getSettingsPath(), OLD_SCOUTING, "utf-8");
    const r = writeScoutingProfile(getSettingsPath(), [{ modelId: "new/head" }]);
    expect(r.previousHeadModelId).toBe("old/head");
    expect(backups().length).toBe(1);
    const scouting = readProfiles().scouting;
    expect(scouting.model).toBe("new/head");
    expect(scouting).not.toHaveProperty("paid_models");
    expect(loadSettings()!.unmarkedDynamicProfiles).toEqual([]);
  });
});

describe("PT-04: mass scouting on the placeholder", () => {
  it("refuses with the benchmark hint, not with 'no PASS'", async () => {
    setValidationBypassForTests(true);
    const work = mkdtempSync(join(tmpdir(), "llm-ext-pt04-work-"));
    try {
      writeFileSync(
        join(work, "f.json"),
        JSON.stringify({ version: 1, fieldset_name: "pt04", fields: [{ name: "is_async", description: "true if file uses async/await", type: { kind: "bool" } }] }),
        "utf-8",
      );
      // An active paid profile, so the gate does not delegate to the free pool (that delegation is PT-05's).
      writeFileSync(
        getSettingsPath(),
        stringifyYaml({
          active: "mine",
          allow_paid_models: true,
          profiles: {
            mine: { "profile-type": "paid", mode: "remote", api: "openrouter-remote", api_key: "$OPENROUTER_API_KEY", model: "vendor/mine" },
            // Spelled out, not taken from unpopulatedDefaultProfile: the placeholder shape a fresh install writes.
            scouting: { "profile-type": "scouting", mode: "remote", api: "openrouter-remote", api_key: "$OPENROUTER_API_KEY", model: PLACEHOLDER_MODEL_ID },
          },
        }),
        "utf-8",
      );
      const r = await runMassScoutCli(
        ["scout", "--db", join(work, "s.db"), "--fields-file", join(work, "f.json"), "--job-id", "j1", "--source-root", work],
        { apiKey: "test-key", mainRoot: work },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/no scouting profile — the USER must run: llm-ext benchmark scout-accuracy/);
      expect(r.stderr).not.toMatch(/no PASS/);
    } finally {
      setValidationBypassForTests(false);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
