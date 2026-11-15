> Approved plan for TRDD-S5KOOT2S, copied verbatim from the plan file the user approved (ExitPlanMode) on 2026-11-04; only two machine-local paths were genericized. The local-profile run of Phase 1 was dropped after approval; see the deviation section of TRDD-S5KOOT2S.

# Plan: requirement extraction with Jev, free/local LLM as the measured alternative (TRDD-S5KOOT2S, goal TRDD-Q2VTMG4P C1+C2)

## Context

The /goal (TRDD-Q2VTMG4P) needs C1, "extract the explicit requirements from a prompt", and C2, "use the earlier messages as context". The user's latest direction: split the prompt into sentences, let Jev score each one as requirement or not. The open problem is grouping: is a run of sentences one requirement or a list of separate ones? The user offered a free or local LLM as the alternative to test, and left the choice to me.

Facts verified this session that shape the design:
- No sentence splitter exists in `scripts/llm-ext/src`. `Intl.Segmenter` (Node 26.12.1) failed the user's own style. Given that prose line followed by two bullet lines, it returned three segments: the bullets split on their newlines, but the whole prose line "the colors are horrible. the loading screen background should be blue. e.g. use #00f!" came back as ONE segment, because ICU starts a sentence only before an uppercase letter. A custom splitter is required.
- `filter` propositions mode (`filter.ts:20-23,49-63`) packs up to 64 atomic propositions (≤2000 chars each) into shared requests. It judges each one true or false with `context` in the state. So any question wording can be measured today by embedding it in the proposition text.
- `classify label` in JSON mode packs atomic `{id,text}` units into shared requests and supports a job-wide `context` (`classifiers/catalog/label.ts:187,201`). `filter` items mode ignores context in its instruction (`filter.ts:85`) and costs one request per item. So label-style atomic noul questions are the right Jev shape.
- Jev only scores; it cannot write text. A classify command accepts only `classifier` profiles, and text commands only local/free/paid (`tools/definitions.ts:337-347`). A single command mixing Jev and an LLM would need a second profile slot. That is out of scope here.
- `check` presets cannot do per-sentence work: whole-result, unsplittable, refused on oversize (`check.ts:84-127`). A dedicated spec is the clean shape.

## Decision

1. **Splitting is code**, deterministic, in a new module.
2. **Scoring is Jev**: one noul question per sentence, "is this an explicit requirement?", with the earlier messages as `shared.context`.
3. **Grouping is Jev by default**, through a second noul question per ADJACENT pair: "does B continue A (refers back to it, qualifies it, gives an exception or example) so that it cannot stand alone as its own rule?" Both question kinds go in ONE call. Grouping and repairing the splitter's mistakes are the same act: a wrongly split sentence rejoins through the pair question.
4. **Requirement text is the verbatim concatenation of the group's sentences.** No rewrite, which keeps the user's own words. A pronoun stays inside its group, so it still resolves. This removes any need for an LLM in C1. The price: when a requirement's antecedent sits in a non-requirement sentence ("the colors are horrible. they should be blue."), that opinion sentence is necessarily carried into the requirement text. The user's loading-screen example ("the colors are horrible. the loading screen background should be blue.") is the opposite case. B stands alone, so the expected join is NO and only the second sentence should come out. Whether Jev agrees is measured, not guaranteed.
5. **The free/local LLM is the measured alternative** for scoring and grouping (Phase 1). The decision rule is declared below, before the data. If the LLM wins grouping, the product keeps Jev scoring and the skill documents an `llm ask` grouping recipe. A hybrid command is then minted as its own card, never done silently.

## Phase 0: run the blocked R1-R5 recipes (live data for the skills)

The earlier recipe workflow was refused by plan mode. Nothing ran, and no card may say it did. Resume it with `Workflow({scriptPath: <session-dir>/workflows/scripts/jev-recipes-live-check-<run>.js, resumeFromRunId: "wf_b654e31e-b24"})`, or re-dispatch with the step list in the recipe worker step list (a machine-local plan file; its steps are summarised in the next sentence). Those steps are: temp HOME/config, `--estimate` first, R1 filter+context, R2 label, R3 find json via `--input`, R4 label duplicate/updated_version/new (one run per rule, because context is job-wide), and R5 sem-deduplicate. Output goes to `reports_dev/jev-recipes/`. These results feed Phase 3 and LFTQCFUX/WYY3SPDX.

## Phase 1: measure before building (scratch only, nothing committed)

- Gold set, ~30 prompts in the user's lowercase style, written by me in `scripts_dev/req-extract/gold.jsonl`. Cases cover:
  - the user's loading-screen example
  - opinion only
  - a requirement spread over two sentences with "it" or "also"
  - a requirement plus an example sentence
  - bullet lists (separate requirements)
  - abbreviations ("e.g.") and file names
  - questions to the assistant
  - a requirement that depends on the previous message
- Gold definition: one requirement is a group of consecutive sentences where each later sentence refers back to or qualifies the earlier one. Each list item is its own requirement.
- Scratch splitter: the same rules as the product splitter below, in a scratch script.
- The gold set is my own grouping theory. The report says so: agreement with it is not independent corroboration. The user's loading-screen example is a named gold case with expected join=NO.
- **Run A (Jev):** two `classify filter --input` jobs per prompt in propositions mode, with the previous message as `context`. The proposition text embeds the EXACT question wording that `requirements.ts` will ship: the requirement question per sentence, and the join question per adjacent pair. What is measured is what ships. Use the temp HOME, `LLM_EXT_CONFIG_DIR` and `LLM_EXT_INSTALL_RULE=0` recipe from the earlier recipe plan (classifier profile in a temp settings.yaml, key read from the existing env var, never written).
- **Run B (LLM):** `llm ask` on the free profile. The input is the numbered sentence list plus context; the instruction asks for a JSON array `[{sentences:[ids]}]` listing the requirement groups. A local profile runs only if `llm-ext models calibration-status` shows a calibrated local model; otherwise it is reported as skipped.
- **Metrics:**
  - sentence requirement precision/recall/F1
  - adjacent-pair grouping accuracy
  - group exact-match per prompt
  - wall time
  - Jev metrics are also swept over thresholds 0.3 to 0.7
- **Decision rule (fixed now):**
  - Jev scoring ships if F1 ≥ 0.85 and is no more than 0.05 below the LLM's.
  - Jev grouping ships if pair accuracy ≥ 0.85 and is no more than 0.05 below the LLM's.
  - Otherwise that step goes to the LLM recipe.
  - If neither engine reaches 0.85, stop and bring the numbers to the user.
- Report: `reports_dev/req-extract/<ts>-ab-report.md` (raw replies), summary `reports/req-extract/<ts>-ab-summary.md` (sanitized).

## Phase 2: build the `classify requirements` spec (Jev path)

New files (pattern: `classifiers/catalog/label.ts`, `filter.ts`):
- `scripts/llm-ext/src/classifiers/l2/sentences.ts`, which exports `splitSentences(text)` → `[{id:"s1",text,kind:"text"|"code"}]`. Rules:
  - A blank line, or a line starting with a list marker (`-`, `*`, `•`, `1.`, `1)`), starts a new segment. A soft-wrapped line is joined.
  - Within a segment, split after `[.!?]+` plus whitespace, whatever the case of the next letter.
  - Do not split after an abbreviation from a fixed list (e.g, i.e, etc, vs, cf, approx, Mr, Dr), after a single-letter initial, or inside backticks or quotes.
  - A fenced code block becomes one `kind:"code"` segment that is not scored.
- `scripts/llm-ext/src/classifiers/catalog/requirements.ts`: the DecisionSpec.
  - Input zod `{prompt: string, context?: string}`.
  - `cli.document` on `prompt` (IN-06) and spec flag `--context <file|->` with `file: true` (IN-05).
  - `build`: the same instruction template as filter propositions, so the shipped prompt equals the Phase 1 measured prompt. Atomic units `s<i>` carry the requirement question with the sentence. Units `j<i>` carry the join question for each adjacent pair (`A: …\nB: …`). Sentences are capped at 2000 chars. `sharedState` is the context (or null), under `dataGuard`. Putting the sentence in the instruction is the caller's own data at the same trust level as filter propositions; say so in a WHY comment.
  - `split: per-item`.
  - Thresholds: `threshold` 0.5, `join` 0.5, `band` 0.15. Check BOTH `join` and the `context` spec flag against the shared-flag clash test (`tools/definitions-classify.test.ts:57`) before naming them.
  - `project` returns `requirements:[{id,sentences,text,p,borderline}]` plus `sentences:[{id,text,p_req,p_join_next}]` and `invalid`. A group is a maximal run of requirement sentences linked by `join`. A non-requirement sentence joined to a requirement neighbor (an example or exception) is absorbed into that requirement.
- Tests:
  - `l2/sentences.test.ts`, pure, including the ICU failure case above.
  - `catalog/requirements.test.ts`: build/project over captured real replies (`classifiers/__fixtures__/` pattern), plus a partial-failure scenario via `catalog/partial-failure.testkit.ts` `runUnder`.
- Registration and gates:
  - Add an entry to `DECISION_SPECS` (`classifiers/catalog/index.ts`).
  - Add a `SAMPLES` entry (`catalog/index.test.ts`).
  - Add an `INPUTS` entry and capture `__fixtures__/o4/requirements.json` with `scripts_dev/capture-o4mszig5.ts` (live, key from env, temp HOME).
  - Add the test files to the explicit include list in `scripts/llm-ext/vitest.config.ts`. That file carries another session's uncommitted line, so stage ONLY my hunk: `git diff` → patch → `git apply --cached`, then verify with `git diff --cached`.
  - CLI actions and tool rows are generated from the registry; no hand edit.
- Eval dataset: move the gold set to the EV-01 format (`benchmark/classify-eval/dataset.ts`: `<dir>/requirements.jsonl`, input validated by the spec schema).

## Phase 3: skills (goal Q2VTMG4P)

Write the following only from live-verified runs:
- In `skills/llm-externalizer-cli-reference/references/classify.md`: a `classify requirements` section with the user's example, verbatim command and output, plus the fix to the false `--estimate` claim (classify.md:3).
- A new `references/requirements-pipeline.md` covering:
  - the three-step pipeline from the goal: extract (this spec); duplicate / updated_version / new (TRDD-LFTQCFUX, documented as pending if not built); and merge, which keeps the preexisting rule's form
  - the user's three cases verbatim
- A link from `SKILL.md`.

## Card bookkeeping (via trddgrep, after approval)

- Record the user's latest directive verbatim on TRDD-S5KOOT2S.
- Record the Phase 1 numbers and the decision taken on S5KOOT2S.
- Rewrite TRDD-Q2VTMG4P's STATE as one current block (review finding on 617e71f8).
- If the LLM wins grouping, mint a card for a hybrid Jev+LLM command (two profile slots).

## Verification

- Phase 1: the A/B report exists, with per-prompt raw verdicts, and the decision rule is applied as written.
- Phase 2:
  - `npx vitest run src/classifiers/l2/sentences.test.ts src/classifiers/catalog/requirements.test.ts src/classifiers/catalog/index.test.ts src/classifiers/catalog/live-capture.test.ts src/tools/definitions-classify.test.ts`
  - `npx tsc --noEmit`, `npx eslint src --max-warnings 0`
  - full `npm test` once
  - Live: `llm-ext classify requirements prompt.txt --context prev.txt --json` on the user's example. The command must run and return valid rows; a crash or an invalid row is a build failure. The content is a measured result: expected is one requirement, "the loading screen background should be blue", with the opinion sentence not absorbed. A miss is recorded as a measured failure on S5KOOT2S, not hidden.
- Phase 3: every command quoted in the skill was run, and its output was captured to `reports_dev/req-extract/`.
- Commits by file name only, with `TRDD-S5KOOT2S` in the subject, followed by a review fork.
