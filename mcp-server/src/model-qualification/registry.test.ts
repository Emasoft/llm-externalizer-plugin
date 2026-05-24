// Unit tests for the per-tool model-qualification registry. Pure, no network.

import { describe, it, expect } from "vitest";

import type { OpenRouterModel } from "../benchmark/discover.js";
import { SECURITY_TRIAGE_CRITERIA } from "../benchmark/security-triage/select.js";
import {
  TOOL_MODEL_REGISTRY,
  getToolDescriptor,
  qualifyModelForTool,
  registeredTools,
} from "./registry.js";

/** Build a synthetic OpenRouter model. pricing is per-TOKEN (qualify ×1e6). */
function model(over: Partial<OpenRouterModel> & { pricing?: { prompt?: string; completion?: string } } = {}): OpenRouterModel {
  return {
    id: "vendor/m",
    context_length: 200_000,
    top_provider: { max_completion_tokens: 64_000 },
    supported_parameters: ["response_format", "reasoning"],
    pricing: { prompt: "0.0000004", completion: "0.0000008" }, // $0.40 / $0.80 per M
    ...over,
  };
}

describe("TOOL_MODEL_REGISTRY", () => {
  it("registers security_scan with its real benchmark + the triage criteria", () => {
    const d = getToolDescriptor("security_scan");
    expect(d).toBeDefined();
    expect(d!.benchmark).toBe("security-triage");
    expect(d!.requirements).toBe(SECURITY_TRIAGE_CRITERIA);
    // Triage criteria: structured output, NO reasoning, modest context.
    expect(d!.requirements.requireReasoning).toBe(false);
    expect(d!.requirements.requireStructuredOutputs).toBe(true);
  });

  it("registers mass_scout against the existing keyword-classification benchmark", () => {
    expect(getToolDescriptor("mass_scout")!.benchmark).toBe("keyword-classification");
  });

  it("carries requirements-only descriptors (benchmark:null) for tools without a dataset yet", () => {
    for (const t of ["code_task", "scan_folder", "check_imports", "compare_files", "chat", "cluster_synonyms"]) {
      const d = getToolDescriptor(t);
      expect(d, `${t} registered`).toBeDefined();
      expect(d!.benchmark, `${t} has no dataset yet`).toBeNull();
    }
  });

  it("does NOT register pure-utility (non-LLM) tools", () => {
    for (const t of ["discover", "reset", "get_settings", "or_model_info"]) {
      expect(getToolDescriptor(t)).toBeUndefined();
    }
  });

  it("every descriptor's tool field matches its key, and every entry has a note", () => {
    for (const [key, d] of Object.entries(TOOL_MODEL_REGISTRY)) {
      expect(d.tool).toBe(key);
      expect(d.note.length).toBeGreaterThan(10);
    }
  });

  it("registeredTools lists the LLM tools", () => {
    const tools = registeredTools();
    expect(tools).toContain("security_scan");
    expect(tools).toContain("chat");
    expect(tools).not.toContain("discover");
  });
});

describe("qualifyModelForTool", () => {
  it("a structured non-reasoning small-context model qualifies for security_scan", () => {
    // 32K ctx, no reasoning — below the keyword-ensemble bar but fine for triage.
    const m = model({ context_length: 32_000, supported_parameters: ["response_format"] });
    const q = qualifyModelForTool("security_scan", m);
    expect(q.meetsRequirements).toBe(true);
    expect(q.qualified).not.toBeNull();
    expect(q.benchmark).toBe("security-triage");
  });

  it("that same small/no-reasoning model does NOT qualify for code_task (needs reasoning + 128K)", () => {
    const m = model({ context_length: 32_000, supported_parameters: ["response_format"] });
    expect(qualifyModelForTool("code_task", m).meetsRequirements).toBe(false);
  });

  it("a reasoning + long-context model qualifies for code_task", () => {
    const m = model({ context_length: 200_000, supported_parameters: ["response_format", "reasoning"] });
    expect(qualifyModelForTool("code_task", m).meetsRequirements).toBe(true);
  });

  it("a model with no structured output still qualifies for chat (loosest tool)", () => {
    const m = model({ supported_parameters: [] });
    expect(qualifyModelForTool("chat", m).meetsRequirements).toBe(true);
  });

  it("a pricier-than-ceiling model qualifies for NO tool (cost gate)", () => {
    const pricey = model({ pricing: { prompt: "0.000002", completion: "0.000002" } }); // $2 / $2 per M
    expect(qualifyModelForTool("security_scan", pricey).meetsRequirements).toBe(false);
    expect(qualifyModelForTool("code_task", pricey).meetsRequirements).toBe(false);
    expect(qualifyModelForTool("chat", pricey).meetsRequirements).toBe(false);
  });

  it("an unknown / pure-utility tool yields meetsRequirements:false, benchmark:null", () => {
    const q = qualifyModelForTool("discover", model());
    expect(q.meetsRequirements).toBe(false);
    expect(q.qualified).toBeNull();
    expect(q.benchmark).toBeNull();
  });
});
