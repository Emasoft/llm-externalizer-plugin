// Recursive-split-and-retry ladder for cluster_synonyms — Q7 of
// TRDD-220ea89f. Each batch at any depth gets up to
// opts.maxRetriesPerAttempt LLM attempts; on retry exhaustion the
// batch splits in half and recurses on each half independently with a
// fresh retry budget. Max recursion depth opts.maxSplitDepth — a
// 300-item batch can split 300 → 2×150 → 4×75 → 8×~38 before giving
// up. Worst-case per source batch: 3 + 6 + 12 + 24 = 45 LLM calls.
//
// Generic over input items I and LLM responses R, with caller-provided
// llmCall + validate. Pure async function: no I/O, no globals.
// Budget is a mutable counter object the caller owns so multiple
// source batches in one run share the same global `budget_max_llm_calls`.

export interface RetryLadderOptions {
  maxRetriesPerAttempt: number;
  maxSplitDepth: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryLadderOptions = {
  maxRetriesPerAttempt: 3,
  maxSplitDepth: 3,
};

export interface RetryBudget {
  /** Remaining LLM calls allowed across the whole run; decrements on every dispatch (success or fail). */
  remaining: number;
}

export type ValidateResult = { ok: true } | { ok: false; reason: string };

export type LlmCallFn<I, R> = (items: I[], depth: number, attempt: number) => Promise<R>;
/**
 * Validate the LLM response. Receives the response AND the items the
 * response was supposed to cover — important when the ladder has split
 * a batch and the validator's "expected size" must follow the current
 * sub-slice, not the original source batch.
 */
export type ValidateFn<I, R> = (response: R, items: I[]) => ValidateResult;

export interface RetryLeafSuccess<I, R> {
  items: I[];
  response: R;
  depth: number;
  attempts: number;
}

export interface RetryLeafFailure<I> {
  items: I[];
  depth: number;
  attempts: number;
  lastError: string;
}

export interface RetryResult<I, R> {
  succeeded: RetryLeafSuccess<I, R>[];
  failed: RetryLeafFailure<I>[];
  budgetExhausted: boolean;
  llmCallCount: number;
}

/**
 * Recursively retry-with-split. Returns succeeded + failed leaves,
 * never throws (LLM exceptions are caught and counted as failed
 * attempts). Budget is decremented before every LLM dispatch — if the
 * caller's budget hits zero mid-recursion, remaining items are
 * recorded as failed with reason "budget exhausted".
 */
export async function processBatchWithRetry<I, R>(
  items: I[],
  llmCall: LlmCallFn<I, R>,
  validate: ValidateFn<I, R>,
  opts: RetryLadderOptions = DEFAULT_RETRY_OPTIONS,
  budget: RetryBudget = { remaining: Number.POSITIVE_INFINITY },
): Promise<RetryResult<I, R>> {
  const succeeded: RetryLeafSuccess<I, R>[] = [];
  const failed: RetryLeafFailure<I>[] = [];
  let llmCallCount = 0;
  let budgetExhausted = false;

  async function recurse(slice: I[], depth: number): Promise<void> {
    if (slice.length === 0) return;

    let lastError = "no attempts made";
    let attempts = 0;
    for (let attempt = 1; attempt <= opts.maxRetriesPerAttempt; attempt++) {
      if (budget.remaining <= 0) {
        budgetExhausted = true;
        failed.push({
          items: slice,
          depth,
          attempts,
          lastError: "budget exhausted before attempt",
        });
        return;
      }
      attempts = attempt;
      budget.remaining -= 1;
      llmCallCount += 1;
      try {
        const response = await llmCall(slice, depth, attempt);
        const v = validate(response, slice);
        if (v.ok) {
          succeeded.push({ items: slice, response, depth, attempts });
          return;
        }
        lastError = v.reason;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // All retries at this depth exhausted.
    if (depth < opts.maxSplitDepth && slice.length >= 2) {
      const mid = Math.floor(slice.length / 2);
      await recurse(slice.slice(0, mid), depth + 1);
      await recurse(slice.slice(mid), depth + 1);
      return;
    }

    // Max depth reached or can't split (single-item batch). Give up.
    failed.push({ items: slice, depth, attempts, lastError });
  }

  await recurse(items, 0);
  return { succeeded, failed, budgetExhausted, llmCallCount };
}
