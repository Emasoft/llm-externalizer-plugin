/**
 * TRDD-LFWV2DKG: the BUILT CLI (dist/llm-ext.js) end to end with a settings.yaml whose load throws at boot.
 *
 * Ruling (orchestrator, 2026-11-20): after a failed settings load the four gate-exempt tools (discover, get_settings, list_profiles, profile) must RUN
 * (no gate refusal line), print their diagnostic, and ALL exit NON-ZERO; work commands are refused by the gate (FBWXV4JF, 6f1089eb).
 * boot-failed-settings.test.ts and active-precedence.test.ts only cover this in-process; this file spawns the real bundle.
 *
 * The throw is real, not mocked: settings.yaml is a DIRECTORY (EISDIR), as in boot-failed-settings.test.ts. Every spawn gets a hermetic
 * environment (fresh HOME, config dir and output dir, no OpenRouter key, no detached helpers). NOT asserted: that no request is made; only the
 * hermetic environment (no API key) bounds the network. Limit: EISDIR is the only failure fixture; other load failures are not exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);

// TRDD-LA1MA1EL: Windows has no /tmp; there the runner temp root is the base. Elsewhere the literal /tmp the config-dir allowlist names. TRDD-VQ0VEK3L: the config-dir guard (config.ts:922-928) allows only home or /tmp, and USERPROFILE points at root/home, so cfgDir sits under root/home.
const TMP_BASE = process.platform === "win32" ? tmpdir() : "/tmp";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

let root: string;
let cfgDir: string;
let inputFile: string;

beforeEach(() => {
  root = mkdtempSync(join(TMP_BASE, "llm-ext-failedcfg-"));
  cfgDir = join(root, "home", "cfg");
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "out"));
  mkdirSync(join(cfgDir, "settings.yaml"), { recursive: true });
  inputFile = join(root, "input.txt");
  writeFileSync(inputFile, "hello world\n", "utf-8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Spawn the built CLI with a minimal environment (nothing inherited but PATH): no API key can reach it. */
async function runCli(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(root, "home"),
        USERPROFILE: join(root, "home"),
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        LLM_EXT_CONFIG_DIR: cfgDir,
        LLM_EXT_OUTPUT_DIR: join(root, "out"),
        LLM_EXT_INSTALL_RULE: "0",
        LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1",
        LLM_EXT_DISABLE_AUTO_RECONCILE: "1",
      },
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null; signal?: string | null };
    return {
      stdout: e.stdout ?? "",
      stderr: e.signal ? `${e.stderr ?? ""}\n[test harness] child killed by ${e.signal} - args: ${args.join(" ")}` : (e.stderr ?? ""),
      exitCode: e.code ?? null,
    };
  }
}

/** The gate's own refusal line (main.ts); the boot warning is "[llm-externalizer] ..." and the handlers print no "llm-ext:" prefix. */
const GATE_REFUSAL = /^llm-ext: Failed to load settings/m;

/** Each gate-exempt verb with the diagnostic it prints (read from a probe run of the built CLI; every one lands on stderr). After a failed boot load show/profiles/profile print the boot's own error (index.ts guard), discover its NOT CONFIGURED report. */
const EXEMPT_VERBS: ReadonlyArray<{ args: string[]; tool: string; diagnostic: string }> = [
  { args: ["settings", "show", "--quiet"], tool: "get_settings", diagnostic: "Failed to load settings: EISDIR" },
  { args: ["settings", "status", "--quiet"], tool: "discover", diagnostic: "NOT CONFIGURED" },
  { args: ["settings", "profiles", "--quiet"], tool: "list_profiles", diagnostic: "Failed to load settings: EISDIR" },
  { args: ["settings", "profile", "--quiet"], tool: "profile", diagnostic: "Failed to load settings: EISDIR" },
];

describe("TRDD-LFWV2DKG - built CLI after a failed settings load (settings.yaml is a directory)", () => {
  for (const { args, tool, diagnostic } of EXEMPT_VERBS) {
    // Proves: the gate-exempt tool runs (no gate refusal line), prints its diagnostic and exits with a real non-zero code (null would mean killed).
    it(`${args.slice(0, 2).join(" ")} (${tool}) is not gate-refused, names the failure and exits non-zero`, async () => {
      const r = await runCli(args);
      const out = `stdout: ${r.stdout}\nstderr: ${r.stderr}`;
      expect(r.stderr).not.toMatch(GATE_REFUSAL);
      expect(`${r.stdout}\n${r.stderr}`, out).toContain(diagnostic);
      expect(r.exitCode, out).not.toBeNull();
      expect(r.exitCode, out).not.toBe(0);
    });
  }

  // Proves: `settings profile --show free` never resolves the in-memory generated default: it exits non-zero and prints no resolved-profile line.
  it("settings profile --show free exits non-zero and prints no resolved-profile lines", async () => {
    const r = await runCli(["settings", "profile", "--show", "free", "--quiet"]);
    const out = `stdout: ${r.stdout}\nstderr: ${r.stderr}`;
    expect(r.exitCode, out).not.toBeNull();
    expect(r.exitCode, out).not.toBe(0);
    // formatResolvedProfileLines always prints "Auth: set|NOT SET" and "Context window: ..." (config.ts).
    expect(`${r.stdout}\n${r.stderr}`, out).not.toMatch(/^Auth: /m);
    expect(`${r.stdout}\n${r.stderr}`, out).not.toContain("Context window:");
    expect(`${r.stdout}\n${r.stderr}`, out).toContain("Failed to load settings: EISDIR");
  });

  // Proves: a work command is refused by main.ts with the settings error before any request is made.
  it("a work command (llm ask) exits non-zero, names 'Failed to load settings' and the settings path", async () => {
    const r = await runCli(["llm", "ask", inputFile, "--instructions", "say hi", "--quiet"]);
    expect(r.exitCode, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).not.toBe(0);
    expect(r.stderr).toMatch(GATE_REFUSAL);
    expect(r.stderr).toContain("settings.yaml");
    expect(r.stdout).toBe("");
  });

  // Proves: an explicit --profile is never silently dropped: the exempt tool is gate-refused too.
  it("settings show WITH --profile free exits non-zero with the gate refusal", async () => {
    const r = await runCli(["settings", "show", "--profile", "free", "--quiet"]);
    expect(r.exitCode, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).not.toBe(0);
    expect(r.stderr).toMatch(GATE_REFUSAL);
  });
});
