/**
 * Report generation for a finished mass-scouting job. Two surfaces:
 *
 *   • `JsonlAppender` — append-only telemetry sink. One JSON object per line.
 *     Used by the scout layer for per-file events (start/end/repair/error).
 *   • `summariseJob` + `renderMarkdownReport` — read the registry, aggregate
 *     per-field stats, and emit the human-readable `.md` deliverable that
 *     ends up under `<repo-root>/reports/mass_scouting/`.
 *
 * Token-frugality: aggregates are computed in TypeScript over rows the
 * registry already gives us. We never re-parse the body cache here.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ScoutFieldset, FieldType } from "./fieldset";
import type { Registry } from "./registry";

// ── JSONL telemetry ────────────────────────────────────────────────────

/**
 * Append-only JSONL writer. Every call writes one line, fsyncs not enforced
 * (caller is OK with a tail-of-file loss on hard kill — the per-file
 * registry rows are the source of truth, JSONL is a debug breadcrumb).
 *
 * The writer is *append only* — it never truncates. Re-running a job with
 * the same JSONL path appends new events to the existing file.
 */
export class JsonlAppender {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event: Record<string, unknown>): void {
    appendFileSync(this.path, JSON.stringify(event) + "\n", "utf-8");
  }

  /** Path to the file (handy for callers that want to log the location). */
  get filePath(): string {
    return this.path;
  }
}

// ── Job summary types ──────────────────────────────────────────────────

export interface NumericStats {
  min: number;
  max: number;
  avg: number;
}

export interface FieldStats {
  /** The DSL `kind` of the field (bool, string, enum, etc.). */
  type: string;
  /** Count of result rows that had a non-null value for this field. */
  total: number;
  /**
   * For bool / enum / array_enum: counts per distinct value, sorted desc.
   * For string fields: counts per distinct string (cap top 25 to keep the
   *   markdown report readable for high-cardinality fields).
   */
  by_value?: { value: string; count: number }[];
  /** For int / number fields: min/max/avg across non-null rows. */
  numeric?: NumericStats;
  /** For array fields: per-item counts across the union. */
  top_items?: { value: string; count: number }[];
}

export interface JobSummary {
  jobId: string;
  fieldset_name: string;
  /** The model the job REQUESTED. Under free-mode rotation it may not be the only
   *  one that answered — see `models_used`. */
  model: string;
  /** Present ONLY when free-mode rotation moved off `model` mid-job: every free
   *  model that actually produced a result, in first-use order. Absent on a normal
   *  run, so its presence is itself the signal that rotation happened. */
  models_used?: string[];
  source_root: string;
  files_total: number;
  files_ok: number;
  files_failed: number;
  retries: number;
  cost_usd: number;
  duration_ms: number | null;
  per_field: Record<string, FieldStats>;
  /** First N failures (path + last error) for the report's "Skipped" section. */
  skipped: { file_path: string; reason: string }[];
}

// ── Aggregation helpers ────────────────────────────────────────────────

/**
 * Tally string-valued field counts. `cap` limits the output (top N by count).
 */
function tallyValues(
  values: string[],
  cap = 25,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, cap);
}

function tallyBool(values: boolean[]): { value: string; count: number }[] {
  let t = 0;
  let f = 0;
  for (const v of values) {
    if (v) t++;
    else f++;
  }
  return [
    { value: "true", count: t },
    { value: "false", count: f },
  ];
}

function tallyNumeric(values: number[]): NumericStats | undefined {
  if (values.length === 0) return undefined;
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

function aggregateField(
  fieldName: string,
  fieldType: FieldType,
  rowsParsed: Record<string, unknown>[],
): FieldStats {
  const values: unknown[] = [];
  for (const r of rowsParsed) {
    const v = r[fieldName];
    if (v != null) values.push(v);
  }
  switch (fieldType.kind) {
    case "bool": {
      const bools = values.filter((v): v is boolean => typeof v === "boolean");
      return {
        type: "bool",
        total: bools.length,
        by_value: tallyBool(bools),
      };
    }
    case "string": {
      const strs = values.filter((v): v is string => typeof v === "string");
      return {
        type: "string",
        total: strs.length,
        by_value: tallyValues(strs),
      };
    }
    case "enum": {
      const strs = values.filter((v): v is string => typeof v === "string");
      return {
        type: "enum",
        total: strs.length,
        by_value: tallyValues(strs, fieldType.values.length),
      };
    }
    case "array_string":
    case "array_enum": {
      const flat: string[] = [];
      for (const v of values) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === "string") flat.push(item);
          }
        }
      }
      return {
        type: fieldType.kind,
        total: values.length,
        top_items: tallyValues(flat),
      };
    }
    case "int":
    case "number": {
      const nums = values.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v),
      );
      return {
        type: fieldType.kind,
        total: nums.length,
        numeric: tallyNumeric(nums),
      };
    }
    default: {
      // Defensive — every kind above is exhaustive at compile time, but a
      // future fieldset version could add new kinds.
      return { type: "unknown", total: values.length };
    }
  }
}

// ── Public: summarise + render ─────────────────────────────────────────

export function summariseJob(reg: Registry, jobId: string): JobSummary {
  const job = reg.getJob(jobId);
  if (!job) {
    throw new Error(`summariseJob: no job with id ${JSON.stringify(jobId)}`);
  }
  const results = reg.listResultsByJob(jobId);
  const fieldset = JSON.parse(job.fieldset_json) as ScoutFieldset;

  // Parse every result_json once — reused across every field aggregation.
  const parsed: Record<string, unknown>[] = results.map((r) => {
    try {
      return JSON.parse(r.result_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  });

  const perField: Record<string, FieldStats> = {};
  for (const f of fieldset.fields) {
    perField[f.name] = aggregateField(f.name, f.type, parsed);
  }

  let durationMs: number | null = null;
  if (job.ended_at) {
    durationMs =
      new Date(job.ended_at).getTime() - new Date(job.started_at).getTime();
  }

  const skipped = reg
    .listSkipped("scout")
    .map((s) => ({ file_path: s.file_path, reason: s.reason }))
    .slice(0, 50);

  return {
    jobId,
    fieldset_name: job.fieldset_name,
    model: job.model,
    source_root: job.source_root,
    files_total: job.files_total ?? 0,
    files_ok: job.files_ok ?? 0,
    files_failed: job.files_failed ?? 0,
    retries: job.retries ?? 0,
    cost_usd: job.cost_usd ?? 0,
    duration_ms: durationMs,
    per_field: perField,
    skipped,
  };
}

export function renderMarkdownReport(s: JobSummary): string {
  const lines: string[] = [];
  lines.push(`# Mass-scouting report — \`${s.jobId}\``);
  lines.push("");
  lines.push("## Run summary");
  lines.push("");
  lines.push(`- **Fieldset:** \`${s.fieldset_name}\``);
  lines.push(`- **Model:** \`${s.model}\``);
  if (s.models_used && s.models_used.length > 0) {
    lines.push(
      `- **Models actually used (free-model rotation on rate-limit):** ${s.models_used.map((m) => `\`${m}\``).join(", ")}`,
    );
  }
  lines.push(`- **Source root:** \`${s.source_root}\``);
  lines.push(
    `- **Files:** ${s.files_total} total / **${s.files_ok}** ok / **${s.files_failed}** failed`,
  );
  lines.push(`- **Retries:** ${s.retries}`);
  lines.push(`- **Cost:** $${s.cost_usd.toFixed(6)}`);
  if (s.duration_ms != null) {
    lines.push(`- **Duration:** ${(s.duration_ms / 1000).toFixed(1)}s`);
  }
  lines.push("");

  lines.push("## Per-field stats");
  lines.push("");
  for (const [name, stats] of Object.entries(s.per_field)) {
    lines.push(`### \`${name}\` _(${stats.type}, n=${stats.total})_`);
    lines.push("");
    if (stats.by_value && stats.by_value.length > 0) {
      lines.push("| Value | Count |");
      lines.push("|---|---:|");
      for (const v of stats.by_value) {
        lines.push(`| \`${escapePipe(v.value)}\` | ${v.count} |`);
      }
      lines.push("");
    }
    if (stats.numeric) {
      lines.push(
        `min: **${stats.numeric.min}** · max: **${stats.numeric.max}** · avg: **${stats.numeric.avg.toFixed(2)}**`,
      );
      lines.push("");
    }
    if (stats.top_items && stats.top_items.length > 0) {
      lines.push("Top items:");
      for (const v of stats.top_items.slice(0, 10)) {
        lines.push(`- \`${escapePipe(v.value)}\` _(×${v.count})_`);
      }
      lines.push("");
    }
  }

  if (s.skipped.length > 0) {
    lines.push("## Skipped files");
    lines.push("");
    for (const sk of s.skipped) {
      lines.push(`- \`${sk.file_path}\` — ${sk.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Pipes inside markdown table cells break formatting — escape with HTML. */
function escapePipe(v: string): string {
  return v.replace(/\|/g, "&#124;");
}
