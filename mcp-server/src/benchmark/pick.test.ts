// Unit tests for pick.ts — the deterministic top-N model picker + the
// atomic settings.yaml mutator. No network, no external state.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPicksToSettings,
  loadCachedReport,
  pickTopN,
  renderEnsembleBlock,
  type CachedResult,
} from "./pick.js";

function makeResult(overrides: Partial<CachedResult>): CachedResult {
  return {
    modelId: "vendor/model",
    name: "Model",
    isBaseline: false,
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    inputDollarsPerMillion: 0.5,
    outputDollarsPerMillion: 0.8,
    supportsStructured: true,
    supportsReasoning: true,
    ok: true,
    pass: true,
    meanF1: 1.0,
    kw1F1: 1.0,
    kw2F1: 1.0,
    kw3F1: 1.0,
    schemaCompliant: true,
    inputTokens: 1000,
    outputTokens: 500,
    reasoningTokens: 0,
    latencyMs: 2000,
    actualCost: 0.005,
    providerFinishReason: "stop",
    hallucinatedNames: [],
    ...overrides,
  };
}

describe("pickTopN", () => {
  it("returns top-3 sorted by meanF1 desc, then cost asc", () => {
    const results = [
      makeResult({ modelId: "a", meanF1: 1.0, actualCost: 0.01 }),
      makeResult({ modelId: "b", meanF1: 1.0, actualCost: 0.005 }), // same F1, lower cost
      makeResult({ modelId: "c", meanF1: 0.99, actualCost: 0.001 }),
      makeResult({ modelId: "d", meanF1: 1.0, actualCost: 0.02 }),
    ];
    const picks = pickTopN(results, { topN: 3, minMeanF1: 0.95, requireSchema: true });
    expect(picks.map((p) => p.modelId)).toEqual(["b", "a", "d"]);
  });

  it("ties on F1 + cost broken by latency", () => {
    const results = [
      makeResult({ modelId: "slow", meanF1: 1.0, actualCost: 0.01, latencyMs: 5000 }),
      makeResult({ modelId: "fast", meanF1: 1.0, actualCost: 0.01, latencyMs: 1000 }),
    ];
    const picks = pickTopN(results, { topN: 2, minMeanF1: 0.95, requireSchema: true });
    expect(picks.map((p) => p.modelId)).toEqual(["fast", "slow"]);
  });

  it("drops baselines", () => {
    const results = [
      makeResult({ modelId: "incumbent", meanF1: 1.0, isBaseline: true }),
      makeResult({ modelId: "challenger-a", meanF1: 0.97, actualCost: 0.003 }),
      makeResult({ modelId: "challenger-b", meanF1: 0.96, actualCost: 0.002 }),
      makeResult({ modelId: "challenger-c", meanF1: 0.95, actualCost: 0.001 }),
    ];
    const picks = pickTopN(results, { topN: 3, minMeanF1: 0.95, requireSchema: true });
    expect(picks.map((p) => p.modelId)).toEqual(["challenger-a", "challenger-b", "challenger-c"]);
  });

  it("drops failed runs", () => {
    const results = [
      makeResult({ modelId: "broken", ok: false }),
      makeResult({ modelId: "good-a", meanF1: 1.0 }),
      makeResult({ modelId: "good-b", meanF1: 1.0, actualCost: 0.01 }),
      makeResult({ modelId: "good-c", meanF1: 0.99, actualCost: 0.001 }),
    ];
    const picks = pickTopN(results, { topN: 3, minMeanF1: 0.95, requireSchema: true });
    expect(picks.map((p) => p.modelId).includes("broken")).toBe(false);
  });

  it("drops models below minMeanF1", () => {
    const results = [
      makeResult({ modelId: "above", meanF1: 0.96 }),
      makeResult({ modelId: "below", meanF1: 0.94 }),
      makeResult({ modelId: "fine-a", meanF1: 1.0 }),
      makeResult({ modelId: "fine-b", meanF1: 0.97, actualCost: 0.01 }),
    ];
    const picks = pickTopN(results, { topN: 3, minMeanF1: 0.95, requireSchema: true });
    expect(picks.map((p) => p.modelId).includes("below")).toBe(false);
  });

  it("drops schemaCompliant=false when requireSchema=true", () => {
    const results = [
      makeResult({ modelId: "loose", schemaCompliant: false, meanF1: 1.0 }),
      makeResult({ modelId: "strict-a", schemaCompliant: true, meanF1: 0.97 }),
      makeResult({ modelId: "strict-b", schemaCompliant: true, meanF1: 0.96 }),
      makeResult({ modelId: "strict-c", schemaCompliant: true, meanF1: 0.95 }),
    ];
    const picks = pickTopN(results, { topN: 3, minMeanF1: 0.95, requireSchema: true });
    expect(picks.map((p) => p.modelId).includes("loose")).toBe(false);
  });

  it("keeps schemaCompliant=false when requireSchema=false", () => {
    const results = [
      makeResult({ modelId: "loose", schemaCompliant: false, meanF1: 1.0 }),
      makeResult({ modelId: "strict-a", schemaCompliant: true, meanF1: 0.97 }),
      makeResult({ modelId: "strict-b", schemaCompliant: true, meanF1: 0.96 }),
    ];
    const picks = pickTopN(results, { topN: 3, minMeanF1: 0.95, requireSchema: false });
    expect(picks.map((p) => p.modelId)).toEqual(["loose", "strict-a", "strict-b"]);
  });

  it("throws when fewer than N qualify", () => {
    const results = [
      makeResult({ modelId: "only-one", meanF1: 1.0 }),
    ];
    expect(() => pickTopN(results, { topN: 3, minMeanF1: 0.95, requireSchema: true })).toThrow(
      /only 1 model\(s\) cleared/,
    );
  });
});

describe("renderEnsembleBlock", () => {
  it("3 picks → mode: remote-ensemble with all three model slots", () => {
    const picks = [
      { modelId: "vendor/a", meanF1: 1.0, actualCost: 0.01, latencyMs: 100, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
      { modelId: "vendor/b", meanF1: 1.0, actualCost: 0.01, latencyMs: 100, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
      { modelId: "vendor/c", meanF1: 0.99, actualCost: 0.01, latencyMs: 100, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
    ];
    const yaml = renderEnsembleBlock("my-profile", picks);
    expect(yaml).toContain("my-profile:");
    expect(yaml).toContain("mode: remote-ensemble");
    expect(yaml).toContain("model: vendor/a");
    expect(yaml).toContain("second_model: vendor/b");
    expect(yaml).toContain("third_model: vendor/c");
    expect(yaml).toContain("api: openrouter-remote");
    expect(yaml).toContain("api_key:");
  });

  it("1 pick → mode: remote (no ensemble), no second_model/third_model", () => {
    const picks = [
      { modelId: "vendor/solo", meanF1: 1.0, actualCost: 0.01, latencyMs: 100, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
    ];
    const yaml = renderEnsembleBlock("solo", picks);
    expect(yaml).toContain("mode: remote");
    expect(yaml).not.toContain("second_model");
    expect(yaml).not.toContain("third_model");
  });

  it("throws on empty pick list", () => {
    expect(() => renderEnsembleBlock("x", [])).toThrow(/need at least one pick/);
  });
});

describe("applyPicksToSettings", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pick-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSettings(content: string): string {
    const path = join(tmp, "settings.yaml");
    writeFileSync(path, content);
    return path;
  }

  it("updates an existing ensemble profile in-place, preserving other profiles + active:", () => {
    const settingsPath = writeSettings(
      `active: prod-ensemble
profiles:
  local-stub:
    mode: local
    api: lmstudio-local
    model: test
  prod-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model: old/a
    second_model: old/b
    third_model: old/c
    api_key: $OPENROUTER_API_KEY
`,
    );
    const picks = [
      { modelId: "new/x", meanF1: 1.0, actualCost: 0, latencyMs: 0, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
      { modelId: "new/y", meanF1: 1.0, actualCost: 0, latencyMs: 0, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
      { modelId: "new/z", meanF1: 0.99, actualCost: 0, latencyMs: 0, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
    ];
    const result = applyPicksToSettings(settingsPath, "prod-ensemble", picks);
    expect(result.oldEnsemble).toEqual({ model: "old/a", second_model: "old/b", third_model: "old/c" });
    expect(result.newEnsemble).toEqual({ model: "new/x", second_model: "new/y", third_model: "new/z" });
    const after = readFileSync(settingsPath, "utf-8");
    expect(after).toContain("active: prod-ensemble");
    expect(after).toContain("local-stub:");
    expect(after).toContain("model: new/x");
    expect(after).toContain("second_model: new/y");
    expect(after).toContain("third_model: new/z");
    expect(after).not.toContain("old/a");
  });

  it("downgrades to single-model when given 1 pick: drops second_model + third_model + sets mode: remote", () => {
    const settingsPath = writeSettings(
      `active: x
profiles:
  x:
    mode: remote-ensemble
    api: openrouter-remote
    model: old/a
    second_model: old/b
    third_model: old/c
    api_key: $OPENROUTER_API_KEY
`,
    );
    const picks = [
      { modelId: "solo/only", meanF1: 1.0, actualCost: 0, latencyMs: 0, inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.6 },
    ];
    applyPicksToSettings(settingsPath, "x", picks);
    const after = readFileSync(settingsPath, "utf-8");
    expect(after).toContain("mode: remote");
    expect(after).not.toContain("second_model");
    expect(after).not.toContain("third_model");
    expect(after).toContain("model: solo/only");
  });

  it("throws when profile doesn't exist, lists available", () => {
    const settingsPath = writeSettings(
      `active: a
profiles:
  a:
    mode: remote
    api: openrouter-remote
    model: x
`,
    );
    const picks = [{ modelId: "y", meanF1: 1, actualCost: 0, latencyMs: 0, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }];
    expect(() => applyPicksToSettings(settingsPath, "nonexistent", picks)).toThrow(/no profile named 'nonexistent'/);
  });

  it("throws on malformed YAML, preserves cause", () => {
    const settingsPath = writeSettings(": : : not valid yaml: [unclosed");
    const picks = [{ modelId: "x", meanF1: 1, actualCost: 0, latencyMs: 0, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }];
    expect(() => applyPicksToSettings(settingsPath, "any", picks)).toThrow();
  });

  it("throws when picks is empty", () => {
    const settingsPath = writeSettings(
      `profiles:
  x:
    mode: remote
    api: openrouter-remote
    model: y
`,
    );
    expect(() => applyPicksToSettings(settingsPath, "x", [])).toThrow(/need at least one pick/);
  });
});

describe("loadCachedReport", () => {
  let tmp = "";
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pick-cache-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("loads a valid cache file", () => {
    const path = join(tmp, "c.json");
    writeFileSync(path, JSON.stringify({
      timestamp: "t",
      keywords: ["k"],
      groundTruth: {},
      roster: { candidates: [], baselines: [] },
      results: [makeResult({})],
    }));
    const r = loadCachedReport(path);
    expect(r.results).toHaveLength(1);
  });

  it("throws on missing file with a helpful message", () => {
    expect(() => loadCachedReport(join(tmp, "missing.json"))).toThrow(/No cached benchmark results/);
  });

  it("throws on malformed JSON", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, "not json");
    expect(() => loadCachedReport(path)).toThrow(/not valid JSON/);
  });

  it("throws on missing results array", () => {
    const path = join(tmp, "weird.json");
    writeFileSync(path, JSON.stringify({ timestamp: "t" }));
    expect(() => loadCachedReport(path)).toThrow(/missing 'results' array/);
  });
});
