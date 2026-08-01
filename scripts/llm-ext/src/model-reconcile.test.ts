// Auto model-reconcile PURE CORE — dead/new detection, free-pool recompute, the
// fail-open contract, and the throttle math. All hermetic: plain data in, verdict
// out; no catalog fetch, no settings IO, no clock.

import { describe, it, expect } from "vitest";
import {
  computeReconcile,
  parseReconcileInterval,
  reconcileModelsBeforeWork,
  shouldReconcile,
  DEFAULT_RECONCILE_INTERVAL_MS,
  type ReconcileDeps,
  type ReconcileInput,
} from "./model-reconcile";

const base = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  catalogIds: new Set(["a/x:free", "a/y:free", "paid/keep"]),
  configuredEnsemble: [],
  configuredFreePool: ["a/x:free", "a/y:free"],
  configuredToolModels: [],
  catalogFreeQualified: ["a/x:free", "a/y:free"],
  benchmarkFailed: new Set(),
  ...over,
});

describe("computeReconcile — dead-model detection", () => {
  it("flags a configured free model that vanished from the catalog and drops it", () => {
    const v = computeReconcile(
      base({
        catalogIds: new Set(["a/x:free", "paid/keep"]), // a/y:free gone
      }),
    );
    expect(v.deadModels).toEqual(["a/y:free"]);
    expect(v.deadFreeModels).toEqual(["a/y:free"]);
    expect(v.newFreePool).toEqual(["a/x:free"]); // the dead one is dropped
    expect(v.freePoolChanged).toBe(true);
  });

  it("flags a dead PAID model as a WARNING and never auto-replaces it", () => {
    const v = computeReconcile(
      base({
        configuredEnsemble: ["paid/gone", "paid/keep"],
        catalogIds: new Set(["a/x:free", "a/y:free", "paid/keep"]), // paid/gone missing
      }),
    );
    expect(v.deadPaidModels).toEqual(["paid/gone"]);
    expect(v.paidWarnings).toHaveLength(1);
    expect(v.paidWarnings[0]).toMatch(/paid\/gone/);
    expect(v.paidWarnings[0]).toMatch(/--update-all --paid/);
    // Paid death changes nothing about the free pool — no auto-replacement.
    expect(v.freePoolChanged).toBe(false);
  });

  it("does NOT flag a local (non-OpenRouter) id as dead — it isn't in the catalog by design", () => {
    const v = computeReconcile(
      base({
        configuredEnsemble: ["qwen3:14b"], // local model, no '/'
      }),
    );
    expect(v.deadModels).toEqual([]);
    expect(v.paidWarnings).toEqual([]);
  });
});

describe("computeReconcile — new-model adoption (FREE only, $0)", () => {
  it("adopts a qualifying :free arrival not yet in the pool", () => {
    const v = computeReconcile(
      base({
        catalogIds: new Set(["a/x:free", "a/y:free", "a/z:free", "paid/keep"]),
        catalogFreeQualified: ["a/x:free", "a/y:free", "a/z:free"], // z is new
      }),
    );
    expect(v.newFreeModels).toEqual(["a/z:free"]);
    expect(v.newFreePool).toEqual(["a/x:free", "a/y:free", "a/z:free"]);
    expect(v.freePoolChanged).toBe(true);
  });

  it("NEVER adopts a non-':free' id — a $0 router pseudo-model can't reach the pool", () => {
    // openrouter/free is priced $0 but has no ':free' suffix; the cost-safety
    // chokepoint refuses it, so it must never be adopted here either.
    const v = computeReconcile(
      base({
        catalogIds: new Set(["a/x:free", "a/y:free", "openrouter/free"]),
        catalogFreeQualified: ["a/x:free", "a/y:free", "openrouter/free"],
      }),
    );
    expect(v.newFreeModels).not.toContain("openrouter/free");
    expect(v.newFreePool).not.toContain("openrouter/free");
  });

  it("never adopts a benchmark-FAILED free model", () => {
    const v = computeReconcile(
      base({
        catalogIds: new Set(["a/x:free", "a/y:free", "a/bad:free"]),
        catalogFreeQualified: ["a/x:free", "a/y:free", "a/bad:free"],
        benchmarkFailed: new Set(["a/bad:free"]),
      }),
    );
    expect(v.newFreeModels).not.toContain("a/bad:free");
  });

  it("drops an already-pooled model that later FAILED its benchmark", () => {
    const v = computeReconcile(
      base({
        benchmarkFailed: new Set(["a/y:free"]),
      }),
    );
    expect(v.newFreePool).toEqual(["a/x:free"]);
    expect(v.freePoolChanged).toBe(true);
  });

  it("caps the recomputed pool at maxFreePool, preserving the user's order first", () => {
    const arrivals = Array.from({ length: 20 }, (_, i) => `a/n${i}:free`);
    const v = computeReconcile(
      base({
        configuredFreePool: ["a/x:free", "a/y:free"],
        catalogIds: new Set(["a/x:free", "a/y:free", ...arrivals]),
        catalogFreeQualified: ["a/x:free", "a/y:free", ...arrivals],
        maxFreePool: 5,
      }),
    );
    expect(v.newFreePool).toHaveLength(5);
    // The user's two stay at the front (preference preserved).
    expect(v.newFreePool.slice(0, 2)).toEqual(["a/x:free", "a/y:free"]);
  });
});

describe("computeReconcile — the fail-open contract", () => {
  it("an EMPTY catalog (fetch failed) is a NO-OP — it never declares models dead", () => {
    // The load-bearing safety property: a transient network blip must not wipe
    // the configured pool.
    const v = computeReconcile(
      base({
        catalogIds: new Set(),
        configuredEnsemble: ["paid/x"],
      }),
    );
    expect(v.deadModels).toEqual([]);
    expect(v.newFreeModels).toEqual([]);
    expect(v.freePoolChanged).toBe(false);
    expect(v.newFreePool).toEqual(["a/x:free", "a/y:free"]); // unchanged
  });

  it("no changes at all → freePoolChanged is false (no needless settings write)", () => {
    const v = computeReconcile(base());
    expect(v.freePoolChanged).toBe(false);
    expect(v.deadModels).toEqual([]);
    expect(v.newFreeModels).toEqual([]);
  });
});

describe("throttle math", () => {
  it("shouldReconcile: never-run always reconciles; then gated by the interval", () => {
    expect(shouldReconcile(null, 1_000)).toBe(true);
    expect(shouldReconcile(1_000, 1_000 + DEFAULT_RECONCILE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldReconcile(1_000, 1_000 + DEFAULT_RECONCILE_INTERVAL_MS)).toBe(true);
  });

  it("interval 0 means ALWAYS reconcile (agrees with parseReconcileInterval)", () => {
    expect(shouldReconcile(1_000, 1_000, 0)).toBe(true);
    expect(shouldReconcile(1_000, 1_001, 0)).toBe(true);
  });

  it("a negative / non-finite interval falls back to the default (never hammers)", () => {
    expect(shouldReconcile(1_000, 1_000 + 60_000, -5)).toBe(false);
    expect(shouldReconcile(1_000, 1_000 + 60_000, NaN)).toBe(false);
  });

  it("parseReconcileInterval: unset/empty → default; 0 passes; junk → default", () => {
    expect(parseReconcileInterval(undefined)).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(parseReconcileInterval("")).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(parseReconcileInterval("0")).toBe(0);
    expect(parseReconcileInterval("90000")).toBe(90_000);
    expect(parseReconcileInterval("nonsense")).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(parseReconcileInterval("-1")).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
  });
});

describe("reconcileModelsBeforeWork — the IO-shell orchestrator (deps injected)", () => {
  const mkDeps = (over: Partial<ReconcileDeps> = {}): {
    deps: ReconcileDeps;
    spies: {
      applied: string[][];
      benches: string[];
      logs: string[];
      wroteTs: number[];
    };
  } => {
    const spies = { applied: [] as string[][], benches: [] as string[], logs: [] as string[], wroteTs: [] as number[] };
    const deps: ReconcileDeps = {
      now: () => 1_000_000,
      env: {},
      readLastRunMs: () => null,
      writeLastRunMs: (ms) => spies.wroteTs.push(ms),
      fetchCatalog: async () => ({
        ids: new Set(["a/x:free", "a/y:free", "a/z:free", "paid/keep"]),
        freeQualified: ["a/x:free", "a/y:free", "a/z:free"],
      }),
      getConfigured: () => ({ ensemble: ["paid/keep"], freePool: ["a/x:free", "a/y:free"], toolModels: [] }),
      benchmarkFailed: () => new Set(),
      applyFreePool: (pool) => {
        spies.applied.push(pool);
        return true;
      },
      launchFreeBench: (reason) => spies.benches.push(reason),
      log: (m) => spies.logs.push(m),
      ...over,
    };
    return { deps, spies };
  };

  it("adopts a new :free arrival: writes the pool AND launches the $0 benchmark", async () => {
    const { deps, spies } = mkDeps();
    const out = await reconcileModelsBeforeWork(deps);
    expect(out.outcome).toBe("ran");
    expect(spies.applied).toEqual([["a/x:free", "a/y:free", "a/z:free"]]);
    expect(spies.benches).toHaveLength(1); // benchmark fired on the class change
    expect(spies.wroteTs).toEqual([1_000_000]); // throttle timestamp banked
  });

  it("no change → no settings write, no benchmark (but the timestamp is still banked)", async () => {
    const { deps, spies } = mkDeps({
      fetchCatalog: async () => ({
        ids: new Set(["a/x:free", "a/y:free", "paid/keep"]),
        freeQualified: ["a/x:free", "a/y:free"],
      }),
    });
    const out = await reconcileModelsBeforeWork(deps);
    expect(out.outcome).toBe("ran");
    expect(spies.applied).toEqual([]);
    expect(spies.benches).toEqual([]);
    expect(spies.wroteTs).toEqual([1_000_000]);
  });

  it("is a NO-OP when throttled — never fetches, writes, or benchmarks", async () => {
    let fetched = false;
    const { deps, spies } = mkDeps({
      readLastRunMs: () => 999_000, // 1s ago, well within the default hour
      fetchCatalog: async () => {
        fetched = true;
        return { ids: new Set(), freeQualified: [] };
      },
    });
    const out = await reconcileModelsBeforeWork(deps);
    expect(out).toMatchObject({ outcome: "skipped", reason: "throttled" });
    expect(fetched).toBe(false);
    expect(spies.applied).toEqual([]);
    expect(spies.wroteTs).toEqual([]);
  });

  it("env opt-out disables it entirely", async () => {
    const { deps } = mkDeps({ env: { LLM_EXT_DISABLE_AUTO_RECONCILE: "1" } });
    const out = await reconcileModelsBeforeWork(deps);
    expect(out).toMatchObject({ outcome: "skipped", reason: "disabled via env" });
  });

  it("fail-open: a catalog fetch THROW banks the timestamp and touches nothing else", async () => {
    const { deps, spies } = mkDeps({
      fetchCatalog: async () => {
        throw new Error("network down");
      },
    });
    const out = await reconcileModelsBeforeWork(deps);
    expect(out).toMatchObject({ outcome: "skipped", reason: "catalog fetch failed" });
    expect(spies.applied).toEqual([]);
    expect(spies.benches).toEqual([]);
    expect(spies.wroteTs).toEqual([1_000_000]); // we DID look → don't hammer
  });

  it("surfaces a paid-dead WARNING without writing the free pool", async () => {
    const { deps, spies } = mkDeps({
      getConfigured: () => ({ ensemble: ["paid/gone"], freePool: ["a/x:free", "a/y:free"], toolModels: [] }),
      fetchCatalog: async () => ({
        ids: new Set(["a/x:free", "a/y:free"]), // paid/gone missing; no new free
        freeQualified: ["a/x:free", "a/y:free"],
      }),
    });
    const out = await reconcileModelsBeforeWork(deps);
    expect(out.verdict?.deadPaidModels).toEqual(["paid/gone"]);
    expect(spies.applied).toEqual([]); // paid death never rewrites the free pool
    expect(spies.logs.some((l) => /paid\/gone/.test(l))).toBe(true);
  });

  it("skips when the backend is not OpenRouter", async () => {
    const { deps } = mkDeps({ getConfigured: () => null });
    const out = await reconcileModelsBeforeWork(deps);
    expect(out).toMatchObject({ outcome: "skipped", reason: "not openrouter / no profile" });
  });
});
