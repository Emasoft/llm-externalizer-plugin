/**
 * calibration/record.ts — a model's calibration record: where it lives, its
 * schema (version 1), the atomic writer, and whether it makes the model usable
 * (P6, TRDD-1OOAH3LD, TRDD-ZGSGGHQG; design/specs/local-calibration-design.md
 * sections 3 and 7).
 *
 * The broker reads this before it queues a job for a managed local model:
 * only a valid record with `status: ok` makes the model usable; with none, the
 * job is held until one exists (user ruling "No, wait", spec section 2).
 */

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { BrokerEngine } from "../broker/protocol.js";
import { timingsFromEnv } from "../broker/scheduler.js";

/**
 * Bumped when the calibration method changes, and whenever PRODUCTION_HARNESS
 * (runner.ts) changes: every record and progress entry of an older harness is
 * invalid (spec section 3).
 */
// 3 (review of a3862052, coordinator decision): the Phase C method changed (wall-time throughput, per-kind slot
// context, non-terminal skips) and Phase B resumes on the hard W, with the same harness JSON: a progress file of
// fb861fab (version 2) mixes the old measurements in, so it is discarded.
// 4 (coordinator decisions 2026-10-29): scouting with every candidate over total RAM is no longer a calibration
// failure, and a scouting timeout becomes terminal after 3 passes. A version-3 calibration-failed record from the old
// scouting rule would otherwise stay "valid and current" forever, so every version-3 record and progress is redone.
// 5 (coordinator, 2026-10-29): `aggregate_decode_tps` is renamed `aggregate_tps` (a wall-time throughput, prefill
// included), a scouting run whose requests fail in transport (reset, HTTP 502/503/504) is no longer scored all-wrong
// but repeated and left pending, and a memory wait is stored as an object. A version-4 progress file would be read
// wrongly (its main-slot trials carry the old key and would count as finished but unmeasured, and its scouting trials
// may have scored transport failures as wrong answers), so every version-4 record and progress is redone. Phase B
// waits for memory with the same bound and rule A as Phase C (a step given up after its waits is a "memory-wait"
// grid skip, never a failure), where a version-4 Phase B waited without a bound. Version 5 also carries the memory
// verdicts (coordinator decisions 2026-10-29, rules 1 and 2): the status "memory-limited" and the optional
// `memory_judged` of a calibration-failed record, both additive under RECORD_SCHEMA 2. No further bump: version 5 was
// never released before them, so no version-5 record of the older shape exists outside a development tree.
export const HARNESS_VERSION = 5;
/**
 * The `harness` id of a record made with the production harness (D4, main-agent
 * decision 2026-10-29). A custom LLM_EXT_CALIBRATION_HARNESS writes
 * "custom:<sha256 of its JSON>", and such a record never makes a model usable.
 */
export const PRODUCTION_HARNESS_ID = "production";
/** The record format (spec section 7): 2 added `harness` and thinking_works.off "leaky" (D6). */
export const RECORD_SCHEMA = 2;
/** Bumped when a fixture (filler, needles, planted bugs, scouting copy) changes. */
export const FIXTURE_VERSION = 1;

export const TASK_KINDS = ["fact", "aggregate", "bug"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type PerKind = Record<TaskKind, number>;

/**
 * A grid step not run for a kind (main-agent decision 2026-10-29, the user may override): "window" when step + nominal
 * output cap + 64 exceeds the HARD window (window-limited, not quality-limited); "memory-wait" when it fit the hard
 * window but free memory stayed short of it through INCONCLUSIVE_PASSES passes of memory waits (coordinator decision
 * 2026-10-29: given up, never a failure; memory-limited). The walk steps down past either.
 */
export interface GridSkip {
  kind: TaskKind;
  tokens: number;
  skipped: "window" | "memory-wait";
  /** The W the step did not fit: the hard W for "window", the soft W (free memory) for "memory-wait". */
  W: number;
}
export interface GridEntry {
  kind: TaskKind;
  /** "main" for fact and aggregate; bug runs two counters, "bug" and "control" (spec 4.3). */
  counter: "main" | "bug" | "control";
  tokens: number;
  trials: number;
  passed: number;
  inconclusive: number;
  /** Replies cut at max_tokens (D1), conclusive or not; cut_fails = the fails that were cuts at the nominal cap. */
  cuts: number;
  cut_fails: number;
  /** The largest cap a cut hit, or null when no reply was cut. */
  cut_cap: number | null;
}

export interface Fingerprint {
  /** sha256 of every weight file's content (the Hugging Face blob name), sorted. */
  blobs: string[];
  ram_bytes: number;
}

/**
 * "memory-limited" (coordinator decision 2026-10-29, rule 2): the step that decides the calibration (B/window, or every
 * Phase C main slot) was given up after its memory waits. Neither a pass nor a failure: a busy machine gives no verdict.
 */
export type RecordStatusValue = "ok" | "engine-check-failed" | "calibration-failed" | "memory-limited";

/** What a "too big for this machine's memory" verdict was judged against (rule 1): a change of any re-checks it. */
export interface MemoryJudged {
  total_ram_bytes: number;
  floor_pct: number;
  n_ctx_train: number;
}

/**
 * Spec section 7. A calibration-failed or memory-limited record carries the identity, status, failed_step and message
 * only, plus memory_judged on a "too big for this machine's memory" failure.
 */
export interface CalibrationRecord {
  schema: 2;
  /** PRODUCTION_HARNESS_ID, or "custom:<sha256>" for a reduced harness (D4). */
  harness: string;
  harness_version: number;
  fixture_version: number;
  engine: BrokerEngine;
  model: string;
  fingerprint: Fingerprint;
  engine_version: string;
  engine_version_checked: string;
  status: RecordStatusValue;
  failed_step: string | null;
  message?: string;
  /** Rule 1: on a calibration-failed record whose model is too big for this machine's memory, what it was judged against. */
  memory_judged?: MemoryJudged;
  calibrated_at: string;
  duration_s: number;
  window_tokens?: number;
  free_ram_bytes?: number;
  chars_per_token?: number;
  capabilities?: { thinking: boolean; n_ctx_train: number };
  /** off: "leaky" = thinking is off but the model reasons in its visible answer (D5; does not fail Phase A). */
  thinking_works?: { off: boolean | "leaky"; on: boolean };
  min_output_tokens?: PerKind;
  /** 0 = unfit for that kind (it failed at the 2048-token floor). */
  fill_tokens?: PerKind;
  /** Why a kind is unfit when no grid step ran for it (main-agent decision 2026-10-29: "window W too small for thinking on output"). */
  unfit_reasons?: Partial<Record<TaskKind, string>>;
  grid?: Array<GridEntry | GridSkip>;
  structured_output?: { off: boolean; on: boolean; array40: boolean; error?: string };
  main?: { slots: number; slot_ctx: number };
  /**
   * Every scouting candidate Phase C measured (review of fb861fab; main-agent decision 2026-10-29, the user may
   * override). scout_accuracy_threshold is applied when the record is read (scoutingFor), so changing the threshold
   * in settings.yaml needs no new calibration. No candidate passing the threshold means scouting is unfit.
   */
  scouting_candidates?: ScoutCandidate[];
  /**
   * Why no scouting candidate was scored (coordinator decision 2026-10-29): "over total RAM", "timed out on 3 passes",
   * or both. Present only with an empty scouting_candidates; scouting is then unfit at any threshold, and the model is
   * usable for everything else. Absent means unfit, if at all, by accuracy.
   */
  scouting_unfit_reason?: string;
  speed?: { prefill_tps: number; decode_tps: number; aggregate_tps: number; load_avg: number };
}

/** `<slug>`: the model id made filename-safe, plus 8 hex digits of its sha256, so two ids that sanitize alike never share a record. */
export function recordSlug(model: string): string {
  const safe = model.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return `${safe}-${createHash("sha256").update(model).digest("hex").slice(0, 8)}`;
}

/** `<config dir>/calibration/<engine>/`. */
export function calibrationDir(dir: string, engine: BrokerEngine): string {
  return join(dir, "calibration", engine);
}

/** `<config dir>/calibration/<engine>/<slug>.json`. */
export function recordPath(dir: string, engine: BrokerEngine, model: string): string {
  return join(calibrationDir(dir, engine), `${recordSlug(model)}.json`);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonNeg = (v: unknown): boolean => isNum(v) && v >= 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const perKind = (v: unknown): boolean => isObj(v) && TASK_KINDS.every((k) => isNonNeg(v[k]));

/** Every way `raw` breaks the version-1 schema; [] = valid. */
export function recordSchemaErrors(raw: unknown): string[] {
  const e: string[] = [];
  if (!isObj(raw)) return ["not an object"];
  const need = (ok: boolean, what: string): void => {
    if (!ok) e.push(what);
  };
  need(raw.schema === RECORD_SCHEMA, `schema must be ${RECORD_SCHEMA}`);
  need(isStr(raw.harness) && /^(production|custom:[0-9a-f]{64})$/.test(raw.harness), "harness (production or custom:<sha256>)");
  need(isNonNeg(raw.harness_version), "harness_version");
  need(isNonNeg(raw.fixture_version), "fixture_version");
  need(raw.engine === "llama" || raw.engine === "locals", "engine");
  need(isStr(raw.model) && raw.model !== "", "model");
  const fp = raw.fingerprint;
  need(isObj(fp) && Array.isArray(fp.blobs) && fp.blobs.every((b) => isStr(b) && /^[0-9a-f]{64}$/.test(b)) && isNonNeg(fp.ram_bytes), "fingerprint {blobs: sha256[], ram_bytes}");
  need(isStr(raw.engine_version) && isStr(raw.engine_version_checked), "engine_version, engine_version_checked");
  need(raw.status === "ok" || raw.status === "engine-check-failed" || raw.status === "calibration-failed" || raw.status === "memory-limited", "status");
  need(raw.failed_step === null || isStr(raw.failed_step), "failed_step");
  need(raw.message === undefined || isStr(raw.message), "message");
  need(isStr(raw.calibrated_at) && isNonNeg(raw.duration_s), "calibrated_at, duration_s");
  const mj = raw.memory_judged;
  need(mj === undefined || (raw.status === "calibration-failed" && isObj(mj) && isNonNeg(mj.total_ram_bytes) && isNonNeg(mj.floor_pct) && isNonNeg(mj.n_ctx_train)), "memory_judged (a calibration-failed record only)");
  if (raw.status === "calibration-failed" || raw.status === "memory-limited") {
    need(isStr(raw.failed_step) && isStr(raw.message), `a ${raw.status} record names failed_step and message`);
    return e;
  }
  need(isNum(raw.window_tokens) && raw.window_tokens >= 2048, "window_tokens");
  need(isNonNeg(raw.free_ram_bytes), "free_ram_bytes");
  need(isNum(raw.chars_per_token) && raw.chars_per_token > 0, "chars_per_token");
  const cap = raw.capabilities;
  need(isObj(cap) && isBool(cap.thinking) && isNonNeg(cap.n_ctx_train), "capabilities");
  const tw = raw.thinking_works;
  need(isObj(tw) && (isBool(tw.off) || tw.off === "leaky") && isBool(tw.on), "thinking_works");
  need(perKind(raw.min_output_tokens), "min_output_tokens");
  need(perKind(raw.fill_tokens), "fill_tokens");
  const ur = raw.unfit_reasons;
  need(ur === undefined || (isObj(ur) && Object.entries(ur).every(([k, v]) => TASK_KINDS.includes(k as TaskKind) && isStr(v))), "unfit_reasons");
  need(
    Array.isArray(raw.grid) &&
      raw.grid.every(
        (g: unknown) =>
          isObj(g) &&
          TASK_KINDS.includes(g.kind as TaskKind) &&
          isNonNeg(g.tokens) &&
          (g.skipped === "window" || g.skipped === "memory-wait"
            ? isNonNeg(g.W)
            : (g.counter === "main" || g.counter === "bug" || g.counter === "control") &&
              [g.trials, g.passed, g.inconclusive, g.cuts, g.cut_fails].every(isNonNeg) &&
              (g.cut_cap === null || isNonNeg(g.cut_cap))),
      ),
    "grid",
  );
  const so = raw.structured_output;
  need(isObj(so) && isBool(so.off) && isBool(so.on) && isBool(so.array40) && (so.error === undefined || isStr(so.error)), "structured_output");
  const main = raw.main;
  need(isObj(main) && isNum(main.slots) && main.slots >= 1 && isNum(main.slot_ctx) && main.slot_ctx >= 256, "main");
  const sc = raw.scouting_candidates;
  need(Array.isArray(sc) && sc.every((c) => isObj(c) && SCOUT_CANDIDATE_KEYS.every((k) => isNonNeg(c[k]))), "scouting_candidates");
  // A reason only where no candidate was scored: with candidates, unfit is decided by the threshold at read time.
  const sr = raw.scouting_unfit_reason;
  need(sr === undefined || (isStr(sr) && sr !== "" && Array.isArray(sc) && sc.length === 0), "scouting_unfit_reason");
  const sp = raw.speed;
  need(isObj(sp) && ["prefill_tps", "decode_tps", "aggregate_tps", "load_avg"].every((k) => isNonNeg(sp[k])), "speed");
  return e;
}

/** One measured scouting shape (spec 4.5): the share in tokens per request, the slot count, and what it scored. */
export interface ScoutCandidate {
  share_tokens: number;
  slots: number;
  slot_ctx: number;
  accuracy: number;
  records_per_s: number;
  permutation_seed: number;
}

const SCOUT_CANDIDATE_KEYS = ["share_tokens", "slots", "slot_ctx", "accuracy", "records_per_s", "permutation_seed"] as const;

/**
 * The scouting shape at a threshold (spec 4.5): the highest share whose accuracy reaches it; at that share, the slot
 * count with the best records per second; "unfit" when no candidate passes. Applied when the record is read, never
 * when it is written, so the record stays valid across threshold changes.
 */
export function scoutingFor(candidates: readonly ScoutCandidate[], threshold: number): ScoutCandidate | "unfit" {
  const passing = candidates.filter((c) => c.accuracy >= threshold);
  if (passing.length === 0) return "unfit";
  const share = Math.max(...passing.map((c) => c.share_tokens));
  return passing.filter((c) => c.share_tokens === share).reduce((a, b) => (b.records_per_s > a.records_per_s ? b : a));
}

/** The fields of a record that come from the run itself, not from the phase summaries. */
export type RecordBase = Pick<CalibrationRecord, "harness" | "harness_version" | "fixture_version" | "engine" | "model" | "fingerprint" | "engine_version" | "engine_version_checked" | "calibrated_at" | "duration_s">;

type SummaryData = Record<string, number | string | boolean | null>;

/**
 * The `status: ok` record of a model whose three phases passed (spec section 7), built from the A/summary,
 * B/summary and C/summary trials. thinking_works.off is Phase B's re-judged value (D5, review of a72827f9), and
 * window_tokens is the smallest W any counted Phase B trial ran under (main-agent decision 2026-10-29, after
 * review). A missing summary is a bug in the runner: it throws, and writeRecord checks the shape.
 */
export function okRecordFrom(base: RecordBase, trials: ReadonlyArray<{ step: string; data?: SummaryData }>): CalibrationRecord {
  const of = (step: string): SummaryData => {
    const d = [...trials].reverse().find((t) => t.step === step && t.data)?.data;
    if (!d) throw new Error(`cannot write the calibration record: no ${step}`);
    return d;
  };
  const a = of("A/summary");
  const b = of("B/summary");
  const c = of("C/summary");
  const n = (v: unknown): number => Number(v);
  const off = b.thinking_off_mode;
  const reasons = typeof b.unfit_reasons === "string" ? (JSON.parse(b.unfit_reasons) as Partial<Record<TaskKind, string>>) : {};
  return {
    schema: 2,
    ...base,
    status: "ok",
    failed_step: null,
    window_tokens: n(b.window_tokens_min ?? b.window_tokens),
    free_ram_bytes: n(b.free_ram_bytes),
    chars_per_token: n(a.chars_per_token),
    capabilities: { thinking: a.template_thinking === true, n_ctx_train: n(a.n_ctx_train) },
    thinking_works: { off: off === "leaky" ? "leaky" : off === true, on: a.thinking_on === true },
    min_output_tokens: { fact: n(b.min_out_fact), aggregate: n(b.min_out_aggregate), bug: n(b.min_out_bug) },
    fill_tokens: { fact: n(b.fill_fact), aggregate: n(b.fill_aggregate), bug: n(b.fill_bug) },
    ...(Object.keys(reasons).length > 0 ? { unfit_reasons: reasons } : {}),
    grid: JSON.parse(String(b.grid)) as Array<GridEntry | GridSkip>,
    structured_output: { off: a.json_off === true, on: a.json_on === true, array40: a.array40 === true, ...(typeof a.json_error === "string" ? { error: a.json_error } : {}) },
    main: { slots: n(c.main_slots), slot_ctx: n(c.main_slot_ctx) },
    scouting_candidates: JSON.parse(String(c.scout_candidates)) as ScoutCandidate[],
    ...(typeof c.scouting_unfit_reason === "string" ? { scouting_unfit_reason: c.scouting_unfit_reason } : {}),
    speed: { prefill_tps: Math.min(n(a.prefill_tps_2k), n(a.prefill_tps_8k)), decode_tps: n(a.decode_tps), aggregate_tps: n(c.aggregate_tps), load_avg: n(c.load_avg) },
  };
}

/** Records whose problem was already logged by this process (spec section 3: "logged once"). */
const loggedBad = new Set<string>();

/**
 * The record, or null when it is absent, does not parse, fails the schema,
 * or belongs to another model or engine (counts as missing; spec section 3).
 * An unreadable or invalid record is reported once per process through `log`.
 */
export function readRecord(dir: string, engine: BrokerEngine, model: string, log: (msg: string) => void = () => undefined): CalibrationRecord | null {
  const p = recordPath(dir, engine, model);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !loggedBad.has(p)) {
      loggedBad.add(p);
      log(`calibration record ${p} is unreadable (${(err as Error).message}); it counts as missing`);
    }
    return null;
  }
  const errors = recordSchemaErrors(raw);
  const r = raw as CalibrationRecord;
  if (errors.length === 0 && (r.engine !== engine || r.model !== model)) errors.push(`it is the record of ${r.engine} '${r.model}'`);
  if (errors.length > 0) {
    if (!loggedBad.has(p)) {
      loggedBad.add(p);
      log(`calibration record ${p} is invalid (${errors.join("; ")}); it counts as missing`);
    }
    return null;
  }
  return r;
}

/**
 * Write a record atomically (temp file in the same directory, then rename),
 * mode 0600. A record that fails the schema is a bug in the writer: it throws
 * and nothing is written (spec section 7).
 */
export function writeRecord(dir: string, record: CalibrationRecord): void {
  const errors = recordSchemaErrors(record);
  if (errors.length > 0) throw new Error(`refusing to write an invalid calibration record for '${record.model}': ${errors.join("; ")}`);
  const p = recordPath(dir, record.engine, record.model);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  // Review m4: flushed to disk before the rename, so a power loss never leaves an empty record in place.
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

export type RecordStatus = { state: "ok" } | { state: "failed"; message: string } | { state: "missing" };

/**
 * Coordinator decision 2026-10-29, rule 2: a memory-limited record (calibration only waited for free memory) fails
 * the model's jobs at once for this long after it was written; the first request after that calibrates it again.
 */
export const MEMORY_LIMITED_RETRY_MS = 3_600_000;

/**
 * Coordinator decision 2026-10-29, rule 1: why a "too big for this machine's memory" record no longer holds (the total
 * RAM or the memory floor it was judged against changed), or null while it does. Like Phase C's over-total-RAM skip,
 * which a different floor re-checks. The trained context it stores changes only with the weights; a weights change is
 * caught by the runner's fingerprint once the model is queued, never at read time (nothing is loaded here).
 *
 * Review m3: the floor is read from the environment of the reading process (LLM_EXT_BROKER_MEMORY_FLOOR, default 10)
 * on purpose: the environment is the only place the floor is configured (broker/scheduler.ts TIMING_ENV; there is no
 * settings field), and the broker gates memory with that same value. Every process of one config dir agrees when they
 * share it: a runner the broker starts inherits the broker's environment (runner.ts ensureCalibrator). A shell with
 * another value (models calibrate, calibration-status) can judge differently; the disagreement converges once a
 * broker-started runner measures the model again under the broker's floor (spec 4.3, rule 1).
 */
export function memoryVerdictStale(r: Pick<CalibrationRecord, "status" | "memory_judged">, floorPct = timingsFromEnv(process.env).memoryFloorPct, totalRam = totalmem()): string | null {
  const j = r.memory_judged;
  if (r.status !== "calibration-failed" || j === undefined) return null;
  if (j.total_ram_bytes !== totalRam) return `the total RAM changed from ${j.total_ram_bytes} to ${totalRam} bytes`;
  if (j.floor_pct !== floorPct) return `the memory floor changed from ${j.floor_pct} % to ${floorPct} %`;
  return null;
}

/** The record's verdict for the broker: ok, failed (with the message the job fails with), or missing (the job is held). */
export function readRecordStatus(dir: string, engine: BrokerEngine, model: string, log?: (msg: string) => void, nowMs = Date.now()): RecordStatus {
  const r = readRecord(dir, engine, model, log);
  if (r === null) return { state: "missing" };
  // Review M5: a record of another harness or fixture version describes another method: the model is calibrated again.
  if (r.harness_version !== HARNESS_VERSION || r.fixture_version !== FIXTURE_VERSION) return { state: "missing" };
  // D4 (main-agent decision 2026-10-29): only the production harness makes a model usable; a reduced-harness
  // record (custom:<sha256>) counts as missing, compared by id and version, never by deep-equal.
  if (r.harness !== PRODUCTION_HARNESS_ID) return { state: "missing" };
  if (r.status === "ok") return { state: "ok" };
  if (r.status === "memory-limited") {
    // Rule 2: a busy machine gives no verdict. Its jobs fail at once for an hour; the first request after that holds and
    // re-queues the model (missing), and the runner calibrates it again with fresh pass counters.
    const retryAt = Date.parse(r.calibrated_at) + MEMORY_LIMITED_RETRY_MS;
    if (nowMs >= retryAt) return { state: "missing" };
    return {
      state: "failed",
      message: `model '${model}': not enough free memory to calibrate it (${r.failed_step ?? "?"}: ${r.message ?? ""}); free memory, or run llm-ext models calibrate --model ${model} (it is calibrated again on the first request after ${new Date(retryAt).toISOString()})`,
    };
  }
  // Rule 1: a "too big for this machine's memory" verdict is re-checked when what it was judged against changed.
  if (memoryVerdictStale(r) !== null) return { state: "missing" };
  const step = r.failed_step !== null ? ` at ${r.failed_step}` : "";
  const why = r.message !== undefined ? `: ${r.message}` : "";
  return { state: "failed", message: `model '${model}' ${r.status}${step}${why} (llm-ext models calibration-status; llm-ext models calibrate --model ${model} --force)` };
}
