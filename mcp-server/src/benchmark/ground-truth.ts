/**
 * Ground-truth extractor for the model benchmark.
 *
 * Walks each fixture's TypeScript AST and classifies every top-level
 * function/arrow declaration by which keyword substring(s) appear in its
 * body. Ground truth is derived from the fixtures at runtime — the
 * fixtures are the single source of truth, so they cannot drift from the
 * expected answer.
 *
 * A "function" here is:
 *   - a top-level `function NAME(...)` declaration (exported or not), or
 *   - a top-level `const NAME = (...) => { ... }` arrow, or
 *   - a top-level `const NAME = function(...) { ... }` expression.
 *
 * Class methods and nested helpers are intentionally ignored — the model
 * only needs to classify top-level functions.
 */

import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Fixture {
  /** File path read from disk. */
  path: string;
  /** Filename only (e.g. "file-01.ts"). */
  filename: string;
  /** Raw source text the LLM will see. */
  source: string;
  /** All top-level function names detected in this file, in declaration order. */
  functionNames: string[];
}

export interface GroundTruth {
  /** The three keyword substrings, in the order the benchmark reports them. */
  keywords: [string, string, string];
  /** All function names classified under each keyword. Sorted alphabetically. */
  keywordFunctions: [string[], string[], string[]];
  /** Function names that contain none of the keywords. Sorted alphabetically. */
  noiseFunctions: string[];
  /** All functions (keyworded + noise) across every fixture. */
  allFunctions: string[];
  /** Per-fixture view. */
  fixtures: Fixture[];
}

export const BENCHMARK_KEYWORDS: [string, string, string] = [
  "JSON.parse(",
  "new URLSearchParams",
  "performance.now()",
];

/**
 * Read fixture .ts files from a directory and build the ground truth.
 *
 * Throws if any function contains more than one keyword — the benchmark
 * grades against disjoint sets, so a multi-keyword function would make
 * the expected answer ambiguous.
 */
export function buildGroundTruth(
  fixturesDir: string,
  keywords: readonly string[] = BENCHMARK_KEYWORDS,
): GroundTruth {
  if (keywords.length !== 3) {
    throw new Error(`expected exactly 3 keywords, got ${keywords.length}`);
  }

  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  const fixtures: Fixture[] = [];
  const byKeyword: string[][] = [[], [], []];
  const noise: string[] = [];
  const all: string[] = [];
  const multi: Array<{ name: string; matched: string[] }> = [];

  for (const filename of files) {
    const path = join(fixturesDir, filename);
    const source = readFileSync(path, "utf-8");
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, /*setParentNodes*/ true);
    const fixtureFns: string[] = [];

    for (const stmt of sf.statements) {
      const entries = extractNameAndBody(stmt, source);
      for (const { name, body } of entries) {
        fixtureFns.push(name);
        all.push(name);
        const matched: number[] = [];
        for (let i = 0; i < keywords.length; i++) {
          if (body.includes(keywords[i])) matched.push(i);
        }
        if (matched.length === 0) {
          noise.push(name);
        } else if (matched.length === 1) {
          byKeyword[matched[0]].push(name);
        } else {
          multi.push({ name, matched: matched.map((i) => keywords[i]) });
        }
      }
    }

    fixtures.push({ path, filename, source, functionNames: fixtureFns });
  }

  if (multi.length > 0) {
    const detail = multi.map((m) => `  ${m.name}: ${m.matched.join(", ")}`).join("\n");
    throw new Error(`fixture functions contain multiple keywords (ambiguous ground truth):\n${detail}`);
  }

  const sort = (arr: string[]): string[] => [...arr].sort();
  return {
    keywords: [keywords[0], keywords[1], keywords[2]],
    keywordFunctions: [sort(byKeyword[0]), sort(byKeyword[1]), sort(byKeyword[2])],
    noiseFunctions: sort(noise),
    allFunctions: sort(all),
    fixtures,
  };
}

/**
 * Extract `{ name, body }` pairs for every top-level function-like
 * declaration in a statement. Returns an array because a single
 * VariableStatement can declare multiple functions (e.g. `const a = ..., b = ...;`).
 */
function extractNameAndBody(stmt: ts.Statement, source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];

  if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
    out.push({ name: stmt.name.text, body: source.slice(stmt.body.pos, stmt.body.end) });
    return out;
  }

  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.name || !ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      let body: ts.Node | null = null;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        body = init.body;
      }
      if (body) {
        out.push({ name: decl.name.text, body: source.slice(body.pos, body.end) });
      }
    }
  }

  return out;
}
