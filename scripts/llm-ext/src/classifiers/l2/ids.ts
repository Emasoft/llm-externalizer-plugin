// L2-08, plan D14: the one rule for caller-supplied item ids, and the one way question keys are built.

/** Refusal of a caller id (CLI exit 1). */
export class IdError extends Error {
  constructor(
    readonly code: "invalid" | "duplicate",
    message: string,
  ) {
    super(message);
    this.name = "IdError";
  }
}

// WHY one pattern and no renaming: jev-mcp had three strategies (rename with _1, verbatim with _2 fallback, slug-reject); a silent rename makes the output id differ from the id the caller sent.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// WHY truncated: an invalid id can be arbitrarily long and carry newlines; JSON.stringify keeps the message on one line.
function named(id: unknown): string {
  const s = typeof id === "string" ? id : String(id);
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}...` : s);
}

/** Refuses the first id that is not a string matching ID_PATTERN or that repeats an earlier id (E50, E51). */
export function checkItemIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new IdError("invalid", `invalid item id ${named(id)}: ids must match [A-Za-z0-9_-]{1,64}`);
    }
    if (seen.has(id)) throw new IdError("duplicate", `duplicate item id ${named(id)}`);
    seen.add(id);
  }
}

const KEY_STEM = /^[A-Za-z][A-Za-z0-9_]*$/;

// WHY the index and never the caller id: the API has key rules the id rule does not know about, so a valid id could still break a key; caller ids travel in state and are mapped back in project.
/** The question key of item `index`, e.g. label_i0. */
export function indexKey(prefix: string, index: number): string {
  if (!KEY_STEM.test(prefix)) throw new RangeError(`key prefix must be a plain name, got ${named(prefix)}`);
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`key index must be a non-negative integer, got ${index}`);
  return `${prefix}_i${index}`;
}
