// ── New-arrivals autodiscovery (A4, TRDD-828238b5) ─────────────────────
//
// Persist a snapshot of every model id seen in the OpenRouter catalog, and on
// each run report the ids that newly appeared since the last snapshot — each
// assessed against every per-tool requirements gate (registry, TRDD-f45eeaa0)
// so the operator can see, at a glance, which new models are worth adopting.
//
// FREE — the OpenRouter model catalog is public (no API key, no LLM call).
// REPORT-ONLY — never writes settings. Acting on a new arrival is user-only
// (edit settings.yaml + reset; vet first with /assess-model + the tool's
// benchmark). First run seeds the snapshot and reports zero arrivals (every id
// is trivially "new"), mirroring check_model_health's baseline seeding.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir } from "../config.js";
import { fetchProgrammingModels, type OpenRouterModel } from "../benchmark/discover.js";
import { assessModelAcrossTools } from "./assess.js";
import { localIsoTimestamp } from "../usage-history.js";
import { resolveProjectMainRoot } from "../project-root.js";
import { compactStamp } from "./drift.js";

// ── Shapes ─────────────────────────────────────────────────────────────

export interface SnapshotEntry {
  /** OpenRouter model creation epoch (seconds), or null when absent. */
  created: number | null;
}

export interface CatalogSnapshot {
  /** When this snapshot was last written (ISO local + offset). */
  generatedAt: string;
  /** Every catalog model id we have seen → its created epoch. */
  models: Record<string, SnapshotEntry>;
}

export interface NewArrival {
  id: string;
  name: string;
  /** OpenRouter creation epoch (seconds), or null. */
  created: number | null;
  /** ISO-8601 (UTC) rendering of `created`, or null. */
  createdIso: string | null;
  /** Tools whose hard requirements this model meets. */
  qualifiedCount: number;
  totalTools: number;
  /** True iff qualifiedCount > 0. */
  qualifiesForAnyTool: boolean;
  /** Qualified tools that ALSO carry a benchmark gate (run before assigning). */
  benchmarkGatedQualified: string[];
}

export interface NewArrivalsReport {
  generatedAt: string;
  /** True on the first run (no prior snapshot) — arrivals suppressed, snapshot seeded. */
  snapshotSeeded: boolean;
  /** Number of models in the live catalog. */
  catalogSize: number;
  arrivals: NewArrival[];
  summary: { total: number; qualifying: number };
}

// ── Pure core ──────────────────────────────────────────────────────────

/** ISO-8601 (UTC) rendering of an OpenRouter `created` epoch (seconds), or null. */
export function createdToIso(created: number | null): string | null {
  if (created === null || !Number.isFinite(created) || created <= 0) return null;
  return new Date(created * 1000).toISOString();
}

/**
 * Pure diff: every model in `catalog` whose id is ABSENT from `snapshot.models`
 * is a new arrival, assessed across all tool requirements. Also returns the
 * refreshed snapshot (every current id → its created epoch). Arrivals sort
 * newest-first by `created` (nulls last, then by id for a stable order).
 *
 * Seeding (empty prior snapshot ⇒ suppress the list) is the CALLER's call —
 * this function always returns the raw diff so it stays pure and testable.
 */
export function diffNewArrivals(
  catalog: readonly OpenRouterModel[],
  snapshot: CatalogSnapshot,
): { arrivals: NewArrival[]; updatedSnapshot: CatalogSnapshot } {
  const known = snapshot.models;
  const arrivals: NewArrival[] = [];
  const updatedModels: Record<string, SnapshotEntry> = {};
  for (const m of catalog) {
    const created =
      typeof m.created === "number" && Number.isFinite(m.created) ? m.created : null;
    updatedModels[m.id] = { created };
    if (!(m.id in known)) {
      const a = assessModelAcrossTools(m);
      arrivals.push({
        id: m.id,
        name: m.name ?? m.id,
        created,
        createdIso: createdToIso(created),
        qualifiedCount: a.qualifiedCount,
        totalTools: a.totalTools,
        qualifiesForAnyTool: a.qualifiedCount > 0,
        benchmarkGatedQualified: a.benchmarkGatedQualified,
      });
    }
  }
  arrivals.sort((x, y) => {
    if (x.created !== null && y.created !== null) {
      if (y.created !== x.created) return y.created - x.created; // newest first
    } else if (x.created !== null) {
      return -1; // dated before undated
    } else if (y.created !== null) {
      return 1;
    }
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; // stable by id
  });
  return {
    arrivals,
    updatedSnapshot: { generatedAt: localIsoTimestamp(), models: updatedModels },
  };
}

// ── Snapshot persistence (best-effort, atomic) ─────────────────────────

/** Absolute path of the catalog snapshot. Honors LLM_EXT_CONFIG_DIR via getConfigDir(). */
export function getCatalogSnapshotPath(): string {
  return join(getConfigDir(), "catalog-snapshot.json");
}

/** Load the snapshot (best-effort: empty when missing/corrupt). */
export function loadSnapshot(path: string = getCatalogSnapshotPath()): CatalogSnapshot {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Partial<CatalogSnapshot>;
      if (obj.models && typeof obj.models === "object" && !Array.isArray(obj.models)) {
        return {
          generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
          models: obj.models as Record<string, SnapshotEntry>,
        };
      }
    }
    return { generatedAt: "", models: {} };
  } catch {
    return { generatedAt: "", models: {} };
  }
}

/** Persist the snapshot atomically (tmp + rename). Best-effort; never throws. */
export function saveSnapshot(
  snapshot: CatalogSnapshot,
  path: string = getCatalogSnapshotPath(),
): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, path);
  } catch {
    // best-effort; a failed snapshot write must not break the discovery run.
  }
}

// ── IO orchestrator ────────────────────────────────────────────────────

export interface DiscoverNewArrivalsOptions {
  /** Catalog fetcher override (tests inject; default hits OpenRouter, no auth). */
  fetchModels?: () => Promise<OpenRouterModel[]>;
  /** Snapshot path override (tests point this at a tmp file). */
  snapshotPath?: string;
  /** When false, do not persist the refreshed snapshot. Default true. */
  persistSnapshot?: boolean;
  /** Only report arrivals that qualify for ≥1 tool. Default false (report all). */
  qualifyingOnly?: boolean;
}

/**
 * Fetch the live catalog, diff against the on-disk snapshot, persist the
 * refreshed snapshot, and return the report. Seeds (and suppresses arrivals) on
 * the first run when no prior snapshot exists.
 */
export async function discoverNewArrivals(
  opts: DiscoverNewArrivalsOptions = {},
): Promise<NewArrivalsReport> {
  const fetchModels = opts.fetchModels ?? (() => fetchProgrammingModels());
  const snapshotPath = opts.snapshotPath ?? getCatalogSnapshotPath();
  const persist = opts.persistSnapshot !== false;

  const catalog = await fetchModels();
  const prior = loadSnapshot(snapshotPath);
  const seeded = Object.keys(prior.models).length === 0;

  const { arrivals, updatedSnapshot } = diffNewArrivals(catalog, prior);
  if (persist) saveSnapshot(updatedSnapshot, snapshotPath);

  // First run: every id is trivially "new" — suppress the meaningless full list.
  const reported = seeded
    ? []
    : opts.qualifyingOnly
      ? arrivals.filter((a) => a.qualifiesForAnyTool)
      : arrivals;

  return {
    generatedAt: localIsoTimestamp(),
    snapshotSeeded: seeded,
    catalogSize: catalog.length,
    arrivals: reported,
    summary: {
      total: reported.length,
      qualifying: reported.filter((a) => a.qualifiesForAnyTool).length,
    },
  };
}

// ── Renderers ──────────────────────────────────────────────────────────

/** Render the report as a Markdown document (for the report file). */
export function renderNewArrivalsMarkdown(report: NewArrivalsReport): string {
  const lines: string[] = [];
  lines.push("# New OpenRouter model arrivals");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Catalog size: ${report.catalogSize} models`);
  if (report.snapshotSeeded) {
    lines.push("");
    lines.push(
      "> First run — seeded the catalog snapshot; new-arrival detection starts next run.",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(
    `**${report.summary.total} new model(s)** since the last snapshot · ` +
      `${report.summary.qualifying} qualify for ≥1 tool.`,
  );
  lines.push("");
  if (report.arrivals.length === 0) {
    lines.push("_No new models since the last snapshot._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Model | Created | Qualifies | Benchmark-gated |");
  lines.push("|-------|---------|-----------|-----------------|");
  for (const a of report.arrivals) {
    const created = a.createdIso ? a.createdIso.slice(0, 10) : "—";
    const qual = a.qualifiesForAnyTool ? `${a.qualifiedCount}/${a.totalTools}` : "no";
    const gated = a.benchmarkGatedQualified.length
      ? a.benchmarkGatedQualified.join(", ")
      : "—";
    lines.push(`| \`${a.id}\` | ${created} | ${qual} | ${gated} |`);
  }
  lines.push("");
  lines.push(
    "Acting on an arrival is user-only: vet it with `/llm-externalizer-assess-model` " +
      "(and the tool's benchmark for benchmark-gated tools), then edit " +
      "`~/.llm-externalizer/settings.yaml` and `reset`.",
  );
  lines.push("");
  return lines.join("\n");
}

/** Max arrivals shown in the compact text surface before truncating. */
export const TEXT_ARRIVALS_CAP = 25;

/** Render the report as an aligned, human-readable block (capped). */
export function renderNewArrivalsText(report: NewArrivalsReport): string {
  const lines: string[] = [];
  lines.push(`New model arrivals — ${report.generatedAt}`);
  if (report.snapshotSeeded) {
    lines.push(
      `Catalog size: ${report.catalogSize}. First run — seeded the snapshot; ` +
        "detection starts next run.",
    );
    return lines.join("\n");
  }
  lines.push(
    `${report.summary.total} new since last snapshot (${report.summary.qualifying} ` +
      `qualify for ≥1 tool); catalog size ${report.catalogSize}.`,
  );
  const shown = report.arrivals.slice(0, TEXT_ARRIVALS_CAP);
  for (const a of shown) {
    const created = a.createdIso ? a.createdIso.slice(0, 10) : "????-??-??";
    const qual = a.qualifiesForAnyTool ? `qualifies ${a.qualifiedCount}/${a.totalTools}` : "no fit";
    const gated = a.benchmarkGatedQualified.length
      ? ` (benchmark: ${a.benchmarkGatedQualified.join(", ")})`
      : "";
    lines.push(`  ${created}  ${a.id}  — ${qual}${gated}`);
  }
  if (report.arrivals.length > shown.length) {
    lines.push(`  … and ${report.arrivals.length - shown.length} more (see the report).`);
  }
  return lines.join("\n");
}

// ── Top-level orchestrator (3 surfaces) ────────────────────────────────

export interface RunDiscoverNewArrivalsOptions extends DiscoverNewArrivalsOptions {
  /** Report output dir override. Default <main-project-dir>/reports/model-arrivals/. */
  outputDir?: string;
}

/**
 * Resolve, run, and persist a Markdown report under reports/model-arrivals/.
 * Returns both the report and the file path. Advisory only — never writes settings.
 */
export async function runDiscoverNewArrivals(
  opts: RunDiscoverNewArrivalsOptions = {},
): Promise<{ report: NewArrivalsReport; reportPath: string }> {
  const report = await discoverNewArrivals(opts);
  const dir = opts.outputDir ?? join(resolveProjectMainRoot(), "reports", "model-arrivals");
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${compactStamp()}-new-arrivals.md`);
  writeFileSync(reportPath, renderNewArrivalsMarkdown(report));
  return { report, reportPath };
}
