// Plan §3 L1-08 / §7 Snapshot / D24: the reply model is the served build; a request is judged against its alias target, not its alias name.
import type { ResolvedModel } from "../l0/model.js";

export interface Snapshot {
  /** The base model without its build stamp, e.g. `typesafe/jev-1.13`. */
  family: string;
  /** The YYYYMMDD build stamp, or null for an unstamped id. */
  date: string | null;
}

// WHY: the catalog writes every dated build as `<id>-YYYYMMDD` (canonical_slug, P-02), and the stamp moves on each rebuild, so builds are compared by family, never by the whole string.
// shortcut: any 8 digits count as a stamp, no calendar check; upgrade when the catalog documents the stamp format.
const STAMPED = /^(.+)-(\d{8})$/;

export function parseSnapshot(model: string): Snapshot {
  const m = STAMPED.exec(model);
  return m ? { family: m[1], date: m[2] } : { family: model, date: null };
}

/**
 * Whether a served build (the reply model) is the build a request resolves to: the same base model as the alias target.
 * WHY a boolean, not a throw: E11, a differing reply model is recorded as the snapshot, not refused; the caller decides what it means.
 * shortcut: resolveModel has already replaced a dated request with its plain entry, so the requested stamp is not checked; upgrade by passing the requested id in here.
 */
export function isServedBuildOf(served: string, resolved: ResolvedModel): boolean {
  return parseSnapshot(served).family === resolved.effective.id;
}
