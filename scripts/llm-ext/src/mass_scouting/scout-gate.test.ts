/**
 * The mass-scout scouting-profile REQUIRE gate (TRDD-FKAR9VPK D5, A3 tree).
 *
 * Red-proofs live here: (a) the gate refuses when no scouting profile exists;
 * (b) --allow-untested-model refuses when the structural schema probe fails;
 * plus the full A3 decision tree, and the register/estimate-still-work pin.
 *
 * All fixture-fed and hermetic (A9a/A9d): the scouting profile is written BY
 * HAND as YAML into a per-test LLM_EXT_CONFIG_DIR — no benchmark invocation,
 * no live spend, no module mocking. LLM-driving paths get the candidate
 * responses through the runScoutJob fetch seam.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setValidationBypassForTests } from "../benchmark/validated.js";
import { DEFAULT_SCOUT_ACCURACY_THRESHOLD, DEFAULT_SCOUT_ACCURACY_TARGET_BYTES, PLACEHOLDER_MODEL_ID } from "../config.js";
import {
  recordScoutAccuracy,
  scoutAccuracyHash,
} from "./scout-accuracy-ledger.js";
import { generateFixture, MIN_FIXTURE_BYTES } from "./scout-accuracy-fixture.js";
import { runMassScoutCli, type CliRunOptions } from "./cli";
import type { FetchImpl } from "./scout";

let cfgDir: string;
let workdir: string;
let sourceRoot: string;
let dbPath: string;
let fieldsetPath: string;
let mainRoot: string;
let prevCfgDir: string | undefined;

const HEAD_MODEL = "test/scout-head";

function writeScoutingProfile(modelId: string): void {
  writeFileSync(
    join(cfgDir, "settings.yaml"),
    [
      "allow_paid_models: true",
      "profiles:",
      "  scouting:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    url: https://openrouter.ai/api",
      '    api_key: "$OPENROUTER_API_KEY"',
      `    model: ${modelId}`,
      `    paid_models: [${modelId}]`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function recordPass(modelId: string): void {
  recordScoutAccuracy(
    modelId,
    scoutAccuracyHash(DEFAULT_SCOUT_ACCURACY_THRESHOLD, DEFAULT_SCOUT_ACCURACY_TARGET_BYTES),
    { pass: true, inconclusive: false, accuracy: 0.99 },
  );
}

/** Fetch stub returning a valid extraction for every file (positional gate
 *  probes and scout runs both succeed). */
function goodFetch(): FetchImpl {
  return async (_url, init) => {
    // Count the fixture records the request carries, so a probe gets a
    // correctly-sized positional array back.
    const body = JSON.parse(init.body) as { messages?: { content?: string }[] };
    const user = body.messages?.[1]?.content ?? "";
    const count = (user.match(/^name: skill-/gm) ?? []).length;
    const payload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              categories: Array.from({ length: Math.max(count, 1) }, () => "debugging"),
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

/** Fetch stub whose model output is NOT parseable positional JSON — the
 *  structural schema probe must refuse it (red-proof b). */
function garbageOutputFetch(): FetchImpl {
  return async () => {
    const payload = {
      choices: [{ message: { content: "not json at all" } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

function writeTree(): void {
  writeFileSync(join(sourceRoot, "a.ts"), "export const a = 1\n", "utf-8");
  writeFileSync(join(sourceRoot, "b.ts"), "export const b = 2\n", "utf-8");
  writeFileSync(
    fieldsetPath,
    JSON.stringify({
      version: 1,
      fieldset_name: "gate-test",
      fields: [
        { name: "is_async", description: "true if file uses async/await", type: { kind: "bool" } },
      ],
    }),
    "utf-8",
  );
}

beforeEach(() => {
  setValidationBypassForTests(true);
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  cfgDir = mkdtempSync("/tmp/scout-gate-cfg-");
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  workdir = mkdtempSync("/tmp/scout-gate-work-");
  writeFileSync(join(cfgDir, "settings.yaml"), "allow_paid_models: true\n", "utf-8");
  sourceRoot = join(workdir, "tree");
  mkdirSync(sourceRoot, { recursive: true });
  dbPath = join(workdir, "scout.db");
  fieldsetPath = join(workdir, "fields.json");
  mainRoot = workdir;
});

afterEach(() => {
  setValidationBypassForTests(false);
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

describe("mass-scout scouting-profile require gate (D5)", () => {
  it("RED-PROOF (a): scout refuses when no scouting profile exists", async () => {
    writeTree();
    const r = await runMassScoutCli(
      ["scout", "--db", dbPath, "--fields-file", fieldsetPath, "--job-id", "j1", "--source-root", sourceRoot],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/no scouting profile — the USER must run: llm-ext benchmark scout-accuracy/);
    expect(r.stderr).toMatch(/Do not run the benchmark yourself/);
  });

  it("RED-PROOF (b): --allow-untested-model refuses when the structural schema probe fails", async () => {
    writeTree();
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "j1",
        "--source-root",
        sourceRoot,
        "--model",
        "test/untested-model",
        "--allow-untested-model",
      ],
      { apiKey: "test-key", mainRoot, fetchImpl: garbageOutputFetch() },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/structural schema probe/);
  });

  it("A3: no profile + --model + no flag -> refusal 2 names the USER (fix-round F2 pin)", async () => {
    writeTree();
    const r = await runMassScoutCli(
      ["scout", "--db", dbPath, "--fields-file", fieldsetPath, "--job-id", "j1", "--source-root", sourceRoot, "--model", "test/untested-model"],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(1);
    // Partial pin (sibling-consistent). The covers:-absence owns the branch:
    // the final refusal (profile exists, model unpassed) shares this tail.
    expect(r.stderr).toMatch(/the USER must run llm-ext benchmark scout-accuracy/);
    expect(r.stderr).not.toMatch(/covers:/);
  });

  it("A3: profile exists + head ledger-PASSED -> scout proceeds on the head", async () => {
    writeTree();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    writeScoutingProfile(HEAD_MODEL);
    recordPass(HEAD_MODEL);
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "gate-job",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
        "--input-price-per-m",
        "0.0001",
        "--output-price-per-m",
        "0.0002",
        "--context-window",
        "200000",
      ],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/files_ok=2/);
  });

  it("A3: profile exists + head NOT ledger-PASSED -> refuse re-run scout-accuracy", async () => {
    writeTree();
    writeScoutingProfile(HEAD_MODEL); // no ledger pass recorded
    const r = await runMassScoutCli(
      ["scout", "--db", dbPath, "--fields-file", fieldsetPath, "--job-id", "j1", "--source-root", sourceRoot],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/the USER must re-run scout-accuracy/);
  });

  it("A3: --model ledger-PASSED under CURRENT hash -> admitted", async () => {
    writeTree();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    writeScoutingProfile(HEAD_MODEL);
    recordPass("test/passed-model");
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "gate-job",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
        "--input-price-per-m",
        "0.0001",
        "--output-price-per-m",
        "0.0002",
        "--context-window",
        "200000",
        "--model",
        "test/passed-model",
      ],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/files_ok=2/);
  });

  it("A3: --model NOT passed, no flag -> refuse with benchmark coverage message", async () => {
    writeTree();
    writeScoutingProfile(HEAD_MODEL);
    recordPass(HEAD_MODEL); // the named model is NOT the passed one
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "j1",
        "--source-root",
        sourceRoot,
        "--model",
        "test/other-model",
      ],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/scout-accuracy-verified|not scout-accuracy/);
    // Positive pin on the covers: clause (round-4 F1): the refusal-2 pin's
    // covers:-absence branch ownership is vacuous unless the clause exists
    // where it lives — this is that positive side.
    expect(r.stderr).toMatch(/covers:/);
  });

  it("A3: --model NOT passed, WITH flag + probe pass -> admitted and stamped UNTESTED", async () => {
    writeTree();
    writeScoutingProfile(HEAD_MODEL);
    recordPass(HEAD_MODEL);
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "gate-job",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
        "--input-price-per-m",
        "0.0001",
        "--output-price-per-m",
        "0.0002",
        "--context-window",
        "200000",
        "--model",
        "test/probe-model",
        "--allow-untested-model",
      ],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/UNTESTED MODEL \(--allow-untested-model\)/);
  });

  it("A4: the probe row is inconclusive — it never authorizes a later invocation", async () => {
    writeTree();
    writeScoutingProfile(HEAD_MODEL);
    recordPass(HEAD_MODEL);
    // First invocation: probe succeeds, model admitted per-invocation.
    const r1 = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "probe-job",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
        "--input-price-per-m",
        "0.0001",
        "--output-price-per-m",
        "0.0002",
        "--context-window",
        "200000",
        "--model",
        "test/probe-once",
        "--allow-untested-model",
      ],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r1.exitCode).toBe(0);
    // Second invocation WITHOUT the flag: the probe row must not authorize.
    const r2 = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "probe-job-2",
        "--source-root",
        sourceRoot,
        "--model",
        "test/probe-once",
      ],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toMatch(/scout-accuracy/);
  });

  it("chain is gated by the same tree (no scouting profile -> refuse)", async () => {
    writeTree();
    writeFileSync(
      fieldsetPath,
      JSON.stringify({
        version: 1,
        fieldset_name: "gate-test",
        fields: [
          { name: "is_async", description: "true if file uses async/await", type: { kind: "bool" } },
        ],
      }),
      "utf-8",
    );
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() };
    // Seed a source job — wait, scout is gated too, so seed via a scouting profile + passed head.
    writeScoutingProfile(HEAD_MODEL);
    recordPass(HEAD_MODEL);
    const r1 = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "src-job",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
        "--input-price-per-m",
        "0.0001",
        "--output-price-per-m",
        "0.0002",
        "--context-window",
        "200000",
      ],
      opts,
    );
    expect(r1.exitCode).toBe(0);
    // Now remove the profile: chain must refuse.
    rmSync(join(cfgDir, "settings.yaml"), { force: true });
    const r2 = await runMassScoutCli(
      [
        "chain",
        "--db",
        dbPath,
        "--source-job",
        "src-job",
        "--new-job-id",
        "chained",
        "--new-fields-file",
        fieldsetPath,
        "--filter",
        "$.is_async:=:false",
      ],
      opts,
    );
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toMatch(/no scouting profile/);
  });

  it("propose-fieldset is gated by the same tree (no scouting profile -> refuse)", async () => {
    const r = await runMassScoutCli(["propose-fieldset", "--goal", "find async modules"], {
      apiKey: "test-key",
      fetchImpl: goodFetch(),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/no scouting profile/);
  });

  it("PIN: register still works WITHOUT a scouting profile", async () => {
    writeTree();
    const r = await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/registered=2/);
  });

  it("PIN: estimate still works WITHOUT a scouting profile", async () => {
    writeTree();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli(
      ["estimate", "--db", dbPath, "--fields-file", fieldsetPath],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/model=/);
  });
});

// PT-05 (TRDD-RPEKSYJL, D34): the model of every mass-scouting action comes from a
// scouting-type profile, whatever the active profile is.
const FREE_PROFILE_YAML = [
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    model: some/free-model:free",
  "    free_models: [some/free-model:free]",
];

function scoutingYaml(name: string, modelId: string): string[] {
  return [
    `  ${name}:`,
    "    profile-type: scouting",
    "    mode: remote",
    "    api: openrouter-remote",
    "    url: https://openrouter.ai/api",
    '    api_key: "$OPENROUTER_API_KEY"',
    `    model: ${modelId}`,
  ];
}

function writeSettings(lines: string[]): void {
  // allow_paid_models: scouting bills; without it the gate refuses early (PT-05 review round).
  writeFileSync(join(cfgDir, "settings.yaml"), ["allow_paid_models: true", ...lines, ""].join("\n"), "utf-8");
}

/** goodFetch that also records the model id of every request. */
function recordingFetch(seen: string[]): FetchImpl {
  const inner = goodFetch();
  return async (url, init) => {
    seen.push((JSON.parse(init.body) as { model?: string }).model ?? "");
    return inner(url, init);
  };
}

function scoutArgv(extra: string[] = []): string[] {
  return [
    "scout", "--db", dbPath, "--fields-file", fieldsetPath, "--job-id", "pt05-job",
    "--source-root", sourceRoot, "--workers", "1", "--no-smoke-test",
    "--input-price-per-m", "0.0001", "--output-price-per-m", "0.0002", "--context-window", "200000",
    ...extra,
  ];
}

describe("PT-05: mass scouting accepts only the scouting type (D34)", () => {
  it("E81b: free profile active + placeholder scouting -> scout refuses with the benchmark hint", async () => {
    writeTree();
    writeSettings(["active: free", "profiles:", ...FREE_PROFILE_YAML, ...scoutingYaml("scouting", PLACEHOLDER_MODEL_ID)]);
    const r = await runMassScoutCli(scoutArgv(), { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/llm-ext benchmark scout-accuracy/);
  });

  it("free profile active + populated scouting -> scout runs on the scouting model, never the free pool", async () => {
    writeTree();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    writeSettings(["active: free", "profiles:", ...FREE_PROFILE_YAML, ...scoutingYaml("scouting", HEAD_MODEL)]);
    recordPass(HEAD_MODEL);
    const seen: string[] = [];
    const r = await runMassScoutCli(scoutArgv(), { apiKey: "test-key", mainRoot, fetchImpl: recordingFetch(seen) });
    expect(r.exitCode).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([HEAD_MODEL]));
  });

  it("--profile naming another scouting-type profile selects that profile's model", async () => {
    writeTree();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    writeSettings(["active: free", "profiles:", ...FREE_PROFILE_YAML, ...scoutingYaml("scouting", HEAD_MODEL), ...scoutingYaml("scouting-b", "test/scout-b")]);
    recordPass("test/scout-b");
    const seen: string[] = [];
    const r = await runMassScoutCli(scoutArgv(["--profile", "scouting-b"]), { apiKey: "test-key", mainRoot, fetchImpl: recordingFetch(seen) });
    expect(r.exitCode).toBe(0);
    expect(new Set(seen)).toEqual(new Set(["test/scout-b"]));
  });

  it("--profile naming a profile of another type is refused before any request", async () => {
    writeTree();
    writeSettings(["active: free", "profiles:", ...FREE_PROFILE_YAML, ...scoutingYaml("scouting", HEAD_MODEL)]);
    const seen: string[] = [];
    const r = await runMassScoutCli(scoutArgv(["--profile", "free"]), { apiKey: "test-key", mainRoot, fetchImpl: recordingFetch(seen) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not a scouting profile/);
    expect(seen).toEqual([]);
  });

  it("estimate under a free active profile prices the scouting model, not the free pool head", async () => {
    writeTree();
    writeSettings(["active: free", "profiles:", ...FREE_PROFILE_YAML, ...scoutingYaml("scouting", HEAD_MODEL)]);
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli(
      ["estimate", "--db", dbPath, "--fields-file", fieldsetPath, "--input-price-per-m", "0.0001", "--output-price-per-m", "0.0002", "--context-window", "200000"],
      { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`model=${HEAD_MODEL}`);
  });
});

describe("PT-05 review round: spend safety of the scouting send", () => {
  const PAID_OFF_TEXT = `mass scouting bills on the scouting profile's model '${HEAD_MODEL}'; allow_paid_models is off; turn it on in settings.yaml to run it.`;

  function writeSettingsRaw(lines: string[]): void {
    writeFileSync(join(cfgDir, "settings.yaml"), [...lines, ""].join("\n"), "utf-8");
  }

  it("allow_paid_models: false + populated paid scouting profile + ledger PASS -> refused early, nothing sent, no registry opened", async () => {
    writeTree();
    writeSettingsRaw(["allow_paid_models: false", "profiles:", ...scoutingYaml("scouting", HEAD_MODEL)]);
    recordPass(HEAD_MODEL);
    const seen: string[] = [];
    const r = await runMassScoutCli(scoutArgv(), { apiKey: "test-key", mainRoot, fetchImpl: recordingFetch(seen) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(PAID_OFF_TEXT);
    expect(r.stderr).not.toMatch(/:free/);
    expect(seen).toEqual([]);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("settings.yaml absent + --model -> refused (fail closed: unreadable settings never mean paid allowed)", async () => {
    writeTree();
    rmSync(join(cfgDir, "settings.yaml"));
    const seen: string[] = [];
    const r = await runMassScoutCli(scoutArgv(["--model", HEAD_MODEL]), { apiKey: "test-key", mainRoot, fetchImpl: recordingFetch(seen) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(PAID_OFF_TEXT);
    expect(seen).toEqual([]);
  });

  it("allow_paid_models: true + free active profile -> one stderr line names the scouting profile and model as billed", async () => {
    writeTree();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    writeSettings(["active: free", "profiles:", ...FREE_PROFILE_YAML, ...scoutingYaml("scouting", HEAD_MODEL)]);
    recordPass(HEAD_MODEL);
    const spy = vi.spyOn(process.stderr, "write");
    try {
      const r = await runMassScoutCli(scoutArgv(), { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() });
      expect(r.exitCode).toBe(0);
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("BILLED"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("'scouting'");
      expect(lines[0]).toContain(`'${HEAD_MODEL}'`);
    } finally {
      spy.mockRestore();
    }
  });

  it("allow_paid_models: true + paid active profile -> no billed notice", async () => {
    writeTree();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    writeSettings(["active: paid", "profiles:", "  paid:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    model: some/paid-model", ...scoutingYaml("scouting", HEAD_MODEL)]);
    recordPass(HEAD_MODEL);
    const spy = vi.spyOn(process.stderr, "write");
    try {
      const r = await runMassScoutCli(scoutArgv(), { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() });
      expect(r.exitCode).toBe(0);
      expect(spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("BILLED"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("--profile naming a profile that does not exist -> error naming it and the available scouting profiles", async () => {
    writeTree();
    writeSettings(["active: free", "profiles:", ...FREE_PROFILE_YAML, ...scoutingYaml("scouting", HEAD_MODEL), ...scoutingYaml("scouting-b", "test/scout-b")]);
    const r = await runMassScoutCli(scoutArgv(["--profile", "nope"]), { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("'nope' does not exist");
    expect(r.stderr).toContain("scouting, scouting-b");
    expect(r.stderr).not.toMatch(/benchmark scout-accuracy/);
  });

  it("estimate with the placeholder scouting profile says its price is a stand-in", async () => {
    writeTree();
    writeSettings(["profiles:", ...scoutingYaml("scouting", PLACEHOLDER_MODEL_ID)]);
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli(["estimate", "--db", dbPath, "--fields-file", fieldsetPath], { apiKey: "test-key", mainRoot, fetchImpl: goodFetch() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no scouting profile yet; priced with ");
    expect(r.stdout).toContain("the real run uses the model `benchmark scout-accuracy` selects");
  });
});

// Keep the fixture import referenced in one assertion so the module graph of
// this test file stays honest about what it exercises.
describe("gate test fixtures", () => {
  it("minimum fixture clears MIN_FIXTURE_BYTES with >= 40 records", () => {
    const f = generateFixture(1, MIN_FIXTURE_BYTES);
    expect(f.recordCount).toBeGreaterThanOrEqual(40);
    expect(f.body.length).toBeGreaterThanOrEqual(MIN_FIXTURE_BYTES);
  });
});
