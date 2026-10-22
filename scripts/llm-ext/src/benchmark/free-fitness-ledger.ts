/**
 * Free-fitness verdict ledger (TRDD-HBCCFOUF) — the two fitness benchmarks
 * addendum H demands before the dynamic `free` profile may serve
 * `mass_scout` / `high_quality_scan`.
 *
 * OWN files — mass-scout-throughput-results.json and hq-scan-quality-results.json
 * in the config dir. NEVER security-triage-results.json: every triage reader
 * discards datasetHash, so a shared file would let a throughput verdict poison
 * free-rotation and the serving gates (the measured reason scout-accuracy got
 * its own file, scout-accuracy-ledger.ts MEASURE A2). A fitness pass must also
 * never count as a validated-for-security_scan pass, which a shared file would
 * do through validated.ts's difficulty hierarchy.
 *
 * Key: `modelId::date::hash`, rows `{date, score: {pass, inconclusive}, detail}`
 * — the same conventions as scout-accuracy-ledger.ts. A retuned benchmark
 * (version bump, parameter change, corpus edit) changes the hash, so every prior
 * verdict is intentionally invalidated and the next run re-probes.
 *
 * `freeFitnessUnlocked` is the class-level gate `isFreeForbiddenTool` reads:
 * the tool is unlocked iff SOME ':free'-suffixed model has a recorded
 * CONCLUSIVE PASS under the CURRENT hash. An inconclusive latest row, a
 * stale-hash pass, a pass owned by a paid id, and an uncomputable hash all
 * read as LOCKED (fail closed — the refusal stays until there is real
 * evidence a free model is fit).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir } from "../config.js";
import { isFreeSuffixModelId } from "./free-mode.js";
import { datasetFingerprint } from "./scan-folder/dataset.js";

export type FitnessTool = "mass_scout" | "high_quality_scan";

export const MASS_SCOUT_FITNESS_LEDGER = "mass-scout-throughput-results.json";
export const HQ_SCAN_FITNESS_LEDGER = "hq-scan-quality-results.json";

// ── Benchmark policy (owned here so the unlock hash and the benchmark's own
// hash can never diverge — the scoutAccuracyHash lesson) ────────────────────

/** Bump whenever the throughput benchmark's shape or policy changes. */
export const THROUGHPUT_VERSION = 1;

/** The sustained burst, sized to mass_scout's real concurrency:
 *  DEFAULT_SCOUT_WORKERS (16) callers in flight, 64 calls total (~4 waves),
 *  pass requires >= 90% of the burst completing without a rate-limit. */
export interface ThroughputParams {
  workers: number;
  calls: number;
  minSuccessRate: number;
}

export const DEFAULT_THROUGHPUT_PARAMS: ThroughputParams = {
  workers: 16,
  calls: 64,
  minSuccessRate: 0.9,
};

/** Bump whenever the hq-scan quality benchmark's shape or policy changes. */
export const HQ_QUALITY_VERSION = 1;

function fitnessHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

/** The hash a throughput verdict is recorded under. The unlock reads the
 *  DEFAULT params' hash only — a test-tuned run records under its own hash
 *  and never unlocks production. */
export function massScoutThroughputHash(params: ThroughputParams): string {
  return fitnessHash({ v: THROUGHPUT_VERSION, ...params });
}

/** The hash an hq-scan quality verdict is recorded under: bound to the
 *  scan-folder golden corpus the quality bar is measured on. */
export function hqScanQualityHash(datasetHash: string): string {
  return fitnessHash({ v: HQ_QUALITY_VERSION, dataset: datasetHash });
}

// ── Ledger rows ────────────────────────────────────────────────────────────

export interface FitnessVerdictScore {
  pass: boolean;
  inconclusive: boolean;
}

export interface FitnessVerdictRow {
  date: string;
  score: FitnessVerdictScore;
  /** Human-readable one-liner for the report reader; the gate ignores it. */
  detail?: string;
}

export type FitnessCache = Record<string, FitnessVerdictRow>;

export function fitnessLedgerPath(tool: FitnessTool): string {
  return join(getConfigDir(), tool === "mass_scout" ? MASS_SCOUT_FITNESS_LEDGER : HQ_SCAN_FITNESS_LEDGER);
}

/** Pure read: {} when absent or corrupt (corrupt reads as EMPTY here, not
 *  fail-closed — the gate this feeds asks "is there a recorded pass", and
 *  empty == no pass recorded == the tool stays refused, the safe side). */
export function loadFitnessCache(tool: FitnessTool): FitnessCache {
  const p = fitnessLedgerPath(tool);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FitnessCache;
    }
  } catch {
    // Corrupt ledger is non-fatal — treat as empty; the writer overwrites.
  }
  return {};
}

export function saveFitnessCache(tool: FitnessTool, cache: FitnessCache): void {
  mkdirSync(getConfigDir(), { recursive: true });
  const p = fitnessLedgerPath(tool);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  renameSync(tmp, p);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Record one verdict for `modelId` at today() under `hash`. An inconclusive
 *  row is recorded the same way — it NEVER authorizes later invocations. */
export function recordFitnessVerdict(
  tool: FitnessTool,
  modelId: string,
  hash: string,
  score: FitnessVerdictScore,
  detail?: string,
): void {
  const cache = loadFitnessCache(tool);
  cache[`${modelId}::${today()}::${hash}`] = { date: today(), score, detail };
  saveFitnessCache(tool, cache);
}

/** The model ids whose LATEST verdict is a CONCLUSIVE PASS under `hash`
 *  (current-hash only — a stale-hash PASS never authorizes, A8). Inconclusive
 *  latest rows count as neither pass nor fail (A9c). */
export function passedFitnessModelIds(tool: FitnessTool, hash: string): Set<string> {
  const cache = loadFitnessCache(tool);
  const latest = new Map<string, { date: string; score: FitnessVerdictScore }>();
  for (const [key, entry] of Object.entries(cache)) {
    const parts = key.split("::");
    if (parts.length !== 3) continue;
    const modelId = parts[0]!;
    if (parts[2] !== hash) continue;
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

// ── The class-level unlock `isFreeForbiddenTool` reads ─────────────────────

let hqDatasetFingerprintMemo: string | null = null;

function currentHqDatasetFingerprint(): string {
  if (hqDatasetFingerprintMemo === null) {
    // The scan-folder corpus is shipped and static, so the fingerprint is
    // memoized for the process lifetime — it is recomputed on every
    // high_quality_scan dispatch otherwise, and it reads a dozen files.
    hqDatasetFingerprintMemo = datasetFingerprint();
  }
  return hqDatasetFingerprintMemo;
}

/**
 * Is `tool`'s fitness benchmark UNLOCKED — i.e. does some ':free'-suffixed
 * model hold a recorded conclusive PASS under the CURRENT benchmark hash?
 * Fail-closed on every absence: no ledger, no matching hash, an uncomputable
 * hash (missing fixtures), or only paid/non-free passers all read LOCKED.
 */
export function freeFitnessUnlocked(tool: FitnessTool): boolean {
  try {
    const hash =
      tool === "mass_scout"
        ? massScoutThroughputHash(DEFAULT_THROUGHPUT_PARAMS)
        : hqScanQualityHash(currentHqDatasetFingerprint());
    for (const id of passedFitnessModelIds(tool, hash)) {
      if (isFreeSuffixModelId(id)) return true;
    }
    return false;
  } catch {
    // The refusal "may never throw" (dynamicProfileGate's invariant) and this
    // read sits inside it: an uncomputable hash (missing fixture corpus) is
    // no evidence of fitness, so the tool stays refused.
    return false;
  }
}
