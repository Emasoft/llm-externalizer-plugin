// Free-only switch — Phase 1 (TRDD-8b6b3646). Pure, offline, free.
// Covers: resolveProfile derives the ensemble from free_models; validateProfile
// enforces the zero-spend invariants (all ':free', non-empty, remote, ≥2 for
// ensemble); selectFreeEnsembleModels applies the context-floor requirements
// pre-filter. Importing ./index is safe — the entry-point guard (TRDD-e82f2c49)
// stops it booting the server.

import { describe, it, expect } from "vitest";
import {
  resolveProfile,
  validateProfile,
  resolveModelForTool,
  assertFreeOnlyModel,
  setActiveFreeOnly,
  getActiveFreeOnly,
  type Profile,
} from "./config";
import {
  selectFreeEnsembleModels,
  filterFreeModels,
  isModelUnavailableError,
  callEnsembleSlotWithRotation,
  FREE_FLOOR_MIN_CONTEXT_TOKENS,
} from "./index";
import { runBenchmarkOnModel } from "./benchmark/runner";
import type { QualifiedModel } from "./benchmark/discover";
import { failedModelsFromCache } from "./benchmark/security-triage/index";

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

  it("Phase 2: drops a benchmark-FAILED free model even if it clears the context floor", () => {
    const cat = new Map([
      ["a:free", { id: "a:free", name: "a", context_length: big }],
      ["b:free", { id: "b:free", name: "b", context_length: big }], // benchmark-failed
      ["c:free", { id: "c:free", name: "c", context_length: big }],
      ["d:free", { id: "d:free", name: "d", context_length: big }],
    ]);
    const failed = new Set(["b:free"]);
    expect(selectFreeEnsembleModels(["a:free", "b:free", "c:free", "d:free"], cat, failed)).toEqual([
      "a:free",
      "c:free",
      "d:free",
    ]);
  });
});

describe("failedModelsFromCache — proven-failing extraction (Phase 2)", () => {
  it("flags a model whose latest entry is a CONCLUSIVE non-pass", () => {
    const cache = {
      "x/m:free::2026-05-20::h1": { date: "2026-05-20", score: { pass: false, inconclusive: false } },
    };
    expect(failedModelsFromCache(cache).has("x/m:free")).toBe(true);
  });

  it("does NOT flag a passing model", () => {
    const cache = {
      "x/m:free::2026-05-20::h1": { date: "2026-05-20", score: { pass: true, inconclusive: false } },
    };
    expect(failedModelsFromCache(cache).has("x/m:free")).toBe(false);
  });

  it("does NOT flag an INCONCLUSIVE run (flaky/empty is not a failure)", () => {
    const cache = {
      "x/m:free::2026-05-20::h1": { date: "2026-05-20", score: { pass: false, inconclusive: true } },
    };
    expect(failedModelsFromCache(cache).has("x/m:free")).toBe(false);
  });

  it("latest-wins: a newer PASS overrides an older FAIL", () => {
    const cache = {
      "x/m:free::2026-05-10::h1": { date: "2026-05-10", score: { pass: false, inconclusive: false } },
      "x/m:free::2026-05-25::h2": { date: "2026-05-25", score: { pass: true, inconclusive: false } },
    };
    expect(failedModelsFromCache(cache).has("x/m:free")).toBe(false);
  });

  it("an empty cache flags nothing", () => {
    expect(failedModelsFromCache({}).size).toBe(0);
  });
});

// ── Phase 3 — rate-limit / daily-limit fallback rotation (TRDD-8b6b3646) ──────
// Free providers ALL cap requests per-day, so a slot whose model is daily-limited
// must rotate to the next unused free model rather than fail. All pure + offline.

describe("filterFreeModels — full filtered list feeds the fallback pool (Phase 3)", () => {
  const big = FREE_FLOOR_MIN_CONTEXT_TOKENS + 1;
  it("returns ALL passing free models (unsliced) so models 4+ can serve as fallbacks", () => {
    const cat = new Map([
      ["a:free", { id: "a:free", name: "a", context_length: big }],
      ["b:free", { id: "b:free", name: "b", context_length: big }],
      ["c:free", { id: "c:free", name: "c", context_length: big }],
      ["d:free", { id: "d:free", name: "d", context_length: big }],
      ["e:free", { id: "e:free", name: "e", context_length: big }],
    ]);
    // selectFreeEnsembleModels would slice to 3; filterFreeModels keeps all 5.
    const all = filterFreeModels(["a:free", "b:free", "c:free", "d:free", "e:free"], cat);
    expect(all).toEqual(["a:free", "b:free", "c:free", "d:free", "e:free"]);
    expect(selectFreeEnsembleModels(["a:free", "b:free", "c:free", "d:free", "e:free"], cat)).toEqual([
      "a:free",
      "b:free",
      "c:free",
    ]);
  });
});

describe("isModelUnavailableError — rotate ONLY on availability/quota errors", () => {
  it("matches a generic 429 / rate-limit", () => {
    expect(isModelUnavailableError("HTTP 429: Too Many Requests")).toBe(true);
    expect(isModelUnavailableError("rate limit reached")).toBe(true);
    expect(isModelUnavailableError("rate-limit hit")).toBe(true);
  });

  it("matches free-provider DAILY-limit phrasings (the Phase 3 raison d'être)", () => {
    expect(isModelUnavailableError("Rate limit exceeded: free-models-per-day")).toBe(true);
    expect(isModelUnavailableError("You have hit your daily limit")).toBe(true);
    expect(isModelUnavailableError("per-day quota exhausted")).toBe(true);
    expect(isModelUnavailableError("daily quota reached")).toBe(true);
  });

  it("matches provider-side unavailability (no endpoints, 404, 503, overloaded)", () => {
    expect(isModelUnavailableError("No endpoints found for this model")).toBe(true);
    expect(isModelUnavailableError("404 model not found")).toBe(true);
    expect(isModelUnavailableError("503 Service Unavailable")).toBe(true);
    expect(isModelUnavailableError("Provider is overloaded")).toBe(true);
  });

  it("does NOT match request-level errors that rotating would not fix", () => {
    // Auth, malformed request, content-length — a different model would fail too.
    expect(isModelUnavailableError("401 Unauthorized: invalid api key")).toBe(false);
    expect(isModelUnavailableError("malformed JSON in request body")).toBe(false);
    expect(isModelUnavailableError("authentication failed")).toBe(false);
    expect(isModelUnavailableError("")).toBe(false);
  });
});

describe("callEnsembleSlotWithRotation — free-model fallback rotation (Phase 3)", () => {
  // Minimal StreamingResult-shaped builder (usage is optional on StreamingResult).
  const sr = (model: string, content: string, finishReason: "stop" | "error") => ({
    model,
    content,
    finishReason,
    truncated: false,
  });
  const slot = (id: string) => ({ id, maxOutput: 1000 });

  it("returns the primary result when it succeeds — no fallback claimed", async () => {
    let claims = 0;
    const callOne = async (model: string) => sr(model, "primary ok", "stop");
    const r = await callEnsembleSlotWithRotation(
      slot("p0:free"),
      [slot("fb0:free")],
      () => claims++,
      callOne,
    );
    expect(r.error).toBe(false);
    expect(r.model).toBe("p0:free");
    expect(r.content).toBe("primary ok");
    expect(claims).toBe(0); // never rotated
  });

  it("rotates to a fallback when the primary hits a DAILY limit", async () => {
    let next = 0;
    const callOne = async (model: string) =>
      model === "p0:free"
        ? sr(model, "Rate limit exceeded: free-models-per-day", "error")
        : sr(model, "fallback ok", "stop");
    const r = await callEnsembleSlotWithRotation(
      slot("p0:free"),
      [slot("fb0:free")],
      () => next++,
      callOne,
    );
    expect(r.error).toBe(false);
    expect(r.model).toBe("fb0:free");
  });

  it("rotates through MULTIPLE fallbacks until one succeeds", async () => {
    let next = 0;
    const callOne = async (model: string) =>
      model === "fb1:free" ? sr(model, "ok", "stop") : sr(model, "503 overloaded", "error");
    const r = await callEnsembleSlotWithRotation(
      slot("p0:free"),
      [slot("fb0:free"), slot("fb1:free")],
      () => next++,
      callOne,
    );
    expect(r.error).toBe(false);
    expect(r.model).toBe("fb1:free");
  });

  it("rotates when callOne THROWS a rate-limit error (not just an error result)", async () => {
    let next = 0;
    const callOne = async (model: string) => {
      if (model === "p0:free") throw new Error("HTTP 429: too many requests");
      return sr(model, "ok", "stop");
    };
    const r = await callEnsembleSlotWithRotation(
      slot("p0:free"),
      [slot("fb0:free")],
      () => next++,
      callOne,
    );
    expect(r.error).toBe(false);
    expect(r.model).toBe("fb0:free");
  });

  it("does NOT rotate on a non-availability error — returns it immediately", async () => {
    let claims = 0;
    const callOne = async (model: string) => sr(model, "invalid api key", "error");
    const r = await callEnsembleSlotWithRotation(
      slot("p0:free"),
      [slot("fb0:free")],
      () => claims++,
      callOne,
    );
    expect(r.error).toBe(true);
    expect(r.model).toBe("p0:free"); // never rotated
    expect(claims).toBe(0);
  });

  it("returns an error result when the WHOLE free pool is exhausted (bounded, no infinite loop)", async () => {
    let next = 0;
    const callOne = async (model: string) => sr(model, "429 rate limit", "error");
    const r = await callEnsembleSlotWithRotation(
      slot("p0:free"),
      [slot("fb0:free")],
      () => next++,
      callOne,
    );
    expect(r.error).toBe(true);
    expect(r.model).toBe("fb0:free"); // rotated once, then the pool ran out
  });

  it("a SHARED claimFallback stops two parallel slots grabbing the same fallback", async () => {
    let next = 0;
    const claim = () => next++; // shared atomic counter across both slots
    const callOne = async (model: string) =>
      model === "p0:free" || model === "p1:free"
        ? sr(model, "429 too many requests", "error")
        : sr(model, "ok", "stop");
    const [a, b] = await Promise.all([
      callEnsembleSlotWithRotation(slot("p0:free"), [slot("fb0:free"), slot("fb1:free")], claim, callOne),
      callEnsembleSlotWithRotation(slot("p1:free"), [slot("fb0:free"), slot("fb1:free")], claim, callOne),
    ]);
    // Each slot landed on a DISTINCT fallback — no double-spend of one model's quota.
    expect(new Set([a.model, b.model])).toEqual(new Set(["fb0:free", "fb1:free"]));
    expect(a.error).toBe(false);
    expect(b.error).toBe(false);
  });
});

// ── Airtight free_only enforcement — overrides EVERY tool (TRDD-97ef8b63) ─────
// The chokepoint guard + resolveModelForTool override together guarantee a paid
// model is unreachable under free_only. All pure + offline.

describe("assertFreeOnlyModel — airtight chokepoint guard (TRDD-97ef8b63)", () => {
  it("THROWS on a non-':free' model under free_only + openrouter (cost-safety)", () => {
    expect(() => assertFreeOnlyModel(true, "openrouter", "deepseek/deepseek-v4-pro")).toThrow(/cost-safety/);
    expect(() => assertFreeOnlyModel(true, "openrouter", "openai/gpt-5.4-nano")).toThrow(/non-free model/);
  });

  it("ALLOWS a ':free' model under free_only", () => {
    expect(() => assertFreeOnlyModel(true, "openrouter", "qwen/qwen3-coder:free")).not.toThrow();
    expect(() => assertFreeOnlyModel(true, "openrouter", "nvidia/nemotron-3-super-120b-a12b:free")).not.toThrow();
  });

  it("is a NO-OP when free_only is off (paid model allowed on a paid profile)", () => {
    expect(() => assertFreeOnlyModel(false, "openrouter", "deepseek/deepseek-v4-pro")).not.toThrow();
  });

  it("is a NO-OP for local backends (':free' is OpenRouter-only; local is $0)", () => {
    expect(() => assertFreeOnlyModel(true, "local", "qwen3:14b")).not.toThrow();
  });
});

describe("resolveModelForTool — free_only overrides every per-tool choice (TRDD-97ef8b63)", () => {
  it("ignores tool_models AND the caller fallback — the top free model wins", () => {
    const r = resolveProfile(
      "free",
      freeProfile({ tool_models: { security_scan: "openai/gpt-5.4-nano" } as Record<string, string> }),
    );
    // Even a PAID tool_models override AND a PAID caller fallback are overridden:
    expect(resolveModelForTool(r, "security_scan", "deepseek/deepseek-v4-pro")).toBe(FREE[0]);
    expect(resolveModelForTool(r, "chat")).toBe(FREE[0]);
  });

  it("clears resolved toolModels under free_only (no active per-tool overrides)", () => {
    const r = resolveProfile(
      "free",
      freeProfile({ tool_models: { security_scan: "openai/gpt-5.4-nano" } as Record<string, string> }),
    );
    expect(r.toolModels).toEqual({}); // the file keeps tool_models; the RESOLVED profile drops them
  });

  it("a NON-free profile still honours tool_models + fallback (behaviour unchanged)", () => {
    const r = resolveProfile("p", {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      model: "main/model",
      second_model: "second/model",
      api_key: "test-key-direct-value",
      tool_models: { security_scan: "tuned/model" },
    } as Profile);
    expect(resolveModelForTool(r, "security_scan")).toBe("tuned/model"); // override honoured
    expect(resolveModelForTool(r, "chat", "fb/model")).toBe("fb/model"); // fallback honoured
    expect(resolveModelForTool(r, "chat")).toBe("main/model"); // falls to main model
  });
});

describe("setActiveFreeOnly / getActiveFreeOnly — process free-only flag (TRDD-97ef8b63)", () => {
  it("round-trips so the pure subsystem spend sites can read the live state", () => {
    const orig = getActiveFreeOnly();
    try {
      setActiveFreeOnly(true);
      expect(getActiveFreeOnly()).toBe(true);
      setActiveFreeOnly(false);
      expect(getActiveFreeOnly()).toBe(false);
    } finally {
      setActiveFreeOnly(orig); // never leak the flag into other tests
    }
  });
});

describe("benchmark runner — free_only enforcement at the real spend site (TRDD-97ef8b63)", () => {
  // Minimal QualifiedModel — the guard only reads `.id`, returning a RunError
  // BEFORE any fetch, so the rest of the shape can be a stub.
  const paid = (id: string) =>
    ({
      id,
      name: id,
      contextTokens: 1,
      maxOutputTokens: 1,
      inputDollarsPerMillion: 1,
      outputDollarsPerMillion: 1,
      supportsStructured: true,
      supportsReasoning: false,
      raw: {},
    }) as unknown as QualifiedModel;

  it("SKIPS a non-':free' model under free_only — RunError, never reaches the network", async () => {
    setActiveFreeOnly(true);
    try {
      // apiKey is deliberately bogus: if the guard FAILED to short-circuit, the
      // real fetch would run and this test would hang/network-error instead of
      // returning a clean cost-safety RunError.
      const out = await runBenchmarkOnModel(paid("openai/gpt-5.4-nano"), ["a", "b", "c"], [], {
        apiKey: "unused-because-guard-skips-before-fetch",
        timeoutMs: 2000,
      });
      expect(out.ok).toBe(false);
      expect((out as { error: string }).error).toMatch(/cost-safety/);
      expect((out as { error: string }).error).toMatch(/gpt-5\.4-nano/);
    } finally {
      setActiveFreeOnly(false); // reset global so later tests are unaffected
    }
  });
});
