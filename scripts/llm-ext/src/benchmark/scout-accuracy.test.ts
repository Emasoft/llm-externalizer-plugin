/**
 * Scout-accuracy benchmark ACTION tests (TRDD-FKAR9VPK D2, amendment A9a).
 *
 * ALL fixture-fed through the injected seams — opts.catalogFetch (the catalog
 * provider) and opts.fetchImpl (the HTTP send). No module mocking, no live
 * OpenRouter, ever (A9d: the scouting profile written BY the action here is
 * the real writer on a throwaway LLM_EXT_CONFIG_DIR).
 *
 * Red-proof (c) lives here: a ':free' id NEVER enters the scouting profile —
 * buildScoutingProfile throws on one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "../test-tmp-root.js";
import { join } from "node:path";

import {
  buildScoutingProfile,
  runScoutAccuracyBenchmark,
  type ScoutAccuracyOptions,
} from "./scout-accuracy.js";
import { passedModelIds, scoutAccuracyHash } from "../mass_scouting/scout-accuracy-ledger.js";
import {
  DEFAULT_SCOUT_ACCURACY_TARGET_BYTES,
  DEFAULT_SCOUT_ACCURACY_THRESHOLD,
} from "../config.js";
import { setPaidBenchmarksAllowed } from "./discover.js";
import { setAllowPaidModels } from "../paid-switch.js";
import { SCOUT_CATEGORIES } from "../mass_scouting/scout-accuracy-fixture.js";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

let cfgDir: string;
let prevCfgDir: string | undefined;

import { mkdirSync } from "node:fs";
import { loadCache, saveCache } from "../mass_scouting/scout-accuracy-ledger.js";
import { runMassScoutCli } from "../mass_scouting/cli.js";
import type { FetchImpl } from "../mass_scouting/scout.js";
import { setValidationBypassForTests } from "./validated.js";

function rawCatalog(): unknown[] {
  const mk = (id: string, input: number, output: number, ctx: number) => ({
    id,
    name: id,
    context_length: ctx,
    top_provider: { max_completion_tokens: 8_192 },
    supported_parameters: ["response_format", "temperature"],
    pricing: {
      prompt: String(input / 1_000_000),
      completion: String(output / 1_000_000),
    },
  });
  return [
    mk("cheap/good", 0.01, 0.01, 131_072),
    mk("cheap/bad", 0.02, 0.02, 131_072),
    mk("tiny/ctx", 0.005, 0.005, 1_024), // context too small for the fixture (A1/A2 skip)
    mk("expensive/good", 0.04, 0.04, 131_072),
  ];
}

/** Fetch stub: the model answers the fixture's ground truth EXACTLY for
 *  `goodIds`, and swaps two categories for `badIds`. */
function fixtureFetch(goodIds: ReadonlySet<string>): NonNullable<ScoutAccuracyOptions["fetchImpl"]> {
  return async (_url, init) => {
    const body = JSON.parse(init.body) as { model?: string; messages?: { content?: string }[] };
    const modelId = body.model ?? "";
    const user = body.messages?.[1]?.content ?? "";
    // The ground truth is deterministic from the record index:
    // expected[i] === SCOUT_CATEGORIES[i % SCOUT_CATEGORIES.length]. Parse the
    // record indices the request actually carries and rebuild the truth from
    // them, so the stub answers ANY fixture size correctly.
    const indices = [...user.matchAll(/^name: skill-(\d{6})$/gm)].map((m) => Number(m[1]));
    const expected = indices.map((i) => SCOUT_CATEGORIES[i % SCOUT_CATEGORIES.length]!);
    const predicted = expected.map((c, i) => {
      if (goodIds.has(modelId)) return c;
      // Deterministically wrong for half the records — clearly below 95%.
      return i % 2 === 0 ? SCOUT_CATEGORIES[(i + 1) % SCOUT_CATEGORIES.length]! : c;
    });
    const payload = {
      choices: [
        {
          message: {
            content: JSON.stringify({ categories: predicted }),
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 200 },
    };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

function baseOpts(): ScoutAccuracyOptions {
  return {
    apiKey: "test-key",
    catalogFetch: async () => rawCatalog() as never,
    fetchImpl: fixtureFetch(new Set(["cheap/good", "expensive/good"])),
    outputDir: join(cfgDir, "reports-out"),
  };
}


/** Mirror of the ledger reader's cutoff math (30d), inline — these tests pin
 *  the AUTHORIZATION BEHAVIOR, not the reader's private helper. */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Fetch stub for the mass-scout CLI leg: a correctly-sized positional
 *  payload for gate probes and parseable extractions for the job run. */
function goodCliFetch(): FetchImpl {
  return async (_url, init) => {
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

/** Hermetic workdir for the mass-scout CLI leg, under this file's cfgDir so
 *  afterEach cleans it (mirrors scout-gate.test.ts's fixture). */
function writeRoundTripFixture(): { dbPath: string; fieldsetPath: string; sourceRoot: string } {
  const sourceRoot = join(cfgDir, "rt-tree");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "a.ts"), "export const a = 1\n", "utf-8");
  writeFileSync(join(sourceRoot, "b.ts"), "export const b = 2\n", "utf-8");
  const dbPath = join(cfgDir, "rt-scout.db");
  const fieldsetPath = join(cfgDir, "rt-fields.json");
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
  return { dbPath, fieldsetPath, sourceRoot };
}

describe("scout-accuracy ledger date-axis (TRDD-IQ6EHUUW)", () => {
  const defaultHash = () =>
    scoutAccuracyHash(DEFAULT_SCOUT_ACCURACY_THRESHOLD, DEFAULT_SCOUT_ACCURACY_TARGET_BYTES);

  it("an aged-out PASS (older than 30 days) no longer authorizes", () => {
    const h = defaultHash();
    saveCache({
      [`vendor/aged::${daysAgoIso(31)}::${h}`]: {
        date: daysAgoIso(31),
        score: { pass: true, inconclusive: false, accuracy: 0.99 },
      },
    });
    expect(passedModelIds(h).has("vendor/aged")).toBe(false);
  });

  it("a PASS at the 30-day boundary and at 29 days still authorizes", () => {
    const h = defaultHash();
    saveCache({
      [`vendor/boundary::${daysAgoIso(30)}::${h}`]: {
        date: daysAgoIso(30),
        score: { pass: true, inconclusive: false, accuracy: 0.99 },
      },
      [`vendor/fresh::${daysAgoIso(29)}::${h}`]: {
        date: daysAgoIso(29),
        score: { pass: true, inconclusive: false, accuracy: 0.99 },
      },
    });
    expect(passedModelIds(h).has("vendor/boundary")).toBe(true);
    expect(passedModelIds(h).has("vendor/fresh")).toBe(true);
  });

  it("a newer in-window PASS overrides an aged-out FAIL (latest-wins x aging)", () => {
    const h = defaultHash();
    saveCache({
      [`vendor/m::${daysAgoIso(40)}::${h}`]: {
        date: daysAgoIso(40),
        score: { pass: false, inconclusive: false, accuracy: 0.4 },
      },
      [`vendor/m::${daysAgoIso(5)}::${h}`]: {
        date: daysAgoIso(5),
        score: { pass: true, inconclusive: false, accuracy: 0.97 },
      },
    });
    expect(passedModelIds(h).has("vendor/m")).toBe(true);
  });

  it("a row with an unparseable date never authorizes (fail closed)", () => {
    const h = defaultHash();
    // The KEY is well-formed (3 parts) so only the DATE check can reject it —
    // a malformed key would be skipped by the key-shape filter either way.
    saveCache({
      [`vendor/nodate::2026-01-01::${h}`]: {
        date: "not-a-date",
        score: { pass: true, inconclusive: false, accuracy: 0.99 },
      },
    });
    expect(passedModelIds(h).has("vendor/nodate")).toBe(false);
  });
});

describe("writer -> reader round-trip (TRDD-IQ6EHUUW)", () => {
  it("a profile written by the REAL writer authorizes the REAL mass-scout gate (fresh PASS)", async () => {
    const r = await runScoutAccuracyBenchmark(baseOpts());
    expect(r.ok).toBe(true);
    expect(r.profileWritten).toBe(true);
    const { dbPath, fieldsetPath, sourceRoot } = writeRoundTripFixture();
    const reg = await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot, "--input-price-per-m", "0.0001", "--output-price-per-m", "0.0002", "--context-window", "200000"]);
    // PT-05: register now sizes files for the scouting model ("cheap/good"), whose pricing the test must supply.
    expect(reg.stderr).toBe("");
    // Key-name drift between the writer (settings.yaml scouting profile) and
    // the reader (the gate) would surface HERE as a gate refusal.
    setValidationBypassForTests(true);
    try {
      const res = await runMassScoutCli(
        [
          "scout",
          "--db",
          dbPath,
          "--fields-file",
          fieldsetPath,
          "--job-id",
          "rt-job",
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
        { apiKey: "test-key", mainRoot: cfgDir, fetchImpl: goodCliFetch() },
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/files_ok=2/);
    } finally {
      setValidationBypassForTests(false);
    }
  });

  it("date-axis through the REAL reader: an aged-out head PASS refuses the gate", async () => {
    const r = await runScoutAccuracyBenchmark(baseOpts());
    expect(r.ok).toBe(true);
    // Age every ledger row the writer just recorded past the max age, keeping
    // the rest of each key (modelId + hash) intact.
    const cache = loadCache();
    const aged: typeof cache = {};
    for (const [key, entry] of Object.entries(cache)) {
      const modelId = key.split("::")[0]!;
      const hashPart = key.split("::")[2]!;
      aged[`${modelId}::${daysAgoIso(40)}::${hashPart}`] = {
        date: daysAgoIso(40),
        score: entry.score,
      };
    }
    saveCache(aged);
    const { dbPath, fieldsetPath, sourceRoot } = writeRoundTripFixture();
    const res = await runMassScoutCli(
      ["scout", "--db", dbPath, "--fields-file", fieldsetPath, "--job-id", "rt-aged", "--source-root", sourceRoot],
      { apiKey: "test-key", mainRoot: cfgDir, fetchImpl: goodCliFetch() },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/the USER must re-run scout-accuracy/);
  });
});

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  cfgDir = mkdtempSync(join(tmpdir(), "scout-acc-test-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  // Mirror the CLI contract: scout-accuracy is a PAID benchmark, so the run
  // needs the master switch (allow_paid_models in settings.yaml) AND the
  // per-run opt-in (--allow-paid-models-tests sets the process flag in main()).
  // Tests replicate both; the paid gate itself is covered by paid-guard.test.ts.
  writeFileSync(
    join(cfgDir, "settings.yaml"),
    "allow_paid_models: true\nprofiles:\n  paid:\n    mode: remote-ensemble\n",
    "utf-8",
  );
  // The master switch is a process global the CLI publishes from settings at
  // main() time — a direct runScoutAccuracyBenchmark() test must publish it
  // the same way (the settings.yaml line above is what production reads).
  setAllowPaidModels(true);
  setPaidBenchmarksAllowed(true);
});

afterEach(() => {
  setPaidBenchmarksAllowed(false);
  setAllowPaidModels(false);
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("scout-accuracy benchmark action (D2)", () => {
  it("probes candidates cost-ascending, stops at survivors, writes the scouting profile", async () => {
    const progress: string[] = [];
    const r = await runScoutAccuracyBenchmark({
      ...baseOpts(),
      onProgress: (m) => progress.push(m),
    });
    expect(r.ok).toBe(true);
    expect(r.profileWritten).toBe(true);
    // cheap/good is the cheapest passer; cheap/bad fails; tiny/ctx is skipped.
    expect(r.survivors.map((s) => s.id)).toEqual(["cheap/good", "expensive/good"]);
    const skipped = r.rows.find((row) => row.modelId === "tiny/ctx");
    expect(skipped?.skipped).toBe("context too small for fixture");
    // The ledger holds a PASS under the CURRENT default-settings hash.
    const hash = scoutAccuracyHash(DEFAULT_SCOUT_ACCURACY_THRESHOLD, DEFAULT_SCOUT_ACCURACY_TARGET_BYTES);
    expect(passedModelIds(hash).has("cheap/good")).toBe(true);
    // The profile landed on disk with the cheapest passer as head.
    const yaml = readFileSync(join(cfgDir, "settings.yaml"), "utf-8");
    expect(yaml).toMatch(/scouting:/);
    expect(yaml).toMatch(/model: cheap\/good/);
    expect(yaml).not.toMatch(/:free/);
  });

  it("replaces an existing scouting profile and reports the previous head (D3/A8)", async () => {
    writeFileSync(
      join(cfgDir, "settings.yaml"),
      [
        "profiles:",
        "  scouting:",
        "    mode: remote",
        "    api: openrouter-remote",
        `    model: old/previous-head`,
        `    paid_models: [old/previous-head]`,
        "",
      ].join("\n"),
      "utf-8",
    );
    const progress: string[] = [];
    const r = await runScoutAccuracyBenchmark({
      ...baseOpts(),
      onProgress: (m) => progress.push(m),
    });
    expect(r.ok).toBe(true);
    expect(r.previousHeadModelId).toBe("old/previous-head");
    expect(progress.join("\n")).toMatch(/replaced existing scouting profile \(previous model: old\/previous-head\)/);
  });

  it("zero survivors -> ok:false with per-candidate best accuracy for retuning", async () => {
    const r = await runScoutAccuracyBenchmark({
      ...baseOpts(),
      fetchImpl: fixtureFetch(new Set()), // nobody passes
    });
    expect(r.ok).toBe(false);
    expect(r.profileWritten).toBe(false);
    expect(r.summaryLine).toMatch(/no model cleared the 95% scout-accuracy threshold/);
    expect(r.summaryLine).toMatch(/cheap\/bad: 50\.0%/);
    const yaml = readFileSync(join(cfgDir, "settings.yaml"), "utf-8");
    expect(yaml).not.toMatch(/scouting:/);
  });

  it("RED-PROOF (c): a ':free' id never enters the profile — the builder throws", () => {
    expect(() => buildScoutingProfile([{ modelId: "free/model:free" }])).toThrow(/:free/);
    expect(() =>
      buildScoutingProfile([{ modelId: "paid/ok" }, { modelId: "sneaky:free" }]),
    ).toThrow(/:free/);
  });

  it("ledger cache hit skips the probe (no second spend for a known PASS today)", async () => {
    const r1 = await runScoutAccuracyBenchmark(baseOpts());
    expect(r1.ok).toBe(true);
    const calls1 = r1.rows.filter((row) => row.modelId === "cheap/good" && row.costUsd > 0).length;
    expect(calls1).toBe(1);
    // Second run: cheap/good is a ledger PASS for today — served from the ledger.
    const r2 = await runScoutAccuracyBenchmark(baseOpts());
    expect(r2.ok).toBe(true);
    const cachedRow = r2.rows.find((row) => row.modelId === "cheap/good");
    expect(cachedRow?.costUsd).toBe(0);
  });
});

