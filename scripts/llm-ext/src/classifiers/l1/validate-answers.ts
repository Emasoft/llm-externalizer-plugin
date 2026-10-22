// Plan §6 answer-set rule (card L1-06): turns one parsed reply plus the questions asked into the Answers shape the specs project from.
import type { Answers } from "../catalog/spec.js";
import type { Question } from "./questions.js";
import { validateChoice } from "./validate-choice.js";
import { validateScore } from "./validate-score.js";
import { validateNoul, type ValidationPolicy } from "./validate.js";

export interface AnswerSet {
  answers: Answers;
  /** Reply keys no question asked about: ignored for validity, returned so the caller can log them (§6). */
  extra: string[];
}

export function validateAnswers(questions: Record<string, Question>, reply: Record<string, unknown>, p: ValidationPolicy): AnswerSet {
  const answers: Answers = {};
  // Why: response.ts:56 guarantees a plain object today, but this seam must not throw (Object.hasOwn(null) does) if a caller passes anything else.
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
    for (const key of Object.keys(questions)) answers[key] = { ok: false, reason: "reply has no answers object" };
    return { answers, extra: [] };
  }
  for (const [key, q] of Object.entries(questions)) {
    // Why hasOwn: a reply key such as "__proto__" or "toString" must not resolve through the prototype chain (E27 needs "missing" to be exact).
    if (!Object.hasOwn(reply, key)) {
      // E27: one missing answer invalidates only its own question; the rest of the reply stands.
      answers[key] = { ok: false, reason: "answer missing from reply" };
      continue;
    }
    const a = reply[key];
    // Why the type check lives in the per-type validators: they already refuse an explicit wrong `type` and accept an absent one (§6).
    answers[key] =
      q.type === "noul" ? validateNoul(a, p) : q.type === "choice" ? validateChoice(a, Object.keys(q.criteria), p) : validateScore(a, q.criteria.length, p);
  }
  return { answers, extra: Object.keys(reply).filter((k) => !Object.hasOwn(questions, k)) };
}
