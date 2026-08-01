// Tests for describeWorkload() — the P4 pre-flight spend-estimate seam for the
// scan_folder (MASS SEARCH) benchmark.
//
// Nothing here is mocked: describeWorkload() reads the REAL fixture corpus off
// disk, exactly as bench-runner.ts does for a real sweep. These tests exist to
// prove the numbers are DERIVED from that corpus (not a stub returning hardcoded
// literals) and that computing them never touches the network.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { describeWorkload } from "./index.js";
import { SCAN_FOLDER_MAX_OUTPUT_TOKENS } from "./bench-runner.js";
import {
  SCAN_FOLDER_CASES,
  fixtureAbsPath,
  resolveFixtureRoot,
  scannedFilesFor,
} from "./dataset.js";

describe("describeWorkload", () => {
  it("callsPerModel is cases x files, recomputed from the REAL dataset exports (a corpus edit moves it)", () => {
    const root = resolveFixtureRoot();
    const expectedCalls = SCAN_FOLDER_CASES.reduce(
      (n, c) => n + scannedFilesFor(c, root).length,
      0,
    );

    const w = describeWorkload();
    expect(w.tool).toBe("scan_folder");
    expect(w.benchmark).toBe("scan-folder");
    // Sanity floor: if this were ever 0, the test below would pass vacuously.
    expect(expectedCalls).toBeGreaterThan(0);
    expect(w.callsPerModel).toBe(expectedCalls);
  });

  it("promptCharsPerModel exceeds the raw character count of every fixture file it sends (proves it isn't a stub)", () => {
    const root = resolveFixtureRoot();
    let totalFixtureChars = 0;
    for (const c of SCAN_FOLDER_CASES) {
      for (const rel of scannedFilesFor(c, root)) {
        totalFixtureChars += readFileSync(fixtureAbsPath(rel, root), "utf-8").length;
      }
    }

    const w = describeWorkload();
    expect(w.promptCharsPerModel).toBeGreaterThan(0);
    // Every call's prompt is the file content PLUS the system prompt, the
    // pre-instructions, the per-case task, and the filename/code-fence wrapper —
    // so the total must strictly exceed the raw fixture character count alone.
    expect(w.promptCharsPerModel).toBeGreaterThan(totalFixtureChars);
  });

  it("maxOutputTokensPerCall is the SAME constant the real runner puts on the wire", () => {
    const w = describeWorkload();
    expect(w.maxOutputTokensPerCall).toBe(SCAN_FOLDER_MAX_OUTPUT_TOKENS);
  });

  it("is synchronous and never throws — it reads local fixtures only, no network call", () => {
    const result = describeWorkload();
    // A Promise return would mean an async/network seam crept in; a pre-flight
    // spend estimate must never wait on the network to compute itself.
    expect(result).not.toBeInstanceOf(Promise);
    expect(() => describeWorkload()).not.toThrow();
  });
});
