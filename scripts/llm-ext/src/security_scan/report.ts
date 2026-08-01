/**
 * Report — fan group verdicts back out to per-id results, aggregate the
 * summary, render JSON + markdown, and write both to disk. The tool itself
 * returns ONLY the paths + a one-line counter (TRDD §4); all detail lives in
 * these two files.
 *
 * The timestamp / slug / report-dir helpers are re-implemented locally (no
 * mass_scouting import) and honor the agent-reports-location rule: local time
 * + GMT offset, under <main-root>/reports/security_scan/ unless output_dir is
 * given.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveProjectMainRoot } from "../project-root";

import type { GroupVerdict } from "./judge";
import type { DedupGroup, SkippedRecord } from "./intake";
import {
  VERDICTS,
  type SecurityScanItemResult,
  type SecurityScanReport,
  type SecurityScanSummary,
  type Verdict,
} from "./types";

// ── Path helpers (local, agent-reports-location compliant) ───────────────

function defaultMainRoot(): string {
  // Single source of truth — see project-root.ts.
  return resolveProjectMainRoot();
}

/** Resolve the report directory. Explicit output_dir wins; else <root>/reports/security_scan/. */
export function resolveReportDir(
  outputDir: string | undefined,
  mainRoot?: string,
): string {
  if (outputDir && outputDir.length > 0) {
    return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
  }
  return join(mainRoot ?? defaultMainRoot(), "reports", "security_scan");
}

/** Local-time + GMT-offset compact stamp: YYYYMMDD_HHMMSS±HHMM. */
export function isoTimestampLocal(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const tzMin = -now.getTimezoneOffset();
  const tzSign = tzMin >= 0 ? "+" : "-";
  const tzAbs = Math.abs(tzMin);
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `${tzSign}${pad(Math.floor(tzAbs / 60))}${pad(tzAbs % 60)}`
  );
}

export function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "job";
}

// ── Aggregation ──────────────────────────────────────────────────────────

export interface AggregateInput {
  jobId: string;
  model: string;
  groups: DedupGroup[];
  verdicts: GroupVerdict[];
  skipped: SkippedRecord[];
  recordsTotal: number;
  budgetSpent: number;
  /** Items refused because the whole-job budget gate failed. */
  itemsSkippedOverBudget: number;
  /**
   * Every free model that ACTUALLY answered during this run, when free-mode
   * rotation was in play (the requested model included). Omitted/singleton on a
   * normal run. Reported so the artifact cannot claim one model judged findings
   * that a rotated-to model actually judged.
   */
  modelsUsed?: string[];
}

/**
 * Fan each group's verdict out to every member id, build per-item rows, and
 * compute the summary. `groups[i]` is paired with `verdicts[i]` by index
 * (judgeGroups preserves order).
 */
export function aggregate(input: AggregateInput): SecurityScanReport {
  const items: SecurityScanItemResult[] = [];
  const verdictByKey = new Map<string, GroupVerdict>();
  for (const v of input.verdicts) verdictByKey.set(v.key, v);

  for (const g of input.groups) {
    const gv = verdictByKey.get(g.key);
    if (!gv) continue; // unreachable — every group has a verdict.
    for (const m of g.members) {
      const item: SecurityScanItemResult = {
        id: m.id,
        category: m.category,
        verdict: gv.payload.verdict,
        confidence: gv.payload.confidence,
        reason: gv.payload.reason,
        injection_observed: gv.payload.injection_observed,
        injection_markers: gv.injectionMarkers,
        model: input.model,
        dedup_group: g.key,
        // F9: carry the per-group fail-safe flag through to every fanned item.
        fail_safe: gv.failSafe,
      };
      if (m.file_path !== undefined) item.file_path = m.file_path;
      if (m.line !== undefined) item.line = m.line;
      items.push(item);
    }
  }

  // Skipped items are reported too, as uncertain rows with the skip reason, so
  // the caller never silently loses a finding.
  for (const s of input.skipped) {
    const item: SecurityScanItemResult = {
      id: s.id,
      category: s.category,
      verdict: "uncertain",
      confidence: 0,
      reason: `Skipped during intake: ${s.reason}`,
      injection_observed: false,
      injection_markers: [],
      model: input.model,
      dedup_group: "(skipped)",
      // F9: a skipped item was never judged → fail-safe by definition.
      fail_safe: true,
    };
    if (s.file_path !== undefined) item.file_path = s.file_path;
    items.push(item);
  }

  const counts_by_verdict: Record<Verdict, number> = {
    threat: 0,
    not_threat: 0,
    uncertain: 0,
  };
  const counts_by_category: Record<string, number> = {};
  for (const it of items) {
    counts_by_verdict[it.verdict]++;
    counts_by_category[it.category] = (counts_by_category[it.category] ?? 0) + 1;
  }

  const summary: SecurityScanSummary = {
    counts_by_verdict,
    counts_by_category,
    items_total: items.length,
    items_deduped: Math.max(0, input.recordsTotal - input.groups.length),
    items_skipped_too_big: input.skipped.filter((s) =>
      s.reason.startsWith("content "),
    ).length,
    budget_usd_spent: input.budgetSpent,
    items_skipped_over_budget: input.itemsSkippedOverBudget,
  };

  const report: SecurityScanReport = {
    job_id: input.jobId,
    model: input.model,
    generated_at: new Date().toISOString(),
    summary,
    items,
  };
  // Only when rotation actually moved off the requested model — otherwise the
  // extra field would be noise on every normal run.
  const used = input.modelsUsed ?? [];
  if (used.length > 1 || (used.length === 1 && used[0] !== input.model)) {
    report.models_used = used;
  }
  return report;
}

// ── Markdown render ──────────────────────────────────────────────────────

export function renderMarkdown(report: SecurityScanReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Security-scan report — ${report.job_id}`, "");
  lines.push(`- Model: \`${report.model}\``);
  if (report.models_used && report.models_used.length > 0) {
    // Free-mode rotation moved off the requested model mid-run. Say so, and name
    // every model that actually produced a verdict.
    lines.push(
      `- Models actually used (free-model rotation on rate-limit): ${report.models_used.map((m) => `\`${m}\``).join(", ")}`,
    );
  }
  lines.push(`- Generated: ${report.generated_at}`);
  lines.push(`- Items total: ${s.items_total}`);
  lines.push(`- Deduped (judged once, fanned out): ${s.items_deduped}`);
  lines.push(`- Skipped (too big): ${s.items_skipped_too_big}`);
  lines.push(`- Skipped (over budget): ${s.items_skipped_over_budget}`);
  lines.push(`- Budget spent: $${s.budget_usd_spent.toFixed(6)}`);
  lines.push("");
  lines.push("## Counts by verdict", "");
  lines.push("| Verdict | Count |", "| --- | --- |");
  for (const v of VERDICTS) {
    lines.push(`| ${v} | ${s.counts_by_verdict[v]} |`);
  }
  lines.push("");
  lines.push("## Counts by category", "");
  lines.push("| Category | Count |", "| --- | --- |");
  for (const [c, n] of Object.entries(s.counts_by_category).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${mdCell(c)} | ${n} |`);
  }
  lines.push("");
  lines.push("## Items", "");
  lines.push(
    "| id | category | verdict | conf | injection | reason |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  // Threats first, then uncertain, then not_threat — most actionable on top.
  const order: Record<Verdict, number> = {
    threat: 0,
    uncertain: 1,
    not_threat: 2,
  };
  const sorted = [...report.items].sort(
    (a, b) => order[a.verdict] - order[b.verdict] || b.confidence - a.confidence,
  );
  for (const it of sorted) {
    const inj = it.injection_observed
      ? `yes${it.injection_markers.length > 0 ? ` (${it.injection_markers.join(",")})` : ""}`
      : it.injection_markers.length > 0
        ? `markers: ${it.injection_markers.join(",")}`
        : "no";
    lines.push(
      `| ${mdCell(it.id)} | ${mdCell(it.category)} | ${it.verdict} | ${it.confidence.toFixed(2)} | ${mdCell(inj)} | ${mdCell(it.reason)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Escape a value for a single markdown table cell (no pipe/newline breakage). */
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 400);
}

// ── Write ────────────────────────────────────────────────────────────────

export interface WrittenReport {
  jsonPath: string;
  mdPath: string;
}

/**
 * Write the JSON + markdown report to `reportDir`, returning both paths.
 * Filenames: <stamp>-security-scan-<job>.{json,md}.
 */
export function writeReport(
  report: SecurityScanReport,
  reportDir: string,
): WrittenReport {
  mkdirSync(reportDir, { recursive: true });
  const stamp = isoTimestampLocal();
  const base = `${stamp}-security-scan-${slugify(report.job_id)}`;
  const jsonPath = join(reportDir, `${base}.json`);
  const mdPath = join(reportDir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  writeFileSync(mdPath, renderMarkdown(report), "utf-8");
  return { jsonPath, mdPath };
}
