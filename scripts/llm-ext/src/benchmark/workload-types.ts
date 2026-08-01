/**
 * What ONE benchmark will actually ask an LLM to do, per model (P4 pre-flight estimate).
 *
 * This is the input to the pre-flight cost estimate `--update-all` prints (and aborts
 * on) BEFORE any paid call. Every field MUST be DERIVED from the benchmark's real
 * dataset/corpus on disk — never a hardcoded count. A corpus edit therefore moves the
 * estimate automatically, and a stale literal can never quietly under-price a sweep.
 *
 * Each benchmark implements `describeWorkload()` in its OWN index.ts, next to the code
 * that builds its prompts, so the estimate cannot drift from the call pattern it
 * describes. It makes NO network call and costs nothing to compute.
 *
 * IMPORTANT — what this is NOT: this is an ESTIMATE, and the run's real guarantee does
 * not depend on it being right. The HARD cap is enforced per-call at the HTTP
 * chokepoint (budget.ts), which reads the ACTUAL outbound request body. If a workload
 * here ever under-states reality, the chokepoint still refuses the call that would
 * cross the cap. The estimate's job is to fail the run EARLY and to make `--dry-run`
 * honest — not to be the safety mechanism.
 */
export interface BenchmarkWorkload {
  /** The MCP tool this benchmark selects a model for (registry key). */
  tool: string;
  /** The benchmark id from the model-qualification registry. */
  benchmark: string;
  /** LLM calls this benchmark makes for ONE model. Derived from the real dataset. */
  callsPerModel: number;
  /**
   * Total characters of prompt this benchmark sends for ONE model, summed across all
   * of its calls. Derived from the real corpus bytes + the real instruction strings.
   */
  promptCharsPerModel: number;
  /**
   * The `max_tokens` this benchmark actually puts on the wire, per call — a real
   * contractual output bound, so the estimate's output half is exact rather than
   * assumed. (The keyword/ensemble sweep declares none; see budget.ts's
   * ASSUMED_MAX_OUTPUT_TOKENS for the one place an assumption is unavoidable.)
   */
  maxOutputTokensPerCall: number;
}
