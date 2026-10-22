/**
 * Integration tests for the `profile` command (TRDD-K3PW7Q2M).
 *
 * `profile` is READ-ONLY by design (config.ts §"MCP cannot write settings" —
 * profile add/select/edit/remove is user-only, hand-edit settings.yaml + call
 * `reset`). These tests spawn the real compiled CLI against a throwaway
 * multi-profile settings.yaml, so they exercise the exact bytes a user's
 * `llm-ext profile` invocation would produce — no mocking of config.ts.
 *
 * Every test uses a `mode: local` profile with an unreachable URL, so no
 * network call and no OpenRouter billing is possible (mirrors the cost-safety
 * discipline in test-helpers.ts's default LOCAL_TEST_SETTINGS_YAML).
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_SCRIPT } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

/** A settings.yaml with THREE profiles so list/show has something to
 * distinguish. All local + unreachable — zero network, zero billing. */
const MULTI_PROFILE_SETTINGS_YAML = [
  "active: local-b",
  "profiles:",
  "  local-a:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-a",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "    profile-type: local",
  "  local-b:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-b",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "    profile-type: local",
  "  remote-free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models:",
  "      - vendor/model-x:free",
  "      - vendor/model-y:free",
  "    profile-type: free",
  "",
].join("\n");

/** Settings file whose 'profiles' map is present but empty — a hand-edit
 * mistake, distinct from "file missing" (ensureSettingsExist always seeds
 * defaults on first run, so an empty map can only come from a bad edit). */
const EMPTY_PROFILES_SETTINGS_YAML = ["active: nothing", "profiles: {}", ""].join("\n");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn the real CLI against a throwaway config dir seeded with the given
 * settings.yaml. Mirrors test-helpers.ts's runCli(), but lets the caller
 * supply arbitrary settings content — runCli() only ever writes the fixed
 * single-profile LOCAL_TEST_SETTINGS_YAML, which can't exercise list/show
 * across multiple profiles. */
async function runProfileCli(
  settingsYaml: string,
  args: string[],
): Promise<RunResult> {
  const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_profile_cfg_");
  writeFileSync(join(tmpConfigDir, "settings.yaml"), settingsYaml, "utf-8");
  const outputDir = mkdtempSync("/tmp/__llm_ext_profile_out_");

  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [CLI_SCRIPT, "profile", ...args, "--quiet"],
      {
        env: {
          ...process.env,
          LLM_EXT_CONFIG_DIR: tmpConfigDir,
          LLM_EXT_OUTPUT_DIR: outputDir,
          LLM_EXT_INSTALL_RULE: "0",
        },
        // 60s, not 15s: this spawns a cold Node process running the real CLI, and
        // the gate that runs it (publish.py) runs it while the machine is also
        // type-checking, linting and building. A 15s budget failed there while
        // passing every time in isolation. See c0a3b6f6 — the same fix, applied
        // to the file that hit it first; these never received it.
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | null;
      signal?: string | null;
      killed?: boolean;
    };
    // A timeout kill sets `signal` and leaves `code` undefined, so the old
    // `e.code ?? null` turned "we killed it after N seconds" into a bare
    // `exitCode: null` and the assertion read "expected null to be +0" — a
    // message that names neither the timeout nor the command. Say what happened.
    const stderrText = (e.stderr ?? "").trim();
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: e.signal
        ? `${stderrText}\n[test harness] child killed by ${e.signal}` +
          `${e.killed ? " (timeout)" : ""} — args: ${args.join(" ")}`
        : stderrText,
      exitCode: e.code ?? null,
    };
  }
}

describe("profile command", () => {
  it("is listed in llm-ext --help", async () => {
    /** The command must appear in the catalog-driven global help text */
    const { stdout } = await execFileAsync("node", [CLI_SCRIPT, "--help"]);
    expect(stdout).toMatch(/\bprofile\b/);
  });

  it("with no flags lists every profile and marks the EFFECTIVE one (--profile, not active:)", async () => {
    /** Default (no args) = list mode: every profile name, effective marker, mode/backend/model.
     *  Marker semantics changed under P6 (item 2/3): the marker is on the
     *  profile THIS invocation actually runs (--profile, or the built-in
     *  default), never on whatever the now-inert `active:` key names. */
    const result = await runProfileCli(MULTI_PROFILE_SETTINGS_YAML, ["--profile", "local-b"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/local-a/);
    expect(result.stdout).toMatch(/local-b/);
    expect(result.stdout).toMatch(/remote-free/);
    const effectiveLine = result.stdout.split("\n").find((l) => l.includes("local-b"));
    const inactiveLine = result.stdout.split("\n").find((l) => l.includes("local-a"));
    expect(effectiveLine).toMatch(/^\* /);
    expect(inactiveLine).toMatch(/^ {2}/);
    // free_only profile shows the pool size, not a raw model id
    expect(result.stdout).toMatch(/remote-free.*free_only \(2 models\)/);
  });

  it("--show <name> prints resolved detail for exactly that profile", async () => {
    /** --show switches to single-profile detail mode, resolved via config.ts's own resolveProfile */
    const result = await runProfileCli(MULTI_PROFILE_SETTINGS_YAML, ["--show", "local-a"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Profile: local-a/);
    expect(result.stdout).toMatch(/Model: model-a/);
    expect(result.stdout).not.toMatch(/ACTIVE/); // local-a is not the active profile
    expect(result.stdout).not.toMatch(/model-b/); // must not leak the other profile's fields
  });

  it("--show on the EFFECTIVE profile (--profile, not active:) marks it ACTIVE", async () => {
    const result = await runProfileCli(MULTI_PROFILE_SETTINGS_YAML, [
      "--profile",
      "local-b",
      "--show",
      "local-b",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Profile: local-b \(ACTIVE\)/);
  });

  it("--show on a free_only profile prints the free pool, not a single model", async () => {
    const result = await runProfileCli(MULTI_PROFILE_SETTINGS_YAML, ["--show", "remote-free"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Free only: true/);
    expect(result.stdout).toMatch(/vendor\/model-x:free/);
    expect(result.stdout).toMatch(/vendor\/model-y:free/);
  });

  it("--show <unknown> fails fast with a clear error listing the real profiles", async () => {
    /** FAIL FAST: an unknown --show value is a configuration/typo error, never a silent empty result */
    const result = await runProfileCli(MULTI_PROFILE_SETTINGS_YAML, ["--show", "does-not-exist"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown profile 'does-not-exist'/);
    expect(result.stderr).toMatch(/local-a/);
    expect(result.stderr).toMatch(/local-b/);
    expect(result.stderr).toMatch(/remote-free/);
  });

  it("a zero-profile settings.yaml self-heals via the built-in default (P6 item 2)", async () => {
    /** Pre-P6, an empty profiles map was a hard configuration error. Under
     *  item 2, `--profile`'s omission always resolves to the built-in
     *  'free' default, which overrideActiveProfile creates on first run
     *  (design §2.6) even when the file started with zero profiles — so
     *  the command now succeeds instead of failing "No profiles defined". */
    const result = await runProfileCli(EMPTY_PROFILES_SETTINGS_YAML, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\* free\b/);
  });

  it("--profile <name> on a zero-profile settings.yaml still fails fast for a STATIC name", async () => {
    /** A non-default, non-dynamic name that genuinely does not exist is
     *  still an error — only 'free'/'paid' self-heal (item 2). */
    const result = await runProfileCli(EMPTY_PROFILES_SETTINGS_YAML, ["--profile", "nothing"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown profile 'nothing'/);
  });

  it("never mutates an existing STATIC profile's own section on disk", async () => {
    /** Read-only contract: profile add/select/edit/remove is user-only (see
     *  the tool description). Passing --profile local-a (an existing
     *  STATIC profile) keeps this test on that contract exactly — the
     *  first-run creation of an absent 'free'/'paid' section (item 2) is a
     *  separate, deliberate, and already-tested exception (see the
     *  active-profile-retirement.test.ts "created on first run" case), not
     *  a violation of it. */
    const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_profile_immut_");
    const settingsPath = join(tmpConfigDir, "settings.yaml");
    writeFileSync(settingsPath, MULTI_PROFILE_SETTINGS_YAML, "utf-8");
    // The 14.1.0 migration runs once, on the first command after an upgrade (see the test below); this test is about what the COMMAND does, so that one-time step is already recorded.
    writeFileSync(join(tmpConfigDir, "dynamic-profiles-state.json"), JSON.stringify({ version: 1, profiles: {}, migrationsApplied: ["or-jev-section-added"] }), "utf-8");
    const beforeContent = MULTI_PROFILE_SETTINGS_YAML;

    await execFileAsync(
      "node",
      [CLI_SCRIPT, "profile", "--profile", "local-a", "--show", "local-a", "--quiet"],
      {
        env: { ...process.env, LLM_EXT_CONFIG_DIR: tmpConfigDir, LLM_EXT_INSTALL_RULE: "0" },
        // 60s, not 15s: this spawns a cold Node process running the real CLI, and
        // the gate that runs it (publish.py) runs it while the machine is also
        // type-checking, linting and building. A 15s budget failed there while
        // passing every time in isolation. See c0a3b6f6 — the same fix, applied
        // to the file that hit it first; these never received it.
        timeout: 60_000,
      },
    );

    const { readFileSync } = await import("node:fs");
    const afterContent = readFileSync(settingsPath, "utf-8");
    expect(afterContent).toBe(beforeContent);
  });


  it("design: the first command after an upgrade applies the 14.1.0 migration once, even a read-only one; the second changes nothing", async () => {
    /** The migration runs at boot for EVERY command (index.ts, module import), so `profile` on a pre-14.1 file adds `or-jev` once, with a notice and a backup. */
    const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_profile_upgrade_");
    const settingsPath = join(tmpConfigDir, "settings.yaml");
    writeFileSync(settingsPath, MULTI_PROFILE_SETTINGS_YAML, "utf-8");
    const run = () =>
      execFileAsync("node", [CLI_SCRIPT, "profile", "--profile", "local-a", "--show", "local-a", "--quiet"], {
        env: { ...process.env, LLM_EXT_CONFIG_DIR: tmpConfigDir, LLM_EXT_INSTALL_RULE: "0" },
        // 60s, not 15s: this spawns a cold Node process running the real CLI, and
        // the gate that runs it (publish.py) runs it while the machine is also
        // type-checking, linting and building. A 15s budget failed there while
        // passing every time in isolation. See c0a3b6f6 — the same fix, applied
        // to the file that hit it first; these never received it.
        timeout: 60_000,
      });
    const { readFileSync, readdirSync } = await import("node:fs");
    const first = await run();
    const afterFirst = readFileSync(settingsPath, "utf-8");
    expect(afterFirst).not.toBe(MULTI_PROFILE_SETTINGS_YAML);
    expect(afterFirst.startsWith(MULTI_PROFILE_SETTINGS_YAML.trimEnd().split("\n")[0])).toBe(true);
    expect(afterFirst).toContain("or-jev:");
    expect(afterFirst).toMatch(/^active_classifier: or-jev$/m);
    expect(first.stderr).toContain("'or-jev-section-added' migration added the classifier profile 'or-jev'");
    expect(first.stderr).toContain("A backup of settings.yaml exists in");
    expect(readdirSync(join(tmpConfigDir, "backups")).some((f) => f.includes("-or-jev-"))).toBe(true);
    const second = await run();
    expect(readFileSync(settingsPath, "utf-8")).toBe(afterFirst);
    expect(second.stderr).not.toContain("or-jev-section-added");
  });

});
