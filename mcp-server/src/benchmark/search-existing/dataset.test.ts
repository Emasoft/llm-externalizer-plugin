// Tests for the search-existing golden dataset (TRDD-828238b5 A6).
// Each test's name string is its one-line description.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SEARCH_EXISTING_CASES,
  listFixtureFiles,
  resolveFixtureRoot,
  validateDataset,
} from "./dataset.js";

describe("search-existing fixture corpus", () => {
  it("resolves the on-disk fixture root next to the package", () => {
    const root = resolveFixtureRoot();
    expect(existsSync(root)).toBe(true);
    expect(root).toContain("benchmark-fixtures");
  });

  it("lists exactly the authored fixture files (10, tsconfig excluded)", () => {
    const files = listFixtureFiles();
    expect(files).toEqual([
      "src/auth/token.ts",
      "src/cache/lru.ts",
      "src/cache/memo.ts",
      "src/http/client.ts",
      "src/http/retry.ts",
      "src/legacy/retry_old.py",
      "src/log/logger.ts",
      "src/util/chunk.ts",
      "src/util/debounce.ts",
      "src/util/slug.ts",
    ]);
  });
});

describe("search-existing golden dataset", () => {
  it("validates cleanly against the on-disk fixture (no drift)", () => {
    expect(() => validateDataset()).not.toThrow();
  });

  it("has unique, kebab-case case ids", () => {
    const ids = SEARCH_EXISTING_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("gives every case a non-empty feature description and rationale", () => {
    for (const c of SEARCH_EXISTING_CASES) {
      expect(c.featureDescription.trim().length).toBeGreaterThan(20);
      expect(c.rationale.trim().length).toBeGreaterThan(10);
    }
  });

  it("includes at least one absent-feature case to measure hallucination", () => {
    expect(
      SEARCH_EXISTING_CASES.some((c) => c.expectedYes.length === 0),
    ).toBe(true);
  });

  it("includes a multi-match case exercising the EXHAUSTIVE output rule", () => {
    expect(
      SEARCH_EXISTING_CASES.some(
        (c) => !c.sourceFiles && c.expectedYes.length >= 2,
      ),
    ).toBe(true);
  });

  it("includes a source_files self-exclusion case whose reference exists", () => {
    const selfRef = SEARCH_EXISTING_CASES.find(
      (c) => (c.sourceFiles ?? []).length > 0,
    );
    expect(selfRef).toBeDefined();
    const root = resolveFixtureRoot();
    for (const rel of selfRef?.sourceFiles ?? []) {
      expect(existsSync(join(root, rel))).toBe(true);
      expect(selfRef?.expectedYes).not.toContain(rel);
    }
  });

  it("detects on-disk drift: a fabricated expectation path must throw", () => {
    const root = resolveFixtureRoot();
    // validateDataset(root) is the live check; simulate drift via a bogus root.
    expect(() => validateDataset(join(root, "no-such-subdir"))).toThrow(
      /missing on disk/,
    );
  });
});
