import { describe, expect, it } from "vitest";
import { brokerTokenMatches } from "./protocol.js";

describe("brokerTokenMatches", () => {
  const expected = Buffer.from("a".repeat(48));

  // A missing header is rejected.
  it("rejects an undefined header", () => {
    expect(brokerTokenMatches(undefined, expected)).toBe(false);
  });

  // A repeated header arrives as an array and is rejected, never coerced.
  it("rejects an array-valued header", () => {
    expect(brokerTokenMatches(["a".repeat(48)], expected)).toBe(false);
  });

  // A different length is rejected without timingSafeEqual throwing.
  it("rejects a token of a different length", () => {
    expect(brokerTokenMatches("a".repeat(47), expected)).toBe(false);
  });

  // Same length, one differing character is rejected.
  it("rejects a same-length token with one character different", () => {
    expect(brokerTokenMatches("a".repeat(47) + "b", expected)).toBe(false);
  });

  // The exact token is accepted.
  it("accepts the exact token", () => {
    expect(brokerTokenMatches("a".repeat(48), expected)).toBe(true);
  });
});
