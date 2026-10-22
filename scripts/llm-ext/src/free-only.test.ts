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
import { memoryRotationStore } from "./free-rotation";
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
      const r = resolveProfile("my-free-only", freeProfile());
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
      expect(validateProfile("my-free-only", freeProfile()).valid).toBe(true);
  });

  it("accepts free_only WITHOUT a model field (free_models supplies it)", () => {
    const p = { ...freeProfile() } as Partial<Profile>;
    delete p.model;
    expect(validateProfile("my-free-only", p as Profile).valid).toBe(true);
  });

  it("REJECTS a non-':free' entry in free_models (would bill)", () => {
      const r = validateProfile("my-free-only", freeProfile({ free_models: [...FREE, "openai/gpt-5.4-nano"] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/gpt-5\.4-nano/);
    expect(r.errors.join("\n")).toMatch(/:free/);
  });

  it("REJECTS an empty free_models list", () => {
      const r = validateProfile("my-free-only", freeProfile({ free_models: [] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/non-empty 'free_models'/);
  });

  it("REJECTS free_only on a local preset (':free' is OpenRouter-only)", () => {
      const r = validateProfile("my-free-only", freeProfile({ mode: "local", api: "lmstudio-local", url: undefined }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/remote \(OpenRouter\)/);
  });

  it("REJECTS free_only + remote-ensemble with only ONE free model", () => {
      const r = validateProfile("my-free-only", freeProfile({ free_models: ["qwen/qwen3-coder:free"] }));
    expect(r.valid).toBe(false);
    // D5: reserved slots count toward the 2-member minimum, so the sentence
    // names "ensemble members", not "free_models".
    expect(r.errors.join("\n")).toMatch(/at least 2 ensemble members/);
  });

  it("accepts free_only + mode 'remote' (single free model, no ensemble)", () => {
      const r = validateProfile("my-free-only", freeProfile({ mode: "remote", free_models: ["qwen/qwen3-coder:free"] }));
    expect(r.valid).toBe(true);
  });

  it("does NOT crash on a malformed (non-list) free_models, reports a clear error", () => {
    // YAML scalar instead of a list — the runtime value is a string. Must be
    // reported, not throw (and must not spread into single characters).
    const bad = { ...freeProfile(), free_models: "qwen/qwen3-coder:free" as unknown as string[] };
    const r = validateProfile("my-free-only", bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/free_models must be a YAML list/);
  });

  it("resolveProfile coerces a malformed free_models to [] (no char-spread, no throw)", () => {
    const bad = { ...freeProfile(), free_models: "qwen/qwen3-coder:free" as unknown as string[] };
    const r = resolveProfile("my-free-only", bad);
    expect(r.freeModels).toEqual([]); // NOT ['q','w','e','n', ...]
    expect(r.model).toBe(""); // no free_models[0] to derive from
  });

  // A DYNAMIC free_only profile ("free") keeps tool_models populated after
  // resolve (unlike a STATIC one, which is blanked to {}) — see the
  // resolveModelForTool describe block below. So the free_models pool being
  // clean is not enough: a paid model id sitting in tool_models would still
  // reach resolveModelForTool unblocked unless validateProfile also gates it.
  it("REJECTS a non-':free' model in tool_models on the dynamic 'free' profile (would bill)", () => {
    const r = validateProfile(
      "free",
      freeProfile({ tool_models: { code_task: "openai/gpt-5.4-nano" } as Record<string, string> }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/tool_models/);
    expect(r.errors.join("\n")).toMatch(/gpt-5\.4-nano/);
  });

  it("ACCEPTS a ':free' model in tool_models on the dynamic 'free' profile, and resolveModelForTool honours it", () => {
    const p = freeProfile({ tool_models: { code_task: "qwen/qwen3-coder:free" } as Record<string, string> });
    expect(validateProfile("free", p).valid).toBe(true);
    const r = resolveProfile("free", p);
    expect(resolveModelForTool(r, "code_task")).toBe("qwen/qwen3-coder:free");
  });

  it("ACCEPTS a non-':free' tool_models id served by a non-billable 'providers[]' route (b.ai)", () => {
    const r = validateProfile(
      "free",
      freeProfile({
        tool_models: { code_task: "glm-5.3-flash" } as Record<string, string>,
        // Direct key value, same reasoning as freeProfile()'s own api_key: the
        // binding's own auth requirement is unrelated to this test (the point
        // under test is the tool_models cost gate), so it must not depend on
        // $BAI_API_KEY being set in the environment.
        providers: [{ api: "chat-b-ai-remote", models: ["glm-5.3-flash"], api_key: "test-key-direct-value" }],
      }),
    );
    expect(r.valid).toBe(true);
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
  // Every rotation test injects a RAM-only cooldown registry. The production
  // default is the PERSISTENT one, and a unit test must neither write to the
  // developer's real ~/.llm-externalizer nor leak a cooldown into the next test
  // (a model cooled by one case would be skipped by the next, silently).
  const rot = () => ({ store: memoryRotationStore() });

  it("returns the primary result when it succeeds — no fallback claimed", async () => {
    let claims = 0;
    const callOne = async (model: string) => sr(model, "primary ok", "stop");
    const r = await callEnsembleSlotWithRotation(
      slot("p0:free"),
      [slot("fb0:free")],
      () => claims++,
      callOne,
      rot(),
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
      rot(),
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
      rot(),
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
      rot(),
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
      rot(),
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
      rot(),
    );
    expect(r.error).toBe(true);
    expect(r.model).toBe("fb0:free"); // rotated once, then the pool ran out
    expect(r.content).toMatch(/All 2 approved free model\(s\) are unavailable/);
  });

  it("a SHARED claimFallback stops two parallel slots grabbing the same fallback", async () => {
    let next = 0;
    const claim = () => next++; // shared atomic counter across both slots
    // ONE registry shared by both slots — exactly how ensembleStreaming wires it.
    const shared = rot();
    const callOne = async (model: string) =>
      model === "p0:free" || model === "p1:free"
        ? sr(model, "429 too many requests", "error")
        : sr(model, "ok", "stop");
    const [a, b] = await Promise.all([
      callEnsembleSlotWithRotation(slot("p0:free"), [slot("fb0:free"), slot("fb1:free")], claim, callOne, shared),
      callEnsembleSlotWithRotation(slot("p1:free"), [slot("fb0:free"), slot("fb1:free")], claim, callOne, shared),
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
  // Param 2 is now `billable: boolean`, not a backend-type string. The old
  // signature conflated "which request format" with "can this charge me", which
  // is what let a remote openai_api preset (type "local") bypass the guard.
  it("THROWS on a non-':free' model under free_only + a BILLABLE endpoint", () => {
    expect(() => assertFreeOnlyModel(true, true, "deepseek/deepseek-v4-pro")).toThrow(/cost-safety/);
    expect(() => assertFreeOnlyModel(true, true, "openai/gpt-5.4-nano")).toThrow(/non-free model/);
  });

  it("ALLOWS a ':free' model under free_only", () => {
    expect(() => assertFreeOnlyModel(true, true, "qwen/qwen3-coder:free")).not.toThrow();
    expect(() => assertFreeOnlyModel(true, true, "nvidia/nemotron-3-super-120b-a12b:free")).not.toThrow();
  });

  it("is a NO-OP when free_only is off (paid model allowed on a paid profile)", () => {
    expect(() => assertFreeOnlyModel(false, true, "deepseek/deepseek-v4-pro")).not.toThrow();
  });

  it("is a NO-OP for a NON-billable endpoint (a local server is $0)", () => {
    expect(() => assertFreeOnlyModel(true, false, "qwen3:14b")).not.toThrow();
  });

  it("ALLOWS any id from a free-by-nature provider (b.ai has no ':free' suffix)", () => {
    // The 4th arg is the provider's free claim. Without it this id would be
    // refused for lacking a suffix that its provider does not use.
    expect(() => assertFreeOnlyModel(true, false, "glm-5.3-flash", true)).not.toThrow();
  });

  it("lets the free-provider claim OVERRIDE billable — so the claim must be voided upstream", () => {
    // Precedence, stated as a test because it is load-bearing: isFreeProvider
    // short-circuits BEFORE the billable check. A wrong `true` here is therefore
    // a spend bypass, which is exactly why overridesEndpoint() voids the claim at
    // resolve time when a url: redirects the host or scheme. Once a claim reaches
    // this guard it wins — the enforcement point is the resolver, not here.
    expect(() => assertFreeOnlyModel(true, true, "openai/gpt-4o", true)).not.toThrow();
  });
});

describe("resolveModelForTool — static free_only profile overrides every per-tool choice (TRDD-97ef8b63)", () => {
  it("ignores tool_models AND the caller fallback — the top free model wins", () => {
    const r = resolveProfile(
      "my-free-only",
      freeProfile({ tool_models: { security_scan: "openai/gpt-5.4-nano" } as Record<string, string> }),
    );
    // Even a PAID tool_models override AND a PAID caller fallback are overridden:
    expect(resolveModelForTool(r, "security_scan", "deepseek/deepseek-v4-pro")).toBe(FREE[0]);
    expect(resolveModelForTool(r, "chat")).toBe(FREE[0]);
  });

  it("clears resolved toolModels under free_only (no active per-tool overrides)", () => {
    const r = resolveProfile(
      "my-free-only",
      freeProfile({ tool_models: { security_scan: "openai/gpt-5.4-nano" } as Record<string, string> }),
    );
    expect(r.toolModels).toEqual({}); // static free_only: the resolved profile still drops tool_models
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
    // Row 92 fix-queue: the gate now reads options.freeOnly, not the module
    // global — pass it directly instead of set/reset-ing setActiveFreeOnly
    // around the call (no global state to leak into other tests any more).
    // apiKey is deliberately bogus: if the guard FAILED to short-circuit, the
    // real fetch would run and this test would hang/network-error instead of
    // returning a clean cost-safety RunError.
    const out = await runBenchmarkOnModel(paid("openai/gpt-5.4-nano"), ["a", "b", "c"], [], {
      apiKey: "unused-because-guard-skips-before-fetch",
      freeOnly: true,
      timeoutMs: 2000,
    });
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/cost-safety/);
    expect((out as { error: string }).error).toMatch(/gpt-5\.4-nano/);
  });

  it("row 92 fix-queue: a PAID call runs its own gate from options.freeOnly, never the leaked global", async () => {
    // Deliberately leave the global TRUE (as a previous free sweep in the same
    // process would) and pass freeOnly: false explicitly — before the fix this
    // model would have been skipped by getActiveFreeOnly() regardless of what
    // this call actually asked for. Red on HEAD: options.freeOnly did not exist,
    // so the gate read the global above and returned the cost-safety RunError
    // instead of reaching fetchImpl.
    setActiveFreeOnly(true);
    try {
      const body = {
        choices: [{ message: { content: JSON.stringify({ kw1_functions: [], kw2_functions: [], kw3_functions: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      const out = await runBenchmarkOnModel(paid("openai/gpt-5.4-nano"), ["a", "b", "c"], [], {
        apiKey: "unused-fetch-is-stubbed",
        freeOnly: false,
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
      });
      expect(out.ok).toBe(true);
    } finally {
      setActiveFreeOnly(false); // never leak into other tests
    }
  });
});
