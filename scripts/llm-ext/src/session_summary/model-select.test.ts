// Unit tests for model-select.ts — OpenRouter free-model eligibility filter
// for session-summary. Pure function tests only; fetchCatalog (network IO) is
// never exercised here.

import { describe, it, expect } from "vitest";
import {
  selectEligibleModels,
  DEFAULT_MIN_CONTEXT,
  type CatalogModel,
} from "./model-select.js";

// The final modality rule is PERMISSIVE: text must be present on BOTH sides
// of "->"; any OTHER modality on either side is irrelevant. This DOES admit
// the lyria pair (they carry "text" on both sides, even though the rest of
// their modality is music) — see model-select.ts's header for why that is
// intentional, and driver.ts's runtime "no-text" fallback for what actually
// enforces usability.
const NEMOTRON: CatalogModel = {
  id: "nvidia/nemotron-3-ultra-550b-a55b:free",
  context_length: 1_000_000,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "text->text" },
  top_provider: { max_completion_tokens: 65_536 },
};

const LYRIA_PRO: CatalogModel = {
  id: "google/lyria-3-pro-preview:free",
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

// text present on both sides, plus extra modalities — must be ELIGIBLE.
const MULTIMODAL_TEXT_BOTH_SIDES: CatalogModel = {
  id: "google/gemma-4-31b-it:free",
  context_length: 262_144,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "text+image+video->text" },
  top_provider: { max_completion_tokens: 8_192 },
};

// No text on the INPUT side — must be INELIGIBLE.
const NO_TEXT_INPUT: CatalogModel = {
  id: "vendor/image-only-in:free",
  context_length: 262_144,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "image->text" },
  top_provider: { max_completion_tokens: 8_192 },
};

// No text on the OUTPUT side — must be INELIGIBLE.
const NO_TEXT_OUTPUT: CatalogModel = {
  id: "vendor/audio-only-out:free",
  context_length: 262_144,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "text->audio" },
  top_provider: { max_completion_tokens: 8_192 },
};

// "textual" must NOT match "text" via substring — proves membership-split,
// not a raw String.includes() check.
const SUBSTRING_TRAP: CatalogModel = {
  id: "vendor/textual-trap:free",
  context_length: 262_144,
  pricing: { prompt: "0", completion: "0" },
  architecture: { modality: "textual->text" },
  top_provider: { max_completion_tokens: 8_192 },
};

const CATALOG: CatalogModel[] = [NEMOTRON, LYRIA_PRO, PAID_BIG_CONTEXT, FREE_SMALL_CONTEXT];

describe("selectEligibleModels", () => {
  it("with no minContext, returns every eligible free model, biggest context first (no implicit floor)", () => {
    const result = selectEligibleModels(CATALOG);
    // LYRIA_PRO (1,048,576) sorts ahead of NEMOTRON (1,000,000) — text is
    // present on both sides of its modality, so it IS eligible even though
    // it's a music model; that's the permissive-by-design rule.
    expect(result.map((m) => m.id)).toEqual([
      "google/lyria-3-pro-preview:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "google/gemma-4-26b:free",
    ]);
  });

  it("the default (no floor) still returns the biggest model even when the biggest free text model is below 1,000,000 context", () => {
    // Nothing at or above 1M in this catalog — the old default floor would
    // have thrown here. The new default must return the smaller model
    // anyway, first, instead of refusing.
    const result = selectEligibleModels([FREE_SMALL_CONTEXT]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("google/gemma-4-26b:free");
    expect(result[0].contextLength).toBe(262_144);
  });

  it("admits a model with text on both sides plus extra modalities (image, video) on the input side", () => {
    const result = selectEligibleModels([MULTIMODAL_TEXT_BOTH_SIDES]);
    expect(result.map((m) => m.id)).toEqual(["google/gemma-4-31b-it:free"]);
  });

  it("admits text+image->text+audio (lyria-shaped) — text present on both sides is the whole rule, extra modalities are irrelevant", () => {
    const result = selectEligibleModels([LYRIA_PRO]);
    expect(result.map((m) => m.id)).toEqual(["google/lyria-3-pro-preview:free"]);
  });

  it("rejects a model with no text on the INPUT side", () => {
    expect(() => selectEligibleModels([NO_TEXT_INPUT])).toThrow(/no free text-capable model/);
  });

  it("rejects a model with no text on the OUTPUT side", () => {
    expect(() => selectEligibleModels([NO_TEXT_OUTPUT])).toThrow(/no free text-capable model/);
  });

  it("rejects 'textual->text' — proves membership-split on '+', not a raw substring match against 'text'", () => {
    expect(() => selectEligibleModels([SUBSTRING_TRAP])).toThrow(/no free text-capable model/);
  });

  it("rejects a missing or malformed architecture.modality as ineligible, never assuming text", () => {
    const missingModality: CatalogModel = {
      id: "vendor/no-modality:free",
      context_length: 500_000,
      pricing: { prompt: "0", completion: "0" },
    };
    const garbledModality: CatalogModel = {
      id: "vendor/garbled-modality:free",
      context_length: 500_000,
      pricing: { prompt: "0", completion: "0" },
      architecture: { modality: "not-a-real-modality-string" },
    };
    expect(() => selectEligibleModels([missingModality])).toThrow();
    expect(() => selectEligibleModels([garbledModality])).toThrow();
  });

  it("throws fail-fast (never falls back to paid) when only a paid model is in the catalog", () => {
    expect(() => selectEligibleModels([PAID_BIG_CONTEXT])).toThrow(/no free text-capable model/);
  });

  it("an explicit minContext excludes a free model below it and names the biggest available in the error", () => {
    expect(() => selectEligibleModels([FREE_SMALL_CONTEXT], { minContext: 1_000_000 })).toThrow(
      /no free text-capable model with context_length >= 1000000/,
    );
    expect(() => selectEligibleModels([FREE_SMALL_CONTEXT], { minContext: 1_000_000 })).toThrow(
      /google\/gemma-4-26b:free/,
    );
  });

  it("DEFAULT_MIN_CONTEXT is documented as 1,000,000 but is NOT applied unless passed explicitly", () => {
    expect(DEFAULT_MIN_CONTEXT).toBe(1_000_000);
    // Passing it explicitly restores the old hard-floor behavior.
    const result = selectEligibleModels(CATALOG, { minContext: DEFAULT_MIN_CONTEXT });
    expect(result.every((m) => m.contextLength >= 1_000_000)).toBe(true);
    expect(result.map((m) => m.id)).toEqual(["google/lyria-3-pro-preview:free", "nvidia/nemotron-3-ultra-550b-a55b:free"]);
  });

  it("an explicit minContext, when met, still returns every model at or above it (not just the top one)", () => {
    const result = selectEligibleModels(CATALOG, { minContext: 200_000 });
    const ids = result.map((m) => m.id).sort();
    expect(ids).toEqual(
      ["google/gemma-4-26b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/lyria-3-pro-preview:free"].sort(),
    );
  });

  it("orders eligible models by context_length descending", () => {
    const bigger: CatalogModel = { ...NEMOTRON, id: "vendor/bigger:free", context_length: 2_000_000 };
    const result = selectEligibleModels([NEMOTRON, bigger]);
    expect(result.map((m) => m.id)).toEqual(["vendor/bigger:free", "nvidia/nemotron-3-ultra-550b-a55b:free"]);
  });

  it("breaks a context_length tie by the larger max_completion_tokens, then by model id ascending", () => {
    const sameContextHigherCompletion: CatalogModel = {
      ...NEMOTRON,
      id: "vendor/zzz-same-context:free",
      top_provider: { max_completion_tokens: 100_000 },
    };
    const sameContextSameCompletionLaterId: CatalogModel = {
      ...NEMOTRON,
      id: "vendor/zzz-tiebreak:free",
    };
    const result = selectEligibleModels([
      NEMOTRON, // 1M ctx, 65_536 completion, id "nvidia/..."
      sameContextHigherCompletion, // 1M ctx, 100_000 completion — wins on completion tiebreak
      sameContextSameCompletionLaterId, // 1M ctx, 65_536 completion, id sorts after "nvidia/..."
    ]);
    expect(result.map((m) => m.id)).toEqual([
      "vendor/zzz-same-context:free", // highest max_completion_tokens first
      "nvidia/nemotron-3-ultra-550b-a55b:free", // same completion as the third, but lower id
      "vendor/zzz-tiebreak:free",
    ]);
  });

  it("returns a no-eligible-models-at-all error message that names the applied filters", () => {
    try {
      selectEligibleModels([]);
      throw new Error("expected selectEligibleModels to throw on an empty catalog");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/pricing\.prompt == 0/);
      expect(msg).toMatch(/modality/);
    }
  });

  it("treats a missing pricing block as non-free (excluded, not a crash)", () => {
    const noPricing: CatalogModel = { id: "vendor/mystery", context_length: 2_000_000, architecture: { modality: "text->text" } };
    expect(() => selectEligibleModels([noPricing])).toThrow();
  });

  it("treats a missing context_length as 0 but still returns it when there is no minContext floor", () => {
    const noContext: CatalogModel = { id: "vendor/mystery:free", pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->text" } };
    const result = selectEligibleModels([noContext]);
    expect(result).toHaveLength(1);
    expect(result[0].contextLength).toBe(0);
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
    const result = selectEligibleModels([...CATALOG, PAID_BIG_CONTEXT]);
    expect(result.some((m) => m.id === "anthropic/claude-sonnet-5")).toBe(false);
  });
});
