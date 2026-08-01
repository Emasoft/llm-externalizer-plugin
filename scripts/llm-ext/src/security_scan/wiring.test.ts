/**
 * Wire-up tests — verify `security_scan` is reachable through BOTH surfaces:
 *   • the MCP tool registry + dispatcher (mass_scouting/mcp-tools.ts), and
 *   • the CLI subcommand (mass_scouting/cli.ts → runSecurityScanCli → our
 *     self-contained runSecurityScan, NOT the mass_scout pipeline).
 *
 * These exercise the JSON-encoded argv plumbing (the rich targets[] can't ride
 * flat flags) and the deterministic FetchImpl injection through CliRunOptions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
