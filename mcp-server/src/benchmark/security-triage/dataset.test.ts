// Unit tests for the security-triage golden dataset loader + rubrics.
// No network — validates the shipped dataset.jsonl and the loader's strictness.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BENCHMARK_RUBRICS,
  loadDataset,
  resolveDatasetPath,
  TRIAGE_CATEGORIES,
} from "./dataset.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTmpDataset(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "triage-ds-"));
  tmpDirs.push(dir);
  const p = join(dir, "dataset.jsonl");
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  return p;
}

describe("loadDataset (shipped golden dataset)", () => {
  it("loads the shipped dataset.jsonl without error and yields cases", () => {
    const cases = loadDataset();
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it("every critical case declares an 'underflag' verdict (the mandatory floor needs it)", () => {
    const cases = loadDataset();
    const critical = cases.filter((c) => c.critical);
    expect(critical.length).toBeGreaterThan(0);
    for (const c of critical) {
      expect(c.underflag, `critical case ${c.id} must declare underflag`).toBeDefined();
    }
  });

  it("ships at least one case per provenance verdict (threat / not_threat / uncertain)", () => {
    const cases = loadDataset();
    const expectedSet = new Set(cases.map((c) => c.expected));
    expect(expectedSet.has("threat")).toBe(true);
    expect(expectedSet.has("not_threat")).toBe(true);
    expect(expectedSet.has("uncertain")).toBe(true);
  });

  it("every dataset category has a benchmark rubric", () => {
    const cases = loadDataset();
    for (const c of cases) {
      expect(BENCHMARK_RUBRICS[c.category], `missing rubric for ${c.category}`).toBeTruthy();
    }
  });

  it("the canonical TRIAGE_CATEGORIES all have a rubric", () => {
    for (const cat of TRIAGE_CATEGORIES) {
      expect(BENCHMARK_RUBRICS[cat]).toBeTruthy();
    }
  });

  it("expected is never also listed in acceptable twice (dedup) and is always first", () => {
    const cases = loadDataset();
    for (const c of cases) {
      expect(c.acceptable[0]).toBe(c.expected);
      const uniq = new Set(c.acceptable);
      expect(uniq.size).toBe(c.acceptable.length);
    }
  });
});

describe("loadDataset (strict validation)", () => {
  it("resolves a real path for the shipped dataset", () => {
    expect(resolveDatasetPath()).toMatch(/dataset\.jsonl$/);
  });

  it("skips the _schema header line", () => {
    const p = writeTmpDataset([
      JSON.stringify({ _schema: "doc" }),
      JSON.stringify({
        id: "a",
        category: "ssrf",
        snippet: "x",
        expected: "threat",
        critical: true,
        underflag: "not_threat",
        rationale: "r",
        source: "#1",
      }),
    ]);
    const cases = loadDataset(p);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("a");
  });

  it("rejects a duplicate case id", () => {
    const row = {
      id: "dup",
      category: "ssrf",
      snippet: "x",
      expected: "not_threat",
      rationale: "r",
      source: "#1",
    };
    const p = writeTmpDataset([JSON.stringify(row), JSON.stringify(row)]);
    expect(() => loadDataset(p)).toThrow(/duplicate case id/);
  });

  it("rejects a critical case with no underflag declared", () => {
    const p = writeTmpDataset([
      JSON.stringify({
        id: "c",
        category: "ssrf",
        snippet: "x",
        expected: "threat",
        critical: true,
        rationale: "r",
        source: "#1",
      }),
    ]);
    expect(() => loadDataset(p)).toThrow(/critical case must declare/);
  });

  it("rejects an invalid expected verdict", () => {
    const p = writeTmpDataset([
      JSON.stringify({
        id: "c",
        category: "ssrf",
        snippet: "x",
        expected: "maybe",
        rationale: "r",
        source: "#1",
      }),
    ]);
    expect(() => loadDataset(p)).toThrow(/expected must be/);
  });

  it("rejects malformed JSON", () => {
    const p = writeTmpDataset(["{not json}"]);
    expect(() => loadDataset(p)).toThrow(/invalid JSON/);
  });

  it("rejects an empty dataset", () => {
    const p = writeTmpDataset([JSON.stringify({ _schema: "only header" })]);
    expect(() => loadDataset(p)).toThrow(/zero cases/);
  });
});
