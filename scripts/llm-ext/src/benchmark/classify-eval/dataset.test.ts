// EV-01: classify-eval dataset loader and fingerprint, against real files in a /tmp directory (no network).
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDataset } from "./dataset.js";

const dir = mkdtempSync(join(tmpdir(), "llm-ext-ev01-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const good = { id: "a", input: { claims: [{ text: "x" }], evidence: [{ text: "y" }] }, expected: "supported" };
const write = (rows: unknown[], name = "verify"): void => writeFileSync(join(dir, `${name}.jsonl`), rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");

describe("classify-eval dataset", () => {
  it("loads one jsonl file per spec", () => {
    write([good, { ...good, id: "b" }]);
    const d = loadDataset(dir, "verify");
    expect(d.specId).toBe("verify");
    expect(d.records.map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("fingerprint is stable for equal bytes and changes with any edit", () => {
    write([good]);
    const f1 = loadDataset(dir, "verify").fingerprint;
    expect(loadDataset(dir, "verify").fingerprint).toBe(f1);
    expect(f1).toMatch(/^[0-9a-f]{12}$/);
    write([{ ...good, expected: "refuted" }]);
    expect(loadDataset(dir, "verify").fingerprint).not.toBe(f1);
  });
  it("fingerprint ignores line-ending style, a trailing newline and blank lines, but not a changed record", () => {
    const l1 = JSON.stringify(good), l2 = JSON.stringify({ ...good, id: "b" });
    const fp = (text: string): string => { writeFileSync(join(dir, "verify.jsonl"), text); return loadDataset(dir, "verify").fingerprint; };
    const lf = fp(`${l1}\n${l2}\n`);
    expect(fp(`${l1}\r\n${l2}\r\n`)).toBe(lf);
    expect(fp(`${l1}\n\n  \n${l2}`)).toBe(lf);
    expect(fp(`${l1}\n${JSON.stringify({ ...good, id: "c" })}\n`)).not.toBe(lf);
  });
  it("accepts a null expected label (no match) but still requires the key", () => {
    write([{ ...good, expected: null }]);
    expect(loadDataset(dir, "verify").records[0].expected).toBeNull();
  });
  it.each([
    ["invalid JSON", ["{nope"], /:1: not valid JSON/],
    ["non-object line", ["[1]"], /record must be a JSON object/],
    ["unknown field", [{ ...good, extra: 1 }], /unknown field "extra"/],
    ["missing id", [{ ...good, id: "" }], /id must be a non-empty string/],
    ["duplicate id", [good, good], /:2: duplicate id "a"/],
    ["missing expected", [{ id: "a", input: good.input }], /expected is required/],
    ["input the spec rejects", [{ ...good, input: { claims: [] } }], /input rejected by spec "verify"/],
    ["empty file", [], /no records/],
  ])("refuses %s", (_n, rows, re) => {
    write(rows as unknown[]);
    expect(() => loadDataset(dir, "verify")).toThrow(re);
  });
  it("refuses an unregistered spec", () => {
    expect(() => loadDataset(dir, "nope")).toThrow(/unknown decision spec "nope"/);
  });
});
