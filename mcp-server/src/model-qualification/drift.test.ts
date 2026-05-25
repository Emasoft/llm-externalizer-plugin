// Tests for check_model_health drift detection (TRDD-828238b5 A2).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { OpenRouterModel } from "../benchmark/discover.js";
import {
  perMillion,
  buildConfiguredModels,
  computeModelHealth,
  loadBaseline,
  saveBaseline,
  checkModelHealth,
  runCheckModelHealth,
  renderModelHealthMarkdown,
  type ModelBaseline,
} from "./drift.js";

/** Build a catalog model. Prices are given in $/million and converted to the
 *  per-token strings OpenRouter actually returns. A "full" model meets the
 *  general DEFAULT_CRITERIA (128K ctx, 64K out, structured + reasoning, <$1/M). */
function makeModel(
  id: string,
  o: {
    inPerM?: number;
    outPerM?: number;
    ctx?: number;
    maxOut?: number;
    params?: string[];
  } = {},
): OpenRouterModel {
  const inPerM = o.inPerM ?? 0.15;
  const outPerM = o.outPerM ?? 0.6;
  return {
    id,
    name: id,
    context_length: o.ctx ?? 200_000,
    pricing: { prompt: String(inPerM / 1e6), completion: String(outPerM / 1e6) },
    top_provider: { max_completion_tokens: o.maxOut ?? 100_000 },
    supported_parameters: o.params ?? ["structured_outputs", "response_format", "reasoning", "include_reasoning"],
  };
}

describe("perMillion", () => {
  it("converts a per-token price string to $/million", () => {
    expect(perMillion("0.00000015")).toBeCloseTo(0.15, 6);
  });
  it("returns null for missing or non-numeric input", () => {
    expect(perMillion(undefined)).toBeNull();
    expect(perMillion("abc")).toBeNull();
  });
});

describe("buildConfiguredModels (pure)", () => {
  const tools = ["mass_scout", "security_scan", "code_task"];

  it("main model serves every tool that has no override", () => {
    const cfg = buildConfiguredModels(
      { model: "main", secondModel: "", thirdModel: "", toolModels: {} },
      tools,
    );
    expect(cfg).toHaveLength(1);
    expect(cfg[0].model).toBe("main");
    expect(cfg[0].roles).toEqual(["model"]);
    expect(cfg[0].servedTools.sort()).toEqual([...tools].sort());
  });

  it("a tool_models override serves only its tool; main loses it", () => {
    const cfg = buildConfiguredModels(
      { model: "main", secondModel: "", thirdModel: "", toolModels: { security_scan: "triage" } },
      tools,
    );
    const main = cfg.find((c) => c.model === "main")!;
    const triage = cfg.find((c) => c.model === "triage")!;
    expect(main.servedTools).not.toContain("security_scan");
    expect(triage.servedTools).toEqual(["security_scan"]);
    expect(triage.roles).toEqual(["tool_models.security_scan"]);
  });

  it("merges a model referenced by several slots", () => {
    const cfg = buildConfiguredModels(
      { model: "x", secondModel: "x", thirdModel: "", toolModels: { mass_scout: "x" } },
      tools,
    );
    expect(cfg).toHaveLength(1);
    expect(cfg[0].model).toBe("x");
    expect(cfg[0].roles.sort()).toEqual(["model", "second_model", "tool_models.mass_scout"].sort());
  });

  it("ensemble members serve the non-overridden tools too", () => {
    const cfg = buildConfiguredModels(
      { model: "a", secondModel: "b", thirdModel: "c", toolModels: {} },
      tools,
    );
    expect(cfg.map((c) => c.model).sort()).toEqual(["a", "b", "c"]);
    for (const c of cfg) expect(c.servedTools.sort()).toEqual([...tools].sort());
  });
});

describe("computeModelHealth (pure)", () => {
  const configured = [{ model: "m", roles: ["model"], servedTools: ["mass_scout"] }];

  it("flags a removed model as critical (present:false)", () => {
    const { findings } = computeModelHealth(configured, [], {});
    expect(findings[0].present).toBe(false);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].notes.join(" ")).toContain("deprecated/removed");
  });

  it("flags a cost increase beyond the threshold as warn", () => {
    const baseline: ModelBaseline = { m: { inputPerM: 0.15, outputPerM: 0.6, capturedAt: "t0" } };
    const catalog = [makeModel("m", { inPerM: 0.3, outPerM: 0.6 })]; // input doubled
    const { findings } = computeModelHealth(configured, catalog, baseline);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].costChanged).toBe(true);
    expect(findings[0].notes.join(" ")).toContain("input price up");
  });

  it("a cost decrease is noted but not a warning", () => {
    const baseline: ModelBaseline = { m: { inputPerM: 0.6, outputPerM: 0.6, capturedAt: "t0" } };
    const catalog = [makeModel("m", { inPerM: 0.15, outPerM: 0.6 })];
    const { findings } = computeModelHealth(configured, catalog, baseline);
    expect(findings[0].severity).toBe("ok");
    expect(findings[0].notes.join(" ")).toContain("input price down");
  });

  it("flags a requirements regression as warn", () => {
    // weak model: missing structured_outputs ⇒ fails mass_scout's requirements.
    const catalog = [makeModel("m", { params: ["reasoning"] })];
    const { findings } = computeModelHealth(configured, catalog, {});
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].requirementsRegressions.map((r) => r.tool)).toContain("mass_scout");
  });

  it("a present, in-budget, qualifying model with no baseline is ok and gets captured", () => {
    const catalog = [makeModel("m")];
    const { findings, updatedBaseline } = computeModelHealth(configured, catalog, {});
    expect(findings[0].severity).toBe("ok");
    expect(updatedBaseline.m.inputPerM).toBeCloseTo(0.15, 6);
    expect(updatedBaseline.m.outputPerM).toBeCloseTo(0.6, 6);
  });

  it("preserves the original capturedAt when refreshing an existing baseline entry", () => {
    const baseline: ModelBaseline = { m: { inputPerM: 0.15, outputPerM: 0.6, capturedAt: "t-original" } };
    const catalog = [makeModel("m")];
    const { updatedBaseline } = computeModelHealth(configured, catalog, baseline);
    expect(updatedBaseline.m.capturedAt).toBe("t-original");
  });
});

describe("baseline persistence + checkModelHealth orchestrator", () => {
  const ORIG = process.env.LLM_EXT_CONFIG_DIR;
  let tmp: string;
  let baselinePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join("/tmp", "drift-"));
    process.env.LLM_EXT_CONFIG_DIR = tmp;
    baselinePath = join(tmp, "model-baseline.json");
  });
  afterEach(() => {
    if (ORIG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG;
    else delete process.env.LLM_EXT_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loadBaseline returns {} when missing; saveBaseline round-trips", () => {
    expect(loadBaseline(baselinePath)).toEqual({});
    const b: ModelBaseline = { m: { inputPerM: 1, outputPerM: 2, capturedAt: "t" } };
    saveBaseline(b, baselinePath);
    expect(loadBaseline(baselinePath)).toEqual(b);
    expect(JSON.parse(readFileSync(baselinePath, "utf-8")).m.inputPerM).toBe(1);
  });

  it("seeds the baseline on first run (no drift), then detects drift on the second", async () => {
    const profile = { name: "p", model: "m", secondModel: "", thirdModel: "", toolModels: {} };

    // First run: empty baseline → seeded, no cost drift.
    const r1 = await checkModelHealth(profile, {
      fetchModels: async () => [makeModel("m", { inPerM: 0.15, outPerM: 0.6 })],
      baselinePath,
    });
    expect(r1.baselineSeeded).toBe(true);
    expect(r1.findings[0].costChanged).toBe(false);
    expect(r1.summary.ok).toBe(1);

    // Second run: price doubled → warn.
    const r2 = await checkModelHealth(profile, {
      fetchModels: async () => [makeModel("m", { inPerM: 0.3, outPerM: 0.6 })],
      baselinePath,
    });
    expect(r2.baselineSeeded).toBe(false);
    expect(r2.summary.warn).toBe(1);
    expect(r2.findings[0].notes.join(" ")).toContain("input price up");
  });

  it("reports a removed configured model as critical end-to-end", async () => {
    const profile = { name: "p", model: "ghost", secondModel: "", thirdModel: "", toolModels: {} };
    const r = await checkModelHealth(profile, {
      fetchModels: async () => [makeModel("other")],
      baselinePath,
    });
    expect(r.summary.critical).toBe(1);
    expect(r.findings[0].present).toBe(false);
  });

  it("runCheckModelHealth writes a Markdown report and returns its path", async () => {
    const outputDir = join(tmp, "reports", "model-health");
    const { report, reportPath } = await runCheckModelHealth({
      profile: { name: "p", model: "m", secondModel: "", thirdModel: "", toolModels: {} },
      fetchModels: async () => [makeModel("m")],
      baselinePath,
      outputDir,
    });
    expect(reportPath.startsWith(outputDir)).toBe(true);
    expect(reportPath.endsWith(".md")).toBe(true);
    const md = readFileSync(reportPath, "utf-8");
    expect(md).toContain("# Model health — profile `p`");
    expect(md).toContain("`m`");
    expect(report.summary.ok).toBe(1);
  });
});

describe("renderModelHealthMarkdown (pure)", () => {
  it("renders a table with a status per finding", () => {
    const md = renderModelHealthMarkdown({
      generatedAt: "2026-01-01T00:00:00+0000",
      profile: "p",
      baselineSeeded: false,
      findings: [
        { model: "good", roles: ["model"], present: true, baselineInputPerM: null, currentInputPerM: 0.15, baselineOutputPerM: null, currentOutputPerM: 0.6, costChanged: false, requirementsRegressions: [], severity: "ok", notes: ["healthy"] },
        { model: "gone", roles: ["tool_models.x"], present: false, baselineInputPerM: null, currentInputPerM: null, baselineOutputPerM: null, currentOutputPerM: null, costChanged: false, requirementsRegressions: [], severity: "critical", notes: ["removed"] },
      ],
      summary: { total: 2, ok: 1, warn: 0, critical: 1 },
    });
    expect(md).toContain("| `good` | model | ok |");
    expect(md).toContain("| `gone` | tool_models.x | CRITICAL |");
  });
});
