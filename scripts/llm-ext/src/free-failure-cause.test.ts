/**
 * free-failure-cause.test.ts — TRDD-3CG178O7: the PURE network-isolation classifier and the typed rethrow helper.
 * No I/O and no mocks: the causes are built from real Error objects with the typed failure fields the HTTP layer attaches.
 */
import { describe, it, expect } from "vitest";
import {
  freeFailureCause,
  FreeRotationNetworkError,
  isNetworkIsolation,
  typedRawFailure,
  type FreeFailureCause,
} from "./free-failure-cause.js";
import { attachFailure, failureOf, NETWORK_ISOLATION_CODES, OUTAGE_NETWORK_CODES, RetryDeadlineError } from "./provider/http.js";

/** A cause as the rotation builds it: a real Error with the fields the HTTP layer attaches. */
function causeWith(modelId: string, fields: { networkCode?: string; status?: number } | undefined, text = "fetch failed"): FreeFailureCause {
  const err = new Error(text);
  if (fields !== undefined) attachFailure(err, fields);
  return freeFailureCause(modelId, err, text);
}

describe("NETWORK_ISOLATION_CODES", () => {
  it("is OUTAGE_NETWORK_CODES minus ETIMEDOUT-LOCAL, nothing else", () => {
    expect(NETWORK_ISOLATION_CODES.has("ETIMEDOUT-LOCAL")).toBe(false);
    expect([...NETWORK_ISOLATION_CODES].sort()).toEqual([...OUTAGE_NETWORK_CODES].filter((c) => c !== "ETIMEDOUT-LOCAL").sort());
    expect(NETWORK_ISOLATION_CODES.size).toBe(OUTAGE_NETWORK_CODES.size - 1);
  });

  it("pins the set as a literal: a code dropped from it fails here, the it.each above cannot", () => {
    expect([...NETWORK_ISOLATION_CODES].sort()).toEqual(
      ["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].sort(),
    );
  });
});

describe("isNetworkIsolation", () => {
  it.each([...NETWORK_ISOLATION_CODES])("%s on every cause is isolation", (code) => {
    expect(isNetworkIsolation([causeWith("m1", { networkCode: code })])).toBe(true);
    expect(isNetworkIsolation([causeWith("m1", { networkCode: code }), causeWith("m2", { networkCode: code })])).toBe(true);
  });

  it("ETIMEDOUT-LOCAL (the request own timeout) is not isolation", () => {
    expect(isNetworkIsolation([causeWith("m1", { networkCode: "ETIMEDOUT-LOCAL" })])).toBe(false);
  });

  it("a cause with no networkCode is not isolation (an HTTP status, an untyped error, a failure value)", () => {
    expect(isNetworkIsolation([causeWith("m1", { status: 503 }, "API error 503")])).toBe(false);
    expect(isNetworkIsolation([causeWith("m1", undefined)])).toBe(false);
    expect(isNetworkIsolation([freeFailureCause("m1", "API error 503 text value", "API error 503 text value")])).toBe(false);
  });

  it("a mixed list is not isolation, in either order", () => {
    const refused = causeWith("m1", { networkCode: "ECONNREFUSED" });
    const status = causeWith("m2", { status: 503 }, "API error 503");
    const local = causeWith("m3", { networkCode: "ETIMEDOUT-LOCAL" });
    expect(isNetworkIsolation([refused, status])).toBe(false);
    expect(isNetworkIsolation([status, refused])).toBe(false);
    expect(isNetworkIsolation([refused, local])).toBe(false);
  });

  it("an empty list is not isolation", () => {
    expect(isNetworkIsolation([])).toBe(false);
  });

  it("looks through a RetryDeadlineError to the typed failure of its cause", () => {
    const inner = new Error("fetch failed");
    attachFailure(inner, { networkCode: "ENOTFOUND" });
    const deadline = new RetryDeadlineError({ attempts: 2, elapsedMs: 10, lastStatus: undefined }, inner, undefined, false);
    expect(isNetworkIsolation([freeFailureCause("m1", deadline, "fetch failed")])).toBe(true);
  });
});

describe("typedRawFailure", () => {
  it("a plain Error with a networkCode becomes a FreeRotationNetworkError: original text first, code named, fields re-attached", () => {
    const raw = new Error("fetch failed");
    attachFailure(raw, { networkCode: "ECONNREFUSED" });
    const typed = typedRawFailure("vendor/free-a:free", raw, "fetch failed");
    expect(typed).toBeInstanceOf(FreeRotationNetworkError);
    const e = typed as FreeRotationNetworkError;
    expect(e.message.startsWith("fetch failed")).toBe(true);
    expect(e.message).toContain("ECONNREFUSED");
    expect(e.message).toContain("vendor/free-a:free");
    expect(e.cause).toBe(raw);
    expect(failureOf(e)?.networkCode).toBe("ECONNREFUSED");
    expect(e.causes).toHaveLength(1);
    expect(e.causes[0].modelId).toBe("vendor/free-a:free");
    expect(e.causes[0].failure?.networkCode).toBe("ECONNREFUSED");
    expect(isNetworkIsolation(e.causes)).toBe(true);
  });

  it("ETIMEDOUT-LOCAL is typed too (the cause list names it) but is not isolation", () => {
    const raw = new Error("This operation was aborted");
    attachFailure(raw, { networkCode: "ETIMEDOUT-LOCAL" });
    const typed = typedRawFailure("m", raw, raw.message) as FreeRotationNetworkError;
    expect(typed).toBeInstanceOf(FreeRotationNetworkError);
    expect(isNetworkIsolation(typed.causes)).toBe(false);
  });

  it("every other raw error keeps its identity: no code, a plain 400, a RetryDeadlineError, a non-Error", () => {
    const noCode = new Error("API error 400 (local): bad request");
    attachFailure(noCode, { status: 400 });
    expect(typedRawFailure("m", noCode, noCode.message)).toBe(noCode);
    const untyped = new Error("boom");
    expect(typedRawFailure("m", untyped, "boom")).toBe(untyped);
    const inner = new Error("fetch failed");
    attachFailure(inner, { networkCode: "ECONNREFUSED" });
    const deadline = new RetryDeadlineError({ attempts: 1, elapsedMs: 1, lastStatus: undefined }, inner, undefined, false);
    expect(typedRawFailure("m", deadline, "fetch failed")).toBe(deadline);
    expect(typedRawFailure("m", "a string", "a string")).toBe("a string");
  });
});
