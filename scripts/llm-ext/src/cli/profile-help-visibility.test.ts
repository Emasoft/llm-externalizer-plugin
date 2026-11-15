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
import { runCliInTempConfig as run } from "../test-helpers.js";
import { DRY_RUN_SUPPORT, type ProfileAwareTool } from "./dry-run-flags.js";

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

// Needs a rebuilt dist/llm-ext.js (the suite spawns the compiled CLI).
// TRDD-58CFBQHN: a command's help lists --estimate / --preview exactly when DRY_RUN_SUPPORT says it accepts them; dry-run-flags.test.ts binds that table to what the two flags really do.
describe("--estimate and --preview visibility in per-command --help (TRDD-58CFBQHN)", () => {
  const rows = (stdout: string) => ({
    estimate: /--estimate\s+\[boolean\]/.test(stdout),
    preview: /--preview\s+\[boolean\]/.test(stdout),
  });

  it.each(Object.entries(DRY_RUN_SUPPORT))(
    "%s lists exactly the dry-run flags it accepts",
    async (cmd, support) => {
      const r = await run([cmd, "--help", "--quiet"]);
      expect(r.exitCode).toBe(0);
      expect(rows(r.stdout)).toEqual(support);
    },
  );

  // WHY these three: they exist only as flat commands (no group action), and help reaches the same table through printToolHelp's flat call.
  it.each<[string, ProfileAwareTool]>([
    ["batch-check", "batch_check"],
    ["security-triage-benchmark", "security_triage_benchmark"],
    ["search-existing-benchmark", "search_existing_benchmark"],
  ])("flat-only spelling %s reads the same table as %s", async (spelling, name) => {
    const r = await run([spelling, "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(rows(r.stdout)).toEqual(DRY_RUN_SUPPORT[name]);
  });

  it.each<[string[], ProfileAwareTool]>([
    [["scan", "folder"], "scan_folder"],
    [["llm", "summarize"], "summarize"],
    [["scan", "security"], "security_scan"],
  ])("grouped help (%s) lists exactly what %s accepts", async (invocation, name) => {
    const r = await run([...invocation, "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(rows(r.stdout)).toEqual(DRY_RUN_SUPPORT[name]);
  });

  it("a no-LLM command (reset) lists neither", async () => {
    const r = await run(["reset", "--help", "--quiet"]);
    expect(r.stdout).not.toMatch(/--estimate|--preview/);
  });
});
describe("--profile still dispatches correctly (no regression from the help injection)", () => {
  it("a valid --profile still runs the command", async () => {
    const r = await run(["discover", "--profile", "prof-a", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Effective profile: prof-a \(source: --profile\)/);
  });

  it("an unknown --profile still fails fast and lists the real available profiles", async () => {
    const r = await run(["discover", "--profile", "nonesuch", "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown profile 'nonesuch'/);
    expect(r.stderr).toMatch(/prof-a/);
  });
});
