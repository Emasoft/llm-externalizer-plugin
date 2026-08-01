/**
 * Generic same-or-cheaper selection gate (TRDD-828238b5 A6, extracted from
 * security-triage/select.ts so every per-tool benchmark reuses ONE gate
 * instead of re-implementing the three-gate math).
 *
 * The gate is the user's standing rule made mechanical: a candidate may
 * become a tool's default ONLY if it clears THREE independent gates —
 *   1. REQUIREMENTS — passed the tool's own qualify() (carried in
 *      `qualified` + `disqualifyReason`).
 *   2. BENCHMARK — passed that tool's golden-dataset benchmark
 *      (`benchmarkPass` + `benchmarkScore` + `benchmarkFailReasons`).
 *   3. COST — is NOT pricier than the incumbent default on EITHER axis. We
 *      never auto-bump to a pricier model. Among eligible same-or-cheaper
 *      passers, the best benchmark score wins (ties → lower cost → lower
 *      latency, mirroring pickTopN).
 *
 * Pure module — no network, no IO, fully unit-testable. The rejection /
 * recommendation messages are PARAMETERIZED via `requirementsLabel` and
 * `benchmarkLabel` so each tool reproduces its own wording (security-triage
 * keeps "security-triage requirements" / "the triage benchmark" byte-for-byte).
 */

/** Tiny tolerance for float pricing noise when comparing $/M values. */
export const COST_EPSILON = 1e-9;

/**
 * One candidate, tool-agnostic. Every per-tool selector maps its own assessment
 * shape onto this before calling selectSameOrCheaper, and maps the result back.
 */
export interface GenericCandidate {
  modelId: string;
  /** Passed the tool's qualify() against its per-tool requirements. */
  qualified: boolean;
  /** Why it failed qualify (when qualified === false). */
  disqualifyReason?: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Mean per-call latency over the dataset run (ms). 0 when unknown. */
  latencyMs: number;
  /** Passed the tool's golden-dataset benchmark. */
  benchmarkPass: boolean;
  /** The benchmark score used to rank eligible passers (higher is better). */
  benchmarkScore: number;
  /** Why the benchmark failed (joined into the rejection reason). */
  benchmarkFailReasons: string[];
}

export interface GenericSelectionInput {
  candidates: GenericCandidate[];
  /** The current default model id for this tool. */
  incumbentModelId: string;
  incumbentInputDollarsPerMillion: number;
  incumbentOutputDollarsPerMillion: number;
  /**
   * Label for the per-tool requirements in the "does not meet …" rejection
   * (e.g. "security-triage requirements" / "search-existing requirements").
   */
  requirementsLabel: string;
  /**
   * Label for the per-tool benchmark in the recommendation reason
   * (e.g. "the triage benchmark" / "the search-existing benchmark").
   */
  benchmarkLabel: string;
}

export interface GenericRejectedCandidate {
  modelId: string;
  reason: string;
}

export interface GenericSelectionResult {
  /** The model the benchmark recommends as the tool's default. */
  recommendedModelId: string;
  /** True iff the recommendation differs from the incumbent. */
  changed: boolean;
  reason: string;
  /** Eligible passers (qualified + benchmark-pass + not-pricier), best-first. */
  eligible: GenericCandidate[];
  /** Candidates that failed one of the gates, with the reason. */
  rejected: GenericRejectedCandidate[];
}

/** Is `candidate` NOT pricier than the incumbent on either axis? */
export function notPricier(
  candidate: GenericCandidate,
  inInc: number,
  outInc: number,
): boolean {
  return (
    candidate.inputDollarsPerMillion <= inInc + COST_EPSILON &&
    candidate.outputDollarsPerMillion <= outInc + COST_EPSILON
  );
}

/**
 * Apply the three gates and pick the winner. Deterministic, pure.
 *
 * If no eligible same-or-cheaper passer exists, the incumbent is kept
 * (changed=false) — the gate NEVER recommends a pricier model and never
 * leaves the tool without a default.
 *
 * Message wording is parameterized: the security-triage selector passes
 * requirementsLabel="security-triage requirements" and benchmarkLabel="the
 * triage benchmark", reproducing its original strings exactly.
 */
export function selectSameOrCheaper(
  input: GenericSelectionInput,
): GenericSelectionResult {
  const {
    incumbentModelId,
    incumbentInputDollarsPerMillion: inInc,
    incumbentOutputDollarsPerMillion: outInc,
    requirementsLabel,
    benchmarkLabel,
  } = input;

  const eligible: GenericCandidate[] = [];
  const rejected: GenericRejectedCandidate[] = [];

  for (const c of input.candidates) {
    if (!c.qualified) {
      rejected.push({
        modelId: c.modelId,
        reason: `does not meet ${requirementsLabel}${c.disqualifyReason ? ` (${c.disqualifyReason})` : ""}`,
      });
      continue;
    }
    if (!c.benchmarkPass) {
      rejected.push({
        modelId: c.modelId,
        reason: `failed ${benchmarkLabel}: ${c.benchmarkFailReasons.join("; ")}`,
      });
      continue;
    }
    if (!notPricier(c, inInc, outInc)) {
      rejected.push({
        modelId: c.modelId,
        reason: `pricier than the incumbent default (in $${c.inputDollarsPerMillion.toFixed(3)}/out $${c.outputDollarsPerMillion.toFixed(3)} vs incumbent in $${inInc.toFixed(3)}/out $${outInc.toFixed(3)}) — never auto-bump to a pricier model`,
      });
      continue;
    }
    eligible.push(c);
  }

  eligible.sort((a, b) => {
    if (b.benchmarkScore !== a.benchmarkScore) return b.benchmarkScore - a.benchmarkScore;
    const aCost = a.inputDollarsPerMillion + a.outputDollarsPerMillion;
    const bCost = b.inputDollarsPerMillion + b.outputDollarsPerMillion;
    if (aCost !== bCost) return aCost - bCost;
    return a.latencyMs - b.latencyMs;
  });

  if (eligible.length === 0) {
    return {
      recommendedModelId: incumbentModelId,
      changed: false,
      reason: `No eligible same-or-cheaper model passed ${benchmarkLabel}. Keeping the incumbent default.`,
      eligible,
      rejected,
    };
  }

  const winner = eligible[0];
  const changed = winner.modelId !== incumbentModelId;
  return {
    recommendedModelId: winner.modelId,
    changed,
    reason: changed
      ? `${winner.modelId} passed ${benchmarkLabel} (score ${winner.benchmarkScore.toFixed(3)}) at no higher cost than the incumbent and scored best among eligible passers.`
      : `The incumbent ${winner.modelId} remains the best eligible passer (score ${winner.benchmarkScore.toFixed(3)}).`,
    eligible,
    rejected,
  };
}
