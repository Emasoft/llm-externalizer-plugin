/**
 * provider/strip-thinking.ts: the production reply-side handling of a thinking block (USER directive 2026-10-28, TRDD-1OOAH3LD gap C1-7:
 * strip the thinking block). NOT the calibration scorer stripThinking (calibration/phase-a.ts), which is deliberately more aggressive.
 */

/** A reasoning block at the very start of a reply, the whitespace before it, and the whitespace right after it. */
const LEADING_THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/;

/**
 * Remove ONLY a leading `<think>…</think>` block (with the whitespace right after it); anything else comes back byte for byte, no trim.
 * WHY so narrow: a model puts its reasoning first, so a block at the start is reasoning; a think tag anywhere else (after text, an orphan
 * `</think>`, an unclosed `<think>`) may be the answer itself quoting the tag, or a cut-off reply whose handling (empty / length) must stay
 * exactly what it was before thinking was switched on. The calibration stripThinking would drop text before an orphan close tag and after
 * an unclosed open tag and would trim, which is right for scoring and wrong for a real answer.
 */
export function stripLeadingThinkBlock(content: string): string {
  return content.replace(LEADING_THINK_BLOCK, "");
}
