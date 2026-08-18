/**
 * Unit tests for the shared response gate (TRDD-P4ULUV1R) — the non-empty +
 * non-echo verdict every surface applies before accepting a model response.
 * Pure — no network, no process spawn.
 */

import { describe, it, expect } from "vitest";
import {
  ECHO_MIN_RESPONSE_LENGTH,
  gateFailureMessage,
  gateLLMResponse,
  isEchoResponse,
} from "./response-gate.js";

const SOURCE =
  "Task: review this file\n\n" +
  "function add(a, b) { return a + b; }\n" +
  "const result = add(1, 2); // the answer is three, computed at module load\n";

describe("gateLLMResponse", () => {
  it("rejects an empty response as 'empty'", () => {
    expect(gateLLMResponse("", SOURCE)).toBe("empty");
    expect(gateLLMResponse("   \n\t ", SOURCE)).toBe("empty");
  });

  it("rejects a whole-response echo of the input as 'echo'", () => {
    const echoed =
      "const result = add(1, 2); // the answer is three, computed at module load";
    expect(gateLLMResponse(echoed, SOURCE)).toBe("echo");
  });

  it("accepts a real answer that quotes a short fragment of the input", () => {
    const answer =
      "The function `add(a, b)` is correct; the comment on the result line is " +
      "stale wording but harmless. No defects found.";
    expect(gateLLMResponse(answer, SOURCE)).toBeNull();
  });

  it("accepts a short generic reply below the echo floor even if it appears in the source", () => {
    const short = "the answer is three";
    expect(short.length).toBeLessThan(ECHO_MIN_RESPONSE_LENGTH);
    expect(gateLLMResponse(short, SOURCE)).toBeNull();
  });

  it("normalizes whitespace and case before the echo comparison", () => {
    const echoed =
      "CONST RESULT = ADD(1, 2);   // the answer is three,\n computed at module load";
    expect(isEchoResponse(echoed, SOURCE)).toBe(true);
  });
});

describe("gateFailureMessage", () => {
  it("names each verdict distinctly", () => {
    expect(gateFailureMessage("empty")).toMatch(/empty/i);
    expect(gateFailureMessage("echo")).toMatch(/echo/i);
    expect(gateFailureMessage("empty")).not.toBe(gateFailureMessage("echo"));
  });
});
