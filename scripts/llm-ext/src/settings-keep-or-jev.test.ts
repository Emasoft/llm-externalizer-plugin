// TRDD-IO0B25CV: every writer that rewrites settings.yaml keeps a user's `or-jev` classifier profile and its `active_classifier: or-jev` line.
// WHY: on 2026-11-11 the real settings.yaml lost both after a rewrite and `classify` refused to run; no test pinned this per writer.
// Real files in a throwaway config dir under /tmp, never the user's real one; no mocking of any writer.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { tmpdir } from "./test-tmp-root.js";
import {
  addProfileToSettings,
  applyEnsembleSlotToSettings,
  applyFreePoolToSettings,
  applyPicksToSettings,
  applyToolModelToSettings,
  dropKeysOutsideClosedSet,
  localProfileStepIds,
  migrateProfileSections,
  migrateSettingsTo141,
  writeDynamicProfileSection,
  writeDynamicUserKeys,
} from "./benchmark/pick.js";
import { isMigrationStepApplied, markMigrationStepApplied } from "./default-profiles-state.js";
import { regenerateInvalidMarkedSection } from "./dynamic-maintainer.js";
import { registeredTools } from "./model-qualification/registry.js";
import { GENERATED_MARKER, ensureSettingsExist, getSettingsPath, loadSettings, unpopulatedDefaultProfile, type Profile } from "./config.js";

const OR_JEV_LINES = [
  "  # my classifier, tuned",
  "  or-jev:",
  "    profile-type: classifier",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: typesafe/jev-1.13",
  "    concurrency: 4",
];
const MINE_LINES = [
  "  mine:",
  "    profile-type: paid",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/mine",
];
const MARKED_FREE_LINES = [
  `  # ${GENERATED_MARKER}`,
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models: [a/one:free]",
  "    model: a/one:free",
  "    api_key: $OPENROUTER_API_KEY",
];
// Invalid on purpose (remote-ensemble with one model): the shape regenerateInvalidMarkedSection repairs.
const INVALID_MARKED_FREE_LINES = MARKED_FREE_LINES.map((l) => (l === "    mode: remote" ? "    mode: remote-ensemble" : l));
// Hand-authored (no marker): the shape migrateProfileSections backs up and regenerates.
const UNMARKED_FREE_LINES = ["  free:", "    mode: remote", "    api: openrouter-remote", "    free_only: true", "    free_models: [hand/made:free]", "    model: hand/made:free", "    api_key: $OPENROUTER_API_KEY"];

const fixture = (freeLines: string[]): string =>
  ["# my header", "active: free", "active_classifier: or-jev", "profiles:", ...freeLines, ...MINE_LINES, ...OR_JEV_LINES, ""].join("\n");

type Root = { active_classifier?: string; profiles: Record<string, Record<string, unknown>> };
const readRoot = (): Root => parseYaml(readFileSync(getSettingsPath(), "utf-8")) as Root;
const ORIGINAL_OR_JEV = (parseYaml(fixture(MARKED_FREE_LINES)) as Root).profiles["or-jev"];

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBai: string | undefined;
let prevOr: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevBai = process.env.BAI_API_KEY;
  prevOr = process.env.OPENROUTER_API_KEY;
  delete process.env.BAI_API_KEY; // the bai seed step would otherwise rewrite the free section
  process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one"; // a credential gap is not a regeneration trigger
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-keep-orjev-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  // These tests exercise other writers; the built-in local-profile steps have their own tests (local-profiles-builtin.test.ts).
  for (const step of localProfileStepIds()) markMigrationStepApplied(step);
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevBai === undefined) delete process.env.BAI_API_KEY;
  else process.env.BAI_API_KEY = prevBai;
  if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = prevOr;
  rmSync(cfgDir, { recursive: true, force: true });
});

/** Raw text of the last seed(): a writer test must see the file differ from it, so a writer that silently did nothing cannot pass. */
let seeded = "";

/**
 * The assertion shared by every case: the file still parses and loads, or-jev is field-for-field unchanged, active_classifier is still or-jev.
 * `writerChangesFile: false` is for the cases whose subject is a no-op by design (a valid file left alone, a migration with nothing to do).
 */
function expectOrJevKept(opts: { writerChangesFile?: boolean } = {}): void {
  const root = readRoot();
  expect(root.profiles["or-jev"]).toEqual(ORIGINAL_OR_JEV);
  expect(root.profiles["or-jev"]).toMatchObject({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$OPENROUTER_API_KEY" });
  expect(root.active_classifier).toBe("or-jev");
  expect(readFileSync(getSettingsPath(), "utf-8")).toContain("# my classifier, tuned");
  expect(loadSettings()).not.toBeNull();
  if (opts.writerChangesFile !== false) expect(readFileSync(getSettingsPath(), "utf-8")).not.toBe(seeded);
}

const seed = (freeLines: string[] = MARKED_FREE_LINES): void => {
  seeded = fixture(freeLines);
  writeFileSync(getSettingsPath(), seeded, "utf-8");
};
const aProfile = (over: Record<string, unknown>): Profile => ({ ...unpopulatedDefaultProfile("free"), ...over }) as Profile;

describe("dynamic-section writers keep or-jev and active_classifier", () => {
  it("writeDynamicProfileSection rewrites the free pool and leaves or-jev alone", () => {
    seed();
    const r = writeDynamicProfileSection(getSettingsPath(), "free", (cur) => aProfile({ ...cur, free_models: ["b/two:free"], model: "b/two:free" }), { notify: () => {} });
    expect(r.changed).toBe(true);
    expect(readRoot().profiles.free.free_models).toEqual(["b/two:free"]);
    expectOrJevKept();
  });

  it.each(["paid", "local", "scouting"] as const)("writeDynamicProfileSection creates the %s section and leaves or-jev alone", (name) => {
    seed();
    const r = writeDynamicProfileSection(getSettingsPath(), name, () => unpopulatedDefaultProfile(name), { notify: () => {} });
    expect(r.changed).toBe(true);
    expect(readRoot().profiles).toHaveProperty(name);
    expectOrJevKept();
  });

  it("writeDynamicUserKeys writes a user-owned key on free and leaves or-jev alone", () => {
    seed();
    writeDynamicUserKeys(getSettingsPath(), "free", (cur) => ({ ...(cur as Profile), selection: "first" }) as Profile);
    expect(readRoot().profiles.free.selection).toBe("first");
    expectOrJevKept();
  });

  it("dropKeysOutsideClosedSet strips a stray free key and leaves or-jev alone", () => {
    seed([...MARKED_FREE_LINES, "    stray_key: 1"]);
    expect(dropKeysOutsideClosedSet(getSettingsPath(), "free")).toEqual(["stray_key"]);
    expectOrJevKept();
  });

  it("regenerateInvalidMarkedSection backs up and regenerates an invalid marked free section and leaves or-jev alone", () => {
    seed(INVALID_MARKED_FREE_LINES);
    const current = readRoot().profiles.free as unknown as Profile;
    const out = regenerateInvalidMarkedSection({ name: "free", settingsPath: getSettingsPath(), current, nowMs: Date.now() });
    expect(out.kind).toBe("regenerated");
    expect(readRoot().profiles.free.model).toBe(unpopulatedDefaultProfile("free").model);
    expectOrJevKept();
  });

  it("migrateProfileSections backs up and regenerates a hand-authored free section and leaves or-jev alone", () => {
    seed(UNMARKED_FREE_LINES);
    let stamp: number | undefined;
    const r = migrateProfileSections(getSettingsPath(), { notify: () => {}, readStamp: () => stamp, writeStamp: (n) => { stamp = n; return null; } });
    expect(r.regenerated).toEqual(["free"]);
    expect(existsSync(join(cfgDir, "backups"))).toBe(true);
    expectOrJevKept();
  });

  it("migrateSettingsTo141 runs all eight steps (incl. or-jev-section-added) on a file that already has or-jev and leaves or-jev alone", () => {
    seed();
    const r = migrateSettingsTo141(getSettingsPath(), { notify: () => {}, isApplied: isMigrationStepApplied, markApplied: markMigrationStepApplied });
    // The local-profile steps are pre-marked applied in beforeEach; these eight are what ran, pinned so a change to the step list is noticed here.
    expect(r.applied).toEqual([
      "price-ceiling-into-paid",
      "local-detected-providers",
      "bai-binding-to-reserved-slot",
      "bai-reserved-seed",
      "dynamic-unknown-keys",
      "scouting-section-marked",
      "or-jev-section-added",
      "profile-type-written",
    ]);
    expectOrJevKept();
  });
});

describe("static-profile writers keep or-jev and active_classifier", () => {
  const pick = (modelId: string) => ({ modelId, meanF1: 1, actualCost: 0, latencyMs: 1, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 });
  it.each([
    ["applyPicksToSettings", () => applyPicksToSettings(getSettingsPath(), "mine", [pick("vendor/new")])],
    ["applyEnsembleSlotToSettings", () => applyEnsembleSlotToSettings(getSettingsPath(), "mine", "model", "vendor/other")],
    ["applyToolModelToSettings", () => applyToolModelToSettings(getSettingsPath(), "mine", registeredTools()[0], "vendor/tool")],
    ["applyFreePoolToSettings", () => applyFreePoolToSettings(getSettingsPath(), "mine", ["x/y:free"])],
    ["addProfileToSettings", () => addProfileToSettings(getSettingsPath(), "added", { mode: "remote", api: "openrouter-remote", model: "v/a", api_key: "$OPENROUTER_API_KEY" })],
  ])("%s rewrites its own profile and leaves or-jev alone", (_name, write) => {
    seed();
    write();
    expectOrJevKept();
  });
});

describe("ensureSettingsExist keeps or-jev", () => {
  it("a valid file holding or-jev and active_classifier is left byte-identical", () => {
    seed();
    const before = readFileSync(getSettingsPath(), "utf-8");
    ensureSettingsExist();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(before);
    expect(readdirSync(cfgDir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
    expectOrJevKept({ writerChangesFile: false });
  });

  it("a corrupt file is REPLACED by the default template, not preserved: the user's original (customised or-jev included) survives only in the .corrupt- backup", () => {
    // Documents replacement-with-backup (ensureSettingsExist regenerates the whole file): the regenerated or-jev is the shipped template, never the user's version; that version is recoverable by hand from the backup only.
    const corrupt = fixture(MARKED_FREE_LINES) + "  broken: [unclosed\n";
    writeFileSync(getSettingsPath(), corrupt, "utf-8");
    ensureSettingsExist();
    const backups = readdirSync(cfgDir).filter((f) => f.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(cfgDir, backups[0]), "utf-8")).toBe(corrupt);
    const root = readRoot();
    expect(root.profiles["or-jev"]).toMatchObject({ "profile-type": "classifier", api: "openrouter-remote" });
    expect(root.profiles["or-jev"]).not.toEqual(ORIGINAL_OR_JEV);
    expect(root.active_classifier).toBe("or-jev");
  });
});

describe("the shared assertion can fail (negative controls)", () => {
  it("expectOrJevKept throws when or-jev is gone from the file", () => {
    writeFileSync(getSettingsPath(), ["active_classifier: or-jev", "profiles:", ...MINE_LINES, ""].join("\n"), "utf-8");
    expect(expectOrJevKept).toThrow();
  });

  it("expectOrJevKept throws when active_classifier is gone from the file", () => {
    writeFileSync(getSettingsPath(), fixture(MARKED_FREE_LINES).replace("active_classifier: or-jev\n", ""), "utf-8");
    expect(expectOrJevKept).toThrow();
  });

  it("expectOrJevKept throws when an or-jev field was changed", () => {
    writeFileSync(getSettingsPath(), fixture(MARKED_FREE_LINES).replace("typesafe/jev-1.13", "typesafe/other"), "utf-8");
    expect(expectOrJevKept).toThrow();
  });
});
