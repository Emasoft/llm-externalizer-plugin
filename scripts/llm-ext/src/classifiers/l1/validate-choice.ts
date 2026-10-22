// Plan §6 choice rules (card L1-04): sum, tie, probabilities, unknown keys, NaN/range. Policy and tolerances stay owned by validate.ts.
import { sumTolerance, type Invalid, type ValidationPolicy, type Valid } from "./validate.js";

export type ChoiceAnswer = { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number; tie: boolean };

const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const fail = (reason: string): Invalid => ({ ok: false, reason });

/** `keys` are the question's criteria keys: the only labels an answer may name (E24). */
export function validateChoice(a: unknown, keys: readonly string[], p: ValidationPolicy): Valid<ChoiceAnswer> | Invalid {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return fail("answer is not an object");
  const r = a as Record<string, unknown>;
  if (r.type !== undefined && r.type !== "choice") return fail(`answer type is ${String(r.type)}, expected choice`);
  if (typeof r.choice !== "string" || !keys.includes(r.choice)) return fail(`choice ${JSON.stringify(r.choice)} is not a key of the question`);
  const answer: ChoiceAnswer = { type: "choice", choice: r.choice, tie: false };

  const raw = r.probabilities;
  if (raw === undefined || raw === null) {
    // Why fail closed: without probabilities the sum and tie checks cannot run, so a required policy must not accept the answer.
    if (p.probabilities === "required") return fail("probabilities are required for a choice");
  } else {
    if (typeof raw !== "object" || Array.isArray(raw)) return fail("probabilities is not an object");
    const probs: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!keys.includes(k)) return fail(`probabilities names unknown key ${JSON.stringify(k)}`);
      // Why: NaN/Infinity cannot arrive via JSON but can via a caller; a non-finite or out-of-range value must never be summed.
      if (!isProb(v)) return fail(`probability of ${JSON.stringify(k)} must be a number in [0,1]`);
      probs[k] = v;
    }
    // Why every option: a distribution over a subset of the options can sum to 1 and pass; the API always returns one entry per option, zeros included.
    const missing = keys.find((k) => !Object.hasOwn(probs, k));
    if (missing !== undefined) return fail(`probabilities has no entry for ${JSON.stringify(missing)}`);
    const values = Object.values(probs);
    const sum = values.reduce((s, v) => s + v, 0);
    // Why non-zero only: rounding to 2 decimals drifts only terms that survive rounding (P-04, D6).
    const tol = sumTolerance(p, values.filter((v) => v > 0).length);
    if (Math.abs(sum - 1) > tol) return fail(`probabilities sum to ${sum}, allowed |sum-1| is ${tol}`);
    const [top, second] = values.sort((x, y) => y - x);
    // Why a flag and not a rejection: a tie is a valid answer the caller must route to review (E22).
    answer.tie = second !== undefined && top - second <= p.tie;
    answer.probabilities = probs;
  }

  if (r.confidence !== undefined && r.confidence !== null) {
    if (isProb(r.confidence)) answer.confidence = r.confidence;
    else if (p.confidence === "reject") return fail("confidence must be a number in [0,1]");
  }
  return { ok: true, answer };
}
