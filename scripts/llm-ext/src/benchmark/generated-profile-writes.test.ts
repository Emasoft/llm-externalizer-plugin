/**
 * `profiles.free` / `profiles.paid` have exactly ONE writer (P6b-fix2 B-1).
 *
 * Those sections are GENERATED: the dynamic-profile maintainer writes them
 * through `writeDynamicProfileSection`, which holds `<cfg>/settings.write.lock`,
 * stamps the generated marker, and backs up a hand-authored section first. The
 * `llm-ext-benchmark` entry point resolved its write target from the disk
 * `active:` key — retired for SELECTION by P6, but still set to `"free"` by the
 * shipped default config — so `--update-all`, `--auto-replace --apply`,
 * `--apply-free-pool free` and `--adopt` all defaulted to writing that section
 * with a second, lockless, marker-less, backup-less engine.
 *
 * These spawn the REAL bundled entry point (dist/benchmark.js), the same binary
 * the slash commands run, against a tmp `LLM_EXT_CONFIG_DIR`. They are
 * hermetic: the refusal happens in the usage-error phase, before preflight, so
 * no API key and no network are involved — which is itself the property under
 * test (a run must never write, then fail).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_JS = join(HERE, "..", "..", "dist", "benchmark.js");

/** The SHIPPED default shape: `active: free` on disk, plus a static profile a
 *  user could legitimately target with --profile. */
const SETTINGS = [
  "# a comment the writers must never eat",
  "active: free",
  "profiles:",
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models: [vendor/a:free]",
  "    model: vendor/a:free",
  "    api_key: $OPENROUTER_API_KEY",
  "  ens:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    model: vendor/one",
  "    second_model: vendor/two",
  "    api_key: sk-test-literal",
  "",
].join("\n");

describe("llm-ext-benchmark refuses to write a GENERATED dynamic profile", () => {
  let cfg = "";
  let root = "";
  let settingsPath = "";

  beforeAll(() => {
    expect(existsSync(BENCH_JS)).toBe(true); // npm run build is a prerequisite of npm test
  });

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "genprof-cfg-"));
    root = mkdtempSync(join("/tmp", "genprof-root-"));
    settingsPath = join(cfg, "settings.yaml");
    writeFileSync(settingsPath, SETTINGS);
  });
  afterEach(() => {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      LLM_EXT_CONFIG_DIR: cfg,
      CLAUDE_PROJECT_DIR: root,
    };
    delete env.OPENROUTER_API_KEY;
    delete env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
    return spawnSync(process.execPath, [BENCH_JS, ...args], { encoding: "utf-8", env });
  }

  // Each of the three commands the review found reachable, on a DEFAULT config
  // with no --profile: non-zero exit, the remedy named, settings untouched.
  for (const [label, args] of [
    ["--update-all", ["--update-all"]],
    ["--auto-replace --apply", ["--auto-replace", "--apply"]],
    ["--apply-free-pool free", ["--apply-free-pool", "free", "--bench-free-pool"]],
  ] as const) {
    it(`${label} on the default config exits non-zero, names the remedy, and leaves settings.yaml byte-identical`, () => {
      const before = readFileSync(settingsPath, "utf-8");
      const r = run([...args]);
      expect(r.status, `${label} must not succeed against a generated profile`).not.toBe(0);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(out).toContain("GENERATED dynamic profile");
      expect(out).toContain("--populate-default-profile");
      // The whole point: it refuses BEFORE writing, so not one byte moved.
      expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    });
  }

  it("--update-all --profile <static> is NOT refused (the refusal is about the target, not the command)", () => {
    const r = run(["--update-all", "--profile", "ens", "--dry-run"]);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).not.toContain("GENERATED dynamic profile");
    // It may still fail for an unrelated environmental reason (no API key);
    // what must not happen is this refusal. The WRITE half is proven at the
    // orchestrator level in update-all.test.ts, which drives runUpdateAll
    // against a static profile with injected seams and asserts the real
    // writers ran.
  });

  it("--adopt falls back to the built-in default, never the disk `active:` key", () => {
    // --adopt with no --adopt-profile used to read settings.active ("free").
    const before = readFileSync(settingsPath, "utf-8");
    const r = run(["--adopt", "vendor/one", "--adopt-into", "model"]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("GENERATED dynamic profile");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("P6b-fix3 S-1': --apply-profile <generated> is refused UP FRONT — before the pick, not after it", () => {
    // `--apply-profile` is the write target of five phases and was absent from
    // the refusal chain, so `--apply-profile free` ran the whole sweep (billable
    // on a paid profile) and only then took pick.ts's throw. `--from-cache`
    // makes this hermetic: it is the one pick path that needs no key, so a
    // refusal here can only come from the up-front chain.
    writeFileSync(
      join(cfg, "benchmark-results.json"),
      JSON.stringify({ savedAt: new Date().toISOString(), results: [] }),
    );
    const before = readFileSync(settingsPath, "utf-8");
    const r = run(["--from-cache", "--pick-top-n", "3", "--apply-profile", "free"]);
    expect(r.status, "--apply-profile free must not succeed").not.toBe(0);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("GENERATED dynamic profile");
    expect(out).toContain("--apply-profile refused");
    // Not the pick's own "only N model(s) cleared" failure — the refusal beat it.
    expect(out).not.toMatch(/cleared/);
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("P6b-fix3 N-3: --update-all --paid on the shipped config hears the GENERATED refusal, not free_only advice", () => {
    // refuseUnsafeUpdateAll used to run first, so the user was told to "turn off
    // free_only in settings.yaml" — a hand-edit of a GENERATED section the
    // maintainer overwrites on the next dispatch, about a profile they never
    // named. Both refusals are true; only one is actionable.
    const before = readFileSync(settingsPath, "utf-8");
    const r = run(["--update-all", "--paid"]);
    expect(r.status).not.toBe(0);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("GENERATED dynamic profile");
    expect(out).not.toContain("turn off free_only");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("P6b-fix3 N-3: --update-all --paid on a STATIC free_only target still hears the free_only refusal", () => {
    // The reorder must not swallow the cost-safety refusal for the targets it
    // was written for — a static profile the user named themselves.
    writeFileSync(
      settingsPath,
      [
        "profiles:",
        "  fo:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    free_only: true",
        "    free_models: [vendor/a:free]",
        "    model: vendor/a:free",
        "    api_key: sk-test-literal",
        "",
      ].join("\n"),
    );
    const r = run(["--update-all", "--paid", "--profile", "fo"]);
    expect(r.status).not.toBe(0);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("turn off free_only");
    expect(out).not.toContain("GENERATED dynamic profile");
  });
});

describe("P6b-fix3 S-2': the free_only COST GATE is published from the profile the command WRITES", () => {
  // `setActiveFreeOnly` decides which candidates the runner may bill for, and it
  // is consumed deep inside a sweep that needs the network — so the resolution
  // itself is what a hermetic test can observe. The second case is a source-shape
  // assertion (the same technique free-rotation-coverage.test.ts uses for the
  // dispatch pre-flight): it is the only thing that proves main still CONSUMES
  // the resolution rather than re-deriving it.
  it("resolves --apply-profile first, then the populator's own name, then the general target", async () => {
    const { costGateProfile } = await import("./index.js");
    const { parseArgs } = await import("./cli-args.js");
    const resolve = (argv: string[]): string => costGateProfile(parseArgs(["node", "bench", ...argv]));

    // The defect: with no --profile, main published `free`'s free_only for a run
    // whose writes all go to `ens`, so runner.ts skipped every non-zero-cost
    // candidate and the phase reported "no eligible same-or-cheaper passer, so
    // nothing was written to 'ens'" — a silent no-op dressed as a verdict.
    expect(resolve(["--from-cache", "--pick-top-n", "3", "--apply-profile", "ens"])).toBe("ens");
    // --profile does not outrank the actual write target.
    expect(
      resolve(["--from-cache", "--pick-top-n", "3", "--apply-profile", "ens", "--profile", "other"]),
    ).toBe("ens");
    // The populators name themselves (they also set the flag inside their own
    // phase; this stops main publishing `free`'s gate while populating `paid`).
    expect(resolve(["--populate-default-profile", "paid"])).toBe("paid");
    // Everything else: --profile if given, else the built-in default.
    expect(resolve(["--update-all", "--profile", "ens"])).toBe("ens");
    expect(resolve(["--update-all"])).toBe("free");
    // fix-queue item 51: costGateProfile now also covers --apply-free-pool and
    // --adopt, the two write-target flags it used to fall through past (harmless
    // today — --adopt only reads the public no-auth catalog, --apply-free-pool is
    // $0 by construction — but the gate should still name the profile written).
    expect(resolve(["--apply-free-pool", "x"])).toBe("x");
    // --adopt-profile names its own target, same as --profile does elsewhere.
    expect(resolve(["--adopt", "m", "--adopt-profile", "y"])).toBe("y");
    // --adopt with no --adopt-profile falls back to --profile, same as everything else.
    expect(resolve(["--adopt", "m", "--profile", "ens"])).toBe("ens");
    // --adopt alone falls back to the built-in default.
    expect(resolve(["--adopt", "m"])).toBe("free");
    // Priority order preserved: the two new branches sit AFTER --apply-profile /
    // --populate-default-profile, not before — a combined invocation still
    // publishes the higher-priority flag's target.
    expect(resolve(["--apply-profile", "ens", "--apply-free-pool", "x"])).toBe("ens");
    expect(resolve(["--populate-default-profile", "paid", "--adopt", "m"])).toBe("paid");
  });

  it("main still feeds setActiveFreeOnly from costGateProfile, not from benchmarkTargetProfile", async () => {
    const { readFileSync: read } = await import("node:fs");
    const src = read(join(HERE, "index.ts"), "utf-8");
    // row99 fix-queue item 2: `activeName` is now `let`-declared above (so a
    // getSettingsPath()/costGateProfile() throw can be caught in the same
    // try as settingsPath/loadSettings — see index.ts main()) and assigned
    // without `const` inside that try block, so the source shape to look
    // for lost its `const` prefix; the assertion is otherwise unchanged.
    const activeName = src.indexOf("activeName = costGateProfile(opts);");
    expect(activeName, "main no longer resolves its cost gate from the write target").toBeGreaterThan(-1);
    const publish = src.indexOf("setActiveFreeOnly(resolved.freeOnly);", activeName);
    expect(publish, "the resolution is no longer consumed by the cost gate").toBeGreaterThan(activeName);
  });
});
