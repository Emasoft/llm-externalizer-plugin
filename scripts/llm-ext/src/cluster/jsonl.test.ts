// Unit tests for jsonl.ts — streaming reader + validator + writer.
// No network, no LLM calls. All paths exercised against tmp fixtures.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { asClusterItem, readClusterJsonl, streamJsonl, writeJsonl } from "./jsonl.js";

describe("jsonl", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cluster-jsonl-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("asClusterItem", () => {
    it("accepts canonical {id, sentence}", () => {
      const r = asClusterItem({ id: "x", sentence: "hello" });
      expect("item" in r).toBe(true);
      if ("item" in r) {
        expect(r.item).toEqual({ id: "x", sentence: "hello" });
      }
    });

    it("accepts legacy {id, label} and normalises to sentence", () => {
      const r = asClusterItem({ id: "x", label: "domain/programming/" });
      expect("item" in r).toBe(true);
      if ("item" in r) expect(r.item.sentence).toBe("domain/programming/");
    });

    it("prefers `sentence` over `label` when both present", () => {
      const r = asClusterItem({ id: "x", sentence: "A", label: "B" });
      expect("item" in r).toBe(true);
      if ("item" in r) expect(r.item.sentence).toBe("A");
    });

    it("attaches optional context when provided", () => {
      const r = asClusterItem({ id: "x", sentence: "y", context: "ctx" });
      expect("item" in r).toBe(true);
      if ("item" in r) expect(r.item.context).toBe("ctx");
    });

    it("rejects missing id", () => {
      const r = asClusterItem({ sentence: "y" });
      expect("reason" in r).toBe(true);
    });
    it("rejects empty id", () => {
      const r = asClusterItem({ id: "", sentence: "y" });
      expect("reason" in r).toBe(true);
    });
    it("rejects missing sentence/label", () => {
      const r = asClusterItem({ id: "x" });
      expect("reason" in r).toBe(true);
    });
    it("rejects non-object", () => {
      expect("reason" in asClusterItem(null)).toBe(true);
      expect("reason" in asClusterItem("string")).toBe(true);
      expect("reason" in asClusterItem(42)).toBe(true);
    });
  });

  describe("streamJsonl", () => {
    it("yields one outcome per line, skipping blank lines silently", async () => {
      const p = join(dir, "in.jsonl");
      writeFileSync(p, `{"id":"a","sentence":"x"}\n\n{"id":"b","sentence":"y"}\n`);
      const outs: Array<{ ok: boolean; lineNo: number }> = [];
      for await (const o of streamJsonl(p)) outs.push({ ok: o.ok, lineNo: o.lineNo });
      expect(outs).toHaveLength(2);
      expect(outs[0]).toEqual({ ok: true, lineNo: 1 });
      expect(outs[1]).toEqual({ ok: true, lineNo: 3 });
    });

    it("yields a parse-failure outcome on bad JSON without aborting", async () => {
      const p = join(dir, "in.jsonl");
      writeFileSync(p, `{"id":"a","sentence":"x"}\n{not json\n{"id":"b","sentence":"y"}\n`);
      const okIds: string[] = [];
      const errLines: number[] = [];
      for await (const o of streamJsonl(p)) {
        if (o.ok) okIds.push((o.value as { id: string }).id);
        else errLines.push(o.lineNo);
      }
      expect(okIds).toEqual(["a", "b"]);
      expect(errLines).toEqual([2]);
    });
  });

  describe("readClusterJsonl", () => {
    it("returns clean items + empty warnings for a good file", async () => {
      const p = join(dir, "good.jsonl");
      writeFileSync(p, `{"id":"a","sentence":"x"}\n{"id":"b","sentence":"y","context":"c"}\n`);
      const r = await readClusterJsonl(p);
      expect(r.items).toEqual([
        { id: "a", sentence: "x" },
        { id: "b", sentence: "y", context: "c" },
      ]);
      expect(r.warnings).toEqual([]);
    });

    it("flags duplicate ids in warnings but keeps both lines", async () => {
      const p = join(dir, "dup.jsonl");
      writeFileSync(p, `{"id":"a","sentence":"x"}\n{"id":"a","sentence":"y"}\n`);
      const r = await readClusterJsonl(p);
      expect(r.items).toHaveLength(2);
      expect(r.warnings.some((w) => w.includes("duplicate id 'a'"))).toBe(true);
    });

    it("collects parse + schema failures as warnings", async () => {
      const p = join(dir, "mixed.jsonl");
      writeFileSync(
        p,
        `{"id":"a","sentence":"x"}\n{bad json\n{"id":"","sentence":"y"}\n{"id":"c"}\n`,
      );
      const r = await readClusterJsonl(p);
      expect(r.items).toHaveLength(1);
      expect(r.warnings).toHaveLength(3);
    });
  });

  describe("writeJsonl", () => {
    it("writes one line per object atomically (via tmp rename)", async () => {
      const p = join(dir, "out.jsonl");
      await writeJsonl(p, [
        { id: "a", sentence: "x" },
        { id: "b", sentence: "y" },
      ]);
      expect(existsSync(p)).toBe(true);
      const lines = readFileSync(p, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ id: "a", sentence: "x" });
      expect(JSON.parse(lines[1])).toEqual({ id: "b", sentence: "y" });
    });
  });
});
