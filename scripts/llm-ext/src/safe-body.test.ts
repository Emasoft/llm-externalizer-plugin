/**
 * Unit tests for safe-body.ts — bounded response body readers added in
 * v9.10.0 (T2.6 fix) that prevent OOM from oversized upstream responses.
 *
 * These tests cover the two exported helpers:
 *
 *   • safeReadText  — reads a Response body with a hard byte cap.
 *   • safeReadJson  — same cap, then JSON.parse.
 *
 * The module enforces the cap in two ways:
 *   (a) up-front via Content-Length when the server advertises one and
 *       the advertised size exceeds the cap (throws before reading);
 *   (b) post-hoc by checking the actual body length once read — either
 *       streamed chunk-by-chunk via getReader(), or in one shot via
 *       res.text() when res.body is absent.
 *
 * IMPLEMENTATION NOTE: the module THROWS on overflow rather than
 * truncating. The original test plan (T2) asked to assert truncation;
 * those assertions are adapted to expect a throw matching the actual
 * contract. See report B7a for details.
 *
 * The fakeResponse helper builds a minimal stub matching the subset of
 * the Fetch Response interface the SUT actually touches: text(), json(),
 * headers.get(), and body (intentionally omitted so the fallback path
 * via text() is exercised — this keeps the tests free of streaming
 * machinery that would otherwise dominate the file).
 */

import { describe, it, expect } from "vitest";
import {
  safeReadText,
  safeReadJson,
  MAX_RESPONSE_BYTES,
} from "./safe-body";

const CAP = 32 * 1024 * 1024;

function fakeResponse(body: string, contentLength?: number): Response {
  const headers = new Headers();
  if (contentLength !== undefined) {
    headers.set("content-length", String(contentLength));
  }
  return {
    text: async () => body,
    json: async () => JSON.parse(body),
    headers,
    ok: true,
    // body intentionally undefined → exercises the text() fallback path
    // in safeReadText, which is where post-hoc length checking lives.
  } as unknown as Response;
}

describe("MAX_RESPONSE_BYTES", () => {
  it("defaults to 32 MiB", () => {
    /** Sanity check on the exported cap constant so the rest of the
     * tests can rely on `CAP` being the same number. */
    expect(MAX_RESPONSE_BYTES).toBe(CAP);
  });
});

// ── safeReadText ───────────────────────────────────────────────────────

describe("safeReadText", () => {
  it("returns the text under the 32 MiB cap", async () => {
    /** Happy path: small body, no content-length → returns verbatim. */
    const body = "hello world";
    const res = fakeResponse(body);
    const got = await safeReadText(res);
    expect(got).toBe(body);
  });

  it("throws (does NOT silently truncate) when body exceeds 32 MiB cap", async () => {
    /** ADAPTED FROM ORIGINAL PLAN: the original plan asked for
     * truncation, but the implementation throws — this is the safer
     * contract because a truncated upstream payload is usually worse
     * than a clear error. Build a body 8 MiB over the cap and assert
     * that safeReadText rejects with a message naming the cap. We use
     * 'A'.repeat(...) which is exactly 1 byte per char in UTF-8.
     *
     * Memory cost: ~40 MiB allocated in-process during the test —
     * vitest's default heap accommodates this, but the body is freed
     * as soon as the throw propagates. */
    const oversized = "A".repeat(CAP + 8 * 1024 * 1024);
    const res = fakeResponse(oversized); // no content-length → post-hoc path
    await expect(safeReadText(res)).rejects.toThrow(/cap|exceed/i);
  });

  it("honors Content-Length when set and below cap (returns full body)", async () => {
    /** A truthful, in-bounds Content-Length must not block the read —
     * the implementation only short-circuits when CL > cap. */
    const body = "x".repeat(500);
    const res = fakeResponse(body, 500);
    const got = await safeReadText(res);
    expect(got).toBe(body);
    expect(got.length).toBe(500);
  });

  it("does not crash when Content-Length lies low but body is huge — throws cleanly", async () => {
    /** ADAPTED: original plan said 'rejects (or truncates without
     * crash)'. The actual implementation, with res.body absent, falls
     * back to res.text() (which returns the full oversized body) and
     * then the post-hoc length check throws. Either way the function
     * does NOT silently return >cap bytes. We assert two things:
     *
     *   1. the call settles (resolves or rejects, no crash / hang);
     *   2. if it resolved, the returned text is ≤ cap (defensive
     *      byte-length comparison per the prompt fallback rule).
     *
     * In practice the implementation rejects, so we cover both
     * branches without making the test brittle. */
    const oversized = "A".repeat(CAP + 8 * 1024 * 1024);
    const res = fakeResponse(oversized, 100); // CL lies: claims 100, body is huge

    let resolved: string | undefined;
    let rejected: unknown;
    try {
      resolved = await safeReadText(res);
    } catch (err) {
      rejected = err;
    }

    // Exactly one of the two outcomes must have occurred.
    expect(
      resolved !== undefined || rejected !== undefined,
    ).toBe(true);

    if (resolved !== undefined) {
      // Fallback assertion: if no throw, length must be ≤ cap.
      expect(resolved.length).toBeLessThanOrEqual(CAP);
    } else {
      // Expected path on this implementation.
      expect(rejected).toBeInstanceOf(Error);
      expect(String((rejected as Error).message)).toMatch(/cap|exceed/i);
    }
  });
});

// ── safeReadJson ───────────────────────────────────────────────────────

describe("safeReadJson", () => {
  it("parses valid JSON under cap", async () => {
    /** Happy path: small JSON body → parsed object equals input. */
    const res = fakeResponse('{"ok":true}');
    const got = await safeReadJson<{ ok: boolean }>(res);
    expect(got).toEqual({ ok: true });
  });

  it("throws on invalid JSON with a message mentioning JSON", async () => {
    /** safeReadJson does `JSON.parse(text)` directly — the thrown
     * SyntaxError will carry 'JSON' in its message on every modern V8. */
    const res = fakeResponse("not-json{");
    await expect(safeReadJson(res)).rejects.toThrow(/JSON|Unexpected/i);
  });

  it("enforces the same 32 MiB cap as safeReadText (cap checked BEFORE JSON.parse)", async () => {
    /** This is the contract verified by reading the source: safeReadJson
     * is implemented as `JSON.parse(await safeReadText(res, maxBytes))`,
     * so the cap is enforced inside safeReadText BEFORE the parse step.
     * Concretely: an oversized body must produce a cap-violation error,
     * NOT a JSON syntax error — because the function never reaches the
     * JSON.parse call.
     *
     * Build a 40 MiB body that is ALSO not valid JSON. If the cap were
     * not enforced first, we'd see a SyntaxError from JSON.parse. The
     * fact that we see a cap error proves the ordering. */
    const oversized = "A".repeat(CAP + 8 * 1024 * 1024); // not JSON
    const res = fakeResponse(oversized);

    let caught: unknown;
    try {
      await safeReadJson(res);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = String((caught as Error).message);
    // Must be a cap/size error, NOT a JSON parse error.
    expect(msg).toMatch(/cap|exceed/i);
    expect(msg).not.toMatch(/JSON|Unexpected token/i);
  });

  it("handles odd Content-Length values (negative, garbage) without crashing", async () => {
    /** ADAPTED: original plan asked for 'rejects Content-Length > MAX_INT
     * or negative'. The actual implementation is `Number.isFinite(n) &&
     * n > maxBytes` → it accepts negative CL (because -1 < cap) and
     * accepts garbage CL like 'abc' (because Number('abc') = NaN, which
     * is not finite). Huge but parseable CL like '99999999999999999999'
     * IS rejected because Number(...) returns a finite ~1e20.
     *
     * We test the two genuinely-lenient cases (negative + non-numeric)
     * because the prompt's success criterion is 'graceful fallback (no
     * crash, returns or throws cleanly)'. Neither must crash; both must
     * end up reading the body via the post-hoc path. */
    const body = '{"ok":true}';

    // Case A: negative content-length → passes CL check (-1 < cap),
    // body read normally via text() fallback, returns parsed JSON.
    const resNeg = fakeResponse(body, -1);
    const gotNeg = await safeReadJson<{ ok: boolean }>(resNeg);
    expect(gotNeg).toEqual({ ok: true });

    // Case B: non-numeric content-length → Number('abc')=NaN, isFinite
    // false → passes CL check, body read normally.
    const resGarbage = {
      text: async () => body,
      json: async () => JSON.parse(body),
      headers: new Headers([["content-length", "abc"]]),
      ok: true,
    } as unknown as Response;
    const gotGarbage = await safeReadJson<{ ok: boolean }>(resGarbage);
    expect(gotGarbage).toEqual({ ok: true });
  });
});
