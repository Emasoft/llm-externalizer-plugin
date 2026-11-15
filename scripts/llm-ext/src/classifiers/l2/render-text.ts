// IN-07 (TRDD-LWDKZO2A, Q4 decided: text is the default stdout, `--json` prints the envelope unchanged): the one place a spec text form is wrapped.
// WHY a spec returns only `lines`: the runner adds what every command shares (a stopped run, warnings, saved files), so a spec cannot forget them and IN-08/IN-09 add a `renderText` and nothing else.
// The receipt line (cost, tokens, totals) stays with card C4-12.
import type { ResultEnvelope } from "./envelope.js";

/** The spec-declared render flags (SpecFlag.render), by their `field`; the spec reads the ones it declared. */
export type RenderOptions = Readonly<Record<string, unknown>>;

/** What a spec text form returns: the body lines, and the files its flags ask for (filter --save). The runner writes the files and redacts their content like the text. */
export interface TextRender {
  lines: string[];
  files?: { path: string; content: string }[];
}

/** Two decimals, as quicksilver prints a score. */
export const f2 = (n: number): string => n.toFixed(2);

/** One line: whitespace collapsed, cut at `max` characters with an ellipsis. */
export function clip(s: string, max: number): string {
  const one = s.trim().replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1))}…` : one;
}

/**
 * The stdout text: the spec body, then the notes every command shares.
 * `saved` are the paths that were really written; a failed write is a warning of the envelope, never a "saved" line.
 */
export function composeText(env: ResultEnvelope<unknown>, rendered: TextRender, saved: readonly string[]): string {
  const lines = [...rendered.lines];
  // WHY said in the text: a partial result that reads like a complete one would be taken for the whole answer.
  if (env.stopped !== null) lines.push(`— stopped (${env.stopped}): the result is partial`);
  for (const w of env.warnings) lines.push(`— warning: ${w.message}${w.count === undefined || w.count < 2 ? "" : ` (×${w.count})`}`);
  for (const p of saved) lines.push(`— full results saved to ${p}`);
  return `${lines.join("\n")}\n`;
}
