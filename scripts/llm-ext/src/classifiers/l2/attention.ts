// Plan §3 L2-13, §9: exit codes of a classify run.
// llm-ext convention (cli/main.ts:18-19, die() at :136-139): exit 0 success, exit 1 error or malformed call; Ctrl-C is CTRL_C_EXIT_CODE (abort.ts:5).
// llm-ext has no code for "key/credits", "request rejected" or "failed after retries", so quicksilver's 3, 4, 5 are used for those only.
import type { ClassifierError, ErrorClass } from "../l0/errors.js";

// WHY a Record: a new ErrorClass must fail to compile until it is given an exit code.
const ERROR_EXIT: Record<ErrorClass, 3 | 4 | 5> = {
  auth: 3,
  payment: 3,
  // WHY 5: the transport retries an in-flight 402 (plan §7), so this error only surfaces after the retries ran out.
  "in-flight-budget": 5,
  "key-limit": 3,
  "bad-request": 4,
  "not-found": 4,
  "too-large": 4,
  "context-overflow": 4,
  "rate-limited": 5,
  unavailable: 5,
  network: 5,
  timeout: 5,
  "bad-response": 5,
};

export function exitCodeForError(err: ClassifierError): 3 | 4 | 5 {
  return ERROR_EXIT[err.class];
}

/** WHY 1: attention is "the tool wants a look", and llm-ext's only non-zero code for a run that finished is 1; without --strict-exit it stays 0 so scripts opt in. */
export function exitCodeForRun(opts: { attention: boolean; strictExit: boolean }): 0 | 1 {
  return opts.attention && opts.strictExit ? 1 : 0;
}
