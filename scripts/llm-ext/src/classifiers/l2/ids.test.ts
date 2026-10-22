import { describe, expect, it } from "vitest";
import { IdError, checkItemIds, indexKey } from "./ids.js";

describe("checkItemIds (D14)", () => {
  it("accepts unique ids of 1 to 64 characters from [A-Za-z0-9_-]", () => {
    expect(() => checkItemIds(["a", "B-2", "snake_case", "x".repeat(64), "0"])).not.toThrow();
  });
  it("accepts an empty list", () => {
    expect(() => checkItemIds([])).not.toThrow();
  });
  it("E50: refuses a duplicate id and names it", () => {
    expect(() => checkItemIds(["a", "b", "a"])).toThrow(IdError);
    expect(() => checkItemIds(["a", "b", "a"])).toThrow(/duplicate.*"a"/);
  });
  it("E50: ids differing only in case are distinct", () => {
    expect(() => checkItemIds(["a", "A"])).not.toThrow();
  });
  it("E51: refuses invalid characters and names the id", () => {
    for (const bad of ["a b", "a.b", "é", "a/b", "a\n", "a:b"]) {
      expect(() => checkItemIds(["ok", bad])).toThrow(IdError);
      expect(() => checkItemIds(["ok", bad])).toThrow(/invalid/);
    }
    expect(() => checkItemIds(["ok", "a b"])).toThrow(/"a b"/);
  });
  it("E51: refuses an empty id and an id of 65 characters", () => {
    expect(() => checkItemIds([""])).toThrow(IdError);
    expect(() => checkItemIds(["x".repeat(65)])).toThrow(IdError);
  });
  it("refuses a non-string id", () => {
    expect(() => checkItemIds([1 as unknown as string])).toThrow(IdError);
  });
  it("names a very long invalid id truncated, not whole", () => {
    try {
      checkItemIds(["é".repeat(500)]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(200);
    }
  });
  it("reports the first problem in input order", () => {
    expect(() => checkItemIds(["a b", "a", "a"])).toThrow(/invalid/);
  });
});

describe("indexKey (D14)", () => {
  it("builds the key from the index only", () => {
    expect(indexKey("label", 0)).toBe("label_i0");
    expect(indexKey("p", 12)).toBe("p_i12");
  });
  it("refuses a negative, fractional or non-finite index and an empty prefix", () => {
    expect(() => indexKey("p", -1)).toThrow(RangeError);
    expect(() => indexKey("p", 1.5)).toThrow(RangeError);
    expect(() => indexKey("p", Number.NaN)).toThrow(RangeError);
    expect(() => indexKey("", 0)).toThrow(RangeError);
  });
  it("refuses a prefix that is not a plain key stem", () => {
    expect(() => indexKey("a b", 0)).toThrow(RangeError);
  });
});
