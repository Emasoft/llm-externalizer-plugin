// Reasoning-effort cost guard (TRDD-ec45c66f). Pure, offline, free. The
// reasoning ladder decides how much THINKING (billed) a model does per call.
// Before this fix the default top rung was "xhigh" (maximum thinking tokens),
// which — on a reasoning primary — was the dominant per-call cost. These tests
// pin the cost-safe behavior: default "high", a per-call "off" opt-out (used by
// cluster_synonyms), and the explicit-xhigh opt-in still available.
//
// Importing ./index is safe: index.ts has an entry-point guard (TRDD-e82f2c49)
// so importing it never boots the server or contacts a backend.

import { describe, it, expect } from "vitest";
// The reasoning ladder moved out of index.ts into the provider layer
// (B1 Phase 5b, TRDD-63314265). No re-export shim exists by project rule, so the
// test imports it from its new (and only) home.
import { reasoningLadderForModel } from "./provider/completion";

describe("reasoningLadderForModel — cost-safe default effort (TRDD-ec45c66f)", () => {
  it("default top rung is 'high', NOT 'xhigh' (the per-call cost regression)", () => {
    // Fresh model id → not in the downgrade cache → uses the configured default.
    const ladder = reasoningLadderForModel("vendor/fresh-default-1");
    expect(ladder[0]).toEqual({ effort: "high" });
    // xhigh must not appear anywhere in the default ladder.
    expect(JSON.stringify(ladder)).not.toContain("xhigh");
    // Always ends with the drop-reasoning (null) fallback.
    expect(ladder[ladder.length - 1]).toBeNull();
  });

  it("per-call override 'off' disables reasoning entirely → [null]", () => {
    // This is exactly what cluster_synonyms passes so it never pays to think.
    expect(reasoningLadderForModel("vendor/fresh-off-1", "off")).toEqual([null]);
  });

  it("per-call override 'medium' sends medium then drops to no reasoning", () => {
    expect(reasoningLadderForModel("vendor/fresh-medium-1", "medium")).toEqual([
      { effort: "medium" },
      null,
    ]);
  });

  it("per-call override 'low' sends low then null", () => {
    expect(reasoningLadderForModel("vendor/fresh-low-1", "low")).toEqual([
      { effort: "low" },
      null,
    ]);
  });

  it("explicit 'xhigh' opt-in keeps the xhigh→high→none ladder", () => {
    expect(reasoningLadderForModel("vendor/fresh-xhigh-1", "xhigh")).toEqual([
      { effort: "xhigh" },
      { effort: "high" },
      null,
    ]);
  });

  it("empty model id → no reasoning regardless of override", () => {
    expect(reasoningLadderForModel("", "high")).toEqual([null]);
  });
});
