// check_imports golden dataset — the ORACLE's own tests (TRDD-f45eeaa0).
//
// A deterministic oracle feels authoritative, so the risk is not that it errs
// loudly but that it is confidently precise about the WRONG question. These
// tests attack the derivation with the nastiest cases in its own corpus, and
// with the four shapes an import can take that a naive rule gets wrong.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FIXTURE_DIR,
  EXPECTED_SPECIFIER_COUNTS,
  deriveDeclaredSpecifiers,
  loadDataset,
  scrubCommentsAndStrings,
  validateDataset,
} from "./dataset.js";

const read = (f: string): string => readFileSync(join(FIXTURE_DIR, f), "utf-8");

describe("check-imports dataset — the corpus and its tripwire", () => {
  it("derives a truth for every fixture and agrees with the tripwire", () => {
    expect(() => validateDataset()).not.toThrow();
  });

  it("THROWS when the derived truth and the tripwire disagree", () => {
    // The tripwire is worthless unless a disagreement actually fails. Feed it a
    // deliberately wrong case set rather than trusting that it would.
    const wrong = loadDataset().map((c) =>
      c.file === "budget.ts" ? { ...c, specifiers: [] } : c,
    );
    expect(() => validateDataset(wrong)).toThrow(/tripwire says/);
  });

  it("covers every fixture file, none silently dropped", () => {
    const files = loadDataset().map((c) => c.file).sort();
    expect(files).toEqual(Object.keys(EXPECTED_SPECIFIER_COUNTS).sort());
  });
});

describe("check-imports dataset — the trap that disciplines the oracle", () => {
  it("does NOT report the phantom import from a trailing comment", () => {
    // free-rotation.ts:1115 is executable code with a trailing comment holding
    // the literal text: from "real bug". A `from "…"` scan yields a phantom.
    const src = read("free-rotation.ts");
    expect(src).toContain('from "real bug"'); // the trap is really there
    expect(deriveDeclaredSpecifiers(src)).not.toContain("real bug");
  });

  it("finds the real specifiers in the same file the trap lives in", () => {
    const specs = deriveDeclaredSpecifiers(read("free-rotation.ts"));
    expect(specs).toContain("node:fs");
    expect(specs).toContain("node:path");
    expect(specs).toContain("./config.js");
  });
});

describe("check-imports dataset — the four shapes a naive rule gets wrong", () => {
  it("keeps a TYPE-ONLY import — it is declared, even though emit erases it", () => {
    expect(deriveDeclaredSpecifiers(read("budget.ts"))).toContain(
      "../security_scan/judge.js",
    );
  });

  it("keeps node: builtins and a BARE package alongside relatives", () => {
    const specs = deriveDeclaredSpecifiers(read("config.ts"));
    expect(specs).toContain("node:fs");
    expect(specs).toContain("yaml"); // bare package, not a path
    expect(specs.some((s) => s.startsWith("./") || s.startsWith("../"))).toBe(true);
  });

  it("keeps a SIDE-EFFECT import, which binds nothing", () => {
    expect(deriveDeclaredSpecifiers('import "./polyfill.js";')).toEqual(["./polyfill.js"]);
  });

  it("keeps a re-export's source — referenced by consumers, not by this file", () => {
    expect(deriveDeclaredSpecifiers('export { X } from "./y.js";')).toEqual(["./y.js"]);
  });

  it("finds require() and dynamic import()", () => {
    expect(deriveDeclaredSpecifiers('const a = require("./a.js");')).toEqual(["./a.js"]);
    expect(deriveDeclaredSpecifiers('await import("./b.js");')).toEqual(["./b.js"]);
  });

  it("deduplicates a specifier imported twice", () => {
    const src = 'import { a } from "./x.js";\nimport { b } from "./x.js";';
    expect(deriveDeclaredSpecifiers(src)).toEqual(["./x.js"]);
  });
});

describe("check-imports dataset — the scrubber's ordering argument", () => {
  it("blanks a block comment before its quotes can open a phantom string", () => {
    const src = '/* a quote " here */\nimport { a } from "./real.js";';
    expect(deriveDeclaredSpecifiers(src)).toEqual(["./real.js"]);
  });

  it("preserves LENGTH so offsets still line up with the original", () => {
    const src = 'import "./a.js"; // trailing\n/* block */\n';
    expect(scrubCommentsAndStrings(src)).toHaveLength(src.length);
  });

  it("does not let an import inside a STRING literal count", () => {
    const src = 'const s = "import { x } from \\"./fake.js\\"";\nimport "./real.js";';
    const specs = deriveDeclaredSpecifiers(src);
    expect(specs).toContain("./real.js");
    expect(specs).not.toContain("./fake.js");
  });
});
