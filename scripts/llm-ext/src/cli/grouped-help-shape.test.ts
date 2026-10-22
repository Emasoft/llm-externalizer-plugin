/**
 * The grouped help must show the invocation the user actually types.
 *
 * REGRESSION GUARD. `printToolHelp()` used to print the FLAT catalog name as
 * its header even when reached through a group, so `llm-ext llm summarize
 * --help` announced itself as `llm-ext summarize` — a form the grouped syntax
 * rejects, so anyone copying the header got an error. The renderer had zero
 * coverage, which is how that shipped; these assertions are the pin.
 *
 * Spawns the real compiled CLI (dist/llm-ext.js), no mocking.
 */

import { describe, it, expect } from "vitest";
import { runCliInTempConfig as run } from "../test-helpers.js";

describe("grouped action --help shows the grouped invocation", () => {
  it.each([
    ["llm", "summarize"],
    ["llm", "topics"],
    ["scan", "folder"],
    ["session", "compact"],
  ])("'%s %s --help' headers and uses the grouped form", async (group, action) => {
    const r = await run([group, action, "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    // The header line — the exact thing that was wrong.
    expect(r.stdout.split("\n")[0]).toBe(`llm-ext ${group} ${action}`);
    // And the Usage line must name the same form, not the flat command.
    expect(r.stdout).toContain(`Usage:\n  llm-ext ${group} ${action}`);
  });

  it("shows a runnable Example carrying the positional argument", async () => {
    const r = await run(["llm", "summarize", "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Example:\n {2}llm-ext llm summarize \S/);
    // The positional is otherwise invisible: help lists --input_file but never
    // says the value may be passed bare, which is how the docs call it.
    expect(r.stdout).toContain("--input_file");
  });

  it("the FLAT path still shows the flat name, which is what it accepts", async () => {
    const r = await run(["summarize", "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("llm-ext summarize");
  });
});

describe("group --help describes actions instead of leaking internal names", () => {
  it("does not print the internal 'action -> flat_command' arrow", async () => {
    const r = await run(["scan", "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("llm-ext scan <action>");
    // `folder  -> scan-folder` exposed a name the grouped syntax cannot accept.
    expect(r.stdout).not.toMatch(/->\s*scan-folder/);
    // Pins the SHAPE, not the action. This line used to demand `scan folder`,
    // which pinned a broken example: scan_folder's handler refuses without
    // --instructions, so the advertised one-liner died. The example now falls
    // through to the first action that actually runs.
    expect(r.stdout).toMatch(/Example:\n {2}llm-ext scan \w[\w-]* \S/);
  });
});

// An Example the reader cannot paste is worse than no Example. `mass_scout`
// declares four required flags, so `llm-ext scout run` dies in parseFlags —
// yet it shipped as this group's worked example.
describe("an Example is printed only when it can actually run", () => {
  it("omits the Example for an action whose required flags the positional cannot fill", async () => {
    const r = await run(["scout", "run", "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--db_path");
    expect(r.stdout).not.toContain("Example:");
  });

  it("the group falls through to an action that IS runnable bare", async () => {
    const r = await run(["scout", "--help", "--quiet"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Example:\n {2}llm-ext scout list-fieldsets\n/);
  });
});

describe("errors name the invocation the user typed, not the flat command", () => {
  it("a missing required flag reports 'scout run', never 'mass-scout'", async () => {
    const r = await run(["scout", "run", "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("'scout run' requires --db_path");
    expect(r.stderr).not.toContain("'mass-scout' requires");
  });

  it("an unknown flag points at the grouped --help, not the flat one", async () => {
    const r = await run(["scan", "folder", "./src", "--bogus", "x", "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown flag --bogus for 'scan folder'");
    expect(r.stderr).toContain("Run 'llm-ext scan folder --help'");
  });

  it("the FLAT path still names the flat command, which is what it accepts", async () => {
    const r = await run(["scan-folder", "--bogus", "x", "--quiet"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown flag --bogus for 'scan-folder'");
  });
});

describe("advertised examples clear HANDLER-level validation too", () => {
  // Regression: `llm-ext scan folder ./src` was printed as an Example by both
  // global and group help, passed parseFlags, and then died with "FAILED:
  // instructions or instructions_files_paths is required." — the schema does
  // not mark that pair required, so a schema-only runnability check cannot see
  // it. Asserting on the rendered help (not on the predicate) is what keeps
  // this honest: if a future tool grows a handler-only requirement and is not
  // listed, its Example reappears here and this fails.
  // Stated POSITIVELY, on purpose. The obvious form — "if the Example says
  // `scan folder`, it must carry --instructions" — is VACUOUS: `scan folder`
  // and `llm ask` are exactly the invocations the fix makes unprintable, so
  // the guard never fires and the assertion never runs. It would stay green
  // with exampleIsRunnable deleted, while wearing this bug's name. Asserting
  // the absence fires on every group and fails the moment one leaks back.
  const SUPPRESSED = ["llm ask", "llm code", "scan folder", "scan impl"];

  it("no group advertises an Example whose handler refuses without a non-positional flag", async () => {
    for (const group of ["llm", "scan", "check", "scout", "models", "settings", "session"]) {
      const { stdout } = await run([group, "--help"]);
      const example = stdout.split("\n").find((l) => /^ {2}llm-ext /.test(l));
      if (!example) continue;
      for (const bad of SUPPRESSED) {
        expect(example, `${group} group Example`).not.toContain(`llm-ext ${bad} `);
      }
    }
  });

  it("global help's scan-folder example carries --instructions", async () => {
    const { stdout } = await run(["--help"]);
    const line = stdout.split("\n").find((l) => l.includes("scan folder"));
    expect(line).toBeDefined();
    expect(line).toMatch(/--instructions/);
  });
});
