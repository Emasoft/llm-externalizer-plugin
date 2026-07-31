// Integration regression test for the launcher → CLI handoff.
//
// WHY THIS FILE EXISTS (unchanged in spirit since the -32001 bug): every other
// test in this repo imports the TypeScript sources DIRECTLY. None of them
// exercise the chain a real user runs — `bin/llm-ext` → `launcher.mjs` →
// `dist/llm-ext.js`. That gap once let 1543 tests pass while the shipped MCP
// server did not boot at all (Claude Code error -32001).
//
// The gap survived the move to a CLI, and bit immediately: removing the MCP
// server left a `watchFile()` call at MODULE SCOPE in index.ts. Importing the
// engine registered a 5-second poller that kept Node's event loop alive
// forever, so `llm-ext --help` printed its output and then HUNG until killed.
// Every one of the 1645 unit tests passed while the shipped binary was unusable.
//
// So this test spawns the REAL launcher against the REAL bundle and asserts two
// things a direct import can never check:
//   1. the handoff reaches the CLI and produces correct output, and
//   2. THE PROCESS EXITS — no lingering timer, watcher, or open handle.
// If you ever reintroduce a module-scope handle in index.ts, this test is what
// tells you, instead of a user filing "llm-ext never returns".

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = resolve(SRC_DIR, "..", "launcher.mjs");
const DIST_CLI = resolve(SRC_DIR, "..", "dist", "llm-ext.js");

// The launcher imports the built bundle; if the suite runs without a prior
// `npm run build`, fail loudly rather than silently skipping the regression.
const distReady = existsSync(DIST_CLI);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn the real launcher and wait for it to exit (or time out). */
function runLauncher(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child: ChildProcess = spawn(process.execPath, [LAUNCHER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Deterministic auth without touching the keychain or the network.
        // `--help` makes no backend call; a dummy key just lets auth resolution
        // succeed so we are testing the handoff, not the credential lookup.
        OPENROUTER_API_KEY:
          process.env.OPENROUTER_API_KEY ??
          "sk-or-v1-test-dummy-key-for-launcher-boot-regression",
        // Never let the spawned process install the usage rule into the real
        // ~/.claude/rules/ during a test run.
        LLM_EXT_INSTALL_RULE: "0",
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // SIGKILL, not SIGTERM: the failure mode we are guarding against is a
      // process that will not leave on its own.
      child.kill("SIGKILL");
      resolvePromise({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${err}`, timedOut: false });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut: false });
    });
  });
}

describe("launcher → CLI handoff (regressions: -32001, module-scope hang)", () => {
  it("the real launcher runs the real bundle and EXITS", async () => {
    expect(
      distReady,
      `dist/llm-ext.js missing at ${DIST_CLI} — run \`npm run build\` first`,
    ).toBe(true);

    // 30s is enormous for `--help` (it takes ~0.2s). A timeout here does not
    // mean "slow", it means "hung" — the exact bug this guards.
    const run = await runLauncher(["--help"], 30_000);

    expect(
      run.timedOut,
      `launcher did not exit within 30s — something in the import graph is ` +
        `keeping the event loop alive (a module-scope timer/watcher/handle).\n` +
        `stdout so far:\n${run.stdout}\nstderr so far:\n${run.stderr}`,
    ).toBe(false);

    expect(run.code, `launcher exited non-zero.\nstderr:\n${run.stderr}`).toBe(0);

    // It reached the real CLI, not just "a process that ran and quit".
    expect(run.stdout).toContain("llm-ext");
    expect(run.stdout).toContain("Commands:");
    // Spot-check one core tool and one mass-scout tool so a half-populated
    // catalog (e.g. a broken buildTools import) still fails.
    expect(run.stdout).toContain("scan-folder");
    expect(run.stdout).toContain("mass-scout-register");
  }, 45_000);

  it("an unknown command fails loudly instead of hanging or exiting 0", async () => {
    expect(distReady).toBe(true);

    const run = await runLauncher(["definitely-not-a-real-command"], 30_000);

    expect(run.timedOut, "unknown command hung instead of failing").toBe(false);
    expect(run.code, "an unknown command must be a non-zero exit").not.toBe(0);
    expect(run.stderr).toContain("unknown command");
  }, 45_000);
});
