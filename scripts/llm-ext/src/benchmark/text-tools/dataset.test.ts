// Golden-corpus tests for the four text-tool benchmarks (summarize / topics /
// sem_deduplicate / describe). Every case here is hand-authored (dataset.ts) —
// these tests are the gate that keeps the corpus internally consistent: no
// duplicate ids, no empty answer keys, and semDedupInput's interleaving
// preserving every phrase exactly once. Nothing is mocked; pure data checks.

import { describe, it, expect } from "vitest";

import {
  DESCRIBE_CASES,
  SEM_DEDUP_CASES,
  SUMMARIZE_CASES,
  TOPICS_CASES,
  semDedupInput,
} from "./dataset.js";

describe("case ids are unique within each dataset", () => {
  it("SUMMARIZE_CASES has no duplicate ids", () => {
    const ids = SUMMARIZE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("TOPICS_CASES has no duplicate ids", () => {
    const ids = TOPICS_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SEM_DEDUP_CASES has no duplicate ids", () => {
    const ids = SEM_DEDUP_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DESCRIBE_CASES has no duplicate ids", () => {
    const ids = DESCRIBE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sem_deduplicate corpus", () => {
  it("every cluster in every case is non-empty", () => {
    for (const c of SEM_DEDUP_CASES) {
      expect(c.clusters.length, `${c.id} must declare at least one cluster`).toBeGreaterThan(0);
      for (const cl of c.clusters) {
        expect(cl.length, `${c.id}: every cluster must hold at least one phrase`).toBeGreaterThan(0);
      }
    }
  });

  it("semDedupInput interleaves round-robin and contains every phrase exactly once", () => {
    for (const c of SEM_DEDUP_CASES) {
      const flatClusters = c.clusters.flat();
      const input = semDedupInput(c);
      // Same multiset of phrases, nothing dropped, nothing duplicated.
      expect(input.length).toBe(flatClusters.length);
      expect([...input].sort()).toEqual([...flatClusters].sort());
      // Interleaved, not just concatenated: a cluster's own first and second
      // phrase are never adjacent in the output — every OTHER cluster's first
      // phrase is interposed between them by the round-robin.
      for (const cl of c.clusters) {
        if (cl.length < 2) continue;
        const idx0 = input.indexOf(cl[0]);
        const idx1 = input.indexOf(cl[1]);
        expect(Math.abs(idx1 - idx0), `${c.id}: '${cl[0]}' and '${cl[1]}' must not be adjacent`).toBeGreaterThan(1);
      }
    }
  });
});

describe("concept answer keys are non-empty", () => {
  it("every SUMMARIZE_CASES concept has at least one acceptable surface form", () => {
    for (const c of SUMMARIZE_CASES) {
      expect(c.concepts.length, `${c.id} must declare concepts`).toBeGreaterThan(0);
      for (const forms of c.concepts) expect(forms.length).toBeGreaterThan(0);
    }
  });

  it("every TOPICS_CASES concept has at least one acceptable surface form, and a language", () => {
    for (const c of TOPICS_CASES) {
      expect(c.language.length, `${c.id} must declare acceptable language spellings`).toBeGreaterThan(0);
      expect(c.concepts.length, `${c.id} must declare concepts`).toBeGreaterThan(0);
      for (const forms of c.concepts) expect(forms.length).toBeGreaterThan(0);
    }
  });

  it("every DESCRIBE_CASES concept has at least one acceptable surface form", () => {
    for (const c of DESCRIBE_CASES) {
      expect(c.concepts.length, `${c.id} must declare concepts`).toBeGreaterThan(0);
      for (const forms of c.concepts) expect(forms.length).toBeGreaterThan(0);
    }
  });
});
