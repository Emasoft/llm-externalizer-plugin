/**
 * Golden dataset for the check_against_specs (SPEC ADHERENCE) benchmark — P2d.
 *
 * ── WHAT IS SCORED, AND WHAT DELIBERATELY IS NOT ────────────────────────────
 * check_against_specs reads ONE specification and N source files and reports the
 * violations. In answer_mode 0 it makes one LLM call per source file and emits one
 * report per source file (check-specs/core.ts:303), so its atom of judgment is a
 * PER-FILE verdict: does THIS file violate the spec, or not?
 *
 * That per-file binary is the ONLY thing this benchmark grades, and the P2 dataset
 * spec is explicit about why (reports/model-pipeline/…-p2-golden-dataset-spec.md
 * §3). Two things the tool also emits are NOT scorable without an LLM judge, and a
 * judge is excluded by design:
 *
 *   1. EXACT-RULE MATCH. The tool asks the model to quote the spec rule it thinks
 *      was violated. Deciding whether that quote really paraphrases the intended
 *      clause — as opposed to a coincidental unrelated nitpick — is a
 *      semantic-equivalence judgment. Exact substring matching is far too brittle
 *      (models paraphrase), and anything looser IS a judge.
 *   2. SEVERITY (CRITICAL/HIGH/MEDIUM/LOW). Human reviewers disagree about
 *      severity. A `Severity: X` regex is trivially possible; scoring it
 *      correct/incorrect needs a subjective rubric, which is a judge in a costume.
 *
 * So the gate is CLEAN vs VIOLATION and nothing else. The corpus is engineered so
 * that "flagged a violation" and "flagged THE violation" coincide: each VIOLATION
 * fixture has exactly ONE plausible thing wrong with it against this spec, named in
 * the commit that fixed it.
 *
 * ── THE CORPUS IS REAL, AND SO IS THE SPEC (a hard project rule) ────────────
 * benchmark-fixtures/check-specs/ holds:
 *   • spec/TESTING.md — a verbatim copy of this repo's own shipped
 *     scripts/llm-ext/TESTING.md: the cost-safety contract the project actually lives by.
 *   • src/<blob>/… — THIRTEEN byte-for-byte snapshots of real revisions of real
 *     files in this repo, pulled straight out of git.
 *
 * Nothing is authored, nothing is edited, nothing is "planted". The four VIOLATION
 * fixtures are the exact bytes commit 31ce212 REPLACED — and the reason it replaced
 * them is the reason they are labelled violations. Its message records the damage:
 * $26.46 of OpenRouter spend over two days, $17.67 of it in the single hour
 * `npm test` ran ten times, because the test harness silently pointed at the user's
 * premium ensemble. The violations are not hypothetical. They cost real money.
 *
 * ── WHERE THE TRUTH COMES FROM (and why it is not a regex) ──────────────────
 * scan_folder's benchmark (P2c) DERIVES its truth from the corpus bytes with a
 * regex, because "this file imports child_process" and "this file starts a process"
 * are the same fact. Spec adherence is not like that: R1 and R2 below are violated
 * in structurally different ways, and "this test spends money" is not a regex.
 *
 * So the truth here is anchored the way P2b's code-audit corpus anchors its: in the
 * REAL FIX COMMIT. The label of every fixture is a fact about git history, recorded
 * in `provenance` and justified in `rationale` (both echoed in the report). What the
 * dataset DOES carry mechanically is a per-fixture TRIPWIRE (`probe`): a cheap,
 * checkable property that must still hold on the bytes — e.g. a fixture labelled
 * VIOLATION for lacking the `LIVE_TESTS` gate must, in fact, still lack it.
 * validateDataset runs every probe BEFORE a cent is spent, so a fixture that was
 * edited (or extracted from the wrong blob) fails loudly instead of silently
 * redefining the answer. The probe CHECKS the label; the commit DEFINES it.
 *
 * ── AND IT IS NOT GREP-SOLVABLE ─────────────────────────────────────────────
 * Three of the four violations sit in the corpus NEXT TO their own fixed twin — the
 * same file, ten lines apart, from the commit either side of the fix. No bag-of-
 * words strategy can separate a pair whose two members are 95% identical. The
 * adversarial baselines in ./score.ts are run against this corpus in
 * bench-runner.test.ts and are ASSERTED to score below the pass gate, so the corpus
 * cannot quietly decay into something a grep could pass (the P2c lesson: its first
 * corpus scored F1 0.909 for a keyword matcher and was worthless).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The per-file ground truth. Two values — that is the whole gradeable space. */
export type SpecVerdict = "VIOLATION" | "CLEAN";

/**
 * A mechanical tripwire on a fixture's bytes.
 *
 * NOT the definition of the label (the fix commit is — see the module header), but
 * a property that must still hold if the label is to make sense. `source` is a regex
 * SOURCE string, never a RegExp object, for the same reason as scan-folder's:
 * `JSON.stringify(/x/)` is `{}`, so a RegExp would be invisible to the dataset
 * fingerprint that keys the per-day score cache, and a rule edit would silently
 * serve a stale score.
 */
export interface TruthProbe {
  source: string;
  /** true → the pattern MUST match the fixture; false → it must NOT. */
  mustMatch: boolean;
  /** What the probe is asserting, in words. Printed when it fires. */
  says: string;
}

export interface SpecFixture {
  /** Fixture-relative path, POSIX separators (e.g. "src/b816534/live.test.ts"). */
  file: string;
  /** The graded label. */
  truth: SpecVerdict;
  /** `<git-blob>:<real path>` — how to reproduce these exact bytes. */
  provenance: string;
  /** Which spec rule is at stake (R1 / R2 / "none — no LLM call"). */
  rule: string;
  /** Why the label is true. Sourced from the fix commit, never from an opinion. */
  rationale: string;
  /** Mechanical tripwire, or null when the label is not regex-checkable. */
  probe: TruthProbe | null;
}

/**
 * The forced per-file output contract.
 *
 * `instructions` is check_against_specs's ordinary free-text parameter (the tool
 * injects it under "## ADDITIONAL INSTRUCTIONS", core.ts:317-320), so the benchmark
 * exercises the tool exactly the way a real caller does — there is no benchmark-only
 * API and no second prompt to drift.
 *
 * The CLEAN anchor is NOT invented here: rule 4 of the tool's own system prompt
 * already mandates the exact sentence "CLEAN — no spec violations found."
 * (check-specs/core.ts:157). All these instructions add is the matching VIOLATION
 * anchor and the discipline of putting the verdict FIRST, which is what turns the
 * scorer into pure string math instead of a judge.
 *
 * The one-line "which rule" clause on the VIOLATION anchor is deliberate: it costs a
 * few tokens, it makes a lucky guess more expensive than a considered answer, and it
 * is printed for a human to spot-check. It is NOT graded — see score.ts's honest
 * ceiling.
 */
export const CHECK_SPECS_INSTRUCTIONS = [
  "You are auditing exactly ONE source file against the specification above.",
  "",
  "OUTPUT FORMAT (mandatory). The FIRST line of your reply must be exactly one of:",
  "VIOLATION: <which spec rule this file breaks, in a few words>",
  "CLEAN — no spec violations found.",
  "",
  "Then, only if you answered VIOLATION, give the details the RULES section asks for.",
  "",
  "Judge what the code DOES, not what its name, its comments or its documentation",
  "suggest. A file that merely mentions, describes, or tests the subject of a rule",
  "does not thereby break it. A file that is not governed by a rule at all is CLEAN.",
].join("\n");

/**
 * THE CORPUS. Thirteen real files: 4 VIOLATION, 9 CLEAN.
 *
 * Small and honest, deliberately. Every fixture below earns its place — either it is
 * a real violation, its own fixed twin, or a distractor that a named cheap strategy
 * gets WRONG (see ./score.ts::NAIVE_STRATEGIES). Nothing is here to pad a count.
 */
export const CHECK_SPECS_FIXTURES: SpecFixture[] = [
  // ── The four real violations (pre-fix blobs, 31ce212^ = b816534) ──────────
  {
    file: "src/b816534/test-helpers.ts",
    truth: "VIOLATION",
    provenance: "31ce212^:mcp-server/src/test-helpers.ts",
    rule: "R1 — the default test backend must never bill",
    rationale:
      "Its own header states it: 'Uses the real ~/.llm-externalizer/settings.yaml — " +
      "the same file the server uses.' createTestClient copies that settings file " +
      "into EVERY spawned test server, unconditionally: there is no requireLiveBackend " +
      "opt-in in this revision at all. This is the root cause commit 31ce212 names — " +
      "the default `npm test` ran the user's premium 3-model ensemble for real.",
    // The R1 opt-in the spec REQUIRES does not exist anywhere in this revision. Its
    // absence is what makes the real backend unconditional.
    probe: {
      source: "requireLiveBackend",
      mustMatch: false,
      says: "the pre-fix helper has no requireLiveBackend opt-in — the real backend is unconditional",
    },
  },
  {
    file: "src/b816534/live.test.ts",
    truth: "VIOLATION",
    provenance: "31ce212^:mcp-server/src/live.test.ts",
    rule: "R2 — a real-LLM suite must self-skip unless opted into",
    rationale:
      "Every describe block here makes real LLM round-trips (chat, code_task, " +
      "compare_files, batch_check) against the user's configured backend, and NOT ONE " +
      "is gated: no LIVE_TESTS, no key check, no skipIf. It bills on any invocation.",
    probe: {
      source: "LIVE_TESTS",
      mustMatch: false,
      says: "no LIVE_TESTS gate anywhere in the pre-fix live suite",
    },
  },
  {
    file: "src/b816534/live-extended.test.ts",
    truth: "VIOLATION",
    provenance: "31ce212^:mcp-server/src/live-extended.test.ts",
    rule: "R2 — a real-LLM suite must self-skip unless opted into",
    rationale:
      "The same defect across seven ungated live describe blocks (chat, scan_folder, " +
      "batch_check, check_imports, check_references, deprecation, scan_secrets).",
    probe: {
      source: "LIVE_TESTS",
      mustMatch: false,
      says: "no LIVE_TESTS gate anywhere in the pre-fix extended live suite",
    },
  },
  {
    file: "src/b816534/security-scan-live.test.ts",
    truth: "VIOLATION",
    provenance: "31ce212^:mcp-server/src/security_scan/security_scan_live.test.ts",
    rule: "R2 — a real-LLM suite must self-skip unless opted into",
    rationale:
      "The subtle one, and the reason a model has to actually READ the gate rather " +
      "than notice that one exists: this suite IS gated — on HAS_KEY alone. The spec " +
      "requires BOTH LIVE_TESTS=1 AND the key. A half-gate fired the suite on every " +
      "`npm test` in any environment that had a key exported, which the dev machine " +
      "did — 'silently billing the user', as the fix commit puts it.",
    probe: {
      source: "LIVE_TESTS",
      mustMatch: false,
      says: "the pre-fix gate is HAS_KEY only — the LIVE_TESTS half of the gate is missing",
    },
  },

  // ── The four fixed twins (post-fix blobs, 31ce212) ────────────────────────
  // Textually ~95% identical to the violations above. This pairing is what makes
  // the corpus impossible to solve with a bag of words.
  {
    file: "src/31ce212/test-helpers.ts",
    truth: "CLEAN",
    provenance: "31ce212:mcp-server/src/test-helpers.ts",
    rule: "R1 — satisfied",
    rationale:
      "The fix. resolveTestConfig() now defaults to a synthetic LOCAL profile at " +
      "http://127.0.0.1:1 (a guaranteed-dead port, local mode → never contacts " +
      "openrouter.ai), and the real settings.yaml is copied ONLY when the caller " +
      "passes requireLiveBackend: true — which is precisely what TESTING.md says.",
    probe: {
      source: "requireLiveBackend",
      mustMatch: true,
      says: "the fixed helper carries the requireLiveBackend opt-in the spec requires",
    },
  },
  {
    file: "src/31ce212/live.test.ts",
    truth: "CLEAN",
    provenance: "31ce212:mcp-server/src/live.test.ts",
    rule: "R2 — satisfied",
    rationale:
      "The fix: every describe became describe.skipIf(!LIVE), where LIVE requires " +
      "LIVE_TESTS === '1' AND a non-empty OPENROUTER_API_KEY — both halves — and the " +
      "config is taken with requireLiveBackend: true, the sanctioned opt-in.",
    probe: {
      source: "LIVE_TESTS",
      mustMatch: true,
      says: "the fixed live suite gates on LIVE_TESTS",
    },
  },
  {
    file: "src/31ce212/live-extended.test.ts",
    truth: "CLEAN",
    provenance: "31ce212:mcp-server/src/live-extended.test.ts",
    rule: "R2 — satisfied",
    rationale: "The same fix, applied to all seven describe blocks.",
    probe: {
      source: "LIVE_TESTS",
      mustMatch: true,
      says: "the fixed extended live suite gates on LIVE_TESTS",
    },
  },
  {
    file: "src/31ce212/security-scan-live.test.ts",
    truth: "CLEAN",
    provenance: "31ce212:mcp-server/src/security_scan/security_scan_live.test.ts",
    rule: "R2 — satisfied",
    rationale:
      "The fix: the half-gate becomes the full one — LIVE_TESTS === '1' AND a " +
      "non-empty OPENROUTER_API_KEY.",
    probe: {
      source: "LIVE_TESTS",
      mustMatch: true,
      says: "the fixed security-scan live suite gates on LIVE_TESTS",
    },
  },

  // ── Real files the incident never touched (HEAD, a4d6241) ─────────────────
  {
    file: "src/a4d6241/security-triage-live.test.ts",
    truth: "CLEAN",
    provenance: "a4d6241:mcp-server/src/benchmark/security-triage/live.test.ts",
    rule: "R2 — satisfied",
    rationale:
      "A live suite that was ALREADY compliant when the incident happened — commit " +
      "31ce212's own message cites it as the pattern the broken suites were fixed TO. " +
      "It makes real, paid LLM calls and is correctly double-gated. Its presence is " +
      "the direct rebuttal of 'a live test is a violation': what matters is the gate.",
    probe: {
      source: "LIVE_TESTS",
      mustMatch: true,
      says: "an already-compliant live suite: real calls, correctly double-gated",
    },
  },
  {
    file: "src/a4d6241/test-helpers.test.ts",
    truth: "CLEAN",
    provenance: "a4d6241:mcp-server/src/test-helpers.test.ts",
    rule: "none — it makes no LLM call",
    rationale:
      "THE HARDEST CLEAN CASE, and the fixture that defeats the smartest cheap rule. " +
      "It contains `requireLiveBackend: true` (R1's opt-in marker) and carries NO " +
      "LIVE_TESTS gate, so EVERY mechanical rule an adversary can write from the spec " +
      "calls it a violation. It is compliant: it is the cost-safety REGRESSION GUARD, " +
      "and it only RESOLVES a config object to assert the default can never bill — it " +
      "never spawns a client, never opens a socket ('file read only — no network, no " +
      "spend'). A rule you cannot break by reading a file cannot be violated by " +
      "reading a file. Getting this one right requires reading the code.",
    // No probe: "this test spends nothing" is a fact about what the code DOES, and
    // there is no honest regex for it. The label rests on reading the file (its
    // imports are vitest + one local pure function) — stated plainly rather than
    // dressed up in a pattern that would only pretend to check it.
    probe: null,
  },
  {
    file: "src/a4d6241/config.test.ts",
    truth: "CLEAN",
    provenance: "a4d6241:mcp-server/src/config.test.ts",
    rule: "none — it makes no LLM call",
    rationale:
      "A settings-parser unit test. It contains the literal string " +
      '`url: "https://openrouter.ai/api"` — as a YAML fixture VALUE it writes to a temp ' +
      "file to test the parser — so any grep for the OpenRouter endpoint flags it. It " +
      "imports vitest, node:fs and local pure modules; it opens no socket and spends " +
      "nothing.",
    probe: null,
  },
  {
    file: "src/a4d6241/security-triage-runner.test.ts",
    truth: "CLEAN",
    provenance: "a4d6241:mcp-server/src/benchmark/security-triage/runner.test.ts",
    rule: "none — it makes no LLM call",
    rationale:
      "A hermetic transform test whose own header records that exercising the real " +
      "judge over fetchImpl is out of scope. No network, no gate needed, no violation.",
    probe: null,
  },
  {
    file: "src/a4d6241/pick.test.ts",
    truth: "CLEAN",
    provenance: "a4d6241:mcp-server/src/benchmark/pick.test.ts",
    rule: "none — it makes no LLM call",
    rationale:
      "A pure model-selection / settings-writer test over temp dirs. Saturated with " +
      "model ids and OpenRouter pricing vocabulary, and spends nothing.",
    probe: null,
  },
];

/**
 * Corpus floors. A corpus with no violations cannot measure recall; one with no
 * clean files cannot measure precision. Either way it measures nothing, and a
 * benchmark that measures nothing is worse than none — it manufactures a pass.
 * validateDataset THROWS below either floor.
 */
export const MIN_VIOLATIONS = 3;
export const MIN_CLEAN = 4;

/**
 * Resolve the on-disk fixture root. The fixtures live OUTSIDE src/ so tsc, eslint
 * and vitest never compile, lint or execute them — they are verbatim historical
 * snapshots whose imports do not resolve against today's tree, which is irrelevant
 * because check_against_specs reads a file's TEXT.
 */
export function resolveFixtureRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, "../../../benchmark-fixtures/check-specs"),
    // dist/ bundle layout: dist/<bundle>.js → one level less deep.
    resolve(here, "../../benchmark-fixtures/check-specs"),
    resolve(here, "../benchmark-fixtures/check-specs"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  throw new Error(
    `check-specs fixture root not found near ${here} — looked at:\n` +
      candidates.map((c) => `  ${c}`).join("\n"),
  );
}

/** The spec file handed to the tool as `spec_file_path`. */
export function specPath(root: string = resolveFixtureRoot()): string {
  return join(root, "spec", "TESTING.md");
}

/** Absolute path of a fixture-relative source file. */
export function fixtureAbsPath(rel: string, root: string = resolveFixtureRoot()): string {
  return join(root, rel);
}

/** The source files handed to the tool as `input_files_paths`, in dataset order. */
export function fixtureFilePaths(
  fixtures: readonly SpecFixture[] = CHECK_SPECS_FIXTURES,
  root: string = resolveFixtureRoot(),
): string[] {
  return fixtures.map((f) => resolve(fixtureAbsPath(f.file, root)));
}

/** The expected-VIOLATION set, as RESOLVED absolute paths (the scorer's key form). */
export function expectedViolations(
  fixtures: readonly SpecFixture[] = CHECK_SPECS_FIXTURES,
  root: string = resolveFixtureRoot(),
): Set<string> {
  return new Set(
    fixtures
      .filter((f) => f.truth === "VIOLATION")
      .map((f) => resolve(fixtureAbsPath(f.file, root))),
  );
}

/** Every file actually present under the fixture src/ tree (fixture-relative). */
export function listFixtureFiles(root: string = resolveFixtureRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(join(root, "src"), "src");
  return out.sort();
}

/**
 * A fingerprint over the labels, the instructions, the SPEC bytes AND the corpus
 * bytes. The orchestrator keys its per-model-per-day cache on this, so editing a
 * fixture — or the spec — invalidates yesterday's scores. Hashing only the dataset
 * object would let a corpus edit silently reuse a score computed against the OLD
 * corpus (scan-folder learned this; the same trap applies here, plus the spec, which
 * scan_folder does not have).
 */
export function datasetFingerprint(root: string = resolveFixtureRoot()): string {
  const h = createHash("sha1");
  h.update(JSON.stringify(CHECK_SPECS_FIXTURES));
  h.update(CHECK_SPECS_INSTRUCTIONS);
  h.update(readFileSync(specPath(root)));
  for (const rel of listFixtureFiles(root)) {
    h.update(rel);
    h.update(readFileSync(fixtureAbsPath(rel, root)));
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Validate the dataset against the corpus on disk. Runs BEFORE a cent is spent.
 * Every check below is a way this benchmark could silently measure the wrong thing:
 *
 *  - a duplicate fixture path → one file's verdict overwrites another's;
 *  - a fixture listed but absent from disk → readFileAsCodeBlock throws, the file is
 *    never dispatched, and EVERY model "fails" it;
 *  - a NUL byte → readFileAsCodeBlock treats the file as binary and REFUSES it (P2b
 *    hit exactly this with a real fixture), so again every model fails it;
 *  - a file on disk that the dataset does not label → it would be scanned by a
 *    folder-mode caller and graded against nothing. We pass an explicit file list, so
 *    this cannot happen at run time — but an unlabelled fixture is dead weight in the
 *    tree and a sign the corpus and the dataset have drifted apart, so say so;
 *  - a probe that no longer holds → the fixture's bytes changed (or the wrong blob
 *    was extracted) and the LABEL may no longer be true. HARD failure: a benchmark
 *    that scores models against a stale answer key is worse than no benchmark;
 *  - too few violations / too few clean files → the corpus cannot be got wrong.
 */
export function validateDataset(
  fixtures: readonly SpecFixture[] = CHECK_SPECS_FIXTURES,
  root: string = resolveFixtureRoot(),
): void {
  const spec = specPath(root);
  if (!existsSync(spec)) {
    throw new Error(`check-specs spec file missing: ${spec}`);
  }
  if (readFileSync(spec, "utf-8").trim().length === 0) {
    throw new Error(`check-specs spec file is empty: ${spec}`);
  }

  if (fixtures.length === 0) throw new Error("check-specs corpus is empty");

  const seen = new Set<string>();
  let violations = 0;
  let clean = 0;

  for (const f of fixtures) {
    if (seen.has(f.file)) throw new Error(`duplicate fixture: ${f.file}`);
    seen.add(f.file);

    const abs = fixtureAbsPath(f.file, root);
    if (!existsSync(abs)) {
      throw new Error(`fixture ${f.file} is listed in the dataset but missing on disk (${abs})`);
    }
    const bytes = readFileSync(abs);
    if (bytes.includes(0)) {
      throw new Error(
        `fixture ${f.file} contains a NUL byte — readFileAsCodeBlock treats it as binary and REFUSES to read it, so no model could ever be scored on it.`,
      );
    }
    if (f.rationale.trim().length < 40) {
      // Every label must carry its justification: the truth here is a claim about
      // real history, and a claim with no stated reason cannot be checked by the
      // next person to touch the corpus.
      throw new Error(`fixture ${f.file}: rationale is missing or too thin to check`);
    }

    if (f.probe) {
      if (/[gy]/.test(new RegExp(f.probe.source).flags)) {
        // Unreachable via `new RegExp(src)` (which sets no flags) — asserted anyway so
        // a future refactor that starts carrying flags cannot introduce the lastIndex
        // bug (a global regex keeps state between .test() calls) silently.
        throw new Error(`fixture ${f.file}: truth probe must not be global/sticky`);
      }
      const hit = new RegExp(f.probe.source).test(bytes.toString("utf-8"));
      if (hit !== f.probe.mustMatch) {
        throw new Error(
          `fixture ${f.file}: TRUTH PROBE FAILED — ${f.probe.says}.\n` +
            `  expected /${f.probe.source}/ to ${f.probe.mustMatch ? "MATCH" : "NOT match"} the fixture, but it ${hit ? "matched" : "did not match"}.\n` +
            `  These bytes came from ${f.provenance}. Re-extract them from git — do NOT edit a fixture to make the probe pass, and do NOT relax the probe to fit edited bytes.`,
        );
      }
    }

    if (f.truth === "VIOLATION") violations++;
    else clean++;
  }

  // The floors come BEFORE the tree-hygiene check below, because "can this dataset
  // measure anything at all?" is the more fundamental question: a corpus with nothing
  // to find hands out a passing grade for free, and that is worth saying first.
  if (violations < MIN_VIOLATIONS) {
    throw new Error(
      `only ${violations} VIOLATION fixture(s) (need ≥ ${MIN_VIOLATIONS}) — recall is not measurable.`,
    );
  }
  if (clean < MIN_CLEAN) {
    throw new Error(
      `only ${clean} CLEAN fixture(s) (need ≥ ${MIN_CLEAN}) — precision is not measurable, so flagging every file would pass.`,
    );
  }

  const onDisk = listFixtureFiles(root);
  const unlabelled = onDisk.filter((rel) => !seen.has(rel));
  if (unlabelled.length > 0) {
    throw new Error(
      `fixture file(s) on disk with no dataset entry: ${unlabelled.join(", ")}. ` +
        `Either label them or remove them — an unlabelled fixture is a file nobody has decided the truth about.`,
    );
  }
}
