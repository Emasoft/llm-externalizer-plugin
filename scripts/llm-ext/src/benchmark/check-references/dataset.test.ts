// check_references golden dataset — the ORACLE's own tests (TRDD-2G6D42LK).

import { describe, it, expect } from "vitest";

import {
  EXPECTED_BROKEN,
  exportsSymbol,
  loadDataset,
  validateDataset,
} from "./dataset.js";

describe("check-references dataset — corpus and tripwire", () => {
  it("derives a verdict for every case and agrees with the tripwire", () => {
    expect(() => validateDataset()).not.toThrow();
  });

  it("THROWS when a verdict disagrees", () => {
    const wrong = loadDataset().map((c) =>
      c.symbol === "packIntoBatches" ? { ...c, broken: false } : c,
    );
    expect(() => validateDataset(wrong)).toThrow(/verdict mismatch/);
  });

  it("the corpus KEEPS an intact binding as a negative control", () => {
    // Without one, "declare everything broken" scores perfectly. The guard lives
    // on EXPECTED_BROKEN rather than on the derived cases: behind the
    // verdict-mismatch check it was unreachable, since any all-broken case set
    // trips that check first. This test is what exposed that.
    expect(Object.values(EXPECTED_BROKEN).some((b) => !b)).toBe(true);
  });

  it("carries both a broken and an intact case", () => {
    const cases = loadDataset();
    expect(cases.some((c) => c.broken)).toBe(true);
    expect(cases.some((c) => !c.broken)).toBe(true);
    expect(Object.keys(EXPECTED_BROKEN)).toHaveLength(cases.length);
  });
});

describe("check-references dataset — what counts as an export", () => {
  it("matches a top-level declaration", () => {
    expect(exportsSymbol("export function foo() {}", "foo")).toBe(true);
    expect(exportsSymbol("export const bar = 1;", "bar")).toBe(true);
    expect(exportsSymbol("export interface Baz {}", "Baz")).toBe(true);
  });

  it("matches an export LIST, including a rename's public half", () => {
    expect(exportsSymbol("export { a, b };", "b")).toBe(true);
    expect(exportsSymbol("export { internal as publicName };", "internal")).toBe(true);
  });

  it("does NOT accept a default export for a NAMED import", () => {
    // The distinction under test: `import { foo }` is not satisfied by
    // `export default foo`.
    expect(exportsSymbol("export default foo;", "foo")).toBe(false);
  });

  it("does not match a non-exported declaration", () => {
    expect(exportsSymbol("function foo() {}", "foo")).toBe(false);
    expect(exportsSymbol("const foo = 1;", "foo")).toBe(false);
  });

  it("does not match an indented (non-top-level) declaration", () => {
    expect(exportsSymbol("  export const foo = 1;", "foo")).toBe(false);
  });

  it("does not match a prefix collision", () => {
    expect(exportsSymbol("export function fooBar() {}", "foo")).toBe(false);
  });
});
