/**
 * Tests for the `config` -> `settings` group rename (settings-rename task).
 *
 * - `llm-ext settings <action>` replaces `llm-ext config <action>` (no alias —
 *   this project's no-backward-compatibility rule).
 * - `settings show` (get_settings) now prints the ACTIVE profile's resolved
 *   settings to stdout, in addition to copying settings.yaml to the output dir.
 * - `settings profiles` (list_profiles) lists every profile in settings.yaml
 *   with a marker on the active one, and never crashes on a missing file.
 *
 * The CLI-spawn tests reuse profile.test.ts's pattern (throwaway config dir,
 * `mode: local` + unreachable URL profiles — zero network, zero billing).
 * The "missing settings.yaml" case is instead tested directly against
 * config.ts's pure formatters: `src/index.ts` (and therefore the compiled
 * CLI entrypoint) runs `ensureSettingsExist()` at import time, which ALWAYS
 * auto-creates settings.yaml before any command dispatches — so a full CLI
 * spawn can never actually observe a missing file. config.ts itself has no
 * such side effect, so importing it directly lets the test point
 * `LLM_EXT_CONFIG_DIR` at a directory that genuinely has no settings.yaml.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CLI_SCRIPT } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

/** Same shape as profile.test.ts's fixture: local + unreachable, zero network. */
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

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn the real compiled CLI against a throwaway settings.yaml. */
async function runCliWithSettings(
  settingsYaml: string,
  args: string[],
): Promise<RunResult & { configDir: string; settingsPath: string }> {
  const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_settingsgrp_cfg_");
  const settingsPath = join(tmpConfigDir, "settings.yaml");
  writeFileSync(settingsPath, settingsYaml, "utf-8");
  const outputDir = mkdtempSync("/tmp/__llm_ext_settingsgrp_out_");

  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_SCRIPT, ...args, "--quiet"], {
      env: {
        ...process.env,
        LLM_EXT_CONFIG_DIR: tmpConfigDir,
        LLM_OUTPUT_DIR: outputDir,
        LLM_EXT_INSTALL_RULE: "0",
      },
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, configDir: tmpConfigDir, settingsPath };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
      exitCode: e.code ?? null,
      configDir: tmpConfigDir,
      settingsPath,
    };
  }
}

const tmpDirsToClean: string[] = [];
afterEach(() => {
  while (tmpDirsToClean.length > 0) {
    const dir = tmpDirsToClean.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("settings group replaces config (no backward-compat alias)", () => {
  it("'llm-ext settings --help' resolves and lists the group's actions", async () => {
    const { stdout, stderr } = await execFileAsync("node", [CLI_SCRIPT, "settings", "--help"]);
    const out = stdout + stderr;
    expect(out).toMatch(/settings <action>/);
    expect(out).toMatch(/\bshow\b/);
    expect(out).toMatch(/\bprofile\b/);
    expect(out).toMatch(/\bprofiles\b/);
    expect(out).toMatch(/\breset\b/);
    expect(out).toMatch(/\bstatus\b/);
    expect(out).toMatch(/scan-local/);
  });

  it("'llm-ext config <anything>' no longer resolves — the group is gone", async () => {
    const result = await runCliWithSettings(MULTI_PROFILE_SETTINGS_YAML, ["config", "show"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown command 'config'/);
    tmpDirsToClean.push(result.configDir);
  });
});

describe("settings show — prints the ACTIVE profile's resolved settings", () => {
  it("prints the active profile's fields to stdout (not just a file path)", async () => {
    const result = await runCliWithSettings(MULTI_PROFILE_SETTINGS_YAML, ["settings", "show"]);
    tmpDirsToClean.push(result.configDir);
    expect(result.exitCode).toBe(0);
    // local-b is 'active' in the fixture.
    expect(result.stdout).toMatch(/Profile: local-b \(ACTIVE\)/);
    expect(result.stdout).toMatch(/Model: model-b/);
    expect(result.stdout).toMatch(/Mode: local/);
    // The file-copy behaviour is preserved alongside the printed summary.
    expect(result.stdout).toMatch(/settings_edit\.yaml/);
  });

  it("never mutates settings.yaml on disk", async () => {
    const result = await runCliWithSettings(MULTI_PROFILE_SETTINGS_YAML, ["settings", "show"]);
    tmpDirsToClean.push(result.configDir);
    expect(result.exitCode).toBe(0);
    const after = readFileSync(result.settingsPath, "utf-8");
    expect(after).toBe(MULTI_PROFILE_SETTINGS_YAML);
  });
});

describe("settings profiles — lists every profile, marks exactly one active", () => {
  it("lists every profile from the fixture and marks exactly local-b active", async () => {
    const result = await runCliWithSettings(MULTI_PROFILE_SETTINGS_YAML, ["settings", "profiles"]);
    tmpDirsToClean.push(result.configDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/local-a/);
    expect(result.stdout).toMatch(/local-b/);
    expect(result.stdout).toMatch(/remote-free/);

    // Only match profile rows ("* name — mode / api — model"), not the
    // trailing legend line ("* = active profile...") which also starts "* ".
    const lines = result.stdout.split("\n");
    const activeLines = lines.filter((l) => /^\* \S+ — /.test(l));
    expect(activeLines).toHaveLength(1);
    expect(activeLines[0]).toMatch(/local-b/);

    const inactiveA = lines.find((l) => l.includes("local-a"));
    expect(inactiveA).toMatch(/^ {2}/);
  });

  it("never mutates settings.yaml on disk", async () => {
    const result = await runCliWithSettings(MULTI_PROFILE_SETTINGS_YAML, ["settings", "profiles"]);
    tmpDirsToClean.push(result.configDir);
    expect(result.exitCode).toBe(0);
    const after = readFileSync(result.settingsPath, "utf-8");
    expect(after).toBe(MULTI_PROFILE_SETTINGS_YAML);
  });
});

describe("missing settings.yaml — graceful message, never a crash", () => {
  it("formatProfilesList() reports the missing file plainly instead of throwing", async () => {
    const emptyDir = mkdtempSync("/tmp/__llm_ext_settingsgrp_missing_");
    tmpDirsToClean.push(emptyDir);
    expect(existsSync(join(emptyDir, "settings.yaml"))).toBe(false);

    const prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = emptyDir;
    try {
      // config.ts is a pure library module (no top-level side effects), so
      // importing it does NOT auto-create settings.yaml the way importing
      // src/index.ts would — this is the only way to genuinely observe the
      // missing-file path.
      const { formatProfilesList, formatActiveProfileSummary } = await import("./config.js");
      const profilesText = formatProfilesList();
      expect(profilesText).toMatch(/No settings file found/);
      expect(profilesText).toMatch(/created automatically/);

      const summaryText = formatActiveProfileSummary();
      expect(summaryText).toMatch(/No settings file found/);
      expect(summaryText).toMatch(/created automatically/);

      // Still no file on disk — read-only, never mutates.
      expect(existsSync(join(emptyDir, "settings.yaml"))).toBe(false);
    } finally {
      if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
    }
  });
});

describe("settings profiles — machine-managed vs user, and unpopulated rendering", () => {
  /** Point config.ts at a throwaway dir holding `yaml`, then read the listing. */
  async function listingFor(yaml: string): Promise<string> {
    const dir = mkdtempSync(join("/tmp", "settings-listing-"));
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
    try {
      writeFileSync(join(dir, "settings.yaml"), yaml);
      const { formatProfilesList } = await import("./config.js");
      return formatProfilesList();
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const UNPOPULATED_DEFAULTS = [
    "active: free",
    "profiles:",
    "  free:",
    "    mode: remote-ensemble",
    "    api: openrouter-remote",
    "    free_only: true",
    "    free_models: []",
    "    model: placeholder/unpopulated-default-profile",
    "    api_key: $OPENROUTER_API_KEY",
    // paid-ensemble is NOT free_only, so its unpopulated state is carried by the
    // sentinel `model` itself. This is the profile that actually exercised the
    // bug: the old renderer printed the model slots verbatim, so the raw
    // `placeholder/...` id appeared in the listing. A free_only profile alone
    // would NOT have caught it — it rendered as "free_only (0 models)".
    "  paid-ensemble:",
    "    mode: remote-ensemble",
    "    api: openrouter-remote",
    "    model: placeholder/unpopulated-default-profile",
    "    second_model: placeholder/unpopulated-default-profile",
    "    third_model: placeholder/unpopulated-default-profile",
    "    api_key: $OPENROUTER_API_KEY",
    "  my-own:",
    "    mode: local",
    "    api: generic-local",
    "    model: model-a",
    "    url: http://127.0.0.1:1",
    "",
  ].join("\n");

  it("NEVER prints the raw placeholder sentinel id — it reads as a broken config the user must repair, when it is a normal pre-benchmark state", async () => {
    const text = await listingFor(UNPOPULATED_DEFAULTS);
    expect(text).not.toContain("placeholder/unpopulated-default-profile");
    expect(text).toMatch(/not benchmarked yet/i);
  });

  it("labels a machine-managed default but NOT a user profile — only the 5 machine-managed default profiles refresh themselves", async () => {
    const text = await listingFor(UNPOPULATED_DEFAULTS);
    const freeLine = text.split("\n").find((l) => l.includes("free —") || l.includes("free ["));
    const userLine = text.split("\n").find((l) => l.includes("my-own"));
    expect(freeLine).toBeDefined();
    expect(userLine).toBeDefined();
    expect(freeLine).toContain("[machine-managed]");
    expect(userLine).not.toContain("[machine-managed]");
  });

  it("omits the unpopulated explainer once every default carries real models — the note is guidance, not decoration", async () => {
    const populated = [
      "active: free",
      "profiles:",
      "  free:",
      "    mode: remote-ensemble",
      "    api: openrouter-remote",
      "    free_only: true",
      "    free_models:",
      "      - vendor/a:free",
      "      - vendor/b:free",
      "    model: vendor/a:free",
      "    api_key: $OPENROUTER_API_KEY",
      "",
    ].join("\n");
    const text = await listingFor(populated);
    expect(text).not.toMatch(/not benchmarked yet/i);
    expect(text).not.toMatch(/Unpopulated profiles are expected/i);
    // Still labelled — populated does not mean user-owned.
    expect(text).toContain("[machine-managed]");
  });
});
