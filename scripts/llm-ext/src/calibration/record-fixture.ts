/**
 * calibration/record-fixture.ts — complete, schema-valid calibration records
 * for tests (P6). A test that needs a managed model served writes a real
 * record through writeRecord; there is no switch that bypasses the hold
 * (design/specs/local-calibration-design.md section 2).
 */

import type { BrokerEngine } from "../broker/protocol.js";
import { FIXTURE_VERSION, HARNESS_VERSION, type CalibrationRecord } from "./record.js";

/** A complete `status: ok` record with plausible values, or a calibration-failed one when `failed` is given. */
export function recordFixture(engine: BrokerEngine, model: string, failed?: { step: string; message: string }): CalibrationRecord {
  const base = {
    schema: 1 as const,
    harness_version: HARNESS_VERSION,
    fixture_version: FIXTURE_VERSION,
    engine,
    model,
    fingerprint: { blobs: ["0".repeat(64)], ram_bytes: 1 },
    engine_version: "test",
    engine_version_checked: "test",
    calibrated_at: new Date(0).toISOString(),
    duration_s: 0,
  };
  if (failed) return { ...base, status: "calibration-failed", failed_step: failed.step, message: failed.message };
  return {
    ...base,
    status: "ok",
    failed_step: null,
    window_tokens: 4096,
    free_ram_bytes: 1,
    chars_per_token: 4,
    capabilities: { thinking: false, n_ctx_train: 4096 },
    thinking_works: { off: true, on: false },
    min_output_tokens: { fact: 256, aggregate: 256, bug: 256 },
    fill_tokens: { fact: 2048, aggregate: 2048, bug: 2048 },
    grid: [],
    structured_output: { off: false, on: false, array40: false },
    main: { slots: 2, slot_ctx: 1024 },
    scouting: "unfit",
    speed: { prefill_tps: 1, decode_tps: 1, aggregate_decode_tps: 1, load_avg: 0 },
  };
}
