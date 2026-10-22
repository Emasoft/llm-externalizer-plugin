// PT-03 (TRDD-B9FWID59): acceptedProfileTypes on every command and the runtime check
// (E80, E81, E81i). Real buildTools() catalog and the real check; no I/O.

import { afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { tmpdir } from "./test-tmp-root.js";
import { join } from "node:path";

import { CLI_TOOLS_WITHOUT_RESOLVED_PROFILE, type Profile, type ProfileType } from "./config.js";
import { describeAcceptedTypes, profileSelectionRefusal } from "./profile-accept.js";
import { buildTools } from "./tools/definitions.js";
import { ANY_PROFILE_TYPE } from "./profile-accept.js";
import { GROUPS } from "./cli/launcher.js";

const tools = buildTools("") as Array<{ name: string; acceptedProfileTypes: readonly ProfileType[] }>;
const accepted = (name: string): readonly ProfileType[] => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.acceptedProfileTypes;
};

const profiles: Record<string, Profile> = {
  free: { "profile-type": "free" } as Profile,
  paid: { "profile-type": "paid" } as Profile,
  local: { "profile-type": "local" } as Profile,
  scouting: { "profile-type": "scouting" } as Profile,
  "or-jev": { "profile-type": "classifier" } as Profile,
};
const refuse = (toolName: string, command: string, profileFlag: string | undefined, active?: string) =>
  profileSelectionRefusal({
    command,
    accepted: accepted(toolName),
    viewsSettings: false,
    profileFlag,
    settings: { active, profiles },
  });

describe("acceptedProfileTypes table", () => {
  it("every launcher command and every catalog tool carries a non-empty list", () => {
    for (const t of tools) expect(t.acceptedProfileTypes.length).toBeGreaterThan(0);
    for (const actions of Object.values(GROUPS)) for (const a of Object.values(actions)) expect(accepted(a.command).length).toBeGreaterThan(0);
  });
  it("encodes the plan section 8 rows", () => {
    expect(accepted("chat")).toEqual(["local", "free", "paid"]);
    expect(accepted("check_imports")).toEqual(["local", "free", "paid"]);
    expect(accepted("high_quality_scan")).toEqual(["paid"]);
    expect(accepted("security_scan")).toEqual(["paid"]);
    expect(accepted("session_summary")).toEqual(["free", "paid"]);
    expect(accepted("mass_scout")).toEqual(["scouting"]);
    expect(describeAcceptedTypes(accepted("rules_check"))).toBe("any");
  });
});

describe("profileSelectionRefusal", () => {
  it("E80: a classifier or scouting profile given to scan is refused naming command, profile, type and accepted types", () => {
    for (const [flag, type] of [["or-jev", "classifier"], ["scouting", "scouting"]] as const) {
      const msg = refuse("scan_folder", "scan folder", flag);
      expect(msg).toContain("scan folder");
      expect(msg).toContain(`'${flag}'`);
      expect(msg).toContain(`type '${type}'`);
      expect(msg).toContain("local, free, paid");
    }
  });
  it("E81: a local, free, paid or scouting profile given to a classifier-only command is refused", () => {
    for (const flag of ["local", "free", "paid", "scouting"]) {
      const msg = profileSelectionRefusal({ command: "classify x", accepted: ["classifier"], viewsSettings: false, profileFlag: flag, settings: { active: "free", profiles } });
      expect(msg).toContain("classify x");
      expect(msg).toContain(`'${flag}'`);
      expect(msg).toContain("accepted profile types: classifier");
    }
  });
  it("E81i: active naming a scouting or classifier profile is a load error naming active and the allowed types", () => {
    for (const active of ["scouting", "or-jev"]) {
      expect(refuse("chat", "llm ask", undefined, active)).toMatch(/'active:'.*must name a local, free, paid profile/);
    }
  });
  it("a settings-viewing command still runs with a wrong active so the user can fix it", () => {
    expect(profileSelectionRefusal({ command: "settings show", accepted: accepted("get_settings"), viewsSettings: true, profileFlag: undefined, settings: { active: "or-jev", profiles } })).toBeUndefined();
  });
  it("accepts a matching flag and the default active profile", () => {
    expect(refuse("chat", "llm ask", "paid", "free")).toBeUndefined();
    expect(refuse("chat", "llm ask", undefined, "local")).toBeUndefined();
    expect(refuse("chat", "llm ask", undefined, undefined)).toBeUndefined();
  });
  it("scan quality refuses the free active profile (paid only)", () => {
    expect(refuse("high_quality_scan", "scan quality", undefined, "free")).toContain("accepted profile types: paid");
  });
  it("scouting-only commands are checked on --profile only, never on active", () => {
    expect(refuse("mass_scout", "scout run", undefined, "free")).toBeUndefined();
    expect(refuse("mass_scout", "scout run", "free", "free")).toContain("accepted profile types: scouting");
    expect(refuse("mass_scout", "scout run", "scouting", "free")).toBeUndefined();
  });
  it("session compact refuses a local profile", () => {
    expect(refuse("session_summary", "session compact", "local")).toContain("free, paid");
  });
  it("a no-model command accepts every type via --profile", () => {
    for (const flag of Object.keys(profiles)) expect(refuse("rules_check", "check rules", flag)).toBeUndefined();
  });
});

describe("review fixes", () => {
  it("lockout: with active naming a scouting profile the settings viewers still run, every model command is refused", () => {
    const settings = { active: "scouting", profiles };
    for (const t of ["get_settings", "list_profiles", "profile", "discover"]) {
      expect(CLI_TOOLS_WITHOUT_RESOLVED_PROFILE.has(t)).toBe(true);
      expect(profileSelectionRefusal({ command: t, accepted: accepted(t), viewsSettings: true, profileFlag: undefined, settings })).toBeUndefined();
    }
    expect(refuse("chat", "llm ask", undefined, "scouting")).toContain("'active:'");
  });
  it("a settings viewer with a bogus profile-type in active runs (no raw throw); a model command is refused with the loader's own named message", () => {
    const bogus = { active: "x", profiles: { x: { "profile-type": "bogus" } as unknown as Profile } };
    expect(profileSelectionRefusal({ command: "settings show", accepted: accepted("get_settings"), viewsSettings: true, profileFlag: undefined, settings: bogus })).toBeUndefined();
    expect(refuse2(bogus)).toMatch(/^Profile 'x': profile-type 'bogus' is not one of/);
  });
  it("an untyped profile on a not-yet-migrated file is typed by inference, not refused", () => {
    const settings = { active: "mine", profiles: { mine: { mode: "remote" } as Profile } };
    expect(profileSelectionRefusal({ command: "llm ask", accepted: accepted("chat"), viewsSettings: false, profileFlag: undefined, settings })).toBeUndefined();
    expect(profileSelectionRefusal({ command: "scout run", accepted: accepted("mass_scout"), viewsSettings: false, profileFlag: "mine", settings })).toContain("type 'paid'");
  });
  it("overrideActiveProfile overwrites active in the live settings, so the check must read the snapshot taken before it", async () => {
    // WHY own dir: the suite's config dir is shared by every test file; a settings.yaml left there broke other files in the full run.
    const prevCfg = process.env.LLM_EXT_CONFIG_DIR;
    const cfg = mkdtempSync(join(tmpdir(), "llm-ext-pt03-live-"));
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    try {
    writeFileSync(
      join(cfg, "settings.yaml"),
      [
        "active: myscout",
        "profiles:",
        "  mine:",
        "    profile-type: paid",
        "    mode: remote",
        "    api: openrouter-remote",
        "    api_key: sk-test-literal",
        "    model: vendor/paid-model",
        "  myscout:",
        "    profile-type: scouting",
        "    mode: remote",
        "    api: openrouter-remote",
        "    api_key: sk-test-literal",
        "    model: vendor/paid-model",
        "",
      ].join("\n"),
    );
    vi.resetModules();
    const index = await import("./index.js");
    const before = index.getActiveSettings();
    expect(before.active).toBe("myscout");
    expect(index.overrideActiveProfile("mine", "flag")).toEqual({ ok: true });
    expect(index.getActiveSettings().active).toBe("mine");
    const refusalOf = (settings: typeof before) => profileSelectionRefusal({ command: "llm ask", accepted: accepted("chat"), viewsSettings: false, profileFlag: "mine", settings });
    expect(refusalOf(before)).toContain("'active:'");
    expect(refusalOf(index.getActiveSettings())).toBeUndefined();
    } finally {
      if (prevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prevCfg;
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});

function refuse2(settings: { active: string; profiles: Record<string, Profile> }) {
  return profileSelectionRefusal({ command: "llm ask", accepted: accepted("chat"), viewsSettings: false, profileFlag: undefined, settings });
}

describe("any-type detection", () => {
  it("is by identity, so a duplicated entry in a normal list is not mistaken for every type", () => {
    const dup: readonly ProfileType[] = ["local", "free", "paid", "paid", "paid"];
    expect(profileSelectionRefusal({ command: "x", accepted: dup, viewsSettings: false, profileFlag: "myscout", settings: { active: "free", profiles: { ...profiles, myscout: profiles.scouting } } })).toContain("accepted profile types");
    expect(profileSelectionRefusal({ command: "x", accepted: ANY_PROFILE_TYPE, viewsSettings: false, profileFlag: "scouting", settings: { active: "free", profiles } })).toBeUndefined();
  });
});

// The real CLI entry, bundled from SOURCE into /tmp (dist/ is built only by the orchestrator and is stale
// here), run in a child process with throwaway HOME/config dirs. Every command below is refused before any model call.
describe("main.ts ordering (real CLI entry)", () => {
  // WHY inside node_modules: the bundle keeps better-sqlite3 external (as the real build does) and ESM resolves it only by walking up from the file.
  const work = join(__dirname, "..", "node_modules", "llm-ext-pt03-bundle");
  const bundle = join(work, "cli.mjs");
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const settingsOf = (active: string, extra: string[]): string =>
    ["active: " + active, "profiles:", "  mine:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    api_key: sk-test-literal", "    model: vendor/paid-model", "  myscout:", "    profile-type: scouting", "    mode: remote", "    api: openrouter-remote", "    api_key: sk-test-literal", "    model: vendor/paid-model", ...extra, ""].join("\n");
  const run = (settings: string, args: string[], extraFiles: Record<string, string> = {}) => {
    const cfg = mkdtempSync(join(tmpdir(), "llm-ext-pt03-cfg-"));
    const home = mkdtempSync(join(tmpdir(), "llm-ext-pt03-home-"));
    writeFileSync(join(cfg, "settings.yaml"), settings);
    for (const [name, content] of Object.entries(extraFiles)) writeFileSync(join(cfg, name), content);
    const r = spawnSync("node", [bundle, ...args], { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: home, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0" } });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  it("bundles", async () => {
    await build({
      entryPoints: [join(__dirname, "cli", "main.ts")], outfile: bundle, bundle: true, platform: "node", target: "node18", format: "esm", sourcemap: false,
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"],
      banner: { js: 'import { createRequire as __r } from "node:module";\nimport { fileURLToPath as __f } from "node:url";\nimport { dirname as __d } from "node:path";\nconst require = __r(import.meta.url);\nconst __filename = __f(import.meta.url);\nconst __dirname = __d(__filename);\n' },
    });
  }, 120_000);
  it("E81i: active names a scouting profile and --profile names a paid one on a text command: refused naming active", () => {
    const r = run(settingsOf("myscout", []), ["llm", "ask", "--profile", "mine", "--instructions", "x"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/'active:' names profile 'myscout' of type 'scouting'; 'active:' must name a local, free, paid profile/);
  }, 120_000);
  it("E80: a scouting profile given to scan is refused naming command, profile, type and accepted types", () => {
    const r = run(settingsOf("mine", []), ["scan", "folder", "--profile", "myscout", "--folder_path", "/tmp"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("scan folder does not accept profile 'myscout' (type 'scouting'); accepted profile types: local, free, paid.");
  }, 120_000);
  it("a malformed profile named by active gives a named message and no stack, for reset and for a text command", () => {
    const s = settingsOf("bad", ["  bad:", "    profile-type: bogus", "    mode: remote"]);
    for (const args of [["settings", "reset"], ["llm", "ask", "--instructions", "x"]]) {
      const r = run(s, args);
      expect(r.status).toBe(1);
      expect(r.out).toContain("profile-type 'bogus' is not one of");
      expect(r.out).not.toMatch(/\n\s+at /);
    }
  }, 120_000);


  // PF-02 wiring: the chat guard runs at CLI selection, from the cached catalog only (the child has no network key and the cache is fresh).
  it("PF-02: a free profile whose model is a cached decisions model is refused at selection, before any model call", () => {
    const id = "inception/mercury-decide:free";
    const s = ["active: f", "profiles:", "  f:", "    profile-type: free", "    mode: remote", "    api: openrouter-remote", "    api_key: sk-test-literal", `    model: ${id}`, `    free_models: [${id}]`, "    free_only: true", ""].join("\n");
    const model = { id, canonicalSlug: id, aliasTarget: null, contextTokens: 32000, promptUsdPerM: 0, outputModalities: [], systemOne: false };
    const r = run(s, ["llm", "ask", "--instructions", "x"], { "decisions-catalog-cache.json": JSON.stringify({ fetchedAtMs: Date.now(), models: [model] }) });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`Profile 'f' (free): model '${id}' is a decisions model`);
  }, 120_000);

});
