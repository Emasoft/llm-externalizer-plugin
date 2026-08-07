// Unit tests for model-select.ts — OpenRouter free-model eligibility filter
// for session-summary. Pure function tests only; fetchCatalog (network IO) is
// never exercised here.

import { describe, it, expect } from "vitest";
import {
  selectEligibleModels,
  DEFAULT_MIN_CONTEXT,
  LOWER_CONTEXT_FLOOR,
  type CatalogModel,
} from "./model-select.js";

// The exact real-world shape from the TRDD's verified facts (2026-08-06 live
// catalog snapshot): one genuine free text->text model at 1M ctx, and two
// free music models that are numerically 1M+ but text+image->text+audio.
const NEMOTRON: CatalogModel = {
  id: "nvidia/nemotron-3-ultra-550b-a55b:free",
  context_length: 1_000_000,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "text->text" },
  top_provider: { max_completion_tokens: 65_536 },
};

const LYRIA_PRO: CatalogModel = {
  id: "google/lyria-3-pro-preview",
  context_length: 1_048_576,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "text+image->text+audio" },
  top_provider: { max_completion_tokens: 8_192 },
};

const LYRIA_CLIP: CatalogModel = {
  id: "google/lyria-3-clip-preview",
  context_length: 1_048_576,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "text+image->text+audio" },
  top_provider: { max_completion_tokens: 8_192 },
};

const PAID_BIG_CONTEXT: CatalogModel = {
  id: "anthropic/claude-sonnet-5",
  context_length: 1_000_000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  architecture: { modality: "text->text" },
  top_provider: { max_completion_tokens: 64_000 },
};

const FREE_SMALL_CONTEXT: CatalogModel = {
  id: "google/gemma-4-26b:free",
  context_length: 262_144,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "text->text" },
  top_provider: { max_completion_tokens: 8_192 },
};

const CATALOG: CatalogModel[] = [NEMOTRON, LYRIA_PRO, LYRIA_CLIP, PAID_BIG_CONTEXT, FREE_SMALL_CONTEXT];

describe("selectEligibleModels", () => {
  it("selects exactly the one free text->text 1M-context model from the TRDD's verified catalog shape", () => {
    const result = selectEligibleModels(CATALOG);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      contextLength: 1_000_000,
      maxCompletionTokens: 65_536,
    });
  });

  it("excludes free non-text models even when price and context both qualify (the load-bearing modality filter)", () => {
    // Isolate the effect: a catalog of ONLY the two lyria ids, which pass
    // price and context but must fail on modality alone.
    expect(() => selectEligibleModels([LYRIA_PRO, LYRIA_CLIP])).toThrow();

    // Mixed in with a genuine text->text model, the lyria ids are silently
    // dropped rather than surfacing as false positives.
    const withLyriaAndNemotron = selectEligibleModels([LYRIA_PRO, LYRIA_CLIP, NEMOTRON]);
    expect(withLyriaAndNemotron.map((m) => m.id)).toEqual(["nvidia/nemotron-3-ultra-550b-a55b:free"]);
    expect(withLyriaAndNemotron.some((m) => m.id.startsWith("google/lyria"))).toBe(false);
  });

  it("throws fail-fast (never falls back to paid) when only a paid model qualifies on context", () => {
    expect(() => selectEligibleModels([PAID_BIG_CONTEXT])).toThrow(/no free text->text model/);
  });

  it("excludes a free text->text model below minContext", () => {
    expect(() => selectEligibleModels([FREE_SMALL_CONTEXT])).toThrow();
  });

  it("defaults minContext to DEFAULT_MIN_CONTEXT (1,000,000)", () => {
    expect(DEFAULT_MIN_CONTEXT).toBe(1_000_000);
    const result = selectEligibleModels(CATALOG);
    expect(result.every((m) => m.contextLength >= 1_000_000)).toBe(true);
  });

  it("allowLowerContext drops the floor to LOWER_CONTEXT_FLOOR (262,144), admitting the smaller free model too", () => {
    expect(LOWER_CONTEXT_FLOOR).toBe(262_144);
    const result = selectEligibleModels(CATALOG, { allowLowerContext: true });
    const ids = result.map((m) => m.id).sort();
    expect(ids).toEqual(["google/gemma-4-26b:free", "nvidia/nemotron-3-ultra-550b-a55b:free"].sort());
  });

  it("an explicit minContext overrides allowLowerContext", () => {
    const result = selectEligibleModels(CATALOG, { allowLowerContext: true, minContext: 1_000_000 });
    expect(result.map((m) => m.id)).toEqual(["nvidia/nemotron-3-ultra-550b-a55b:free"]);
  });

  it("orders eligible models by context_length descending", () => {
    const bigger: CatalogModel = { ...NEMOTRON, id: "vendor/bigger:free", context_length: 2_000_000 };
    const result = selectEligibleModels([NEMOTRON, bigger]);
    expect(result.map((m) => m.id)).toEqual(["vendor/bigger:free", "nvidia/nemotron-3-ultra-550b-a55b:free"]);
  });

  it("returns an empty-list-only error message that names the applied filters and suggests allowLowerContext", () => {
    try {
      selectEligibleModels([]);
      throw new Error("expected selectEligibleModels to throw on an empty catalog");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/pricing\.prompt == 0/);
      expect(msg).toMatch(/context_length >=/);
      expect(msg).toMatch(/modality/);
      expect(msg).toMatch(/262144|262,144/);
    }
  });

  it("treats a missing pricing block as non-free (excluded, not a crash)", () => {
    const noPricing: CatalogModel = { id: "vendor/mystery", context_length: 2_000_000, architecture: { modality: "text->text" } };
    expect(() => selectEligibleModels([noPricing])).toThrow();
  });

  it("treats a missing context_length as 0 (excluded, not a crash)", () => {
    const noContext: CatalogModel = { id: "vendor/mystery:free", pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->text" } };
    expect(() => selectEligibleModels([noContext])).toThrow();
  });

  it("defaults maxCompletionTokens to 0 when top_provider is absent", () => {
    const noTopProvider: CatalogModel = {
      id: "vendor/mystery:free",
      context_length: 2_000_000,
      pricing: { prompt: "0", completion: "0" },
      architecture: { modality: "text->text" },
    };
    const result = selectEligibleModels([noTopProvider]);
    expect(result[0].maxCompletionTokens).toBe(0);
  });

  it("cost-safety: a $0-priced model that lacks the ':free' suffix is rejected via the shared assertFreeOnlyModel gate, never returned", () => {
    // Reuse of the project's existing free-only enforcement (config.ts,
    // TRDD-97ef8b63) is proven by observing its exact throw message, not
    // just "it throws" — a bespoke check here could pass while the real
    // gate is bypassed elsewhere.
    const malformed: CatalogModel = {
      id: "vendor/free-priced-but-not-suffixed",
      context_length: 2_000_000,
      pricing: { prompt: "0", completion: "0" },
      architecture: { modality: "text->text" },
    };
    expect(() => selectEligibleModels([malformed])).toThrow(/free_only cost-safety/);
  });

  it("never selects a paid model regardless of the caller's active profile (this tool forces freeOnly=true internally)", () => {
    // PAID_BIG_CONTEXT is excluded purely on price (":free" absent AND
    // price != 0) before the cost-safety gate is even reached; assert the
    // whole pipeline end-to-end never returns it, independent of whatever
    // getActiveFreeOnly() would report for the real process.
    const result = selectEligibleModels([...CATALOG, PAID_BIG_CONTEXT], { allowLowerContext: true });
    expect(result.some((m) => m.id === "anthropic/claude-sonnet-5")).toBe(false);
  });
});
