import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { choice, noul, score, questionSet } from "./questions.js";
import { DEFAULT_POLICY, SCORE_POLICY } from "./validate.js";
import { validateAnswers } from "./validate-answers.js";

const real = (n: string): Record<string, unknown> => {
  const rec = JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url)), "utf8"));
  return JSON.parse(rec.body).answers;
};
const opts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`opt${i}`, `option ${i}`]));
const qs = questionSet({
  team: choice("pick", opts(3)),
  is_bug: noul("bug?"),
  rate: score("rate", ["a", "b", "c"]),
});
// Real replies, one per question, merged into a multi-question reply.
const full = (): Record<string, unknown> => ({ team: real("dec-choice3").team, is_bug: Object.values(real("dec-noul"))[0], rate: Object.values(real("dec-score3"))[0] });

describe("answer set", () => {
  it("real replies for all three questions are valid", () => {
    const r = validateAnswers(qs, full(), SCORE_POLICY);
    expect(Object.values(r.answers).map((a) => a.ok)).toEqual([true, true, true]);
    expect(r.extra).toEqual([]);
  });
  it("E27: one answer missing makes only that question invalid", () => {
    const reply = full();
    delete reply.is_bug;
    const r = validateAnswers(qs, reply, SCORE_POLICY);
    expect(r.answers.is_bug).toEqual({ ok: false, reason: "answer missing from reply" });
    expect(r.answers.team.ok).toBe(true);
    expect(r.answers.rate.ok).toBe(true);
  });
  it("an inherited name is not an answer", () => {
    const r = validateAnswers(questionSet({ toString: noul("x") }), {}, DEFAULT_POLICY);
    expect(Object.values(r.answers)[0].ok).toBe(false);
  });
  it("extra key is ignored and returned for logging", () => {
    const r = validateAnswers(qs, { ...full(), bonus: { type: "noul", noul: 1 } }, SCORE_POLICY);
    expect(Object.keys(r.answers)).toEqual(["team", "is_bug", "rate"]);
    expect(r.extra).toEqual(["bonus"]);
  });
  it("explicit wrong type is invalid, absent type is accepted", () => {
    const reply = full();
    reply.is_bug = { type: "choice", noul: 0.5 };
    expect(validateAnswers(qs, reply, SCORE_POLICY).answers.is_bug.ok).toBe(false);
    reply.is_bug = { noul: 0.5 };
    expect(validateAnswers(qs, reply, SCORE_POLICY).answers.is_bug.ok).toBe(true);
  });
  it("a choice answer naming a key outside the question is invalid", () => {
    const reply = full();
    reply.team = { type: "choice", choice: "nope", probabilities: { opt0: 1 } };
    expect(validateAnswers(qs, reply, SCORE_POLICY).answers.team.ok).toBe(false);
  });


  // Real captured reply (dec-multi3.json) to the three questions below: the first reply that ever held more than one answer.
  it("real 3-question reply validates to three Valid answers and no extra keys", () => {
    const asked = questionSet({
      is_bug: noul("Is the customer reporting a software defect?"),
      team: choice("Which category fits this ticket?", { opt0: "Category number 0 of the ticket.", opt1: "Category number 1 of the ticket.", opt2: "Category number 2 of the ticket." }),
      urgency: score("How urgent is this ticket?", ["level 0", "level 1", "level 2"]),
    });
    const r = validateAnswers(asked, real("dec-multi3"), SCORE_POLICY);
    expect(Object.keys(r.answers)).toEqual(["is_bug", "team", "urgency"]);
    expect(Object.values(r.answers).map((a) => a.ok)).toEqual([true, true, true]);
    expect(r.extra).toEqual([]);
  });

  it.each([[null], [[]], ["x"], [5]])("review 1: non-object reply %j never throws, every question is invalid, extra is empty", (bad) => {
    const r = validateAnswers(qs, bad as never, SCORE_POLICY);
    expect(Object.values(r.answers).map((a) => a.ok)).toEqual([false, false, false]);
    expect(Object.values(r.answers).every((a) => !a.ok && a.reason === "reply has no answers object")).toBe(true);
    expect(r.extra).toEqual([]);
  });
  // Review 2: real answers of the wrong kind, with and without `type`.
  const kinds = () => ({ team: full().team, is_bug: full().is_bug, rate: full().rate }) as Record<string, Record<string, unknown>>;
  const untyped = (a: Record<string, unknown>) => { const { type: _t, ...rest } = a; return rest; };
  const swaps: Array<[string, string]> = [["team", "is_bug"], ["is_bug", "rate"], ["rate", "team"]];
  it.each(swaps)("review 2: question %s given the %s-shaped answer is invalid (typed and untyped)", (q, from) => {
    const wrong = kinds()[from];
    for (const a of [wrong, untyped(wrong)]) {
      const reply = { ...full(), [q]: a };
      const res = validateAnswers(qs, reply, SCORE_POLICY).answers[q];
      expect(res.ok, JSON.stringify(a)).toBe(false);
    }
  });
});
