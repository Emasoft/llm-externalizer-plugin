// TRDD-SZ7TO9FW increment 2: the pure resolution chain (spec 4.2, 4.3, 4.5, 5). Owner rules under test: D1 local is
// implicit in every profile; D2 only benchmark-passing models serve; Q1 paid -> free -> local; Q2 one-way rule.
import { describe, expect, it } from "vitest";

import { resolveChain, tierOrder, type ChainInputs, type ChainProfile } from "./resolve-chain.js";
import type { Verdict } from "./verdicts.js";

const isFree = (id: string): boolean => id.endsWith(":free");

/** Inputs with a verdict table; a model absent from the table is untested. */
function inputs(profile: ChainProfile, verdicts: Record<string, Verdict>, over: Partial<ChainInputs> = {}): ChainInputs {
  return {
    profile,
    kind: "chat",
    verdictOf: (id) => verdicts[id] ?? "untested",
    pools: { paid: ["p/pool-a", "p/pool-b"], free: ["f/pool-a:free", "f/pool-b:free"] },
    localReady: ["l/local-a"],
    isFree,
    ...over,
  };
}

const ALL_PASS: Record<string, Verdict> = {
  "p/pin": "pass",
  "p/pool-a": "pass",
  "p/pool-b": "pass",
  "f/pool-a:free": "pass",
  "f/pool-b:free": "pass",
  "l/local-a": "pass",
};

const ids = (r: ReturnType<typeof resolveChain>): string[] => r.entries.map((e) => e.modelId);

describe("resolveChain", () => {
  it("puts a passing pin first, tagged pinned", () => {
    const r = resolveChain(inputs({ name: "mine", category: "paid", model: "p/pin" }, ALL_PASS));
    expect(r.entries[0]).toEqual({ modelId: "p/pin", tier: "pinned" });
  });

  it("orders tool_models.<kind> before model, second_model, third_model", () => {
    const v = { ...ALL_PASS, "p/tool": "pass", "p/second": "pass" } as Record<string, Verdict>;
    const r = resolveChain(inputs({ name: "mine", category: "paid", toolModels: { chat: "p/tool" }, model: "p/pin", secondModel: "p/second" }, v));
    expect(ids(r).slice(0, 3)).toEqual(["p/tool", "p/pin", "p/second"]);
  });

  it("skips a failing pin and reports it", () => {
    const r = resolveChain(inputs({ name: "mine", category: "paid", model: "p/bad" }, { ...ALL_PASS, "p/bad": "fail" }));
    expect(ids(r)).not.toContain("p/bad");
    expect(r.failedPins).toEqual(["p/bad"]);
    expect(r.entries[0]?.tier).toBe("paid");
  });

  it("skips an untested pin for this run (never placed later) and reports it for the background test", () => {
    const r = resolveChain(inputs({ name: "mine", category: "paid", model: "p/new" }, ALL_PASS));
    expect(ids(r)).not.toContain("p/new");
    expect(r.untestedPins).toEqual(["p/new"]);
  });

  it("free profile: pinned free -> free pool -> local, and never the paid pool", () => {
    const r = resolveChain(inputs({ name: "f", category: "free", model: "f/pin:free" }, { ...ALL_PASS, "f/pin:free": "pass" }));
    expect(r.entries).toEqual([
      { modelId: "f/pin:free", tier: "pinned" },
      { modelId: "f/pool-a:free", tier: "free" },
      { modelId: "f/pool-b:free", tier: "free" },
      { modelId: "l/local-a", tier: "local" },
    ]);
  });

  it("free profile drops a billable pin (pinned free only)", () => {
    const r = resolveChain(inputs({ name: "f", category: "free", model: "p/pin" }, ALL_PASS));
    expect(ids(r)).not.toContain("p/pin");
  });

  it("free profile falls to local when no free remote model passes", () => {
    const r = resolveChain(inputs({ name: "f", category: "free" }, { "l/local-a": "pass", "f/pool-a:free": "fail" }));
    expect(r.entries).toEqual([{ modelId: "l/local-a", tier: "local" }]);
  });

  it("paid profile: pinned -> paid pool -> free pool -> local (owner Q1)", () => {
    const r = resolveChain(inputs({ name: "p", category: "paid", model: "p/pin" }, ALL_PASS));
    expect(r.entries.map((e) => e.tier)).toEqual(["pinned", "paid", "paid", "free", "free", "local"]);
  });

  it("local profile never gets a remote model unless it lists that tier (one-way rule)", () => {
    const r = resolveChain(inputs({ name: "l", category: "local", model: "l/pin" }, { ...ALL_PASS, "l/pin": "pass" }));
    expect(r.entries).toEqual([
      { modelId: "l/pin", tier: "pinned" },
      { modelId: "l/local-a", tier: "local" },
    ]);
  });

  it("free profile never gets the paid pool unless it lists paid", () => {
    expect(tierOrder({ name: "f", category: "free" })).toEqual(["pinned", "free", "local"]);
    const listed = resolveChain(inputs({ name: "f", category: "free", fallback: ["paid"] }, ALL_PASS));
    expect(listed.entries.map((e) => e.tier)).toEqual(["free", "free", "paid", "paid", "local"]);
  });

  it("honors the profile's own fallback list and still appends local (D1)", () => {
    expect(tierOrder({ name: "p", category: "paid", fallback: ["pinned", "paid"] })).toEqual(["pinned", "paid", "local"]);
    expect(tierOrder({ name: "l", category: "local", fallback: ["free"] })).toEqual(["pinned", "local", "free"]);
    const r = resolveChain(inputs({ name: "p", category: "paid", fallback: ["paid"] }, ALL_PASS));
    expect(r.entries.map((e) => e.tier)).toEqual(["paid", "paid", "local"]);
  });

  it("rejects an unknown fallback tier", () => {
    expect(() => tierOrder({ name: "x", category: "paid", fallback: ["cloud" as never] })).toThrow(/unknown fallback tier 'cloud'/);
  });

  it("lists a model once, at its first tier", () => {
    const r = resolveChain(inputs({ name: "p", category: "paid", model: "p/pool-a" }, ALL_PASS));
    expect(ids(r).filter((id) => id === "p/pool-a")).toHaveLength(1);
    expect(r.entries[0]).toEqual({ modelId: "p/pool-a", tier: "pinned" });
  });

  it("returns an empty chain when nothing passes", () => {
    const r = resolveChain(inputs({ name: "p", category: "paid", model: "p/pin" }, {}));
    expect(r.entries).toEqual([]);
    expect(r.untestedPins).toEqual(["p/pin"]);
  });

  it("throws for a kind with no benchmark verdict (classify keeps its own chain)", () => {
    expect(() => resolveChain(inputs({ name: "p", category: "paid" }, ALL_PASS, { kind: "classify_verify" }))).toThrow(/no resolution chain/);
  });
});
