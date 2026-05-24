/**
 * Assess one candidate model against EVERY registered LLM tool's REQUIREMENTS
 * (TRDD-f45eeaa0 §2.4 — the re-runnable "assess a new model" surface).
 *
 * This is the requirements half of the per-tool gate. It is FREE (no LLM call,
 * no token cost) — it makes a single public OpenRouter model-catalog fetch (no
 * API key needed) and reports, for each tool, whether the model meets that
 * tool's hard requirements plus
 * whether the tool ALSO has a benchmark gate the operator must still run before
 * assigning the model. It does NOT run any benchmark — the benchmark half stays
 * with each benchmark's own runner (today only `security_scan` →
 * security-triage; the rest are requirements-only until their dataset lands).
 *
 * The pure core (`assessModelAcrossTools`) takes a raw model and is fully
 * unit-testable; `assessModelById` adds catalog lookup with an injectable
 * fetcher for the MCP/CLI surfaces.
 */

import {
  fetchProgrammingModels,
  type OpenRouterModel,
} from "../benchmark/discover.js";
import {
  getToolDescriptor,
  qualifyModelForTool,
  registeredTools,
} from "./registry.js";

export interface ToolAssessment {
  tool: string;
  /** Meets the tool's hard requirements (cost / context / output / params). */
  meetsRequirements: boolean;
  /** First failing requirement when it does NOT qualify, else null. */
  disqualifyReason: string | null;
  /** Benchmark id that ALSO gates this tool, or null (requirements-only). */
  benchmark: string | null;
  /** The registry's human note for the tool. */
  note: string;
}

export interface ModelAssessment {
  modelId: string;
  modelName: string;
  tools: ToolAssessment[];
  /** Tools whose hard requirements this model meets. */
  qualifiedCount: number;
  totalTools: number;
  /**
   * Tools the model qualifies for (requirements) AND that carry a benchmark
   * gate — i.e. the operator must still run that benchmark before assigning the
   * model. (Subset of the qualified tools.)
   */
  benchmarkGatedQualified: string[];
}

/**
 * Pure: assess a fully-formed OpenRouter model against every registered tool.
 * No IO. Mirrors the registry's per-tool requirements gate.
 */
export function assessModelAcrossTools(model: OpenRouterModel): ModelAssessment {
  const tools: ToolAssessment[] = [];
  for (const tool of registeredTools()) {
    const q = qualifyModelForTool(tool, model);
    tools.push({
      tool,
      meetsRequirements: q.meetsRequirements,
      disqualifyReason: q.disqualifyReason,
      benchmark: q.benchmark,
      note: getToolDescriptor(tool)?.note ?? "",
    });
  }
  const qualifiedCount = tools.filter((t) => t.meetsRequirements).length;
  const benchmarkGatedQualified = tools
    .filter((t) => t.meetsRequirements && t.benchmark !== null)
    .map((t) => t.tool);
  return {
    modelId: model.id,
    modelName: model.name ?? model.id,
    tools,
    qualifiedCount,
    totalTools: tools.length,
    benchmarkGatedQualified,
  };
}

export interface AssessByIdOptions {
  /** Catalog fetcher override (tests inject this; default hits OpenRouter). */
  fetchModels?: () => Promise<OpenRouterModel[]>;
}

/**
 * Fetch the OpenRouter catalog, find `modelId`, and assess it. Throws a clear
 * error when the id is not in the catalog. The catalog is public (no auth).
 */
export async function assessModelById(
  modelId: string,
  opts: AssessByIdOptions = {},
): Promise<ModelAssessment> {
  const fetchModels = opts.fetchModels ?? (() => fetchProgrammingModels());
  const models = await fetchModels();
  const model = models.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(
      `Model '${modelId}' not found in the OpenRouter catalog. ` +
        `Check the id (e.g. 'google/gemini-2.5-flash').`,
    );
  }
  return assessModelAcrossTools(model);
}

/** Render an assessment as an aligned, human-readable block. */
export function renderAssessmentText(a: ModelAssessment): string {
  const lines: string[] = [];
  lines.push(`Model: ${a.modelId} (${a.modelName})`);
  lines.push(
    `Meets requirements for ${a.qualifiedCount}/${a.totalTools} LLM tools.`,
  );
  lines.push("");
  const toolWidth = Math.max(4, ...a.tools.map((t) => t.tool.length));
  for (const t of a.tools) {
    const status = t.meetsRequirements ? "OK" : "NO";
    const tail = t.meetsRequirements
      ? t.benchmark
        ? `benchmark: ${t.benchmark} (run before assigning)`
        : "requirements-only"
      : (t.disqualifyReason ?? "does not meet requirements");
    lines.push(`  ${t.tool.padEnd(toolWidth)}  ${status}  ${tail}`);
  }
  if (a.benchmarkGatedQualified.length > 0) {
    lines.push("");
    lines.push(
      `Note: ${a.benchmarkGatedQualified.join(", ")} ALSO require a benchmark ` +
        `pass before assignment — run that tool's benchmark ` +
        `(security_scan → /llm-externalizer-security-triage-benchmark).`,
    );
  }
  return lines.join("\n");
}
