/**
 * provider/connection.test.ts — the per-call deadline override.
 *
 * `resolveConnection` is the SINGLE point every request's (url, model, timeout)
 * tuple flows through, so this is where a caller-supplied deadline either takes
 * effect or is silently dropped. A dropped override would be invisible: the run
 * would simply keep using the 300s global and nobody would see a wrong number,
 * only a slow run. Hence a behavioural assertion, not a code reading.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveConnection } from "./connection.js";
import type { ProviderDeps } from "./types.js";
import { withUsageContext } from "../usage-history.js";
import {
  setValidationBypassForTests,
  setBenchmarkValidationExempt,
} from "../benchmark/validated.js";

const GLOBAL_SOFT_TIMEOUT = 300_000;

function deps(): ProviderDeps {
  return {
    getBackend: () => ({
      type: "openrouter" as const,
      baseUrl: "https://openrouter.ai/api",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    }),
    apiHeaders: () => ({ authorization: "Bearer test" }),
    getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
    isFreeOnly: () => false,
    // Single-provider fixture: no model is routed elsewhere, so every request
    // uses the primary backend — the pre-multi-provider behaviour.
    //
    // NOTE the `as unknown as ProviderDeps` cast below: it is why adding these
    // two deps did NOT fail tsc, and why these tests instead died at runtime
    // with "deps.routeForModel is not a function". A cast silences the one check
    // that would have caught an incomplete fake.
    routeForModel: () => null,
    routeHeaders: () => ({ authorization: "Bearer route" }),
    getActiveProtocol: () => "openai_api",
  } as unknown as ProviderDeps;
}

describe("resolveConnection — per-call deadline", () => {
  it("uses the global soft timeout when the caller supplies none", async () => {
    const conn = await resolveConnection({ model: "m:free" }, deps());
    expect(conn.timeout).toBe(GLOBAL_SOFT_TIMEOUT);
  });

  it("honors a caller-supplied timeoutMs, so session_summary's tighter per-chunk deadline reaches the wire", async () => {
    const conn = await resolveConnection({ model: "m:free", timeoutMs: 120_000 }, deps());
    expect(conn.timeout).toBe(120_000);
    expect(conn.timeout).toBeLessThan(GLOBAL_SOFT_TIMEOUT); // the whole point: TIGHTER than global
  });

  it("honors an override LARGER than the global too — it is a deadline, not a cap", async () => {
    // The owner's standing rule: an explicit value is honored verbatim; the
    // caller decides how long they are willing to wait.
    const conn = await resolveConnection({ model: "m:free", timeoutMs: 900_000 }, deps());
    expect(conn.timeout).toBe(900_000);
  });
});

// ── multi-provider routing ───────────────────────────────────────────
// The point of the routing seam: one run must be able to send model A to b.ai
// and model B to OpenRouter. Before this, resolveConnection built every URL from
// the single active backend, so a mixed ensemble was impossible however the pool
// was assembled.
const BAI_ROUTE = {
  api: "chat-b-ai-remote",
  protocol: "openai_api" as const,
  url: "https://api.b.ai",
  authToken: "bai-key",
  isFreeProvider: true,
  models: ["glm-5.3-flash"],
};

function routedDeps(): ProviderDeps {
  return {
    getBackend: () => ({
      type: "openrouter" as const,
      billable: true,
      baseUrl: "https://openrouter.ai/api",
      apiKey: "openrouter-key",
      model: "deepseek/deepseek-v4-flash:free",
    }),
    apiHeaders: () => ({ Authorization: "Bearer openrouter-key" }),
    routeHeaders: (r: typeof BAI_ROUTE) => ({ Authorization: `Bearer ${r.authToken}` }),
    getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
    isFreeOnly: () => true,
    routeForModel: (m: string) => (m === "glm-5.3-flash" ? BAI_ROUTE : null),
    getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    // TRDD-FDI9NYAS D3c: the "unrouted model on the primary backend" case is
    // billable + auto-picked, so the NEW send-time price check runs — give it
    // a recorded, well-under-ceiling price (this suite's subject is routing,
    // not pricing).
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.5 }),
    getEnsemblePriceCeilingUsd: () => 1.3,
  } as unknown as ProviderDeps;
}

describe("resolveConnection — per-model provider routing", () => {
  it("sends a routed model to ITS provider's URL, not the primary's", async () => {
    const conn = await resolveConnection({ model: "glm-5.3-flash" }, routedDeps());
    expect(conn.url).toBe("https://api.b.ai/v1/chat/completions");
  });

  it("sends a routed model with ITS provider's key, never the primary's", async () => {
    // The failure this prevents is not just a 401 — it leaks one vendor's
    // credential to another.
    const conn = await resolveConnection({ model: "glm-5.3-flash" }, routedDeps());
    expect(conn.headers["Authorization"]).toBe("Bearer bai-key");
    expect(JSON.stringify(conn.headers)).not.toContain("openrouter-key");
  });

  it("leaves an UNROUTED model on the primary backend", async () => {
    const conn = await resolveConnection(
      { model: "deepseek/deepseek-v4-flash:free" },
      routedDeps(),
    );
    expect(conn.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(conn.headers["Authorization"]).toBe("Bearer openrouter-key");
  });

  it("admits a suffix-less model under free_only when its ROUTE is a free provider", async () => {
    // free_only is true and `glm-5.3-flash` has no ':free' suffix. It is allowed
    // solely because the route it resolves to is marked free-by-nature — the
    // whole reason b.ai can participate in a free profile.
    await expect(
      resolveConnection({ model: "glm-5.3-flash" }, routedDeps()),
    ).resolves.toBeDefined();
  });

  it("still REFUSES a suffix-less model that routes nowhere (primary is billable)", async () => {
    await expect(
      resolveConnection({ model: "openai/gpt-4o" }, routedDeps()),
    ).rejects.toThrow(/cost-safety/);
  });
});

// ── remote+local in ONE profile ──────────────────────────────────────
// The profile shape this must not break: some models remote, some on a local
// server. A local route cannot bill, so free_only must not refuse it — the
// model id has no ':free' suffix and never will, because that is an OpenRouter
// naming convention, not a property of ollama.
const OLLAMA_ROUTE = {
  api: "ollama-local",
  protocol: "openai_api" as const,
  url: "http://localhost:11434",
  authToken: "",
  isLocal: true,
  isFreeProvider: false,
  models: ["qwen3:14b"],
};

function mixedDeps(): ProviderDeps {
  return {
    getBackend: () => ({
      type: "openrouter" as const,
      billable: true,
      baseUrl: "https://openrouter.ai/api",
      apiKey: "openrouter-key",
      model: "deepseek/deepseek-v4-flash:free",
    }),
    apiHeaders: () => ({ Authorization: "Bearer openrouter-key" }),
    routeHeaders: () => ({}),
    getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
    isFreeOnly: () => true,
    routeForModel: (m: string) => (m === "qwen3:14b" ? OLLAMA_ROUTE : null),
    getActiveProtocol: () => "openai_api",
  } as unknown as ProviderDeps;
}

// ── item 1 / A1 regression: resolveConnection must pass ROUTE-AWARE
// billability to assertModelValidated, not backend.type ──
// The bug: connection.ts:76 used to read `assertModelValidated(model, toolCtx,
// backend.type)`. A remote openai_api preset (the exact D1 shape — see BAI_ROUTE
// above) resolves `backend.type` to "local", so ANY billable endpoint whose
// primary backend reports type "local" bypassed the IRON RULE gate entirely
// (`backendType !== "openrouter"` short-circuits before the ledger check even
// runs). This is a BEHAVIOURAL bug, not a type error: the OLD signature already
// accepted `backend.type` (a string) with no compile-time complaint — only the
// runtime gate silently no-ops.
describe("resolveConnection — routes real billability to the IRON RULE gate (item 1)", () => {
  it("a billable backend reading type 'local' still triggers the gate", async () => {
    setValidationBypassForTests(false);
    setBenchmarkValidationExempt(false);
    const localButBillableDeps: ProviderDeps = {
      getBackend: () => ({
        // D1 shape: a remote openai_api preset resolves to type "local" while
        // being a real, billable internet endpoint (see BackendConfig.billable
        // doc comment in provider/types.ts).
        type: "local" as const,
        billable: true,
        baseUrl: "https://api.example-remote.test",
        apiKey: "key",
        model: "paid/unvalidated-model",
      }),
      apiHeaders: () => ({}),
      routeHeaders: () => ({}),
      getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
      isFreeOnly: () => false,
      routeForModel: () => null,
      // type: "local" would otherwise probe LM Studio (detectLMStudio) —
      // irrelevant to this test, so stub it false.
      isLMStudioProvider: () => false,
getActiveProtocol: () => "openai_api",
      // Auto-picked in this test (the point is the IRON RULE gate firing).
      isManualModel: () => false,
    } as unknown as ProviderDeps;

    // No ledger written (isolated LLM_EXT_CONFIG_DIR, per the run rules) — an
    // unvalidated paid model must be refused BEFORE the wire.
    await expect(
      withUsageContext({ tool: "code_task", params: "" }, () =>
        resolveConnection({ model: "paid/unvalidated-model" }, localButBillableDeps),
      ),
    ).rejects.toThrow(/IRON RULE/);
  });

  it("a non-billable b.ai route stays exempt from the gate", async () => {
    setValidationBypassForTests(false);
    setBenchmarkValidationExempt(false);
    // routedDeps()'s BAI_ROUTE is `isFreeProvider: true` → billable false —
    // exempt regardless of the primary backend's own type/billable.
    await expect(
      withUsageContext({ tool: "code_task", params: "" }, () =>
        resolveConnection({ model: "glm-5.3-flash" }, routedDeps()),
      ),
    ).resolves.toBeDefined();
  });
});

describe("resolveConnection — a LOCAL route under free_only", () => {
  it("does NOT refuse a suffix-less local model (a local server cannot bill)", async () => {
    // Regression guard: computing billability as `!route.isFreeProvider` alone
    // made this throw a cost-safety error for ollama.
    const conn = await resolveConnection({ model: "qwen3:14b" }, mixedDeps());
    expect(conn.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  // Row 24 (TRDD-OE27RD7I): a NON-primary local route takes the routed path
  // (connection.ts, `route && !route.primary`) BY DESIGN — straight
  // OpenAI-compat on the route's own URL, `isNative: false`, and the
  // native-flavor probe (a question about the PRIMARY local backend, cached
  // per baseUrl) is never asked of the secondary group, so nothing is fetched.
  it("a SECONDARY (non-primary) local route resolves to its own /v1/chat/completions, isNative:false, with no flavor probe", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const secondary = { ...OLLAMA_ROUTE, primary: false };
      const d = { ...mixedDeps(), routeForModel: (m: string) => (m === "qwen3:14b" ? secondary : null) };
      const conn = await resolveConnection({ model: "qwen3:14b" }, d as unknown as ProviderDeps);
      expect(conn.url).toBe(`${secondary.url}/v1/chat/completions`);
      expect(conn.isNative).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still refuses a suffix-less model on the billable primary", async () => {
    await expect(
      resolveConnection({ model: "openai/gpt-4o" }, mixedDeps()),
    ).rejects.toThrow(/cost-safety/);
  });
});

// ── D3b (TRDD-FDI9NYAS): provenance exemption from the IRON RULE gate ──
// A MANUAL model (the user hand-listed it in a STATIC profile) is never
// refused for lacking a benchmark verdict — "all manual, no benchmarks or
// updates" (USER spec 3.1). The SAME model, unvalidated, on a profile where
// `isManualModel` reports false (the shape an AUTO-PICKED id has) is still
// refused — this is what proves the exemption follows provenance, not just
// "any billable model always passes now".
function manualGateDeps(isManual: boolean): ProviderDeps {
  return {
    getBackend: () => ({
      type: "openrouter" as const,
      billable: true,
      baseUrl: "https://openrouter.ai/api",
      apiKey: "openrouter-key",
      model: "paid/hand-listed-model",
    }),
    apiHeaders: () => ({ Authorization: "Bearer openrouter-key" }),
    routeHeaders: () => ({}),
    getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
    isFreeOnly: () => false,
    routeForModel: () => null,
    isLMStudioProvider: () => false,
getActiveProtocol: () => "openai_api",
    isManualModel: (model: string) => isManual && model === "paid/hand-listed-model",
  } as unknown as ProviderDeps;
}

describe("resolveConnection — manual-model provenance exemption (D3b)", () => {
  it("sends a STATIC profile's hand-listed model even with NO benchmark verdict", async () => {
    setValidationBypassForTests(false);
    setBenchmarkValidationExempt(false);
    // No ledger written (isolated LLM_EXT_CONFIG_DIR) -- an auto-picked model
    // would be refused here (see the next test); a manual one must not be.
    await expect(
      withUsageContext({ tool: "code_task", params: "" }, () =>
        resolveConnection({ model: "paid/hand-listed-model" }, manualGateDeps(true)),
      ),
    ).resolves.toBeDefined();
  });

  it("still refuses the SAME unvalidated model when it is auto-picked (isManualModel false)", async () => {
    setValidationBypassForTests(false);
    setBenchmarkValidationExempt(false);
    await expect(
      withUsageContext({ tool: "code_task", params: "" }, () =>
        resolveConnection({ model: "paid/hand-listed-model" }, manualGateDeps(false)),
      ),
    ).rejects.toThrow(/IRON RULE/);
  });

  // The provenance exemption is ONLY for the benchmark-verdict gate (IRON
  // RULE). assertFreeOnlyModel is a cost-safety check that applies to EVERY
  // origin, manual or not (design: "unchanged, all origins") — a hand-listed
  // model on a static free_only profile must not be able to buy its way past
  // the $0 guarantee just by being manual.
  it("free_only cost-safety still refuses a non-':free' model even when it is manual", async () => {
    const freeOnlyManualDeps: ProviderDeps = {
      getBackend: () => ({
        type: "openrouter" as const,
        billable: true,
        baseUrl: "https://openrouter.ai/api",
        apiKey: "openrouter-key",
        model: "paid/not-free-suffixed",
      }),
      apiHeaders: () => ({ Authorization: "Bearer openrouter-key" }),
      routeHeaders: () => ({}),
      getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
      isFreeOnly: () => true, // static free_only profile
      routeForModel: () => null,
      isLMStudioProvider: () => false,
getActiveProtocol: () => "openai_api",
      // Manual (hand-listed in the static profile's free_models) — still not
      // ':free'-suffixed, so it must still be refused at the cost-safety gate.
      isManualModel: () => true,
    } as unknown as ProviderDeps;
    await expect(
      resolveConnection({ model: "paid/not-free-suffixed" }, freeOnlyManualDeps),
    ).rejects.toThrow(/cost-safety/);
  });
});

// ── D3c (TRDD-FDI9NYAS): send-time price check for AUTO-PICKED paid models ──
// Same provenance exemption as D3b's IRON RULE gate, but for PRICE, and
// deliberately NOT gated behind a tool context — see connection.ts's own
// comment on why a context-less sender must not be a way around cost-safety.
function priceGateDeps(over: Partial<ProviderDeps>): ProviderDeps {
  return {
    getBackend: () => ({
      type: "openrouter" as const,
      billable: true,
      baseUrl: "https://openrouter.ai/api",
      apiKey: "openrouter-key",
      model: "paid/auto-picked-model",
    }),
    apiHeaders: () => ({ Authorization: "Bearer openrouter-key" }),
    routeHeaders: () => ({}),
    getSoftTimeoutMs: () => GLOBAL_SOFT_TIMEOUT,
    isFreeOnly: () => false,
    routeForModel: () => null,
    isLMStudioProvider: () => false,
getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.5 }),
    getEnsemblePriceCeilingUsd: () => 1.3,
    ...over,
  } as unknown as ProviderDeps;
}

describe("resolveConnection — D3c send-time price check (TRDD-FDI9NYAS)", () => {
  it("refuses an auto-picked paid model priced OVER the ceiling", async () => {
    setValidationBypassForTests(true); // isolate: this test is about PRICE, not the benchmark gate
    await expect(
      resolveConnection(
        { model: "paid/auto-picked-model" },
        priceGateDeps({
          getModelPricePerMillion: () => ({ inputDollarsPerMillion: 2.0, outputDollarsPerMillion: 0.5 }),
        }),
      ),
    ).rejects.toThrow(/exceeds the \$1\.3\/M ceiling/);
  });

  it("fails CLOSED on a cold/absent price cache — never sends blind", async () => {
    setValidationBypassForTests(true);
    await expect(
      resolveConnection(
        { model: "paid/auto-picked-model" },
        priceGateDeps({ getModelPricePerMillion: () => null }),
      ),
    ).rejects.toThrow(/no recorded price data/);
  });

  it("exempts a MANUAL model from the price gate even when priced over the ceiling", async () => {
    setValidationBypassForTests(true);
    await expect(
      resolveConnection(
        { model: "paid/auto-picked-model" },
        priceGateDeps({
          isManualModel: () => true,
          getModelPricePerMillion: () => ({ inputDollarsPerMillion: 99, outputDollarsPerMillion: 99 }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("gates an auto-picked over-ceiling model even with NO tool context (a context-less sender)", async () => {
    // No withUsageContext wrapper here at all — the IRON RULE benchmark gate
    // (toolCtx-gated) would skip entirely on this call shape; the price gate
    // must not.
    setValidationBypassForTests(true);
    await expect(
      resolveConnection(
        { model: "paid/auto-picked-model" },
        priceGateDeps({
          getModelPricePerMillion: () => ({ inputDollarsPerMillion: 2.0, outputDollarsPerMillion: 0.5 }),
        }),
      ),
    ).rejects.toThrow(/exceeds the \$1\.3\/M ceiling/);
  });

  it("admits an auto-picked model priced exactly AT the ceiling (<=, not <)", async () => {
    setValidationBypassForTests(true);
    await expect(
      resolveConnection(
        { model: "paid/auto-picked-model" },
        priceGateDeps({
          getModelPricePerMillion: () => ({ inputDollarsPerMillion: 1.3, outputDollarsPerMillion: 1.3 }),
        }),
      ),
    ).resolves.toBeDefined();
  });
});
