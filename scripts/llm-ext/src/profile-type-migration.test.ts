// PT-02 (TRDD-IQTF34TC): the migration that writes `profile-type` into every
// profile. Real files in a throwaway llm-ext-* config dir under /tmp, never the
// user's real one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { tmpdir } from "./test-tmp-root.js";
import { localProfileStepIds, migrateSettingsTo141, writeDynamicProfileSection, addProfileToSettings } from "./benchmark/pick.js";
import { isMigrationStepApplied, markMigrationStepApplied } from "./default-profiles-state.js";
import { managedProfileModels } from "./calibration/triggers.js";
import { profileCatalogErrors, selectedChatProfileErrors, settingsCatalogErrors } from "./classifiers/profile-checks.js";
import { readyLocalTarget } from "./network-give-up.js";
import { resolveClassifierProfile } from "./classifiers/l2/profile.js";
import { resolveSessionSummaryChain } from "./session_summary/local-model.js";
import {
  PROFILE_TYPE_STEP,
  DYNAMIC_PROFILE_NAMES,
  formatProfilesList,
  resolveProfile,
  builtinProfileType,
  renderDefaultSettingsYaml,
  unpopulatedDefaultProfile,
  getSettingsPath,
  loadSettings,
  profileTypesSettingsErrors,
  settingsLevelErrors,
  shouldForceFreeMode,
  validateSettings,
} from "./config.js";

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBai: string | undefined;
let notices: string[];

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevBai = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY; // the bai seed step would otherwise rewrite the free section
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-pt02-"));
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

const SETTINGS = [
  "# my own header comment",
  "profiles:",
  "  # my custom paid profile",
  "  mine:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/some-model  # keep this comment",
  "    bogus_field: 1",
  "  frugal:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/x:free",
  "    free_only: true",
  "  lmstudio:",
  "    mode: local",
  "    api: lmstudio-local",
  "    model: qwen",
  "",
].join("\n");

const types = (): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries((parseYaml(readFileSync(getSettingsPath(), "utf-8")) as { profiles: Record<string, { "profile-type"?: string }> }).profiles).map(([n, p]) => [n, p["profile-type"]]));
const backups = (): string[] => (existsSync(join(cfgDir, "backups")) ? readdirSync(join(cfgDir, "backups")).filter((f) => f.includes("profile-type")) : []);

describe("PT-02 profile-type migration", () => {
  it("backs up first, writes the inferred type into every profile, keeps comments, records the step", () => {
    writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
    run();
    expect(types()).toEqual({ mine: "paid", frugal: "free", lmstudio: "local" });
    const after = readFileSync(getSettingsPath(), "utf-8");
    expect(after).toContain("# my own header comment");
    expect(after).toContain("# my custom paid profile");
    expect(after).toContain("model: vendor/some-model # keep this comment");
    const b = backups();
    expect(b).toHaveLength(1);
    expect(readFileSync(join(cfgDir, "backups", b[0]), "utf-8")).toBe(SETTINGS);
    expect(isMigrationStepApplied(PROFILE_TYPE_STEP)).toBe(true);
  });

  it("reports each inferred type and every field PT-06 will reject", () => {
    writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
    run();
    const all = notices.join("\n");
    expect(all).toContain("profiles.mine: profile-type 'paid' (inferred)");
    expect(all).toContain("profiles.frugal: profile-type 'free' (inferred)");
    expect(all).toContain("profiles.lmstudio: profile-type 'local' (inferred)");
    expect(all).toContain("profiles.mine.bogus_field is unknown to every profile type");
  });

  it("is idempotent: a second run changes nothing and takes no second backup", () => {
    writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
    run();
    const once = readFileSync(getSettingsPath(), "utf-8");
    notices.length = 0;
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(once);
    expect(backups()).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it("leaves the file untouched and unrecorded when a type cannot be inferred", () => {
    const bad = SETTINGS.replace("    bogus_field: 1\n", "    bogus_field: 1\n    profile-type: turbo\n");
    writeFileSync(getSettingsPath(), bad, "utf-8");
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(bad);
    expect(backups()).toEqual([]);
    expect(isMigrationStepApplied(PROFILE_TYPE_STEP)).toBe(false);
    expect(notices.join("\n")).toMatch(/left settings\.yaml untouched.*profile-type 'turbo'/);
  });

  it("E81c/E81g: strict load error switches on only after the migration", () => {
    writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
    expect(profileTypesSettingsErrors(loadSettings()!)).toEqual([]);
    run();
    // PT-06: the fixture's bogus_field is rejected from the moment the profile is typed; before the migration nothing is checked.
    expect(profileTypesSettingsErrors(loadSettings()!)).toEqual(["Profile 'mine': profiles.mine.bogus_field is unknown to every profile type. Fix: delete the key"]);
    writeFileSync(getSettingsPath(), readFileSync(getSettingsPath(), "utf-8") + "  later:\n    mode: remote\n    api: openrouter-remote\n    model: a/b\n", "utf-8");
    expect(profileTypesSettingsErrors(loadSettings()!).join("\n")).toMatch(/Profile 'later' has no profile-type/);
  });

  it("E81h: a custom remote profile without free_only is typed paid and bills nothing while allow_paid_models is off", () => {
    writeFileSync(getSettingsPath(), SETTINGS + "allow_paid_models: false\n", "utf-8");
    run();
    const s = loadSettings()!;
    expect(s.allow_paid_models).toBe(false);
    const type = types().mine as "paid";
    expect(type).toBe("paid");
    expect(shouldForceFreeMode(s.allow_paid_models === true, "remote", type)).toBe(true);
  });
});

describe("pt-02 writers: a section llm-ext creates carries its built-in profile-type, so E81g never rejects a file llm-ext wrote", () => {
  for (const name of DYNAMIC_PROFILE_NAMES) {
    it(`writeDynamicProfileSection creates profiles.${name} with profile-type ${builtinProfileType(name)}`, () => {
      writeFileSync(getSettingsPath(), "allow_paid_models: false\nprofiles: {}\n", "utf-8");
      writeDynamicProfileSection(getSettingsPath(), name, () => unpopulatedDefaultProfile(name), { notify: vi.fn() });
      const parsed = parseYaml(readFileSync(getSettingsPath(), "utf-8")) as { profiles: Record<string, { "profile-type"?: string }> };
      expect(parsed.profiles[name]["profile-type"]).toBe(builtinProfileType(name));
    });
  }
});


describe("pt-02 writers: the other places llm-ext writes a profile also write its type", () => {
  it("addProfileToSettings stamps the inferred type on a profile it adds (free by free_only, local by mode)", () => {
    writeFileSync(getSettingsPath(), "profiles: {}\n", "utf-8");
    // PT-04: `scouting` is a marked built-in now written only by writeDynamicProfileSection, so the by-name arm of the inference is covered in scouting-template.test.ts; a custom free_only profile covers the by-field arm here.
    addProfileToSettings(getSettingsPath(), "my-free", { mode: "remote", api: "openrouter-remote", api_key: "$OPENROUTER_API_KEY", model: "vendor/m:free", free_only: true, free_models: ["vendor/m:free"] }); // ubs:ignore -- "$OPENROUTER_API_KEY" is an env-var placeholder, not a secret
    addProfileToSettings(getSettingsPath(), "my-local", { mode: "local", api: "generic-local", model: "m", url: "http://127.0.0.1:1" });
    const parsed = parseYaml(readFileSync(getSettingsPath(), "utf-8")) as { profiles: Record<string, { "profile-type"?: string }> };
    expect(parsed.profiles["my-free"]["profile-type"]).toBe("free");
    expect(parsed.profiles["my-local"]["profile-type"]).toBe("local");
  });

  it("a freshly rendered default settings.yaml has no E81g even after the migration step was recorded", () => {
    writeFileSync(getSettingsPath(), renderDefaultSettingsYaml(), "utf-8");
    markMigrationStepApplied(PROFILE_TYPE_STEP);
    const s = loadSettings();
    expect(s?.profileTypesMigrated).toBe(true);
    expect(profileTypesSettingsErrors(s!)).toEqual([]);
  });
});

describe("PT-02 restore: an untyped settings.yaml after the step was recorded is stamped again, never a lockout", () => {
  it("restoring the step's own backup: the next run re-stamps it, the load has no E81g, and the restore is reported as applied", () => {
    writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
    run();
    const backup = backups()[0];
    writeFileSync(getSettingsPath(), readFileSync(join(cfgDir, "backups", backup), "utf-8"), "utf-8");
    expect(types()).toEqual({ mine: undefined, frugal: undefined, lmstudio: undefined });
    expect(profileTypesSettingsErrors(loadSettings()!).join("\n")).toMatch(/Profile 'mine' has no profile-type/);
    notices.length = 0;
    const result = run();
    expect(types()).toEqual({ mine: "paid", frugal: "free", lmstudio: "local" });
    // PT-06: the fixture's bogus_field is now a strict-field error; the point here is that no E81g remains.
    expect(profileTypesSettingsErrors(loadSettings()!)).toEqual(["Profile 'mine': profiles.mine.bogus_field is unknown to every profile type. Fix: delete the key"]);
    expect(result.applied).toContain(PROFILE_TYPE_STEP); // index.ts re-reads the settings only when something applied
    expect(notices.join("\n")).toContain("profiles.mine: profile-type 'paid' (inferred)");
  });

  it("a recorded step does not re-report PT-06 field issues of a typed file", () => {
    writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
    run();
    notices.length = 0;
    run();
    expect(notices).toEqual([]);
  });

  it("an invalid explicit type after the step was recorded still leaves the file untouched and reports", () => {
    markMigrationStepApplied(PROFILE_TYPE_STEP);
    const bad = SETTINGS.replace("    bogus_field: 1\n", "    bogus_field: 1\n    profile-type: turbo\n");
    writeFileSync(getSettingsPath(), bad, "utf-8");
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(bad);
    expect(notices.join("\n")).toMatch(/left settings\.yaml untouched.*profile-type 'turbo'/);
  });
});

describe("PT-02 profile-type backup dedupe", () => {
  const runAt = (i: number): void => {
    // a minute apart, so a missing dedupe cannot hide behind one backup file name per second
    migrateSettingsTo141(getSettingsPath(), { notify: (m) => notices.push(m), isApplied: isMigrationStepApplied, markApplied: markMigrationStepApplied, nowMs: Date.now() + i * 60_000 });
  };

  it("F1: a file that keeps reverting to the untyped content leaves exactly one profile-type backup", () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
      runAt(i);
    }
    expect(backups()).toHaveLength(1);
  });

  it("F2: a directory with the backup prefix in the backups dir does not abort the migration", () => {
    mkdirSync(join(cfgDir, "backups", "settings-before-14.1-profile-type-old.yaml"), { recursive: true });
    writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
    runAt(0);
    expect(types()).toEqual({ mine: "paid", frugal: "free", lmstudio: "local" });
    expect(backups().filter((f) => !f.endsWith("-old.yaml"))).toHaveLength(1);
  });

  it("F3: the notice claims a backup exists, true also when the write was deduped", () => {
    for (let i = 0; i < 2; i++) {
      writeFileSync(getSettingsPath(), SETTINGS, "utf-8");
      runAt(i);
    }
    expect(backups()).toHaveLength(1);
    expect(notices.join("\n")).not.toContain("was saved first");
  });
});

// GG44R65K: a profile entry that is not a YAML map used to be skipped silently, so the load passed unless it was the active profile.
describe("GG44R65K non-map profile entries fail the load naming the profile", () => {
  const SHAPES: Array<[string, string, string]> = [
    ["null (empty value)", "  foo:", "null"],
    ["a number", "  foo: 3", "number"],
    ["a string", "  foo: \"x\"", "string"],
    ["an array", "  foo: [1]", "array"],
  ];
  for (const recorded of [false, true]) {
    for (const [label, line, got] of SHAPES) {
      it(`${label}: error names the profile and says "is not a map" (profile-type migration recorded: ${recorded})`, () => {
        writeFileSync(getSettingsPath(), SETTINGS.replace("  lmstudio:", `${line}\n  lmstudio:`), "utf-8");
        if (recorded) markMigrationStepApplied(PROFILE_TYPE_STEP);
        const errors = profileTypesSettingsErrors(loadSettings()!);
        const mine = errors.filter((e) => e.startsWith("Profile 'foo' is not a map"));
        expect(mine).toHaveLength(1);
        expect(mine[0]).toContain(`(got ${got})`);
        expect(errors.join("\n")).not.toContain("Profile 'foo' has no profile-type");
      });
    }
  }

  it("the settings-level load errors carry it too, and the calibration boot check no longer throws on a null entry", () => {
    writeFileSync(getSettingsPath(), SETTINGS.replace("  lmstudio:", "  foo:\n  lmstudio:"), "utf-8");
    const s = loadSettings()!;
    expect(settingsLevelErrors(s).join("\n")).toContain("Profile 'foo' is not a map");
    expect(() => managedProfileModels(s.profiles)).not.toThrow();
  });

  it("a fallback_to_local pin naming a null entry reports it as not a map instead of throwing", () => {
    writeFileSync(getSettingsPath(), SETTINGS.replace("  lmstudio:", "  foo:\n  lmstudio:") + "fallback_to_local:\n  profile: foo\n", "utf-8");
    expect(settingsLevelErrors(loadSettings()!).join("\n")).toContain("Profile 'foo' is not a map");
  });

  // validateSettings is the real load gate: the not-a-map error must reach it for a non-active profile (previously the load passed) and for the active one (previously only a misleading "missing required field"/"not found").
  for (const [label, line] of [["null", "  foo:"], ["0", "  foo: 0"], ["an empty string", "  foo: \"\""], ["false", "  foo: false"], ["a number", "  foo: 3"], ["a string", "  foo: \"x\""], ["an array", "  foo: [1]"]] as const) {
    it(`validateSettings fails with "is not a map" when the non-map ${label} entry is not active and when it is active`, () => {
      const text = SETTINGS.replace("  lmstudio:", `${line}\n  lmstudio:`);
      writeFileSync(getSettingsPath(), "active: lmstudio\n" + text, "utf-8");
      const inactive = validateSettings(loadSettings()!);
      expect(inactive.valid).toBe(false);
      expect(inactive.errors.join("\n")).toContain("Profile 'foo' is not a map");
      writeFileSync(getSettingsPath(), "active: foo\n" + text, "utf-8");
      const active = validateSettings(loadSettings()!);
      expect(active.valid).toBe(false);
      expect(active.errors.join("\n")).toContain("Profile 'foo' is not a map");
    });
  }
});

// GG44R65K follow-up: the consumers that still read fields of a non-map entry after the load reported it.
describe("GG44R65K non-map profile entries do not crash the settings list or the catalog checks", () => {
  const NO_NETWORK = async (): Promise<Response> => {
    throw new Error("no network call expected for a non-map entry");
  };
  const withNullEntry = (): void => {
    writeFileSync(getSettingsPath(), "active: lmstudio\n" + SETTINGS.replace("  lmstudio:", "  foo:\n  lmstudio:"), "utf-8");
  };

  it("formatProfilesList prints the null entry as not a map and still lists the other profiles", () => {
    withNullEntry();
    let text = "";
    expect(() => {
      text = formatProfilesList("lmstudio").text;
    }).not.toThrow();
    expect(text).toContain("Profile 'foo' is not a map");
    expect(text).toContain("(got null)");
    expect(text).toContain("lmstudio");
  });

  for (const [label, line, got] of [["a number", "  foo: 3", "number"], ["an array", "  foo: [1]", "array"]] as const) {
    it(`formatProfilesList names ${label} entry as not a map (got ${got})`, () => {
      writeFileSync(getSettingsPath(), "active: lmstudio\n" + SETTINGS.replace("  lmstudio:", `${line}\n  lmstudio:`), "utf-8");
      expect(formatProfilesList("lmstudio").text).toContain(`Profile 'foo' is not a map: every entry under profiles: must be a YAML mapping of fields (got ${got})`);
    });
  }

  it("profileCatalogErrors skips a null entry instead of throwing", async () => {
    withNullEntry();
    await expect(profileCatalogErrors(loadSettings()!, "foo", NO_NETWORK)).resolves.toEqual([]);
  });

  it("selectedChatProfileErrors skips a null entry instead of throwing", async () => {
    withNullEntry();
    await expect(selectedChatProfileErrors(loadSettings()!, "foo", ["free", "paid", "local"], NO_NETWORK)).resolves.toEqual([]);
  });

  // model-reconcile.ts:560 and free-rotation.ts:449 call resolveProfile on a truthy active entry; a scalar must fail with a plain Error (free-rotation catches it, model-reconcile's caller reports it), not with a property-of-null TypeError.
  it("resolveProfile on a scalar or array entry throws a plain Error naming the api preset, not a TypeError", () => {
    for (const bad of [3, "x", [1]]) {
      let caught: unknown;
      try {
        resolveProfile("foo", bad as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(TypeError);
      expect((caught as Error).message).toContain("Unknown api preset");
    }
  });

  it("settingsCatalogErrors walks every profile of a file with a null entry without throwing", async () => {
    withNullEntry();
    await expect(settingsCatalogErrors(loadSettings()!, NO_NETWORK)).resolves.toEqual([]);
  });

  // index.ts evaluateSettingsValidity reads this null active entry and hands it to shouldBootDespiteInvalidActiveProfile only when settingsLevelErrors is empty; the dynamic name `free` is the one case where that call would throw on null.
  it("a null active entry under a dynamic profile name is a settings-level error, so the boot exemption never sees it", () => {
    writeFileSync(getSettingsPath(), "active: free\n" + SETTINGS.replace("  lmstudio:", "  free:\n  lmstudio:"), "utf-8");
    expect(settingsLevelErrors(loadSettings()!).join("\n")).toContain("Profile 'free' is not a map");
  });

  it("readyLocalTarget skips a null local_llama / locals-mlx entry instead of throwing", () => {
    writeFileSync(getSettingsPath(), "active: lmstudio\nfallback_to_local:\n  enabled: true\n" + SETTINGS.replace("  lmstudio:", "  local_llama:\n  locals-mlx:\n  lmstudio:"), "utf-8");
    expect(readyLocalTarget(loadSettings()!, cfgDir)).toBeUndefined();
  });

  it("resolveClassifierProfile on a null entry returns an error result instead of throwing", () => {
    withNullEntry();
    let result: ReturnType<typeof resolveClassifierProfile> | undefined;
    expect(() => {
      result = resolveClassifierProfile({ settings: loadSettings()!, profileFlag: "foo", command: "classify" });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  it("resolveSessionSummaryChain skips a null local_llama / locals-mlx entry instead of throwing a TypeError", async () => {
    writeFileSync(getSettingsPath(), "active: lmstudio\n" + SETTINGS.replace("  lmstudio:", "  local_llama:\n  locals-mlx:\n  lmstudio:"), "utf-8");
    let caught: unknown;
    try {
      await resolveSessionSummaryChain({
        active: null,
        profiles: loadSettings()!.profiles,
        dir: cfgDir,
        slotCtx: (n) => n,
        selectRemote: async () => [],
        depsFor: () => {
          throw new Error("no local model expected");
        },
        startCalibrationRunner: async () => undefined,
        waitForCalibration: async () => undefined,
        write: () => undefined,
      });
    } catch (e) {
      caught = e;
    }
    // With no usable candidate the chain ends on the "no model" Error of the remote step; a TypeError would mean the null entry was read.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
  });
});
