// Free-only switch — Phase 1 (TRDD-8b6b3646). Pure, offline, free.
// Covers: resolveProfile derives the ensemble from free_models; validateProfile
// enforces the zero-spend invariants (all ':free', non-empty, remote, ≥2 for
// ensemble); selectFreeEnsembleModels applies the context-floor requirements
// pre-filter. Importing ./index is safe — the entry-point guard (TRDD-e82f2c49)
// stops it booting the server.

import { describe, it, expect } from "vitest";
import { resolveProfile, validateProfile, type Profile } from "./config";
import { selectFreeEnsembleModels, FREE_FLOOR_MIN_CONTEXT_TOKENS } from "./index";

const FREE = [
  "poolside/laguna-m.1:free",
  "deepseek/deepseek-v4-flash:free",
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-coder:free",
];

function freeProfile(over: Partial<Profile> = {}): Profile {
  return {
    mode: "remote-ensemble",
    api: "openrouter-remote",
    model: "deepseek/deepseek-v4-pro", // premium — must be IGNORED under free_only
    free_only: true,
    free_models: FREE,
    // Direct key value (not a "$VAR" ref) so validation is env-independent — the
    // suite runs with OPENROUTER_API_KEY unset, and the point under test is the
    // free_only rules, not key resolution.
    api_key: "test-key-direct-value",
    ...over,
  };
}

describe("resolveProfile — free_only derives the ensemble from free_models", () => {
  it("uses free_models[0..2] as model/secondModel/thirdModel, ignoring the premium model", () => {
    const r = resolveProfile("free", freeProfile());
    expect(r.freeOnly).toBe(true);
    expect(r.model).toBe(FREE[0]);
    expect(r.secondModel).toBe(FREE[1]);
    expect(r.thirdModel).toBe(FREE[2]);
    expect(r.model).not.toBe("deepseek/deepseek-v4-pro");
    expect(r.freeModels).toEqual(FREE); // full pool carried for the fallback rotation (Phase 3)
  });

  it("a non-free profile has freeOnly=false and an empty freeModels", () => {
    const r = resolveProfile("p", {
      mode: "remote",
      api: "openrouter-remote",
      model: "deepseek/deepseek-v4-pro",
      api_key: "$OPENROUTER_API_KEY",
    });
    expect(r.freeOnly).toBe(false);
    expect(r.freeModels).toEqual([]);
    expect(r.model).toBe("deepseek/deepseek-v4-pro");
  });
});

describe("validateProfile — free_only zero-spend invariants", () => {
  it("accepts a well-formed free_only ensemble profile", () => {
    expect(validateProfile("free", freeProfile()).valid).toBe(true);
  });

  it("accepts free_only WITHOUT a model field (free_models supplies it)", () => {
    const p = { ...freeProfile() } as Partial<Profile>;
    delete p.model;
    expect(validateProfile("free", p as Profile).valid).toBe(true);
  });

  it("REJECTS a non-':free' entry in free_models (would bill)", () => {
    const r = validateProfile("free", freeProfile({ free_models: [...FREE, "openai/gpt-5.4-nano"] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/gpt-5\.4-nano/);
    expect(r.errors.join("\n")).toMatch(/:free/);
  });

  it("REJECTS an empty free_models list", () => {
    const r = validateProfile("free", freeProfile({ free_models: [] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/non-empty 'free_models'/);
  });

  it("REJECTS free_only on a local preset (':free' is OpenRouter-only)", () => {
    const r = validateProfile("free", freeProfile({ mode: "local", api: "lmstudio-local", url: undefined }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/remote \(OpenRouter\)/);
  });

  it("REJECTS free_only + remote-ensemble with only ONE free model", () => {
    const r = validateProfile("free", freeProfile({ free_models: ["qwen/qwen3-coder:free"] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/at least 2 free_models/);
  });

  it("accepts free_only + mode 'remote' (single free model, no ensemble)", () => {
    const r = validateProfile("free", freeProfile({ mode: "remote", free_models: ["qwen/qwen3-coder:free"] }));
    expect(r.valid).toBe(true);
  });

  it("does NOT crash on a malformed (non-list) free_models, reports a clear error", () => {
    // YAML scalar instead of a list — the runtime value is a string. Must be
    // reported, not throw (and must not spread into single characters).
    const bad = { ...freeProfile(), free_models: "qwen/qwen3-coder:free" as unknown as string[] };
    const r = validateProfile("free", bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/free_models must be a YAML list/);
  });

  it("resolveProfile coerces a malformed free_models to [] (no char-spread, no throw)", () => {
    const bad = { ...freeProfile(), free_models: "qwen/qwen3-coder:free" as unknown as string[] };
    const r = resolveProfile("free", bad);
    expect(r.freeModels).toEqual([]); // NOT ['q','w','e','n', ...]
    expect(r.model).toBe(""); // no free_models[0] to derive from
  });
});

describe("selectFreeEnsembleModels — context-floor requirements pre-filter", () => {
  const big = FREE_FLOOR_MIN_CONTEXT_TOKENS + 1;
  const tiny = FREE_FLOOR_MIN_CONTEXT_TOKENS - 1;

  it("drops free models the catalog reports below the context floor, keeps order, takes top 3", () => {
    const cat = new Map([
      ["a:free", { id: "a:free", name: "a", context_length: big }],
      ["b:free", { id: "b:free", name: "b", context_length: tiny }], // dropped
      ["c:free", { id: "c:free", name: "c", context_length: big }],
      ["d:free", { id: "d:free", name: "d", context_length: big }],
      ["e:free", { id: "e:free", name: "e", context_length: big }],
    ]);
    // b dropped → [a, c, d, e] → top 3 = [a, c, d]
    expect(selectFreeEnsembleModels(["a:free", "b:free", "c:free", "d:free", "e:free"], cat)).toEqual([
      "a:free",
      "c:free",
      "d:free",
    ]);
  });

  it("keeps a model that is ABSENT from the catalog (lenient on availability)", () => {
    const cat = new Map([["a:free", { id: "a:free", name: "a", context_length: big }]]);
    expect(selectFreeEnsembleModels(["a:free", "unknown:free"], cat)).toEqual(["a:free", "unknown:free"]);
  });

  it("a cold (empty) catalog degrades to the raw top-3, never empty", () => {
    expect(selectFreeEnsembleModels(["a:free", "b:free", "c:free", "d:free"], new Map())).toEqual([
      "a:free",
      "b:free",
      "c:free",
    ]);
  });
});
