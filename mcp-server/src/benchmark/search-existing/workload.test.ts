// Tests for describeWorkload() — the P4 pre-flight spend-estimate seam for the
// search_existing_implementations benchmark.
//
// Nothing here is mocked: describeWorkload() reads the REAL fixture corpus off
// disk and replays the REAL FFD bin-packing helper (readAndGroupFiles) the
// pipeline itself uses, exactly as runner.ts does for a real sweep. These
// tests exist to prove the numbers are DERIVED from that corpus (not a stub
// returning hardcoded literals) and that computing them never touches the
// network.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describeWorkload } from "./index.js";
import { SEARCH_EXISTING_MAX_OUTPUT_TOKENS } from "./runner.js";
import { SEARCH_EXISTING_CASES, resolveFixtureRoot, listFixtureFiles } from "./dataset.js";
import { readAndGroupFiles, DEFAULT_MAX_PAYLOAD_BYTES } from "../../scan-pipeline.js";

describe("describeWorkload (search-existing)", () => {
  it("callsPerModel matches the REAL dataset exports (so a corpus edit updates the estimate automatically)", () => {
    const root = resolveFixtureRoot();
    const allFixtureRel = listFixtureFiles(root);
    // Independently reproduce the per-case scan set (same filter runner.ts
    // applies: extension match, minus the case's reference source_files) and
    // the real FFD bin-packing helper, WITHOUT depending on describeWorkload's
    // internal fixed-overhead constant — the fixture corpus (~11 KB) is so far
    // below the 400 KB budget that any reasonable promptBytes offset collapses
    // every case to the same batch count.
    let expectedCalls = 0;
    for (const c of SEARCH_EXISTING_CASES) {
      const sourceRel = new Set(c.sourceFiles ?? []);
      const scannedAbs = allFixtureRel
        .filter((rel) => c.extensions.some((ext) => rel.endsWith(ext)))
        .filter((rel) => !sourceRel.has(rel))
        .map((rel) => resolve(root, rel));
      const { groups } = readAndGroupFiles(scannedAbs, 0, false, DEFAULT_MAX_PAYLOAD_BYTES, null);
      expectedCalls += groups.length;
    }

    const w = describeWorkload();
    expect(w.tool).toBe("search_existing_implementations");
    expect(w.benchmark).toBe("search-existing");
    // Sanity floor: if this were ever 0, the equality below would pass vacuously.
    expect(expectedCalls).toBeGreaterThan(0);
    expect(w.callsPerModel).toBe(expectedCalls);
  });

  it("promptCharsPerModel is positive and exceeds the raw character count of every fixture file it sends (proves it isn't a stub)", () => {
    const root = resolveFixtureRoot();
    const allFixtureRel = listFixtureFiles(root);
    let totalRawChars = 0;
    for (const c of SEARCH_EXISTING_CASES) {
      const sourceRel = new Set(c.sourceFiles ?? []);
      const scannedRel = allFixtureRel
        .filter((rel) => c.extensions.some((ext) => rel.endsWith(ext)))
        .filter((rel) => !sourceRel.has(rel));
      for (const rel of scannedRel) {
        totalRawChars += readFileSync(resolve(root, rel), "utf-8").length;
      }
    }

    const w = describeWorkload();
    expect(w.promptCharsPerModel).toBeGreaterThan(0);
    // Every call wraps the raw file content in <filename>/<file-content> tags
    // and a fenced code block, plus the fixed instructions overhead — so the
    // total must strictly exceed the raw fixture character count alone.
    expect(w.promptCharsPerModel).toBeGreaterThan(totalRawChars);
  });

  it("maxOutputTokensPerCall is the SAME constant the real runner puts on the wire", () => {
    const w = describeWorkload();
    expect(w.maxOutputTokensPerCall).toBe(SEARCH_EXISTING_MAX_OUTPUT_TOKENS);
  });

  it("is synchronous and never throws — it reads local fixtures only, no network call", () => {
    const result = describeWorkload();
    // A Promise return would mean an async/network seam crept in; a pre-flight
    // spend estimate must never wait on the network to compute itself.
    expect(result).not.toBeInstanceOf(Promise);
    expect(() => describeWorkload()).not.toThrow();
  });
});
