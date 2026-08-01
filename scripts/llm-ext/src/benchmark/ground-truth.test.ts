/**
 * Unit tests for the benchmark ground-truth extractor (buildGroundTruth).
 *
 * buildGroundTruth reads real .ts fixture files from a directory, walks
 * each file's TypeScript AST, and classifies every top-level function by
 * which keyword substring appears in its body. The only "I/O" is reading
 * fixture files we write ourselves into a real temp dir — so every test
 * writes real source text and asserts against the real classification.
 * Nothing in the unit under test is mocked; the TypeScript parser and the
 * filesystem run for real. extractNameAndBody is exercised transitively
 * (it is not exported).
 *
 * Coverage focus: keyword-bucket classification + alphabetical sorting,
 * arrow/function-expression detection, multi-declarator const statements,
 * noise (no-keyword) functions, cross-file aggregation in sorted order,
 * the wrong-keyword-count guard, the multi-keyword ambiguity throw, and
 * degenerate cases (empty dir, non-.ts files ignored, class methods and
 * nested helpers intentionally ignored).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGroundTruth, BENCHMARK_KEYWORDS } from "./ground-truth.js";

// Track every temp dir we create so afterEach can remove it — no fixture
// survives a test, so runs are deterministic and leave nothing on disk.
const tmpDirs: string[] = [];

/** Create a fresh temp dir and register it for cleanup. */
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gt-test-"));
  tmpDirs.push(d);
  return d;
}

/** Write a .ts fixture file into `dir` and return its full path. */
function writeFixture(dir: string, filename: string, source: string): string {
  const p = join(dir, filename);
  writeFileSync(p, source, "utf-8");
  return p;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildGroundTruth", () => {
  it("classifies each top-level function under the keyword its body contains", () => {
    const dir = freshDir();
    writeFixture(
      dir,
      "file-01.ts",
      [
        "function parsesJson(s: string) { return JSON.parse(s); }",
        "function buildsParams() { return new URLSearchParams({ a: '1' }); }",
        "function timesIt() { const t = performance.now(); return t; }",
      ].join("\n"),
    );

    const gt = buildGroundTruth(dir);

    // keywordFunctions[i] corresponds to BENCHMARK_KEYWORDS[i].
    expect(gt.keywords).toEqual(BENCHMARK_KEYWORDS);
    expect(gt.keywordFunctions[0]).toEqual(["parsesJson"]); // JSON.parse(
    expect(gt.keywordFunctions[1]).toEqual(["buildsParams"]); // new URLSearchParams
    expect(gt.keywordFunctions[2]).toEqual(["timesIt"]); // performance.now()
    expect(gt.noiseFunctions).toEqual([]);
    expect(gt.allFunctions).toEqual(["buildsParams", "parsesJson", "timesIt"]);
  });

  it("detects arrow-function and function-expression const declarations", () => {
    const dir = freshDir();
    writeFixture(
      dir,
      "file-01.ts",
      [
        "const arrowParse = (s: string) => { return JSON.parse(s); };",
        "const exprTimer = function () { return performance.now(); };",
      ].join("\n"),
    );

    const gt = buildGroundTruth(dir);

    expect(gt.keywordFunctions[0]).toEqual(["arrowParse"]); // arrow body matched JSON.parse(
    expect(gt.keywordFunctions[2]).toEqual(["exprTimer"]); // function-expr body matched performance.now()
    expect(gt.fixtures[0].functionNames).toEqual(["arrowParse", "exprTimer"]);
  });

  it("puts keyword-free functions in noise and captures every declarator in a multi-const statement", () => {
    const dir = freshDir();
    writeFixture(
      dir,
      "file-01.ts",
      [
        // single VariableStatement declaring two arrow functions
        "const noiseA = () => { return 1 + 1; }, parseB = (s: string) => { return JSON.parse(s); };",
        "function plainNoise() { return 'hello'; }",
      ].join("\n"),
    );

    const gt = buildGroundTruth(dir);

    // Both declarators in the one `const a = ..., b = ...;` statement are seen.
    expect(gt.fixtures[0].functionNames).toContain("noiseA");
    expect(gt.fixtures[0].functionNames).toContain("parseB");
    // noiseA + plainNoise have no keyword; parseB matches JSON.parse(.
    expect(gt.noiseFunctions).toEqual(["noiseA", "plainNoise"]);
    expect(gt.keywordFunctions[0]).toEqual(["parseB"]);
  });

  it("aggregates functions across files and returns every output array alphabetically sorted", () => {
    const dir = freshDir();
    // Declaration + filename order is deliberately NOT alphabetical so the
    // test fails if the sort step (lines 111-117) is removed.
    writeFixture(
      dir,
      "file-02.ts",
      "function zeta() { return JSON.parse('{}'); }\nfunction alpha() { return JSON.parse('[]'); }",
    );
    writeFixture(
      dir,
      "file-01.ts",
      "function mid() { return performance.now(); }",
    );

    const gt = buildGroundTruth(dir);

    // Files are read in sorted order: file-01.ts before file-02.ts.
    expect(gt.fixtures.map((f) => f.filename)).toEqual(["file-01.ts", "file-02.ts"]);
    // JSON.parse bucket sorted alphabetically despite zeta declared first.
    expect(gt.keywordFunctions[0]).toEqual(["alpha", "zeta"]);
    expect(gt.keywordFunctions[2]).toEqual(["mid"]);
    // allFunctions is the sorted union across both files.
    expect(gt.allFunctions).toEqual(["alpha", "mid", "zeta"]);
  });

  it("throws when the keyword list does not contain exactly three entries", () => {
    const dir = freshDir();
    writeFixture(dir, "file-01.ts", "function f() { return 1; }");

    expect(() => buildGroundTruth(dir, ["only", "two"])).toThrow(
      "expected exactly 3 keywords, got 2",
    );
    expect(() => buildGroundTruth(dir, ["a", "b", "c", "d"])).toThrow(
      "expected exactly 3 keywords, got 4",
    );
  });

  it("throws an ambiguity error naming the function that matches more than one keyword", () => {
    const dir = freshDir();
    writeFixture(
      dir,
      "file-01.ts",
      "function doesBoth(s: string) { const v = JSON.parse(s); return performance.now() + v; }",
    );

    let err: unknown;
    try {
      buildGroundTruth(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("multiple keywords (ambiguous ground truth)");
    expect(msg).toContain("doesBoth");
    expect(msg).toContain("JSON.parse(");
    expect(msg).toContain("performance.now()");
  });

  it("ignores non-.ts files, class methods, and nested helpers, and handles an empty directory", () => {
    const emptyDir = freshDir();
    const emptyGt = buildGroundTruth(emptyDir);
    expect(emptyGt.allFunctions).toEqual([]);
    expect(emptyGt.fixtures).toEqual([]);
    expect(emptyGt.noiseFunctions).toEqual([]);
    expect(emptyGt.keywordFunctions).toEqual([[], [], []]);

    const dir = freshDir();
    // A subdirectory and a non-.ts file must both be skipped by the filter.
    mkdirSync(join(dir, "nested-dir"));
    writeFixture(dir, "notes.md", "function shouldBeIgnored() { JSON.parse('{}'); }");
    writeFixture(
      dir,
      "file-01.ts",
      [
        "class Widget {",
        "  method() { return JSON.parse('{}'); }", // class method: not its own entry
        "}",
        "function topLevel() {",
        "  function nestedHelper() { return 42; }", // nested fn: not its own entry
        "  return nestedHelper();",
        "}",
      ].join("\n"),
    );

    const gt = buildGroundTruth(dir);

    // Only the single top-level function declaration becomes an entry — the
    // class method and the nested helper do NOT appear as separate functions.
    expect(gt.allFunctions).toEqual(["topLevel"]);
    expect(gt.fixtures).toHaveLength(1);
    expect(gt.fixtures[0].filename).toBe("file-01.ts");
    // topLevel's body text contains no keyword, so it is classified as noise.
    // (Note: the extractor slices the WHOLE body string, so a keyword inside a
    // nested helper would still count toward the parent — kept keyword-free here.)
    expect(gt.noiseFunctions).toEqual(["topLevel"]);
    expect(gt.keywordFunctions).toEqual([[], [], []]);
  });
});
