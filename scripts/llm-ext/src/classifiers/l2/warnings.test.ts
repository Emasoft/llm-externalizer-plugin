import { describe, expect, it } from "vitest";
import { buildEnvelope } from "./envelope.js";
import { degrade, warning } from "./warnings.js";

describe("warning", () => {
  it("builds a record with a stable code and message, and a count only when given", () => {
    expect(warning("secret_redacted", "2 secrets redacted", 2)).toEqual({ code: "secret_redacted", message: "2 secrets redacted", count: 2 });
    expect(warning("invalid_utf8", "replaced")).toEqual({ code: "invalid_utf8", message: "replaced" });
  });
  it("refuses an empty code or message", () => {
    expect(() => warning("", "x")).toThrow();
    expect(() => warning("x", "")).toThrow();
  });
});

describe("degrade", () => {
  it("returns the degraded record with its fallback field AND the warning that reports it (D1, E96)", () => {
    const { degraded, warning: w } = degrade({ where: "search field q", reason: "typing model failed", fallback: "keyword query" });
    expect(degraded).toEqual({ where: "search field q", reason: "typing model failed", fallback: "keyword query" });
    expect(w.code).toBe("degraded");
    expect(w.message).toContain("keyword query");
  });
  it("refuses a missing fallback: a degraded record must say what replaced the normal path", () => {
    expect(() => degrade({ where: "a", reason: "b", fallback: "" })).toThrow();
  });
});

describe("envelope uses the same records", () => {
  it("carries warning and degraded records as built by the constructors", () => {
    const d = degrade({ where: "w", reason: "r", fallback: "f" });
    const env = buildEnvelope({ decision: null, replies: [], warnings: [d.warning], degraded: [d.degraded], stopped: null });
    expect(env.warnings).toEqual([d.warning]);
    expect(env.degraded).toEqual([d.degraded]);
  });
});
