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
import { dirname, join } from "node:path";
import type { BrokerEngine } from "../broker/protocol.js";

/**
 * Bumped when the calibration method changes, and whenever PRODUCTION_HARNESS
 * (runner.ts) changes: every record and progress entry of an older harness is
 * invalid (spec section 3).
 */
export const HARNESS_VERSION = 1;
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

export interface GridEntry {
  kind: TaskKind;
  /** "main" for fact and aggregate; bug runs two counters, "bug" and "control" (spec 4.3). */
  counter: "main" | "bug" | "control";
  tokens: number;
  trials: number;
  passed: number;
  inconclusive: number;
}

export interface Fingerprint {
  /** sha256 of every weight file's content (the Hugging Face blob name), sorted. */
  blobs: string[];
  ram_bytes: number;
}

export type RecordStatusValue = "ok" | "engine-check-failed" | "calibration-failed";

/** Spec section 7. A calibration-failed record carries the identity, status, failed_step and message only. */
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
  grid?: GridEntry[];
  structured_output?: { off: boolean; on: boolean; array40: boolean; error?: string };
  main?: { slots: number; slot_ctx: number };
  scouting?: { share_tokens: number; slots: number; slot_ctx: number; accuracy: number; records_per_s: number; permutation_seed: number } | "unfit";
  speed?: { prefill_tps: number; decode_tps: number; aggregate_decode_tps: number; load_avg: number };
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
  need(raw.status === "ok" || raw.status === "engine-check-failed" || raw.status === "calibration-failed", "status");
  need(raw.failed_step === null || isStr(raw.failed_step), "failed_step");
  need(raw.message === undefined || isStr(raw.message), "message");
  need(isStr(raw.calibrated_at) && isNonNeg(raw.duration_s), "calibrated_at, duration_s");
  if (raw.status === "calibration-failed") {
    need(isStr(raw.failed_step) && isStr(raw.message), "a calibration-failed record names failed_step and message");
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
  need(
    Array.isArray(raw.grid) &&
      raw.grid.every(
        (g: unknown) =>
          isObj(g) && TASK_KINDS.includes(g.kind as TaskKind) && (g.counter === "main" || g.counter === "bug" || g.counter === "control") && [g.tokens, g.trials, g.passed, g.inconclusive].every(isNonNeg),
      ),
    "grid",
  );
  const so = raw.structured_output;
  need(isObj(so) && isBool(so.off) && isBool(so.on) && isBool(so.array40) && (so.error === undefined || isStr(so.error)), "structured_output");
  const main = raw.main;
  need(isObj(main) && isNum(main.slots) && main.slots >= 1 && isNum(main.slot_ctx) && main.slot_ctx >= 256, "main");
  const sc = raw.scouting;
  need(sc === "unfit" || (isObj(sc) && ["share_tokens", "slots", "slot_ctx", "accuracy", "records_per_s", "permutation_seed"].every((k) => isNonNeg(sc[k]))), "scouting");
  const sp = raw.speed;
  need(isObj(sp) && ["prefill_tps", "decode_tps", "aggregate_decode_tps", "load_avg"].every((k) => isNonNeg(sp[k])), "speed");
  return e;
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

/** The record's verdict for the broker: ok, failed (with the message the job fails with), or missing (the job is held). */
export function readRecordStatus(dir: string, engine: BrokerEngine, model: string, log?: (msg: string) => void): RecordStatus {
  const r = readRecord(dir, engine, model, log);
  if (r === null) return { state: "missing" };
  // Review M5: a record of another harness or fixture version describes another method: the model is calibrated again.
  if (r.harness_version !== HARNESS_VERSION || r.fixture_version !== FIXTURE_VERSION) return { state: "missing" };
  // D4 (main-agent decision 2026-10-29): only the production harness makes a model usable; a reduced-harness
  // record (custom:<sha256>) counts as missing, compared by id and version, never by deep-equal.
  if (r.harness !== PRODUCTION_HARNESS_ID) return { state: "missing" };
  if (r.status === "ok") return { state: "ok" };
  const step = r.failed_step !== null ? ` at ${r.failed_step}` : "";
  const why = r.message !== undefined ? `: ${r.message}` : "";
  return { state: "failed", message: `model '${model}' ${r.status}${step}${why} (llm-ext models calibration-status; llm-ext models calibrate --model ${model} --force)` };
}
