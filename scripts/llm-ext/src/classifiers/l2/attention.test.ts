import { describe, expect, it } from "vitest";
import { ClassifierError, classifyHttpError, networkError, timeoutError, badResponseError } from "../l0/errors.js";
import { exitCodeForError, exitCodeForRun } from "./attention.js";

describe("exitCodeForRun", () => {
  it("is 0 for a clean run and for attention without --strict-exit", () => {
    expect(exitCodeForRun({ attention: false, strictExit: true })).toBe(0);
    expect(exitCodeForRun({ attention: false, strictExit: false })).toBe(0);
    expect(exitCodeForRun({ attention: true, strictExit: false })).toBe(0);
  });
  it("is 1 (llm-ext existing non-zero code, cli/main.ts) for attention under --strict-exit", () => {
    expect(exitCodeForRun({ attention: true, strictExit: true })).toBe(1);
  });
});

describe("exitCodeForError", () => {
  const h = new Headers();
  it("maps key and credit failures to 3 (qs mapping)", () => {
    expect(exitCodeForError(classifyHttpError(401, h, "{}"))).toBe(3);
    expect(exitCodeForError(classifyHttpError(402, h, "{}"))).toBe(3);
  });
  it("maps a rejected request to 4 (unknown model and bad request are HTTP 400, E)", () => {
    expect(exitCodeForError(classifyHttpError(400, h, "{}"))).toBe(4);
  });
  it("maps failures after retries (network, timeout, rate limit, server, bad reply) to 5", () => {
    expect(exitCodeForError(networkError(new Error("x")))).toBe(5);
    expect(exitCodeForError(timeoutError())).toBe(5);
    expect(exitCodeForError(badResponseError("x"))).toBe(5);
    expect(exitCodeForError(classifyHttpError(429, h, "{}"))).toBe(5);
    expect(exitCodeForError(classifyHttpError(503, h, "{}"))).toBe(5);
  });
  it("an in-flight budget 402 is retried by the transport, so reaching the exit means failed after retries: 5", () => {
    const e = classifyHttpError(402, h, JSON.stringify({ error: { message: "in-flight budget exceeded" } }));
    if (e.class === "in-flight-budget") expect(exitCodeForError(e)).toBe(5);
    expect(exitCodeForError(new ClassifierError({ class: "in-flight-budget", message: "x", retryable: true }))).toBe(5);
  });
});
