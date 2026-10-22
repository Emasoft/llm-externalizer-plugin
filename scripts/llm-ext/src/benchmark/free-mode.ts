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

/** How sure an error is to be a PAYMENT failure (no credit, payment required). */
export type PaymentErrorCertainty = "certain" | "uncertain";

// The status our own send paths write, read only right after "api error " /
// "http " (classifyUnavailable's STATUS_CODE_RE rule): a bare number is never
// a status, so a token count ("1402 tokens") or a request id cannot read as one.
const ERROR_STATUS_RE = /\b(?:api error|http)\s+(\d{3})\b/;

/**
 * THE payment predicate (D1, USER 2026-09-18: "it should retry once, but if
 * the payment required or credits exhausted error is certain, it should of
 * course skip to the next provider"). One definition, so the completion
 * layer's retry/breaker gate, the free-pool rotation and the benchmark
 * verdict recorder can never disagree on what "certain" means. Lives in this
 * leaf module (it imports nothing) because both free-rotation.ts and
 * benchmark/validated.ts need it, and a validated → free-rotation edge would
 * close the cycle free-rotation → security-triage → validated (TRDD-FDI9NYAS
 * D3c-2: a certain 402 must not record a fail verdict).
 *
 *  - "certain": a real 402 status (c8b27000: "only a real 402 status means
 *    no-longer-free"), or a body that SAYS so — "payment required",
 *    "insufficient credit(s)" (session_summary/driver.ts's two phrases), or
 *    "credit(s) exhausted". Asking the same model again cannot help.
 *  - "uncertain": not certain, but it mentions a 402, credit or payment — worth
 *    exactly one same-model retry before moving on.
 *  - null: not a payment error. A 429/5xx is null even when its body mentions
 *    money (OpenRouter's daily free cap says "Add 10 credits to unlock ..."):
 *    transient failures keep their own retry and circuit-breaker path.
 */
export function paymentErrorCertainty(detail: string): PaymentErrorCertainty | null {
  const s = (detail || "").toLowerCase();
  const status = ERROR_STATUS_RE.exec(s)?.[1];
  if (
    status === "402" ||
    s.includes("payment required") ||
    s.includes("insufficient credit") ||
    /\bcredits? exhausted\b/.test(s)
  ) {
    return "certain";
  }
  if (status === "429" || status?.startsWith("5")) return null;
  return /\b(?:402|credits?|payments?)\b/.test(s) ? "uncertain" : null;
}
