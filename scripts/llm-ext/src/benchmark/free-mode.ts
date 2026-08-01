/**
 * Free-mode (free_only) vocabulary shared by the benchmark orchestrators.
 *
 * Two things live here, and NEITHER weakens the send-time cost-safety chokepoint
 * `assertFreeOnlyModel` (config.ts) — they are its PRE-conditions:
 *
 *  1. `isFreeSuffixModelId` — the ONE predicate for "can this id be sent under
 *     free_only". It is deliberately IDENTICAL to the chokepoint's own test
 *     (`endsWith(":free")`), so a pool/roster filtered through it matches exactly
 *     what the guard will admit. Anything else is a model that CANNOT be sent.
 *
 *  2. `FreeModeSkipError` — the typed, EXPECTED "this tool's benchmark cannot run
 *     under free mode" outcome. It exists so `--update-all --free` can report an
 *     honest skip instead of surfacing the chokepoint's hard-bug wording ("this is
 *     a bug, please report it"). That wording must stay reserved for a GENUINE
 *     internal leak — a paid id reaching the sender when the orchestrator should
 *     already have filtered it out. A benchmark whose only model is paid is not a
 *     bug; it is a fact about the tool, and it deserves a sentence that says so.
 */

/** True iff `id` is an id the free_only chokepoint will admit (`…:free`). */
export function isFreeSuffixModelId(id: string): boolean {
  return id.endsWith(":free");
}

/**
 * Thrown by a per-tool benchmark that has NO ':free' model to assess under a
 * free_only profile (e.g. every model in its run set — including its paid
 * incumbent — is a priced model). Carries the offending non-free id so the caller
 * can name it. Callers MUST treat this as an expected skip, never as a bug.
 */
export class FreeModeSkipError extends Error {
  readonly tool: string;
  readonly nonFreeModelId: string;

  constructor(tool: string, nonFreeModelId: string, message: string) {
    super(message);
    this.name = "FreeModeSkipError";
    this.tool = tool;
    this.nonFreeModelId = nonFreeModelId;
  }
}
