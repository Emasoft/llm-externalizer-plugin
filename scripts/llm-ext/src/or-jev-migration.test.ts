// PF-04 (TRDD-4GZJL3NH, E83): the migration step that gives an existing install the built-in `or-jev`
// classifier profile. Real files in a throwaway config dir under /tmp, never the user's real one; no mocking.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { tmpdir } from "./test-tmp-root.js";
import { migrateSettingsTo141 } from "./benchmark/pick.js";
import { isMigrationStepApplied, markMigrationStepApplied } from "./default-profiles-state.js";
import {
  GENERATED_MARKER,
  formatProfilesList,
  getSettingsPath,
  hasNoTextProfile,
  loadSettings,
  orJevProfile,
  settingsLevelErrors,
  unpopulatedDefaultProfile,
  validateClassifierProfile,
  type Profile,
} from "./config.js";

const STEP = "or-jev-section-added";

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBai: string | undefined;
let notices: string[];

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevBai = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY; // the bai seed step would otherwise rewrite the free section
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-pf04-"));
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

const run = (nowMs?: number): ReturnType<typeof migrateSettingsTo141> =>
  migrateSettingsTo141(getSettingsPath(), { notify: (m) => notices.push(m), isApplied: isMigrationStepApplied, markApplied: markMigrationStepApplied, nowMs });

const readRoot = (): { active_classifier?: string; profiles: Record<string, Record<string, unknown>> } => parseYaml(readFileSync(getSettingsPath(), "utf-8"));
const orJevBackups = (): string[] => (existsSync(join(cfgDir, "backups")) ? readdirSync(join(cfgDir, "backups")).filter((f) => f.includes("-or-jev-")) : []);

const WITHOUT_OR_JEV = [
  "# my header",
  "profiles:",
  "  # my own profile",
  "  mine:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/mine # keep this",
  "",
].join("\n");

describe("PF-04: a file without or-jev gets the template, once", () => {
  it("adds a marked, typed or-jev and active_classifier, backs up first, keeps every other byte, and the file loads", () => {
    writeFileSync(getSettingsPath(), WITHOUT_OR_JEV, "utf-8");
    run();
    const raw = readFileSync(getSettingsPath(), "utf-8");
    const root = readRoot();
    expect(root.profiles["or-jev"]).toMatchObject({ "profile-type": "classifier", api: "openrouter-remote", model: "~typesafe/jev-latest", api_key: "$OPENROUTER_API_KEY" });
    expect(root.active_classifier).toBe("or-jev");
    expect(raw).toContain(`# ${GENERATED_MARKER}`);
    // comment-preserving: the user's comments survive
    expect(raw).toContain("# my header");
    expect(raw).toContain("# my own profile");
    expect(raw).toContain("model: vendor/mine # keep this");
    // byte diff: apart from the later type step stamping `mine`, the original text is a prefix of the result
    const withoutMineType = raw.split("\n").filter((l) => l !== "    profile-type: paid").join("\n");
    expect(withoutMineType.startsWith(WITHOUT_OR_JEV)).toBe(true);
    const backup = orJevBackups();
    expect(backup).toHaveLength(1);
    expect(readFileSync(join(cfgDir, "backups", backup[0]), "utf-8")).toBe(WITHOUT_OR_JEV);
    expect(notices.join("\n")).toContain(join(cfgDir, "backups"));
    expect(isMigrationStepApplied(STEP)).toBe(true);
    const s = loadSettings()!;
    expect(s.unmarkedDynamicProfiles).toEqual([]);
    expect(settingsLevelErrors(s)).toEqual([]);
  });

  it("keeps an active_classifier the user already set", () => {
    writeFileSync(getSettingsPath(), `active_classifier: mine\n${WITHOUT_OR_JEV}`, "utf-8");
    run();
    expect(readRoot().active_classifier).toBe("mine");
    expect(readRoot().profiles).toHaveProperty("or-jev");
  });

  it("is idempotent: a second pass changes nothing and adds no backup or notice", () => {
    writeFileSync(getSettingsPath(), WITHOUT_OR_JEV, "utf-8");
    run();
    const once = readFileSync(getSettingsPath(), "utf-8");
    const n = orJevBackups().length;
    notices.length = 0;
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(once);
    expect(orJevBackups()).toHaveLength(n);
    expect(notices).toEqual([]);
  });

  it("does not bring back an or-jev the user removed after the step was recorded", () => {
    writeFileSync(getSettingsPath(), WITHOUT_OR_JEV, "utf-8");
    markMigrationStepApplied(STEP);
    run();
    expect(readRoot().profiles).not.toHaveProperty("or-jev");
  });
});

// PF-04 / plan E83: "user already has a profile named `or-jev` | migration leaves it, warns". settings.yaml stays BYTE-IDENTICAL.
const CLASSIFIER = [
  "# my header",
  "profiles:",
  "  mine:",
  "    profile-type: paid",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/mine",
  "  # my classifier, tuned",
  "  or-jev:  # keep",
  "    profile-type: classifier",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: typesafe/jev-1.13",
  "    concurrency: 4",
  "  # trailing comment",
  "",
].join("\n");
const CHAT = [
  "active: or-jev",
  "profiles:",
  "  # my chat profile",
  "  or-jev:",
  "    profile-type: paid",
  "    mode: remote",
  "    api: openrouter-remote",
  "    url: https://openrouter.ai/api",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: vendor/chat",
  "    timeout: 90",
  "",
].join("\n");
const CHAT_UNTYPED = CHAT.replace("    profile-type: paid\n", "");
const stepNotices = (): string[] => notices.filter((m) => m.includes(`'${STEP}' migration`));

describe("PF-04 E83: an or-jev the user already has is left byte-identical, with one warning", () => {
  it.each([["(a) a valid classifier profile, with comments around it", CLASSIFIER], ["(b) a chat-type profile", CHAT]])("%s", (_n, content) => {
    writeFileSync(getSettingsPath(), content, "utf-8");
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(content);
    expect(orJevBackups()).toEqual([]);
    expect(existsSync(join(cfgDir, "backups"))).toBe(false);
    const w = stepNotices();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'or-jev'");
    expect(w[0]).toContain("left settings.yaml untouched");
    expect(w[0]).toContain("profile-type: classifier, api: openrouter-remote, a model, and api_key as a $VAR reference");
    expect(isMigrationStepApplied(STEP)).toBe(true);
  });

  it("does not add active_classifier (the plan is silent) and says how to select a matching profile", () => {
    writeFileSync(getSettingsPath(), CLASSIFIER, "utf-8");
    run();
    expect(readRoot().active_classifier).toBeUndefined();
    expect(stepNotices()[0]).toContain("set 'active_classifier: or-jev'");
  });

  it("warns once: later runs write nothing and say nothing", () => {
    writeFileSync(getSettingsPath(), CLASSIFIER, "utf-8");
    run();
    notices.length = 0;
    run();
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(CLASSIFIER);
    expect(notices).toEqual([]);
  });

  it("a restored file with its or-jev is left alone again (the step is recorded)", () => {
    writeFileSync(getSettingsPath(), CHAT, "utf-8");
    run();
    writeFileSync(getSettingsPath(), CLASSIFIER, "utf-8");
    notices.length = 0;
    run();
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(CLASSIFIER);
    expect(stepNotices()).toEqual([]);
  });
});

describe("PF-04 E83: what loads after the migration", () => {
  it("a valid unmarked classifier or-jev LOADS: no reserved-name refusal, no settings-level error", () => {
    writeFileSync(getSettingsPath(), CLASSIFIER, "utf-8");
    run();
    const s = loadSettings()!;
    expect(s.unmarkedDynamicProfiles).toEqual([]);
    expect(settingsLevelErrors(s)).toEqual([]);
    expect(validateClassifierProfile("or-jev", s.profiles["or-jev"])).toEqual([]);
  });

  it("an unmarked or-jev with a typo'd key fails with the classifier field table's message, not the generated-key one", () => {
    writeFileSync(getSettingsPath(), CLASSIFIER.replace("    concurrency: 4", "    concurency: 4"), "utf-8");
    run();
    const text = settingsLevelErrors(loadSettings()!).join("\n");
    expect(text).toContain("profiles.or-jev.concurency is unknown to every profile type");
    expect(text).not.toContain("generated profile");
  });

  it("a chat-typed or-jev fails the load (E113) and the message says to rename it or make it a classifier profile", () => {
    writeFileSync(getSettingsPath(), CHAT, "utf-8");
    run();
    const text = settingsLevelErrors(loadSettings()!).join("\n");
    expect(text).toContain("Profile 'or-jev': built-in profile 'or-jev' has the fixed profile-type 'classifier', not 'paid'");
    expect(text).toMatch(/Fix: rename the profile to another name in settings\.yaml \(and in 'active:' or '--profile' if they name it\), or make it a 'classifier' profile\./);
  });

  it("an untyped chat or-jev is typed by its fields (paid), never 'classifier' by its name, and the file is otherwise untouched", () => {
    writeFileSync(getSettingsPath(), CHAT_UNTYPED, "utf-8");
    run();
    const root = readRoot();
    expect(root.profiles["or-jev"]["profile-type"]).toBe("paid");
    const after = readFileSync(getSettingsPath(), "utf-8");
    expect(after.split("\n").filter((l) => l !== "    profile-type: paid").join("\n")).toBe(CHAT_UNTYPED);
    expect(settingsLevelErrors(loadSettings()!).join("\n")).toContain("fixed profile-type 'classifier', not 'paid'");
  });
});

describe("PF-04 review: files without a profiles map, and a deleted or-jev", () => {
  it.each([["no profiles key", "active: free\n"], ["profiles: {}", "profiles: {}\n"], ["profiles: (null)", "profiles:\n"], ["empty file", ""]])("%s ends loadable with the template", (_n, content) => {
    writeFileSync(getSettingsPath(), content, "utf-8");
    run();
    expect(readRoot().profiles["or-jev"]).toMatchObject({ "profile-type": "classifier" });
    const s = loadSettings()!;
    expect(s.unmarkedDynamicProfiles).toEqual([]);
    expect(settingsLevelErrors(s)).toEqual([]);
  });

  it("or-jev deleted after the step was recorded while active_classifier: or-jev remains: the load error names the key and the fix", () => {
    writeFileSync(getSettingsPath(), "active_classifier: or-jev\n" + WITHOUT_OR_JEV, "utf-8");
    markMigrationStepApplied(STEP);
    run();
    const text = settingsLevelErrors(loadSettings()!).join("\n");
    expect(text).toContain("active_classifier names profile 'or-jev'");
    expect(text).toMatch(/delete the 'active_classifier:' line.*another classifier profile/i);
  });

  it("the absent-branch notice says where the backup is, like the other steps", () => {
    writeFileSync(getSettingsPath(), WITHOUT_OR_JEV, "utf-8");
    run();
    expect(notices.join("\n")).toContain(`a backup of settings.yaml exists in ${join(cfgDir, "backups")}`.replace("a backup", "A backup"));
    expect(notices.join("\n")).not.toContain("was saved first");
  });
});


describe("PF-04 review: active_classifier is placed right after active:", () => {
  it("goes on the line after `active:` (its comment kept), before profiles:", () => {
    writeFileSync(getSettingsPath(), "# top\nactive: mine # keep\nallow_paid_models: false\n" + WITHOUT_OR_JEV, "utf-8");
    run();
    const raw = readFileSync(getSettingsPath(), "utf-8");
    expect(raw.startsWith("# top\nactive: mine # keep\nactive_classifier: or-jev\nallow_paid_models: false\n")).toBe(true);
    expect(raw.indexOf("active_classifier:")).toBeLessThan(raw.indexOf("profiles:"));
    expect(readRoot().active_classifier).toBe("or-jev");
  });

  it("without an active: key it is appended (the only place left)", () => {
    writeFileSync(getSettingsPath(), WITHOUT_OR_JEV, "utf-8");
    run();
    expect(readFileSync(getSettingsPath(), "utf-8").trimEnd().endsWith("active_classifier: or-jev")).toBe(true);
  });
});

describe("PF-04 review: the classifier profile never counts as a text profile", () => {
  const p = (o: Record<string, unknown>): Profile => o as unknown as Profile;
  it("hasNoTextProfile: or-jev alone or with scouting is 'no text profile'; local, free, paid or an untyped chat profile is not", () => {
    expect(hasNoTextProfile({})).toBe(true);
    expect(hasNoTextProfile({ "or-jev": orJevProfile() })).toBe(true);
    expect(hasNoTextProfile({ "or-jev": orJevProfile(), scouting: unpopulatedDefaultProfile("scouting") })).toBe(true);
    for (const text of ["free", "paid", "local"] as const) expect(hasNoTextProfile({ "or-jev": orJevProfile(), [text]: unpopulatedDefaultProfile(text) })).toBe(false);
    expect(hasNoTextProfile({ mine: p({ mode: "remote", api: "openrouter-remote", model: "a/b" }) })).toBe(false);
    expect(hasNoTextProfile({ bad: p({ "profile-type": "bogus" }) })).toBe(false); // the user's own, reported where used
  });

  it("a zero-profile file after the step: the only profile is or-jev, and the shared predicate still says 'no text profile'", () => {
    writeFileSync(getSettingsPath(), "active: free\n", "utf-8");
    run();
    expect(hasNoTextProfile(loadSettings()!.profiles)).toBe(true);
  });

  it("the listing prints the type for classifier and scouting rows (never 'undefined'), keeps the effective marker and the legend", () => {
    writeFileSync(getSettingsPath(), "profiles:\n  scouting:\n    profile-type: scouting\n    mode: remote\n    api: openrouter-remote\n    model: vendor/scout\n", "utf-8");
    run();
    const text = formatProfilesList("or-jev");
    expect(text).not.toContain("undefined");
    expect(text).toContain("* or-jev — classifier / openrouter-remote — ~typesafe/jev-latest");
    expect(text).toContain("  scouting — scouting / openrouter-remote — vendor/scout");
    expect(text).toContain("* = effective profile (this invocation).");
  });
});


describe("PF-04 review: the self-heal of the effective text profile ignores the classifier", () => {
  it("a file whose only profile is the migration-added or-jev still self-heals to `free` (overrideActiveProfile)", async () => {
    writeFileSync(getSettingsPath(), "active: free\n", "utf-8");
    // Importing index.ts boots it: its migration adds `or-jev`, the only profile of this file.
    const { overrideActiveProfile, getActiveSettings } = await import("./index.js");
    expect(Object.keys(getActiveSettings().profiles)).toEqual(["or-jev"]);
    const r = overrideActiveProfile("or-jev", "default");
    expect(r).toEqual({ ok: true });
    expect(getActiveSettings().active).toBe("free");
    expect(Object.keys(loadSettings()!.profiles).sort()).toEqual(["free", "or-jev"]);
  });
});
