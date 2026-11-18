// TRDD-S5KOOT2S Phase 2, plan §Phase 2 `classify requirements`: the explicit requirements of a prompt. The prompt is split into sentences in code (l2/sentences.ts), Jev labels each text sentence with one of four classes, and the sentences that are labelled "requirement" with enough confidence are returned verbatim. Grouping of consecutive sentences into one requirement is NOT done here: it did not pass on Jev and stays on the LLM (TRDD-428Y247Y), so the result carries EVERY sentence with its label for that later step.
import { z } from "zod";
import { choice } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { indexKey } from "../l2/ids.js";
import { splitSentences, type Sentence } from "../l2/sentences.js";
import { dataGuard, isBlank, renumberByPosition } from "./shared.js";
import type { Answers, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

// WHY the four descriptions are constants copied verbatim from the round-3 pre-registration of TRDD-S5KOOT2S: the scoring gate (held-out F1 0.961) was measured with exactly this wording, so any rewording is an unmeasured spec.
const CLASSES = [
  { id: "requirement", description: "a feature, behavior, property or rule the product must have from now on, even when phrased as a command (add X, make it Y, keep Z short)" },
  { id: "instruction", description: "an action on the current work that leaves nothing new to check in the product afterwards (run, rebuild, open, show me, commit, test, refresh)" },
  { id: "opinion", description: "expresses a view or feeling" },
  { id: "other", description: "a question, a description of how things are now, a greeting, or anything else" },
] as const;
const REQUIREMENT = CLASSES[0].id;

const KEY = "label";

const textSentences = (prompt: string): Sentence[] => splitSentences(prompt).filter((s) => s.kind === "text");

const requirementsInput = z
  .strictObject({
    prompt: z.string().refine((s) => !isBlank(s), "prompt must not be blank"),
    // The earlier messages of the conversation, background for the questions; never scored.
    context: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    // WHY refused here: a prompt that is only code blocks builds no question, and a build with no question is an error for every spec that does not set noCall.
    if (textSentences(v.prompt).length === 0) ctx.addIssue({ code: "custom", path: ["prompt"], message: "prompt has no text sentence to score (only code blocks)" });
  });
export type RequirementsInput = z.output<typeof requirementsInput>;

export interface SentenceRow {
  id: string;
  text: string;
  /** code: a fenced block, kept in order for the later grouping step but never sent to Jev. */
  kind: "text" | "code";
  label: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  /** label's own rule: a confidence at or above --min-confidence. A text sentence that is not accepted needs a human look. */
  accepted: boolean;
  invalid: string | null;
}
export interface RequirementRow {
  id: string;
  text: string;
  probabilities: Record<string, number> | null;
  confidence: number | null;
}
export interface RequirementsResult {
  /** The sentences whose label is "requirement" AND that are accepted, verbatim, in prompt order. */
  requirements: RequirementRow[];
  /** EVERY sentence of the prompt in order, code blocks included. */
  sentences: SentenceRow[];
  invalid: { id: string; reason: string }[];
}

export const spec: DecisionSpec<RequirementsInput, RequirementsResult> = {
  id: "requirements",
  // WHY a document spec: the one input is the prompt text, a file or - for stdin.
  cli: { document: { field: "prompt" } },
  // WHY `--context` and not a positional: the document command takes exactly one file. Neither the name nor the property clashes with a shared flag (tools/definitions-classify.test.ts checks the entry property set).
  flags: [
    { flag: "--context", property: "context", field: "context", file: true, help: "File with the earlier messages of the conversation (- reads stdin), used as background for every sentence; never scored.", parse: (raw) => raw },
  ],
  input: requirementsInput,
  thresholds: {
    "min-confidence": { default: 0.6, min: 0, max: 1, help: "--min-confidence: a sentence is a requirement only when its label is requirement and its confidence is at or above this" },
  },
  split: "per-item",
  injection: "index-scoped",
  validation: DEFAULT_POLICY,
  build(i) {
    const background = i.context === undefined ? "" : " Use `shared.context` as background.";
    // Why null criteria: the descriptions live once in shared state; repeating them in every sentence's question would multiply the cost by the sentence count.
    const criteria = Object.fromEntries(CLASSES.map((c) => [c.id, null]));
    // TRDD-0W932B0H: with a context the guard names shared.context too, because the earlier messages in it are untrusted text and must sit inside the injection guard (findings.ts names shared in its guard). Without a context the text is unchanged.
    const contextSubject = i.context === undefined ? "" : "`shared.context` and ";
    const units: BuiltUnit[] = textSentences(i.prompt).map((s, k) => ({
      kind: "atomic",
      state: { id: s.id, text: s.text },
      // WHY the wording of `classify label`: the scoring gate was measured through `classify label` in json mode, so the shipped question is that question byte for byte. The sentence text never reaches the instructions (D5): the question names the unit by position.
      questions: {
        [indexKey(KEY, k)]: choice(
          `Which class in \`shared.classes\` best describes \`units[${k}]\`? Answer with the class id. ${dataGuard(`${contextSubject}the content of \`units[${k}]\``, "classify")}${background}`,
          criteria,
        ),
      },
    }));
    return {
      // WHY purpose: null and not omitted: the measured jobs went through label's shared state, which always carries the key.
      sharedState: { purpose: null, context: i.context ?? null, classes: CLASSES.map((c) => ({ id: c.id, description: c.description })) },
      units,
      unsplittable: {},
      renumber: renumberByPosition,
    };
  },
  project(answers: Answers, i, t: Thresholds) {
    const all = splitSentences(i.prompt);
    const scored = all.filter((s) => s.kind === "text");
    const keys = scored.map((_, k) => indexKey(KEY, k));
    // The runner returns one answer per asked question; any other key set means a sentence was lost or invented, and a partial silent result would be worse than stopping.
    const got = Object.keys(answers);
    if (got.length !== keys.length || !keys.every((k) => Object.hasOwn(answers, k))) {
      throw new Error(`internal error: requirements answers name ${got.length} sentences (${got.join(", ")}) but the prompt has ${keys.length}`);
    }
    const sentences: SentenceRow[] = [];
    const invalid: { id: string; reason: string }[] = [];
    let k = 0;
    for (const s of all) {
      if (s.kind === "code") {
        sentences.push({ id: s.id, text: s.text, kind: "code", label: null, probabilities: null, confidence: null, accepted: false, invalid: null });
        continue;
      }
      const a = answers[keys[k++]!]!;
      if (!a.ok) {
        invalid.push({ id: s.id, reason: a.reason });
        sentences.push({ id: s.id, text: s.text, kind: "text", label: null, probabilities: null, confidence: null, accepted: false, invalid: a.reason });
        continue;
      }
      const c = a.answer as ChoiceAnswer;
      const confidence = c.confidence ?? null;
      // Why >= and a null confidence is not accepted: exactly `classify label` (label.ts), so the gate is the one that was measured. The stored confidence is the classifier's calibrated confidence in the chosen label, not the raw probability (TRDD-S5KOOT2S gate check: a 0.30 requirement probability can carry confidence 0.07).
      const accepted = confidence !== null && confidence >= t["min-confidence"];
      sentences.push({
        id: s.id, text: s.text, kind: "text", label: c.choice,
        probabilities: c.probabilities ? Object.assign(Object.create(null) as Record<string, number>, c.probabilities) : null,
        confidence, accepted, invalid: null,
      });
    }
    // WHY the gate is label === requirement AND accepted (G2 of TRDD-S5KOOT2S): argmax alone admitted "let's improve it a little." at confidence 0.07 in the goal example; G2 kept held-out F1 at 0.961 and returned exactly ["s3"] there. A post-hoc choice, disclosed on the card.
    const requirements = sentences
      .filter((r) => r.kind === "text" && r.label === REQUIREMENT && r.accepted)
      .map((r) => ({ id: r.id, text: r.text, probabilities: r.probabilities, confidence: r.confidence }));
    return { requirements, sentences, invalid };
  },
  // A text sentence that failed, or whose label is not confident enough, is for a human to check; a confident one is not.
  attention: (r) => r.sentences.some((s) => s.kind === "text" && (s.invalid !== null || !s.accepted)),
};
