// Plan §3 L2-14, D1: the one warning record and the one degraded record that classify and browse both put in the envelope.

/** A non-fatal notice. `code` is stable for parsers; `message` is for humans. */
export interface Warning {
  code: string;
  message: string;
  count?: number;
}

/** A run that used a fallback instead of its normal path (D1: keyword query for a search field, E96). */
export interface DegradedRecord {
  where: string;
  reason: string;
  /** What replaced the normal path; D1 requires it so a degraded result is never silent. */
  fallback: string;
}

export function warning(code: string, message: string, count?: number): Warning {
  // WHY fail fast: an empty code or message would print as a blank line nobody can act on.
  if (!code || !message) throw new Error("warning needs a non-empty code and message");
  return count === undefined ? { code, message } : { code, message, count };
}

/** WHY both: D1 says a fallback is "always reported", so one call yields the degraded record and its warning together. */
export function degrade(d: DegradedRecord): { degraded: DegradedRecord; warning: Warning } {
  if (!d.where || !d.reason || !d.fallback) throw new Error("degraded record needs where, reason and fallback");
  return { degraded: { ...d }, warning: warning("degraded", `${d.where}: ${d.reason}; used ${d.fallback}`) };
}
