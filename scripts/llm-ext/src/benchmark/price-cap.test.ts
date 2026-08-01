// Phase 1 (TRDD-8b6b3646): the global $1.25/1M benchmark price cap. A model
// priced over the cap on EITHER input or output is never benchmarked —
// discovered candidates are dropped silently, explicit ids fail the whole run
// fast ($0 spent). Verifies the pure helpers; the phase wiring is asserted at
// tsc/integration level.
import { describe, it, expect } from "vitest";
import {
  MAX_BENCHMARK_PRICE_PER_M,
  overBenchmarkPriceCap,
  assertModelsUnderPriceCap,
  filterModels,
  DEFAULT_CRITERIA,
  type OpenRouterModel,
} from "./discover.js";

const priced = (input: number, output: number) => ({
  id: `m-${input}-${output}`,
  inputDollarsPerMillion: input,
  outputDollarsPerMillion: output,
});

describe("benchmark price cap — overBenchmarkPriceCap", () => {
  it("the cap is $1.25/1M", () => {
    expect(MAX_BENCHMARK_PRICE_PER_M).toBe(1.25);
  });

  it("a model at or under the cap on BOTH axes is allowed", () => {
    expect(overBenchmarkPriceCap(priced(0, 0))).toBe(false); // free
    expect(overBenchmarkPriceCap(priced(1.25, 1.25))).toBe(false); // exactly the cap is allowed (≤)
    expect(overBenchmarkPriceCap(priced(0.14, 0.28))).toBe(false); // mimo-v2.5
    expect(overBenchmarkPriceCap(priced(0.435, 0.87))).toBe(false); // mimo-v2.5-pro
  });

  it("over the cap on EITHER axis is rejected", () => {
    expect(overBenchmarkPriceCap(priced(1.26, 0.5))).toBe(true); // input over
    expect(overBenchmarkPriceCap(priced(0.5, 1.26))).toBe(true); // output over
    expect(overBenchmarkPriceCap(priced(3, 6))).toBe(true); // both over
  });

  it("a non-finite (unknown/unpriced) price is treated as OVER the cap — never benchmark what we cannot bound", () => {
    expect(overBenchmarkPriceCap(priced(Infinity, 0))).toBe(true);
    expect(overBenchmarkPriceCap(priced(0, Infinity))).toBe(true);
    expect(overBenchmarkPriceCap(priced(NaN, 0.5))).toBe(true);
  });
});

describe("benchmark price cap — assertModelsUnderPriceCap (explicit fail-fast)", () => {
  it("is a no-op when every model is within the cap", () => {
    expect(() =>
      assertModelsUnderPriceCap([priced(0.14, 0.28), priced(1.25, 1.0)]),
    ).not.toThrow();
  });

  it("throws naming the offender(s) and their prices, and states $0 was spent", () => {
    let msg = "";
    try {
      assertModelsUnderPriceCap([priced(0.1, 0.1), priced(2.0, 3.0)]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("price cap");
    expect(msg).toContain("m-2-3"); // the over-cap id
    expect(msg).toContain("$0 spent");
    expect(msg).not.toContain("m-0.1-0.1"); // the under-cap id is not named
  });
});

describe("benchmark price cap — filterModels drops over-cap DISCOVERED candidates", () => {
  const model = (
    id: string,
    promptPerToken: number,
    completionPerToken: number,
  ): OpenRouterModel =>
    ({
      id,
      name: id,
      context_length: 200_000,
      top_provider: { max_completion_tokens: 100_000 },
      pricing: { prompt: String(promptPerToken), completion: String(completionPerToken) },
      supported_parameters: ["structured_outputs", "reasoning"],
    }) as unknown as OpenRouterModel;

  it("keeps an under-cap discovered model and drops an over-cap one", () => {
    // Criteria with a HIGH cost ceiling so qualify() itself does not reject the
    // pricey model — proving the global cap is what removes it.
    const looseCriteria = {
      ...DEFAULT_CRITERIA,
      maxInputDollarsPerMillion: 100,
      maxOutputDollarsPerMillion: 100,
    };
    // $/token → $/M: 0.0000005 * 1e6 = $0.5/M (under); 0.000002 * 1e6 = $2/M (over).
    const cheap = model("cheap/model", 0.0000005, 0.0000005);
    const pricey = model("pricey/model", 0.000002, 0.000002);
    const kept = filterModels([cheap, pricey], looseCriteria).map((m) => m.id);
    expect(kept).toContain("cheap/model");
    expect(kept).not.toContain("pricey/model");
  });
});
