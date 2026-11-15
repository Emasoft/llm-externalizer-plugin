// C4-12 (TRDD-APQ601NV), plan §9 receipt paragraph: the receipt every classify run ends with, in quicksilver's format (qs.mjs footer(), lines 880-894), plus the lifetime Jev totals line.
// WHY a leaf module: run-decision.ts is over 300 lines; it only gathers the numbers, this file owns the wording.
import { estimateTokens } from "./l1/estimate.js";
import { lifetimeJevTotalsIncremental, type JevLifetimeTotals } from "../usage-history.js";

/** E132: under this many input tokens Claude could read the input itself for less than a Jev call costs (cost study break-even). */
export const SMALL_INPUT_TOKENS = 1000;

/** The lifetime Jev totals from the usage history, or the reason they cannot be read. WHY not thrown: the run is paid for and its answer already printed; an unreadable history must not turn that into a failure. */
export function lifetimeOrReason(): JevLifetimeTotals | string {
  try {
    return lifetimeJevTotalsIncremental();
  } catch (e) {
    return (e as Error).message;
  }
}

export interface Receipt {
  /** Items the run sent for judgment. */
  items: number;
  /** One `<path>: <reason>` per input the reader left out. */
  skipped: string[];
  elapsedMs: number;
  /** MEASURED: the replies' own usage and cost. */
  jevInputTokens: number;
  /** null when the cost is not a finite number: the receipt then says `cost unknown` and never prints a figure it does not have. */
  costUsd: number | null;
  costEstimated: boolean;
  /** The served builds, first seen first; empty when no request was sent. */
  models: string[];
  /** Estimated tokens of the input the run sent. */
  contentTokens: number;
  /** ESTIMATED: contentTokens minus the tokens of what was printed. WHY the name says it: this figure is never chart data, only measured usage is (RD-06). */
  notReadEstimateTokens: number;
}

export function buildReceipt(o: {
  elapsedMs: number;
  /** Input states of the built units, in the form they are sent. */
  states: readonly unknown[];
  /** The shared state every request carries (Built.sharedState): compare passages, the extract document, the decide evidence, the check before/after. */
  shared?: unknown;
  /** How many unsplittable questions the run asked (Built.unsplittable): decide and check have no units, every question is one of these. */
  unsplittable?: number;
  /** The text the run printed to stdout. */
  shown: string;
  usage: { input_tokens: number };
  cost: { usd: number; cost_estimated: boolean };
  snapshots: readonly string[];
  /** The input reader's warnings; the ones starting `skipped ` are the skipped inputs (input-args.ts). */
  inputWarnings: readonly string[];
}): Receipt {
  // WHY the shared state and the unsplittable questions count too (quality eval of run 20261031_191133): compare and extract carry their documents in the shared state, so counting unit states alone printed "about 4 tokens" for 787 billed; decide and check build no units, so they printed "0 scanned" after judging 7 and 2 questions.
  const contentTokens = (o.shared === undefined || o.shared === null ? 0 : estimateTokens(o.shared)) + o.states.reduce<number>((n, s) => n + estimateTokens(s), 0);
  return {
    items: o.states.length + (o.unsplittable ?? 0),
    skipped: o.inputWarnings.filter((w) => w.startsWith("skipped ")).map((w) => w.slice("skipped ".length)),
    elapsedMs: o.elapsedMs,
    jevInputTokens: o.usage.input_tokens,
    // WHY the finite test (review of 4acc83bb, finding 6): .toFixed on an absent or NaN cost would throw AFTER the paid answer was printed, or print "NaN".
    costUsd: Number.isFinite(o.cost.usd) ? o.cost.usd : null,
    costEstimated: o.cost.cost_estimated,
    models: [...o.snapshots],
    contentTokens,
    notReadEstimateTokens: Math.max(0, contentTokens - estimateTokens(o.shown)),
  };
}

// WHY the same as qs.mjs fmtK: the receipt must read like quicksilver's.
const fmtK = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The receipt lines. The qs line is LAST, so it is the last line of the command; the notes come before it. `lifetime` is a string when the history could not be read. */
export function renderReceipt(r: Receipt, lifetime: JevLifetimeTotals | string | null): string {
  const lines: string[] = [];
  if (r.skipped.length > 0) lines.push(`— skipped ${r.skipped.length}: ${clip(r.skipped.join(", "), 400)}`);
  if (r.items > 0 && r.contentTokens < SMALL_INPUT_TOKENS) {
    lines.push(`— this input is about ${r.contentTokens} tokens (under ${SMALL_INPUT_TOKENS.toLocaleString("en-US")}): Claude could read it directly for less than this call costs`);
  }
  if (typeof lifetime === "string") lines.push(`— lifetime Jev totals unavailable: ${lifetime}`);
  else if (lifetime !== null && lifetime.requests > 0) {
    lines.push(`— lifetime: ${lifetime.runs} runs · ${lifetime.requests} requests · jev ${fmtK(lifetime.inputTokens)} tok ($${lifetime.costUsd.toFixed(4)})${lifetime.since === null ? "" : ` since ${lifetime.since.slice(0, 10)}`}`);
  }
  const parts = [
    `${r.items} scanned`,
    `${(r.elapsedMs / 1000).toFixed(1)}s`,
    `jev ${fmtK(r.jevInputTokens)} tok (${r.costUsd === null ? "cost unknown" : `$${r.costUsd.toFixed(4)}${r.costEstimated ? " estimated" : ""}`})`,
    ...(r.models.length > 0 ? [`via ${r.models.join(", ")}`] : []),
    // WHY left out at 0: "~0 Claude tokens not read" says nothing a reader can use.
    ...(r.notReadEstimateTokens > 0 ? [`~${fmtK(r.notReadEstimateTokens)} Claude tokens not read (estimated)`] : []),
  ];
  lines.push(`— ${parts.join(" · ")}`);
  return lines.join("\n");
}
