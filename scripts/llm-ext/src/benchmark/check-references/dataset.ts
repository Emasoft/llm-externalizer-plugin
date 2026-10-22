/**
 * Golden dataset for the check_references benchmark (TRDD-2G6D42LK).
 *
 * ── THE SCOPE THAT MAKES THIS BOUNDED ───────────────────────────────────────
 * check_references "auto-resolves local imports, reads dependencies, LLM
 * validates all symbols exist". Graded naively — "find every broken reference" —
 * the oracle is UNBOUNDED: it would have to decide which identifiers count as
 * references, admitting dynamic property access, string-keyed lookup,
 * reflection, and re-export chains. A miss could not be attributed to the model
 * versus the oracle, which is the failure that survives review.
 *
 * So the graded question is narrowed to NAMED IMPORT BINDINGS. `import { foo }
 * from "./x.js"` asserts that x exports foo, and whether it does is DECIDABLE
 * from the bytes. Same move that made check-imports tractable, one level deeper.
 *
 * EXCLUDED EXPLICITLY, not silently: default imports, namespace imports
 * (`* as ns`), type-only imports, and re-export chains. Each is a real reference
 * form this oracle cannot adjudicate, so none is scored.
 *
 * ── THE CORPUS IS DERIVED FROM REAL REFACTORS ───────────────────────────────
 * Each case pairs a CONSUMER file from commit N-1 with its DEPENDENCY at commit
 * N, across a commit that removed or renamed an export. The break is real,
 * produced by a refactor that really happened; no fixture was edited to be
 * wrong. Mined with `git log -S <symbol>` over export removals — the same
 * git-derived principle as code_task's pre-fix snapshots.
 *
 * ── AND IT CONTAINS AN INTACT CASE, DELIBERATELY ────────────────────────────
 * `resolveBenchmarkScriptPath` is present in its dependency: a NEGATIVE control.
 * Without one, "declare every binding broken" scores a perfect recall, and the
 * benchmark would reward exactly the behaviour that makes check_references
 * useless in practice. It was found by MEASURING the mined pairs rather than
 * assumed — three of the four came back broken, and this one did not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReferenceCase {
  /** Case directory name — the symbol the refactor moved. */
  symbol: string;
  /** True iff the dependency does NOT export it: a genuinely broken binding. */
  broken: boolean;
}

export const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../benchmark-fixtures/check-references",
);

/**
 * Does this module export the symbol, as a NAMED binding?
 *
 * Matches a top-level `export <kind> <name>` and an `export { a, b }` list. A
 * `export default` is deliberately NOT a match: a default export does not
 * satisfy a named import, which is precisely the distinction under test.
 */
export function exportsSymbol(source: string, symbol: string): boolean {
  const decl = new RegExp(
    `^export\\s+(?:async\\s+)?(?:function|const|let|var|interface|type|class|enum)\\s+${symbol}\\b`,
    "m",
  );
  if (decl.test(source)) return true;
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    const names = m[1].split(",").map((p) => p.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes(symbol)) return true;
  }
  return false;
}

export function loadDataset(): ReferenceCase[] {
  return readdirSync(FIXTURE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((symbol) => ({
      symbol,
      broken: !exportsSymbol(
        readFileSync(join(FIXTURE_DIR, symbol, "dependency.ts"), "utf-8"),
        symbol,
      ),
    }));
}

/**
 * TRIPWIRE. Provenance stated honestly: these verdicts were MEASURED from the
 * fixtures (grep for the export, per case) and then re-derived here, so they are
 * a change detector rather than an independent second opinion. What was checked
 * by hand is the direction — three pairs came back broken and one intact, and
 * the intact one is kept ON PURPOSE as the negative control.
 */
export const EXPECTED_BROKEN: Readonly<Record<string, boolean>> = Object.freeze({
  checkImportsWorkloadShape: true,
  describeWorkload: false,
  packIntoBatches: true,
  resolveBenchmarkScriptPath: false,
});

// `describeWorkload` was added as a SECOND intact case to BALANCE the corpus,
// and the imbalance was found by measurement rather than inspection: with 2
// broken to 1 intact, a model that calls EVERY binding broken scores micro-F1
// exactly 0.80 — precisely the floor — so the degenerate strategy squeaked past.
// The fix is a balanced corpus, NOT a raised threshold: tuning the bar until the
// bad strategy fails is fitting the metric to the answer you want. At 2:2 that
// model scores 0.667 and fails on the merits.

// REMOVED, and the reason is worth keeping: `isEchoResponse` was mined as a
// fourth case and looked broken — my mining grep searched only for a direct
// `export function/const` declaration. The ORACLE disagreed, and it was right:
// the dependency carries `export { isEchoResponse } from "../response-gate.js"`,
// so the symbol MOVED and is re-exported, and the binding is intact. It is not
// kept as a second negative control because its verdict hinges on a RE-EXPORT
// CHAIN, which this dataset excludes as unadjudicable — grading a case the
// stated scope cannot adjudicate is exactly the incoherence the exclusions
// exist to prevent.

export function validateDataset(cases: ReferenceCase[] = loadDataset()): void {
  const want = Object.keys(EXPECTED_BROKEN).sort();
  const got = cases.map((c) => c.symbol).sort();
  if (want.join(",") !== got.join(",")) {
    throw new Error(
      `check-references dataset: corpus changed. expected [${want.join(", ")}], found [${got.join(", ")}]`,
    );
  }
  const wrong = cases.filter((c) => c.broken !== EXPECTED_BROKEN[c.symbol]);
  if (wrong.length > 0) {
    throw new Error(
      `check-references dataset: ${wrong.length} verdict mismatch(es) — ` +
        wrong.map((c) => `${c.symbol}: derived broken=${c.broken}`).join("; ") +
        ". Reconcile DELIBERATELY by reading the dependency, not by adopting the derived value.",
    );
  }
  // Checked against the TRIPWIRE, not the derived cases, and checked FIRST-class
  // rather than last: it is a corpus-COMPOSITION invariant, and behind the
  // verdict-mismatch check it was unreachable — any all-broken case set trips
  // that check before ever reaching this one. Caught by its own test failing.
  if (!Object.values(EXPECTED_BROKEN).some((broken) => !broken)) {
    throw new Error(
      "check-references dataset: every case is BROKEN. Without an intact binding, " +
        '"declare everything broken" scores perfectly — restore a negative control.',
    );
  }
}
