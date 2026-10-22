// E49/E87 say "the estimate" without naming output cost, and the catalog prices completion at zero (l1/usage.ts), so the estimate is input tokens times the prompt price only.
// Plan §3 L2-11, D2, E49, E86, E87: the opt-in spend cap `--max-budget=<usd>`. Classifiers are paid by design, so nothing here runs unless the caller passed the flag.
import type { ResolvedModel } from "../l0/model.js";

/** Non-zero exit of a run that --max-budget stopped (E86). 1 is llm-ext's existing "run did not fully succeed" code (cli/main.ts:18). */
export const BUDGET_EXIT_CODE = 1;

function validCap(cap: number): void {
  // WHY fail fast: a NaN or negative cap would make every comparison false and silently disable the cap; 0 is refused too because a cap that lets one batch through is not a cap (plan is silent on 0).
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`--max-budget must be a positive number of USD, got ${cap}`);
}

/** E49/E87: refuse BEFORE the first call. No-op without the flag (D2). The price is the effective model's, so an alias is priced by its target (E17). */
export function checkEstimate(opts: { maxBudgetUsd: number | undefined; estimatedInputTokens: number; model: ResolvedModel }): void {
  const cap = opts.maxBudgetUsd;
  if (cap === undefined) return;
  validCap(cap);
  const price = opts.model.effective.promptUsdPerM;
  // WHY refuse: with no price the estimate cannot be checked, and proceeding would turn the cap into a guess (E87).
  if (price === null) throw new Error(`--max-budget cannot be checked: the catalog has no prompt price for ${opts.model.effective.id}`);
  const estimate = (opts.estimatedInputTokens * price) / 1_000_000;
  if (estimate > cap) throw new Error(`estimated input cost ${estimate.toFixed(6)} USD exceeds --max-budget ${cap} USD`);
}

/** E86: running cost of one run. The fan-out asks `exceeded()` before sending each remaining request. */
export class BudgetTracker {
  private total = 0;
  constructor(private readonly cap: number | undefined) {
    if (cap !== undefined) validCap(cap);
  }
  add(costUsd: number): void {
    // WHY: one NaN would make the total NaN and exceeded() false forever, silently disabling the cap.
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error(`invalid request cost ${costUsd}`);
    this.total += costUsd;
  }
  spent(): number {
    return this.total;
  }
  /** WHY strictly greater: a cost exactly at the cap has not passed it. Requests already in flight can still overshoot; they are billed and kept. */
  exceeded(): boolean {
    return this.cap !== undefined && this.total > this.cap;
  }
  /** The envelope `stopped` value. */
  stopped(): "budget" | null {
    return this.exceeded() ? "budget" : null;
  }
}
