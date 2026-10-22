// Request shape checks (plan §3, L1-02): refuse an over-sized request before it is sent, with a message that says what to change.
import { ClassifierError } from "../l0/errors.js";
import type { Question } from "./questions.js";

// Why 52428800: probe P-01 sent a 60 MB body and the API answered 413 "exceeds the maximum allowed size of 52428800 bytes" (dec-err413-60mb).
export const MAX_REQUEST_BODY_BYTES = 52_428_800;

export interface ShapeLimits {
  // Why required: no API limit on question count was measured, so it comes from the caller (the spec or the model limits, L2-03), never from a guess here.
  maxQuestions: number;
  // Defaults to the measured API cap; a caller may set a lower one.
  maxBytes?: number;
}

function refuse(message: string, remedy: string): never {
  throw new ClassifierError({ class: "bad-request", message: `${message}; ${remedy}`, remedy_hint: remedy, retryable: false });
}

// Why the body is {state, questions} only: the model id and optional fields are a few hundred bytes, far below any cap this check is set to.
export function checkRequestShape(questions: Record<string, Question>, state: unknown, limits: ShapeLimits): void {
  const maxBytes = limits.maxBytes ?? MAX_REQUEST_BODY_BYTES;
  if (!Number.isInteger(limits.maxQuestions) || limits.maxQuestions < 1) throw new Error(`maxQuestions must be a positive integer, got ${String(limits.maxQuestions)}`);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error(`maxBytes must be a positive integer, got ${String(maxBytes)}`);
  const count = Object.keys(questions).length;
  // Why refuse 0: the API answers 400 when the questions record is missing (P-01 dec-err400-noquestions), so a request with nothing to ask is a caller bug.
  if (count < 1) refuse("the request has no questions, it needs at least 1 question", "add at least one question");
  if (count > limits.maxQuestions) refuse(`the request has ${count} questions, over the limit of ${limits.maxQuestions}`, `remove ${count - limits.maxQuestions} questions or split them across requests`);
  // Why bytes of the JSON text: the API cap counts the request body, and UTF-8 multi-byte text makes characters undercount it.
  const bytes = Buffer.byteLength(JSON.stringify({ state, questions }), "utf8");
  if (bytes > maxBytes) refuse(`the request is ${bytes} bytes serialized, over the limit of ${maxBytes} bytes`, "shorten the state or split it across requests");
}
