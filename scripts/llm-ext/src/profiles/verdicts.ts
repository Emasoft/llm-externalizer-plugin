/**
 * profiles/verdicts.ts — ONE read-only answer to "does model M pass the benchmark for command kind K?"
 * (TRDD-SZ7TO9FW, design/specs/profile-contract.md section 4.1, increment 1 of section 10).
 *
 * WHY: the owner directive is "all must pass the benchmarks" (D2). Today "passes" has six unrelated meanings in six
 * stores, and population and serving disagree (the free pool is filled from the keyword ledger but served only on a
 * security-triage pass). This module reads the six existing stores as the spec maps them and returns pass, fail or
 * untested, with the store and the row's timestamp. It writes nothing. profiles/resolve-chain.ts consumes it through an
 * injected reader; no request path calls either yet (the wiring needs per-tier routes, TRDD-SZ7TO9FW increment 2 report).
 *
 * Stores (spec 4.1):
 *   S1 keyword sweep        general-keyword-results.json + benchmark-results.json snapshot  -> rank-0 kinds
 *   S2 triage ledger        security-triage-results.json                                    -> security_scan
 *      S2 deterministic     code-task / check-specs / scan-folder / search-existing         -> code_task check_against_specs scan_folder search_existing_implementations
 *   S3 text tools           text-tools-results.json                                         -> summarize topics sem_deduplicate describe
 *   S4 scout accuracy       scout-accuracy-results.json                                     -> mass_scout*
 *   S5 free fitness         hq-scan-quality-results.json                                    -> high_quality_scan on a ':free' id
 *   S6 local calibration    calibration/<engine>/<slug>.json                                -> every kind with a task kind
 *
 * S2 deterministic ledgers: pass is the row's qualityPass, never "failureReasons is empty" (see judgeQualityPassLedger).
 *
 * The readers are injected (VerdictSources) so tests run on temp dirs; fileSources builds the production readers over
 * a config directory. The current dataset hashes are injected too: the hash code lives in heavy modules and some of it
 * is private, and an unknown hash reads as untested (the freeFitnessUnlocked rule).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isFreeSuffixModelId } from "../benchmark/free-mode.js";
import { GENERAL_KEYWORD_LEDGER, hasQualityVerdict, isGeneralKeywordPass, latestRowsByModel, rankForTool } from "../benchmark/validated.js";
import { BROKER_ENGINES, type BrokerEngine } from "../broker/protocol.js";
import { readRecord, readRecordStatus, type PerKind } from "../calibration/record.js";
import { taskEntryOf } from "../local-input-budget.js";

export type Verdict = "pass" | "fail" | "untested";
export type VerdictStore = "S1" | "S2" | "S3" | "S4" | "S5" | "S6";

export interface VerdictResult {
  verdict: Verdict;
  /** The store the verdict came from; null when no store holds a conclusive row for this model and kind. */
  store: VerdictStore | null;
  /** The row's ISO timestamp; null when there is no row, or the row carries none (the keyword snapshot). */
  at: string | null;
}

/** How a kind is judged. The Record below forces every kind to be classified, so a new kind cannot ship unrouted. */
type Route = "hierarchy" | "text" | "scout" | "hq";

const ROUTE = {
  // S1 rank-0 kinds (spec 4.1) and the ranked kinds: the difficulty hierarchy decides (TOOL_DIFFICULTY_RANK).
  chat: "hierarchy",
  cluster_synonyms: "hierarchy",
  check_imports: "hierarchy",
  check_references: "hierarchy",
  compare_files: "hierarchy",
  batch_check: "hierarchy",
  session_summary: "hierarchy",
  security_scan: "hierarchy",
  search_existing_implementations: "hierarchy",
  scan_folder: "hierarchy",
  check_against_specs: "hierarchy",
  code_task: "hierarchy",
  // S3
  summarize: "text",
  topics: "text",
  sem_deduplicate: "text",
  describe: "text",
  // S4: the scouting-only commands of tools/definitions.ts ACCEPTED_PROFILE_TYPES that call a model
  mass_scout: "scout",
  mass_scout_chain: "scout",
  mass_scout_propose_fieldset: "scout",
  mass_scout_estimate: "scout",
  mass_scout_register: "scout",
  mass_scout_preclassify: "scout",
  // S5
  high_quality_scan: "hq",
} as const satisfies Record<string, Route>;

/** The tool ids of the model-calling commands that have a benchmark. Classify kinds have none and keep their own chain (spec section 6). */
export type CommandKind = keyof typeof ROUTE;
export const COMMAND_KINDS: readonly CommandKind[] = Object.freeze(Object.keys(ROUTE) as CommandKind[]);

export function isCommandKind(kind: string): kind is CommandKind {
  return Object.hasOwn(ROUTE, kind);
}

type TextToolKind = "summarize" | "topics" | "sem_deduplicate" | "describe";

/** The current dataset hashes; undefined = not computable, which reads as untested. */
export interface CurrentHashes {
  /** scoutAccuracyHash(threshold, targetBytes) */
  scout: string | undefined;
  /** hqScanQualityHash(datasetFingerprint()) */
  hqScanQuality: string | undefined;
  textTool(kind: TextToolKind): string | undefined;
}

export type CalibrationRead =
  | { state: "ok"; fillTokens: PerKind; at: string }
  | { state: "failed"; at: string }
  | { state: "missing" };

export interface VerdictSources {
  /** Parsed JSON of a file in the config dir; undefined when it is missing or corrupt. */
  readJson(fileName: string): unknown;
  readCalibration(engine: BrokerEngine, modelId: string): CalibrationRead;
  currentHash: CurrentHashes;
  nowMs: number;
}

// ── Production readers over a config directory ────────────────────────────

export function fileSources(configDir: string, currentHash: CurrentHashes, nowMs: number = Date.now()): VerdictSources {
  return {
    readJson(fileName) {
      try {
        return JSON.parse(readFileSync(join(configDir, fileName), "utf-8")) as unknown;
      } catch {
        return undefined; // missing or corrupt: no row, never a pass (the existing readers' rule)
      }
    },
    readCalibration(engine, modelId) {
      const status = readRecordStatus(configDir, engine, modelId);
      if (status.state === "missing") return { state: "missing" };
      const record = readRecord(configDir, engine, modelId);
      if (record === null) return { state: "missing" };
      if (status.state === "failed") return { state: "failed", at: record.calibrated_at };
      if (record.fill_tokens === undefined) throw new Error(`calibration record of ${modelId} has status ok but no fill_tokens`);
      return { state: "ok", fillTokens: record.fill_tokens, at: record.calibrated_at };
    },
    currentHash,
    nowMs,
  };
}

// ── Ledger folding ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

interface Judged {
  verdict: "pass" | "fail";
  at: string | null;
}

const judged = (pass: boolean, at: string): Judged => ({ verdict: pass ? "pass" : "fail", at: at === "" ? null : at });

/** The newest row (by ISO date, which sorts lexically) among the rows `match` accepts; a tie keeps the first, like validated.ts. */
function latestRow(ledger: unknown, match: (keyParts: string[], entry: Json) => boolean): { at: string; entry: Json } | undefined {
  const cache = asObject(ledger);
  if (cache === undefined) return undefined;
  let best: { at: string; entry: Json } | undefined;
  for (const [key, value] of Object.entries(cache)) {
    const entry = asObject(value);
    if (entry === undefined || !match(key.split("::"), entry)) continue;
    const at = typeof entry.date === "string" ? entry.date : "";
    if (best === undefined || at > best.at) best = { at, entry };
  }
  return best;
}

/** A `{score: {pass, inconclusive}}` row: an inconclusive row is neither a pass nor a fail (spec 4.1 "untested"). */
function judgeScoreRow(row: { at: string; entry: Json } | undefined): Judged | undefined {
  if (row === undefined) return undefined;
  const score = asObject(row.entry.score);
  if (score === undefined || score.inconclusive === true) return undefined;
  return judged(score.pass === true, row.at);
}

// ── S1: the general keyword sweep (rank 0) ────────────────────────────────

/**
 * The accumulating ledger is AUTHORITATIVE for every model it mentions (latest row wins, pass or fail); the whole-file
 * snapshot of the last sweep only speaks for a model the ledger has never seen (validated.ts passedGeneralKeyword, so a
 * stale snapshot pass cannot resurrect a model the ledger recorded as failing). The fold and the pass predicate are
 * validated.ts's own (TRDD-SZ7TO9FW increment 2 removed the copies, inc-1 report P10).
 */
function judgeKeyword(src: VerdictSources, modelId: string): Judged | undefined {
  const row = latestRowsByModel(src.readJson(GENERAL_KEYWORD_LEDGER)).get(modelId);
  if (row !== undefined) return judged(isGeneralKeywordPass(row.entry), row.date);
  const results = asObject(src.readJson("benchmark-results.json"))?.results;
  if (!Array.isArray(results)) return undefined;
  const rows = results.map(asObject).filter((r): r is Json => r !== undefined && r.modelId === modelId);
  if (rows.length === 0) return undefined;
  return judged(rows.some(isGeneralKeywordPass), ""); // the snapshot carries no date
}

// ── S2: the security-triage ledger (rank 1) ───────────────────────────────

/** The reader of validated.ts keys on the model id and discards the dataset hash, so the hash is ignored here too (same fold). */
function judgeTriage(src: VerdictSources, modelId: string): Judged | undefined {
  const row = latestRowsByModel(src.readJson("security-triage-results.json")).get(modelId);
  return judgeScoreRow(row === undefined ? undefined : { at: row.date, entry: row.entry });
}

/**
 * The four deterministic per-tool ledgers (code-task, check-specs, scan-folder, search-existing), one row per
 * `modelId::date::datasetHash`. WHY qualityPass and not failureReasons (coordinator decision on P1, owner rule "models
 * must pass the benchmarks"): qualityPass is the threshold verdict stored at write time; failureReasons only lists the
 * cases that failed to RUN, so a row can have an empty list and qualityPass false (a live code-task row does) and is
 * then a FAIL. Increment 2 (TRDD-SZ7TO9FW) moved validated.ts passedDeterministic to the same rule and the same fold
 * (latestRowsByModel admitting only rows with a boolean qualityPass), so the send gate and this module agree. The
 * dataset hash is ignored, as in validated.ts. A row without a boolean qualityPass (a legacy row not yet backfilled)
 * gives no verdict.
 */
function judgeQualityPassLedger(src: VerdictSources, modelId: string, fileName: string): Judged | undefined {
  const row = latestRowsByModel(src.readJson(fileName), hasQualityVerdict).get(modelId);
  return row === undefined ? undefined : judged(row.entry.qualityPass === true, row.date);
}

/** The ledgers of the difficulty hierarchy, easiest first (ranks are TOOL_DIFFICULTY_RANK in validated.ts). */
const MAPPED_LEDGERS: ReadonlyArray<{ rank: number; store: VerdictStore; judge: (src: VerdictSources, modelId: string) => Judged | undefined }> = [
  { rank: 0, store: "S1", judge: judgeKeyword },
  { rank: 1, store: "S2", judge: judgeTriage },
  { rank: 2, store: "S2", judge: (src, id) => judgeQualityPassLedger(src, id, "search-existing-results.json") },
  { rank: 3, store: "S2", judge: (src, id) => judgeQualityPassLedger(src, id, "scan-folder-results.json") },
  { rank: 4, store: "S2", judge: (src, id) => judgeQualityPassLedger(src, id, "check-specs-results.json") },
  { rank: 5, store: "S2", judge: (src, id) => judgeQualityPassLedger(src, id, "code-task-results.json") },
];

/**
 * validated.ts validatedModelsForTool: a kind of rank r is covered by a pass in any ledger of rank >= r (a harder
 * benchmark covers an easier one). A fail only counts from the kind's OWN rank: failing a harder benchmark says nothing
 * about an easier one. Any covering pass beats a fail, as the union of passed-sets does there.
 */
function judgeHierarchy(src: VerdictSources, modelId: string, kind: CommandKind): VerdictResult {
  const rank = rankForTool(kind);
  const covering = MAPPED_LEDGERS.filter((l) => l.rank >= rank);
  let ownFail: VerdictResult | undefined;
  for (const ledger of covering) {
    const j = ledger.judge(src, modelId);
    if (j === undefined) continue;
    if (j.verdict === "pass") return { verdict: "pass", store: ledger.store, at: j.at };
    if (ledger.rank === rank) ownFail = { verdict: "fail", store: ledger.store, at: j.at };
  }
  return ownFail ?? UNTESTED;
}

// ── S3: text tools ────────────────────────────────────────────────────────

/** Row key `tool::modelId::date::datasetHash`; the verdict is the row's qualityPass (the threshold verdict stored at write time) under the CURRENT hash. */
function judgeText(src: VerdictSources, modelId: string, kind: TextToolKind): Judged | undefined {
  const hash = src.currentHash.textTool(kind);
  if (hash === undefined) return undefined;
  const row = latestRow(
    src.readJson("text-tools-results.json"),
    (parts, entry) => parts.length === 4 && parts[0] === kind && parts[1] === modelId && parts[3] === hash && typeof entry.qualityPass === "boolean",
  );
  return row === undefined ? undefined : judged(row.entry.qualityPass === true, row.at);
}

// ── S4: scout accuracy ────────────────────────────────────────────────────

/** scout-accuracy-ledger.ts SCOUT_ACCURACY_MAX_AGE_DAYS: a row older than this no longer counts, undated or unparseable rows never do. */
const SCOUT_MAX_AGE_DAYS = 30;

/** Row key `modelId::date::hash`; only rows of the CURRENT hash and under the age limit are considered, then the latest decides. */
function judgeScout(src: VerdictSources, modelId: string): Judged | undefined {
  const hash = src.currentHash.scout;
  if (hash === undefined) return undefined;
  const cutoff = new Date(src.nowMs - SCOUT_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  return judgeScoreRow(
    latestRow(
      src.readJson("scout-accuracy-results.json"),
      (parts, entry) =>
        parts.length === 3 && parts[0] === modelId && parts[2] === hash && typeof entry.date === "string" && Number.isFinite(Date.parse(entry.date)) && entry.date >= cutoff,
    ),
  );
}

// ── S5: free fitness (high_quality_scan) ──────────────────────────────────

/** Row key `modelId::date::hash`. Only a ':free' id is judged: a paid id is spec open question Q12, so it stays untested. */
function judgeHq(src: VerdictSources, modelId: string): Judged | undefined {
  const hash = src.currentHash.hqScanQuality;
  if (hash === undefined || !isFreeSuffixModelId(modelId)) return undefined;
  return judgeScoreRow(latestRow(src.readJson("hq-scan-quality-results.json"), (parts) => parts.length === 3 && parts[0] === modelId && parts[2] === hash));
}

// ── S6: local calibration ─────────────────────────────────────────────────

/** The model's record under the first engine that has an ok one, else a failed one; undefined when no engine has a record. */
function localRecord(src: VerdictSources, modelId: string): Exclude<CalibrationRead, { state: "missing" }> | undefined {
  let failed: { state: "failed"; at: string } | undefined;
  for (const engine of BROKER_ENGINES) {
    const r = src.readCalibration(engine, modelId);
    if (r.state === "ok") return r;
    if (r.state === "failed" && failed === undefined) failed = r;
  }
  return failed;
}

/** ok with fill_tokens[task kind] > 0 = pass; ok with 0, or failed = fail (spec 4.1). A kind with no task kind (mass_scout*) has no mapping: untested. */
function judgeLocal(local: Exclude<CalibrationRead, { state: "missing" }>, kind: CommandKind): VerdictResult {
  if (local.state === "failed") return { verdict: "fail", store: "S6", at: local.at };
  const entry = taskEntryOf(kind);
  if (entry === undefined) return { verdict: "untested", store: "S6", at: local.at };
  return { verdict: local.fillTokens[entry.kind] > 0 ? "pass" : "fail", store: "S6", at: local.at };
}

// ── The unified verdict ───────────────────────────────────────────────────

const UNTESTED: VerdictResult = { verdict: "untested", store: null, at: null };

function fromJudged(j: Judged | undefined, store: VerdictStore): VerdictResult {
  return j === undefined ? UNTESTED : { verdict: j.verdict, store, at: j.at };
}

/**
 * pass | fail | untested for `modelId` on `kind`, with the store and timestamp it came from.
 *
 * Which store wins: a model with a calibration record is a managed local model and S6 alone speaks for it (the record is
 * route-specific, and a local kind the calibration found unfit must never be served from another route's ledger row).
 * Every other model is judged by the kind's own store; the hierarchy kinds also accept a covering pass from a harder
 * ledger (judgeHierarchy). The spec is silent on the S6-versus-ledger conflict: this is the agent's choice (report P5).
 * An unknown kind throws: a verdict for a kind nobody classified would be a guess.
 */
export function verdict(src: VerdictSources, modelId: string, kind: string): VerdictResult {
  if (!isCommandKind(kind)) throw new Error(`no verdict for unknown command kind '${kind}'`);
  const local = localRecord(src, modelId);
  if (local !== undefined) return judgeLocal(local, kind);
  switch (ROUTE[kind]) {
    case "hierarchy":
      return judgeHierarchy(src, modelId, kind);
    case "text":
      return fromJudged(judgeText(src, modelId, kind as TextToolKind), "S3");
    case "scout":
      return fromJudged(judgeScout(src, modelId), "S4");
    case "hq":
      return fromJudged(judgeHq(src, modelId), "S5");
  }
}
