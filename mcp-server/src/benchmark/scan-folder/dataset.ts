/**
 * Golden dataset for the scan_folder (MASS SEARCH) benchmark — P2c.
 *
 * ── WHAT scan_folder IS, AND THEREFORE WHAT IS SCORED ───────────────────────
 * scan_folder walks a folder and asks ONE question of EVERY file, one LLM call
 * per file (scan-folder/core.ts:237). Its unit of judgment is a per-file verdict,
 * so the benchmark's unit of truth is a per-file verdict too: for each query, the
 * exact set of corpus files that genuinely match. That is precisely the shape
 * search_existing_implementations' benchmark already scores (a per-file binary),
 * which is why this dataset reuses that scorer's math verbatim (see score.ts).
 *
 * ── THE CORPUS IS REAL CODE (a hard project rule) ───────────────────────────
 * benchmark-fixtures/scan-folder/src/ holds TWELVE files copied VERBATIM out of
 * this repository's own mcp-server/src/ tree (provenance table in that directory's
 * README.md). Nothing is authored for the benchmark and nothing is edited. They
 * sit outside src/ so the toolchain never compiles them — their relative imports
 * dangle by design, which is irrelevant: scan_folder reads a file's TEXT.
 *
 * ── GROUND TRUTH IS DERIVED, NOT TYPED IN ───────────────────────────────────
 * Each case carries a `truthRegexSource`: a mechanical rule over the fixture
 * bytes. `deriveMatchingFiles()` recomputes the MATCH set from disk on every run,
 * exactly as ground-truth.ts:60 derives the keyword benchmark's truth from its
 * fixtures. The fixtures are the single source of truth — the expected answer
 * CANNOT drift from the corpus, because it is computed from the corpus.
 *
 * `expectedMatchFiles` is checked in anyway, as a TRIPWIRE, not as the
 * definition: validateDataset recomputes the set and THROWS on any disagreement.
 * So a fixture edit that silently changes an answer cannot pass unnoticed, and a
 * mistyped regex cannot silently redefine the truth. Two independent statements of
 * the same fact, and a hard failure when they diverge.
 *
 * ── WHY THE RULE AND THE QUESTION ARE THE SAME STATEMENT ────────────────────
 * The honesty of a derived truth stands or falls on one thing: the regex must be
 * COEXTENSIVE with the question the model is asked, on THIS corpus. So the
 * criterion prose is written to name the very API the regex looks for ("via Node's
 * child_process API"), and every fixture was read to confirm neither a false
 * positive (the token appearing only in a comment) nor a false negative (the
 * capability reached by some other route) exists here. The regex is a CHECKER of a
 * fact about real code, not a definition pulled out of the air.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScanFolderCase {
  /** Unique case id (kebab-case). */
  id: string;
  /**
   * The per-file question, in the caller's own words. Fed to the pipeline inside
   * the anchored contract built by `buildInstructions` — never on its own, so
   * every case shares ONE output contract.
   */
  criterion: string;
  /** File extensions handed straight to the pipeline (walkDir filters on them). */
  extensions: string[];
  /**
   * The MECHANICAL truth rule, as a regex SOURCE string (not a RegExp): a fixture
   * MATCHES the query iff this pattern hits its bytes.
   *
   * A string, not a RegExp object, for one load-bearing reason: the orchestrator
   * fingerprints the dataset with JSON.stringify to key its per-day cache, and
   * `JSON.stringify(/x/)` is `{}` — a RegExp would make every rule edit invisible
   * to the cache and serve a stale score for a changed benchmark.
   *
   * NO `g` flag anywhere: a global regex carries `lastIndex` between `.test()`
   * calls, so the same pattern would alternate hit/miss down the file list.
   */
  truthRegexSource: string;
  /**
   * TRIPWIRE (not the definition — see the module header). The set
   * `deriveMatchingFiles` must reproduce from disk, fixture-relative.
   */
  expectedMatchFiles: string[];
  /** Why this truth is unambiguous on this corpus — keeps future edits honest. */
  rationale: string;
}

/**
 * The forced per-file output contract, shared by EVERY case.
 *
 * This is the same device search_existing_implementations uses (its per-file
 * YES/NO line) and it is what makes the scorer pure code rather than a judge: the
 * model states its verdict on an anchored first line, and score.ts reads that line
 * with a regex. `instructions` is scan_folder's ordinary free-text user prompt, so
 * the tool is being exercised exactly the way a real caller exercises it — there
 * is no benchmark-only API.
 *
 * The "cite the identifier" clause is deliberate: it costs one short sentence of
 * output and it makes a lucky guess much harder than a considered answer. It is
 * NOT graded (grading whether a cited identifier really proves the claim is a
 * semantic judgment — see score.ts's honest-ceiling note), but it is printed in
 * the report for a human.
 */
export function buildInstructions(criterion: string): string {
  return [
    criterion,
    "",
    "OUTPUT FORMAT (mandatory). Your reply's FIRST line must be exactly one of:",
    "MATCH: <the exact identifier or import in this file that proves it>",
    "NO_MATCH",
    "",
    "Answer only about the file you were given. Judge what the code DOES, not what",
    "its name, its comments, or its documentation suggest. If the file does not meet",
    "the criterion, the first line must be exactly NO_MATCH.",
  ].join("\n");
}

/**
 * A corpus-level floor. A query whose MATCH set is empty cannot measure recall;
 * one whose NO_MATCH set is empty cannot measure precision. Either way the query
 * measures nothing, and a benchmark that measures nothing is worse than none —
 * it manufactures a passing grade. validateDataset THROWS below either floor.
 */
export const MIN_MATCHES_PER_CASE = 2;
export const MIN_NON_MATCHES_PER_CASE = 3;

/**
 * The three queries. Each is a question a real operator actually points
 * scan_folder at (an architecture/security sweep of an unfamiliar codebase), and
 * each has a mechanically derivable answer on this corpus.
 */
export const SCAN_FOLDER_CASES: ScanFolderCase[] = [
  {
    id: "spawns-external-process",
    criterion: [
      "Does this file START AN EXTERNAL PROCESS — that is, does it run another",
      "program or a shell command through Node's child_process API (spawn,",
      "spawnSync, exec, execSync, execFile, fork)?",
      "",
      "Running async tasks concurrently, scheduling work, awaiting promises, or",
      "managing a queue is NOT starting an external process.",
    ].join("\n"),
    extensions: [".ts"],
    // Both import forms are covered; `require("child_process")` cannot occur in
    // this ESM corpus but a future fixture could use it, and the rule should not
    // silently miss it.
    truthRegexSource:
      "(?:from\\s*[\"']node:child_process[\"'])|(?:require\\(\\s*[\"'](?:node:)?child_process[\"']\\s*\\))",
    expectedMatchFiles: ["src/embeddings.ts", "src/free-pool-auto-bench.ts"],
    rationale:
      "In Node there is no other way to start a process than child_process, so " +
      "'imports child_process' and 'starts a process' are the same fact. Verified " +
      "by reading all twelve fixtures: embeddings.ts uses spawnSync (the Python " +
      "embedder), free-pool-auto-bench.ts uses spawn (the detached benchmark " +
      "child), and the token appears nowhere else in the corpus — not even in a " +
      "comment. Two traps: rate-limiter.ts dispatches many async tasks in parallel " +
      "and reads like process management while starting nothing; and " +
      "security-triage-dataset.ts is saturated with the vocabulary of shell " +
      "execution ('command_injection', 'shell sink', 'shell=True') because it " +
      "DESCRIBES that threat class — it never executes anything.",
  },
  {
    id: "writes-to-filesystem",
    criterion: [
      "Does this file WRITE TO THE FILESYSTEM — that is, does it create,",
      "overwrite, append to, rename, or delete a file or directory using Node's fs",
      "API (writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync,",
      "rmSync, copyFileSync, createWriteStream)?",
      "",
      "READING the filesystem does NOT count. A file that only calls readFileSync,",
      "existsSync, readdirSync or statSync is NO_MATCH.",
    ].join("\n"),
    extensions: [".ts"],
    truthRegexSource:
      "\\b(?:writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync|rmSync|copyFileSync|createWriteStream)\\s*\\(",
    expectedMatchFiles: [
      "src/embeddings.ts",
      "src/free-pool-auto-bench.ts",
      "src/jsonl.ts",
      "src/preflight_benchmark.ts",
      "src/report.ts",
      "src/rule-install.ts",
    ],
    rationale:
      "Every match is a real call site (checked line by line — none is inside a " +
      "comment or a string). FOUR of the six NO_MATCH files import node:fs and are " +
      "read-only — doc-inventory.ts, project-root.ts, search-existing-dataset.ts " +
      "and security-triage-dataset.ts use readFileSync/existsSync/readdirSync/" +
      "statSync and nothing else. A model that keyword-matches 'fs' instead of " +
      "reading the code answers MATCH on all four and loses precision exactly " +
      "where it should.",
  },
  {
    id: "uses-node-crypto",
    criterion: [
      "Does this file USE A CRYPTOGRAPHIC PRIMITIVE from Node's crypto module —",
      "that is, does it import from 'node:crypto' and use it (hashing, HMAC, random",
      "bytes, UUIDs)?",
      "",
      "Merely handling secrets, tokens, passwords or API keys — redacting them,",
      "storing them, passing them to an HTTP header — is NOT using a cryptographic",
      "primitive, unless node:crypto itself is called.",
    ].join("\n"),
    extensions: [".ts"],
    truthRegexSource:
      "(?:from\\s*[\"']node:crypto[\"'])|(?:require\\(\\s*[\"'](?:node:)?crypto[\"']\\s*\\))",
    expectedMatchFiles: ["src/preflight_benchmark.ts", "src/rule-install.ts"],
    rationale:
      "preflight_benchmark.ts imports createHash, rule-install.ts imports " +
      "randomBytes; both really call them. Three traps, and they are why this query " +
      "cannot be answered by grepping for 'crypto': security-triage-dataset.ts " +
      "contains the literal string 'insecure_crypto' and prose about 'a broken hash " +
      "(md5/sha1)' and 'password hashing' because it DESCRIBES that threat; " +
      "search-existing-dataset.ts says 'Only token.ts touches crypto/signing'; and " +
      "report.ts is the SECURITY-scan reporter, saturated with secret/token/redact. " +
      "None of the three imports node:crypto.",
  },
];

/**
 * Resolve the on-disk fixture root. Mirrors code-task/dataset.ts and
 * search-existing/dataset.ts: the fixtures live OUTSIDE src/ so tsc/eslint/vitest
 * never touch them (they are verbatim snapshots that do not compile against
 * today's tree).
 */
export function resolveFixtureRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, "../../../benchmark-fixtures/scan-folder"),
    // dist/ bundle layout: dist/<bundle>.js → one level less deep.
    resolve(here, "../../benchmark-fixtures/scan-folder"),
    resolve(here, "../benchmark-fixtures/scan-folder"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  throw new Error(
    `scan-folder fixture root not found near ${here} — looked at:\n` +
      candidates.map((c) => `  ${c}`).join("\n"),
  );
}

/**
 * The directory scan_folder is actually pointed at — the `src/` subtree, NOT the
 * fixture root. The root also holds README.md (the corpus's provenance), and a
 * scan of the root would feed that README to the model as an eleventh "file",
 * where it would announce every answer in a table.
 */
export function fixtureScanRoot(root: string = resolveFixtureRoot()): string {
  return join(root, "src");
}

/** Recursively list fixture source files (fixture-relative, POSIX separators). */
export function listFixtureFiles(root: string = resolveFixtureRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(fixtureScanRoot(root), "src");
  return out.sort();
}

/** The fixture files a given case's `extensions` actually select. */
export function scannedFilesFor(
  c: ScanFolderCase,
  root: string = resolveFixtureRoot(),
): string[] {
  return listFixtureFiles(root).filter((f) => c.extensions.some((e) => f.endsWith(e)));
}

/** Absolute path of a fixture-relative file. */
export function fixtureAbsPath(rel: string, root: string = resolveFixtureRoot()): string {
  return join(root, rel);
}

/**
 * THE GROUND TRUTH. Recompute a case's MATCH set from the fixture bytes on disk.
 * This is the ONLY definition of the expected answer that the runner and the
 * scorer ever consult — `expectedMatchFiles` is a tripwire checked by
 * validateDataset, never a source.
 */
export function deriveMatchingFiles(
  c: ScanFolderCase,
  root: string = resolveFixtureRoot(),
): string[] {
  // Compiled per call, never cached: a shared RegExp would be one more piece of
  // mutable state between cases for no gain — this runs a handful of times.
  const re = new RegExp(c.truthRegexSource);
  return scannedFilesFor(c, root)
    .filter((rel) => re.test(readFileSync(fixtureAbsPath(rel, root), "utf-8")))
    .sort();
}

/**
 * A fingerprint over the questions AND the corpus bytes. The orchestrator keys its
 * per-model-per-day cache on this, so editing a fixture — not just the dataset —
 * invalidates yesterday's scores. Hashing only the cases would let a corpus edit
 * silently reuse a score computed against the OLD corpus.
 */
export function datasetFingerprint(root: string = resolveFixtureRoot()): string {
  const h = createHash("sha1");
  h.update(JSON.stringify(SCAN_FOLDER_CASES));
  for (const rel of listFixtureFiles(root)) {
    h.update(rel);
    h.update(readFileSync(fixtureAbsPath(rel, root)));
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Validate the dataset against the corpus on disk. Runs BEFORE a cent is spent.
 * Every check below is a way the benchmark could silently measure the wrong thing:
 *
 *  - a duplicate case id → one case's score overwrites another's in the report;
 *  - a missing / binary fixture → readFileAsCodeBlock refuses it, so EVERY model
 *    "fails" that file (P2b learned this the hard way with a NUL-bearing fixture);
 *  - derived ≠ expectedMatchFiles → the regex and the checked-in answer disagree,
 *    so one of them is wrong and we do not know which. HARD failure, not a warning;
 *  - too few matches / non-matches → the query cannot be got wrong, so passing it
 *    proves nothing.
 */
export function validateDataset(
  cases: readonly ScanFolderCase[] = SCAN_FOLDER_CASES,
  root: string = resolveFixtureRoot(),
): void {
  const files = listFixtureFiles(root);
  if (files.length === 0) {
    throw new Error(`scan-folder corpus is empty at ${fixtureScanRoot(root)}`);
  }

  for (const rel of files) {
    const bytes = readFileSync(fixtureAbsPath(rel, root));
    if (bytes.includes(0)) {
      throw new Error(
        `fixture ${rel} contains a NUL byte — readFileAsCodeBlock treats it as binary and REFUSES to read it, so no model could ever be scored on it.`,
      );
    }
  }

  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);

    if (/[gy]/.test(new RegExp(c.truthRegexSource).flags)) {
      // Unreachable via `new RegExp(src)` (which sets no flags) — asserted anyway
      // so a future refactor that starts carrying flags cannot introduce the
      // lastIndex bug silently. See ScanFolderCase.truthRegexSource.
      throw new Error(`case ${c.id}: truth regex must not be global/sticky`);
    }

    const scanned = scannedFilesFor(c, root);
    if (scanned.length !== files.length) {
      throw new Error(
        `case ${c.id}: its extensions ${c.extensions.join(",")} select only ${scanned.length}/${files.length} fixtures. ` +
          `The corpus is deliberately uniform — a per-case file subset would make the cases incomparable.`,
      );
    }

    const derived = deriveMatchingFiles(c, root);
    const expected = [...c.expectedMatchFiles].sort();
    if (JSON.stringify(derived) !== JSON.stringify(expected)) {
      const missing = expected.filter((f) => !derived.includes(f));
      const extra = derived.filter((f) => !expected.includes(f));
      throw new Error(
        `case ${c.id}: the truth regex and expectedMatchFiles DISAGREE — one of them is wrong.\n` +
          `  derived from disk: ${derived.join(", ") || "(none)"}\n` +
          `  checked in:        ${expected.join(", ") || "(none)"}\n` +
          (missing.length ? `  expected-but-not-derived: ${missing.join(", ")}\n` : "") +
          (extra.length ? `  derived-but-not-expected: ${extra.join(", ")}\n` : "") +
          `Fix the regex or the list — do NOT edit a fixture's bytes to make them agree.`,
      );
    }

    if (derived.length < MIN_MATCHES_PER_CASE) {
      throw new Error(
        `case ${c.id}: only ${derived.length} matching fixture(s) (need ≥ ${MIN_MATCHES_PER_CASE}) — recall is not measurable.`,
      );
    }
    const nonMatches = scanned.length - derived.length;
    if (nonMatches < MIN_NON_MATCHES_PER_CASE) {
      throw new Error(
        `case ${c.id}: only ${nonMatches} non-matching fixture(s) (need ≥ ${MIN_NON_MATCHES_PER_CASE}) — precision is not measurable, so answering MATCH to everything would pass.`,
      );
    }
  }
}
