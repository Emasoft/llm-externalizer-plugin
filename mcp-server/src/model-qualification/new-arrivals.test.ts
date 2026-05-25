// Tests for new-arrivals autodiscovery (TRDD-828238b5 A4).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OpenRouterModel } from "../benchmark/discover.js";
import { assessModelAcrossTools } from "./assess.js";
import { registeredTools } from "./registry.js";
import {
  createdToIso,
  diffNewArrivals,
  loadSnapshot,
  saveSnapshot,
  discoverNewArrivals,
  runDiscoverNewArrivals,
  renderNewArrivalsMarkdown,
  renderNewArrivalsText,
  type CatalogSnapshot,
} from "./new-arrivals.js";

/** Build a catalog model with an optional `created` epoch (seconds). */
function makeModel(
  id: string,
  o: { inPerM?: number; outPerM?: number; ctx?: number; maxOut?: number; params?: string[]; created?: number } = {},
): OpenRouterModel {
  const inPerM = o.inPerM ?? 0.15;
  const outPerM = o.outPerM ?? 0.6;
  return {
    id,
    name: id,
    context_length: o.ctx ?? 200_000,
    pricing: { prompt: String(inPerM / 1e6), completion: String(outPerM / 1e6) },
    top_provider: { max_completion_tokens: o.maxOut ?? 100_000 },
    supported_parameters:
      o.params ?? ["structured_outputs", "response_format", "reasoning", "include_reasoning"],
    ...(o.created !== undefined ? { created: o.created } : {}),
  };
}

const emptySnapshot = (): CatalogSnapshot => ({ generatedAt: "", models: {} });

describe("createdToIso", () => {
  it("renders a positive epoch (seconds) as an ISO string", () => {
    expect(createdToIso(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it("returns null for null, zero, negative, and non-finite inputs", () => {
    expect(createdToIso(null)).toBeNull();
    expect(createdToIso(0)).toBeNull();
    expect(createdToIso(-1)).toBeNull();
    expect(createdToIso(Number.NaN)).toBeNull();
  });
});

describe("diffNewArrivals (pure)", () => {
  it("reports only ids absent from the snapshot; known ids are not arrivals", () => {
    const snap: CatalogSnapshot = { generatedAt: "", models: { "vendor/old": { created: 1 } } };
    const catalog = [makeModel("vendor/old"), makeModel("vendor/new")];
    const { arrivals } = diffNewArrivals(catalog, snap);
    expect(arrivals.map((a) => a.id)).toEqual(["vendor/new"]);
  });

  it("refreshes the snapshot to every current id with its created epoch", () => {
    const catalog = [makeModel("a", { created: 10 }), makeModel("b")];
    const { updatedSnapshot } = diffNewArrivals(catalog, emptySnapshot());
    expect(Object.keys(updatedSnapshot.models).sort()).toEqual(["a", "b"]);
    expect(updatedSnapshot.models["a"].created).toBe(10);
    expect(updatedSnapshot.models["b"].created).toBeNull();
  });

  it("sorts arrivals newest-first by created, nulls last, then by id", () => {
    const catalog = [
      makeModel("z-undated"),
      makeModel("old", { created: 100 }),
      makeModel("new", { created: 900 }),
      makeModel("a-undated"),
    ];
    const { arrivals } = diffNewArrivals(catalog, emptySnapshot());
    expect(arrivals.map((a) => a.id)).toEqual(["new", "old", "a-undated", "z-undated"]);
  });

  it("threads the per-tool assessment exactly as assessModelAcrossTools would", () => {
    const m = makeModel("vendor/full");
    const { arrivals } = diffNewArrivals([m], emptySnapshot());
    const a = arrivals[0];
    const direct = assessModelAcrossTools(m);
    expect(a.totalTools).toBe(registeredTools().length);
    expect(a.qualifiedCount).toBe(direct.qualifiedCount);
    expect(a.qualifiesForAnyTool).toBe(direct.qualifiedCount > 0);
    expect(a.benchmarkGatedQualified).toEqual(direct.benchmarkGatedQualified);
  });

  it("a fully-capable cheap model qualifies for at least one tool", () => {
    const { arrivals } = diffNewArrivals([makeModel("vendor/full", { inPerM: 0.01, outPerM: 0.01 })], emptySnapshot());
    expect(arrivals[0].qualifiesForAnyTool).toBe(true);
  });
});

describe("snapshot persistence", () => {
  const ORIG = process.env.LLM_EXT_CONFIG_DIR;
  let tmp: string;
  let snapshotPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join("/tmp", "new-arrivals-"));
    process.env.LLM_EXT_CONFIG_DIR = tmp;
    snapshotPath = join(tmp, "catalog-snapshot.json");
  });
  afterEach(() => {
    if (ORIG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG;
    else delete process.env.LLM_EXT_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips a snapshot", () => {
    const snap: CatalogSnapshot = { generatedAt: "2026-05-25T00:00:00+0200", models: { x: { created: 5 } } };
    saveSnapshot(snap, snapshotPath);
    expect(loadSnapshot(snapshotPath)).toEqual(snap);
  });

  it("returns an empty snapshot for a missing file", () => {
    expect(loadSnapshot(snapshotPath)).toEqual({ generatedAt: "", models: {} });
  });

  it("returns an empty snapshot for a corrupt file", () => {
    writeFileSync(snapshotPath, "{ not json");
    expect(loadSnapshot(snapshotPath)).toEqual({ generatedAt: "", models: {} });
  });
});

describe("discoverNewArrivals (IO orchestrator, hermetic)", () => {
  const ORIG = process.env.LLM_EXT_CONFIG_DIR;
  let tmp: string;
  let snapshotPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join("/tmp", "new-arrivals-"));
    process.env.LLM_EXT_CONFIG_DIR = tmp;
    snapshotPath = join(tmp, "catalog-snapshot.json");
  });
  afterEach(() => {
    if (ORIG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG;
    else delete process.env.LLM_EXT_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("first run seeds the snapshot and suppresses arrivals", async () => {
    const fetchModels = async () => [makeModel("a"), makeModel("b")];
    const report = await discoverNewArrivals({ fetchModels, snapshotPath });
    expect(report.snapshotSeeded).toBe(true);
    expect(report.arrivals).toEqual([]);
    expect(report.catalogSize).toBe(2);
    // snapshot now holds both ids
    expect(Object.keys(loadSnapshot(snapshotPath).models).sort()).toEqual(["a", "b"]);
  });

  it("second run reports only the genuinely-new model", async () => {
    await discoverNewArrivals({ fetchModels: async () => [makeModel("a")], snapshotPath });
    const report = await discoverNewArrivals({
      fetchModels: async () => [makeModel("a"), makeModel("b", { created: 50 })],
      snapshotPath,
    });
    expect(report.snapshotSeeded).toBe(false);
    expect(report.arrivals.map((x) => x.id)).toEqual(["b"]);
    expect(Object.keys(loadSnapshot(snapshotPath).models).sort()).toEqual(["a", "b"]);
  });

  it("qualifyingOnly filters out arrivals that fit no tool", async () => {
    await discoverNewArrivals({ fetchModels: async () => [makeModel("seed")], snapshotPath });
    const fetchModels = async () => [
      makeModel("seed"),
      makeModel("good", { inPerM: 0.01, outPerM: 0.01 }),
      makeModel("bad", { params: [], ctx: 1000, maxOut: 100, inPerM: 50, outPerM: 50 }),
    ];
    const all = await discoverNewArrivals({ fetchModels, snapshotPath, persistSnapshot: false });
    const onlyQual = await discoverNewArrivals({ fetchModels, snapshotPath, qualifyingOnly: true });
    expect(all.arrivals.map((a) => a.id).sort()).toEqual(["bad", "good"]);
    expect(onlyQual.arrivals.every((a) => a.qualifiesForAnyTool)).toBe(true);
    expect(onlyQual.arrivals.map((a) => a.id)).toContain("good");
    expect(onlyQual.arrivals.map((a) => a.id)).not.toContain("bad");
  });

  it("persistSnapshot:false leaves no snapshot file", async () => {
    await discoverNewArrivals({
      fetchModels: async () => [makeModel("a")],
      snapshotPath,
      persistSnapshot: false,
    });
    expect(loadSnapshot(snapshotPath)).toEqual({ generatedAt: "", models: {} });
  });

  it("runDiscoverNewArrivals writes a Markdown report to the output dir", async () => {
    const outputDir = join(tmp, "reports", "model-arrivals");
    const { reportPath } = await runDiscoverNewArrivals({
      fetchModels: async () => [makeModel("a")],
      snapshotPath,
      outputDir,
    });
    expect(reportPath.startsWith(outputDir)).toBe(true);
    expect(reportPath.endsWith("-new-arrivals.md")).toBe(true);
    expect(readFileSync(reportPath, "utf-8")).toContain("New OpenRouter model arrivals");
  });
});

describe("renderers", () => {
  it("markdown shows the seeded notice on first run", () => {
    const md = renderNewArrivalsMarkdown({
      generatedAt: "t",
      snapshotSeeded: true,
      catalogSize: 10,
      arrivals: [],
      summary: { total: 0, qualifying: 0 },
    });
    expect(md).toContain("seeded the catalog snapshot");
  });

  it("markdown shows a 'no new models' line when there are zero arrivals", () => {
    const md = renderNewArrivalsMarkdown({
      generatedAt: "t",
      snapshotSeeded: false,
      catalogSize: 10,
      arrivals: [],
      summary: { total: 0, qualifying: 0 },
    });
    expect(md).toContain("No new models");
  });

  it("text caps the list and notes the remainder", () => {
    const arrivals = Array.from({ length: 30 }, (_, i) => ({
      id: `m${String(i).padStart(2, "0")}`,
      name: `m${i}`,
      created: 1_000_000 - i,
      createdIso: createdToIso(1_000_000 - i),
      qualifiedCount: 0,
      totalTools: registeredTools().length,
      qualifiesForAnyTool: false,
      benchmarkGatedQualified: [],
    }));
    const txt = renderNewArrivalsText({
      generatedAt: "t",
      snapshotSeeded: false,
      catalogSize: 100,
      arrivals,
      summary: { total: 30, qualifying: 0 },
    });
    expect(txt).toContain("and 5 more");
  });
});
