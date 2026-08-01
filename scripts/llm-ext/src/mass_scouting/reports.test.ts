/**
 * Unit tests for the mass-scouting reports module.
 *
 * Covers:
 *   • JsonlAppender — creates parent dir, appends one line per call,
 *     never truncates, valid JSON per line
 *   • summariseJob — aggregates per-field stats for bool/enum/string/int/array
 *     types; pulls scout-skipped entries; computes duration_ms
 *   • summariseJob — throws on missing job
 *   • renderMarkdownReport — emits run summary + per-field stats + skipped
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAppender, renderMarkdownReport, summariseJob } from "./reports";
import { openRegistry, type Registry } from "./registry";
import { parseFieldset, type ScoutFieldset } from "./fieldset";

// ── JsonlAppender ──────────────────────────────────────────────────────

describe("JsonlAppender", () => {
  let path: string;
  beforeEach(() => {
    path = join(
      tmpdir(),
      `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
  });
  afterEach(() => {
    if (existsSync(path)) rmSync(path);
  });

  it("creates the parent dir if missing and appends one line per event", () => {
    /** Append-only; each line is a JSON object terminated with \n. */
    const writer = new JsonlAppender(path);
    writer.append({ kind: "start", n: 1 });
    writer.append({ kind: "ok", n: 2 });
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ kind: "start", n: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ kind: "ok", n: 2 });
  });

  it("never truncates the existing file (append-only)", () => {
    /** A second JsonlAppender to the same path appends, doesn't replace. */
    new JsonlAppender(path).append({ a: 1 });
    new JsonlAppender(path).append({ a: 2 });
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("creates parent directory when it does not exist", () => {
    /** mkdir recursive — caller can pass a fresh sub-path. */
    const nested = join(
      tmpdir(),
      `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "nested",
      "evt.jsonl",
    );
    new JsonlAppender(nested).append({ ok: true });
    expect(existsSync(nested)).toBe(true);
    rmSync(nested);
  });

  it("exposes the file path for callers that want to log it", () => {
    /** The CLI needs to print the path to the user. */
    const writer = new JsonlAppender(path);
    expect(writer.filePath).toBe(path);
  });
});

// ── summariseJob ───────────────────────────────────────────────────────

describe("summariseJob", () => {
  let reg: Registry;
  beforeEach(() => {
    reg = openRegistry({ path: ":memory:" });
  });
  afterEach(() => {
    reg.close();
  });

  /** A fieldset that exercises every aggregation branch. */
  function richFieldset(): ScoutFieldset {
    return parseFieldset({
      version: 1,
      fieldset_name: "rich-test",
      fields: [
        {
          name: "is_async",
          description: "uses async / await",
          type: { kind: "bool" },
        },
        {
          name: "framework",
          description: "JS framework",
          type: { kind: "enum", values: ["react", "vue", "svelte", "none"] },
        },
        {
          name: "summary",
          description: "one-sentence summary",
          type: { kind: "string", max_length: 80 },
        },
        {
          name: "complexity",
          description: "1..10",
          type: { kind: "int", min: 1, max: 10 },
        },
        {
          name: "tags",
          description: "topic tags",
          type: { kind: "array_string", max_items: 4 },
        },
      ],
    });
  }

  /** Seed a job + N results into the registry. */
  function seedJob(
    jobId: string,
    rows: Record<string, unknown>[],
  ): void {
    const fs = richFieldset();
    reg.createJob({
      job_id: jobId,
      fieldset_name: fs.fieldset_name,
      fieldset_json: JSON.stringify(fs),
      json_schema: JSON.stringify({ type: "object" }),
      model: "qwen/qwen-2.5-7b-instruct",
      workers: 4,
      source_root: "/tmp/r",
    });
    rows.forEach((row, i) => {
      const reg_out = reg.registerFile({
        file_path: `/tmp/r/f${i}.ts`,
        source_root: "/tmp/r",
        body: Buffer.from(`row-${i}`),
        registered_via: "folder",
      });
      reg.insertResult({
        job_id: jobId,
        file_fingerprint: reg_out.fingerprint,
        short_id: reg_out.short_id,
        result_json: JSON.stringify(row),
        searchable_text: "",
      });
    });
    // Mark the job ended so duration_ms is non-null.
    reg.finalizeJob(jobId, {
      files_total: rows.length,
      files_ok: rows.length,
      files_failed: 0,
      retries: 0,
      cost_usd: 0.0001,
    });
  }

  it("aggregates bool / enum / string / int / array_string per field", () => {
    /** Six rows, mixed values, span every aggregation branch. */
    seedJob("agg-1", [
      {
        is_async: true,
        framework: "react",
        summary: "x",
        complexity: 3,
        tags: ["a", "b"],
      },
      {
        is_async: true,
        framework: "react",
        summary: "y",
        complexity: 5,
        tags: ["a", "c"],
      },
      {
        is_async: false,
        framework: "vue",
        summary: "y",
        complexity: 8,
        tags: ["a"],
      },
    ]);
    const s = summariseJob(reg, "agg-1");

    // is_async: 2 true, 1 false
    const ia = s.per_field["is_async"]!;
    expect(ia.type).toBe("bool");
    expect(ia.total).toBe(3);
    const trueCount = ia.by_value!.find((b) => b.value === "true")!.count;
    const falseCount = ia.by_value!.find((b) => b.value === "false")!.count;
    expect(trueCount).toBe(2);
    expect(falseCount).toBe(1);

    // framework: 2 react, 1 vue (sorted desc)
    const fw = s.per_field["framework"]!;
    expect(fw.type).toBe("enum");
    expect(fw.by_value![0]!.value).toBe("react");
    expect(fw.by_value![0]!.count).toBe(2);

    // summary: 2 "y", 1 "x"
    const sm = s.per_field["summary"]!;
    expect(sm.type).toBe("string");
    expect(sm.by_value![0]!.value).toBe("y");
    expect(sm.by_value![0]!.count).toBe(2);

    // complexity: min 3, max 8, avg ≈ 5.33
    const c = s.per_field["complexity"]!;
    expect(c.type).toBe("int");
    expect(c.numeric!.min).toBe(3);
    expect(c.numeric!.max).toBe(8);
    expect(c.numeric!.avg).toBeCloseTo((3 + 5 + 8) / 3, 4);

    // tags: 'a' appears 3×, 'b' once, 'c' once
    const t = s.per_field["tags"]!;
    expect(t.type).toBe("array_string");
    expect(t.top_items!.find((x) => x.value === "a")!.count).toBe(3);
    expect(t.top_items!.find((x) => x.value === "b")!.count).toBe(1);
  });

  it("computes duration_ms when ended_at is set", () => {
    /** finalizeJob writes ended_at = now(); summary should compute Δ. */
    seedJob("dur-1", [
      { is_async: true, framework: "none", summary: "x", complexity: 1, tags: [] },
    ]);
    const s = summariseJob(reg, "dur-1");
    expect(s.duration_ms).not.toBeNull();
    expect(s.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns null duration_ms when the job never ended", () => {
    /** Aborted runs leave ended_at null — summary tolerates that. */
    const fs = richFieldset();
    reg.createJob({
      job_id: "aborted-1",
      fieldset_name: fs.fieldset_name,
      fieldset_json: JSON.stringify(fs),
      json_schema: JSON.stringify({ type: "object" }),
      model: "qwen",
      workers: 1,
      source_root: "/tmp",
    });
    const s = summariseJob(reg, "aborted-1");
    expect(s.duration_ms).toBeNull();
  });

  it("includes the first 50 scout-skipped entries", () => {
    /** Skipped section in the markdown report comes from listSkipped('scout'). */
    seedJob("sk-1", []);
    for (let i = 0; i < 60; i++) {
      reg.recordSkipped({
        file_path: `/tmp/skip-${i}.bin`,
        reason: "too big",
        phase: "scout",
        size_bytes: 100_000 + i,
      });
    }
    const s = summariseJob(reg, "sk-1");
    expect(s.skipped.length).toBe(50); // capped
    expect(s.skipped[0]!.reason).toBe("too big");
  });

  it("throws on unknown jobId", () => {
    /** Defensive: callers must distinguish missing-job from empty-job. */
    expect(() => summariseJob(reg, "nope")).toThrow(/no job with id/i);
  });
});

// ── renderMarkdownReport ───────────────────────────────────────────────

describe("renderMarkdownReport", () => {
  it("emits run summary + per-field stats + skipped sections", () => {
    /** The rendered string must contain every documented section header. */
    const md = renderMarkdownReport({
      jobId: "md-1",
      fieldset_name: "test",
      model: "qwen/qwen-2.5-7b-instruct",
      source_root: "/tmp/x",
      files_total: 2,
      files_ok: 1,
      files_failed: 1,
      retries: 1,
      cost_usd: 0.0123,
      duration_ms: 1500,
      per_field: {
        framework: {
          type: "enum",
          total: 2,
          by_value: [
            { value: "react", count: 2 },
            { value: "vue", count: 0 },
          ],
        },
        complexity: {
          type: "int",
          total: 2,
          numeric: { min: 1, max: 8, avg: 4.5 },
        },
      },
      skipped: [{ file_path: "/tmp/x/big.bin", reason: "too big" }],
    });
    expect(md).toContain("# Mass-scouting report");
    expect(md).toContain("## Run summary");
    expect(md).toContain("## Per-field stats");
    expect(md).toContain("## Skipped files");
    expect(md).toContain("`/tmp/x/big.bin`");
    expect(md).toMatch(/Cost.*\$0\.012300/);
    expect(md).toMatch(/Duration.*1\.5s/);
    expect(md).toMatch(/min.*1.*max.*8/);
  });

  it("escapes pipes inside table cells", () => {
    /** A field value with `|` would break markdown tables — escape to &#124;. */
    const md = renderMarkdownReport({
      jobId: "esc-1",
      fieldset_name: "x",
      model: "x",
      source_root: "/x",
      files_total: 1,
      files_ok: 1,
      files_failed: 0,
      retries: 0,
      cost_usd: 0,
      duration_ms: null,
      per_field: {
        summary: {
          type: "string",
          total: 1,
          by_value: [{ value: "a|b", count: 1 }],
        },
      },
      skipped: [],
    });
    expect(md).toContain("a&#124;b");
    expect(md).not.toContain("| a|b |");
  });

  it("omits the Skipped section when there are no skipped files", () => {
    /** Don't dump empty section headers in the report. */
    const md = renderMarkdownReport({
      jobId: "no-skip",
      fieldset_name: "x",
      model: "x",
      source_root: "/x",
      files_total: 0,
      files_ok: 0,
      files_failed: 0,
      retries: 0,
      cost_usd: 0,
      duration_ms: null,
      per_field: {},
      skipped: [],
    });
    expect(md).not.toContain("## Skipped files");
  });
});
