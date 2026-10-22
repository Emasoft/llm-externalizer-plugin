/** Plan §6: the single owner of answer-validation tolerances and policy presets. */

export interface ValidationPolicy {
  sum: "fixed" | "scaled";
  tie: number;
  score: "expected-value" | "integer-index";
  confidence: "reject" | "coerce-null";
  probabilities: "required" | "optional";
  legend: "ignore" | "require";
}

// Declared here because the question types live in l1/questions.ts (card L1-01, another worker); the orchestrator reconciles.
export type NoulQuestion = { type: "noul" };
export type NoulAnswer = { type: "noul"; noul: number; confidence?: number };
export type Valid<A> = { ok: true; answer: A };
export type Invalid = { ok: false; reason: string };

// Defaults are the §6 table. Tolerances are P-04 numbers (D6): scaled sum, tie 0.001, answers have 2 decimals.
export const DEFAULT_POLICY: ValidationPolicy = {
  sum: "scaled",
  tie: 0.001,
  score: "expected-value",
  confidence: "coerce-null",
  probabilities: "required",
  legend: "ignore",
};
// jev-mcp verify relation: a present but malformed confidence must fail the answer, not be hidden.
export const VERIFY_POLICY: ValidationPolicy = { ...DEFAULT_POLICY, confidence: "reject" };
// Score answers may omit the probability list; the score itself is checked against it when present.
export const SCORE_POLICY: ValidationPolicy = { ...DEFAULT_POLICY, probabilities: "optional" };

/** Allowed |sum-1| for N non-zero options: rounding to 2 decimals drifts up to 0.005 per term, capped at 0.05. */
export const sumTolerance = (p: ValidationPolicy, nonZero: number): number =>
  p.sum === "fixed" ? 0.01 + 1e-9 : Math.min(0.05, Math.max(0.01, 0.005 * nonZero)) + 1e-9;

/** Allowed |score - sum(i*p_i)| for N options: a fixed 0.02 rejects the real score10 replies (diff 0.10). */
export const scoreTolerance = (n: number): number => 0.02 + (0.005 * n * (n - 1)) / 2;

const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function validateNoul(a: unknown, p: ValidationPolicy): Valid<NoulAnswer> | Invalid {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return { ok: false, reason: "answer is not an object" };
  const r = a as Record<string, unknown>;
  if (r.type !== undefined && r.type !== "noul") return { ok: false, reason: `answer type is ${String(r.type)}, expected noul` };
  // E26: null/missing noul must not read as "no" (0) downstream, so it is invalid, never coerced.
  if (!isProb(r.noul)) return { ok: false, reason: "noul must be a number in [0,1]" };
  const answer: NoulAnswer = { type: "noul", noul: r.noul };
  if (r.confidence !== undefined && r.confidence !== null) {
    if (isProb(r.confidence)) answer.confidence = r.confidence;
    else if (p.confidence === "reject") return { ok: false, reason: "confidence must be a number in [0,1]" };
  }
  return { ok: true, answer };
}
