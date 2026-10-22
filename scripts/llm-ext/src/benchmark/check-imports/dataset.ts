/**
 * Golden dataset for the check_imports benchmark (TRDD-f45eeaa0).
 *
 * ── WHAT check_imports IS, AND THEREFORE WHAT IS SCORED ─────────────────────
 * check_imports is TWO-PHASE (tools/definitions.ts): "(1) LLM extracts import
 * paths, (2) server validates each exists on disk." Phase 2 is already
 * deterministic and needs no model. So the ONLY thing a model can be graded on
 * here is phase 1: given a file's TEXT, did it extract the set of import
 * specifiers the file actually declares?
 *
 * That is the unit of truth: a SET of specifier strings per file. Precision and
 * recall over that set, no LLM judge — the same deterministic shape
 * scan-folder/ and search-existing/ already score.
 *
 * It also fixes the design error this dataset was nearly built on. The card
 * originally described check_imports as an UNUSED-import checker, which would
 * have needed a tsc-derived oracle and inherited every one of that oracle's
 * definitional traps (side-effect imports, `import type` elision, re-exports,
 * type-position-only use). None of those apply: an unused import is still a
 * DECLARED import, and a side-effect import declares a specifier like any other.
 * Reading the tool's definition instead of the card's summary of it removed a
 * whole class of problem rather than solving it.
 *
 * ── THE CORPUS IS REAL CODE, AND SO IS ITS BREAKAGE ─────────────────────────
 * benchmark-fixtures/check-imports/src/ holds FIVE files copied VERBATIM from
 * this repo's own src/ at commit bbefaaa (provenance table in that directory's
 * README.md). They sit outside src/ so the toolchain never compiles them — and
 * for THIS benchmark that is the point, not a convenience: check_imports exists
 * to find broken imports after a move, and copying a file out of its tree IS a
 * move. Their relative specifiers genuinely no longer resolve. Not one path was
 * typed to be broken.
 *
 * ── GROUND TRUTH IS DERIVED, NOT TYPED IN ───────────────────────────────────
 * `deriveDeclaredSpecifiers()` recomputes the answer from the fixture bytes on
 * every run. `EXPECTED_SPECIFIER_COUNTS` is checked in as a TRIPWIRE, not as the
 * definition: `validateDataset()` recomputes and THROWS on disagreement, so a
 * fixture edit cannot silently change an answer and a mistaken rule cannot
 * silently redefine the truth. Two independent statements of one fact, and a
 * hard failure when they diverge (the discipline scan-folder/dataset.ts uses).
 *
 * ── THE ORACLE MUST SURVIVE ITS OWN CORPUS ──────────────────────────────────
 * fixtures/free-rotation.ts line 1115 is executable code with a trailing
 * comment containing the literal text `from "real bug"`. A naive `from "…"`
 * scan yields a phantom import. The derivation therefore strips comments and
 * strings BEFORE matching, and a dedicated test asserts `real bug` is absent
 * from the derived set. A deterministic oracle feels authoritative, which is
 * exactly why it has to be tested against the nastiest case in its own corpus —
 * precision about the wrong question is the failure that survives review.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One fixture file's derived truth. */
export interface ImportCase {
  /** Fixture basename, e.g. "config.ts". */
  file: string;
  /** Every specifier the file DECLARES, in source order, deduplicated. */
  specifiers: string[];
}

export const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../benchmark-fixtures/check-imports/src",
);

/**
 * Strip line comments, block comments and string literals so a specifier is
 * only ever read from a real import/require FORM.
 *
 * Order matters and is the whole correctness argument: block comments first
 * (they may contain quotes), then line comments, then remaining string
 * literals. Running it the other way round would let a quote inside a comment
 * open a phantom string and swallow real code after it.
 *
 * Replacement preserves LENGTH (spaces), so any offset computed against the
 * scrubbed text still refers to the same position in the original.
 */
export function scrubCommentsAndStrings(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/**
 * Half-open [start, end) ranges of every string literal in comment-scrubbed
 * text.
 *
 * WHY NOT JUST BLANK THE STRINGS TOO: the specifier we are trying to READ lives
 * inside a string. Blanking string contents destroys the answer — the first
 * version of this file did exactly that and turned "./polyfill.js" into
 * "             ". So strings are located, not erased, and a match is judged by
 * where it STARTS: an import form starts at `import`/`require`/`export`, which
 * is code, while a full import statement quoted inside a string starts inside
 * that string and is correctly rejected.
 */
export function stringRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === ch) break;
        // An unterminated literal must not swallow the rest of the file; a
        // newline ends ' and " (template literals legitimately span lines).
        if (ch !== "`" && text[i] === "\n") break;
        i += 1;
      }
      ranges.push([start, Math.min(i + 1, text.length)]);
      i += 1;
      continue;
    }
    i += 1;
  }
  return ranges;
}

function isInsideString(index: number, ranges: ReadonlyArray<[number, number]>): boolean {
  return ranges.some(([a, b]) => index >= a && index < b);
}

/**
 * The specifier FORMS this tool cares about. Deliberately narrow: each is a way
 * a module is really pulled in, and nothing here matches prose.
 *   import … from "x" / import "x" / export … from "x" / require("x") /
 *   dynamic import("x")
 */
const IMPORT_FORMS: readonly RegExp[] = Object.freeze([
  /(?:^|[\s;}])import\s+type\s+[^'"]*?from\s*(['"])([^'"]+)\1/g,
  /(?:^|[\s;}])import\s+[^'"]*?from\s*(['"])([^'"]+)\1/g,
  /(?:^|[\s;}])import\s*(['"])([^'"]+)\1/g,
  /(?:^|[\s;}])export\s+[^'"]*?from\s*(['"])([^'"]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
]);

/**
 * Derive the specifiers a source file DECLARES.
 *
 * Works on the SCRUBBED text, so a `from "…"` inside a comment or a string
 * cannot contribute — the fixture corpus contains exactly that case on purpose.
 */
export function deriveDeclaredSpecifiers(src: string): string[] {
  const scrubbed = scrubCommentsAndStrings(src);
  const ranges = stringRanges(scrubbed);
  const found: string[] = [];
  for (const form of IMPORT_FORMS) {
    // Fresh lastIndex per call: these are module-level /g regexes and a shared
    // lastIndex across calls silently skips matches — a classic and invisible bug.
    form.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = form.exec(scrubbed)) !== null) {
      // The leading (?:^|[\s;}]) may consume one character, so the FORM starts at
      // the keyword, not necessarily at m.index. Either way both sit in code for
      // a genuine import and inside the literal for a quoted one, so testing
      // m.index is sufficient and needs no adjustment.
      if (isInsideString(m.index, ranges)) continue;
      const spec = m[2];
      if (spec && !found.includes(spec)) found.push(spec);
    }
  }
  return found;
}

/** Read the corpus and derive every file's truth. */
export function loadDataset(): ImportCase[] {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  return files.map((file) => ({
    file,
    specifiers: deriveDeclaredSpecifiers(readFileSync(join(FIXTURE_DIR, file), "utf-8")),
  }));
}

/**
 * TRIPWIRE, not the definition. Recomputed and compared by validateDataset();
 * a mismatch THROWS rather than quietly adopting the new number, so a fixture
 * edit or a regex change cannot move the goalposts unnoticed.
 *
 * Counts rather than full lists: the count is what a human can eyeball against
 * the file, and the per-specifier content is already pinned by the targeted
 * tests (node: builtins, the bare package, the type-only import, the trap).
 */
// Each number was read off the FILE (distinct quoted specifiers, eyeballed), not
// copied from the derivation — a tripwire taken from the thing it checks is a
// mirror, not a check. Two were wrong on the first pass, both from the same bad
// proxy (a grep LINE count, where a multi-line `import {\n…\n} from "x"` counts
// twice and a duplicate specifier counts twice):
//   completion.ts    15 -> 13  (multi-line imports double-counted)
//   free-rotation.ts  6 -> 5   (the `from "real bug"` phantom counted as real)
// The second is the corpus's own trap catching its author, which is the best
// possible argument for keeping it in.
export const EXPECTED_SPECIFIER_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  "backfill-ledgers.ts": 5,
  "budget.ts": 1,
  "completion.ts": 13,
  "config.ts": 6,
  "free-rotation.ts": 5,
});

/** Throw unless the derived truth and the checked-in tripwire agree exactly. */
export function validateDataset(cases: ImportCase[] = loadDataset()): void {
  const derived = Object.fromEntries(cases.map((c) => [c.file, c.specifiers.length]));
  const expectedFiles = Object.keys(EXPECTED_SPECIFIER_COUNTS).sort();
  const derivedFiles = Object.keys(derived).sort();
  if (expectedFiles.join(",") !== derivedFiles.join(",")) {
    throw new Error(
      `check-imports dataset: corpus changed. expected files [${expectedFiles.join(", ")}], ` +
        `found [${derivedFiles.join(", ")}]`,
    );
  }
  // Collect EVERY mismatch, not just the first. Throwing on the first one hid a
  // second wrong tripwire number while this dataset was being built: the error
  // named completion.ts, free-rotation.ts was equally wrong, and fixing only the
  // reported file would have left the corpus half-verified.
  const mismatches: string[] = [];
  for (const [file, want] of Object.entries(EXPECTED_SPECIFIER_COUNTS)) {
    const got = derived[file];
    if (got !== want) mismatches.push(`${file}: derived ${got}, tripwire says ${want}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `check-imports dataset: ${mismatches.length} tripwire mismatch(es) — ` +
        `${mismatches.join("; ")}. Either the fixtures changed or the derivation did. ` +
        "Reconcile DELIBERATELY: read the file and count, do not just adopt the derived " +
        "number — the derivation is the thing under test, so trusting it here would make " +
        "the tripwire a mirror instead of an independent check.",
    );
  }
}
