/**
 * HARD SPEND CAP for the model pipeline (P4).
 *
 * WHY THIS EXISTS — the incident this is built to make impossible:
 * commit 31ce212 fixed a cost-safety defect that had drained **$17.67 of a real
 * OpenRouter balance in one hour**. Nothing in the pipeline BOUNDED spend; a run
 * either finished or it emptied the wallet. This module is that bound, and it is
 * enforced at the ONE place money is actually committed — the HTTP request — not
 * in prose asking an agent to "be careful".
 *
 * The two guarantees, in the order they fire:
 *
 *   1. RESERVE (before every paid call). We compute the WORST-CASE cost the
 *      request could incur and refuse to send it when `spent + worstCase > cap`.
 *      So the cap is never crossed by a call we chose to make: we abort BEFORE
 *      the spend, not after it.
 *   2. RECORD (after every paid call). We read the provider's OWN `usage` block
 *      and add the ACTUAL cost. If that ever exceeds the cap anyway (a provider
 *      billing past the bound we asked for), the ledger TRIPS.
 *
 * THE TRIP LATCH is load-bearing, not decoration. Every benchmark runner in this
 * repo CATCHES fetch errors and converts them into a per-case failure (that is
 * their never-throw contract — see runner.ts's `network error:` branch). So a
 * throw from inside the fetch is SWALLOWED by the runner and the sweep would
 * merrily continue spending. The latch defeats that: once tripped, every
 * subsequent `reserve()` refuses instantly, so not one further cent can leave the
 * account even while the runner is busy marking cases failed. The orchestrator
 * then checks `tripped` at the next unit boundary and fails the whole run fast
 * with an accurate "spent / skipped" report. Refuse-then-report, never
 * silent-continue.
 */

import type { FetchImpl, FetchResponse } from "../security_scan/judge.js";

/**
 * Default cap for a PAID sweep. Deliberately small.
 *
 * WHY $2: the owner's OpenRouter balance is ~$20, and the 31ce212 incident burned
 * $17.67 in a single unbounded hour. $2 is ~10% of the balance — a runaway costs a
 * coffee, not the wallet — while still covering a realistic full six-tool paid
 * refresh at the default 15-candidate cap.
 *
 * The stronger guarantee is NOT this number, it is the MODE default: `--update-all`
 * with no mode flag runs in FREE mode and cannot spend a cent (see update-all.ts).
 * Money is only ever at risk when the operator TYPES `--paid` / `--both`, and even
 * then it is capped here. A run whose pre-flight estimate exceeds the cap aborts and
 * prints the exact `--budget-usd` value that would let it through — so raising the
 * cap is always a deliberate, informed, typed decision.
 */
export const DEFAULT_BUDGET_USD = 2.0;

/**
 * Chars→tokens divisor used ONLY for the pre-call estimate.
 *
 * 3 (not the usual ~4) on purpose: this is a SPEND CAP, so every approximation must
 * err toward OVER-estimating. Source code — which is what every one of these
 * benchmarks sends — tokenizes denser than prose (punctuation, identifiers, indent),
 * so 4 would under-count and let a call through that the cap should have refused.
 * Over-counting only makes the guard stricter, which is the safe direction.
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 3;

/**
 * Assumed output bound for a request that declares NO `max_tokens`.
 *
 * This is an ASSUMPTION and is labelled as one — not a measurement. Four of the six
 * benchmarks declare a real `max_tokens` and the estimator uses THAT (a genuine
 * contractual bound). The keyword/ensemble sweep does not declare one (adding it
 * would risk truncating reasoning models and shifting the golden baseline), so a cap
 * must assume a bound for it. 16K generously covers a strict-JSON schema response of
 * three short arrays plus reasoning headroom, and bounds a runaway at cents per call.
 *
 * If a provider ever exceeds it, `record()` sees the REAL usage and trips the ledger,
 * so a wrong assumption can cost at most one call's over-run — never an unbounded one.
 */
export const ASSUMED_MAX_OUTPUT_TOKENS = 16_000;

export interface ModelPrice {
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
}

/** Resolve a model id to its catalog price. `undefined` = unknown to the catalog. */
export type PriceLookup = (modelId: string) => ModelPrice | undefined;

export class BudgetExceededError extends Error {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly wouldSpendUsd: number;
  readonly label: string;

  constructor(args: { capUsd: number; spentUsd: number; wouldSpendUsd: number; label: string }) {
    super(
      `SPEND CAP: refusing to call '${args.label}' — it would bring the run to ` +
        `$${(args.spentUsd + args.wouldSpendUsd).toFixed(4)}, over the $${args.capUsd.toFixed(2)} cap ` +
        `(already spent $${args.spentUsd.toFixed(4)}; this call's worst case $${args.wouldSpendUsd.toFixed(4)}). ` +
        `Nothing further will be sent. Raise the cap with --budget-usd, or use --free ($0).`,
    );
    this.name = "BudgetExceededError";
    this.capUsd = args.capUsd;
    this.spentUsd = args.spentUsd;
    this.wouldSpendUsd = args.wouldSpendUsd;
    this.label = args.label;
  }
}

/** Cost of one call, in USD. Pure. */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice,
): number {
  return (
    (inputTokens * price.inputDollarsPerMillion + outputTokens * price.outputDollarsPerMillion) /
    1_000_000
  );
}

/** A model priced at exactly $0 on both axes can never move the ledger. */
export function isZeroPriced(price: ModelPrice): boolean {
  return price.inputDollarsPerMillion === 0 && price.outputDollarsPerMillion === 0;
}

export interface SpendEntry {
  label: string;
  usd: number;
}

/**
 * The running spend account. One per `--update-all` run; shared by every benchmark
 * so the cap is a property of the RUN, not of each tool in isolation (five tools
 * each staying under the cap would otherwise spend 5× it).
 */
export class SpendLedger {
  readonly capUsd: number;
  private spent = 0;
  private trip: string | null = null;
  private readonly log: SpendEntry[] = [];

  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd < 0) {
      throw new Error(`SpendLedger: cap must be a finite non-negative USD amount, got ${capUsd}`);
    }
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spent);
  }

  /** Non-null once the cap has been hit — every later reserve() refuses instantly. */
  get tripped(): string | null {
    return this.trip;
  }

  get entries(): readonly SpendEntry[] {
    return this.log;
  }

  /**
   * Gate ONE call. Throws BudgetExceededError when the call's worst case would cross
   * the cap — i.e. we abort BEFORE the money is committed, which is the whole point.
   * Also refuses instantly once tripped (see the trip-latch note in the file header).
   */
  reserve(label: string, worstCaseUsd: number): void {
    if (this.trip !== null) {
      throw new BudgetExceededError({
        capUsd: this.capUsd,
        spentUsd: this.spent,
        wouldSpendUsd: worstCaseUsd,
        label,
      });
    }
    if (this.spent + worstCaseUsd > this.capUsd) {
      this.trip = `reserve '${label}' would cross the cap`;
      throw new BudgetExceededError({
        capUsd: this.capUsd,
        spentUsd: this.spent,
        wouldSpendUsd: worstCaseUsd,
        label,
      });
    }
  }

  /**
   * Book the ACTUAL cost of a completed call. Never throws — the money is already
   * gone and throwing here would only be swallowed by the runner's catch. It TRIPS
   * instead, which is what actually stops the bleeding (every later reserve refuses).
   */
  record(label: string, actualUsd: number): void {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) return;
    this.spent += actualUsd;
    this.log.push({ label, usd: actualUsd });
    if (this.spent > this.capUsd && this.trip === null) {
      this.trip = `actual spend $${this.spent.toFixed(4)} exceeded the $${this.capUsd.toFixed(2)} cap on '${label}'`;
    }
  }
}

// ── The per-call chokepoint ──────────────────────────────────────────────────
//
// Both wrappers below share ONE core (chargeRequest / chargeResponse) so the
// reserve/record rules cannot drift between the two request shapes in this repo:
//   - FetchImpl        — the injectable seam the five per-tool benchmarks already
//                        take (security-triage, search-existing, code-task,
//                        scan-folder, check-specs).
//   - global fetch     — what the keyword/ensemble runner uses (runner.ts), which
//                        needs the real Response (it reads `headers` for retry-after).

interface ChatRequestBody {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
}

/** Reserve budget for a request. Returns the model id so the response can be booked. */
function chargeRequest(bodyRaw: string, ledger: SpendLedger, priceOf: PriceLookup): string {
  let body: ChatRequestBody;
  try {
    body = JSON.parse(bodyRaw) as ChatRequestBody;
  } catch {
    // A body we cannot read is a body whose cost we cannot bound. Under a spend cap
    // the only safe answer is to refuse — never "assume it's cheap and send it".
    throw new Error("SPEND CAP: refusing a request whose JSON body could not be parsed to bound its cost.");
  }
  const modelId = typeof body.model === "string" ? body.model : "";
  if (modelId === "") {
    throw new Error("SPEND CAP: refusing a chat request with no `model` field — its cost cannot be bounded.");
  }

  const price = priceOf(modelId);
  if (price === undefined) {
    // Fail-safe: an unpriced model is one whose bill we cannot predict. Refusing is
    // the conservative direction; guessing a price is exactly how a cap gets blown.
    throw new Error(
      `SPEND CAP: refusing to call '${modelId}' — it is not in the OpenRouter catalog, ` +
        `so its cost cannot be bounded before the call.`,
    );
  }

  // A provably $0 model can never move the ledger. Skip the reserve so free mode
  // works under a $0 cap (the free-mode zero-spend guarantee is exactly this line).
  if (isZeroPriced(price)) return modelId;

  const promptChars = typeof body.messages === "undefined" ? 0 : JSON.stringify(body.messages).length;
  const estInTokens = Math.ceil(promptChars / CONSERVATIVE_CHARS_PER_TOKEN);
  const estOutTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? body.max_tokens
      : ASSUMED_MAX_OUTPUT_TOKENS;

  ledger.reserve(modelId, estimateCostUsd(estInTokens, estOutTokens, price));
  return modelId;
}

interface UsageBlock {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Book the actual cost from the provider's own usage block. */
function chargeResponse(
  rawText: string,
  modelId: string,
  ledger: SpendLedger,
  priceOf: PriceLookup,
): void {
  const price = priceOf(modelId);
  if (price === undefined || isZeroPriced(price)) return;
  let parsed: UsageBlock;
  try {
    parsed = JSON.parse(rawText) as UsageBlock;
  } catch {
    // An error page / truncated body carries no usage. A failed call is not billed
    // for completion; the reserve above already bounded the exposure either way.
    return;
  }
  const inTok = typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : 0;
  const outTok = typeof parsed.usage?.completion_tokens === "number" ? parsed.usage.completion_tokens : 0;
  if (inTok === 0 && outTok === 0) return;
  ledger.record(modelId, estimateCostUsd(inTok, outTok, price));
}

/**
 * Wrap the five per-tool benchmarks' injectable HTTP seam so every call they make
 * is reserved before it is sent and booked after it returns.
 *
 * The response body is buffered ONCE here (a stream can only be read once) and
 * re-served to the caller through both `text()` and `json()`, so the benchmark sees
 * byte-identical data to an unwrapped fetch — the guard is transparent, never lossy.
 */
export function makeBudgetedFetch(
  inner: FetchImpl,
  ledger: SpendLedger,
  priceOf: PriceLookup,
): FetchImpl {
  return async (url, init): Promise<FetchResponse> => {
    const modelId = chargeRequest(init.body, ledger, priceOf); // throws → call never sent
    const resp = await inner(url, init);
    const raw = await resp.text();
    chargeResponse(raw, modelId, ledger, priceOf);
    return {
      ok: resp.ok,
      status: resp.status,
      text: async (): Promise<string> => raw,
      json: async (): Promise<unknown> => JSON.parse(raw),
    };
  };
}

/** The global-`fetch`-shaped twin, for the keyword/ensemble runner (runner.ts). */
export type GlobalFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Same guard, global-fetch shape. Returns a REAL `Response` rebuilt from the buffered
 * body, preserving status + headers — runner.ts reads `retry-after` off them for its
 * 429 backoff, so a lossy stand-in would silently break free-tier retries.
 */
export function makeBudgetedGlobalFetch(
  ledger: SpendLedger,
  priceOf: PriceLookup,
  inner: GlobalFetch = (url, init): Promise<Response> => fetch(url, init),
): GlobalFetch {
  return async (url, init): Promise<Response> => {
    const body = typeof init.body === "string" ? init.body : "";
    const modelId = chargeRequest(body, ledger, priceOf); // throws → call never sent
    const resp = await inner(url, init);
    const raw = await resp.text();
    chargeResponse(raw, modelId, ledger, priceOf);
    // The Response constructor THROWS (TypeError) if a body is supplied with a
    // null-body status (204/205/304), and RangeError outside 200..599. Rebuilding
    // blindly would therefore turn a harmless provider response into a crash inside
    // the guard — the guard must never be the thing that breaks the run.
    const nullBody = resp.status === 204 || resp.status === 205 || resp.status === 304;
    return new Response(nullBody || raw === "" ? null : raw, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  };
}
