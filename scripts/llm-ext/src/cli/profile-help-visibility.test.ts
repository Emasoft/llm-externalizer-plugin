/**
 * `--profile <name>` discoverability (owner requirement, verbatim: "the
 * profile should be specified in any command requiring the use of profiles,
 * in the same line, with `--profile <profile name>`"). The flag itself is
 * parsed centrally in extractProfileFlag() (main.ts) and already worked
 * before this test file existed — this only covers whether per-command
 * `--help` SHOWS it, and only for commands that actually use it.
 *
 * Spawns the real compiled CLI (dist/llm-ext.js), no mocking.
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);

const SETTINGS_YAML = [
  "active: prof-a",
  "profiles:",
  "  prof-a:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-a",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "",
].join("\n");

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_profilehelp_cfg_");
  writeFileSync(join(tmpConfigDir, "settings.yaml"), SETTINGS_YAML, "utf-8");
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_SCRIPT, ...args], {
      env: { ...process.env, LLM_EXT_CONFIG_DIR: tmpConfigDir, LLM_EXT_INSTALL_RULE: "0" },
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim(), exitCode: e.code ?? null };
  }
}

describe("--profile visibility in per-command --help", () => {
  it("a profile-using command (chat) advertises --profile in its own help", async () => {
    const r = await run(["chat", "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/--profile\s+\[string\]/);
  });

  it.each(["scan_folder", "compare_files", "check_references", "mass_scout"])(
    "%s also advertises --profile in its own help",
    async (cmd) => {
      const r = await run([cmd, "--help", "--quiet"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/--profile\s+\[string\]/);
    },
  );

  it("a non-profile command (reset) does NOT advertise --profile", async () => {
    const r = await run(["reset", "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/--profile/);
  });

  it.each(["discover", "get_settings", "or_model_info", "assess_model", "rules_check", "review_plan"])(
    "%s (no LLM call) does NOT advertise --profile",
    async (cmd) => {
      const r = await run([cmd, "--help", "--quiet"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toMatch(/--profile/);
    },
  );

  it("the top-level --help still mentions --profile as a global flag", async () => {
    const r = await run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/--profile <name>/);
  });
});

describe("--profile still dispatches correctly (no regression from the help injection)", () => {
  it("a valid --profile still runs the command", async () => {
    const r = await run(["discover", "--profile", "prof-a", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Active profile: prof-a/);
  });

  it("an unknown --profile still fails fast and lists the real available profiles", async () => {
    const r = await run(["discover", "--profile", "nonesuch", "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown profile 'nonesuch'/);
    expect(r.stderr).toMatch(/prof-a/);
  });
});
