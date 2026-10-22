/**
 * Scout-accuracy ledger tests (TRDD-FKAR9VPK D4 + amendments A8/A9c).
 * Real on-disk ledger under a per-test LLM_EXT_CONFIG_DIR.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import {
  loadCache,
  loadOrInit,
  passedModelIds,
  recordScoutAccuracy,
  saveCache,
  scoutAccuracyHash,
  scoutAccuracyLedgerPath,
} from "./scout-accuracy-ledger.js";
import { SCOUT_ACCURACY_FIXTURE_VERSION } from "./scout-accuracy-fixture.js";

let cfgDir: string;
let prevCfgDir: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  cfgDir = mkdtempSync("/tmp/scout-ledger-test-");
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("scout-accuracy ledger (D4)", () => {
  it("lives in its OWN file — never security-triage-results.json", () => {
    const p = scoutAccuracyLedgerPath();
    expect(p).toMatch(/scout-accuracy-results\.json$/);
    expect(p).not.toMatch(/security-triage/);
    expect(p).toContain(cfgDir);
  });

  it("the hash covers fixture version + threshold + target bytes", () => {
    const a = scoutAccuracyHash(0.95, 250_000);
    const b = scoutAccuracyHash(0.9, 250_000);
    const c = scoutAccuracyHash(0.95, 100_000);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(scoutAccuracyHash(0.95, 250_000)); // deterministic
    expect(a).toHaveLength(12);
  });

  it("records and reads back a verdict under the current hash", () => {
    const hash = scoutAccuracyHash(0.95, 250_000);
    recordScoutAccuracy("vendor/m", hash, { pass: true, inconclusive: false, accuracy: 0.97 });
    expect(passedModelIds(hash).has("vendor/m")).toBe(true);
    const cache = loadCache();
    const key = Object.keys(cache)[0]!;
    expect(key.startsWith(`vendor/m::`)).toBe(true);
    expect(key.endsWith(`::${hash}`)).toBe(true);
    expect(cache[key]!.score).toEqual({ pass: true, inconclusive: false, accuracy: 0.97 });
  });

  it("A8: a stale-hash PASS never authorizes", () => {
    const oldHash = scoutAccuracyHash(0.95, 250_000);
    const newHash = scoutAccuracyHash(0.9, 250_000); // threshold retuned
    recordScoutAccuracy("vendor/m", oldHash, { pass: true, inconclusive: false, accuracy: 0.97 });
    expect(passedModelIds(oldHash).has("vendor/m")).toBe(true);
    expect(passedModelIds(newHash).has("vendor/m")).toBe(false);
  });

  it("A9c: an inconclusive row is NOT a PASS", () => {
    const hash = scoutAccuracyHash(0.95, 250_000);
    recordScoutAccuracy("vendor/m", hash, { pass: false, inconclusive: true, accuracy: 0 });
    expect(passedModelIds(hash).has("vendor/m")).toBe(false);
  });

  it("latest date wins per model within one hash", () => {
    const hash = scoutAccuracyHash(0.95, 250_000);
    // Dates must be RELATIVE — with the 30d reader-side max age, a hardcoded
    // calendar date silently ages out of the window (2026-09-30 did on
    // 2026-10-31) and the test starts failing for the wrong reason.
    const d0 = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const d1 = new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10);
    saveCache({
      [`vendor/m::${d0}::${hash}`]: { date: d0, score: { pass: false, inconclusive: false, accuracy: 0.4 } },
      [`vendor/m::${d1}::${hash}`]: { date: d1, score: { pass: true, inconclusive: false, accuracy: 0.97 } },
    });
    expect(passedModelIds(hash).has("vendor/m")).toBe(true);
  });

  it("a corrupt ledger reads as empty (every model untested — the safe side)", () => {
    writeFileSync(scoutAccuracyLedgerPath(), "{not json", "utf-8");
    expect(loadCache()).toEqual({});
    expect(passedModelIds(scoutAccuracyHash(0.95, 250_000)).size).toBe(0);
  });

  it("loadOrInit creates the config dir; loadCache does not throw on a missing file", () => {
    expect(existsSync(cfgDir)).toBe(true);
    expect(loadCache()).toEqual({});
    loadOrInit();
    expect(existsSync(cfgDir)).toBe(true);
  });

  it("fixture version is part of the hashed material", () => {
    // SCOUT_ACCURACY_FIXTURE_VERSION is inside the hash preimage — pin the
    // concrete digest so a bump is a visible, deliberate change.
    expect(scoutAccuracyHash(0.95, 250_000)).toBe(
      scoutAccuracyHash(0.95, 250_000),
    );
    expect(SCOUT_ACCURACY_FIXTURE_VERSION).toBe(1);
  });
});
