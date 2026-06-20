// Unit tests for request-overrides.ts (B1 Phase 1 extraction, TRDD-63314265).
// Pure function — no I/O, no LLM, no network.

import { describe, it, expect } from "vitest";
import { applyModelOverrides } from "./request-overrides.js";

describe("applyModelOverrides", () => {
  it("returns the body unchanged (same reference) when modelId is undefined", () => {
    const body = { temperature: 0.1 };
    expect(applyModelOverrides(body, undefined)).toBe(body);
  });

  it("returns the body unchanged (same reference) for a model with no override", () => {
    const body = { temperature: 0.1, top_p: 0.5 };
    expect(applyModelOverrides(body, "some/unknown-model")).toBe(body);
  });

  it("applies the Nemotron sampling override (temperature 1.0, top_p 0.95)", () => {
    const out = applyModelOverrides({ temperature: 0.1 }, "nvidia/nemotron-3-super-120b-a12b:free");
    expect(out.temperature).toBe(1.0);
    expect(out.top_p).toBe(0.95);
  });

  it("returns a COPY (not the original) when an override applies, leaving the input unmutated", () => {
    const body = { temperature: 0.1 };
    const out = applyModelOverrides(body, "nvidia/nemotron-3-super-120b-a12b:free");
    expect(out).not.toBe(body);
    expect(body.temperature).toBe(0.1); // original untouched
  });

  it("preserves unrelated fields while overriding the sampling knobs", () => {
    const out = applyModelOverrides(
      { messages: [{ role: "user", content: "hi" }], stream: false, temperature: 0.1 },
      "nvidia/nemotron-3-super-120b-a12b:free",
    );
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(out.stream).toBe(false);
    expect(out.temperature).toBe(1.0);
  });
});
