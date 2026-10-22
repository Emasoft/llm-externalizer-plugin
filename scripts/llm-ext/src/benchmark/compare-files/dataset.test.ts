// compare_files golden dataset — the ORACLE's own tests (TRDD-2G6D42LK).
//
// Two oracle defects were found by MEASURING this corpus rather than reasoning
// about it, and both are pinned here so they cannot return.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXPECTED_SYMBOL_COUNTS,
  FIXTURE_DIR,
  deriveChangedSymbols,
  loadDataset,
  validateDataset,
} from "./dataset.js";

describe("compare-files dataset — corpus and tripwire", () => {
  it("derives a truth for every fixture and agrees with the tripwire", () => {
    expect(() => validateDataset()).not.toThrow();
  });

  it("THROWS when derived truth and tripwire disagree", () => {
    const wrong = loadDataset().map((c) =>
      c.id === "fb6d782" ? { ...c, changedSymbols: [] } : c,
    );
    expect(() => validateDataset(wrong)).toThrow(/tripwire says/);
  });

  it("EVERY fixture carries a non-empty truth set", () => {
    // DEFECT 1, measured: three original fixtures derived ZERO symbols (their
    // diffs changed logic inside existing functions). Recall over an empty set
    // is vacuously 1, so those cases would have inflated every score. They were
    // replaced with declaration-bearing commits, and this is the guard.
    for (const c of loadDataset()) {
      expect(c.changedSymbols.length, `${c.id} has symbols`).toBeGreaterThan(0);
    }
  });
});

describe("compare-files dataset — top-level only", () => {
  it("does NOT report locals from inside function bodies", () => {
    // DEFECT 2, measured: an earlier rule matched a declaration anywhere on a
    // touched line and returned `c`, `empty`, `cases` from test bodies. No
    // useful summary names a local called `c`.
    const indented = "+  const c = 1;\n+    function helper() {}\n";
    expect(deriveChangedSymbols(indented)).toEqual([]);
  });

  it("reports a top-level declaration, exported or not", () => {
    expect(deriveChangedSymbols("+export function foo() {}")).toEqual(["foo"]);
    expect(deriveChangedSymbols("-const bar = 1;")).toEqual(["bar"]);
    expect(deriveChangedSymbols("+export interface Baz {}")).toEqual(["Baz"]);
  });

  it("ignores +++/--- file headers, which are not content", () => {
    expect(deriveChangedSymbols("+++ b/src/const-thing.ts\n--- a/src/x.ts")).toEqual([]);
  });

  it("ignores context lines — only +/- count", () => {
    expect(deriveChangedSymbols(" const untouched = 1;")).toEqual([]);
  });

  it("deduplicates a symbol touched on both sides of a change", () => {
    expect(deriveChangedSymbols("-export const x = 1;\n+export const x = 2;")).toEqual(["x"]);
  });

  it("finds real exported API in a real fixture", () => {
    const diff = readFileSync(join(FIXTURE_DIR, "fb6d782.diff"), "utf-8");
    expect(deriveChangedSymbols(diff)).toContain("buildCheckImportsExtractMessages");
  });

  it("covers every fixture named by the tripwire", () => {
    expect(loadDataset().map((c) => c.id).sort()).toEqual(
      Object.keys(EXPECTED_SYMBOL_COUNTS).sort(),
    );
  });
});
