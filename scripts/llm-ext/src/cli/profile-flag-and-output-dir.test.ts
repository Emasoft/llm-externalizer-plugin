/**
 * Integration tests for two owner-specified gaps (profile+output-flags task):
 *
 *   1. `--profile <name>` — a GLOBAL flag (handled centrally in main.ts, not
 *      per-tool schema) that overrides which settings.yaml profile ONE
 *      invocation uses, without ever touching the file on disk.
 *   2. `-o`/`--output_dir` now works on report-writing commands that
 *      previously declared no output parameter at all (scan_folder among
 *      them), while genuinely report-less commands (get_settings / "config
 *      show") keep the honest "no output option" error.
 *
 * Spawns the real compiled CLI (dist/llm-ext.js) against throwaway
 * settings.yaml / config dirs — no mocking of config.ts or main.ts. All
 * profiles are `mode: local` pointed at an unreachable port (127.0.0.1:1)
 * with a short timeout, so nothing here can hit the network or bill
 * OpenRouter (mirrors the cost-safety discipline in test-helpers.ts).
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);

/** Two LOCAL, unreachable profiles so a real override is observable —
 * different model names make "which one is active" unambiguous in output. */
const TWO_PROFILE_SETTINGS_YAML = [
  "active: prof-a",
  "profiles:",
  "  prof-a:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-a",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "  prof-b:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-b",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "",
].join("\n");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn the real CLI against a throwaway config dir seeded with
 * TWO_PROFILE_SETTINGS_YAML, with `args` passed through VERBATIM (so tests
 * control exact --profile positioning) — no serializeFlags() re-ordering. */
async function runRaw(args: string[]): Promise<RunResult> {
  const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_profileflag_cfg_");
  writeFileSync(join(tmpConfigDir, "settings.yaml"), TWO_PROFILE_SETTINGS_YAML, "utf-8");
  const outputDir = mkdtempSync("/tmp/__llm_ext_profileflag_out_");

  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_SCRIPT, ...args], {
      env: {
        ...process.env,
        LLM_EXT_CONFIG_DIR: tmpConfigDir,
        LLM_OUTPUT_DIR: outputDir,
        LLM_EXT_INSTALL_RULE: "0",
      },
      // 60s, not 15s: this spawns a cold Node process running the real CLI, and
      // the gate that runs it (publish.py) runs it while the machine is also
      // type-checking, linting and building. A 15s budget failed there while
      // passing every time in isolation.
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
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

describe("--profile <name> global flag", () => {
  it("positioned AFTER the command overrides the active profile for this call", async () => {
    // settings.yaml's active is prof-a; override to prof-b.
    const r = await runRaw(["discover", "--profile", "prof-b", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Active profile: prof-b/);
    expect(r.stdout).toMatch(/Model: model-b/);
  });

  it("positioned BEFORE the command also overrides the active profile", async () => {
    const r = await runRaw(["--profile", "prof-b", "discover", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Active profile: prof-b/);
  });

  it("an unknown profile fails fast and lists the real available profiles", async () => {
    const r = await runRaw(["discover", "--profile", "nonesuch", "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown profile 'nonesuch'/);
    expect(r.stderr).toMatch(/prof-a/);
    expect(r.stderr).toMatch(/prof-b/);
  });

  it("never mutates settings.yaml on disk", async () => {
    const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_profileflag_immut_");
    const settingsPath = join(tmpConfigDir, "settings.yaml");
    writeFileSync(settingsPath, TWO_PROFILE_SETTINGS_YAML, "utf-8");

    await execFileAsync(
      "node",
      [CLI_SCRIPT, "discover", "--profile", "prof-b", "--quiet"],
      {
        env: { ...process.env, LLM_EXT_CONFIG_DIR: tmpConfigDir, LLM_EXT_INSTALL_RULE: "0" },
        // Same 60s budget and same reason as runRaw above — a cold CLI spawn on
        // a machine busy running the rest of the publish gate.
        timeout: 60_000,
      },
    );

    const afterContent = readFileSync(settingsPath, "utf-8");
    expect(afterContent).toBe(TWO_PROFILE_SETTINGS_YAML);
    // The file's own 'active:' line must still read prof-a — the override
    // never touched it.
    expect(afterContent).toMatch(/^active: prof-a$/m);
  });

  it("without --profile the settings.yaml active profile is used as before", async () => {
    const r = await runRaw(["discover", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Active profile: prof-a/);
  });
});

describe("-o / --output_dir on report-writing commands (profile+output-flags task)", () => {
  it("scan folder -o dispatches with --output_dir instead of erroring", async () => {
    // Omit `instructions` (required) so the tool fails fast with a
    // deterministic validation error, no network — proving the CLI parsed
    // --output_dir as a known flag and reached the tool's own validation,
    // not a schema rejection. Folder is EMPTY but real (sanitizeInputPath's
    // realpath check needs the path to exist — see the check-against-specs
    // test below for the nonexistent-leaf case).
    const emptyDir = mkdtempSync("/tmp/__llm_ext_profileflag_scanempty_");
    const outDir = mkdtempSync("/tmp/__llm_ext_profileflag_scanout_");
    const r = await runRaw([
      "scan",
      "folder",
      emptyDir,
      "-o",
      outDir,
      "--quiet",
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/instructions/);
    // Must NOT be the flat-parser's "unknown flag" rejection, and must NOT
    // be the launcher's "no output option" error — --output_dir was accepted.
    expect(r.stderr).not.toMatch(/unknown flag/);
    expect(r.stderr).not.toMatch(/no output option/);
  });

  it("settings show (get_settings) -o still returns the honest 'no output option' error", async () => {
    const outDir = mkdtempSync("/tmp/__llm_ext_profileflag_noout_");
    const r = await runRaw(["settings", "show", "-o", outDir, "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no output option/);
    expect(r.stderr).toMatch(/settings show/);
  });
});

describe("output_dir threading survives on the report-writing commands", () => {
  it("check-against-specs -o dispatches with --output_dir instead of erroring", async () => {
    // Nonexistent spec_file_path fails fast, no network — same proof pattern
    // as scan folder above, for a command whose schema was hand-written
    // (not shared via folderSchemaProps). Rooted under process.cwd() (an
    // allowed root that needs no realpath translation, unlike /tmp on
    // macOS -> /private/tmp) so a MISSING leaf still resolves inside the
    // sanitizeInputPath whitelist instead of tripping the traversal guard.
    const missingSpec = join(
      process.cwd(),
      "__llm_ext_profileflag_csmissing__",
      "does-not-exist.md",
    );
    const someInput = mkdtempSync("/tmp/__llm_ext_profileflag_csinput_");
    writeFileSync(join(someInput, "a.txt"), "hello", "utf-8");
    const outDir = mkdtempSync("/tmp/__llm_ext_profileflag_csout_");
    const r = await runRaw([
      "check",
      "specs",
      missingSpec,
      "--input_files_paths",
      join(someInput, "a.txt"),
      "-o",
      outDir,
      "--quiet",
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).not.toMatch(/unknown flag/);
    expect(r.stderr).not.toMatch(/no output option/);
  });
});
