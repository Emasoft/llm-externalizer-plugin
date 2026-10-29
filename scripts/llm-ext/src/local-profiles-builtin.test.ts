// P5 (TRDD-1OOAH3LD, TRDD-ZGSGGHQG): the two built-in local profiles (local_llama, locals-mlx), three
// models each, added ONCE by migrateSettingsTo141; and the validation of three-model managed local
// profiles. Real files in a throwaway config dir under /tmp (HOME and LLM_EXT_CONFIG_DIR), never the
// user's real ~/.llm-externalizer; no mocking. The fresh-install case runs the real CLI.

import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, parseDocument } from "yaml";
import { tmpdir } from "./test-tmp-root.js";
import { LOCAL_PROFILE_STEP_PREFIX, localProfileStepIds, migrateSettingsTo141 } from "./benchmark/pick.js";
import { isMigrationStepApplied, markMigrationStepApplied } from "./default-profiles-state.js";
import { builtinLocalProfiles, getSettingsPath, localsPlatformSupported, profileTypeFieldIssues, validateProfile, type Profile } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ON_APPLE_SILICON = localsPlatformSupported(process.platform, process.arch);
/** The profiles this machine gets: locals-mlx only where Locals runs (elsewhere it could never run, so it is left out). */
const EXPECTED = ON_APPLE_SILICON ? ["local_llama", "locals-mlx"] : ["local_llama"];

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBai: string | undefined;
let notices: string[];

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  prevBai = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY; // the bai seed step would otherwise rewrite the free section
  cfgDir = mkdtempSync(join(tmpdir(), "llm-ext-p5-"));
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

const run = (platform?: { platform: string; arch: string }): ReturnType<typeof migrateSettingsTo141> =>
  migrateSettingsTo141(getSettingsPath(), { notify: (m) => notices.push(m), isApplied: isMigrationStepApplied, markApplied: markMigrationStepApplied, platform });
const profiles = (): Record<string, Record<string, unknown>> =>
  (parseYaml(readFileSync(getSettingsPath(), "utf-8")) as { profiles: Record<string, Record<string, unknown>> }).profiles;
const BASE = ["active: mine", "profiles:", "  mine:", "    profile-type: local", "    mode: local", "    api: ollama-local", "    model: llama3", ""].join("\n");

describe("built-in local profiles: added once (P5)", () => {
  it("an install without them gets each, with its comment header, three models, server: managed, never active", () => {
    writeFileSync(getSettingsPath(), BASE);
    const r = run();
    for (const n of EXPECTED) expect(r.applied).toContain(`${LOCAL_PROFILE_STEP_PREFIX}${n}`);
    const p = profiles();
    for (const b of builtinLocalProfiles().filter((x) => EXPECTED.includes(x.name))) {
      expect(p[b.name]).toEqual(b.profile);
      expect(p[b.name].server).toBe("managed");
      expect([p[b.name].model, p[b.name].second_model, p[b.name].third_model].every((m) => typeof m === "string" && m !== "")).toBe(true);
    }
    const raw = readFileSync(getSettingsPath(), "utf-8");
    // The user's own header for local_llama, word for word, right above the key.
    expect(raw).toContain(
      "  # The local_llama profile will run llama.cpp locally as inference engine, with any llama.cpp compatible model.\n" +
        "  # WARNING: You need a llama.cpp build with LFM3 support (merged in llama.cpp #31252; produced at llama.cpp 19cce69).\n" +
        "  # The first model added to the profile is `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K`.\n" +
        "  # The profile must automatically download it from huggingface or using the llama-cli command to download it,\n" +
        "  # cache it automatically, and run it, like this:\n" +
        '  # llama-cli -hf AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6 -p "The prompt content goes here."\n' +
        "  local_llama:\n",
    );
    expect((parseYaml(raw) as { active: string }).active).toBe("mine");
    expect(p.mine).toEqual({ "profile-type": "local", mode: "local", api: "ollama-local", model: "llama3" });
    // Every profile written validates.
    for (const n of EXPECTED) expect(validateProfile(n, p[n] as unknown as Profile).errors).toEqual([]);
  });

  it("a profile of that name the user already has (or edited) is kept byte-identical, and the step is recorded", () => {
    const own = [BASE.trimEnd(), "  # my llama", "  local_llama:", "    profile-type: local", "    mode: local", "    api: llamacpp-local", "    url: http://127.0.0.1:8181", "    server: managed", "    model: org/repo:Q4_K_M", ""].join("\n");
    writeFileSync(getSettingsPath(), own);
    run();
    expect(isMigrationStepApplied(`${LOCAL_PROFILE_STEP_PREFIX}local_llama`)).toBe(true);
    const p = profiles();
    expect(p.local_llama).toEqual({ "profile-type": "local", mode: "local", api: "llamacpp-local", url: "http://127.0.0.1:8181", server: "managed", model: "org/repo:Q4_K_M" });
    if (!ON_APPLE_SILICON) expect(readFileSync(getSettingsPath(), "utf-8")).toBe(own);
  });

  it("a deleted profile stays deleted: the step never adds it again", () => {
    writeFileSync(getSettingsPath(), BASE);
    run();
    expect(Object.keys(profiles())).toEqual(expect.arrayContaining(EXPECTED));
    // The user deletes both.
    writeFileSync(getSettingsPath(), BASE);
    notices = [];
    const again = run();
    expect(again.applied.filter((s) => s.startsWith(LOCAL_PROFILE_STEP_PREFIX))).toEqual([]);
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(BASE);
    expect(notices).toEqual([]);
  });

  const MAC = { platform: "darwin", arch: "arm64" };

  it("the first run adds both profiles on a Mac and records both ids", () => {
    writeFileSync(getSettingsPath(), BASE);
    const r = run(MAC);
    expect(Object.keys(profiles())).toEqual(expect.arrayContaining(["local_llama", "locals-mlx"]));
    expect(r.applied).toEqual(expect.arrayContaining(localProfileStepIds()));
    for (const id of localProfileStepIds()) expect(isMigrationStepApplied(id)).toBe(true);
  });

  it("a second run leaves settings.yaml byte-identical", () => {
    writeFileSync(getSettingsPath(), BASE);
    run(MAC);
    const first = readFileSync(getSettingsPath(), "utf-8");
    notices = [];
    run(MAC);
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(first);
    expect(notices).toEqual([]);
  });

  it("after the user deletes locals-mlx the next run does not add it again (local_llama is kept)", () => {
    writeFileSync(getSettingsPath(), BASE);
    run(MAC);
    const doc = parseDocument(readFileSync(getSettingsPath(), "utf-8"));
    doc.deleteIn(["profiles", "locals-mlx"]);
    writeFileSync(getSettingsPath(), String(doc));
    const afterDelete = readFileSync(getSettingsPath(), "utf-8");
    run(MAC);
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(afterDelete);
    expect(profiles()["locals-mlx"]).toBeUndefined();
    expect(profiles().local_llama).toBeDefined();
  });

  it("a user profile named local_llama is neither overwritten nor duplicated", () => {
    const own = [BASE.trimEnd(), "  local_llama:", "    profile-type: local", "    mode: local", "    api: llamacpp-local", "    url: http://127.0.0.1:8181", "    server: managed", "    model: org/repo:Q4_K_M", ""].join("\n");
    writeFileSync(getSettingsPath(), own);
    run(MAC);
    const raw = readFileSync(getSettingsPath(), "utf-8");
    expect(raw.match(/^ {2}local_llama:/gm)).toHaveLength(1);
    expect(profiles().local_llama.model).toBe("org/repo:Q4_K_M");
    expect(profiles().local_llama.second_model).toBeUndefined();
  });

  it.each([
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
    ["darwin", "x64"],
  ])("on %s/%s locals-mlx is not written but its step is recorded (not retried); local_llama is still added", (platform, arch) => {
    writeFileSync(getSettingsPath(), BASE);
    run({ platform, arch });
    expect(profiles()["locals-mlx"]).toBeUndefined();
    expect(profiles().local_llama).toBeDefined();
    expect(isMigrationStepApplied(`${LOCAL_PROFILE_STEP_PREFIX}locals-mlx`)).toBe(true);
    // The Mac run that follows finds the step recorded and writes nothing.
    const before = readFileSync(getSettingsPath(), "utf-8");
    run(MAC);
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(before);
  });

  it("the step-id list is pinned: a new built-in local profile step must be added here on purpose", () => {
    expect(localProfileStepIds()).toEqual(["local-profile-added:local_llama", "local-profile-added:locals-mlx"]);
  });

  // P5 review M1: the file may hold API keys; the write must not widen its mode.
  it.skipIf(process.platform === "win32")("a 0600 settings.yaml stays 0600 after the profiles are added", () => {
    writeFileSync(getSettingsPath(), BASE, { mode: 0o600 });
    chmodSync(getSettingsPath(), 0o600);
    run();
    expect(profiles().local_llama).toBeDefined();
    expect(statSync(getSettingsPath()).mode & 0o777).toBe(0o600);
  });

  // P5 review M1: a settings.yaml linked into a dotfiles repo stays a link; its target gets the profiles.
  it.skipIf(process.platform === "win32")("a symlinked settings.yaml stays a symlink, its target (0600 kept) gets the profiles, no tmp file is left", () => {
    const dotfiles = mkdtempSync(join(tmpdir(), "llm-ext-p5-dotfiles-"));
    try {
      const target = join(dotfiles, "settings.yaml");
      writeFileSync(target, BASE, { mode: 0o600 });
      chmodSync(target, 0o600);
      symlinkSync(target, getSettingsPath());
      run();
      expect(lstatSync(getSettingsPath()).isSymbolicLink()).toBe(true);
      expect(readlinkSync(getSettingsPath())).toBe(target);
      expect((parseYaml(readFileSync(target, "utf-8")) as { profiles: Record<string, unknown> }).profiles.local_llama).toBeDefined();
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readdirSync(dotfiles).filter((f) => f.includes(".tmp."))).toEqual([]);
    } finally {
      rmSync(dotfiles, { recursive: true, force: true });
    }
  });

  // P5 review m2: the write does not fold long lines, pad flow maps, or turn CRLF into LF.
  it("the rest of the file keeps its long lines, flow-map spacing and CRLF line endings", () => {
    const long = "x".repeat(120);
    const src = [BASE.trimEnd(), `    note: ${long}`, "    extra: {a: b}", ""].join("\r\n").replace(/\r?\n/g, "\r\n");
    writeFileSync(getSettingsPath(), src);
    run();
    const raw = readFileSync(getSettingsPath(), "utf-8");
    expect(raw).toContain(`    note: ${long}\r\n`);
    expect(raw).toContain("    extra: {a: b}\r\n");
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
    expect(profiles().local_llama).toBeDefined();
  });
});

describe("three-model managed local profiles: validation (P5)", () => {
  const llama = (over: Record<string, unknown> = {}): Profile =>
    ({ ...builtinLocalProfiles().find((b) => b.name === "local_llama")!.profile, ...over }) as unknown as Profile;
  const mlx = (over: Record<string, unknown> = {}): Profile =>
    ({ ...builtinLocalProfiles().find((b) => b.name === "locals-mlx")!.profile, ...over }) as unknown as Profile;

  it("the built-in local_llama validates: three llama.cpp model forms (repo:quant, repo/file.gguf twice)", () => {
    expect(validateProfile("local_llama", llama()).errors).toEqual([]);
  });

  it.skipIf(!ON_APPLE_SILICON)("the built-in locals-mlx validates on macOS on Apple silicon", () => {
    expect(validateProfile("locals-mlx", mlx()).errors).toEqual([]);
  });

  it("second_model and third_model on a local profile need server: managed", () => {
    const { server: _s, ...unmanaged } = llama() as unknown as Record<string, unknown>;
    const errors = validateProfile("x", unmanaged as unknown as Profile).errors.join("\n");
    expect(errors).toMatch(/profiles\.x\.second_model needs server: managed/);
    expect(errors).toMatch(/profiles\.x\.third_model needs server: managed/);
    const ollama = { "profile-type": "local", mode: "local", api: "ollama-local", model: "a", second_model: "b" } as unknown as Profile;
    expect(validateProfile("o", ollama).errors.join("\n")).toMatch(/second_model needs server: managed/);
  });

  it("every model of a managed llamacpp-local profile must be a form the broker can start", () => {
    const errors = validateProfile("x", llama({ third_model: "not-a-gguf-id" })).errors.join("\n");
    expect(errors).toMatch(/model 'not-a-gguf-id' cannot be served by a managed llama-server/);
  });

  // P5 review m6: the load-time field check (run on every profile, selected or not) needs the broker's api too.
  it("at load, second_model on a managed local profile whose api the broker does not serve is refused", () => {
    const typo = { "profile-type": "local", mode: "local", api: "lmstudio-local", server: "managed", model: "a", second_model: "b" } as unknown as Profile;
    expect(profileTypeFieldIssues("t", typo, "local").join("\n")).toMatch(/profiles\.t\.second_model needs server: managed with api llamacpp-local or locals-local/);
    expect(profileTypeFieldIssues("local_llama", llama(), "local")).toEqual([]);
  });

  it.skipIf(!ON_APPLE_SILICON)("every model of a managed locals-local profile must be an org/name repo id, never a GGUF", () => {
    expect(validateProfile("x", mlx({ second_model: "smollm" })).errors.join("\n")).toMatch(/must be a Hugging Face repo id/);
    expect(validateProfile("x", mlx({ third_model: "org/m.gguf" })).errors.join("\n")).toMatch(/GGUF/);
  });
});

describe("a fresh install through the real CLI (P5)", () => {
  let cliDir: string | null = null;
  afterAll(() => {
    if (cliDir) rmSync(cliDir, { recursive: true, force: true });
  });

  it("the first command writes the defaults AND the built-in local profiles, none of them active; the second adds nothing", async () => {
    // Under the package node_modules (a gitignored cache): the bundle keeps better-sqlite3 external.
    cliDir = mkdtempSync(join(HERE, "..", "node_modules", ".cache-llm-ext-p5-cli-"));
    const cli = join(cliDir, "llm-ext.mjs");
    const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
    await build({
      entryPoints: [join(HERE, "cli", "main.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: `import { createRequire as __cjsCreateRequire } from "node:module";\nimport { fileURLToPath as __cjsFileURLToPath } from "node:url";\nimport { dirname as __cjsDirname } from "node:path";\nconst require = __cjsCreateRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);\n` },
      external: [...nodeExternals, "better-sqlite3"],
      outfile: cli,
    });
    const env = { ...process.env, HOME: cfgDir, LLM_EXT_CONFIG_DIR: cfgDir, LLM_EXT_INSTALL_RULE: "0" };
    const first = spawnSync(process.execPath, [cli, "--help"], { env, encoding: "utf8", timeout: 120_000 });
    expect(first.status, first.stderr).toBe(0);
    const p = profiles();
    for (const n of EXPECTED) expect(p[n], first.stderr).toBeDefined();
    const active = (parseYaml(readFileSync(getSettingsPath(), "utf-8")) as { active: string }).active;
    expect(EXPECTED).not.toContain(active);
    const listed = spawnSync(process.execPath, [cli, "settings", "profiles"], { env, encoding: "utf8", timeout: 120_000 });
    expect(listed.status, listed.stderr).toBe(0);
    for (const n of EXPECTED) expect(listed.stdout + listed.stderr).toContain(n);
    expect(listed.stderr).not.toMatch(/added the built-in profile/);
  }, 300_000);
});

// P5 review m4: the built-ins the migration adds are not "the user has profiles": a file with a
// dangling `active:` and no text profile of its own still self-heals to `free`.
describe("the self-heal of the effective text profile ignores the added built-ins (P5 review m4)", () => {
  it("active: old with no profile: after boot adds local_llama, overrideActiveProfile still resolves to free", async () => {
    writeFileSync(getSettingsPath(), "active: old\n", "utf-8");
    // Importing index.ts boots it: its migration adds or-jev and the built-in local profiles.
    const { overrideActiveProfile, getActiveSettings } = await import("./index.js");
    expect(Object.keys(getActiveSettings().profiles)).toContain("local_llama");
    expect(overrideActiveProfile("old", "default")).toEqual({ ok: true });
    expect(getActiveSettings().active).toBe("free");
    // active: naming a built-in keeps it: the built-in is ignored only when it is not the one asked for.
    expect(overrideActiveProfile("local_llama", "default")).toEqual({ ok: true });
    expect(getActiveSettings().active).toBe("local_llama");
  });
});
