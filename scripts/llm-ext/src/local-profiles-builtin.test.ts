// P5 (TRDD-1OOAH3LD, TRDD-ZGSGGHQG): the two built-in local profiles (local_llama, locals-mlx), three
// models each, added ONCE by migrateSettingsTo141; and the validation of three-model managed local
// profiles. Real files in a throwaway config dir under /tmp (HOME and LLM_EXT_CONFIG_DIR), never the
// user's real ~/.llm-externalizer; no mocking. The fresh-install case runs the real CLI.

import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { tmpdir } from "./test-tmp-root.js";
import { LOCAL_PROFILE_STEP_PREFIX, migrateSettingsTo141 } from "./benchmark/pick.js";
import { isMigrationStepApplied, markMigrationStepApplied } from "./default-profiles-state.js";
import { builtinLocalProfiles, getSettingsPath, localsPlatformSupported, validateProfile, type Profile } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ON_APPLE_SILICON = localsPlatformSupported(process.platform, process.arch);
/** The profiles this machine gets: locals-mlx only where Locals runs (it would fail validation elsewhere). */
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

const run = (): ReturnType<typeof migrateSettingsTo141> =>
  migrateSettingsTo141(getSettingsPath(), { notify: (m) => notices.push(m), isApplied: isMigrationStepApplied, markApplied: markMigrationStepApplied });
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

  it.skipIf(ON_APPLE_SILICON)("off macOS on Apple silicon locals-mlx is neither added nor recorded (a later run on a Mac adds it)", () => {
    writeFileSync(getSettingsPath(), BASE);
    run();
    expect(profiles()["locals-mlx"]).toBeUndefined();
    expect(isMigrationStepApplied(`${LOCAL_PROFILE_STEP_PREFIX}locals-mlx`)).toBe(false);
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
