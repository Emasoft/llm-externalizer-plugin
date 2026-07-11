/**
 * Per-tool model-qualification registry (TRDD-f45eeaa0 — framework core).
 *
 * Each LLM-using MCP tool declares its own model REQUIREMENTS (hard
 * eligibility) and, when one exists, the id of its model-judgment BENCHMARK.
 * A model is eligible to serve a tool ONLY if it (a) meets that tool's
 * requirements AND (b) passes that tool's benchmark — and, per the standing
 * same-cost rule, is never pricier than the incumbent. This module is the
 * single source of truth for (a) and the benchmark pointer for (b).
 *
 * Scope note (deliberate, not an omission): this is the registry + requirements
 * half, EXTRACTED from the working security_scan reference instance
 * ([[TRDD-973a0265]], shipped v9.12.0). The per-tool BENCHMARK DATASETS for the
 * other tools, the settings.yaml per-tool model map, and a generalized
 * cross-tool selection are explicitly INCREMENTAL — they are added as each tool
 * gets a real benchmark, to avoid abstracting a selection mechanism from a
 * single instance (the premature-abstraction trap the TRDD §1 warns against).
 * Today exactly one tool (`security_scan`) has a benchmark; `mass_scout`/the
 * ensemble reuse the keyword-classification benchmark via the existing
 * benchmark/pick.ts path. The rest carry requirements only (benchmark: null).
 */

import {
  DEFAULT_CRITERIA,
  qualify,
  disqualifyReason,
  type ModelCriteria,
  type OpenRouterModel,
  type QualifiedModel,
} from "../benchmark/discover.js";
import { SECURITY_TRIAGE_CRITERIA } from "../benchmark/security-triage/select.js";

export interface ToolModelDescriptor {
  /** The MCP tool name. */
  tool: string;
  /** Hard eligibility criteria (cost ceiling / context / output / params). */
  requirements: ModelCriteria;
  /**
   * Benchmark id gating model selection for this tool, or null when no
   * model-judgment benchmark exists yet (requirements-only gating).
   */
  benchmark: string | null;
  /** Short human note on why these requirements / what the benchmark covers. */
  note: string;
}

/**
 * Helper: a copy of DEFAULT_CRITERIA with per-tool overrides. DEFAULT_CRITERIA
 * is the keyword-ensemble baseline (128K ctx / 64K out / structured + reasoning
 * / < $1/M). Each tool relaxes or tightens from there.
 */
function criteria(overrides: Partial<ModelCriteria>): ModelCriteria {
  return { ...DEFAULT_CRITERIA, ...overrides };
}

/**
 * The registry. Keyed by tool name. Only LLM-USING tools appear — pure-utility
 * tools (discover, reset, get_settings, or_model_info, the mass_scout_* registry
 * ops) make no LLM call and have no descriptor.
 *
 * Requirements derived from TRDD-f45eeaa0 §3's first-pass capability map.
 */
export const TOOL_MODEL_REGISTRY: Record<string, ToolModelDescriptor> = {
  security_scan: {
    tool: "security_scan",
    // The reference instance. Structured output + a modest context; NO reasoning
    // / 128K bar — triage snippets are small and the verdict is ~200 bytes.
    requirements: SECURITY_TRIAGE_CRITERIA,
    benchmark: "security-triage",
    note: "Injection-hardened verdict adjudication. Gated by the security-triage golden dataset (TRDD-973a0265).",
  },
  mass_scout: {
    tool: "mass_scout",
    requirements: criteria({ requireReasoning: false }),
    benchmark: "keyword-classification",
    note: "Fieldset extraction / classification. Reuses the existing keyword-classification benchmark (benchmark/ground-truth.ts + pick.ts).",
  },
  cluster_synonyms: {
    tool: "cluster_synonyms",
    requirements: criteria({ requireReasoning: true }),
    benchmark: null,
    note: "Meaning-equivalence clustering. Has an in-tool pre-flight benchmark gate; a formal golden dataset is incremental.",
  },
  code_task: {
    tool: "code_task",
    requirements: criteria({ requireReasoning: true, minContextTokens: 128_000 }),
    benchmark: "code-task",
    note: "Code-optimized analysis. Gated by the code-audit benchmark (P2b): real pre-fix snapshots from this repo's own git history, scored deterministically on defect localization by symbol name — no LLM judge.",
  },
  scan_folder: {
    tool: "scan_folder",
    requirements: criteria({ requireReasoning: false, minContextTokens: 128_000 }),
    benchmark: null,
    note: "Per-file auto-discovery scan. Per-file detection benchmark dataset is incremental.",
  },
  search_existing_implementations: {
    tool: "search_existing_implementations",
    requirements: criteria({ requireReasoning: true, minContextTokens: 128_000 }),
    benchmark: "search-existing",
    note: "Duplicate-implementation match across a codebase. Gated by the search-existing fixture benchmark (TRDD-828238b5 A6).",
  },
  check_references: {
    tool: "check_references",
    requirements: criteria({ requireReasoning: false }),
    benchmark: null,
    note: "Symbol-reference validation. Validation-accuracy benchmark dataset is incremental.",
  },
  check_imports: {
    tool: "check_imports",
    requirements: criteria({ requireReasoning: false }),
    benchmark: null,
    note: "Import-path validation. Validation-accuracy benchmark dataset is incremental.",
  },
  check_against_specs: {
    tool: "check_against_specs",
    requirements: criteria({ requireReasoning: false }),
    benchmark: null,
    note: "Source-vs-specification compliance. Validation-accuracy benchmark dataset is incremental.",
  },
  compare_files: {
    tool: "compare_files",
    requirements: criteria({ requireReasoning: false, minContextTokens: 128_000 }),
    benchmark: null,
    note: "Two-file change summary. Change-summary benchmark dataset is incremental.",
  },
  chat: {
    tool: "chat",
    // The loosest tool — general text. Structured output not required.
    requirements: criteria({ requireStructuredOutputs: false, requireReasoning: false }),
    benchmark: null,
    note: "General-purpose text. A loose general-quality benchmark is incremental.",
  },
};

/** Look up a tool's descriptor, or undefined for a pure-utility / unknown tool. */
export function getToolDescriptor(tool: string): ToolModelDescriptor | undefined {
  return TOOL_MODEL_REGISTRY[tool];
}

/** Every LLM-using tool name the registry knows about. */
export function registeredTools(): string[] {
  return Object.keys(TOOL_MODEL_REGISTRY);
}

export interface ToolQualification {
  tool: string;
  /** Passed the tool's hard REQUIREMENTS (cost/context/output/params). */
  meetsRequirements: boolean;
  /** First failing requirement as a short string, or null when it passed. */
  disqualifyReason: string | null;
  /** The decorated model when it qualifies, else null. */
  qualified: QualifiedModel | null;
  /** Benchmark id that ALSO gates this tool, or null (requirements-only). */
  benchmark: string | null;
  /**
   * True iff the model is FULLY eligible from the registry's perspective:
   * meets requirements AND (the tool has no benchmark OR the caller must still
   * run that benchmark). When `benchmark` is non-null, the caller MUST run the
   * benchmark and confirm a pass before assigning the model — this function
   * only covers the requirements half (the benchmark half lives with each
   * benchmark's runner, e.g. security-triage/runner.ts).
   */
  requirementsEligible: boolean;
}

/**
 * Check a raw OpenRouter model against a tool's REQUIREMENTS. The benchmark gate
 * (when the tool has one) is run separately by that benchmark's runner — this
 * is the requirements half of the per-tool gate. Unknown/utility tools (no
 * descriptor) return meetsRequirements:false with benchmark:null.
 */
export function qualifyModelForTool(
  tool: string,
  model: OpenRouterModel,
): ToolQualification {
  const descriptor = getToolDescriptor(tool);
  if (!descriptor) {
    return {
      tool,
      meetsRequirements: false,
      disqualifyReason: "unknown or non-LLM tool (no registry descriptor)",
      qualified: null,
      benchmark: null,
      requirementsEligible: false,
    };
  }
  const qualified = qualify(model, descriptor.requirements);
  const reason =
    qualified === null ? disqualifyReason(model, descriptor.requirements) : null;
  return {
    tool,
    meetsRequirements: qualified !== null,
    disqualifyReason: reason,
    qualified,
    benchmark: descriptor.benchmark,
    requirementsEligible: qualified !== null,
  };
}
