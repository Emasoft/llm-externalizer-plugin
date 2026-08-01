import { describe, it, expect } from "vitest";
import {
  resolveEnsembleModelLimits,
  KNOWN_MODEL_LIMITS,
  DEFAULT_MODEL_LIMITS,
  MIN_PLAUSIBLE_MAX_OUTPUT,
  type ModelLimits,
} from "./ensemble-limits";

const KNOWN: Record<string, ModelLimits> = {
  "vendor/known": { maxOutput: 30_000, maxInputLines: 20_000 },
};
const FALLBACK: ModelLimits = { maxOutput: 32_000, maxInputLines: 30_000 };

describe("resolveEnsembleModelLimits — maxOutput is a calibrated CEILING (catalog can only lower)", () => {
  it("CLAMPS a high catalog maxOutput down to the calibrated table value", () => {
    // Catalog 65_535 must NOT raise the budget above the table's 30_000 — a
    // reasoning model would fill the extra budget with billed thinking tokens
    // (TRDD-ec45c66f). The catalog can only LOWER, never raise.
    const r = resolveEnsembleModelLimits("vendor/known", 65_535, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(30_000);
  });

  it("HONORS a catalog maxOutput below the calibrated value (provider tightened its cap)", () => {
    const r = resolveEnsembleModelLimits("vendor/known", 8_000, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(8_000); // min(8_000, 30_000)
  });

  it("falls back to the table maxOutput when the catalog value is absent (cold cache)", () => {
    const r = resolveEnsembleModelLimits("vendor/known", undefined, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(30_000); // table value
  });

  it("falls back to the default maxOutput for a model in neither catalog nor table", () => {
    const r = resolveEnsembleModelLimits("vendor/unknown", undefined, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(FALLBACK.maxOutput);
  });

  it("CLAMPS a high catalog to the default ceiling for a model absent from the table", () => {
    // The A3 regression: deepseek/gpt-nano/gemini-flash-lite aren't in the table,
    // so a 65K catalog used to DOUBLE their 32K default cap. Now clamped to 32K.
    const r = resolveEnsembleModelLimits("vendor/unknown", 65_535, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(FALLBACK.maxOutput); // 32_000, not 65_535
  });

  it("honors a catalog below the default ceiling for an off-table model", () => {
    const r = resolveEnsembleModelLimits("vendor/unknown", 16_000, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(16_000); // min(16_000, 32_000)
  });

  it("floors a fractional catalog value (still below the ceiling)", () => {
    const r = resolveEnsembleModelLimits("vendor/unknown", 8192.9, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(8192);
  });
});

describe("resolveEnsembleModelLimits — implausible catalog values are rejected", () => {
  it("rejects a catalog value below the floor and uses the table value", () => {
    const r = resolveEnsembleModelLimits("vendor/known", MIN_PLAUSIBLE_MAX_OUTPUT - 1, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(30_000);
  });

  it("accepts a catalog value exactly at the floor", () => {
    const r = resolveEnsembleModelLimits("vendor/unknown", MIN_PLAUSIBLE_MAX_OUTPUT, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(MIN_PLAUSIBLE_MAX_OUTPUT);
  });

  it("rejects zero and uses the fallback", () => {
    const r = resolveEnsembleModelLimits("vendor/unknown", 0, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(FALLBACK.maxOutput);
  });

  it("rejects a negative catalog value", () => {
    const r = resolveEnsembleModelLimits("vendor/known", -5, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(30_000);
  });

  it("rejects NaN", () => {
    const r = resolveEnsembleModelLimits("vendor/known", Number.NaN, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(30_000);
  });

  it("rejects Infinity", () => {
    const r = resolveEnsembleModelLimits("vendor/known", Number.POSITIVE_INFINITY, KNOWN, FALLBACK);
    expect(r.maxOutput).toBe(30_000);
  });
});

describe("resolveEnsembleModelLimits — maxInputLines is NEVER catalog-derived", () => {
  it("takes maxInputLines from the table regardless of the catalog maxOutput", () => {
    const r = resolveEnsembleModelLimits("vendor/known", 999_999, KNOWN, FALLBACK);
    expect(r.maxInputLines).toBe(20_000); // table value, untouched by the live maxOutput
  });

  it("falls back to the default maxInputLines for an unknown model", () => {
    const r = resolveEnsembleModelLimits("vendor/unknown", 65_535, KNOWN, FALLBACK);
    expect(r.maxInputLines).toBe(FALLBACK.maxInputLines);
  });
});

describe("resolveEnsembleModelLimits — defaults wire to the real shipped tables", () => {
  it("uses the shipped KNOWN_MODEL_LIMITS when no table is injected", () => {
    const r = resolveEnsembleModelLimits("google/gemini-2.5-flash", undefined);
    expect(r).toEqual(KNOWN_MODEL_LIMITS["google/gemini-2.5-flash"]);
  });

  it("uses the shipped DEFAULT_MODEL_LIMITS for an unknown id with a cold cache", () => {
    const r = resolveEnsembleModelLimits("brand/new-model", undefined);
    expect(r).toEqual(DEFAULT_MODEL_LIMITS);
  });

  it("grok keeps its calibrated 20K input-line cap AND clamps a huge live output cap to its 30K ceiling", () => {
    const r = resolveEnsembleModelLimits("x-ai/grok-4.1-fast", 200_000);
    expect(r.maxInputLines).toBe(20_000);
    // Catalog 200K is clamped to grok's calibrated 30K maxOutput (was 200K pre-fix).
    expect(r.maxOutput).toBe(KNOWN_MODEL_LIMITS["x-ai/grok-4.1-fast"].maxOutput);
  });
});
