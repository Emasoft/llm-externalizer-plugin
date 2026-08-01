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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigDir } from "../config.js";
import { isFreeSuffixModelId } from "./free-mode.js";

// ── Ledger readers (latest-wins, conclusive-pass only) ────────────────────

/** Generic reader for a `modelId::date::datasetHash`-keyed ledger. For each model
 *  it keeps the MOST RECENT entry (by ISO date, which sorts lexically) and adds
 *  the model to the result set when `isPass(entry)` holds. A missing/corrupt file
 *  is an EMPTY set (→ the gate refuses; never "all pass"). Loosely typed so it
 *  serves every tool's differently-shaped entry. */
function latestEntriesFromKeyedLedger(fileName: string): Map<string, Record<string, unknown>> {
  let cache: Record<string, unknown>;
  try {
    const raw = readFileSync(join(getConfigDir(), fileName), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    cache = parsed as Record<string, unknown>;
  } catch {
    return new Map(); // missing / unreadable / corrupt → no proof of any pass
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
  const out = new Map<string, Record<string, unknown>>();
  for (const [modelId, { entry }] of latest) out.set(modelId, entry);
  return out;
}

function passedModelsFromKeyedLedger(
  fileName: string,
  isPass: (entry: Record<string, unknown>) => boolean,
): Set<string> {
  const passed = new Set<string>();
  for (const [modelId, entry] of latestEntriesFromKeyedLedger(fileName)) {
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

/** The rank-0 ACCUMULATING ledger — keyed `modelId::date` like the five per-tool
 *  ledgers, so it survives a later sweep of a different model set. */
export const GENERAL_KEYWORD_LEDGER = "general-keyword-results.json";

/** THE single definition of "passed the general keyword sweep", applied to both
 *  the accumulating ledger and the legacy snapshot. `schemaCompliant !== false`
 *  matches --apply-free-pool's own filter (index.ts) — before this there were two
 *  competing definitions, and the looser one guarded the send gate. */
function isGeneralKeywordPass(row: {
  ok?: unknown;
  pass?: unknown;
  schemaCompliant?: unknown;
}): boolean {
  return row.ok === true && row.pass === true && row.schemaCompliant !== false;
}

/** The GENERAL keyword sweep passed-set — rank 0, the floor that validates every
 *  tool with no dedicated benchmark (chat, compare_files, cluster_synonyms, …).
 *
 *  TWO sources, because `benchmark-results.json` is a WHOLE-FILE SNAPSHOT of one
 *  run, not an accumulating ledger. Every sweep OVERWRITES it, so a background
 *  free-pool bench (`--bench-free-pool`, whose roster is ':free'-only) used to
 *  erase the pass of a paid model that was working minutes earlier — silently
 *  revoking it for every rank-0 tool. The accumulating ledger fixes that; the
 *  snapshot is still read so an install whose only proof predates the ledger
 *  keeps working.
 *
 *  Precedence: the accumulating ledger is AUTHORITATIVE for every model it
 *  mentions (its latest entry wins, pass or fail); the snapshot only contributes
 *  models the ledger has never seen. Unioning them blindly would let a stale
 *  snapshot PASS resurrect a model the ledger has since recorded as FAILING. */
function passedGeneralKeyword(): Set<string> {
  const ledger = latestEntriesFromKeyedLedger(GENERAL_KEYWORD_LEDGER);
  const passed = new Set<string>();
  for (const [modelId, entry] of ledger) {
    if (isGeneralKeywordPass(entry)) passed.add(modelId);
  }
  try {
    const raw = readFileSync(join(getConfigDir(), "benchmark-results.json"), "utf-8");
    const parsed = JSON.parse(raw) as { results?: unknown };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const r of results) {
      if (!r || typeof r !== "object") continue;
      const row = r as { modelId?: unknown; ok?: unknown; pass?: unknown; schemaCompliant?: unknown };
      if (typeof row.modelId !== "string") continue;
      if (ledger.has(row.modelId)) continue; // the ledger already ruled on it
      if (isGeneralKeywordPass(row)) passed.add(row.modelId);
    }
  } catch {
    /* missing / corrupt → the ledger alone answers */
  }
  return passed;
}

/**
 * Append one keyword-sweep's rows to the rank-0 ACCUMULATING ledger.
 *
 * Called by the sweep right after it writes its snapshot. Merge-on-write keyed
 * `modelId::date` so a run only ever ADDS to (or supersedes its own model's entry
 * in) the record — never revokes another model's pass the way overwriting the
 * snapshot does. Best-effort: a ledger we cannot write must not fail a benchmark
 * that already ran and already wrote its report; the gate simply falls back to
 * the snapshot, which is exactly the pre-ledger behavior.
 */
export function recordGeneralKeywordPasses(
  rows: ReadonlyArray<{ modelId?: unknown; ok?: unknown; pass?: unknown; schemaCompliant?: unknown }>,
  when: string = new Date().toISOString(),
): void {
  const path = join(getConfigDir(), GENERAL_KEYWORD_LEDGER);
  let cache: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cache = parsed as Record<string, unknown>;
    }
  } catch {
    /* missing / corrupt → start a fresh ledger rather than lose the run */
  }
  const date = when.slice(0, 10);
  for (const row of rows) {
    if (!row || typeof row.modelId !== "string" || row.modelId.length === 0) continue;
    cache[`${row.modelId}::${date}`] = {
      date: when,
      ok: row.ok === true,
      pass: row.pass === true,
      schemaCompliant: row.schemaCompliant,
    };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
  } catch {
    /* best-effort — see the doc comment */
  }
  clearValidatedMemo(); // the gate must see this run's passes immediately
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

// Short-TTL memo of the per-tool passed-sets. WHY: `assertModelValidated` runs at
// resolveConnection — i.e. once per LLM REQUEST — and an uncached call reads and
// JSON-parses up to six ledger files SYNCHRONOUSLY. A 500-file ensemble scan would
// do thousands of blocking reads for an answer that changes only when a benchmark
// finishes. The TTL (not a permanent memo) is the point: a benchmark that runs
// IN-PROCESS must still be able to validate a model within seconds, so the memo has
// to expire on its own rather than need explicit invalidation from every writer.
const VALIDATED_MEMO_TTL_MS = 5_000;
const validatedMemo = new Map<string, { at: number; set: Set<string> }>();

/**
 * Every model validated for `toolName`: the UNION of the passed-sets of every
 * ledger at least as hard as the tool (harder covers easier). For a rank-0 tool
 * (no dedicated benchmark) that is every ledger, so ANY pass validates it; for
 * code_task (rank 5) it is ONLY a code_task pass.
 */
export function validatedModelsForTool(toolName: string): Set<string> {
  // Keyed by CONFIG DIR too, not just the tool: LLM_EXT_CONFIG_DIR is swapped per
  // test case (and can change at runtime), and a dir-blind memo would answer one
  // config's question with another config's ledgers.
  const key = `${getConfigDir()} ${toolName}`;
  const hit = validatedMemo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < VALIDATED_MEMO_TTL_MS) return hit.set;
  const min = rankForTool(toolName);
  const out = new Set<string>();
  for (const ledger of LEDGERS) {
    if (ledger.rank < min) continue;
    for (const id of ledger.read()) out.add(id);
  }
  validatedMemo.set(key, { at: now, set: out });
  return out;
}

/** Drop the memo. Called by the test bypass toggles so a suite that swaps
 *  LLM_EXT_CONFIG_DIR between cases never reads a previous case's ledgers. */
export function clearValidatedMemo(): void {
  validatedMemo.clear();
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
// Test-only bypass. The gate reads REAL ledger files, so suites that exercise the
// scout/judge/cli/completion PLUMBING with a MOCKED fetch (no real spend, no ledger
// fixture) would trip it despite testing nothing about validation. This lets those
// suites opt out — set true in beforeEach, false in afterEach. Production code NEVER
// calls it; same risk profile as setPaidBenchmarksAllowed.
let validationBypassForTests = false;
export function setValidationBypassForTests(v: boolean): void {
  validationBypassForTests = v;
  clearValidatedMemo(); // a suite toggling this also swaps LLM_EXT_CONFIG_DIR
}

// The BENCHMARK exemption — production, and load-bearing. A benchmark is the ONLY
// thing that can PRODUCE a validation, so gating it on one is circular: without this
// flag, benchmarking a paid candidate for security_scan is impossible, because
// `runSecurityTriageBenchmark` → runner.ts → `judgeGroups` hits the very gate the
// run exists to satisfy ("IRON RULE: not validated for security_scan"), and the
// candidate can never become validated. The benchmark has its OWN, stricter cost
// guards in front of it (the $1.25/1M cap + the --allow-paid-models-tests opt-in),
// so exempting it does not weaken cost-safety — it is the one caller that has
// already paid the opt-in toll. Set with try/finally around the benchmark body.
let benchmarkValidationExempt = false;
export function setBenchmarkValidationExempt(v: boolean): void {
  benchmarkValidationExempt = v;
}

export function assertModelValidated(
  modelId: string,
  toolName: string,
  backendType: "local" | "openrouter",
): void {
  if (validationBypassForTests) return; // test-only escape hatch (see above)
  if (benchmarkValidationExempt) return; // the run that CREATES validations
  if (backendType !== "openrouter") return; // local — no catalog/benchmark
  if (isFreeSuffixModelId(modelId)) return; // ':free' — its own filter, and $0

  // ONE ledger read for both the decision and the message — the failure path used
  // to re-read all six files a second time just to name the alternatives.
  const validatedSet = validatedModelsForTool(toolName);
  if (validatedSet.has(modelId)) return;
  const validated = [...validatedSet];
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
