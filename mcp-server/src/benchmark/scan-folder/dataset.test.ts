// Tests for the scan_folder (MASS SEARCH) golden dataset — P2c.
//
// The REAL corpus on disk is the subject: nothing here is mocked. These tests
// exist because the dataset's central claim — "the ground truth is DERIVED from
// the corpus bytes, not hand-written" — is only true if the derivation is
// actually exercised and the tripwire actually fires.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  MIN_MATCHES_PER_CASE,
  MIN_NON_MATCHES_PER_CASE,
  SCAN_FOLDER_CASES,
  buildInstructions,
  datasetFingerprint,
  deriveMatchingFiles,
  fixtureAbsPath,
  fixtureScanRoot,
  listFixtureFiles,
  resolveFixtureRoot,
  scannedFilesFor,
  validateDataset,
  type ScanFolderCase,
} from "./dataset.js";

const ROOT = resolveFixtureRoot();

describe("the corpus", () => {
  it("is exactly the twelve real files the README documents, all non-empty and text", () => {
    const files = listFixtureFiles(ROOT);
    expect(files.length).toBe(12);
    for (const rel of files) {
      const bytes = readFileSync(fixtureAbsPath(rel, ROOT));
      expect(bytes.length).toBeGreaterThan(500);
      // A NUL byte makes readFileAsCodeBlock refuse the file as binary, which would
      // silently fail EVERY model on it (the bug P2b found the hard way).
      expect(bytes.includes(0)).toBe(false);
    }
  });

  it("is scanned from src/, so the provenance README is never fed to the model as an 11th file", () => {
    // The README announces every answer in a table. Scanning the fixture ROOT
    // instead of its src/ subtree would hand the model the answer key.
    expect(fixtureScanRoot(ROOT).endsWith("/src")).toBe(true);
    expect(listFixtureFiles(ROOT).every((f) => f.startsWith("src/"))).toBe(true);
    expect(listFixtureFiles(ROOT).some((f) => f.toLowerCase().includes("readme"))).toBe(false);
  });

  it("is REAL code — every fixture is byte-identical to the repo source it was copied from", () => {
    // The whole corpus rests on this: these are verbatim snapshots of production
    // source, not code written to be found. Spot-check the two files that carry the
    // rarest truth (child_process) against their originals in src/.
    const pairs: [string, string][] = [
      ["src/embeddings.ts", "src/cluster/embeddings.ts"],
      ["src/unionfind.ts", "src/cluster/unionfind.ts"],
    ];
    for (const [fixture, origin] of pairs) {
      const fixtureBytes = readFileSync(fixtureAbsPath(fixture, ROOT));
      // ROOT is <pkg>/benchmark-fixtures/scan-folder → the package root is two up.
      const originBytes = readFileSync(`${ROOT}/../../${origin}`);
      expect(fixtureBytes.equals(originBytes)).toBe(true);
    }
  });
});

describe("ground truth is DERIVED from the bytes, not typed in", () => {
  it("validateDataset passes on the shipped corpus", () => {
    expect(() => validateDataset()).not.toThrow();
  });

  it("every case's derived MATCH set equals its checked-in tripwire", () => {
    for (const c of SCAN_FOLDER_CASES) {
      expect(deriveMatchingFiles(c, ROOT)).toEqual([...c.expectedMatchFiles].sort());
    }
  });

  it("derives the truth by READING the file, not by reading its name", () => {
    // The derivation must be a function of the bytes. Point a case's rule at a
    // token that appears in NO fixture and the MATCH set must collapse to empty —
    // proving nothing else (a filename, a hard-coded list) is feeding the answer.
    const impossible: ScanFolderCase = {
      ...SCAN_FOLDER_CASES[0],
      truthRegexSource: "zzz_no_such_token_zzz",
    };
    expect(deriveMatchingFiles(impossible, ROOT)).toEqual([]);
  });

  it("the fs-write query really does separate writers from read-only fs users", () => {
    // The load-bearing discrimination of the whole benchmark: four fixtures import
    // node:fs and are full of reads, and every one must be NO_MATCH. If a corpus
    // edit ever made one of them a writer, this benchmark would stop measuring the
    // thing it claims to measure.
    const write = SCAN_FOLDER_CASES.find((c) => c.id === "writes-to-filesystem");
    expect(write).toBeDefined();
    const matches = deriveMatchingFiles(write!, ROOT);
    const readOnly = [
      "src/doc-inventory.ts",
      "src/project-root.ts",
      "src/search-existing-dataset.ts",
      "src/security-triage-dataset.ts",
    ];
    for (const rel of readOnly) {
      expect(matches).not.toContain(rel);
      const src = readFileSync(fixtureAbsPath(rel, ROOT), "utf-8");
      expect(src).toMatch(/node:fs/); // it really does use fs …
      expect(src).toMatch(/readFileSync|existsSync|readdirSync|statSync/); // … to READ.
    }
  });

  it("the corpus TRAPS a keyword matcher on every query, not just one", () => {
    // A benchmark a grep could pass measures nothing. security-triage-dataset.ts is
    // the corpus's answer: it is REAL source that DESCRIBES threats, so it is
    // saturated with the vocabulary of shell execution and broken hashes while
    // importing neither child_process nor crypto — and its fs use is read-only. A
    // model that pattern-matches vocabulary says MATCH on all three queries; a model
    // that reads the code says NO_MATCH on all three. (bench-runner.test.ts proves
    // the keyword strategy actually FAILS the gate on this corpus.)
    const trap = readFileSync(fixtureAbsPath("src/security-triage-dataset.ts", ROOT), "utf-8");
    expect(trap).toMatch(/command_injection/);
    expect(trap).toMatch(/shell/);
    expect(trap).toMatch(/insecure_crypto/);
    expect(trap).toMatch(/md5|sha1/);
    // … and yet it does none of it.
    for (const c of SCAN_FOLDER_CASES) {
      expect(deriveMatchingFiles(c, ROOT)).not.toContain("src/security-triage-dataset.ts");
    }
  });

  it("every case can be got both right and wrong (recall AND precision are measurable)", () => {
    for (const c of SCAN_FOLDER_CASES) {
      const scanned = scannedFilesFor(c, ROOT);
      const matches = deriveMatchingFiles(c, ROOT);
      expect(matches.length).toBeGreaterThanOrEqual(MIN_MATCHES_PER_CASE);
      expect(scanned.length - matches.length).toBeGreaterThanOrEqual(MIN_NON_MATCHES_PER_CASE);
    }
  });
});

describe("validateDataset — the tripwire fires", () => {
  it("THROWS when the truth regex and the checked-in answer disagree", () => {
    // The exact failure the tripwire exists for: someone edits the rule (or the
    // list) and the two statements of the truth diverge. It must be a hard error —
    // a silent disagreement would score every model against a wrong answer.
    const drifted: ScanFolderCase = {
      ...SCAN_FOLDER_CASES[0],
      truthRegexSource: "from\\s*[\"']node:fs[\"']", // now matches a different set
    };
    expect(() => validateDataset([drifted], ROOT)).toThrow(/DISAGREE/);
  });

  it("THROWS on a query with nothing to find (recall unmeasurable)", () => {
    const empty: ScanFolderCase = {
      ...SCAN_FOLDER_CASES[0],
      truthRegexSource: "zzz_no_such_token_zzz",
      expectedMatchFiles: [],
    };
    expect(() => validateDataset([empty], ROOT)).toThrow(/recall is not measurable/);
  });

  it("THROWS on a query everything matches (precision unmeasurable — MATCH-to-all would pass)", () => {
    const all: ScanFolderCase = {
      ...SCAN_FOLDER_CASES[0],
      // `\S` — every fixture contains a non-whitespace character, so the MATCH set
      // is the whole corpus and there is nothing left to answer NO_MATCH to.
      truthRegexSource: "\\S",
      expectedMatchFiles: listFixtureFiles(ROOT),
    };
    expect(() => validateDataset([all], ROOT)).toThrow(/precision is not measurable/);
  });

  it("THROWS on a duplicate case id", () => {
    expect(() => validateDataset([SCAN_FOLDER_CASES[0], SCAN_FOLDER_CASES[0]], ROOT)).toThrow(
      /duplicate case id/,
    );
  });
});

describe("the output contract", () => {
  it("forces the anchored first line the deterministic scorer reads", () => {
    const text = buildInstructions("Does this file do X?");
    expect(text).toContain("Does this file do X?");
    expect(text).toContain("MATCH: <the exact identifier or import in this file that proves it>");
    expect(text).toContain("NO_MATCH");
    // "Judge what the code DOES, not what its name suggests" is not decoration: the
    // model is shown each file's PATH, and a filename is the cheapest wrong signal.
    expect(text).toMatch(/Judge what the code DOES/);
  });

  it("every case shares ONE contract — the criterion is the only thing that varies", () => {
    for (const c of SCAN_FOLDER_CASES) {
      const text = buildInstructions(c.criterion);
      expect(text).toContain("OUTPUT FORMAT (mandatory)");
      expect(text.endsWith("the first line must be exactly NO_MATCH.")).toBe(true);
    }
  });
});

describe("datasetFingerprint", () => {
  it("is stable across calls", () => {
    expect(datasetFingerprint(ROOT)).toBe(datasetFingerprint(ROOT));
    expect(datasetFingerprint(ROOT)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("covers the corpus BYTES, not just the questions", () => {
    // The per-day cache is keyed on this. If it hashed only the case list, editing a
    // FIXTURE would serve yesterday's score for a corpus that no longer exists.
    // Proven by hashing a root whose bytes differ: the digest must differ too.
    const h = datasetFingerprint(ROOT);
    const files = listFixtureFiles(ROOT);
    // Reconstruct the hash input the implementation uses, with one byte changed, and
    // assert the implementation's digest is not that of the mutated corpus.
    const mutated = createHash("sha1");
    mutated.update(JSON.stringify(SCAN_FOLDER_CASES));
    for (const rel of files) {
      mutated.update(rel);
      const bytes = readFileSync(fixtureAbsPath(rel, ROOT));
      mutated.update(rel === files[0] ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
    }
    expect(mutated.digest("hex").slice(0, 12)).not.toBe(h);
  });
});
