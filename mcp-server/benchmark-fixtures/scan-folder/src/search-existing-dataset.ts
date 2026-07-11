/**
 * Golden dataset for the search_existing_implementations per-tool benchmark
 * (TRDD-828238b5 A6). Mirrors benchmark/security-triage/dataset.ts.
 *
 * The corpus is a REAL, hand-authored fixture mini-codebase under
 * mcp-server/benchmark-fixtures/search-existing/ — authored specifically so
 * every feature location is KNOWN, which is what makes deterministic
 * precision/recall scoring possible (no LLM judge needed). Each case states
 * the exact files a correct run must answer YES for; every other discovered
 * file must be NO. Ambiguous truths are engineered OUT of the fixture (see
 * the lru.ts/memo.ts header comments) rather than papered over in scoring.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SearchExistingCase {
  /** Unique case id (kebab-case). */
  id: string;
  /** The feature_description handed to the real pipeline. */
  featureDescription: string;
  /** Fixture-relative paths the model MUST answer YES for. */
  expectedYes: string[];
  /** File extensions to scan (passed straight to the pipeline). */
  extensions: string[];
  /**
   * Fixture-relative paths passed as reference source_files. The pipeline
   * excludes them from the scan, so they must NOT appear in expectedYes.
   */
  sourceFiles?: string[];
  /** Why this truth is unambiguous — keeps future edits honest. */
  rationale: string;
}

/**
 * Resolve the on-disk fixture root. The fixture lives OUTSIDE src/ so the
 * package toolchain (tsc/eslint/vitest) never touches it; from
 * src/benchmark/search-existing/ (or its dist equivalent the bundle inlines)
 * that is three levels up.
 */
export function resolveFixtureRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, "../../../benchmark-fixtures/search-existing"),
    // dist/ bundle layout: dist/<bundle>.js → one level less deep.
    resolve(here, "../../benchmark-fixtures/search-existing"),
    resolve(here, "../benchmark-fixtures/search-existing"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  throw new Error(
    `search-existing fixture root not found near ${here} — looked at:\n` +
      candidates.map((c) => `  ${c}`).join("\n"),
  );
}

/** Recursively list fixture files (relative paths, POSIX separators). */
export function listFixtureFiles(root: string = resolveFixtureRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile() && entry.name !== "tsconfig.json") {
        out.push(relPath);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

export const SEARCH_EXISTING_CASES: SearchExistingCase[] = [
  {
    id: "retry-backoff-ts",
    featureDescription:
      "Retry a failing async operation with exponential backoff between attempts, " +
      "rethrowing the last error when the attempts are exhausted.",
    expectedYes: ["src/http/retry.ts", "src/http/client.ts"],
    extensions: [".ts"],
    rationale:
      "retry.ts is the canonical wrapper; client.ts re-implements the same " +
      "semantics inline (while-loop, doubling delay) — the EXHAUSTIVE rule " +
      "requires both. No other .ts fixture retries anything.",
  },
  {
    id: "retry-backoff-cross-language",
    featureDescription:
      "Retry a failing operation with exponential backoff between attempts, " +
      "rethrowing the last error when the attempts are exhausted.",
    expectedYes: [
      "src/http/retry.ts",
      "src/http/client.ts",
      "src/legacy/retry_old.py",
    ],
    extensions: [".ts", ".py"],
    rationale:
      "Same truth as retry-backoff-ts plus the Python port — semantic " +
      "equivalence must cross languages when .py is scanned.",
  },
  {
    id: "retry-self-reference-exclusion",
    featureDescription:
      "Retry a failing async operation with exponential backoff between attempts, " +
      "rethrowing the last error when the attempts are exhausted.",
    expectedYes: ["src/http/client.ts"],
    extensions: [".ts"],
    sourceFiles: ["src/http/retry.ts"],
    rationale:
      "retry.ts is supplied as the PR reference (source_files) so the " +
      "pipeline excludes it from the scan; the only remaining duplicate is " +
      "client.ts.",
  },
  {
    id: "lru-cache",
    featureDescription:
      "An in-memory least-recently-used (LRU) cache with a maximum size that " +
      "evicts the least recently used entry when full.",
    expectedYes: ["src/cache/lru.ts"],
    extensions: [".ts"],
    rationale:
      "memo.ts is unbounded with no eviction policy at all, so it cannot be " +
      "the LRU feature nor trivially composed into one (the fixture headers " +
      "encode this disambiguation).",
  },
  {
    id: "memoization",
    featureDescription:
      "Wrap a pure function so repeated calls with the same arguments return a " +
      "cached result instead of recomputing, keyed by the call arguments.",
    expectedYes: ["src/cache/memo.ts"],
    extensions: [".ts"],
    rationale:
      "lru.ts is a bare data structure with get/set only — no get-or-compute " +
      "wrapper exists, so memoizing with it still requires writing the whole " +
      "wrap-and-key logic (not 'trivially composed').",
  },
  {
    id: "slugify",
    featureDescription:
      "Generate a URL-safe slug from an arbitrary string: lowercase it, strip " +
      "accents, and collapse non-alphanumeric runs into single hyphens.",
    expectedYes: ["src/util/slug.ts"],
    extensions: [".ts"],
    rationale: "Only slug.ts manipulates strings into slugs.",
  },
  {
    id: "debounce",
    featureDescription:
      "A debounce utility that delays invoking a function until a quiet period " +
      "has elapsed, where only the last call within the window executes.",
    expectedYes: ["src/util/debounce.ts"],
    extensions: [".ts"],
    rationale: "Only debounce.ts schedules/cancels delayed invocations.",
  },
  {
    id: "hmac-token",
    featureDescription:
      "Create and verify HMAC-signed tokens, with constant-time signature " +
      "comparison on the verify path.",
    expectedYes: ["src/auth/token.ts"],
    extensions: [".ts"],
    rationale: "Only token.ts touches crypto/signing.",
  },
  {
    id: "leveled-logger",
    featureDescription:
      "A leveled logger (debug/info/warn/error) that drops messages below a " +
      "configurable minimum level.",
    expectedYes: ["src/log/logger.ts"],
    extensions: [".ts"],
    rationale: "Only logger.ts implements log levels and filtering.",
  },
  {
    id: "absent-feature-websocket-pool",
    featureDescription:
      "A WebSocket connection pool that reuses open sockets per origin and " +
      "enforces a maximum number of concurrent connections.",
    expectedYes: [],
    extensions: [".ts"],
    rationale:
      "Nothing in the fixture opens sockets — every YES is a false positive. " +
      "Measures hallucination resistance.",
  },
];

/**
 * Validate the dataset against the on-disk fixture. Throws with a precise
 * message on drift (missing files, duplicate ids, expectations whose
 * extension is not scanned, sourceFiles listed as expectedYes).
 */
export function validateDataset(root: string = resolveFixtureRoot()): void {
  const ids = new Set<string>();
  for (const c of SEARCH_EXISTING_CASES) {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);
    for (const rel of [...c.expectedYes, ...(c.sourceFiles ?? [])]) {
      if (!existsSync(join(root, rel))) {
        throw new Error(`case ${c.id}: fixture file missing on disk: ${rel}`);
      }
    }
    for (const rel of c.expectedYes) {
      if (!c.extensions.some((ext) => rel.endsWith(ext))) {
        throw new Error(
          `case ${c.id}: expectedYes ${rel} has an extension outside ${c.extensions.join(",")}`,
        );
      }
      if ((c.sourceFiles ?? []).includes(rel)) {
        throw new Error(
          `case ${c.id}: ${rel} is both a reference source_file (excluded from the scan) and expectedYes`,
        );
      }
    }
  }
}
