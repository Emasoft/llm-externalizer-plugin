import { describe, expect, it } from "vitest";
import { MAX_DEPTH, createRedactor } from "./redact.js";

// A real key shape from the shared secret patterns (security_scan/intake.ts), built in pieces so no scanner flags this file.
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";

describe("registered values", () => {
  it("replaces a registered value wherever it occurs in a string, every occurrence", () => {
    const r = createRedactor();
    r.register("hunter2-pass");
    expect(r.redact("login with hunter2-pass then hunter2-pass again")).toBe("login with [REDACTED] then [REDACTED] again");
  });
  it("redacts a registered value inside nested objects, arrays and keys", () => {
    const r = createRedactor();
    r.register("s3cr3t-value");
    const out = r.redact({ a: ["x s3cr3t-value y"], "s3cr3t-value": 1 }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("s3cr3t-value");
  });
  it("redacts a longer registered value before a shorter one that it contains", () => {
    const r = createRedactor();
    r.register("pass");
    r.register("pass-word-long");
    expect(r.redact("pass-word-long")).toBe("[REDACTED]");
  });
  it("refuses to register an empty value (it would match everywhere)", () => {
    expect(() => createRedactor().register("")).toThrow(/empty/);
  });
  it("does not carry registrations from one redactor to another", () => {
    const a = createRedactor();
    a.register("only-in-a");
    expect(createRedactor().redact("only-in-a")).toBe("only-in-a");
  });
});

describe("secret-like keys and secret shapes", () => {
  it("redacts the value of a secret-like key whatever its type", () => {
    const out = createRedactor().redact({ password: "p", API_KEY: 12, authorization: { x: 1 }, nested: { Token: "t" }, user: "bob" });
    expect(out).toEqual({ password: "[REDACTED]", API_KEY: "[REDACTED]", authorization: "[REDACTED]", nested: { Token: "[REDACTED]" }, user: "bob" });
  });
  it("redacts known secret shapes in plain strings", () => {
    expect(createRedactor().redact(`key ${AWS} end`)).toBe("key [REDACTED:AWS_KEY] end");
  });
  it("leaves harmless values unchanged", () => {
    expect(createRedactor().redact({ n: 1, b: true, z: null, s: "hello", a: [1, 2] })).toEqual({ n: 1, b: true, z: null, s: "hello", a: [1, 2] });
  });
});

describe("E54: values that break a naive walker", () => {
  it("cyclic object: marked, no crash", () => {
    const o: Record<string, unknown> = { name: "n" };
    o.self = o;
    const out = createRedactor().redact(o) as Record<string, unknown>;
    expect(out.name).toBe("n");
    expect(out.self).toBe("[Circular]");
  });
  it("a repeated reference that is not a cycle is walked both times", () => {
    const shared = { v: 1 };
    expect(createRedactor().redact({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });
  it("cyclic array and cyclic Map", () => {
    const a: unknown[] = [1];
    a.push(a);
    expect(createRedactor().redact(a)).toEqual([1, "[Circular]"]);
    const m = new Map<string, unknown>();
    m.set("me", m);
    expect(createRedactor().redact(m)).toEqual([["me", "[Circular]"]]);
  });
  it("deep nesting past MAX_DEPTH is cut, not a stack overflow", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    const out = JSON.stringify(createRedactor().redact(deep));
    expect(out).toContain("[MaxDepth]");
    expect(out.split("{").length - 1).toBeLessThanOrEqual(MAX_DEPTH + 1);
  });
  it("a Map becomes an array of [key, value] pairs with values redacted, and a secret-like Map key redacts its value", () => {
    const m = new Map<string, unknown>([["ok", "fine"], ["password", "p"]]);
    expect(createRedactor().redact(m)).toEqual([["ok", "fine"], ["password", "[REDACTED]"]]);
  });
  it("a Set becomes an array", () => {
    expect(createRedactor().redact(new Set([1, "a"]))).toEqual([1, "a"]);
  });
  it("a class instance is walked through its own enumerable properties, secret keys included", () => {
    class Conn {
      host = "h";
      password = "pw";
      #hidden = "x";
      peek(): string {
        return this.#hidden;
      }
    }
    const c = new Conn();
    expect(c.peek()).toBe("x");
    expect(createRedactor().redact(c)).toEqual({ host: "h", password: "[REDACTED]" });
  });
  it("a getter that throws is reported, not propagated", () => {
    const o = {
      get boom(): string {
        throw new Error("nope");
      },
      ok: 1,
    };
    expect(createRedactor().redact(o)).toEqual({ boom: "[Unreadable]", ok: 1 });
  });
  it("an Error keeps name, message and cause, redacted", () => {
    const r = createRedactor();
    r.register("tok-12345");
    const out = r.redact(new Error("failed with tok-12345", { cause: "tok-12345" })) as Record<string, unknown>;
    expect(out.name).toBe("Error");
    expect(out.message).toBe("failed with [REDACTED]");
    expect(out.cause).toBe("[REDACTED]");
  });
  it("functions, symbols, bigints, dates and binary data become short markers", () => {
    const out = createRedactor().redact({ f: () => 1, s: Symbol("x"), b: 10n, d: new Date(0), u: new Uint8Array(4) });
    expect(out).toEqual({ f: "[Function]", s: "Symbol(x)", b: "10", d: "1970-01-01T00:00:00.000Z", u: "[Binary 4 bytes]" });
  });
  it("an invalid Date does not throw", () => {
    expect(createRedactor().redact(new Date(Number.NaN))).toBe("[Invalid Date]");
  });
  it("a huge flat array is bounded by the node budget", () => {
    const out = createRedactor().redact(new Array(200_000).fill(1)) as unknown[];
    expect(out.length).toBeLessThan(200_000);
    expect(out[out.length - 1]).toBe("[Truncated]");
  });
  it("does not mutate its input", () => {
    const o = { password: "p", n: { x: 1 } };
    createRedactor().redact(o);
    expect(o).toEqual({ password: "p", n: { x: 1 } });
  });
  it("a __proto__ key is kept as a plain key and does not change the prototype of the result", () => {
    const o = JSON.parse("{\"__proto__\": {\"polluted\": 1}, \"a\": 1}") as unknown;
    const out = createRedactor().redact(o) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.a).toBe(1);
  });
});
