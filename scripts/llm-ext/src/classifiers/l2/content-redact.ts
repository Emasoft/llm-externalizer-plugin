// L2-07: redaction of file CONTENT before it is sent to the model (E37). Not log/report redaction: that is redact.ts (L2-15).
// No third copy of the patterns (plan §4): security_scan/intake.ts redactSecrets is the adopted one (see content-redact.test.ts for the comparison).
import { safeRedact } from "../../security_scan/intake.js";
import { InputError } from "./input-error.js";

export interface RedactedContent {
  text: string;
  /** Present only when something was redacted: "<label>: N secret(s) redacted before send". */
  warning?: string;
}

function checked(r: ReturnType<typeof safeRedact>, label: string): { redacted: string; count: number } {
  // Why throw: safeRedact is the fail-closed variant (a stalled or throwing pass must not egress); skipping silently would hide a missing input.
  if (!r.ok) throw new InputError(`${label}: ${r.reason}`);
  return r;
}

export function redactContent(text: string, label: string, budgetMs?: number): RedactedContent {
  // Why keepLines: a redacted multi-line match must keep its newlines so line N of the output is line N of the file (E37).
  const r = checked(safeRedact(text, budgetMs, { keepLines: true }), label);
  if (r.count === 0) return { text };
  return { text: r.redacted, warning: `${label}: ${r.count} secret${r.count === 1 ? "" : "s"} redacted before send` };
}
