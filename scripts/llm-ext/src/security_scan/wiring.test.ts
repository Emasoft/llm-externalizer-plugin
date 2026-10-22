/**
 * Wire-up tests — verify `security_scan` is reachable through BOTH surfaces:
 *   • the MCP tool registry + dispatcher (mass_scouting/mcp-tools.ts), and
 *   • the CLI subcommand (mass_scouting/cli.ts → runSecurityScanCli → our
 *     self-contained runSecurityScan, NOT the mass_scout pipeline).
 *
 * These exercise the JSON-encoded argv plumbing (the rich targets[] can't ride
 * flat flags) and the deterministic FetchImpl injection through CliRunOptions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setValidationBypassForTests } from "../benchmark/validated.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MASS_SCOUT_TOOLS,
  MASS_SCOUT_TOOL_NAMES,
  dispatchMassScoutTool,
} from "../mass_scouting/mcp-tools";
import { runMassScoutCli } from "../mass_scouting/cli";
import type { FetchImpl } from "./judge";
import { DEFAULT_MODEL } from "./types";
import { setActiveFreeOnly, setActiveRouting } from "../config.js";

function okFetch(content: string): FetchImpl {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    }),
    text: async () => content,
  })) as FetchImpl;
}

const NOT_THREAT = JSON.stringify({
  verdict: "not_threat",
  confidence: 0.6,
  reason: "benign",
  injection_observed: false,
});

let tmp: string;
beforeEach(() => {
  setValidationBypassForTests(true); // plumbing test, mocked fetch — gate not under test
  tmp = mkdtempSync(join(tmpdir(), "secscan-wire-"));
});
afterEach(() => {
  setValidationBypassForTests(false);
  rmSync(tmp, { recursive: true, force: true });
});

describe("wiring — MCP tool registry", () => {
  it("security_scan appears in MASS_SCOUT_TOOLS and the name set", () => {
    /** the tool is registered array-driven (no index.ts edit needed). */
    expect(MASS_SCOUT_TOOL_NAMES.has("security_scan")).toBe(true);
    const def = MASS_SCOUT_TOOLS.find((t) => t.name === "security_scan");
    expect(def).toBeDefined();
    expect(def!.inputSchema.required).toContain("targets");
    // The injection-defense intent is documented in the description.
    expect(def!.description.toLowerCase()).toContain("injection");
    expect(def!.description.toLowerCase()).toContain("uncertain");
  });

  it("dispatchMassScoutTool routes security_scan through to a structured result", async () => {
    /** the MCP dispatch JSON-encodes the rich input and returns the counter. */
    const res = await dispatchMassScoutTool(
      "security_scan",
      {
        targets: [{ id: "m1", category: "c", snippet: "createHash('sha1')" }],
        output_dir: tmp,
      },
      { fetchImpl: okFetch(NOT_THREAT), apiKey: "k" },
    );
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toMatch(/items=1/);
    expect(text).toMatch(/json=/);
    expect(text).toMatch(/report=/);
  });

  it("dispatch surfaces a usage error (bad input) as isError", async () => {
    /** an empty targets[] is the one fatal path, and it propagates. */
    const res = await dispatchMassScoutTool(
      "security_scan",
      { targets: [] },
      { fetchImpl: okFetch(NOT_THREAT), apiKey: "k" },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/at least one item/);
  });
});

describe("wiring — CLI subcommand", () => {
  it("runMassScoutCli('security-scan', --input-json ...) runs our module", async () => {
    /** the CLI path parses --input-json and adjudicates via runSecurityScan. */
    const input = JSON.stringify({
      targets: [{ id: "c1", category: "c", snippet: "code" }],
      output_dir: tmp,
    });
    const res = await runMassScoutCli(
      ["security-scan", "--input-json", input],
      { fetchImpl: okFetch(NOT_THREAT), apiKey: "k" },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/items=1/);
    expect(res.stdout).toMatch(/not_threat=1/);
  });

  it("--output-dir flag overrides output_dir embedded in the JSON", async () => {
    /** an explicit flag wins (belt-and-braces with the MCP dispatch). */
    const input = JSON.stringify({
      targets: [{ id: "c1", category: "c", snippet: "code" }],
      output_dir: "/should/be/overridden",
    });
    const res = await runMassScoutCli(
      ["security-scan", "--input-json", input, "--output-dir", tmp],
      { fetchImpl: okFetch(NOT_THREAT), apiKey: "k" },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(tmp);
  });

  it("rejects missing --input-json with a usage error", async () => {
    /** the CLI adapter requires the JSON-encoded input. */
    const res = await runMassScoutCli(["security-scan"], {});
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/input-json/);
  });

  it("rejects malformed --input-json", async () => {
    /** invalid JSON is a clean usage error, not a crash. */
    const res = await runMassScoutCli(
      ["security-scan", "--input-json", "{not json"],
      {},
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/not valid JSON/);
  });

  it("--help lists the security-scan subcommand", async () => {
    /** discoverability: the subcommand shows up in mass-scout help. */
    const res = await runMassScoutCli(["--help"]);
    expect(res.stdout).toContain("security-scan");
    expect(res.stdout.toLowerCase()).toContain("injection-hardened");
  });
});

// captureFetch records each request body so a test can assert WHICH model the
// judge was actually told to use — that's the observable result of per-tool
// model resolution (TRDD-f45eeaa0).
function captureFetch(content: string): { impl: FetchImpl; bodies: string[] } {
  const bodies: string[] = [];
  const impl = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      }),
      text: async () => content,
    };
  }) as FetchImpl;
  return { impl, bodies };
}

// Pick the judge request (the one carrying a `model` + `messages`) out of every
// captured body, so the assertion is robust to any non-judge request.
function sentModel(bodies: string[]): string {
  const judge = bodies
    .map((b) => {
      try {
        return JSON.parse(b) as { model?: unknown; messages?: unknown };
      } catch {
        return null;
      }
    })
    .find(
      (o) => o !== null && typeof o.model === "string" && Array.isArray(o.messages),
    );
  expect(judge).toBeTruthy();
  return (judge as { model: string }).model;
}

describe("wiring — per-tool model resolution (tool_models, TRDD-f45eeaa0)", () => {
  const origCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  const cfgDirs: string[] = [];

  // getConfigDir() only permits a config dir under $HOME or /tmp, so the test
  // settings live in a /tmp dir (realpath /private/tmp on macOS passes the guard).
  function useConfig(yaml: string): void {
    const dir = mkdtempSync(join("/tmp", "secscan-cfg-"));
    writeFileSync(join(dir, "settings.yaml"), yaml, "utf-8");
    cfgDirs.push(dir);
    process.env.LLM_EXT_CONFIG_DIR = dir;
  }
  // An existing dir with no settings.yaml → loadSettings() returns null.
  function useEmptyConfig(): void {
    const dir = mkdtempSync(join("/tmp", "secscan-cfg-"));
    cfgDirs.push(dir);
    process.env.LLM_EXT_CONFIG_DIR = dir;
  }

  const PROFILE_WITH_OVERRIDE =
    "active: t\n" +
    "profiles:\n" +
    "  t:\n" +
    "    mode: remote\n" +
    "    api: openrouter-remote\n" +
    "    model: profile/main-model\n" +
    "    api_key: direct-key\n" +
    "    tool_models:\n" +
    "      security_scan: test/override-model\n";

  const PROFILE_NO_OVERRIDE =
    "active: t\n" +
    "profiles:\n" +
    "  t:\n" +
    "    mode: remote\n" +
    "    api: openrouter-remote\n" +
    "    model: profile/main-model\n" +
    "    api_key: direct-key\n";

  function scanInput(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      targets: [{ id: "c1", category: "c", snippet: "code" }],
      output_dir: tmp,
      ...extra,
    });
  }

  afterEach(() => {
    if (origCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = origCfgDir;
    for (const d of cfgDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("uses tool_models.security_scan when the caller passes no explicit model", async () => {
    useConfig(PROFILE_WITH_OVERRIDE);
    const { impl, bodies } = captureFetch(NOT_THREAT);
    const res = await runMassScoutCli(
      ["security-scan", "--input-json", scanInput()],
      { fetchImpl: impl, apiKey: "k" },
    );
    expect(res.exitCode).toBe(0);
    expect(sentModel(bodies)).toBe("test/override-model");
  });

  it("falls back to DEFAULT_MODEL when the active profile has no tool_models (back-compat)", async () => {
    useConfig(PROFILE_NO_OVERRIDE);
    const { impl, bodies } = captureFetch(NOT_THREAT);
    const res = await runMassScoutCli(
      ["security-scan", "--input-json", scanInput()],
      { fetchImpl: impl, apiKey: "k" },
    );
    expect(res.exitCode).toBe(0);
    expect(sentModel(bodies)).toBe(DEFAULT_MODEL);
  });

  it("falls back to DEFAULT_MODEL when there is no settings file at all", async () => {
    useEmptyConfig();
    const { impl, bodies } = captureFetch(NOT_THREAT);
    const res = await runMassScoutCli(
      ["security-scan", "--input-json", scanInput()],
      { fetchImpl: impl, apiKey: "k" },
    );
    expect(res.exitCode).toBe(0);
    expect(sentModel(bodies)).toBe(DEFAULT_MODEL);
  });

  it("an explicit input model overrides tool_models (highest precedence)", async () => {
    useConfig(PROFILE_WITH_OVERRIDE);
    const { impl, bodies } = captureFetch(NOT_THREAT);
    const res = await runMassScoutCli(
      ["security-scan", "--input-json", scanInput({ model: "explicit/model" })],
      { fetchImpl: impl, apiKey: "k" },
    );
    expect(res.exitCode).toBe(0);
    expect(sentModel(bodies)).toBe("explicit/model");
  });
});

// C4c (review of 21a2d20): runSecurityScanCli used to derive freeOnly from
// `resolveProfile(activeName, active).freeOnly` — the active profile's OWN
// static field — instead of the chokepoint every other cost-safety gate in
// this file reads (getActiveFreeOnly(), row 101 fix-queue). That chokepoint
// is kept in lockstep with BOTH the allow_paid_models master switch and a
// `--profile` override by publishFreeState() on every settings reload
// (index.ts applyNewSettings, called by boot AND overrideActiveProfile) — the
// profile's own `free_only` field alone reflects neither. Red on 21a2d20 (a
// `git archive 21a2d20` scratch copy of cli.ts): with the active profile's
// own free_only:false but the chokepoint forced true (simulating
// allow_paid_models:false), the pre-fix code sent the paid model straight to
// the mocked fetch — this test's `bodies.length` assertion below would have
// been 1, not 0, and no error would have been thrown.
describe("wiring — CLI subcommand: freeOnly comes from getActiveFreeOnly(), not the profile's own field", () => {
  const origCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  const cfgDirs: string[] = [];

  function useConfig(yaml: string): void {
    const dir = mkdtempSync(join("/tmp", "secscan-freeonly-cfg-"));
    writeFileSync(join(dir, "settings.yaml"), yaml, "utf-8");
    cfgDirs.push(dir);
    process.env.LLM_EXT_CONFIG_DIR = dir;
  }

  // The active profile is an ordinary paid one — free_only is absent
  // (defaults false). Only the module-global chokepoint says free.
  const PAID_PROFILE =
    "active: t\n" +
    "profiles:\n" +
    "  t:\n" +
    "    mode: remote\n" +
    "    api: openrouter-remote\n" +
    "    model: profile/main-model\n" +
    "    api_key: direct-key\n";

  afterEach(() => {
    if (origCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = origCfgDir;
    for (const d of cfgDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    // Never leak free-mode state into a sibling test file.
    setActiveFreeOnly(false);
    setActiveRouting((): never[] => [], false);
  });

  it("refuses a non-':free' judge model when the chokepoint is forced free, even though the active profile's own free_only is false", async () => {
    useConfig(PAID_PROFILE);
    // Simulates what boot's publishFreeState() would have published under
    // allow_paid_models:false (or a --profile override) — the ONE thing the
    // fix in cli.ts must consult instead of re-deriving its own answer.
    setActiveFreeOnly(true);
    // getActiveBillableForModel defaults false with no routing configured,
    // which would make the gate a no-op regardless of freeOnly — force
    // billable true so this test actually exercises the gate (mirrors
    // judge.test.ts's own setup for the same gate).
    setActiveRouting((): never[] => [], true);
    const { impl, bodies } = captureFetch(NOT_THREAT);
    const input = JSON.stringify({
      targets: [{ id: "c1", category: "c", snippet: "code" }],
      model: "paid/non-free-model",
      output_dir: tmp,
    });
    await expect(
      runMassScoutCli(["security-scan", "--input-json", input], {
        fetchImpl: impl,
        apiKey: "k",
      }),
    ).rejects.toThrow(/free_only cost-safety/);
    expect(bodies.length).toBe(0); // refused before any request
  });
});

// C4c follow-up (review of this same fix): the master-switch test above
// proves cli.ts trusts getActiveFreeOnly() unconditionally, but only by
// setting that global BY HAND (setActiveFreeOnly(true)) — it never exercises
// the REAL `--profile` flag path (index.ts's overrideActiveProfile), which
// item 1 of this review showed reaches the same chokepoint via
// applyNewSettings -> publishFreeState -> setActiveFreeOnly. This test drives
// that real path end-to-end: the settings.yaml's `active:` profile is an
// ordinary PAID profile, and a SECOND free_only profile is selected only via
// `--profile` (overrideActiveProfile("flag")) — mirroring exactly what
// cli/main.ts does before any dispatch (index.ts:833). If overrideActiveProfile
// ever stopped republishing free state (a regression in index.ts, not in
// cli.ts), this is the test that would catch it — the master-switch test
// above cannot, since it never calls overrideActiveProfile at all.
describe("wiring — CLI subcommand: a real --profile switch to a free_only profile reaches the same gate", () => {
  it("refuses a non-':free' model when --profile selects a free_only profile, even though the settings.yaml active: profile is paid", async () => {
    const dir = mkdtempSync(join("/tmp", "secscan-profileflag-cfg-"));
    writeFileSync(
      join(dir, "settings.yaml"),
      "active: paidmain\n" +
        "profiles:\n" +
        "  paidmain:\n" +
        "    mode: remote\n" +
        "    api: openrouter-remote\n" +
        "    model: profile/main-model\n" +
        "    api_key: direct-key\n" +
        "  freeswitch:\n" +
        "    mode: remote\n" +
        "    api: openrouter-remote\n" +
        "    api_key: direct-key\n" +
        "    free_only: true\n" +
        "    free_models:\n" +
        "      - vendor/model-x:free\n",
      "utf-8",
    );
    const prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
    try {
      // Fresh module graph so index.ts's boot-time activeSettings load (and
      // cli.ts's config.ts singleton) both see THIS settings.yaml — a
      // statically-imported index.ts would have already loaded whatever
      // profile map was active when the test FILE was first imported and
      // would not know "freeswitch" exists (overrideActiveProfile reuses the
      // in-memory profile map from module init, it does not re-read disk).
      vi.resetModules();
      const idx = await import("../index.js");
      const { runMassScoutCli: freshRunMassScoutCli } = await import(
        "../mass_scouting/cli.js"
      );
      // vi.resetModules() gives judge.ts a BRAND NEW validated.js instance,
      // so the file-level beforeEach's setValidationBypassForTests(true) (bound
      // to the PRE-reset instance) no longer reaches it — set the bypass again
      // on the fresh instance, or assertModelValidated's "IRON RULE" gate fires
      // before the free_only gate even runs, masking the assertion under test.
      const { setValidationBypassForTests: freshBypass } = await import(
        "../benchmark/validated.js"
      );
      freshBypass(true);
      // The real `--profile freeswitch` flag path — the ONLY thing
      // cli/main.ts calls before any dispatch (index.ts:833 comment).
      const result = idx.overrideActiveProfile("freeswitch", "flag");
      expect(result.ok).toBe(true);

      const { impl, bodies } = captureFetch(NOT_THREAT);
      const input = JSON.stringify({
        targets: [{ id: "c1", category: "c", snippet: "code" }],
        // Deliberately NOT one of freeswitch's own free_models — a paid
        // model reaching the gate under a --profile-selected free_only
        // profile is exactly the scenario item 1 showed the old code missed.
        model: "paid/non-free-model",
        output_dir: tmp,
      });
      await expect(
        freshRunMassScoutCli(["security-scan", "--input-json", input], {
          fetchImpl: impl,
          apiKey: "k",
        }),
      ).rejects.toThrow(/free_only cost-safety/);
      expect(bodies.length).toBe(0); // refused before any request
    } finally {
      if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
