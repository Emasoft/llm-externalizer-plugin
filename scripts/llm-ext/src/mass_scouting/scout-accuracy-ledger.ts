/**
 * Scout-accuracy ledger (TRDD-FKAR9VPK D4).
 *
 * OWN file — scout-accuracy-results.json in the config dir. NEVER
 * security-triage-results.json: every triage reader discards datasetHash, so a
 * shared file would let a scout-accuracy row poison free-rotation and the
 * serving gates (MEASURE A2).
 *
 * Key: `modelId::date::hash`, where hash = sha256 over
 * fixture-version-const + threshold + target-bytes (review F-2). RETUNING
 * threshold (or a fixture-version bump, or a target-size change) CHANGES THE
 * HASH, so every prior verdict is intentionally invalidated and the next
 * scout-accuracy run re-probes every candidate.
 *
 * Rows: {date, score: {pass, inconclusive, accuracy}}. An INCONCLUSIVE row is
 * never a PASS (A9c) — only pass:true under the CURRENT hash authorizes a
 * model for the mass-scout gate.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config.js";
import { SCOUT_ACCURACY_FIXTURE_VERSION } from "./scout-accuracy-fixture.js";

export interface ScoutAccuracyLedgerScore {
  pass: boolean;
  inconclusive: boolean;
  /** 0..1 — the positional accuracy this verdict was scored at. */
  accuracy: number;
}

export interface ScoutAccuracyLedgerRow {
  date: string;
  score: ScoutAccuracyLedgerScore;
}

export type LedgerFile = Record<string, ScoutAccuracyLedgerRow>;

export function scoutAccuracyLedgerPath(): string {
  return join(getConfigDir(), "scout-accuracy-results.json");
}

/**
 * ONE definition of the dataset fingerprint. The benchmark run and the
 * mass-scout gate both key verdicts on it — if the two ever diverged, the gate
 * would read a different hash than the benchmark wrote and every model would
 * look untested.
 */
export function scoutAccuracyHash(threshold: number, targetBytes: number): string {
  return createHash("sha256")
    .update(`${SCOUT_ACCURACY_FIXTURE_VERSION}:${threshold}:${targetBytes}`)
    .digest("hex")
    .slice(0, 12);
}


/** Verdicts older than this many days no longer authorize a model (date-axis,
 *  TRDD-IQ6EHUUW). The PASS filter keys on dataset hash only, so a model the
 *  provider later degrades would stay authorized indefinitely; 30d matches the
 *  free-pool/provider churn window the scout re-probe cadence targets. Aging is
 *  applied at the READER so existing ledgers need no migration — aged rows
 *  simply stop counting. */
const SCOUT_ACCURACY_MAX_AGE_DAYS = 30;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function ledgerKey(modelId: string, date: string, hash: string): string {
  return `${modelId}::${date}::${hash}`;
}

/** Pure read: {} when absent or corrupt (a corrupt ledger reads as EMPTY here,
 *  not fail-closed — the gate direction this feeds is "model untested →
 *  refuse", so empty == every model untested == the safe side). */
export function loadCache(): LedgerFile {
  const p = scoutAccuracyLedgerPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LedgerFile;
    }
  } catch {
    // Corrupt ledger is non-fatal — treat as empty; saveCache overwrites.
  }
  return {};
}

/** Load + ensure the config dir exists (the writer path). */
export function loadOrInit(): LedgerFile {
  mkdirSync(getConfigDir(), { recursive: true });
  return loadCache();
}

export function saveCache(cache: LedgerFile): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  const p = scoutAccuracyLedgerPath();
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  renameSync(tmp, p);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Record one verdict for `modelId` at today() under `hash`. An INCONCLUSIVE
 *  probe row (--allow-untested-model, A4) is recorded the same way with
 *  score.pass=false — it NEVER authorizes later invocations. */
export function recordScoutAccuracy(
  modelId: string,
  hash: string,
  score: ScoutAccuracyLedgerScore,
): void {
  const cache = loadOrInit();
  cache[ledgerKey(modelId, today(), hash)] = { date: today(), score };
  saveCache(cache);
}

/** The model ids whose LATEST verdict is a CONCLUSIVE PASS under `hash` (the
 *  CURRENT dataset hash — A8: a stale-hash PASS never authorizes). Inconclusive
 *  latest rows (including --allow-untested-model probe rows) count as neither
 *  pass nor fail — never an authorization (A9c). */
export function passedModelIds(hash: string): Set<string> {
  const cache = loadCache();
  const cutoff = isoDaysAgo(SCOUT_ACCURACY_MAX_AGE_DAYS);
  const latest = new Map<string, { date: string; score: ScoutAccuracyLedgerScore }>();
  for (const [key, entry] of Object.entries(cache)) {
    const parts = key.split("::");
    if (parts.length !== 3) continue;
    const modelId = parts[0]!;
    if (parts[2] !== hash) continue; // stale-hash row — never authorizes
    // Date-axis: a verdict older than the max age no longer authorizes — the
    // hash alone cannot see provider-side degradation, and aging at the READER
    // needs no ledger migration. A missing or unparseable date fails CLOSED
    // (this set only ever grants; a row we cannot date cannot grant).
    if (typeof entry.date !== "string" || !Number.isFinite(Date.parse(entry.date)) || entry.date < cutoff) continue;
    const prev = latest.get(modelId);
    if (!prev || entry.date > prev.date) {
      latest.set(modelId, { date: entry.date, score: entry.score });
    }
  }
  const passed = new Set<string>();
  for (const [modelId, v] of latest) {
    if (!v.score.inconclusive && v.score.pass) passed.add(modelId);
  }
  return passed;
}
