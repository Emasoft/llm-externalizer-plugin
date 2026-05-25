/**
 * `check_model_health` — self-check for the CONFIGURED model(s) (TRDD-828238b5 A2).
 *
 * Answers the three questions the user keeps asking by hand:
 *   1. Presence  — is each configured model id still in the OpenRouter catalog,
 *                  or has it been deprecated/removed (a call would 404/400)?
 *   2. Cost drift — has the live price moved since we last looked, vs a seeded
 *                  baseline snapshot at getConfigDir()/model-baseline.json?
 *   3. Requirements regression — does the model still meet the hard requirements
 *                  of every tool it serves (qualifyModelForTool)?
 *
 * It is FREE (no LLM call, no token cost): one public catalog fetch + a JSON
 * diff. Advisory only — it emits a report and returns a path; the server never
 * silently swaps a model (read-only by design). The pure core
 * (`buildConfiguredModels` + `computeModelHealth`) takes plain data and is fully
 * unit-testable; `checkModelHealth` is the thin IO orchestrator with injectable
 * catalog fetch + baseline path for tests.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir, loadSettings, resolveProfile, type ResolvedProfile } from "../config.js";
import {
  fetchProgrammingModels,
  type OpenRouterModel,
} from "../benchmark/discover.js";
import { qualifyModelForTool, registeredTools } from "./registry.js";
import { localIsoTimestamp } from "../usage-history.js";
import { resolveProjectMainRoot } from "../project-root.js";

/** A configured model and the tools whose requirements it must satisfy. */
export interface ConfiguredModel {
  /** Model id (e.g. "google/gemini-2.5-flash"). */
  model: string;
  /** Config slots that reference it (e.g. ["model", "tool_models.security_scan"]). */
  roles: string[];
  /** Registered tools this model actually serves (requirements apply to these). */
  servedTools: string[];
}

/** Captured price snapshot for one model, in $/million tokens. */
export interface BaselineEntry {
  inputPerM: number;
  outputPerM: number;
  capturedAt: string;
}

/** model id -> captured baseline. Persisted at getConfigDir()/model-baseline.json. */
export type ModelBaseline = Record<string, BaselineEntry>;

export type DriftSeverity = "ok" | "warn" | "critical";

export interface ModelDriftFinding {
  model: string;
  roles: string[];
  /** In the live catalog? false ⇒ deprecated/removed ⇒ critical. */
  present: boolean;
  baselineInputPerM: number | null;
  currentInputPerM: number | null;
  baselineOutputPerM: number | null;
  currentOutputPerM: number | null;
  costChanged: boolean;
  /** Served tools whose requirements the model now FAILS (regression). */
  requirementsRegressions: { tool: string; reason: string }[];
  severity: DriftSeverity;
  notes: string[];
}

export interface ModelHealthReport {
  generatedAt: string;
  profile: string;
  /** True when this run had no prior baseline and seeded a fresh one. */
  baselineSeeded: boolean;
  findings: ModelDriftFinding[];
  summary: { total: number; ok: number; warn: number; critical: number };
}

export interface ComputeOptions {
  /** Relative price increase that flags a cost-drift warning. Default 0.05 (5%). */
  costIncreaseWarnFraction?: number;
}

/** Parse an OpenRouter per-token price string to $/million tokens (null on bad input). */
export function perMillion(s: string | undefined): number | null {
  if (s == null) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return n * 1_000_000;
}

/**
 * Build the configured-model set from a resolved profile. PURE. The main `model`
 * (and ensemble second/third) serve every registered tool that has no explicit
 * tool_models override; each `tool_models[tool]` serves exactly that tool. A
 * model referenced by several slots is merged into one entry (roles + servedTools
 * unioned).
 */
export function buildConfiguredModels(
  profile: Pick<ResolvedProfile, "model" | "secondModel" | "thirdModel" | "toolModels">,
  allTools: readonly string[] = registeredTools(),
): ConfiguredModel[] {
  const byModel = new Map<string, ConfiguredModel>();
  const ensure = (model: string): ConfiguredModel => {
    let c = byModel.get(model);
    if (!c) {
      c = { model, roles: [], servedTools: [] };
      byModel.set(model, c);
    }
    return c;
  };
  const addServed = (c: ConfiguredModel, tool: string): void => {
    if (!c.servedTools.includes(tool)) c.servedTools.push(tool);
  };

  const overriddenTools = new Set(Object.keys(profile.toolModels ?? {}));
  const defaultTools = allTools.filter((t) => !overriddenTools.has(t));

  // Default + ensemble members serve every non-overridden tool.
  for (const [slot, id] of [
    ["model", profile.model],
    ["second_model", profile.secondModel],
    ["third_model", profile.thirdModel],
  ] as const) {
    if (!id) continue;
    const c = ensure(id);
    if (!c.roles.includes(slot)) c.roles.push(slot);
    for (const t of defaultTools) addServed(c, t);
  }

  // Per-tool overrides serve exactly their tool.
  for (const [tool, id] of Object.entries(profile.toolModels ?? {})) {
    if (!id) continue;
    const c = ensure(id);
    const role = `tool_models.${tool}`;
    if (!c.roles.includes(role)) c.roles.push(role);
    addServed(c, tool);
  }

  return [...byModel.values()];
}

/**
 * Compute per-model health from configured models + a live catalog + a baseline.
 * PURE — no IO, no clock. Returns the findings plus an UPDATED baseline that
 * captures the current price of every present model (the caller persists it).
 */
export function computeModelHealth(
  configured: readonly ConfiguredModel[],
  catalog: readonly OpenRouterModel[],
  baseline: ModelBaseline,
  opts: ComputeOptions = {},
): { findings: ModelDriftFinding[]; updatedBaseline: ModelBaseline } {
  const warnFraction = opts.costIncreaseWarnFraction ?? 0.05;
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const updatedBaseline: ModelBaseline = { ...baseline };
  const findings: ModelDriftFinding[] = [];

  for (const cfg of configured) {
    const live = byId.get(cfg.model);
    const notes: string[] = [];
    let severity: DriftSeverity = "ok";

    if (!live) {
      findings.push({
        model: cfg.model,
        roles: cfg.roles,
        present: false,
        baselineInputPerM: baseline[cfg.model]?.inputPerM ?? null,
        currentInputPerM: null,
        baselineOutputPerM: baseline[cfg.model]?.outputPerM ?? null,
        currentOutputPerM: null,
        costChanged: false,
        requirementsRegressions: [],
        severity: "critical",
        notes: [
          "NOT in the OpenRouter catalog — deprecated/removed. Calls will fail; pick a replacement.",
        ],
      });
      continue;
    }

    const curIn = perMillion(live.pricing?.prompt);
    const curOut = perMillion(live.pricing?.completion);
    const base = baseline[cfg.model];
    let costChanged = false;
    if (base && curIn != null && base.inputPerM > 0) {
      const delta = (curIn - base.inputPerM) / base.inputPerM;
      if (delta > warnFraction) {
        costChanged = true;
        severity = "warn";
        notes.push(
          `input price up ${(delta * 100).toFixed(1)}% ($${base.inputPerM.toFixed(3)}→$${curIn.toFixed(3)}/M)`,
        );
      } else if (delta < -warnFraction) {
        notes.push(
          `input price down ${(Math.abs(delta) * 100).toFixed(1)}% ($${base.inputPerM.toFixed(3)}→$${curIn.toFixed(3)}/M)`,
        );
      }
    }
    if (base && curOut != null && base.outputPerM > 0) {
      const delta = (curOut - base.outputPerM) / base.outputPerM;
      if (delta > warnFraction) {
        costChanged = true;
        severity = "warn";
        notes.push(
          `output price up ${(delta * 100).toFixed(1)}% ($${base.outputPerM.toFixed(3)}→$${curOut.toFixed(3)}/M)`,
        );
      } else if (delta < -warnFraction) {
        notes.push(
          `output price down ${(Math.abs(delta) * 100).toFixed(1)}% ($${base.outputPerM.toFixed(3)}→$${curOut.toFixed(3)}/M)`,
        );
      }
    }

    // Requirements regression: does it still meet every served tool's bar?
    const regressions: { tool: string; reason: string }[] = [];
    for (const tool of cfg.servedTools) {
      const q = qualifyModelForTool(tool, live);
      if (!q.meetsRequirements && q.disqualifyReason !== "unknown or non-LLM tool (no registry descriptor)") {
        regressions.push({ tool, reason: q.disqualifyReason ?? "fails requirements" });
      }
    }
    if (regressions.length > 0) {
      severity = "warn";
      notes.push(
        `fails requirements for ${regressions.length} served tool(s): ${regressions.map((r) => r.tool).join(", ")}`,
      );
    }

    // Refresh the baseline snapshot for this present model.
    if (curIn != null && curOut != null) {
      updatedBaseline[cfg.model] = {
        inputPerM: curIn,
        outputPerM: curOut,
        capturedAt: base?.capturedAt ?? localIsoTimestamp(),
      };
    }

    findings.push({
      model: cfg.model,
      roles: cfg.roles,
      present: true,
      baselineInputPerM: base?.inputPerM ?? null,
      currentInputPerM: curIn,
      baselineOutputPerM: base?.outputPerM ?? null,
      currentOutputPerM: curOut,
      costChanged,
      requirementsRegressions: regressions,
      severity,
      notes: notes.length ? notes : ["healthy"],
    });
  }

  return { findings, updatedBaseline };
}

// ── Baseline persistence (atomic tmp+rename) ───────────────────────────────

/** Absolute path of the price baseline. Honors LLM_EXT_CONFIG_DIR via getConfigDir(). */
export function getBaselinePath(): string {
  return join(getConfigDir(), "model-baseline.json");
}

/** Load the baseline (best-effort: {} if missing/corrupt). */
export function loadBaseline(path: string = getBaselinePath()): ModelBaseline {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ModelBaseline;
    }
    return {};
  } catch {
    return {};
  }
}

/** Persist the baseline atomically (tmp + rename). Best-effort; never throws. */
export function saveBaseline(baseline: ModelBaseline, path: string = getBaselinePath()): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(baseline, null, 2));
    renameSync(tmp, path);
  } catch {
    // best-effort persistence; a failed baseline write must not break the check.
  }
}

export interface CheckModelHealthOptions {
  /** Catalog fetcher override (tests inject; default hits OpenRouter, no auth). */
  fetchModels?: () => Promise<OpenRouterModel[]>;
  /** Baseline path override (tests point this at a tmp file). */
  baselinePath?: string;
  /** When false, do not persist the refreshed baseline (dry inspection). Default true. */
  persistBaseline?: boolean;
  costIncreaseWarnFraction?: number;
}

/**
 * IO orchestrator: gather configured models from the active profile, fetch the
 * live catalog, diff against the seeded baseline, and return the health report.
 * Seeds the baseline on first run (no prior file). Persists the refreshed
 * baseline unless `persistBaseline:false`.
 */
export async function checkModelHealth(
  profile: Pick<ResolvedProfile, "name" | "model" | "secondModel" | "thirdModel" | "toolModels">,
  opts: CheckModelHealthOptions = {},
): Promise<ModelHealthReport> {
  const fetchModels = opts.fetchModels ?? (() => fetchProgrammingModels());
  const baselinePath = opts.baselinePath ?? getBaselinePath();
  const persist = opts.persistBaseline !== false;

  const configured = buildConfiguredModels(profile);
  const catalog = await fetchModels();
  const baselineBefore = loadBaseline(baselinePath);
  const baselineSeeded = Object.keys(baselineBefore).length === 0;

  const { findings, updatedBaseline } = computeModelHealth(configured, catalog, baselineBefore, {
    costIncreaseWarnFraction: opts.costIncreaseWarnFraction,
  });

  if (persist) saveBaseline(updatedBaseline, baselinePath);

  const summary = { total: findings.length, ok: 0, warn: 0, critical: 0 };
  for (const f of findings) summary[f.severity] += 1;

  return {
    generatedAt: localIsoTimestamp(),
    profile: profile.name,
    baselineSeeded,
    findings,
    summary,
  };
}

// ── Surfaces glue (active profile, markdown report, orchestrator) ───────────

/** Resolve the active profile from settings.yaml. Throws a clear error if unconfigured. */
export function resolveActiveProfile(): ResolvedProfile {
  const settings = loadSettings();
  if (!settings) {
    throw new Error(
      "LLM Externalizer is not configured (no settings.yaml). Run the setup wizard " +
        "or /llm-externalizer:llm-externalizer-configure.",
    );
  }
  const profile = settings.profiles[settings.active];
  if (!profile) {
    throw new Error(`Active profile '${settings.active}' not found in settings.yaml.`);
  }
  return resolveProfile(settings.active, profile);
}

/** Compact, filesystem-safe local timestamp: `YYYYMMDD_HHMMSS±HHMM`. */
function compactStamp(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const ab = Math.abs(off);
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(ab / 60))}${pad(ab % 60)}`
  );
}

/** Render a health report as a Markdown document (for the report file). */
export function renderModelHealthMarkdown(report: ModelHealthReport): string {
  const lines: string[] = [];
  lines.push(`# Model health — profile \`${report.profile}\``);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.baselineSeeded) {
    lines.push("");
    lines.push("> First run — seeded the price baseline; cost-drift detection starts next run.");
  }
  const { total, ok, warn, critical } = report.summary;
  lines.push("");
  lines.push(`**${total} configured model(s):** ${ok} ok · ${warn} warn · ${critical} critical`);
  lines.push("");
  lines.push("| Model | Roles | Status | Notes |");
  lines.push("|-------|-------|--------|-------|");
  for (const f of report.findings) {
    const status = f.severity === "critical" ? "CRITICAL" : f.severity === "warn" ? "WARN" : "ok";
    lines.push(
      `| \`${f.model}\` | ${f.roles.join(", ")} | ${status} | ${f.notes.join("; ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export interface RunCheckModelHealthOptions extends CheckModelHealthOptions {
  /** Report output dir override. Default <main-project-dir>/reports/model-health/. */
  outputDir?: string;
  /** Profile override (tests/CLI). Default: the active profile from settings.yaml. */
  profile?: Pick<ResolvedProfile, "name" | "model" | "secondModel" | "thirdModel" | "toolModels">;
}

/**
 * Top-level orchestrator for the 3 surfaces: resolve the active profile, run the
 * health check, write a Markdown report under reports/model-health/, and return
 * both the report and the file path. Advisory only — never writes settings.
 */
export async function runCheckModelHealth(
  opts: RunCheckModelHealthOptions = {},
): Promise<{ report: ModelHealthReport; reportPath: string }> {
  const profile = opts.profile ?? resolveActiveProfile();
  const report = await checkModelHealth(profile, opts);
  const dir = opts.outputDir ?? join(resolveProjectMainRoot(), "reports", "model-health");
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${compactStamp()}-model-health-${profile.name}.md`);
  writeFileSync(reportPath, renderModelHealthMarkdown(report));
  return { report, reportPath };
}

/** Render a health report as an aligned, human-readable block. */
export function renderModelHealthText(report: ModelHealthReport): string {
  const lines: string[] = [];
  lines.push(`Model health — profile '${report.profile}' — ${report.generatedAt}`);
  if (report.baselineSeeded) {
    lines.push("(first run — seeded the price baseline; cost-drift starts next run)");
  }
  const { total, ok, warn, critical } = report.summary;
  lines.push(`${total} configured model(s): ${ok} ok, ${warn} warn, ${critical} critical`);
  lines.push("");
  for (const f of report.findings) {
    const mark = f.severity === "critical" ? "✗" : f.severity === "warn" ? "!" : "✓";
    lines.push(`${mark} ${f.model}  [${f.roles.join(", ")}]`);
    for (const n of f.notes) lines.push(`    - ${n}`);
  }
  return lines.join("\n");
}
