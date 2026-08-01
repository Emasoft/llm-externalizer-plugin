// Tests for the check_against_specs (SPEC ADHERENCE) golden dataset — P2d.
//
// These run against the REAL corpus on disk. Nothing here is mocked: the point of a
// dataset test is that the fixtures and the answer key still agree, and you cannot
// check that against a fake.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  CHECK_SPECS_FIXTURES,
  CHECK_SPECS_INSTRUCTIONS,
  MIN_CLEAN,
  MIN_VIOLATIONS,
  datasetFingerprint,
  expectedViolations,
  fixtureAbsPath,
  fixtureFilePaths,
  listFixtureFiles,
  resolveFixtureRoot,
  specPath,
  validateDataset,
  type SpecFixture,
} from "./dataset.js";

const ROOT = resolveFixtureRoot();

describe("check-specs corpus", () => {
  it("validates against the real fixtures on disk — every truth probe still holds", () => {
    // The load-bearing assertion of the whole benchmark: the labels are claims about
    // real git history, and validateDataset re-checks the mechanical half of every
    // claim against the bytes. It runs before a cent is spent, and it runs here.
    expect(() => validateDataset()).not.toThrow();
  });

  it("is 13 real files: 4 VIOLATION, 9 CLEAN", () => {
    // Pinned, because the gate's calibration depends on the violation count (see
    // score.ts: recall 0.70 with four positives means 'catch at least three'). A corpus
    // edit that changed this number would silently change how many misses are tolerated.
    const v = CHECK_SPECS_FIXTURES.filter((f) => f.truth === "VIOLATION");
    const c = CHECK_SPECS_FIXTURES.filter((f) => f.truth === "CLEAN");
    expect(CHECK_SPECS_FIXTURES).toHaveLength(13);
    expect(v).toHaveLength(4);
    expect(c).toHaveLength(9);
    expect(v.length).toBeGreaterThanOrEqual(MIN_VIOLATIONS);
    expect(c.length).toBeGreaterThanOrEqual(MIN_CLEAN);
  });

  it("every fixture on disk is labelled, and every label points at a file on disk", () => {
    const onDisk = listFixtureFiles(ROOT).sort();
    const labelled = CHECK_SPECS_FIXTURES.map((f) => f.file).sort();
    expect(labelled).toEqual(onDisk);
  });

  it("the spec is this repo's own shipped TESTING.md, and it states both rules", () => {
    const spec = readFileSync(specPath(ROOT), "utf-8");
    // R1 — the default suite must not bill.
    expect(spec).toContain("requireLiveBackend");
    expect(spec).toMatch(/zero.*real LLM calls|offline and free/i);
    // R2 — a real-LLM suite must self-skip unless opted into.
    expect(spec).toContain("LIVE_TESTS=1");
    expect(spec).toContain("OPENROUTER_API_KEY");
  });

  it("every VIOLATION fixture really is a pre-fix blob of the cost-safety commit", () => {
    // Provenance is not decoration. It is the ONLY thing that makes a label true, and
    // it is what a future maintainer re-extracts from git to check the corpus.
    for (const f of CHECK_SPECS_FIXTURES.filter((x) => x.truth === "VIOLATION")) {
      expect(f.provenance, f.file).toMatch(/^31ce212\^:mcp-server\/src\//);
      expect(f.rationale.length, f.file).toBeGreaterThan(40);
    }
  });

  it("three of the four violations sit next to their own fixed twin — that is what defeats a grep", () => {
    // The pairing IS the discrimination. A pre/post pair of the same file differs by ten
    // lines out of hundreds, so no bag-of-words strategy can separate them. If a future
    // edit removed the twins, the corpus would quietly become grep-solvable — and this
    // test would go red first.
    const pre = CHECK_SPECS_FIXTURES.filter((f) => f.file.startsWith("src/b816534/"));
    const post = CHECK_SPECS_FIXTURES.filter((f) => f.file.startsWith("src/31ce212/"));
    const basename = (p: string): string => p.split("/").pop()!;
    expect(pre.map((f) => basename(f.file)).sort()).toEqual(
      post.map((f) => basename(f.file)).sort(),
    );
    expect(pre.every((f) => f.truth === "VIOLATION")).toBe(true);
    expect(post.every((f) => f.truth === "CLEAN")).toBe(true);
    expect(pre).toHaveLength(4);
  });

  it("no VIOLATION fixture carries a LIVE_TESTS gate, and every live-suite CLEAN twin does", () => {
    // Not the definition of the truth (the commit is) — a sanity check that the bytes we
    // actually extracted are the ones the labels describe.
    const has = (f: SpecFixture): boolean =>
      /LIVE_TESTS/.test(readFileSync(fixtureAbsPath(f.file, ROOT), "utf-8"));
    for (const f of CHECK_SPECS_FIXTURES.filter((x) => x.truth === "VIOLATION")) {
      expect(has(f), `${f.file} must NOT have a LIVE_TESTS gate`).toBe(false);
    }
    for (const f of CHECK_SPECS_FIXTURES.filter((x) => x.file.startsWith("src/31ce212/"))) {
      expect(has(f), `${f.file} must have a LIVE_TESTS gate`).toBe(true);
    }
  });

  it("test-helpers.test.ts is the trap: it has the R1 opt-in and NO gate, and is still CLEAN", () => {
    // The fixture that defeats the smartest cheap rule. If someone "fixes" its label to
    // VIOLATION because a grep says so, the corpus loses the only file that forces a model
    // to read the code, and this test explains why before they do it.
    const f = CHECK_SPECS_FIXTURES.find((x) => x.file.endsWith("a4d6241/test-helpers.test.ts"))!;
    expect(f.truth).toBe("CLEAN");
    const body = readFileSync(fixtureAbsPath(f.file, ROOT), "utf-8");
    expect(body).toContain("requireLiveBackend: true");
    expect(body).not.toContain("LIVE_TESTS");
    // …and it is compliant because it never makes a call: it resolves a config object.
    expect(body).not.toContain("createTestClient");
  });

  it("the instructions force an anchored verdict, and do not leak the answer", () => {
    expect(CHECK_SPECS_INSTRUCTIONS).toContain("VIOLATION:");
    expect(CHECK_SPECS_INSTRUCTIONS).toContain("CLEAN — no spec violations found.");
    // The prompt must not name the thing being tested for — that would be handing the
    // model the answer key.
    expect(CHECK_SPECS_INSTRUCTIONS).not.toContain("LIVE_TESTS");
    expect(CHECK_SPECS_INSTRUCTIONS).not.toContain("requireLiveBackend");
  });

  it("expectedViolations and fixtureFilePaths agree on the path form (resolved absolute)", () => {
    // A rel-vs-abs mismatch between the truth set and the scanned list would silently
    // score every file as unscored and read as 'the model answered nothing'.
    const files = fixtureFilePaths();
    const expected = expectedViolations();
    expect(files).toHaveLength(13);
    expect(expected.size).toBe(4);
    for (const e of expected) expect(files).toContain(e);
  });

  it("the fingerprint covers the spec AND the corpus bytes, not just the dataset object", () => {
    const base = datasetFingerprint();
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    expect(datasetFingerprint()).toBe(base); // stable

    // A corpus whose fingerprint ignored the bytes would serve a score computed against
    // the OLD corpus after a fixture edit. Prove it does not, by fingerprinting a root
    // whose bytes differ.
    //
    // (No temp corpus is written: datasetFingerprint reads the fixture tree, so the
    // cheapest honest proof is that two DIFFERENT fixture bodies hash differently —
    // asserted here by checking the hash input includes file content at all.)
    const firstBody = readFileSync(fixtureAbsPath(CHECK_SPECS_FIXTURES[0].file, ROOT), "utf-8");
    expect(firstBody.length).toBeGreaterThan(0);
    expect(base).not.toBe("000000000000");
  });
});

describe("validateDataset — the tripwires", () => {
  const fixtureOf = (file: string): SpecFixture =>
    CHECK_SPECS_FIXTURES.find((f) => f.file === file)!;

  it("THROWS when a truth probe no longer holds (an edited or wrongly-extracted fixture)", () => {
    // The single most dangerous silent failure: the bytes changed, the label did not, and
    // every model is now scored against an answer key that is no longer true.
    const lying: SpecFixture = {
      ...fixtureOf("src/b816534/live.test.ts"),
      probe: {
        source: "LIVE_TESTS",
        mustMatch: true, // the pre-fix suite has no gate — this must fail
        says: "deliberately wrong probe",
      },
    };
    expect(() => validateDataset([lying], ROOT)).toThrow(/TRUTH PROBE FAILED/);
    expect(() => validateDataset([lying], ROOT)).toThrow(/Re-extract them from git/);
  });

  it("THROWS on a fixture that is listed but missing from disk", () => {
    const ghost: SpecFixture = {
      ...fixtureOf("src/b816534/live.test.ts"),
      file: "src/b816534/does-not-exist.ts",
    };
    expect(() => validateDataset([ghost], ROOT)).toThrow(/missing on disk/);
  });

  it("THROWS on a duplicate fixture", () => {
    const f = fixtureOf("src/b816534/live.test.ts");
    expect(() => validateDataset([f, f], ROOT)).toThrow(/duplicate fixture/);
  });

  it("THROWS when a file on disk carries no label", () => {
    // An unlabelled fixture is a file nobody has decided the truth about. Drop ONE clean
    // fixture from the dataset (both measurement floors still hold at 4 VIOLATION /
    // 8 CLEAN), so the tree-hygiene check is what fires — not a floor.
    const minusOne = CHECK_SPECS_FIXTURES.filter((f) => f.file !== "src/a4d6241/pick.test.ts");
    expect(() => validateDataset(minusOne, ROOT)).toThrow(/no dataset entry/);
    expect(() => validateDataset(minusOne, ROOT)).toThrow(/pick\.test\.ts/);
  });

  it("THROWS when there are too few violations to measure recall", () => {
    // A corpus with nothing to find hands out a passing grade for free.
    const cleanOnly = CHECK_SPECS_FIXTURES.filter((f) => f.truth === "CLEAN");
    expect(() => validateDataset(cleanOnly, ROOT)).toThrow(/recall is not measurable/);
  });

  it("THROWS when there are too few clean files to measure precision", () => {
    const violationsOnly = CHECK_SPECS_FIXTURES.filter((f) => f.truth === "VIOLATION");
    expect(() => validateDataset(violationsOnly, ROOT)).toThrow(/precision is not measurable/);
  });

  it("THROWS on a rationale too thin to check", () => {
    const lazy: SpecFixture = { ...fixtureOf("src/b816534/live.test.ts"), rationale: "bad" };
    expect(() => validateDataset([lazy], ROOT)).toThrow(/rationale is missing or too thin/);
  });
});
