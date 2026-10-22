/**
 * TRDD-G6XT3AY9 — `active:` reinstated as the default-profile pointer.
 * Precedence: `--profile <name>` flag > `active: <name>` in settings.yaml >
 * the built-in default (DEFAULT_PROFILE_NAME, "free").
 *
 * Replaces src/cli/active-profile-retirement.test.ts (deleted), which pinned
 * the OPPOSITE rule (`active:` inert, always "free" unless --profile given).
 *
 * WHY unit-level, not a compiled-CLI spawn (unlike the file this replaces):
 * this phase (14.1-A code) is explicitly forbidden from running `npm run
 * build` -- dist/ is rebuilt once at the end of the whole release, so a test
 * spawning dist/llm-ext.js here would exercise the OLD pre-fix compiled
 * behaviour regardless of what this file asserts. Every case below drives
 * the SAME functions cli/main.ts calls (config.ts's effectiveProfileName /
 * validateSettings / generateDefaultSettings / renderDefaultSettingsYaml,
 * and index.ts's overrideActiveProfile / getActiveSettings / boot's own
 * validation via __getBootStateForTests) through a REAL settings.yaml under
 * an isolated LLM_EXT_CONFIG_DIR -- not a re-derivation of the precedence
 * logic in the test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROFILE_NAME,
  effectiveProfileName,
  validateSettings,
  generateDefaultSettings,
  renderDefaultSettingsYaml,
  formatActiveProfileSummary,
  loadSettings,
  shouldFailProfileSelection,
} from "../config.js";
import { stampProfileMigrationDone } from "../default-profiles-state.js";
import { resolveInvocation, type ToolDef } from "./launcher.js";
import { buildTools } from "../tools/definitions.js";

let cfgDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  // Same stub as boot-reload-validity.test.ts / default-profile-wiring.test.ts:
  // boot resolves an OpenRouter model-info cache eagerly on some paths;
  // unstubbed, the first real fetch eats several seconds nothing here needs.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
  cfgDir = undefined;
  vi.unstubAllGlobals();
});

/** Same construction as boot-reload-validity.test.ts's loadFreshIndex:
 *  config.ts's getConfigDir() only allows paths under $HOME or /private/tmp,
 *  so mkdtempSync under "/tmp" (resolves to /private/tmp on macOS), never
 *  os.tmpdir() -- and vi.resetModules() is load-bearing: without it,
 *  `import("../index.js")` returns the SAME cached module every test (ESM
 *  module caching), so a "fresh" boot after the first test would silently
 *  reuse the FIRST test's activeSettings instead of re-running the boot IIFE
 *  against the new config dir. Pre-stamps the one-time profile migration so
 *  a hand-authored static-only fixture is never treated as "needs migrating".
 */
async function loadFreshIndex(settingsYaml: string) {
  cfgDir = mkdtempSync(join("/tmp", "llm-ext-active-precedence-"));
  writeFileSync(join(cfgDir, "settings.yaml"), settingsYaml, "utf-8");
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  stampProfileMigrationDone(Date.now());
  vi.resetModules();
  return import("../index.js");
}

const STATIC_PROFILE_A = [
  "  prof-a:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-a",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "",
].join("\n");

describe("active: precedence -- --profile flag > active: > built-in default (TRDD-G6XT3AY9)", () => {
  it("case 1: no flag, active: <static name> => that profile is selected", async () => {
    const idx = await loadFreshIndex(["active: prof-a", "profiles:", STATIC_PROFILE_A].join("\n"));
    // This is exactly what cli/main.ts computes when profileOverride is
    // undefined: `profileOverride ?? effectiveProfileName(getActiveSettings())`.
    const profileOverride: string | undefined = undefined;
    const effective = profileOverride ?? effectiveProfileName(idx.getActiveSettings());
    expect(effective).toBe("prof-a");
    const result = idx.overrideActiveProfile(effective, "default");
    expect(result.ok).toBe(true);
    // Display paths (settings show/status) read this back too -- must agree.
    expect(idx.getActiveSettings().active).toBe("prof-a");
  });

  it("case 2: --profile free wins over active: <static>", async () => {
    const idx = await loadFreshIndex(["active: prof-a", "profiles:", STATIC_PROFILE_A].join("\n"));
    const profileOverride: string | undefined = "free";
    const effective = profileOverride ?? effectiveProfileName(idx.getActiveSettings());
    expect(effective).toBe("free");
    // "free" is a dynamic name absent from this fixture -- overrideActiveProfile
    // self-heals it (same first-run mechanism the old test suite pinned).
    const result = idx.overrideActiveProfile(effective, "flag");
    expect(result.ok).toBe(true);
    expect(idx.getActiveSettings().active).toBe("free");
  });

  it("case 3: no flag, no active: key => the built-in default (free)", async () => {
    const idx = await loadFreshIndex(["profiles:", STATIC_PROFILE_A].join("\n"));
    const profileOverride: string | undefined = undefined;
    const effective = profileOverride ?? effectiveProfileName(idx.getActiveSettings());
    expect(effective).toBe(DEFAULT_PROFILE_NAME);
    expect(effective).toBe("free");
  });

  // AMENDMENT (2026-09-17 ~21:30, TRDD-G6XT3AY9): the dangling-`active:` error
  // moved OFF validateSettings and onto the CLI selection call site
  // (cli/main.ts -> overrideActiveProfile -> shouldFailProfileSelection). It
  // fires only when the raw `active:` value is what actually gets SELECTED
  // (no --profile). Cases 4/4a/4b drive the REAL exported gate
  // (shouldFailProfileSelection/CLI_TOOLS_WITHOUT_RESOLVED_PROFILE) main.ts
  // calls, not a re-derivation of it in the test -- main.ts itself cannot be
  // imported (it runs `main().catch()` at import time), so config.ts is where
  // this decision had to move to become testable at all.

  it("case 4: active: nosuch, no flag => the error names 'active' and 'nosuch', and the gate fails the invocation", async () => {
    const idx = await loadFreshIndex(
      ["active: nosuch", "profiles:", STATIC_PROFILE_A].join("\n"),
    );
    // validateSettings no longer owns this check (amendment) -- it still marks
    // the settings unresolved (generic "not found", no 'active:' wording) so
    // boot skips resolveProfile() instead of crashing on an undefined profile.
    const verdict = validateSettings(idx.getActiveSettings());
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join("\n")).not.toMatch(/active:/);
    // The SELECTION-time call cli/main.ts makes when no --profile is given:
    const profileOverride: string | undefined = undefined;
    const effective = profileOverride ?? effectiveProfileName(idx.getActiveSettings());
    const result = idx.overrideActiveProfile(effective, "default");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/active/);
      expect(result.error).toMatch(/nosuch/);
    }
    // "llm ask" (a tool that needs a resolved backend) is NOT in
    // CLI_TOOLS_WITHOUT_RESOLVED_PROFILE => the invocation must fail.
    expect(shouldFailProfileSelection(result.ok, "llm", profileOverride !== undefined)).toBe(true);
  });

  it("case 4a: active: nosuch, --profile free => runs (the flag bypasses the dangling key entirely)", async () => {
    const idx = await loadFreshIndex(
      ["active: nosuch", "profiles:", STATIC_PROFILE_A].join("\n"),
    );
    // effectiveProfileName is never even called: `??` short-circuits on a
    // defined profileOverride, so the dangling `active:` cannot reach here.
    const profileOverride: string | undefined = "free";
    const result = idx.overrideActiveProfile(profileOverride, "flag");
    expect(result.ok).toBe(true);
    expect(idx.getActiveSettings().active).toBe("free");
    expect(shouldFailProfileSelection(result.ok, "llm", profileOverride !== undefined)).toBe(false);
  });

  it("case 4b: active: nosuch, no flag, an info tool (settings show/status/profiles) => still runs and prints the key", async () => {
    const idx = await loadFreshIndex(
      ["active: nosuch", "profiles:", STATIC_PROFILE_A].join("\n"),
    );
    const profileOverride: string | undefined = undefined;
    const effective = profileOverride ?? effectiveProfileName(idx.getActiveSettings());
    const result = idx.overrideActiveProfile(effective, "default");
    expect(result.ok).toBe(false); // selection still fails...
    // ...but the real gate does NOT fail the invocation for get_settings
    // ("settings show") or discover ("settings status"):
    expect(shouldFailProfileSelection(result.ok, "get_settings", profileOverride !== undefined)).toBe(false);
    expect(shouldFailProfileSelection(result.ok, "discover", profileOverride !== undefined)).toBe(false);
    // and the tool itself (get_settings calls exactly this) runs and shows
    // the broken key value instead of throwing.
    const summary = formatActiveProfileSummary(
      effectiveProfileName(idx.getActiveSettings()),
      idx.getProfileSelectionSource(),
    );
    expect(summary).toMatch(/nosuch/);
  });

  it("case 4c: active: \"\" (empty string) => missing => free", async () => {
    const idx = await loadFreshIndex(["active: \"\"", "profiles:", STATIC_PROFILE_A].join("\n"));
    expect(idx.getActiveSettings().active).toBeUndefined();
    expect(effectiveProfileName(idx.getActiveSettings())).toBe(DEFAULT_PROFILE_NAME);
  });

  it("case 4d: active: (YAML null) => missing => free", async () => {
    const idx = await loadFreshIndex(["active:", "profiles:", STATIC_PROFILE_A].join("\n"));
    expect(idx.getActiveSettings().active).toBeUndefined();
    expect(effectiveProfileName(idx.getActiveSettings())).toBe(DEFAULT_PROFILE_NAME);
    // loadSettings() itself (not just the boot-time wrapper) coerces the
    // YAML-null case the same way -- both "" and null mean "no active key".
    const reparsed = loadSettings();
    expect(reparsed?.active).toBeUndefined();
  });

  it("case 5: a fresh generated settings.yaml has exactly one line matching /^active: free$/", () => {
    const yaml = renderDefaultSettingsYaml();
    const matches = yaml.split("\n").filter((line) => /^active: free$/.test(line));
    expect(matches.length).toBe(1);
    expect(generateDefaultSettings().active).toBe("free");
  });
});

// TRDD-OE27RD7I 14.1-C2 §3b: the lazy-resolution rewrite kept
// CLI_TOOLS_WITHOUT_RESOLVED_PROFILE/shouldFailProfileSelection instead of
// deleting them (this file's own unit-level use of shouldFailProfileSelection
// is exactly why -- deleting it would mean rewriting this file too, outside
// the phase's file set). These cases are the fallback the spec calls for when
// the set survives: a truth table on the gate, an end-to-end dispatch through
// a dangling `active:`, and null-resolved-profile tolerance for the four
// exempt info handlers.
describe("TRDD-OE27RD7I 14.1-C2 §3b — shouldFailProfileSelection truth table + info-tool tolerance", () => {
  it("four-row table: (selectionOk, exempt-tool-or-not, hadProfileFlag)", () => {
    // ok=true -> never fails, regardless of tool or flag.
    expect(shouldFailProfileSelection(true, "profile", false)).toBe(false);
    // ok=false, exempt tool ("profile"), no --profile flag -> tolerated
    // (the whole point of the allow-list: let the user SEE the broken key).
    expect(shouldFailProfileSelection(false, "profile", false)).toBe(false);
    // ok=false, exempt tool, but an EXPLICIT --profile typo -> still fails
    // (the user just typed it; silently ignoring it would run the wrong
    // profile).
    expect(shouldFailProfileSelection(false, "profile", true)).toBe(true);
    // ok=false, a NON-exempt tool ("llm", needs a resolved backend), no flag
    // -> fails (this is the interim regression 3b's escape hatch exists to
    // avoid widening: a completion tool must not silently dispatch with no
    // resolved profile).
    expect(shouldFailProfileSelection(false, "llm", false)).toBe(true);
  });

  it("end-to-end: dispatchCallTool('discover'/'get_settings'/'list_profiles'/'profile') on a dangling active: never throws, with activeResolved genuinely null", async () => {
    const idx = await loadFreshIndex(["active: nosuch", "profiles:", STATIC_PROFILE_A].join("\n"));
    // Confirms the scenario actually produces the null-resolved-profile
    // state the four info handlers must tolerate -- not just a dangling
    // `active:` string that happened to resolve anyway.
    expect(idx.__getBootStateForTests().activeResolved).toBe(false);
    await idx.boot();
    for (const tool of ["discover", "get_settings", "list_profiles", "profile"] as const) {
      await expect(idx.dispatchCallTool(tool, {})).resolves.toBeDefined();
    }
  });

  it("end-to-end: `settings status` (the grouped launcher's actual user-facing name) resolves to 'discover' and tolerates a dangling active:", async () => {
    // 14.1-C2a-FOLLOWUP item 5: the §3b escape hatch's own text called the
    // status->discover mapping "a comment today" -- checked here and found
    // to no longer be true: launcher.ts's GROUPS table (TRDD-DT11TE2Z, landed
    // since §3b was written) is REAL, wired code
    // (`settings: { status: { command: "discover" }, ... } }`), not a
    // comment. What was still untested is that this table's OWN dispatch
    // target ("discover") is the SAME tool the test above already proved
    // tolerates a dangling active: -- i.e. that the two facts compose into
    // one true end-to-end path, rather than each half being checked in
    // isolation. resolveInvocation is used directly (not a `main()`/dist
    // spawn) for the same reason this whole file is unit-level, not a
    // compiled-CLI spawn -- see the file header.
    const resolved = resolveInvocation(["settings", "status"], buildTools("") as ToolDef[]);
    expect(resolved.kind, "the grouped launcher must actually dispatch, not error/help").toBe(
      "dispatch",
    );
    expect(resolved.kind === "dispatch" && resolved.command).toBe("discover");

    const idx = await loadFreshIndex(["active: nosuch", "profiles:", STATIC_PROFILE_A].join("\n"));
    expect(idx.__getBootStateForTests().activeResolved).toBe(false);
    await idx.boot();
    await expect(idx.dispatchCallTool("discover", {})).resolves.toBeDefined();
  });
});
