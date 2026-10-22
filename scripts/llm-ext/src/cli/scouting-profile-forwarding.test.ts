// PT-05 follow-up (TRDD-RPEKSYJL): the real CLI entry (src/cli/main.ts bundled by esbuild, never the stale dist) must
// forward --profile to mass scouting, leave the active text profile alone, and not gate or override a scouting run
// with the ACTIVE profile's free pool. Every test spawns the bundle with its own /tmp config dir.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { join } from "node:path";

import { tmpdir } from "../test-tmp-root.js";
import { buildTools } from "../tools/definitions.js";
import { isScoutingOnlyTool } from "../index.js";

const REMOTE = ["    mode: remote", "    api: openrouter-remote", "    api_key: sk-test-literal"];
const profile = (name: string, type: string, model: string, extra: string[] = []): string[] => [`  ${name}:`, `    profile-type: ${type}`, ...REMOTE, `    model: ${model}`, ...extra];
const FREE_ID = "vendor/pool-model:free";
const STATIC_FREE = profile("myfree", "free", FREE_ID, ["    free_only: true", `    free_models: [${FREE_ID}]`]);
// WHY this id: the only model with built-in pricing (KNOWN_PRICING), so `scout register` works offline without pricing flags.
const DEFAULT_SCOUT = "qwen/qwen-2.5-7b-instruct";
const SCOUTING = profile("scouting", "scouting", DEFAULT_SCOUT);
const OTHER = profile("myscout", "scouting", "vendor/other-scout");
const PAID = profile("mine", "paid", "vendor/paid-model");

const work = join(__dirname, "..", "..", "node_modules", "llm-ext-pt05f-bundle");
const bundle = join(work, "cli.mjs");
const dirs: string[] = [];
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Env { cfg: string; home: string; src: string; db: string; fields: string }
function env(settings: string[]): Env {
  const root = mkdtempSync(join(tmpdir(), "llm-ext-pt05f-"));
  dirs.push(root);
  const cfg = join(root, "cfg"), home = join(root, "home"), src = join(root, "src");
  for (const d of [cfg, home, src]) mkdirSync(d);
  writeFileSync(join(src, "a.ts"), "export const a = 1\n");
  writeFileSync(join(cfg, "settings.yaml"), [...settings, ""].join("\n"));
  const fields = join(root, "fields.json");
  writeFileSync(fields, JSON.stringify({ version: 1, fieldset_name: "t", fields: [{ name: "is_async", description: "true if async", type: { kind: "bool" } }] }));
  return { cfg, home, src, db: join(root, "r.db"), fields };
}
function cli(e: Env, args: string[]): { status: number | null; out: string } {
  // WHY LLM_EXT_DISABLE_AUTO_RECONCILE: a wrongly-run reconcile would fetch the live OpenRouter catalog; the test must stay offline.
  const r = spawnSync("node", [bundle, ...args], { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: e.home, LLM_EXT_CONFIG_DIR: e.cfg, LLM_EXT_INSTALL_RULE: "0", LLM_EXT_DISABLE_AUTO_RECONCILE: "1" } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const register = (e: Env, extra: string[] = []) => cli(e, ["scout", "register", "--folder_path", e.src, "--db_path", e.db, ...extra]);
const estimate = (e: Env, extra: string[] = []) =>
  cli(e, ["scout", "estimate", "--db_path", e.db, "--fields_file", e.fields, "--input_price_per_m", "0.0001", "--output_price_per_m", "0.0002", "--context_window", "200000", ...extra]);
const run = (e: Env, extra: string[] = []) => cli(e, ["scout", "run", "--db_path", e.db, "--fields_file", e.fields, "--job_id", "j1", "--source_root", e.src, "--no_smoke_test", ...extra]);

describe("PT-05 follow-up: scouting-only commands in the real CLI entry", () => {
  beforeAll(async () => {
    await build({
      entryPoints: [join(__dirname, "main.ts")], outfile: bundle, bundle: true, platform: "node", target: "node18", format: "esm", sourcemap: false,
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"],
      banner: { js: 'import { createRequire as __r } from "node:module";\nimport { fileURLToPath as __f } from "node:url";\nimport { dirname as __d } from "node:path";\nconst require = __r(import.meta.url);\nconst __filename = __f(import.meta.url);\nconst __dirname = __d(__filename);\n' },
    });
  }, 120_000);

  it("isScoutingOnlyTool is exactly the set of tools whose accepted types are [scouting] in the table", () => {
    const fromTable = (buildTools("") as Array<{ name: string; acceptedProfileTypes: readonly string[] }>)
      .filter((t) => t.acceptedProfileTypes.length === 1 && t.acceptedProfileTypes[0] === "scouting").map((t) => t.name).sort();
    expect(fromTable).toEqual(["mass_scout", "mass_scout_chain", "mass_scout_estimate", "mass_scout_preclassify", "mass_scout_propose_fieldset", "mass_scout_register"]);
    expect(fromTable.filter((n) => !isScoutingOnlyTool(n))).toEqual([]);
    expect(isScoutingOnlyTool("chat")).toBe(false);
    expect(isScoutingOnlyTool("mass_scout_search")).toBe(false);
  });

  it("--profile naming another scouting profile reaches mass scouting: estimate prices that profile's model", () => {
    const e = env(["active: mine", "allow_paid_models: true", "profiles:", ...PAID, ...SCOUTING, ...OTHER]);
    expect(register(e).status).toBe(0);
    const r = estimate(e, ["--profile", "myscout"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("model=vendor/other-scout");
    const d = estimate(e);
    expect(d.out).toContain(`model=${DEFAULT_SCOUT}`);
  }, 120_000);

  it("--profile on a scouting-only command leaves the active text profile alone (banner shows the active model, no scouting model as active)", () => {
    const e = env(["active: mine", "allow_paid_models: true", "profiles:", ...PAID, ...SCOUTING, ...OTHER]);
    expect(register(e).status).toBe(0);
    const r = estimate(e, ["--profile", "myscout"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("backend: OpenRouter (vendor/paid-model)");
    expect(r.out).not.toContain("backend: OpenRouter (vendor/other-scout)");
  }, 120_000);

  it("a nonexistent --profile still fails, naming the profile and the available scouting profiles", () => {
    const e = env(["active: mine", "allow_paid_models: true", "profiles:", ...PAID, ...SCOUTING]);
    const r = register(e, ["--profile", "nope"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("profile 'nope' does not exist; available scouting-type profiles: scouting");
  }, 120_000);

  it("a free profile named by --profile is still refused by the PT-03 check, first", () => {
    const e = env(["active: mine", "allow_paid_models: true", "profiles:", ...PAID, ...SCOUTING, ...STATIC_FREE]);
    const r = register(e, ["--profile", "myfree"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("does not accept profile 'myfree' (type 'free'); accepted profile types: scouting.");
  }, 120_000);

  it("active: free with a populated free pool: the model reaching the scouting code is the scouting profile's, not a free-pool id", () => {
    const e = env(["active: myfree", "allow_paid_models: true", "profiles:", ...STATIC_FREE, ...SCOUTING]);
    expect(register(e).status).toBe(0);
    const r = estimate(e);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`model=${DEFAULT_SCOUT}`);
    expect(r.out).not.toContain(`model=${FREE_ID}`);
  }, 120_000);

  it("active: free with an unpopulated dynamic pool: the active profile's pool gate does not refuse a scouting command", () => {
    const e = env(["active: free", "allow_paid_models: true", "profiles:", ...SCOUTING]);
    const r = register(e);
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/free profile|retry|free mode is active/i);
  }, 120_000);

  it("spend safety: active free, allow_paid_models false, populated paid scouting profile: refused with the allow_paid_models message", () => {
    const e = env(["active: myfree", "allow_paid_models: false", "profiles:", ...STATIC_FREE, ...SCOUTING]);
    const r = run(e);
    expect(r.status).toBe(1);
    expect(r.out).toContain("allow_paid_models is off");
  }, 120_000);

  it("spend safety: allow_paid_models true: the active free pool no longer refuses; the benchmark PASS gate is the next (and only remaining) gate", () => {
    const e = env(["active: free", "allow_paid_models: true", "profiles:", ...SCOUTING]);
    const r = run(e);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/allow_paid_models is off|free mode is active|free profile/i);
    expect(r.out).toMatch(/scout-accuracy/);
  }, 120_000);
});
