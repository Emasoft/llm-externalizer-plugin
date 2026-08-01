/**
 * code_task (CODE AUDIT) GOLDEN DATASET — types, loader, symbol-universe
 * extractor, and the audit instructions fed to the real pipeline (P2b).
 *
 * ── Where the corpus comes from (NO fabricated code, ever) ──────────────────
 * Every defect fixture is a VERBATIM pre-fix snapshot of a real file from this
 * repository's own git history:
 *
 *     git show <fixCommit>^:<originalPath>  >  benchmark-fixtures/code-task/<file>
 *
 * so each "planted" defect is a defect that really shipped and was really fixed.
 * The commit that fixed it supplies both the buggy symbol (from the diff hunk)
 * and the rationale (from the commit message) — nothing is invented.
 *
 * ── The LATENT-DEFECT rule (why the snapshot is the parent of the LATEST fix) ──
 * A pre-fix snapshot contains the defect its fix commit removed AND every defect
 * that was fixed LATER in the same file. Scoring a model as WRONG for spotting a
 * later-fixed defect would penalise the best models. So the snapshot is taken at
 * the parent of the LATEST fix commit touching that file, and `buggySymbols`
 * carries every symbol that commit repaired. With no later fix to that file, the
 * listed symbols are the ONLY defects our history knows about in that snapshot.
 * (grouping.ts is the deliberate exception: its snapshot is one fix EARLIER, so
 * it carries TWO verified defects — both are listed in `buggySymbols`, so the
 * invariant holds.)
 *
 * ── The CLEAN fixtures ──────────────────────────────────────────────────────
 * Current, unmodified `mcp-server/src/*.ts` files that NO fix commit has ever
 * touched in this repo's history (verifiable: `git log --grep='^fix' -- <file>`
 * is empty). They are the negative distractors — a model that invents defects in
 * them loses precision. They are named neutrally on disk (the model SEES the
 * filename in the file tag), so nothing leaks the answer.
 *
 * NOTHING here needs an LLM judge: the tool's own system prompt (scan-pipeline's
 * codeTaskSystemPrompt) orders the model to "Identify code by FUNCTION/CLASS/
 * METHOD NAME, never by line number", so a symbol NAME is the tool's own
 * contract and the only sound scoring key. See score.ts.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/** One labeled golden case. Mirrors a row of dataset.jsonl. */
export interface CodeAuditCase {
  /** Unique case id (kebab-case). */
  id: string;
  /** Fixture filename under benchmark-fixtures/code-task/ (no directories). */
  file: string;
  /**
   * Top-level symbols that carry a REAL defect in this snapshot. EMPTY for a
   * clean fixture — the negative distractors.
   */
  buggySymbols: string[];
  /**
   * Short free-text defect label taken from the fixing commit (NOT a forced
   * taxonomy — the corpus gets to have the classes it actually has). Recorded on
   * disk as ground truth and surfaced in the report; it is NOT a pass-gate,
   * because grading a model's free-text defect wording against this label is a
   * semantic-equivalence judgment and that needs an LLM judge (excluded by
   * design). See score.ts's header.
   */
  defectClass: string;
  /** The commit that FIXED the defect (empty for a clean fixture). */
  fixCommit: string;
  /** The file's original path in the repo (empty for a clean fixture). */
  originalPath: string;
  /**
   * The 1-based line of the defect in THIS snapshot (informational only — the
   * tool forbids line-number identification, so the scorer never reads it). 0
   * for a clean fixture.
   */
  line: number;
  /** Why this truth is unambiguous — keeps future edits honest. */
  rationale: string;
  /** Provenance: `git show <sha>^:<path>`, or `HEAD:<path>` for a clean file. */
  source: string;
}

/**
 * The audit task handed to the REAL code_task pipeline, verbatim, for every
 * case. Two things it must do:
 *
 *  1. SCOPE the audit to genuine defects. Without this, every model reports
 *     style nits on the clean fixtures and the precision signal is noise about
 *     verbosity rather than about code understanding.
 *  2. Force a machine-parseable ANCHOR (`DEFECT: <symbol> — <why>`). This is the
 *     same trick search-existing uses (its YES/NO per-file contract) and it is
 *     what makes the scorer pure code: no LLM judge, no negation heuristics on
 *     the happy path. `instructions` is the tool's normal free-text user prompt,
 *     so this is the tool used exactly as a real caller uses it — not a bespoke
 *     benchmark-only API.
 *
 * A model that ignores the anchor is NOT scored 0 on formatting alone: score.ts
 * falls back to a documented free-text extractor (see its `parseMode`).
 */
export const CODE_AUDIT_INSTRUCTIONS = [
  "Audit this file for GENUINE DEFECTS — bugs that cause incorrect behavior, data loss,",
  "a crash, a silent failure, a security hole, or a cost regression.",
  "",
  "Do NOT report style, naming, formatting, missing tests, missing documentation,",
  "type-annotation nits, or hypothetical improvements. Those are not defects.",
  "",
  "OUTPUT FORMAT (mandatory):",
  "For EVERY defect you find, emit one line of exactly this form:",
  "DEFECT: <functionName> — <one sentence explaining the bug>",
  "Use the exact identifier of the top-level function, class, or method that contains",
  "the bug. One line per defect. Do not mention a symbol in a DEFECT line unless it",
  "really is defective.",
  "If the file contains no genuine defect, reply with exactly this line and nothing else:",
  "NO DEFECTS",
].join("\n");

/** The language passed to the pipeline for every fixture (they are all TS). */
export const CODE_AUDIT_LANGUAGE = "typescript";

/**
 * Symbols shorter than this are excluded from the universe (see
 * listTopLevelSymbols). A 1-3 char identifier (`id`, `fn`, `of`) collides with
 * ordinary English inside a free-text report, which would manufacture phantom
 * findings in score.ts's free-text mode. No real fixture symbol is this short —
 * validateDataset THROWS if a declared buggy symbol is, so the corpus can never
 * silently depend on a name the scorer refuses to see.
 */
export const MIN_SYMBOL_LENGTH = 4;

/**
 * Corpus-level floor on the number of NON-buggy top-level symbols across the
 * defect fixtures — the "ways to be wrong". This is what makes the benchmark a
 * LOCALIZATION test rather than a bug/no-bug one: with a big pool of innocent
 * symbols, a model that shotguns every function in the file destroys its own
 * precision. See validateDataset's header for why this is a corpus-level rule
 * and not a per-file one.
 */
export const MIN_DISTRACTOR_SYMBOLS = 20;

/**
 * Resolve the on-disk fixture root. Mirrors search-existing/dataset.ts: the
 * fixtures live OUTSIDE src/ so tsc/eslint/vitest never touch them (they are
 * historical snapshots that do not compile against today's tree).
 */
export function resolveFixtureRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, "../../../benchmark-fixtures/code-task"),
    // dist/ bundle layout: dist/<bundle>.js → one level less deep.
    resolve(here, "../../benchmark-fixtures/code-task"),
    resolve(here, "../benchmark-fixtures/code-task"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  throw new Error(
    `code-task fixture root not found near ${here} — looked at:\n` +
      candidates.map((c) => `  ${c}`).join("\n"),
  );
}

/**
 * Resolve dataset.jsonl. Mirrors security-triage's resolveDatasetPath(): works
 * whether running unbundled from src/benchmark/code-task/ or from the esbuild
 * bundle in dist/ (which reads the .jsonl back out of src/ at runtime).
 */
export function resolveDatasetPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "dataset.jsonl"),
    join(here, "..", "src", "benchmark", "code-task", "dataset.jsonl"),
    join(here, "..", "..", "src", "benchmark", "code-task", "dataset.jsonl"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate the code-task dataset. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

/**
 * The SYMBOL UNIVERSE of one fixture: every top-level name the model is allowed
 * to be scored on. Derived from the fixture's AST at run time — the fixture is
 * the single source of truth, exactly as buildGroundTruth (ground-truth.ts) does
 * for the keyword benchmark, so truth can never drift from the corpus.
 *
 * Included (this is precisely what the tool's system prompt tells the model to
 * name — "FUNCTION/CLASS/METHOD NAME"):
 *   - `function NAME(...)` at top level (exported or not),
 *   - `const NAME = (...) => …` / `const NAME = function …` at top level,
 *   - `class NAME` at top level.
 *
 * DELIBERATELY EXCLUDED — class METHODS and nested helpers. Method names are
 * routinely bare English verbs (`find`, `union`, `get`, `add`); scanning a
 * free-text report for them would score prose ("could not find any bug") as a
 * finding. Every defect in this corpus lives in a top-level function, so nothing
 * real is lost; validateDataset enforces that (a buggy symbol outside the
 * universe is a hard error).
 */
export function listTopLevelSymbols(source: string, filename = "fixture.ts"): string[] {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true);
  const names: string[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      names.push(stmt.name.text);
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      names.push(stmt.name.text);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          names.push(decl.name.text);
        }
      }
    }
  }

  // Dedupe + drop the too-short names the scorer refuses to look for.
  return [...new Set(names)].filter((n) => n.length >= MIN_SYMBOL_LENGTH).sort();
}

/** Read a fixture's source text. */
export function readFixture(c: CodeAuditCase, root: string = resolveFixtureRoot()): string {
  return readFileSync(join(root, c.file), "utf-8");
}

/** Absolute on-disk path of a case's fixture. */
export function fixturePath(c: CodeAuditCase, root: string = resolveFixtureRoot()): string {
  return join(root, c.file);
}

/**
 * Load + validate dataset.jsonl. The first line is a `_schema` doc string and is
 * skipped. Every data row is strictly validated — a malformed dataset is a hard
 * error, because a benchmark that silently scores against a broken corpus is
 * worse than no benchmark.
 */
export function loadDataset(path: string = resolveDatasetPath()): CodeAuditCase[] {
  const raw = readFileSync(path, "utf-8");
  const cases: CodeAuditCase[] = [];
  const seenIds = new Set<string>();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`dataset.jsonl line ${i + 1}: invalid JSON: ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new Error(`dataset.jsonl line ${i + 1}: row must be a JSON object`);
    }
    const row = obj as Record<string, unknown>;
    if ("_schema" in row) continue;
    const parsed = parseCase(row, i + 1);
    if (seenIds.has(parsed.id)) {
      throw new Error(`dataset.jsonl line ${i + 1}: duplicate case id '${parsed.id}'`);
    }
    seenIds.add(parsed.id);
    cases.push(parsed);
  }
  if (cases.length === 0) {
    throw new Error(`dataset.jsonl at ${path} contained zero cases.`);
  }
  return cases;
}

function parseCase(row: Record<string, unknown>, lineNo: number): CodeAuditCase {
  const id = requireString(row, "id", lineNo);
  const file = requireString(row, "file", lineNo);
  const defectClass = requireString(row, "defectClass", lineNo);
  const rationale = requireString(row, "rationale", lineNo);
  const source = requireString(row, "source", lineNo);

  if (!Array.isArray(row.buggySymbols)) {
    throw new Error(`dataset.jsonl line ${lineNo} (${id}): buggySymbols must be an array`);
  }
  const buggySymbols: string[] = [];
  for (const s of row.buggySymbols) {
    if (typeof s !== "string" || s.length === 0) {
      throw new Error(
        `dataset.jsonl line ${lineNo} (${id}): buggySymbols[] entry ${JSON.stringify(s)} is not a non-empty string`,
      );
    }
    if (!buggySymbols.includes(s)) buggySymbols.push(s);
  }

  const clean = buggySymbols.length === 0;
  // A defect case MUST carry its provenance; a clean case MUST NOT claim any.
  const fixCommit = typeof row.fixCommit === "string" ? row.fixCommit : "";
  const originalPath = typeof row.originalPath === "string" ? row.originalPath : "";
  const line = typeof row.line === "number" ? row.line : 0;
  if (!clean && (fixCommit === "" || originalPath === "")) {
    throw new Error(
      `dataset.jsonl line ${lineNo} (${id}): a defect case must declare fixCommit + originalPath (its git provenance).`,
    );
  }
  if (clean && fixCommit !== "") {
    throw new Error(
      `dataset.jsonl line ${lineNo} (${id}): a CLEAN case (buggySymbols: []) must not declare a fixCommit.`,
    );
  }

  return { id, file, buggySymbols, defectClass, fixCommit, originalPath, line, rationale, source };
}

function requireString(row: Record<string, unknown>, key: string, lineNo: number): string {
  const v = row[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`dataset.jsonl line ${lineNo}: '${key}' must be a non-empty string`);
  }
  return v;
}

/**
 * Validate the dataset against the on-disk fixture corpus. Throws with a precise
 * message on drift. The invariants, and why each one exists:
 *
 *   1. every fixture file exists                → a missing snapshot would score
 *                                                 every model as a pipeline failure;
 *   2. no NUL bytes                             → readFileAsCodeBlock REFUSES a
 *                                                 binary file, so such a fixture
 *                                                 could never be scored at all
 *                                                 (this is not hypothetical: the
 *                                                 first draft of this corpus had
 *                                                 one and every model would have
 *                                                 "failed" it);
 *   3. every buggySymbol is IN the fixture's    → truth outside the universe is
 *      AST symbol universe                        unreachable — the scorer could
 *                                                 never award recall for it;
 *   4. every fixture exposes ≥1 scorable symbol → a file the extractor sees
 *                                                 nothing in cannot be scored;
 *   5. ≥1 defect case AND ≥1 clean case         → without both, precision or
 *                                                 recall is unmeasurable;
 *   6. ≥ MIN_DISTRACTOR_SYMBOLS non-buggy       → the CORPUS-level invariant that
 *      candidates across the defect cases         makes this a LOCALIZATION test
 *                                                 and not merely a bug/no-bug one.
 *
 * On (4) vs (6). A per-file "must offer ≥2 candidates" rule sounds right and is
 * wrong: ensemble-limits.ts legitimately declares exactly ONE top-level function,
 * and its defect (the catalog silently RAISING a calibrated output cap, doubling
 * the bill on reasoning models) is one of the most valuable in the corpus. That
 * case is a genuine DETECTION test — "did you see the bug at all, or did you say
 * NO DEFECTS?" — and throwing it away to satisfy a per-file rule would trade real
 * signal for a tidy invariant. What actually has to hold is that the corpus AS A
 * WHOLE gives a model plenty of ways to be WRONG, so precision is at genuine risk
 * and a shotgun cannot pass. That is a corpus-level property, so it is enforced
 * as one.
 */
export function validateDataset(
  cases: readonly CodeAuditCase[] = loadDataset(),
  root: string = resolveFixtureRoot(),
): void {
  let defectCases = 0;
  let cleanCases = 0;
  let distractors = 0;

  for (const c of cases) {
    const abs = join(root, c.file);
    if (!existsSync(abs)) {
      throw new Error(`case ${c.id}: fixture file missing on disk: ${c.file}`);
    }
    const bytes = readFileSync(abs);
    if (bytes.includes(0)) {
      throw new Error(
        `case ${c.id}: fixture ${c.file} contains a NUL byte — readFileAsCodeBlock treats it as binary and REFUSES to read it, so the case could never be scored.`,
      );
    }
    const universe = listTopLevelSymbols(bytes.toString("utf-8"), c.file);
    if (universe.length === 0) {
      throw new Error(
        `case ${c.id}: fixture ${c.file} exposes NO scorable top-level symbol — nothing about it can be scored.`,
      );
    }
    for (const s of c.buggySymbols) {
      if (!universe.includes(s)) {
        throw new Error(
          `case ${c.id}: buggySymbol '${s}' is not a scorable top-level symbol of ${c.file}. ` +
            `Universe: ${universe.join(", ")}. (A symbol under ${MIN_SYMBOL_LENGTH} chars, a class method, or a nested helper is excluded by design — see listTopLevelSymbols.)`,
        );
      }
    }
    if (c.buggySymbols.length === 0) {
      cleanCases++;
    } else {
      defectCases++;
      distractors += universe.length - c.buggySymbols.length;
    }
  }

  if (defectCases === 0) throw new Error("dataset has no defect case — recall is unmeasurable.");
  if (cleanCases === 0) throw new Error("dataset has no clean case — precision is unmeasurable.");
  if (distractors < MIN_DISTRACTOR_SYMBOLS) {
    throw new Error(
      `the defect fixtures offer only ${distractors} non-buggy candidate symbol(s) (need ≥ ${MIN_DISTRACTOR_SYMBOLS}). ` +
        `With too few ways to be WRONG, naming every symbol in the file would score well and the benchmark would measure nothing.`,
    );
  }
}
