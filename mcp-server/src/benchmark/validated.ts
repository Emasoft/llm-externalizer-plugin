// ── The IRON RULE: per-tool model validation, with a difficulty hierarchy ──
//
// (TRDD-8b6b3646, USER directive.) A PAID OpenRouter model may only be SENT by a
// tool it has provably PASSED the benchmark for — "validated or never used". This
// module reads the benchmark ledgers to answer "is model M validated for tool T?"
// and provides the send-time chokepoint `assertModelValidated` that refuses an
// unvalidated paid model BEFORE any HTTP call ($0 spent).
//
// THE DIFFICULTY HIERARCHY (the money-saver): the tool benchmarks are RANKED by
// difficulty. A model that passed a HARDER benchmark is assumed to pass every
// EASIER one, so it is validated for tool T if it passed T's benchmark OR any
// benchmark ranked at least as hard as T. This is why a validation run goes
// hardest-first and short-circuits — a code_task pass covers everything, so the
// easier benchmarks never run (never get paid for).
//
// SCOPE. This gate fires ONLY on paid OpenRouter sends:
//   • LOCAL backend  → exempt (no OpenRouter catalog/benchmark applies; $0/offline).
//   • ':free' model  → exempt ($0; the free pool has its own filterFreeModels /
//                       benchmarkFailedModels gate — a different, cheaper rule).
// COST-SAFETY DOMINATES, so unlike the reconcile pre-flight this gate does NOT
// fail open: a missing/corrupt/empty ledger means "no proof of a pass" → REFUSE.
//
// Config.ts stays benchmark-free (no import cycle): the chokepoint lives here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir } from "../config.js";
import { isFreeSuffixModelId } from "./free-mode.js";

// ── Ledger readers (latest-wins, conclusive-pass only) ────────────────────

/** Generic reader for a `modelId::date::datasetHash`-keyed ledger. For each model
 *  it keeps the MOST RECENT entry (by ISO date, which sorts lexically) and adds
 *  the model to the result set when `isPass(entry)` holds. A missing/corrupt file
 *  is an EMPTY set (→ the gate refuses; never "all pass"). Loosely typed so it
 *  serves every tool's differently-shaped entry. */
function passedModelsFromKeyedLedger(
  fileName: string,
  isPass: (entry: Record<string, unknown>) => boolean,
): Set<string> {
  let cache: Record<string, unknown>;
  try {
    const raw = readFileSync(join(getConfigDir(), fileName), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    cache = parsed as Record<string, unknown>;
  } catch {
    return new Set(); // missing / unreadable / corrupt → no proof of any pass
  }
  const latest = new Map<string, { date: string; entry: Record<string, unknown> }>();
  for (const [key, value] of Object.entries(cache)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const modelId = key.split("::")[0];
    if (!modelId) continue;
    const date = typeof entry.date === "string" ? entry.date : "";
    const prev = latest.get(modelId);
    if (!prev || date > prev.date) latest.set(modelId, { date, entry });
  }
  const passed = new Set<string>();
  for (const [modelId, { entry }] of latest) {
    if (isPass(entry)) passed.add(modelId);
  }
  return passed;
}

/** security-triage: `score.pass` && !`score.inconclusive` (an inconclusive run —
 *  empty/errored — is NOT a pass). */
function passedSecurityTriage(): Set<string> {
  return passedModelsFromKeyedLedger("security-triage-results.json", (e) => {
    const s = e.score as { pass?: unknown; inconclusive?: unknown } | undefined;
    return !!s && s.inconclusive !== true && s.pass === true;
  });
}

/** The four DETERMINISTIC per-tool ledgers store no `score.pass`; a run PASSED the
 *  thresholds iff its `failureReasons` list is empty (an errored/empty/429 run has
 *  a non-empty list — so mimo-v2.5's empty result is correctly NOT a pass). */
function passedDeterministic(fileName: string): Set<string> {
  return passedModelsFromKeyedLedger(fileName, (e) => {
    const fr = e.failureReasons;
    return Array.isArray(fr) && fr.length === 0;
  });
}

/** The GENERAL keyword sweep ledger — a single-run snapshot, NOT key-per-model:
 *  `{ results: [{ modelId, ok, pass }] }`. Pass = `ok && pass`. This is the
 *  BOTTOM rank: it validates tools that have no dedicated benchmark. */
function passedGeneralKeyword(): Set<string> {
  const passed = new Set<string>();
  try {
    const raw = readFileSync(join(getConfigDir(), "benchmark-results.json"), "utf-8");
    const parsed = JSON.parse(raw) as { results?: unknown };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const r of results) {
      if (!r || typeof r !== "object") continue;
      const row = r as { modelId?: unknown; ok?: unknown; pass?: unknown };
      if (typeof row.modelId === "string" && row.ok === true && row.pass === true) {
        passed.add(row.modelId);
      }
    }
  } catch {
    /* missing / corrupt → empty */
  }
  return passed;
}

// ── The difficulty hierarchy ──────────────────────────────────────────────

/** Higher = harder. The single source of truth; reorder here and both the gate
 *  and any hardest-first run order follow. Justified by task rigor + observed
 *  pass rates (deepseek-v4-pro: code-task macroF1 0.479 FAIL, keyword sweep 1.0
 *  PASS). A runtime tool ABSENT from this map is rank 0 (the baseline: validated
 *  by ANY pass, including the general keyword sweep). */
export const TOOL_DIFFICULTY_RANK: Readonly<Record<string, number>> = {
  code_task: 5,
  check_against_specs: 4,
  scan_folder: 3,
  search_existing_implementations: 2,
  security_scan: 1,
};

/** Each ledger's difficulty rank + its passed-set reader, hardest → easiest. The
 *  general keyword ledger is rank 0 (the floor). */
const LEDGERS: ReadonlyArray<{ rank: number; read: () => Set<string> }> = [
  { rank: 5, read: () => passedDeterministic("code-task-results.json") },
  { rank: 4, read: () => passedDeterministic("check-specs-results.json") },
  { rank: 3, read: () => passedDeterministic("scan-folder-results.json") },
  { rank: 2, read: () => passedDeterministic("search-existing-results.json") },
  { rank: 1, read: passedSecurityTriage },
  { rank: 0, read: passedGeneralKeyword },
];

/** The CLI flag that benchmarks a given tool, for the refusal message. */
const TOOL_BENCH_FLAG: Readonly<Record<string, string>> = {
  code_task: "--code-task",
  check_against_specs: "--check-specs",
  scan_folder: "--scan-folder",
  search_existing_implementations: "--search-existing",
  security_scan: "--security-triage",
};

export function rankForTool(toolName: string): number {
  return TOOL_DIFFICULTY_RANK[toolName] ?? 0;
}

/**
 * Every model validated for `toolName`: the UNION of the passed-sets of every
 * ledger at least as hard as the tool (harder covers easier). For a rank-0 tool
 * (no dedicated benchmark) that is every ledger, so ANY pass validates it; for
 * code_task (rank 5) it is ONLY a code_task pass.
 */
export function validatedModelsForTool(toolName: string): Set<string> {
  const min = rankForTool(toolName);
  const out = new Set<string>();
  for (const ledger of LEDGERS) {
    if (ledger.rank < min) continue;
    for (const id of ledger.read()) out.add(id);
  }
  return out;
}

/** Is `modelId` validated to serve `toolName`? (Pure availability of a pass — the
 *  send-time exemptions for local/`:free` live in assertModelValidated.) */
export function validatedForTool(modelId: string, toolName: string): boolean {
  return validatedModelsForTool(toolName).has(modelId);
}

// ── The send-time chokepoint ──────────────────────────────────────────────

/**
 * Refuse to send a PAID OpenRouter model that is not validated for `toolName`.
 * Sits beside `assertFreeOnlyModel` at every send site. No-op for a LOCAL backend
 * or a ':free' model (both out of scope — see the module header). Throws with a
 * copy-pasteable recovery command; refuses on an empty/corrupt ledger (cost-safety
 * does NOT fail open). `$0` is spent — this runs before any HTTP.
 */
export function assertModelValidated(
  modelId: string,
  toolName: string,
  backendType: "local" | "openrouter",
): void {
  if (backendType !== "openrouter") return; // local — no catalog/benchmark
  if (isFreeSuffixModelId(modelId)) return; // ':free' — its own filter, and $0
  if (validatedForTool(modelId, toolName)) return;

  const validated = [...validatedModelsForTool(toolName)];
  const flag = TOOL_BENCH_FLAG[toolName];
  const validateCmd = flag
    ? `llm-ext-benchmark ${flag} ${modelId} --allow-paid-models-tests`
    : `llm-ext-benchmark --allow-paid-models-tests   (any benchmark validates '${toolName}')`;
  const haveList =
    validated.length > 0
      ? `Currently validated for ${toolName}: ${validated.join(", ")}.`
      : `No model is validated for ${toolName} yet.`;
  throw new Error(
    `IRON RULE: model '${modelId}' is not validated for ${toolName}. ` +
      `No LLM call was made, no money was spent. ` +
      `Validate it: ${validateCmd} — or configure a model already validated for this tool. ` +
      `${haveList}`,
  );
}
