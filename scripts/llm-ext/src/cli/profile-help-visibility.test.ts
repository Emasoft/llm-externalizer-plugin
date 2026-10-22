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
    expect(r.stdout).toMatch(/Effective profile: prof-a \(source: --profile\)/);
  });

  it("an unknown --profile still fails fast and lists the real available profiles", async () => {
    const r = await run(["discover", "--profile", "nonesuch", "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown profile 'nonesuch'/);
    expect(r.stderr).toMatch(/prof-a/);
  });
});
