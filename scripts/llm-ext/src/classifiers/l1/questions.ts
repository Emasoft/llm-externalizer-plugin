// Question types and builders for the decisions API (plan §3): every malformed question is refused here, before any request is sized or sent.
import { ClassifierError } from "../l0/errors.js";

export type Text = string;

// Shapes match the request bodies the API accepted in probe P-01: criteria is a true/false pair (noul, optional), a label->text map (choice) or a string list (score).
export type Question =
  | { type: "noul"; instructions: Text; criteria?: { true: Text; false: Text } }
  | { type: "choice"; instructions: Text; criteria: Record<string, Text | null> }
  | { type: "score"; instructions: Text; criteria: Text[] };

function refuse(message: string): never {
  throw new ClassifierError({ class: "bad-request", message: `question refused at build: ${message}`, retryable: false });
}

// Why trim: whitespace-only text carries no instruction; the API accepts it, so only the build can catch it (E32).
function assertText(what: string, v: unknown): asserts v is Text {
  if (typeof v !== "string" || v.trim() === "") refuse(`${what} must be a non-empty string`);
}

// Why only non-empty (E30): probe P-01 measured no pattern or length limit up to 5000 chars; the API refuses just the empty question key (HTTP 400). An empty criteria key is accepted by the API but is certainly a bug, so it is refused too.
export function assertKey(what: string, key: string): void {
  if (typeof key !== "string" || key === "") refuse(`${what} must be a non-empty string`);
}

export function noul(instructions: Text, criteria?: { true: Text; false: Text }): Question {
  assertText("instructions", instructions);
  if (criteria === undefined) return { type: "noul", instructions };
  // Why refuse null: a JS caller's null is a wrong value, not "no criteria"; reading .true on it throws a raw TypeError.
  if (criteria === null) refuse("noul criteria must be an object with true and false texts, got null");
  assertText("criteria.true", criteria.true);
  assertText("criteria.false", criteria.false);
  return { type: "noul", instructions, criteria: { true: criteria.true, false: criteria.false } };
}

export function choice(instructions: Text, criteria: Record<string, Text | null>): Question {
  assertText("instructions", instructions);
  const labels = Object.keys(criteria);
  // Why 2 (E31): a one-option choice is always certain, so it asks nothing.
  if (labels.length < 2) refuse(`a choice needs at least 2 options, got ${labels.length}`);
  for (const label of labels) {
    assertKey("choice criteria key", label);
    const text = criteria[label];
    if (text !== null) assertText(`choice criteria text of "${label}"`, text);
  }
  return { type: "choice", instructions, criteria: { ...criteria } };
}

export function score(instructions: Text, criteria: Text[]): Question {
  assertText("instructions", instructions);
  // Why 1: an empty scale has no levels to rate on.
  if (!Array.isArray(criteria) || criteria.length < 1) refuse("a score needs at least 1 criterion");
  criteria.forEach((c, i) => assertText(`score criteria[${i}]`, c));
  return { type: "score", instructions, criteria: [...criteria] };
}

// Why here: the question key is the only key not owned by a builder, so the keyed set is checked where it is assembled.
export function questionSet(entries: Record<string, Question>): Record<string, Question> {
  for (const key of Object.keys(entries)) assertKey("question key", key);
  return { ...entries };
}
