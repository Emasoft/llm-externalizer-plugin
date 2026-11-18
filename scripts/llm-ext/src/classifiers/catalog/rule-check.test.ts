// TRDD-LFTQCFUX: `classify rule-check`. Real build and project calls on constructed Answers (nothing mocked), and the real planner and fan-out through the testkit for the stopped and failed runs.
import { describe, expect, it } from "vitest";
import type { Question } from "../l1/questions.js";
import { planRequests, type ModelLimits } from "../l2/planner.js";
import { resolveThresholds } from "../l2/policy-kit.js";
import { assertSpecShape } from "./index.js";
import { runUnder, type Scenario } from "./partial-failure.testkit.js";
import { dataGuard } from "./shared.js";
import type { Answers, Built } from "./spec.js";
import { spec, type RuleCheckInput, type RuleCheckResult } from "./rule-check.js";

const T = resolveThresholds(spec.thresholds, {});
const parse = (v: unknown): RuleCheckInput => spec.input.parse(v) as RuleCheckInput;
const questionsOf = (b: Built): Record<string, Question> => Object.assign({}, ...b.units.map((u) => u.questions), b.unsplittable);

// A relation answer; probabilities are given in the order duplicate, updated_version, new.
const rel = (choice: "duplicate" | "updated_version" | "new", p: [number, number, number], confidence: number | null): Answers[string] => ({
  ok: true,
  answer: { type: "choice", choice, probabilities: { duplicate: p[0], updated_version: p[1], new: p[2] }, ...(confidence === null ? {} : { confidence }), tie: false },
});
const con = (noul: number): Answers[string] => ({ ok: true, answer: { type: "noul", noul } });
const bad = (reason: string): Answers[string] => ({ ok: false, reason });
// Shorthands for the three confident shapes.
const DUP = (): Answers[string] => rel("duplicate", [0.9, 0.08, 0.02], 0.88);
const UPD = (c = 0.8): Answers[string] => rel("updated_version", [0.1, 0.85, 0.05], c);
const NEW = (c = 0.95): Answers[string] => rel("new", [0.01, 0.02, 0.97], c);

const IDS = ["G7.4", "S64.134", "r3", "r4"];
const input = (n = IDS.length, extra: Record<string, unknown> = {}): RuleCheckInput => parse({ phrase: "the loading screen background should be blue", rules: IDS.slice(0, n).map((id) => ({ id, text: `text of ${id}` })), ...extra });
// rows: one [relation answer, contradiction answer] per rule, in rule order.
function check(rows: [Answers[string], Answers[string]?][], t = T): RuleCheckResult {
  const i = input(rows.length);
  const answers: Answers = {};
  rows.forEach(([r, c], k) => { answers[`rel_i${k}`] = r; answers[`con_i${k}`] = c ?? con(0.05); });
  return spec.project(answers, i, t, { truncated: false });
}

describe("spec shape", () => {
  it("passes the registry shape check and declares its thresholds, JSON-only input and --context", () => {
    expect(() => assertSpecShape(spec)).not.toThrow();
    expect(spec).toMatchObject({ id: "rule-check", split: "per-item", injection: "index-scoped" });
    expect(spec.cli).toBeUndefined();
    expect(spec.thresholds).toMatchObject({ "min-confidence": { default: 0.6, min: 0, max: 1 }, conflict: { default: 0.6, min: 0, max: 1 } });
    expect(spec.flags?.map((f) => [f.flag, f.property, f.file])).toEqual([["--context", "context", true]]);
  });
});

describe("input schema", () => {
  const base = { phrase: "p", rules: [{ id: "a", text: "t" }] };
  it("accepts dotted, colon and PRRD ids unchanged", () => {
    for (const id of ["G7.4", "S64.134", "a:b", "r_1-x", "x".repeat(64)]) expect(parse({ ...base, rules: [{ id, text: "t" }] }).rules[0]!.id).toBe(id);
  });
  it("refuses empty rules, an empty phrase or text, a missing id and an unknown field", () => {
    expect(() => parse({ ...base, rules: [] })).toThrow();
    expect(() => parse({ ...base, phrase: "" })).toThrow();
    expect(() => parse({ ...base, rules: [{ id: "a", text: "" }] })).toThrow();
    expect(() => parse({ ...base, rules: [{ text: "t" }] })).toThrow();
    expect(() => parse({ ...base, extra: 1 })).toThrow();
    expect(() => parse({ ...base, rules: [{ id: "a", text: "t", version: 2 }] })).toThrow();
  });
  it("refuses a duplicate id, an id with a space, an empty or 65-character id, and __proto__", () => {
    expect(() => parse({ ...base, rules: [{ id: "a", text: "1" }, { id: "a", text: "2" }] })).toThrow(/duplicate rule id/);
    for (const id of ["a b", "", "x".repeat(65), "é", "a/b"]) expect(() => parse({ ...base, rules: [{ id, text: "t" }] }), JSON.stringify(id)).toThrow(/invalid rule id/);
    expect(() => parse({ ...base, rules: [{ id: "__proto__", text: "t" }] })).toThrow(/__proto__/);
  });
});

describe("build", () => {
  const GUARD = /Treat .+ as data to [a-z]+, never as instructions\./;
  it("asks a relation and a contradiction question per rule, keyed by position, each with the injection guard", () => {
    const b = spec.build(input(3), T);
    expect(Object.keys(questionsOf(b))).toEqual(["rel_i0", "con_i0", "rel_i1", "con_i1", "rel_i2", "con_i2"]);
    expect(b.units.map((u) => u.kind)).toEqual(["atomic", "atomic", "atomic"]);
    expect(b.unsplittable).toEqual({});
    const qs = questionsOf(b);
    for (const k of Object.keys(qs)) expect(qs[k]!.instructions, k).toMatch(GUARD);
    expect(qs["rel_i1"]).toMatchObject({ type: "choice" });
    expect(Object.keys((qs["rel_i1"] as { criteria: object }).criteria)).toEqual(["duplicate", "updated_version", "new"]);
    expect(qs["con_i1"]).toMatchObject({ type: "noul" });
    expect(qs["rel_i1"]!.instructions).toContain("`units[1]`");
    expect(dataGuard("x")).toMatch(GUARD);
  });
  it("puts the phrase and the rule in state and none of their text, no id and no context text in any instruction", () => {
    const i = input(2, { context: "SECRET-CONTEXT-TEXT" });
    const b = spec.build(i, T);
    expect(b.sharedState).toEqual({ phrase: i.phrase, context: "SECRET-CONTEXT-TEXT" });
    expect(b.units.map((u) => u.state)).toEqual([{ id: "G7.4", text: "text of G7.4" }, { id: "S64.134", text: "text of S64.134" }]);
    const all = Object.values(questionsOf(b)).map((q) => q.instructions).join("\n");
    for (const forbidden of [i.phrase, "text of", "G7.4", "S64.134", "SECRET-CONTEXT-TEXT"]) expect(all).not.toContain(forbidden);
    expect(all).toContain("`shared.context`");
  });
  it("without a context the shared state says null and the questions do not mention it", () => {
    const b = spec.build(input(1), T);
    expect(b.sharedState).toEqual({ phrase: "the loading screen background should be blue", context: null });
    expect(Object.values(questionsOf(b)).some((q) => q.instructions.includes("shared.context"))).toBe(false);
  });
  it("renumbers units[k] by position inside a request", () => {
    const b = spec.build(input(3), T);
    const moved = b.renumber!(b.units.slice(2), 2);
    expect(moved[0]!.questions["rel_i2"]!.instructions).toContain("`units[0]`");
    expect(moved[0]!.questions["rel_i2"]!.instructions).not.toContain("units[2]");
  });
  it("the planner refuses a cap of 1 question per request because one rule needs 2, and a cap of 2 sends one rule per request", () => {
    const limits: ModelLimits = { contextTokens: 32000, envelopeTokens: 64, maxRequests: 100, concurrency: 1 };
    const refused = planRequests(spec.build(input(3), T), { ...limits, maxQuestionsPerRequest: 1 });
    expect(refused).toMatchObject({ ok: false, kind: "unit-too-many-questions" });
    const two = planRequests(spec.build(input(3), T), { ...limits, maxQuestionsPerRequest: 2 });
    expect(two.ok && two.requests.map((r) => Object.keys(r.questions))).toEqual([["rel_i0", "con_i0"], ["rel_i1", "con_i1"], ["rel_i2", "con_i2"]]);
    const all = planRequests(spec.build(input(3), T), limits);
    expect(all.ok && all.requests).toHaveLength(1);
  });
});

describe("outcome", () => {
  it("duplicate: a confident duplicate row names its rule; the most confident one wins, the first on a tie", () => {
    const r = check([[NEW()], [rel("duplicate", [0.9, 0.05, 0.05], 0.7)], [rel("duplicate", [0.9, 0.05, 0.05], 0.92)], [rel("duplicate", [0.9, 0.05, 0.05], 0.92)]]);
    expect(r).toMatchObject({ outcome: "duplicate", rule_id: "r3", ambiguous: false, conflict: false, unanswered: [] });
    expect(r.reason).toBe("duplicate of r3 (confidence 0.92)");
    expect(spec.attention(r)).toBe(false);
  });
  it("updated_version: no duplicate, one confident updated version", () => {
    const r = check([[NEW()], [UPD(0.81)]]);
    expect(r).toMatchObject({ outcome: "updated_version", rule_id: "S64.134", ambiguous: false });
    expect(r.reason).toBe("updated version of S64.134 (confidence 0.81)");
    expect(spec.attention(r)).toBe(false);
  });
  it("precedence: a duplicate wins over an updated version, even a more confident one, and the updated version stays a candidate", () => {
    const r = check([[UPD(0.99)], [rel("duplicate", [0.8, 0.1, 0.1], 0.61)]]);
    expect(r).toMatchObject({ outcome: "duplicate", rule_id: "S64.134", ambiguous: false });
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["G7.4", "S64.134"]);
  });
  it("ambiguous: two confident updated versions give the best one, flagged, and need attention", () => {
    const r = check([[UPD(0.7)], [UPD(0.9)], [NEW()]]);
    expect(r).toMatchObject({ outcome: "updated_version", rule_id: "S64.134", ambiguous: true });
    expect(r.reason).toBe("updated version of S64.134 (confidence 0.90); 2 rules qualify");
    expect(spec.attention(r)).toBe(true);
  });
  it("new: every rule is a confident new", () => {
    const r = check([[NEW()], [NEW(0.6)], [NEW()]]);
    expect(r).toMatchObject({ outcome: "new", rule_id: null, ambiguous: false, conflict: false, candidates: [], confident_new_count: 3 });
    expect(r.reason).toBe("new: all 3 rules are confidently new");
    expect(spec.attention(r)).toBe(false);
  });
  it("uncertain: one new row below --min-confidence keeps the phrase from being new, never a forced label", () => {
    const r = check([[NEW()], [NEW(0.59)], [NEW()]]);
    expect(r).toMatchObject({ outcome: "uncertain", rule_id: null, confident_new_count: 2 });
    expect(r.candidates.map((c) => c.id)).toEqual(["S64.134"]);
    expect(r.reason).toBe("uncertain: no rule is a confident duplicate or updated version, and 1 of 3 rules are not confidently new");
    expect(spec.attention(r)).toBe(true);
  });
  it("a duplicate below --min-confidence is not a duplicate, and --min-confidence moves the cut", () => {
    const rows: [Answers[string]][] = [[rel("duplicate", [0.6, 0.2, 0.2], 0.5)], [NEW()]];
    expect(check(rows).outcome).toBe("uncertain");
    expect(check(rows, { ...T, "min-confidence": 0.5 }).outcome).toBe("duplicate");
  });
  it("an updated version below --min-confidence is uncertain, and the rule stays a candidate with its id, label and probabilities (the measured earlier-version case)", () => {
    // Shape measured 2026-11-18 on the phrase against r2, u1, u2: r2 labelled updated_version at confidence 0.33, the other rules confident new.
    // The 3-pillars converter shows this candidate to a person, so it must keep its id and label (TRDD-FS5WW86J).
    const r = check([[NEW()], [rel("updated_version", [0, 0.55, 0.45], 0.33)], [NEW()]]);
    expect(r).toMatchObject({ outcome: "uncertain", rule_id: null, ambiguous: false, confident_new_count: 2 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ id: "S64.134", label: "updated_version", confidence: 0.33, unanswered: false });
    expect(r.candidates[0]!.probabilities).toMatchObject({ duplicate: 0, updated_version: 0.55, new: 0.45 });
    expect(spec.attention(r)).toBe(true);
  });
  it("a relation with no confidence is never confident: a duplicate without one is uncertain and a new without one is a candidate", () => {
    const noConf = check([[rel("duplicate", [0.9, 0.05, 0.05], null)], [NEW()]]);
    expect(noConf).toMatchObject({ outcome: "uncertain", rule_id: null, confident_new_count: 1 });
    expect(noConf.candidates.map((c) => [c.id, c.confidence])).toEqual([["G7.4", null]]);
  });
});

describe("conflict", () => {
  it("a contradiction on the matched row is flagged and needs attention", () => {
    const r = check([[DUP(), con(0.7)], [NEW()]]);
    expect(r).toMatchObject({ outcome: "duplicate", rule_id: "G7.4", conflict: true });
    expect(r.reason).toBe("duplicate of G7.4 (confidence 0.88); the phrase contradicts 1 rule(s)");
    expect(spec.attention(r)).toBe(true);
  });
  it("a row labelled new that contradicts does not hide behind a clean new: outcome new, conflict true, the row is a candidate and not counted as confidently new", () => {
    const r = check([[NEW()], [NEW(), con(0.85)], [NEW()]]);
    expect(r).toMatchObject({ outcome: "new", conflict: true, confident_new_count: 2 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ id: "S64.134", label: "new", contradicts: { yes: true, probability: 0.85 } });
    expect(spec.attention(r)).toBe(true);
  });
  it("--conflict moves the cut: 0.55 contradicts at 0.5 and not at the default 0.6", () => {
    expect(check([[NEW(), con(0.55)]]).conflict).toBe(false);
    expect(check([[NEW(), con(0.55)]], { ...T, conflict: 0.5 }).conflict).toBe(true);
  });
});

describe("unanswered rules (condition A)", () => {
  it("one rule with no relation answer makes the outcome uncertain even when another rule is a confident duplicate", () => {
    const r = check([[DUP()], [bad("not_sent_budget: --max-budget was passed before this request was sent")], [NEW()]]);
    expect(r).toMatchObject({ outcome: "uncertain", rule_id: null, unanswered: ["S64.134"] });
    expect(r.reason).toBe("uncertain: 1 of 3 rules have no answer");
    expect(spec.attention(r)).toBe(true);
    expect(r.candidates.map((c) => c.id)).toEqual(["G7.4", "S64.134"]);
    expect(r.candidates.at(-1)).toMatchObject({ id: "S64.134", unanswered: true, label: null, contradicts: { yes: false, probability: 0.05 }, invalid: expect.stringMatching(/^not_sent_budget/) });
  });
  it("one rule with no contradiction answer is unanswered too, and keeps its relation", () => {
    const r = check([[DUP()], [NEW(), bad("invalid_response: 500")]]);
    expect(r).toMatchObject({ outcome: "uncertain", unanswered: ["S64.134"] });
    expect(r.candidates.at(-1)).toMatchObject({ id: "S64.134", unanswered: true, label: "new", contradicts: null, invalid: "invalid_response: 500" });
  });
  it("a contradiction that was answered counts toward conflict even when the relation of that rule was not", () => {
    expect(check([[bad("aborted: the run was aborted"), con(0.9)]]).conflict).toBe(true);
  });
  it("all rules unanswered: uncertain, nothing confidently new", () => {
    const r = check([[bad("a")], [bad("b")]]);
    expect(r).toMatchObject({ outcome: "uncertain", unanswered: ["G7.4", "S64.134"], confident_new_count: 0 });
  });
});

describe("candidates", () => {
  it("hold only the rules that are not a confident new, least new first with unanswered last, and the counts add up to the rule count", () => {
    const r = check([
      [NEW()],
      [rel("updated_version", [0.1, 0.8, 0.1], 0.7)],
      [bad("x")],
      [rel("duplicate", [0.95, 0.03, 0.02], 0.9)],
    ]);
    expect(r.candidates.map((c) => c.id)).toEqual(["r4", "S64.134", "r3"]);
    expect(r.confident_new_count).toBe(1);
    expect(r.candidates.length + r.confident_new_count).toBe(4);
  });
  it("a low-confidence new, a contradicted new and a null-confidence new are candidates; a plain confident new is not", () => {
    const r = check([[NEW()], [NEW(0.3)], [NEW(), con(0.9)], [rel("new", [0, 0, 1], null)]]);
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["S64.134", "r3", "r4"]);
    expect(r.confident_new_count).toBe(1);
  });
  it("stay stable on equal p(new)", () => {
    const same = rel("new", [0.2, 0.2, 0.6], 0.3);
    expect(check([[same], [same], [same]]).candidates.map((c) => c.id)).toEqual(["G7.4", "S64.134", "r3"]);
  });
  it("probabilities are a prototype-less map", () => {
    expect(Object.getPrototypeOf(check([[DUP()]]).candidates[0]!.probabilities)).toBeNull();
  });
});

describe("text form", () => {
  it("prints the outcome and rule, one line per answered candidate, the confident-new count and the no-answer lines", () => {
    const r = check([[DUP(), con(0.7)], [NEW()], [bad("not_sent_budget: stopped")]]);
    expect(spec.renderText!(r, {}).lines).toEqual([
      "uncertain · conflict",
      "0.88  duplicate  G7.4  contradicts",
      "1 rules are confidently new",
      "? no answer: r3 (not_sent_budget: stopped)",
    ]);
    const d = check([[DUP()], [NEW()]]);
    expect(spec.renderText!(d, {}).lines).toEqual(["duplicate G7.4", "0.88  duplicate  G7.4", "1 rules are confidently new"]);
    const a = check([[UPD(0.7)], [UPD(0.9)]]);
    expect(spec.renderText!(a, {}).lines[0]).toBe("updated_version S64.134 · ambiguous");
  });
});

describe("project refuses an answer set that lost or invented a question", () => {
  it("is an internal error, not a result that could read as new", () => {
    const i = input(2);
    const answers: Answers = { rel_i0: NEW(), con_i0: con(0.05), rel_i1: NEW() };
    expect(() => spec.project(answers, i, T, { truncated: false })).toThrow(/internal error/);
    expect(() => spec.project({ ...answers, con_i1: con(0.1), con_i9: con(0.1) }, i, T, { truncated: false })).toThrow(/internal error/);
  });
});

// Condition B: what project receives when a run stops or a request fails, through the REAL planner and fan-out. WHY maxQuestionsPerRequest 2: one rule per request, so a failed request loses exactly one rule. The testkit answers every relation "duplicate" at 0.9 and every contradiction at 0.9, so an unanswered rule beating a confident duplicate is what the assertions prove.
describe("stopped and failed runs (condition B): unsent and failed rules arrive as not-ok answers, so the outcome is uncertain, never new", () => {
  const ONE_RULE = { limits: { maxQuestionsPerRequest: 2 } };
  const raw = { phrase: "p", rules: [{ id: "r1", text: "a" }, { id: "r2", text: "b" }, { id: "r3", text: "c" }] };
  const run = async (s: Scenario): Promise<RuleCheckResult> => (await runUnder(spec, raw, s, ONE_RULE)).result as RuleCheckResult;
  it("positive control: with no request failing every rule is answered; the testkit duplicate at 0.9 wins and its contradiction 0.9 is a conflict", async () => {
    const out = await runUnder(spec, raw, "one-failed", { ...ONE_RULE, failAt: 99 });
    expect(out.requests).toBe(3);
    expect(out.result).toMatchObject({ outcome: "duplicate", rule_id: "r1", unanswered: [], conflict: true });
  });
  it("one failed request: that rule is unanswered with the runner's reason; r1 and r3 are confident duplicates yet the outcome is uncertain", async () => {
    const r = await run("one-failed");
    expect(r).toMatchObject({ outcome: "uncertain", rule_id: null, unanswered: ["r2"] });
    expect(r.candidates.find((c) => c.id === "r2")!.invalid).toMatch(/^invalid_response/);
    expect(r.candidates.filter((c) => c.label === "duplicate").map((c) => c.id)).toEqual(["r1", "r3"]);
    expect(spec.attention(r)).toBe(true);
  });
  it("budget reached: the rule never sent is unanswered with not_sent_budget", async () => {
    const r = await run("budget");
    expect(r).toMatchObject({ outcome: "uncertain", rule_id: null, unanswered: ["r3"] });
    expect(r.candidates.find((c) => c.id === "r3")!.invalid).toMatch(/^not_sent_budget/);
  });
  it("Ctrl-C while a request is in flight: that rule and every later one are unanswered as aborted", async () => {
    const r = await run("abort");
    expect(r).toMatchObject({ outcome: "uncertain", unanswered: ["r2", "r3"] });
    expect(r.candidates.filter((c) => c.unanswered).every((c) => /^aborted/.test(c.invalid!))).toBe(true);
  });
  it("a fatal stop on the first request leaves every rule unanswered", async () => {
    const r = await run("fatal-first");
    expect(r).toMatchObject({ outcome: "uncertain", rule_id: null, unanswered: ["r1", "r2", "r3"], confident_new_count: 0 });
  });
});
