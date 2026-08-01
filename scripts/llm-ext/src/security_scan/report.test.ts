/**
 * Unit tests for security_scan/report.ts — the PURE aggregation + markdown
 * rendering helpers (slugify, isoTimestampLocal, resolveReportDir, aggregate,
 * renderMarkdown). No mocks of the unit under test: every test feeds real
 * finding/verdict objects and asserts on the real string/structure produced.
 *
 * Coverage notes: writeReport (FS side-effects) and the report-dir default
 * (resolveProjectMainRoot) are intentionally NOT exercised here — they are I/O,
 * not pure logic. resolveReportDir's explicit-output_dir branches ARE covered.
 */

import { describe, it, expect } from "vitest";
import {
  aggregate,
  isoTimestampLocal,
  renderMarkdown,
  resolveReportDir,
  slugify,
  type AggregateInput,
} from "./report.js";
import type { GroupVerdict } from "./judge.js";
import type { DedupGroup, SkippedRecord } from "./intake.js";
import type { SecurityScanItemResult, SecurityScanReport } from "./types.js";

// ── Fixtures: realistic verdict/group/item objects ───────────────────────

function mkGroup(over: Partial<DedupGroup> & Pick<DedupGroup, "key">): DedupGroup {
  return {
    key: over.key,
    category: over.category ?? "command-injection",
    content: over.content ?? "child_process.exec(userInput)",
    members: over.members ?? [
      { id: "finding#1", category: over.category ?? "command-injection", content: "x" },
    ],
    ...(over.file_path !== undefined ? { file_path: over.file_path } : {}),
    ...(over.line !== undefined ? { line: over.line } : {}),
  };
}

function mkVerdict(
  key: string,
  verdict: GroupVerdict["payload"]["verdict"],
  confidence: number,
  over: Partial<Omit<GroupVerdict, "key" | "payload">> = {},
): GroupVerdict {
  return {
    key,
    payload: {
      verdict,
      confidence,
      reason: over === undefined ? "" : "model reasoned about the flow",
      injection_observed: false,
    },
    injectionMarkers: over.injectionMarkers ?? [],
    failSafe: over.failSafe ?? false,
    costUsd: over.costUsd ?? 0.0001,
  };
}

function mkItem(over: Partial<SecurityScanItemResult>): SecurityScanItemResult {
  return {
    id: over.id ?? "id",
    category: over.category ?? "cat",
    verdict: over.verdict ?? "not_threat",
    confidence: over.confidence ?? 0.5,
    reason: over.reason ?? "reason",
    injection_observed: over.injection_observed ?? false,
    injection_markers: over.injection_markers ?? [],
    model: over.model ?? "qwen/qwen-2.5-7b-instruct",
    dedup_group: over.dedup_group ?? "k",
    fail_safe: over.fail_safe ?? false,
    ...(over.file_path !== undefined ? { file_path: over.file_path } : {}),
    ...(over.line !== undefined ? { line: over.line } : {}),
  };
}

function mkReport(items: SecurityScanItemResult[]): SecurityScanReport {
  const counts_by_verdict = { threat: 0, not_threat: 0, uncertain: 0 };
  const counts_by_category: Record<string, number> = {};
  for (const it of items) {
    counts_by_verdict[it.verdict]++;
    counts_by_category[it.category] = (counts_by_category[it.category] ?? 0) + 1;
  }
  return {
    job_id: "demo-job",
    model: "qwen/qwen-2.5-7b-instruct",
    generated_at: "2026-01-02T03:04:05.000Z",
    summary: {
      counts_by_verdict,
      counts_by_category,
      items_total: items.length,
      items_deduped: 0,
      items_skipped_too_big: 0,
      budget_usd_spent: 0.012345,
      items_skipped_over_budget: 0,
    },
    items,
  };
}

// ── slugify ──────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("replaces runs of illegal chars with a single dash and caps at 80 chars", () => {
    expect(slugify("registry #468 / weird name!!")).toBe("registry-468-weird-name-");
    const long = "a".repeat(120);
    expect(slugify(long)).toBe("a".repeat(80));
    // "" produces "" after replace -> the `|| "job"` fallback fires.
    expect(slugify("")).toBe("job");
  });

  it("preserves allowed [A-Za-z0-9._-] characters verbatim", () => {
    expect(slugify("My.Job_v1-2")).toBe("My.Job_v1-2");
  });
});

// ── isoTimestampLocal ──────────────────────────────────────────────────────

describe("isoTimestampLocal", () => {
  it("formats a fixed Date as compact YYYYMMDD_HHMMSS with a signed HHMM offset", () => {
    // Build a Date and derive the expected offset from THIS machine's tz so the
    // test is deterministic regardless of where it runs.
    const d = new Date(2026, 0, 2, 3, 4, 5); // 2026-01-02 03:04:05 local
    const stamp = isoTimestampLocal(d);
    expect(stamp).toMatch(/^20260102_030405[+-]\d{4}$/);

    const tzMin = -d.getTimezoneOffset();
    const sign = tzMin >= 0 ? "+" : "-";
    const abs = Math.abs(tzMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    expect(stamp).toBe(`20260102_030405${sign}${hh}${mm}`);
  });
});

// ── resolveReportDir ───────────────────────────────────────────────────────

describe("resolveReportDir", () => {
  it("uses an explicit absolute output_dir verbatim, else <mainRoot>/reports/security_scan", () => {
    expect(resolveReportDir("/abs/out", "/root")).toBe("/abs/out");
    expect(resolveReportDir(undefined, "/root")).toBe("/root/reports/security_scan");
    expect(resolveReportDir("", "/root")).toBe("/root/reports/security_scan");
  });
});

// ── aggregate ──────────────────────────────────────────────────────────────

describe("aggregate", () => {
  it("fans each group verdict out to every member id and tallies verdict + category counts", () => {
    const groups: DedupGroup[] = [
      mkGroup({
        key: "k1",
        category: "command-injection",
        members: [
          { id: "a", category: "command-injection", content: "c", file_path: "src/a.ts", line: 10 },
          { id: "b", category: "command-injection", content: "c" },
        ],
      }),
      mkGroup({ key: "k2", category: "path-traversal", members: [{ id: "c", category: "path-traversal", content: "d" }] }),
    ];
    const verdicts: GroupVerdict[] = [
      mkVerdict("k1", "threat", 0.9, { injectionMarkers: ["ignore-previous"] }),
      mkVerdict("k2", "not_threat", 0.2),
    ];
    const input: AggregateInput = {
      jobId: "j",
      model: "qwen/qwen-2.5-7b-instruct",
      groups,
      verdicts,
      skipped: [],
      recordsTotal: 3,
      budgetSpent: 0.005,
      itemsSkippedOverBudget: 0,
    };

    const report = aggregate(input);

    // 3 members across 2 groups -> 3 fanned items.
    expect(report.items).toHaveLength(3);
    expect(report.items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
    // k1's verdict fanned to both a and b.
    const a = report.items.find((i) => i.id === "a")!;
    expect(a.verdict).toBe("threat");
    expect(a.confidence).toBe(0.9);
    expect(a.injection_markers).toEqual(["ignore-previous"]);
    expect(a.dedup_group).toBe("k1");
    expect(a.file_path).toBe("src/a.ts");
    expect(a.line).toBe(10);
    // member b carried no file_path -> field absent.
    const b = report.items.find((i) => i.id === "b")!;
    expect(b.file_path).toBeUndefined();
    // Counts.
    expect(report.summary.counts_by_verdict).toEqual({ threat: 2, not_threat: 1, uncertain: 0 });
    expect(report.summary.counts_by_category).toEqual({ "command-injection": 2, "path-traversal": 1 });
    expect(report.summary.items_total).toBe(3);
    // recordsTotal(3) - groups(2) = 1 deduped.
    expect(report.summary.items_deduped).toBe(1);
    expect(report.summary.budget_usd_spent).toBe(0.005);
  });

  it("records skipped targets as uncertain+fail_safe rows and counts content-too-big skips", () => {
    const skipped: SkippedRecord[] = [
      { id: "big1", category: "secret", reason: "content 240000 bytes exceeds cap", file_path: "huge.ts" },
      { id: "glob0", category: "secret", reason: "glob matched no files" },
    ];
    const input: AggregateInput = {
      jobId: "j",
      model: "m",
      groups: [],
      verdicts: [],
      skipped,
      recordsTotal: 0,
      budgetSpent: 0,
      itemsSkippedOverBudget: 4,
    };

    const report = aggregate(input);

    expect(report.items).toHaveLength(2);
    for (const it of report.items) {
      expect(it.verdict).toBe("uncertain");
      expect(it.confidence).toBe(0);
      expect(it.fail_safe).toBe(true);
      expect(it.dedup_group).toBe("(skipped)");
      expect(it.reason).toContain("Skipped during intake:");
    }
    // Only the "content "-prefixed reason counts as too-big.
    expect(report.summary.items_skipped_too_big).toBe(1);
    expect(report.summary.counts_by_verdict.uncertain).toBe(2);
    // itemsSkippedOverBudget passes straight through.
    expect(report.summary.items_skipped_over_budget).toBe(4);
    // recordsTotal 0, groups 0 -> deduped clamps to 0 (never negative).
    expect(report.summary.items_deduped).toBe(0);
  });
});

// ── renderMarkdown ─────────────────────────────────────────────────────────

describe("renderMarkdown", () => {
  it("orders item rows threat→uncertain→not_threat then by confidence desc, with a full summary block", () => {
    const items = [
      mkItem({ id: "low-nt", verdict: "not_threat", confidence: 0.1, category: "x", reason: "benign" }),
      mkItem({ id: "hi-threat", verdict: "threat", confidence: 0.95, category: "x", reason: "exec of user input" }),
      mkItem({ id: "unc", verdict: "uncertain", confidence: 0.4, category: "y", reason: "off-window" }),
      mkItem({ id: "lo-threat", verdict: "threat", confidence: 0.6, category: "x", reason: "second threat" }),
    ];
    const md = renderMarkdown(mkReport(items));

    // Summary lines present and computed.
    expect(md).toContain("# Security-scan report — demo-job");
    expect(md).toContain("- Items total: 4");
    expect(md).toContain("- Budget spent: $0.012345");
    expect(md).toContain("| threat | 2 |");
    expect(md).toContain("| not_threat | 1 |");
    expect(md).toContain("| uncertain | 1 |");
    // Category counts sorted by count desc (x:3 before y:1).
    const xIdx = md.indexOf("| x | 3 |");
    const yIdx = md.indexOf("| y | 1 |");
    expect(xIdx).toBeGreaterThan(-1);
    expect(yIdx).toBeGreaterThan(xIdx);

    // Item-row ordering: threats first (by conf desc), then uncertain, then not_threat.
    const order = ["hi-threat", "lo-threat", "unc", "low-nt"].map((id) => md.indexOf(`| ${id} |`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Confidence is rendered with 2 decimals.
    expect(md).toContain("| hi-threat | x | threat | 0.95 |");
  });

  it("renders the zero-finding case with all-zero verdict counts and no data rows", () => {
    const md = renderMarkdown(mkReport([]));
    expect(md).toContain("- Items total: 0");
    expect(md).toContain("| threat | 0 |");
    expect(md).toContain("| not_threat | 0 |");
    expect(md).toContain("| uncertain | 0 |");
    // Items header is present but there are no data rows after the separator.
    const itemsSection = md.slice(md.indexOf("## Items"));
    const dataRows = itemsSection
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.includes("---") && !l.includes(" id "));
    expect(dataRows).toHaveLength(0);
  });

  it("escapes pipes and newlines inside table cells and surfaces injection markers", () => {
    const items = [
      mkItem({
        id: "pipe|id",
        category: "weird\ncat",
        verdict: "threat",
        confidence: 0.5,
        reason: "has a | pipe and\na newline",
        injection_observed: true,
        injection_markers: ["sys-tag", "ignore"],
      }),
      mkItem({
        id: "markers-only",
        verdict: "uncertain",
        confidence: 0.3,
        injection_observed: false,
        injection_markers: ["lone-marker"],
      }),
    ];
    const md = renderMarkdown(mkReport(items));

    // Pipe escaped to \| and newline collapsed to a space inside the cell.
    expect(md).toContain("| pipe\\|id | weird cat | threat |");
    expect(md).toContain("has a \\| pipe and a newline");
    // injection_observed -> "yes (markers...)".
    expect(md).toContain("yes (sys-tag,ignore)");
    // observed=false but markers present -> "markers: ...".
    expect(md).toContain("markers: lone-marker");
    // No literal newline ever leaks into a row (every line stays one row).
    for (const line of md.split("\n")) {
      expect(line.includes("\r")).toBe(false);
    }
  });
});
