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
  "  local-b:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-b",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "  remote-free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models:",
  "      - vendor/model-x:free",
  "      - vendor/model-y:free",
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
          LLM_OUTPUT_DIR: outputDir,
          LLM_EXT_INSTALL_RULE: "0",
        },
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
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

  it("with no flags lists every profile and marks the active one", async () => {
    /** Default (no args) = list mode: every profile name, active marker, mode/backend/model */
    const result = await runProfileCli(MULTI_PROFILE_SETTINGS_YAML, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/local-a/);
    expect(result.stdout).toMatch(/local-b/);
    expect(result.stdout).toMatch(/remote-free/);
    // local-b is 'active' in the fixture — its line must carry the marker,
    // local-a's must not.
    const activeLine = result.stdout.split("\n").find((l) => l.includes("local-b"));
    const inactiveLine = result.stdout.split("\n").find((l) => l.includes("local-a"));
    expect(activeLine).toMatch(/^\* /);
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

  it("--show on the active profile marks it ACTIVE", async () => {
    const result = await runProfileCli(MULTI_PROFILE_SETTINGS_YAML, ["--show", "local-b"]);
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

  it("fails fast (not an empty list) when settings.yaml has zero profiles", async () => {
    /** An empty profiles map is a configuration error, not "nothing to show yet" */
    const result = await runProfileCli(EMPTY_PROFILES_SETTINGS_YAML, []);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/No profiles defined/);
  });

  it("never mutates settings.yaml on disk", async () => {
    /** Read-only contract: profile add/select/edit/remove is user-only (see the tool description) */
    const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_profile_immut_");
    const settingsPath = join(tmpConfigDir, "settings.yaml");
    writeFileSync(settingsPath, MULTI_PROFILE_SETTINGS_YAML, "utf-8");
    const before = writeFileSync; // no-op reference just to keep intent obvious
    void before;
    const beforeContent = MULTI_PROFILE_SETTINGS_YAML;

    await execFileAsync("node", [CLI_SCRIPT, "profile", "--show", "local-a", "--quiet"], {
      env: { ...process.env, LLM_EXT_CONFIG_DIR: tmpConfigDir, LLM_EXT_INSTALL_RULE: "0" },
      timeout: 15_000,
    });

    const { readFileSync } = await import("node:fs");
    const afterContent = readFileSync(settingsPath, "utf-8");
    expect(afterContent).toBe(beforeContent);
  });
});
