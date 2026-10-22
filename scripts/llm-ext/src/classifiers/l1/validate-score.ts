// Plan §6 / E25: score validation. Kept apart from validate.ts so choice and score cards land without touching one file.
import { scoreTolerance, sumTolerance } from "./validate.js";
import type { Invalid, Valid, ValidationPolicy } from "./validate.js";

export type ScoreAnswer = { type: "score"; score: number; probabilities?: number[]; confidence?: number };

const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

// Why n is a parameter: the reply does not say how many criteria were asked, and the range [0, n-1] is defined by the question.
export function validateScore(a: unknown, n: number, p: ValidationPolicy): Valid<ScoreAnswer> | Invalid {
  if (!Number.isInteger(n) || n < 1) throw new Error(`validateScore: n must be a positive integer, got ${n}`);
  if (typeof a !== "object" || a === null || Array.isArray(a)) return { ok: false, reason: "answer is not an object" };
  const r = a as Record<string, unknown>;
  if (r.type !== undefined && r.type !== "score") return { ok: false, reason: `answer type is ${String(r.type)}, expected score` };
  const s = r.score;
  // E25: a missing, non-finite or out-of-range score is invalid, never clamped.
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > n - 1) return { ok: false, reason: `score must be a number in [0,${n - 1}]` };
  if (p.score === "integer-index" && !Number.isInteger(s)) return { ok: false, reason: "score must be an integer index" };
  const answer: ScoreAnswer = { type: "score", score: s };
  if (r.probabilities === undefined || r.probabilities === null) {
    if (p.probabilities === "required") return { ok: false, reason: "probabilities are required" };
  } else {
    const probs = parseProbabilities(r.probabilities, n);
    if (typeof probs === "string") return { ok: false, reason: probs };
    const sum = probs.reduce((x, y) => x + y, 0);
    const tol = sumTolerance(p, probs.filter((x) => x > 0).length);
    if (Math.abs(sum - 1) > tol) return { ok: false, reason: `probabilities sum to ${sum}, expected 1 within ${tol}` };
    // Why only expected-value: an integer index is an argmax-style pick, not a mean of the distribution.
    if (p.score === "expected-value") {
      const ev = probs.reduce((x, y, i) => x + i * y, 0);
      if (Math.abs(s - ev) > scoreTolerance(n)) return { ok: false, reason: `score ${s} is far from the expected value ${ev}` };
    }
    answer.probabilities = probs;
  }
  if (r.confidence !== undefined && r.confidence !== null) {
    if (isProb(r.confidence)) answer.confidence = r.confidence;
    else if (p.confidence === "reject") return { ok: false, reason: "confidence must be a number in [0,1]" };
  }
  return { ok: true, answer };
}

// The wire form is an object keyed "0".."n-1"; returns the ordered list, or the reason as a string.
function parseProbabilities(v: unknown, n: number): number[] | string {
  if (typeof v !== "object" || Array.isArray(v)) return "probabilities is not an object";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== n) return `probabilities has ${keys.length} keys, expected ${n}`;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = o[String(i)];
    if (!isProb(x)) return `probabilities["${i}"] must be a number in [0,1]`;
    out.push(x);
  }
  return out;
}
