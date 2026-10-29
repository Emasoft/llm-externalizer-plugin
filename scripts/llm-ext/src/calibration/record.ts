/**
 * calibration/record.ts — where a model's calibration record lives and
 * whether it makes the model usable (P6, TRDD-1OOAH3LD, TRDD-ZGSGGHQG;
 * design/specs/local-calibration-design.md sections 3 and 7).
 *
 * The broker reads this before it queues a job for a managed local model:
 * only a record with `status: ok` makes the model usable; with none, the job
 * is held until one exists (user ruling "No, wait", spec section 2).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrokerEngine } from "../broker/protocol.js";

/** `<slug>`: the model id made filename-safe, plus 8 hex digits of its sha256, so two ids that sanitize alike never share a record. */
export function recordSlug(model: string): string {
  const safe = model.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return `${safe}-${createHash("sha256").update(model).digest("hex").slice(0, 8)}`;
}

/** `<config dir>/calibration/<engine>/<slug>.json`. */
export function recordPath(dir: string, engine: BrokerEngine, model: string): string {
  return join(dir, "calibration", engine, `${recordSlug(model)}.json`);
}

export type RecordStatus = { state: "ok" } | { state: "failed"; message: string } | { state: "missing" };

/**
 * The record's verdict for the broker. A record that is absent, does not
 * parse, or carries an unknown status counts as missing (spec section 3), so
 * the job waits for a calibration that writes a good one.
 */
export function readRecordStatus(dir: string, engine: BrokerEngine, model: string): RecordStatus {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(recordPath(dir, engine, model), "utf8"));
  } catch {
    return { state: "missing" };
  }
  const r = raw as { status?: unknown; failed_step?: unknown; message?: unknown };
  if (r?.status === "ok") return { state: "ok" };
  if (r?.status === "calibration-failed" || r?.status === "engine-check-failed") {
    const step = typeof r.failed_step === "string" ? ` at ${r.failed_step}` : "";
    const why = typeof r.message === "string" ? `: ${r.message}` : "";
    return { state: "failed", message: `model '${model}' ${String(r.status)}${step}${why} (llm-ext models calibration-status; llm-ext models calibrate --model ${model} --force)` };
  }
  return { state: "missing" };
}
