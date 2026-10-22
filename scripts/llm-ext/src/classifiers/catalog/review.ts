// SP-11 (TRDD-QFPC4Z8P), plan §9 `classify review` (+ `--claims`, which absorbs the jev-mcp gate, D27). Semantics ported from jev-mcp jev_review / jev_gate (server.ts:1462-2125, lib.ts:286-425): four rubric scores, a safe_to_apply probability, a weighted composite, an auto / review / escalate action, a fixed reason-code vocabulary; claims are judged against the supplied evidence only. Question wording is our own (D17).
import { z } from "zod";
import { choice, noul, score, type Question } from "../l1/questions.js";
import { SCORE_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import type { ScoreAnswer } from "../l1/validate-score.js";
import { buildEvidence } from "../l2/evidence.js";
import { IdError, indexKey } from "../l2/ids.js";
import { PolicyError } from "../l2/policy-kit.js";
import { assertFits, cutToTokens } from "./audit.js";
import { dataGuard, isBlank, noulOf, positionalIds, renumberByPosition } from "./shared.js";
import type { Answers, Built, BuiltUnit, DecisionSpec, ProjectCtx, Thresholds } from "./spec.js";

// How this spec differs from the reference, in one place:
// - Correctness and spec match are ASKED inverted (how WRONG, how far OFF) and safe_to_apply as `unsafe`; project restores the reference's scores (2 - answer, 1 - unsafe). WHY: the per-file chunk merge keeps the HIGHEST value of every question (plan §5), which is the worst case only when high means bad.
// - Per-file mode refuses claims (the plan §5 table gives claims to the whole-diff review only; the reference allows them with files).
// - Evidence is only used to judge claims: jev_review has no evidence field and only jev_gate reads it (server.ts:1735-1806 vs 1953), so evidence without claims is a schema error here.
// WHY caps here and not in the planner: the planner never truncates (plan §5: "audit, whole-diff review (`--claims` included) and extract truncate-and-flag in `build` (per jev-mcp), and the incomplete-context policy demotes `auto` to `review`"). The cut size is meant to come from the model limit, which `build` is not given.
// WHY tokens: the endpoint takes about 32,000 tokens and non-ASCII text costs one token per character (l1/estimate.ts); jev-mcp's 50,000-character caps (lib.ts:263-281) would refuse dense text.
// Budget arithmetic (estimated tokens, the request limit is 32,000 - 64 = 31,936). With claims: diff 12,000 + evidence 8,000 + request 1,500 + tests 2,500 + claims 3,000 = 27,000, leaving 4,936 for the 5 review questions, the 16 claim questions and the JSON wrapper. Without claims: diff 20,000 + request 1,500 + tests 2,500 = 24,000. review.test.ts proves, for four kinds of text, that every part full still fits. Exact sizing needs the model limits passed to `build`.
const DIFF_TOKENS = 20_000;
// With claims, the evidence is the only support for them, so it gets its own budget and the diff gives some up.
const DIFF_TOKENS_WITH_CLAIMS = 12_000;
const EVIDENCE_TOKENS = 8_000;
const REQUEST_TOKENS = 1_500;
const TESTS_TOKENS = 2_500;
// One budget for all claims, shared evenly and capped per claim: a claim cut to nothing would be meaningless, an even share never is.
const CLAIMS_TOKENS = 3_000;
const CLAIM_MAX_TOKENS = 500;
// jev-mcp lib.ts:259-281.
const MAX_CLAIMS = 16;
const MAX_EVIDENCE = 16;
const MAX_FILES = 16;

// E69: a binary file has no text to review. Real `git diff` prints, after the `diff --git` and `index` lines and with no `@@` hunk at all, either `Binary files a/x and b/x differ` or (with --binary) `GIT binary patch` followed by literal data (see the git 2.55.0 output pinned in review.test.ts).
const BINARY = /^(Binary files .* differ|GIT binary patch)\s*$/m;
const BINARY_LINE = /^(Binary files .* differ|GIT binary patch)\s*$/;

/**
 * Drops the binary sections of a git diff and names them (E69). A diff with no `diff --git` header is one section.
 * WHY the marker is looked for only in the header: every line of a hunk body starts with ' ', '+', '-' or '\\', so a text file whose content reads "Binary files a and b differ" must not be exempted from review by that line (review evasion).
 */
export function dropBinary(diff: string): { text: string; skipped: string[] } {
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    // WHY a section with any `@@` hunk is never binary: it has text to review, and a marker line next to it must not exempt that text. Without `diff --git` there is no header to trust, so such a text is binary only when the marker lines are ALL it holds (a change summary that mentions one is reviewed).
    const binary = part.search(/^@@/m) >= 0 ? false : part.startsWith("diff --git ") ? BINARY.test(part) : BINARY.test(part) && part.split("\n").every((l) => l.trim() === "" || BINARY_LINE.test(l));
    if (binary) skipped.push(/^diff --git a\/(.+?) b\//.exec(part)?.[1] ?? "(diff)");
    else kept.push(part);
  }
  return { text: kept.join(""), skipped };
}

const claim = z.strictObject({ id: z.string().optional(), text: z.string().trim().min(1) });
const input = z
  .strictObject({
    mode: z.enum(["whole", "per-file"]).default("whole"),
    // whole: the diff and evidence texts; per-file: one diff per file. Both: the request and reported test output.
    diff: z.string().optional(),
    evidence: z.array(z.string().refine((s) => !isBlank(s), "evidence text must not be blank")).max(MAX_EVIDENCE).optional(),
    files: z.array(z.strictObject({ id: z.string().optional(), text: z.string() })).min(1).max(MAX_FILES).optional(),
    tests: z.string().optional(),
    // WHY required: it is what correctness and spec match are judged against (server.ts:1738).
    request: z.string().refine((s) => !isBlank(s), "request must not be blank"),
    // `--claims`: the jev-mcp gate's claim checks. An empty list is allowed: the review half runs alone (E70).
    claims: z.array(claim).max(MAX_CLAIMS).default([]),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: "custom", message });
    const ids = (items: readonly { id?: string }[], idMode: "json" | "files"): void => {
      try {
        positionalIds(items, idMode);
      } catch (e) {
        if (!(e instanceof IdError)) throw e;
        issue(e.message);
      }
    };
    ids(v.claims, "json");
    if (v.mode === "whole") {
      if (v.files !== undefined) issue("files belong to mode per-file");
      // E68: an empty diff (or one that holds only binary hunks) has nothing to review.
      if (v.diff === undefined || isBlank(dropBinary(v.diff).text)) issue("the diff is empty or holds only binary hunks: nothing to review");
      // WHY (server.ts:1953): a claim is judged from the evidence alone, so claims with no evidence could only come back unsupported.
      if (v.claims.length > 0 && !(v.evidence ?? []).some((e) => !isBlank(e))) issue("claims need at least one evidence text: they are judged from the evidence only");
      // WHY (server.ts:1735-1806): the review questions never read the evidence, so it would only eat the diff's budget and set truncated for nothing.
      if (v.claims.length === 0 && v.evidence !== undefined) issue("evidence is only used to judge claims: pass claims, or drop the evidence");
      return;
    }
    if (v.diff !== undefined || v.evidence !== undefined) issue("diff and evidence belong to mode whole");
    // WHY refuse (kept from the first version): the plan's §5 table gives claims only to the whole-diff review; the reference allows claims with files, which would mix claim units into the chunked file job.
    if (v.claims.length > 0) issue("claims are checked in mode whole");
    if (v.files === undefined) return issue("mode per-file needs files");
    ids(v.files, "files");
    v.files.forEach((f, k) => {
      if (isBlank(f.text)) issue(`file ${f.id ?? k} has an empty diff`);
    });
    if (v.files.every((f) => isBlank(dropBinary(f.text).text))) issue("every file is a binary diff: nothing to review");
  });
export type ReviewInput = z.output<typeof input>;

// The files that are actually reviewed, in input order, under their caller ids; build and project must agree on this list because question keys are positions in it.
function reviewable(i: ReviewInput): { id: string; text: string }[] {
  const files = i.files ?? [];
  const ids = positionalIds(files, "files");
  // WHY the text left after dropping binary sections, as whole mode does: a file with a text section and a binary section is reviewed on its text; it is skipped only when nothing textual is left.
  return files.flatMap((f, k) => {
    const text = dropBinary(f.text).text;
    return isBlank(text) ? [] : [{ id: ids[k]!, text }];
  });
}

/** E69: the binary sections that were skipped, for the caller's warning. */
export function skippedBinary(i: ReviewInput): string[] {
  if (i.mode === "whole") return dropBinary(i.diff ?? "").skipped;
  const files = i.files ?? [];
  const ids = positionalIds(files, "files");
  // A headerless binary file has no path inside it, so it is named by its id.
  return files.flatMap((f, k) => dropBinary(f.text).skipped.map((s) => (s === "(diff)" ? ids[k]! : s)));
}

type Action = "auto" | "review" | "escalate";
type Verdict = "verified" | "contradicted" | "unsupported";
const RUBRICS = ["correctness", "spec_match", "test_gap", "blast_radius"] as const;
type Rubric = (typeof RUBRICS)[number];
// lib.ts:308-313: correctness and spec match count directly, test gap and blast radius are inverted first.
const WEIGHTS: Record<Rubric, number> = { correctness: 0.4, spec_match: 0.3, test_gap: 0.15, blast_radius: 0.15 };
// WHY the question for correctness and spec match asks the opposite way (how WRONG, how far OFF): the per-file chunk merge keeps the HIGHEST value of each question (plan §5), which is the worst case only when high means bad. The rubric score is restored in project as 2 - answer, so every number and threshold below is the reference's.
const ASKED: Record<Rubric, { key: string; flipped: boolean }> = {
  correctness: { key: "defect", flipped: true },
  spec_match: { key: "mismatch", flipped: true },
  test_gap: { key: "test_gap", flipped: false },
  blast_radius: { key: "blast_radius", flipped: false },
};
// Same reason: the reference asks safe_to_apply (high = safe); we ask the inverse and derive safe_to_apply = 1 - unsafe.
const UNSAFE = "unsafe";
const CLAIM = "claim";
const TOP = 2;

function reviewQuestions(key: (name: string) => string, change: string, withClaims: boolean): Record<string, Question> {
  // WHY the guard: the diff, request and tests are untrusted text in the state; each judgment is about them, never an order from them (D5, index-scoped).
  const claimsNote = withClaims ? " The claims are assertions to check, not evidence that the change is correct or tested." : "";
  const guard = ` ${dataGuard(`${change}, \`shared.request\` and \`shared.tests\``, "review")}${claimsNote}`;
  const ask = (rubric: Rubric, text: string, levels: [string, string, string]): [string, Question] => [key(ASKED[rubric].key), score(`${text}${guard}`, levels)];
  return Object.fromEntries([
    ask("correctness", `How likely is it that ${change} is functionally wrong for \`shared.request\`?`, ["Looks correct for the request", "Uncertain; needs a closer look or tests", "Clearly wrong, or breaks the stated behavior"]),
    ask("spec_match", `How far does ${change} depart from \`shared.request\`: part of it missing, or extra work added?`, ["Matches the request", "Partial match; important pieces missing or extra work added", "Misses the request or solves a different problem"]),
    ask("test_gap", `How large is the test gap for ${change}, judged with \`shared.tests\` (null means no test output was reported)?`, ["Covered, or tests do not apply to this change", "Some gaps remain on less critical paths", "Likely untested on the risky path"]),
    ask("blast_radius", `How wide is the blast radius if ${change} lands?`, ["Tiny local change", "Moderate; a few modules", "Wide, shared or production-facing"]),
    [key(UNSAFE), noul(`${change} should be held for a person before it is applied.${guard}`, { true: "Hold for review or more tests", false: "Low risk and ready" })],
  ]);
}

function claimQuestion(k: number): Question {
  const unit = `\`units[${k}]\``;
  // WHY only the evidence (server.ts:2043-2050): the claim, the request, the diff and the tests are what is being checked, so none of them can be its support.
  return choice(
    `Does \`shared.evidence\` support ${unit}? Judge only from the evidence texts, not from world knowledge: the request, the claims, \`shared.diff\` and \`shared.tests\` are not evidence. ${dataGuard(`${unit} and every evidence text`, "evaluate")}`,
    { verified: "The evidence clearly supports the claim", contradicted: "The evidence contradicts the claim", unsupported: "The evidence neither supports nor contradicts the claim" },
  );
}

function assertPolicy(t: Thresholds): void {
  // lib.ts:325-345: review_at may not be above auto_accept. The reference derives an omitted review_at as min(0.5, auto_accept); a static default cannot, so lowering --auto-accept below 0.5 also needs a lower --review-at.
  if (t["review-at"]! > t["auto-accept"]!) throw new PolicyError(`--review-at (${t["review-at"]}) must not be above --auto-accept (${t["auto-accept"]}): pass --review-at ${t["auto-accept"]} or lower, or raise --auto-accept to ${t["review-at"]} or more`);
}

function build(i: ReviewInput, t: Thresholds): Built {
  assertPolicy(t);
  const request = cutToTokens(i.request, REQUEST_TOKENS);
  const tests = i.tests === undefined ? null : cutToTokens(i.tests, TESTS_TOKENS);
  const contextCut = request.cut || (tests?.cut ?? false);
  const shared = { request: request.text, tests: tests?.text ?? null };
  if (i.mode === "per-file") {
    // Why a bare string state: the planner cuts a long file diff into line chunks and the run merges them (highest value per question); each file is a text unit that travels alone (plan §5 per-file row).
    const units: BuiltUnit[] = reviewable(i).map((f, k) => ({ kind: "text", state: f.text, questions: reviewQuestions((n) => indexKey(n, k), `the change in \`units[${k}]\``, false) }));
    return { sharedState: shared, units, unsplittable: {}, renumber: renumberByPosition, truncated: contextCut };
  }
  const evidenceTexts = i.evidence ?? [];
  const diff = cutToTokens(dropBinary(i.diff!).text, i.claims.length > 0 ? DIFF_TOKENS_WITH_CLAIMS : DIFF_TOKENS);
  // WHY one budget in order: what the first evidence text leaves goes to the next; a text with nothing left is kept empty and flagged so labels stay stable.
  let left = EVIDENCE_TOKENS;
  const sources = evidenceTexts.map((text, j) => {
    const c = cutToTokens(text, left);
    left = Math.max(0, left - c.tokens);
    return { label: `evidence_${j}`, text: c.text, partial: c.cut };
  });
  const evidence = sources.length > 0 ? buildEvidence(sources) : null;
  const ids = positionalIds(i.claims, "json");
  let claimCut = false;
  const units: BuiltUnit[] = i.claims.map((c, k) => {
    const cut = cutToTokens(c.text, Math.min(CLAIM_MAX_TOKENS, Math.floor(CLAIMS_TOKENS / i.claims.length)));
    claimCut ||= cut.cut;
    return { kind: "atomic", state: { id: ids[k], text: cut.text }, questions: { [indexKey(CLAIM, k)]: claimQuestion(k) } };
  });
  // WHY the review half is unsplittable (plan §5): its five judgments are about the whole diff, so over the limit it is refused, never cut.
  const built: Built = {
    sharedState: { ...shared, diff: diff.text, evidence: (evidence?.sharedState as { sources: unknown[] } | undefined)?.sources ?? [] },
    units,
    unsplittable: reviewQuestions((n) => n, "the change in `shared.diff`", i.claims.length > 0),
    renumber: renumberByPosition,
    // jev-mcp server.ts:1964: a cut diff, request, tests, claim or evidence text makes the whole gate incomplete context.
    truncated: contextCut || diff.cut || claimCut || (evidence?.ctx.truncated ?? false),
  };
  // WHY here: the review half and every claim travel in the same single request (plan §5 row: review half unsplittable), so too many claims cannot be split; say what to change.
  assertFits(built, "run fewer claims per run, or review a smaller diff");
  return built;
}

export interface ScoreOut { score: number | null; confidence: number | null }
export interface HalfRow {
  status: "ok" | "invalid_response";
  action: Action;
  composite: number | null;
  safe_to_apply: number | null;
  scores: Record<Rubric, ScoreOut>;
  reason_codes: string[];
  limiting_rubrics: string[];
  unanswered: { question: string; reason: string }[];
  // The runner reports chunk data only for chunked files: the questions of one file were decided by different chunks, so the scores may describe different parts of it.
  mixed_chunks: boolean;
  // The file was cut into chunks: a chunk is a fragment of the file, not the file.
  chunked: boolean;
}
export interface ReviewHalf extends Omit<HalfRow, "scores" | "limiting_rubrics"> {
  // Whole mode: the rubric scores; per-file: null (the files carry them).
  scores: Record<Rubric, ScoreOut> | null;
  limiting: { file: string | null; rubrics: string[] }[];
}
export interface ClaimRow {
  id: string;
  status: "ok" | "invalid_response";
  verdict: Verdict | null;
  confidence: number | null;
  action: Action;
  unanswered: string | null;
}
export interface Verification {
  action: Action;
  summary: { verified: number; contradicted: number; unsupported: number; needs_review: number; invalid_response: number };
  results: ClaimRow[];
}
export interface ReviewResult {
  mode: "whole" | "per-file";
  // WHY a constant: the scores are uncalibrated (plan §9: "routes to review, never authorises"), so no result of this decision may authorise applying a change; `auto` only means "this check raised nothing".
  authorises: false;
  action: Action;
  reason_codes: string[];
  truncated: boolean;
  skipped_binary: string[];
  thresholds: { auto_accept: number; review_at: number; composite_floor: number };
  weights: Record<Rubric, number>;
  review: ReviewHalf;
  files: (HalfRow & { id: string })[];
  verification: Verification | null;
}

const missing = (a: Answers[string] | undefined): string => (a === undefined ? "missing: no answer was returned" : a.ok ? "answer has the wrong type" : a.reason);
const worst = (actions: Action[]): Action => (actions.includes("escalate") ? "escalate" : actions.includes("review") ? "review" : "auto");
// lib.ts:351: truncated input is incomplete context and never permits auto.
const requireComplete = (action: Action, truncated: boolean): Action => (truncated && action === "auto" ? "review" : action);

interface Policy { autoAccept: number; reviewAt: number; compositeFloor: number }

function halfOf(get: (name: string) => Answers[string] | undefined, p: Policy, truncated: boolean, chunkInfo = { mixed: false, chunked: false }): HalfRow {
  const scores = {} as Record<Rubric, ScoreOut>;
  const unanswered: HalfRow["unanswered"] = [];
  for (const r of RUBRICS) {
    const { key, flipped } = ASKED[r];
    const a = get(key);
    if (!a?.ok) {
      scores[r] = { score: null, confidence: null };
      unanswered.push({ question: key, reason: missing(a) });
      continue;
    }
    const s = a.answer as ScoreAnswer;
    scores[r] = { score: flipped ? TOP - s.score : s.score, confidence: s.confidence ?? null };
  }
  const unsafe = noulOf(get(UNSAFE));
  if (unsafe === null) unanswered.push({ question: UNSAFE, reason: missing(get(UNSAFE)) });
  // WHY rounded: 1 - 0.2 is 0.7999999999999999 in floats, which would miss a threshold of 0.8 that the model's 0.2 plainly meets.
  const safe = unsafe === null ? null : Math.round((1 - unsafe) * 1e9) / 1e9;
  const base = { safe_to_apply: safe, scores, unanswered, mixed_chunks: chunkInfo.mixed, chunked: chunkInfo.chunked };
  // jev-mcp server.ts:1620: an unreadable answer escalates and blocks every other reading.
  if (unanswered.length > 0) return { ...base, status: "invalid_response", action: "escalate", composite: null, reason_codes: ["invalid_response"], limiting_rubrics: [] };
  const v = (r: Rubric): number => scores[r].score!;
  const favorability: Record<Rubric, number> = { correctness: v("correctness") / TOP, spec_match: v("spec_match") / TOP, test_gap: 1 - v("test_gap") / TOP, blast_radius: 1 - v("blast_radius") / TOP };
  // WHY rounded like safe_to_apply: 0.4 + 0.3 + 0.075 is 0.7749999999999999 in floats, which would miss a floor of 0.775 that the weighted sum plainly meets.
  const composite = Math.round(RUBRICS.reduce((n, r) => n + WEIGHTS[r] * Math.min(1, Math.max(0, favorability[r])), 0) * 1e9) / 1e9;
  const confidences = RUBRICS.map((r) => scores[r].confidence);
  // WHY null, not 0: an unknown confidence must not become a number that could satisfy a threshold (lib.ts:379).
  const minConfidence = confidences.some((c) => c === null) ? null : Math.min(...(confidences as number[]));
  const safeToApply = safe!;
  // lib.ts:382-401.
  let raw: Action;
  if (minConfidence === null || minConfidence < p.reviewAt || safeToApply < p.reviewAt) raw = "escalate";
  else if (safeToApply >= p.autoAccept && composite >= p.compositeFloor && minConfidence >= p.autoAccept) raw = "auto";
  else raw = "review";
  // WHY a chunked file counts as incomplete context (plan §5 merges chunk answers by highest value; server.ts:1822-1830 demotes an oversized file alone): no single request saw the whole file, and only that file is demoted.
  const incomplete = truncated || chunkInfo.chunked;
  const action = requireComplete(raw, incomplete);
  // Reason codes cover every action path; limiting names the rubric(s) that bound the decision, ties included (server.ts:1693-1727).
  const reasons: string[] = [];
  let limiting: Rubric[] = [];
  if (minConfidence === null) {
    reasons.push("unknown_confidence");
    limiting = RUBRICS.filter((r) => scores[r].confidence === null);
  } else if (minConfidence < p.reviewAt) {
    reasons.push("confidence_below_review");
    limiting = RUBRICS.filter((r) => scores[r].confidence === minConfidence);
  }
  if (safeToApply < p.reviewAt) reasons.push("safe_to_apply_below_review");
  if (raw !== "escalate") {
    if (safeToApply < p.autoAccept) reasons.push("safe_to_apply_below_auto_accept");
    if (minConfidence !== null && minConfidence < p.autoAccept) {
      reasons.push("confidence_below_auto_accept");
      if (limiting.length === 0) limiting = RUBRICS.filter((r) => scores[r].confidence === minConfidence);
    }
    if (composite < p.compositeFloor) {
      reasons.push("composite_below_floor");
      const lowest = Math.min(...RUBRICS.map((r) => favorability[r]));
      if (limiting.length === 0) limiting = RUBRICS.filter((r) => Math.abs(favorability[r] - lowest) <= 1e-12);
    }
  }
  if (incomplete) reasons.push("incomplete_context");
  if (action === "auto") reasons.push("accepted");
  return { ...base, status: "ok", action, composite, reason_codes: reasons, limiting_rubrics: limiting };
}

// server.ts:1527-1561: worst action, composite = mean over files, safe_to_apply = minimum, reason codes merged in first-seen order, every file whose rubrics bound the decision named.
function composeFiles(files: (HalfRow & { id: string })[]): ReviewHalf {
  const action = worst(files.map((f) => f.action));
  const reasons: string[] = [];
  for (const f of files) for (const c of f.reason_codes) if (!reasons.includes(c) && c !== "accepted") reasons.push(c);
  if (action === "auto") reasons.push("accepted");
  return {
    status: files.some((f) => f.status === "invalid_response") ? "invalid_response" : "ok",
    action,
    composite: files.every((f) => f.composite !== null) ? files.reduce((n, f) => n + f.composite!, 0) / files.length : null,
    safe_to_apply: files.every((f) => f.safe_to_apply !== null) ? Math.min(...files.map((f) => f.safe_to_apply!)) : null,
    reason_codes: reasons,
    limiting: files.filter((f) => f.limiting_rubrics.length > 0).map((f) => ({ file: f.id, rubrics: f.limiting_rubrics })),
    scores: null,
    unanswered: files.flatMap((f) => f.unanswered),
    mixed_chunks: files.some((f) => f.mixed_chunks),
    chunked: files.some((f) => f.chunked),
  };
}

// lib.ts:407-415: unknown or low confidence and a confident contradiction escalate; only a confident verification is auto.
function claimAction(verdict: Verdict, confidence: number | null, p: Policy): Action {
  if (confidence === null || confidence < p.reviewAt) return "escalate";
  if (verdict === "contradicted" && confidence >= p.autoAccept) return "escalate";
  return verdict === "verified" && confidence >= p.autoAccept ? "auto" : "review";
}

function claimRow(id: string, a: Answers[string] | undefined, p: Policy, truncated: boolean): ClaimRow {
  if (!a?.ok) return { id, status: "invalid_response", verdict: null, confidence: null, action: "escalate", unanswered: missing(a) };
  const c = a.answer as ChoiceAnswer;
  const confidence = c.confidence ?? null;
  return { id, status: "ok", verdict: c.choice as Verdict, confidence, action: requireComplete(claimAction(c.choice as Verdict, confidence, p), truncated), unanswered: null };
}

function project(answers: Answers, i: ReviewInput, t: Thresholds, ctx: ProjectCtx): ReviewResult {
  assertPolicy(t);
  const p: Policy = { autoAccept: t["auto-accept"]!, reviewAt: t["review-at"]!, compositeFloor: t["composite-floor"]! };
  let files: (HalfRow & { id: string })[] = [];
  let review: ReviewHalf;
  if (i.mode === "per-file") {
    files = reviewable(i).map((f, k) => {
      const metas = [...RUBRICS.map((r) => ASKED[r].key), UNSAFE].map((n) => ctx.chunks?.[indexKey(n, k)]).filter((m) => m !== undefined);
      // WHY: the fan-out merges chunks per question, so different questions of one file can be decided by different chunks (same flag as test-output.ts).
      const chunkInfo = { mixed: new Set(metas.map((m) => m.best_chunk)).size > 1, chunked: metas.some((m) => m.chunks > 1) };
      return { id: f.id, ...halfOf((n) => answers[indexKey(n, k)], p, ctx.truncated, chunkInfo) };
    });
    review = composeFiles(files);
  } else {
    const h = halfOf((n) => answers[n], p, ctx.truncated);
    const { scores, limiting_rubrics, ...rest } = h;
    review = { ...rest, scores, limiting: limiting_rubrics.length > 0 ? [{ file: null, rubrics: limiting_rubrics }] : [] };
  }
  const claimIds = positionalIds(i.claims, "json");
  const base = { mode: i.mode, authorises: false as const, truncated: ctx.truncated, skipped_binary: skippedBinary(i), thresholds: { auto_accept: p.autoAccept, review_at: p.reviewAt, composite_floor: p.compositeFloor }, weights: { ...WEIGHTS }, review, files };
  // E70: no claims, no gate half: the result is the review half alone (server.ts jev_review).
  if (claimIds.length === 0) return { ...base, action: review.action, reason_codes: review.reason_codes, verification: null };
  const results = claimIds.map((id, k) => claimRow(id, answers[indexKey(CLAIM, k)], p, ctx.truncated));
  const count = (f: (r: ClaimRow) => boolean): number => results.filter(f).length;
  const verification: Verification = {
    action: worst(results.map((r) => r.action)),
    summary: {
      verified: count((r) => r.verdict === "verified"),
      contradicted: count((r) => r.verdict === "contradicted"),
      unsupported: count((r) => r.verdict === "unsupported"),
      needs_review: count((r) => r.action !== "auto"),
      invalid_response: count((r) => r.status === "invalid_response"),
    },
    results,
  };
  const action = worst([review.action, verification.action]);
  // server.ts:2078-2112: the gate's reason codes, in the reference's order.
  const reasons: string[] = [];
  if (ctx.truncated) reasons.push("incomplete_context");
  if (review.status === "invalid_response" || verification.summary.invalid_response > 0) reasons.push("invalid_response");
  for (const c of review.reason_codes) if (c !== "invalid_response" && c !== "incomplete_context" && c !== "accepted") reasons.push(c);
  if (review.action === "escalate") reasons.push("review_escalated");
  if (review.action === "review") reasons.push("review_required");
  if (verification.summary.contradicted > 0) reasons.push("claims_contradicted");
  if (verification.summary.unsupported > 0) reasons.push("claims_unsupported");
  // An unknown confidence counts as -1, so it is claim_confidence_low: the reference has no separate code for it (server.ts:2103-2105).
  const confidences = results.filter((r) => r.status !== "invalid_response").map((r) => r.confidence ?? -1);
  if (confidences.some((c) => c < p.reviewAt)) reasons.push("claim_confidence_low");
  if (confidences.some((c) => c >= p.reviewAt && c < p.autoAccept)) reasons.push("claim_confidence_below_auto_accept");
  if (action === "auto") reasons.push("accepted");
  return { ...base, action, reason_codes: reasons, verification };
}

export const spec: DecisionSpec<ReviewInput, ReviewResult> = {
  id: "review",
  input,
  thresholds: {
    "auto-accept": { default: 0.8, min: 0, max: 1, help: "--auto-accept: safe_to_apply, minimum score confidence and every claim's confidence at or above this may stand as auto" },
    "review-at": { default: 0.5, min: 0, max: 1, help: "--review-at: minimum score confidence, safe_to_apply or claim confidence below this escalates (must not be above --auto-accept)" },
    "composite-floor": { default: 0.7, min: 0, max: 1, help: "--composite-floor: the weighted composite must be at or above this for auto" },
  },
  // WHY per-item: per-file units are independent; the whole-diff review is one request, so a failure there loses only that request either way.
  split: "per-item",
  injection: "index-scoped",
  // WHY SCORE_POLICY: the rubrics are score questions whose probability list jev-mcp treats as optional (server.ts:1555); it also makes the claim choice's list optional, where the reference requires it (plan §6 wants "required for choice"): ValidationPolicy is per spec, not per question type (OPEN QUESTION).
  validation: SCORE_POLICY,
  build,
  project,
  // Plan §9: attention is any action other than auto.
  attention: (r) => r.action !== "auto",
};
