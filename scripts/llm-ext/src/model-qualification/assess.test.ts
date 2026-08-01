// Unit tests for the cross-tool model assessment (TRDD-f45eeaa0 §2.4).
// Pure + offline — synthetic OpenRouter models, an injected catalog fetcher.

import { describe, it, expect } from "vitest";

import type { OpenRouterModel } from "../benchmark/discover.js";
import { registeredTools } from "./registry.js";
import {
  assessModelAcrossTools,
  assessModelById,
  renderAssessmentText,
} from "./assess.js";

/** Synthetic OpenRouter model. pricing is per-TOKEN (qualify multiplies ×1e6). */
function model(
  over: Partial<OpenRouterModel> & {
    pricing?: { prompt?: string; completion?: string };
  } = {},
): OpenRouterModel {
  return {
    id: "vendor/m",
    context_length: 200_000,
    top_provider: { max_completion_tokens: 64_000 },
    supported_parameters: ["response_format", "reasoning"],
    pricing: { prompt: "0.0000004", completion: "0.0000008" }, // $0.40 / $0.80 per M
    ...over,
  };
}

describe("assessModelAcrossTools", () => {
  it("assesses against every registered tool", () => {
    const a = assessModelAcrossTools(model());
    expect(a.tools.length).toBe(registeredTools().length);
    expect(a.totalTools).toBe(registeredTools().length);
  });

  it("a big cheap reasoning model qualifies for all tools; both benchmarked tools are flagged", () => {
    const a = assessModelAcrossTools(model({ id: "vendor/big" }));
    expect(a.qualifiedCount).toBe(a.totalTools);
    // The two tools that carry a benchmark gate are surfaced for a follow-up run.
    expect(a.benchmarkGatedQualified).toContain("security_scan");
    expect(a.benchmarkGatedQualified).toContain("mass_scout");
    // chat qualifies but has no benchmark → not in the gated list.
    expect(a.benchmarkGatedQualified).not.toContain("chat");
  });

  it("a small no-reasoning model qualifies only for security_scan (the relaxed-requirements tool)", () => {
    const a = assessModelAcrossTools(
      model({ context_length: 32_000, supported_parameters: ["response_format"] }),
    );
    const ok = a.tools.filter((t) => t.meetsRequirements).map((t) => t.tool);
    expect(ok).toEqual(["security_scan"]);
    expect(a.benchmarkGatedQualified).toEqual(["security_scan"]);
    // code_task fails specifically on the reasoning requirement, with a reason.
    const ct = a.tools.find((t) => t.tool === "code_task")!;
    expect(ct.meetsRequirements).toBe(false);
    expect(ct.disqualifyReason).toMatch(/reasoning/);
  });

  it("a pricier-than-ceiling model qualifies for no tool, each with a cost reason", () => {
    const a = assessModelAcrossTools(
      model({ pricing: { prompt: "0.000002", completion: "0.000002" } }), // $2 / $2 per M
    );
    expect(a.qualifiedCount).toBe(0);
    expect(a.benchmarkGatedQualified).toEqual([]);
    for (const t of a.tools) {
      expect(t.meetsRequirements).toBe(false);
      expect(t.disqualifyReason).toMatch(/cap/);
    }
  });

  it("each tool row carries the registry note", () => {
    const a = assessModelAcrossTools(model());
    const ss = a.tools.find((t) => t.tool === "security_scan")!;
    expect(ss.benchmark).toBe("security-triage");
    expect(ss.note.length).toBeGreaterThan(10);
  });
});

describe("assessModelById", () => {
  it("finds the model in the injected catalog and assesses it", async () => {
    const catalog = [model({ id: "vendor/big" }), model({ id: "vendor/other" })];
    const a = await assessModelById("vendor/big", {
      fetchModels: async () => catalog,
    });
    expect(a.modelId).toBe("vendor/big");
    expect(a.qualifiedCount).toBe(a.totalTools);
  });

  it("throws a clear error when the id is not in the catalog", async () => {
    await expect(
      assessModelById("vendor/missing", { fetchModels: async () => [model()] }),
    ).rejects.toThrow(/not found in the OpenRouter catalog/);
  });
});

describe("renderAssessmentText", () => {
  it("renders OK rows + a benchmark follow-up note for a qualifying model", () => {
    const text = renderAssessmentText(assessModelAcrossTools(model({ id: "vendor/big" })));
    expect(text).toContain("vendor/big");
    expect(text).toContain("OK");
    expect(text).toContain("benchmark: security-triage");
    expect(text).toMatch(/security-triage-benchmark/);
  });

  it("renders NO rows with the failing reason for a disqualified model", () => {
    const text = renderAssessmentText(
      assessModelAcrossTools(
        model({ pricing: { prompt: "0.000002", completion: "0.000002" } }),
      ),
    );
    expect(text).toContain("NO");
    expect(text).toMatch(/cap/);
  });
});
