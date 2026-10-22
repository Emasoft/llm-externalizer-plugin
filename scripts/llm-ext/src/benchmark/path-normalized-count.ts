/**
 * PATH-INDEPENDENT workload measurement for the benchmark characterization tests.
 *
 * WHY THIS EXISTS. `describeWorkload()` reports `promptCharsPerModel` — the
 * characters a benchmark really puts on the wire for ONE model. The prompt text
 * a benchmark builds embeds the ABSOLUTE path of every file it sends
 * (`readFileAsCodeBlock` writes a `<filename>` tag holding the absolute path).
 * A count taken over that text therefore encodes the LENGTH OF THE CHECKOUT
 * ROOT: the same corpus measures a different number on a 45-character checkout
 * than on a 69-character one. The old pins were written for a 69-character
 * root, so they were green only on the machine that wrote them and red
 * everywhere else — CI, any other clone, a worktree.
 *
 * WHAT THIS FILE DOES. For each of the four file-sending workloads it rebuilds
 * the prompt EXACTLY as that workload's own `describeWorkload()` does — same
 * helper calls, same order, same constants — and reports TWO numbers:
 *
 *   `absolute`   — the count over the real prompt text, absolute paths and all.
 *                  This is what the real `describeWorkload()` returns, and the
 *                  test asserts it EQUALS the real thing. That equality is the
 *                  anti-drift check: if a workload's assembly ever changes, this
 *                  helper stops matching it and the test goes red.
 *   `normalised` — the same count over the same text with the FIXTURE-ROOT
 *                  prefix replaced by a fixed placeholder. The corpus's
 *                  LOCATION then contributes a constant instead of a
 *                  machine-specific number, and this is the number the pin
 *                  holds. The pin stays an EXACT equality, not a range.
 *
 * WHAT THIS FILE DOES NOT DO. It does not change production behaviour. The
 * real `describeWorkload()` — which feeds the real pre-flight cost estimate —
 * is untouched and still reports the true absolute-path-inclusive count. This
 * is a SECOND, parallel measurement used only by the characterization test, and
 * it exists to answer the question the pin is actually about: "can a later
 * change to a workload silently change WHAT A SCORE MEANS?".
 *
 * WHY THE COUNT STAYS EXACT. The normalisation is a pure text substitution, so
 * it shifts the count by a known constant (one per embedded path) and leaves
 * every other character — every corpus byte, every prompt the workload builds,
 * every system prompt — counted exactly as before.
 *
 * THE LAW. `absolute = normalised + N × (len(fixture_root) − len(placeholder))`,
 * where N is the number of times the fixture root appears in the counted text
 * (8, 36, 90 and 26 for the four workloads below), the placeholder is
 * FIXTURE_ROOT_PLACEHOLDER (14 characters), and `len(fixture_root)` is the
 * FIXTURE root — `<checkout-root>/scripts/llm-ext/benchmark-fixtures/<name>` —
 * NOT the checkout root, which is only a prefix of it.
 *
 * WHICH N BELONGS TO WHICH WORKLOAD: code-task 8, scan-folder 36,
 * search-existing 90, check-specs 26. security-triage and the text tools send
 * no file, so they carry no fixture root at all and their count is already
 * path-independent — for them the canonical number IS the absolute number.
 *
 * THIS IS A DELIBERATE COPY of each workload's prompt assembly, and it MUST be
 * changed in lockstep with the production assembly it mirrors. The copy is what
 * makes a path-independent count possible at all: production must keep
 * reporting the TRUE absolute count, so it cannot be made path-independent
 * itself. The drift is caught, not silent — the characterization test asserts
 * that this file's ABSOLUTE count equals the real `describeWorkload()` count,
 * so any change to the production assembly that alters the prompt's SIZE turns
 * the test red. (It is a character-count check, not a text equality: a change
 * that altered the prompt's CONTENT while preserving its length would not be
 * caught.)
 *
 * WHAT MAKES IT STILL A TEST. The normalisation removes only the corpus's
 * LOCATION. Change a fixture's content, or change what a workload sends, and
 * the count moves and the pin goes red.
 */

import { resolve } from "node:path";

import {
  buildPerFileSectionPrompt,
  buildPreInstructions,
  codeTaskSystemPrompt,
  detectLang,
  readAndGroupFiles,
  readFileAsCodeBlock,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from "../scan-pipeline.js";
import { CHECK_SPECS_SYSTEM_PROMPT } from "../check-specs/core.js";

import {
  CODE_AUDIT_INSTRUCTIONS,
  CODE_AUDIT_LANGUAGE,
  fixturePath as codeTaskFixturePath,
  loadDataset as loadCodeTaskCases,
  resolveFixtureRoot as resolveCodeTaskRoot,
} from "./code-task/dataset.js";
import {
  buildInstructions as buildScanFolderInstructions,
  fixtureAbsPath as scanFolderAbsPath,
  resolveFixtureRoot as resolveScanFolderRoot,
  SCAN_FOLDER_CASES,
  scannedFilesFor,
} from "./scan-folder/dataset.js";
import {
  listFixtureFiles,
  resolveFixtureRoot as resolveSearchExistingRoot,
  SEARCH_EXISTING_CASES,
} from "./search-existing/dataset.js";
import {
  CHECK_SPECS_FIXTURES,
  CHECK_SPECS_INSTRUCTIONS,
  fixtureAbsPath as checkSpecsAbsPath,
  resolveFixtureRoot as resolveCheckSpecsRoot,
  specPath,
} from "./check-specs/dataset.js";

/**
 * The placeholder that replaces the fixture-root prefix in the counted text.
 *
 * Its length is DELIBERATELY different from any real root, and it is FIXED —
 * that is the whole point. A placeholder whose length tracked the root would
 * make the normalised count silently equal to the absolute count on that one
 * machine, and the pin would be machine-specific again.
 */
export const FIXTURE_ROOT_PLACEHOLDER = "<FIXTURE_ROOT>";

/**
 * A workload's prompt size, measured two ways.
 */
export interface NormalisedPromptChars {
  /** The count over the REAL prompt text (absolute paths included). */
  absolute: number;
  /** The count over the same text with the fixture-root prefix normalised away. */
  normalised: number;
}

/**
 * Replace every occurrence of the fixture-root prefix in `text` with the fixed
 * placeholder.
 *
 * ALL occurrences are replaced, not just a leading one: a fixture whose own
 * content mentioned the root would otherwise make the count root-dependent
 * again. A text that does not contain the root is left alone.
 */
function normaliseText(text: string, fixtureRoot: string): string {
  if (fixtureRoot.length === 0 || !text.includes(fixtureRoot)) return text;
  return text.split(fixtureRoot).join(FIXTURE_ROOT_PLACEHOLDER);
}

// ── code-task ────────────────────────────────────────────────────────────────

/**
 * code-task's prompt size, measured both ways. Mirrors code-task/index.ts's
 * `describeWorkload()` call for call: the same pre-instructions, the same task
 * instructions, the same system prompt, one file block per case.
 */
export function normalisedCodeTaskPromptChars(): NormalisedPromptChars {
  const cases = loadCodeTaskCases();
  const fixtureRoot = resolveCodeTaskRoot();
  const preInstructions = buildPreInstructions(true, "read");
  const systemPrompt = codeTaskSystemPrompt(CODE_AUDIT_LANGUAGE);

  let absolute = 0;
  let normalised = 0;
  for (const c of cases) {
    const absPath = codeTaskFixturePath(c, fixtureRoot);
    // The REAL block — byte-identical to what the benchmark sends.
    const block = readFileAsCodeBlock(absPath, CODE_AUDIT_LANGUAGE);
    const userContent = `${preInstructions}Task: ${CODE_AUDIT_INSTRUCTIONS}\n\n${block}`;
    absolute += systemPrompt.length + userContent.length;

    const normalisedBlock = normaliseText(block, fixtureRoot);
    const normalisedContent = `${preInstructions}Task: ${CODE_AUDIT_INSTRUCTIONS}\n\n${normalisedBlock}`;
    normalised += systemPrompt.length + normalisedContent.length;
  }
  return { absolute, normalised };
}

// ── scan-folder ──────────────────────────────────────────────────────────────

/**
 * scan-folder's prompt size, measured both ways. Mirrors
 * scan-folder/index.ts's `describeWorkload()`: one call per (case, file), each
 * with its own language-specific system prompt and the same per-file prompt.
 */
export function normalisedScanFolderPromptChars(): NormalisedPromptChars {
  const fixtureRoot = resolveScanFolderRoot();
  const preInstructions = buildPreInstructions(true, "read");

  let absolute = 0;
  let normalised = 0;
  for (const c of SCAN_FOLDER_CASES) {
    const task = buildScanFolderInstructions(c.criterion);
    for (const rel of scannedFilesFor(c, fixtureRoot)) {
      const absPath = scanFolderAbsPath(rel, fixtureRoot);
      const systemPrompt = codeTaskSystemPrompt(detectLang(absPath));
      const block = readFileAsCodeBlock(absPath);
      const userPrompt = `${preInstructions}Task: ${task}\n\n${block}`;
      absolute += systemPrompt.length + userPrompt.length;

      const normalisedBlock = normaliseText(block, fixtureRoot);
      const normalisedPrompt = `${preInstructions}Task: ${task}\n\n${normalisedBlock}`;
      normalised += systemPrompt.length + normalisedPrompt.length;
    }
  }
  return { absolute, normalised };
}

// ── search-existing ──────────────────────────────────────────────────────────

/** search-existing's own fixed per-call prompt overhead (index.ts's constant). */
const FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL = 3000;

/**
 * search-existing's prompt size, measured both ways.
 *
 * This workload BIN-PACKS its files, so the number of calls depends on the
 * total block size — which depends on the path lengths. The grouping is
 * therefore re-derived here and then CHECKED: the corpus is a few KB against a
 * 400 KB budget, so every case fits in exactly ONE call. If that ever stops
 * holding, the bin packing would become path-sensitive (a longer checkout root
 * could split a case into two calls) and the normalised count would quietly
 * depend on WHERE the repo is cloned. So this refuses instead, loudly. The
 * characterization test's own `callsPerModel` pin (10 for 10 cases) covers the
 * same property from the other side.
 */
export function normalisedSearchExistingPromptChars(): NormalisedPromptChars {
  const fixtureRoot = resolveSearchExistingRoot();
  const allFixtureRel = listFixtureFiles(fixtureRoot);

  let absolute = 0;
  let normalised = 0;
  for (const c of SEARCH_EXISTING_CASES) {
    const sourceRel = new Set(c.sourceFiles ?? []);
    const scannedAbs = allFixtureRel
      .filter((rel) => c.extensions.some((ext) => rel.endsWith(ext)))
      .filter((rel) => !sourceRel.has(rel))
      .map((rel) => resolve(fixtureRoot, rel));

    const { groups } = readAndGroupFiles(
      scannedAbs,
      FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL,
      false, // redact_secrets: false — the runner's own default
      DEFAULT_MAX_PAYLOAD_BYTES,
      null,
    );

    if (groups.length !== 1) {
      throw new Error(
        `search-existing's corpus no longer fits in ONE call per case (got ${groups.length} groups) — ` +
          "the bin packing would become dependent on the checkout path's length, so the " +
          "path-normalised count is no longer well-defined. Generalise this helper (or pin the " +
          "packing itself) before changing the corpus.",
      );
    }

    for (const group of groups) {
      const groupPaths = group.map((fd) => fd.path);
      // The per-file section prompt is a literal template in production today
      // ("## File: <absolute-file-path>"), so it embeds no real path. That is
      // an ASSUMPTION, not a guarantee, and it is load-bearing: if it ever
      // interpolated a real path, the normalised count would silently become
      // checkout-dependent again while every assertion stayed green. So it is
      // CHECKED — and would fail loudly — AND it is normalised, because the
      // normalised count must be path-independent by construction, not by the
      // current shape of that function.
      const sectionPrompt = buildPerFileSectionPrompt(groupPaths);
      if (sectionPrompt.includes(fixtureRoot)) {
        throw new Error(
          "buildPerFileSectionPrompt now embeds the fixture root — the per-file " +
            "section prompt has become path-dependent, so the normalised count " +
            "would silently depend on where the repo is cloned. Normalise it " +
            "(or pin the section prompt) before proceeding.",
        );
      }
      const normalisedSectionPrompt = normaliseText(sectionPrompt, fixtureRoot);

      let callChars = FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL;
      if (groupPaths.length > 1) callChars += sectionPrompt.length;
      for (const fd of group) callChars += fd.block.length;
      absolute += callChars;

      let normalisedCallChars = FIXED_PROMPT_OVERHEAD_CHARS_PER_CALL;
      if (groupPaths.length > 1) normalisedCallChars += normalisedSectionPrompt.length;
      for (const fd of group) {
        normalisedCallChars += normaliseText(fd.block, fixtureRoot).length;
      }
      normalised += normalisedCallChars;
    }
  }
  return { absolute, normalised };
}

// ── check-specs ──────────────────────────────────────────────────────────────

/**
 * check-specs's prompt size, measured both ways. Mirrors
 * check-specs/index.ts's `describeWorkload()`: the spec block is re-sent on
 * EVERY call, so both the spec's path and each source file's path are
 * normalised.
 */
export function normalisedCheckSpecsPromptChars(): NormalisedPromptChars {
  const fixtures = CHECK_SPECS_FIXTURES;
  const root = resolveCheckSpecsRoot();
  const specBlock = readFileAsCodeBlock(
    specPath(root),
    undefined,
    false, // redact_secrets: false — the benchmark's own default
    DEFAULT_MAX_PAYLOAD_BYTES,
    null,
    "specs-",
  );

  let absolute = 0;
  let normalised = 0;
  for (const fixture of fixtures) {
    const fileBlock = readFileAsCodeBlock(
      checkSpecsAbsPath(fixture.file, root),
      undefined,
      false,
      DEFAULT_MAX_PAYLOAD_BYTES,
      null,
    );
    let userContent = "## SPECIFICATION (source of truth)\n\n" + specBlock + "\n\n";
    userContent += "## ADDITIONAL INSTRUCTIONS\n\n" + CHECK_SPECS_INSTRUCTIONS + "\n\n";
    userContent += "## SOURCE FILES TO CHECK\n\n" + fileBlock;
    absolute += CHECK_SPECS_SYSTEM_PROMPT.length + userContent.length;

    const normalisedSpec = normaliseText(specBlock, root);
    const normalisedFile = normaliseText(fileBlock, root);
    let normalisedContent = "## SPECIFICATION (source of truth)\n\n" + normalisedSpec + "\n\n";
    normalisedContent += "## ADDITIONAL INSTRUCTIONS\n\n" + CHECK_SPECS_INSTRUCTIONS + "\n\n";
    normalisedContent += "## SOURCE FILES TO CHECK\n\n" + normalisedFile;
    normalised += CHECK_SPECS_SYSTEM_PROMPT.length + normalisedContent.length;
  }
  return { absolute, normalised };
}
