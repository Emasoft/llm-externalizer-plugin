// Golden-corpus tests for the code_task CODE-AUDIT benchmark (P2b).
//
// These run against the REAL fixture corpus on disk (benchmark-fixtures/
// code-task/) and the REAL dataset.jsonl — nothing is mocked. They are the gate
// that keeps ground truth and corpus from drifting: a fixture that is deleted,
// renamed, edited so a buggy symbol disappears, or replaced with something the
// pipeline physically cannot read, fails here rather than silently scoring every
// model as incompetent in a paid sweep.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  CODE_AUDIT_INSTRUCTIONS,
  MIN_DISTRACTOR_SYMBOLS,
  MIN_SYMBOL_LENGTH,
  fixturePath,
  listTopLevelSymbols,
  loadDataset,
  readFixture,
  resolveFixtureRoot,
  validateDataset,
} from "./dataset.js";

describe("code-audit golden corpus", () => {
  it("loads and validates against the fixtures actually on disk", () => {
    // validateDataset enforces: every fixture exists, none is binary, every
    // buggySymbol is in that fixture's AST universe, every fixture offers ≥2
    // symbols to choose between, and both a defect and a clean case exist.
    expect(() => validateDataset()).not.toThrow();
  });

  it("has both defect cases (recall) and clean cases (precision)", () => {
    const cases = loadDataset();
    const defect = cases.filter((c) => c.buggySymbols.length > 0);
    const clean = cases.filter((c) => c.buggySymbols.length === 0);
    expect(defect.length).toBeGreaterThanOrEqual(1);
    expect(clean.length).toBeGreaterThanOrEqual(1);
    // Defect cases must outnumber clean ones: the clean fixtures are distractors
    // that measure restraint, not the thing being measured. If they dominated,
    // "say nothing" would become a viable strategy.
    expect(defect.length).toBeGreaterThan(clean.length);
  });

  it("every defect case cites its real git provenance (nothing is fabricated)", () => {
    for (const c of loadDataset()) {
      if (c.buggySymbols.length === 0) {
        expect(c.fixCommit, `${c.id} is clean and must claim no fix commit`).toBe("");
        continue;
      }
      // A defect case must be traceable back to the commit that really fixed it.
      expect(c.fixCommit, `${c.id} must name the fixing commit`).toMatch(/^[0-9a-f]{7,40}$/);
      expect(c.originalPath, `${c.id} must name the original file`).toMatch(/^mcp-server\/src\/.+\.ts$/);
      expect(c.source, `${c.id} must record the exact snapshot command`).toContain(
        `git show ${c.fixCommit}^:${c.originalPath}`,
      );
      expect(c.rationale.length).toBeGreaterThan(80);
    }
  });

  it("every buggy symbol really exists in its fixture's AST symbol universe", () => {
    const root = resolveFixtureRoot();
    for (const c of loadDataset()) {
      const universe = listTopLevelSymbols(readFixture(c, root), c.file);
      for (const s of c.buggySymbols) {
        // Truth outside the universe would be unreachable — the scorer could
        // never award recall for it, so every model would look worse than it is.
        expect(universe, `${c.id}: '${s}' must be a scorable symbol of ${c.file}`).toContain(s);
      }
      expect(universe.length, `${c.id}: ${c.file} must be scorable at all`).toBeGreaterThanOrEqual(1);
    }
  });

  it("offers a large pool of INNOCENT symbols — the corpus is a localization test, not bug/no-bug", () => {
    // The ways to be WRONG. Without them, naming every function in the file would
    // score well and the benchmark would measure nothing. This is deliberately a
    // corpus-level property, not a per-file one: ensemble-limits.ts legitimately
    // declares a single function and is a valuable DETECTION case.
    const root = resolveFixtureRoot();
    let distractors = 0;
    for (const c of loadDataset()) {
      if (c.buggySymbols.length === 0) continue;
      distractors += listTopLevelSymbols(readFixture(c, root), c.file).length - c.buggySymbols.length;
    }
    expect(distractors).toBeGreaterThanOrEqual(MIN_DISTRACTOR_SYMBOLS);
  });

  it("no fixture is binary — readFileAsCodeBlock would REFUSE to read it", () => {
    // Not hypothetical: the first draft of this corpus contained a real snapshot
    // with two NUL bytes. The pipeline's binary guard rejects such a file, so the
    // case could never be scored and every model would "fail" it.
    const root = resolveFixtureRoot();
    for (const c of loadDataset()) {
      expect(readFileSync(fixturePath(c, root)).includes(0), `${c.file} must not contain NUL`).toBe(
        false,
      );
    }
  });

  it("the audit instructions carry the machine-parseable anchor the scorer relies on", () => {
    // The DEFECT:/NO DEFECTS contract is what lets the scorer be pure code. If it
    // is ever dropped from the instructions, every run silently degrades to the
    // free-text extractor — so pin it.
    expect(CODE_AUDIT_INSTRUCTIONS).toContain("DEFECT: <functionName>");
    expect(CODE_AUDIT_INSTRUCTIONS).toContain("NO DEFECTS");
    // And it must scope the audit to real bugs, or the clean fixtures just
    // measure how chatty a model is about style.
    expect(CODE_AUDIT_INSTRUCTIONS).toMatch(/Do NOT report style/);
  });
});

describe("listTopLevelSymbols", () => {
  it("finds top-level functions, arrow consts, and classes", () => {
    const src = [
      "export function alpha(): void {}",
      "function bravo() { return 1; }",
      "export const charlie = (x: number) => x + 1;",
      "const delta = function () { return 2; };",
      "export class Echo { foxtrot() { return 3; } }",
    ].join("\n");
    expect(listTopLevelSymbols(src)).toEqual(["Echo", "alpha", "bravo", "charlie", "delta"]);
  });

  it("excludes class METHODS — their names collide with ordinary English", () => {
    // `find`, `union`, `get` etc. as method names would make the free-text
    // extractor read "could not find any bug" as an accusation of `find`.
    const src = "export class Store { find() {} union() {} }";
    expect(listTopLevelSymbols(src)).toEqual(["Store"]);
  });

  it("excludes nested helpers — only top-level declarations are scorable", () => {
    const src = "export function outer() { function innerHelper() {} return innerHelper; }";
    expect(listTopLevelSymbols(src)).toEqual(["outer"]);
  });

  it(`excludes names shorter than ${MIN_SYMBOL_LENGTH} chars`, () => {
    const src = "function ok() {} function fine() {} const id = (x: number) => x;";
    // `ok` and `id` are dropped; `fine` survives. Short identifiers are ordinary
    // English words and would manufacture phantom findings.
    expect(listTopLevelSymbols(src)).toEqual(["fine"]);
  });

  it("dedupes and sorts (the universe is a set, not a transcript)", () => {
    const src = "function alpha() {}\nfunction zulu() {}\nfunction alpha() {}";
    expect(listTopLevelSymbols(src)).toEqual(["alpha", "zulu"]);
  });
});
