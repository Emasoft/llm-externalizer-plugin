// L2-09: evidence/state builder (plan §3). Sources get an index so instructions can point at sources[i] and never carry the text (D5);
// truncate-and-flag happens here only when a spec asks for it (plan §5), the planner never truncates.
import type { Built, ProjectCtx } from "../catalog/spec.js";
import { estimateTokens } from "../l1/estimate.js";
import type { Snippet } from "./inputs.js";

export interface EvidenceInput {
  label: string;
  text: string;
  /** The caller already holds only part of the source (a line range or head read); counts as truncated. */
  partial?: boolean;
}
export interface EvidenceOptions {
  /** Characters kept per source; absent means no cut. */
  maxChars?: number;
  /** Estimated tokens (estimateTokens of the JSON text) kept per source, applied after maxChars; absent means no cut. An integer >= 0, else it throws; 0 or 1 (below the two JSON quote characters) empties every source and flags it (same contract as cutToTokens). WHY besides maxChars: non-ASCII text and symbols cost one token per character or more, so a character cap alone can leave one source over the request limit. */
  maxTokens?: number;
}
export interface Evidence {
  sharedState: Built["sharedState"];
  ctx: ProjectCtx;
}

export function buildEvidence(inputs: EvidenceInput[], opts: EvidenceOptions = {}): Evidence {
  if (inputs.length === 0) throw new Error("evidence needs at least one source");
  const max = opts.maxChars;
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new Error(`maxChars must be a positive integer, got ${max}`);
  const maxTokens = opts.maxTokens;
  if (maxTokens !== undefined) assertTokenBudget(maxTokens);
  const sources = inputs.map((s, index) => {
    let text = s.text;
    let truncated = s.partial === true;
    if (max !== undefined && text.length > max) {
      // Why drop a trailing high surrogate: a cut between the two halves of an emoji would send a lone surrogate to the model.
      text = text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
      truncated = true;
    }
    if (maxTokens !== undefined) {
      const c = cutToTokens(text, maxTokens);
      text = c.text;
      truncated = truncated || c.cut;
    }
    return { index, label: s.label, text, truncated };
  });
  return { sharedState: { sources }, ctx: { truncated: sources.some((s) => s.truncated) } };
}

// WHY derived from estimateTokens: whitespace is its cheapest class (3/12 token), so no character costs less than 1/MAX_CHARS_PER_TOKEN token and a prefix longer than budget x this cannot fit. 48 is a multiple of 12 so the quotient is exact.
const MAX_CHARS_PER_TOKEN = 48 / estimateTokens(" ".repeat(48));

function assertTokenBudget(maxTokens: number): void {
  if (!Number.isInteger(maxTokens) || maxTokens < 0) throw new Error(`maxTokens must be a non-negative integer, got ${maxTokens}`);
}

/**
 * Largest prefix of `text` whose JSON form (what the planner counts) is at most `maxTokens` estimated tokens.
 * CONTRACT (also buildEvidence's maxTokens): the budget is an integer >= 0, anything else throws; the JSON quotes alone cost 2 tokens, so a budget of 0 or 1 gives empty text with cut true; an empty text is never cut; a prefix never ends in a lone high surrogate.
 * WHY here: the one token-aware cut; audit, review, check and extract all cut through it, so the estimate and the surrogate rule cannot drift apart.
 */
export function cutToTokens(text: string, maxTokens: number): { text: string; cut: boolean; tokens: number } {
  assertTokenBudget(maxTokens);
  // WHY the trailing high surrogate is dropped inside the measure: a lone surrogate is escaped by JSON.stringify (6 characters), so measuring it would make the estimate non-monotonic and the search would stop early.
  const prefix = (n: number): string => {
    const p = text.slice(0, n);
    return /[\uD800-\uDBFF]$/.test(p) ? p.slice(0, -1) : p;
  };
  const tokens = (n: number): number => estimateTokens(JSON.stringify(prefix(n)));
  // WHY a cap on the search: no text fits more than MAX_CHARS_PER_TOKEN characters per token, so longer prefixes are never estimated (a 10 MB input costs the same as a short one).
  const cap = Math.min(text.length, maxTokens * MAX_CHARS_PER_TOKEN);
  if (text.length === 0) return { text, cut: false, tokens: tokens(0) };
  if (cap === text.length && tokens(cap) <= maxTokens) return { text, cut: false, tokens: tokens(cap) };
  // WHY binary search: the estimate grows with the prefix, so the largest fitting prefix is found in about 20 estimates.
  let lo = 0;
  let hi = cap;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tokens(mid) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return { text: prefix(lo), cut: true, tokens: tokens(lo) };
}

// Why compared with totalLines: readForJev slices are the only place a source can be partial before a spec sees it.
export function sourceFromSnippet(label: string, snip: Snippet): EvidenceInput {
  return { label, text: snip.text, partial: snip.fromLine > 1 || snip.toLine < snip.totalLines };
}
