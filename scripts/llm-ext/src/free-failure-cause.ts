// TRDD-3CG178O7 (increment 1a of TRDD-WSPV40Y5): typed per-model failure causes of the free rotation, the typed error
// the rotation throws for a network failure, and the PURE network-isolation classifier. No I/O in this module.

import { attachFailure, failureOf, NETWORK_ISOLATION_CODES, RetryDeadlineError, type FailureFields } from "./provider/http.js";

/**
 * Why ONE model of the free pool failed, as the rotation saw it. `failure` holds the typed fields the HTTP layer attached to
 * the thrown error (status, networkCode, providerState ...); it is undefined for a failure VALUE (a result the caller reported
 * as an error text) and for an error nobody typed. There is deliberately NO base URL here: the rotation does not know which
 * endpoint answered, so a probe URL must come from the active profile or the route, never from a cause.
 */
export interface FreeFailureCause {
  modelId: string;
  /** The text the rotation classified and recorded (failureText of the thrown error, or the failure value). */
  detail: string;
  failure: FailureFields | undefined;
  /** The thrown error, or the failure value text. */
  source: unknown;
}

/** The typed cause of one failed model. A RetryDeadlineError is looked through (failureOf unwraps one level, free-rotation can nest them). */
export function freeFailureCause(modelId: string, source: unknown, detail: string): FreeFailureCause {
  let real = source;
  while (real instanceof RetryDeadlineError) real = real.cause;
  return { modelId, detail, failure: failureOf(real), source };
}

/** A cause as an Error whose message is its detail (what failDynamicProfile and classifyError read as text), with the typed fields and the model id attached. */
export function freeFailureCauseToError(cause: FreeFailureCause): Error {
  const err = new Error(cause.detail, { cause: cause.source });
  attachFailure(err, { ...cause.failure, modelId: cause.modelId });
  return err;
}

/**
 * True when EVERY cause (at least one) carries a typed networkCode in NETWORK_ISOLATION_CODES: this machine reached no
 * provider at all. Pure. ETIMEDOUT-LOCAL is not in that set (a slow model is not a dead network); an empty list, a cause without
 * a code and a mixed list are false. It decides nothing by itself: the strict probe (1b) and the fallback decision (1d) combine
 * it with their own evidence.
 */
export function isNetworkIsolation(causes: readonly FreeFailureCause[]): boolean {
  return (
    causes.length > 0 &&
    causes.every((c) => c.failure?.networkCode !== undefined && NETWORK_ISOLATION_CODES.has(c.failure.networkCode))
  );
}

/**
 * What callWithFreeRotation throws when a model fails with a network error (no HTTP answer at all): before 1a this was the
 * raw fetch error, untyped, and its text ("fetch failed") named no cause. The ORIGINAL message stays first and unchanged
 * (classifyError and endpointFailureKind match on it); the code is appended. The typed fields of the original are re-attached
 * so failureOf, stopIfStopOnErrors and classifyError read the same values from this error.
 */
export class FreeRotationNetworkError extends Error {
  readonly causes: readonly FreeFailureCause[];

  constructor(cause: FreeFailureCause, networkCode: string) {
    super(`${cause.detail} (free model '${cause.modelId}' failed with network error ${networkCode})`, { cause: cause.source });
    this.name = "FreeRotationNetworkError";
    this.causes = [cause];
    attachFailure(this, { ...cause.failure });
  }
}

/**
 * The error the rotation rethrows when a failure is neither an availability verdict nor a certain payment error.
 * Only a plain Error with a typed networkCode becomes a FreeRotationNetworkError; everything else is returned untouched.
 * WHY a RetryDeadlineError is never wrapped: every reader keys on that type (classifyError's first branch, slotErrorContent,
 * the unwrap loops, pickEnsembleAllFailedError), so a wrapper would change their verdicts. WHY only a network code: every other
 * raw error (a genuine 400, a schema bug) keeps its identity, so no catch site sees a difference.
 */
export function typedRawFailure(modelId: string, err: unknown, detail: string): unknown {
  if (!(err instanceof Error) || err instanceof RetryDeadlineError) return err;
  const networkCode = failureOf(err)?.networkCode;
  if (networkCode === undefined) return err;
  return new FreeRotationNetworkError(freeFailureCause(modelId, err, detail), networkCode);
}
