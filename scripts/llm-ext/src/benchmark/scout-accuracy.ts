/**
 * Scout-accuracy benchmark action (TRDD-FKAR9VPK D2) — the single callable
 * behind `llm-ext-benchmark --scout-accuracy`.
 *
 * Candidates = PAID catalog models under the scouting price ceiling
 * (`scout_price_ceiling_usd_per_million`, getter scoutPriceCeilingUsdPerM —
 * withinPriceCeiling machinery, "one ceiling, <="). Ranked COST-ASCENDING.
 * Probes run sequentially, ONE classifyPositional call per candidate at the
 * effective size (A1 clamp: min(target, 50% of the model's context window)),
 * stopping at 3 survivors.
 *
 * Spend backstop: the EXISTING paid_benchmark_daily_cap_usd machinery
 * (SpendLedger + bookDailySpend) applies as-is — this action mints NO second
 * cap key. assertPaidBenchmarkAllowed runs on the candidate set before the
 * first send, like every other paid benchmark.
 *
 * Per-candidate verdicts land in the scout-accuracy ledger (D4) keyed by the
 * CURRENT dataset hash — retuning threshold/target/fixture-version re-probes
 * every candidate by design (review F-2).
 *
 * Zero survivors: exit non-zero with the per-candidate best accuracy so the
 * user can retune knowing the re-probe cost (STATE block item 5).
 *
 * On >= 1 survivor: pick the cheapest, write the STATIC scouting profile (D3)
 * via writeDynamicProfileSection (locked, marked, backed up), and print the profile + survivors.
 *
 * Testability (A9a): the catalog fetch AND the HTTP send are injected seams
 * (opts.catalogFetch / opts.fetchImpl). Tests feed fixtures through them —
 * no module mocking, no live OpenRouter, ever.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fetchProgrammingModels,
  qualify,
  assertPaidBenchmarkAllowed,
  type ModelCriteria,
  type OpenRouterModel,
  type QualifiedModel,
} from "./discover.js";
import { dropKeysOutsideClosedSet, writeDynamicProfileSection } from "./pick.js";
import { SpendLedger } from "./budget.js";
import { bookDailySpend } from "./daily-spend.js";
import { benchmarkSubReportDir } from "./report-dir.js";
import {
  getConfigDir,
  isPlaceholderProfile,
  loadSettings,
  scoutAccuracyTargetBytes,
  scoutAccuracyThreshold,
  scoutPriceCeilingUsdPerM,
  withinPriceCeiling,
  type Profile,
} from "../config.js";
import { estimateCostUsd, type ModelPrice } from "./budget.js";
import type { FetchImpl } from "../mass_scouting/scout.js";
import {
  buildPositionalSchema,
  classifyPositional,
  generateFixture,
  MIN_FIXTURE_BYTES,
  scoreAccuracy,
  SCOUT_ACCURACY_FIXTURE_VERSION,
} from "../mass_scouting/scout-accuracy-fixture.js";
import { bytesCapFromPct } from "../mass_scouting/cost-estimate.js";
import {
  loadOrInit,
  recordScoutAccuracy,
  saveCache,
  scoutAccuracyHash,
  type LedgerFile,
} from "../mass_scouting/scout-accuracy-ledger.js";

/** Scout candidate requirements: structured outputs are REQUIRED (the probe
 *  is a strict json_schema call), reasoning is NOT (ultra-cheap models rarely
 *  expose it). The context floor is deliberately LOW — models too small for
 *  the fixture are not silently filtered here but SKIPPED with the A1 reason
 *  ('context too small for fixture') by the effective-size clamp, so the run
 *  reports them. allowFree false — never a ':free' id. */
export const SCOUT_ACCURACY_CRITERIA: ModelCriteria = {
  category: "programming",
  minContextTokens: 1_024,
  minOutputTokens: 1_024,
  maxInputDollarsPerMillion: Number.MAX_SAFE_INTEGER,
  maxOutputDollarsPerMillion: Number.MAX_SAFE_INTEGER,
  requireStructuredOutputs: true,
  requireReasoning: false,
  allowFree: false,
};

/** Survivors cap (design: STOP at 3). */
export const SCOUT_SURVIVOR_CAP = 3;

export interface ScoutAccuracyOptions {
  apiKey?: string;
  /** A9a seam: the catalog provider. Default: the public OpenRouter catalog. */
  catalogFetch?: () => Promise<OpenRouterModel[]>;
  /** A9a seam: the HTTP send. Default: globalThis fetch. */
  fetchImpl?: FetchImpl;
  /** Report dir override. Default benchmarkSubReportDir("scout-accuracy-benchmark"). */
  outputDir?: string;
  mainRoot?: string;
  /** Run cap override (the CLI's --budget-usd). Default DEFAULT_BUDGET_USD. */
  budgetUsd?: number;
  /** Ignore the per-model-per-day ledger cache and re-probe everything. */
  force?: boolean;
  onProgress?: (message: string) => void;
}

export interface ScoutCandidateRow {
  modelId: string;
  /** Skipped before any send (A1/A2): context too small for the fixture. */
  skipped?: string;
  pass: boolean;
  inconclusive: boolean;
  accuracy: number;
  costUsd: number;
  effectiveBytes: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
}

export interface ScoutAccuracyResult {
  /** false when zero survivors — the CLI phase exits non-zero. */
  ok: boolean;
  survivors: QualifiedModel[];
  profileWritten: boolean;
  /** Set when the profile REPLACED an existing one (D3/A8). */
  previousHeadModelId?: string;
  rows: ScoutCandidateRow[];
  costUsd: number;
  summaryLine: string;
  jsonReportPath?: string;
}

/** The static scouting profile NAME (mirror of mass_scouting/cli.ts's
 *  SCOUTING_PROFILE_NAME — kept literal here to avoid the import cycle that
 *  cli.ts's own benchmark imports would close; the gate reads the same name
 *  from settings.yaml). */
export const SCOUTING_PROFILE = "scouting";

/** never a ':free' id (hard rule) — assertion used by buildScoutingProfile. */
function assertNoFreeModelId(modelId: string, where: string): void {
  if (modelId.endsWith(":free")) {
    throw new Error(
      `${where}: refusing ':free' model '${modelId}' — mass-scout must never use a ` +
        `free-tier model (rate-limit risk at scale).`,
    );
  }
}

/**
 * Assemble the STATIC scouting profile (D3): OpenRouter remote, env-name api
 * key, model = cheapest survivor. No `paid_models` list (PT-04): nothing reads it
 * (profile-fallback.ts) and the closed key set of `scouting` does not allow it.
 * Asserts the ':free' hard rule twice (filter loop + builder), like
 * pickMassScoutModel does. Exported for the red-proof test (c).
 */
export function buildScoutingProfile(
  survivors: readonly { modelId: string }[],
): Profile {
  for (const s of survivors) {
    assertNoFreeModelId(s.modelId, "buildScoutingProfile (candidate filter)");
  }
  const head = survivors[0]?.modelId;
  if (!head) throw new Error("buildScoutingProfile: no survivors");
  assertNoFreeModelId(head, "buildScoutingProfile (head assert)");
  return {
    mode: "remote",
    api: "openrouter-remote",
    url: "https://openrouter.ai/api",
    api_key: "$OPENROUTER_API_KEY",
    model: head,
  };
}

/**
 * Write the scouting profile (D3). Returns the previous head when the profile
 * REPLACED an existing one — the caller prints the A8 replace line.
 */
export function writeScoutingProfile(
  settingsPath: string,
  survivors: readonly { modelId: string }[],
): { previousHeadModelId?: string } {
  const profile = buildScoutingProfile(survivors);
  let previousHeadModelId: string | undefined;
  try {
    const s = loadSettings();
    const existing = s?.profiles?.[SCOUTING_PROFILE];
    // PT-04: the fresh-install placeholder is not a previous head; reporting "replaced ... placeholder/unpopulated-default-profile" would mislead.
    if (existing && typeof existing.model === "string" && !isPlaceholderProfile(existing)) {
      previousHeadModelId = existing.model;
    }
  } catch {
    // unreadable settings — writeDynamicProfileSection will fail loudly if it matters
  }
  // PT-04: the locked, marked, backed-up writer; addProfileToSettings wrote this section with no marker, lock or backup.
  const written = writeDynamicProfileSection(settingsPath, SCOUTING_PROFILE, () => profile, {
    notify: (msg) => process.stderr.write(`${msg}\n`),
  });
  // A section that was not ours has just been backed up and replaced; its stray keys (the old `paid_models`) would fail the closed-key check on the next load.
  if (written.backupPath !== null) dropKeysOutsideClosedSet(settingsPath, SCOUTING_PROFILE);
  return { previousHeadModelId };
}

/** Probe ONE candidate at its clamped effective size. Returns the row. */
async function probeCandidate(
  q: QualifiedModel,
  effectiveBytes: number,
  threshold: number,
  hash: string,
  apiKey: string,
  opts: ScoutAccuracyOptions,
  ledger: LedgerFile,
  spend: SpendLedger,
  cacheKey: string,
  progress: (m: string) => void,
): Promise<ScoutCandidateRow> {
  const price: ModelPrice = {
    inputDollarsPerMillion: q.inputDollarsPerMillion,
    outputDollarsPerMillion: q.outputDollarsPerMillion,
  };
  const base: ScoutCandidateRow = {
    modelId: q.id,
    pass: false,
    inconclusive: true,
    accuracy: 0,
    costUsd: 0,
    effectiveBytes,
    inputDollarsPerMillion: q.inputDollarsPerMillion,
    outputDollarsPerMillion: q.outputDollarsPerMillion,
  };
  const cached = ledger[cacheKey];
  if (cached && !opts.force && !cached.score.inconclusive) {
    progress(`  ${q.id}: ledger hit (${cached.score.pass ? "PASS" : "FAIL"} @ ${(cached.score.accuracy * 100).toFixed(1)}%) — no call.`);
    return {
      ...base,
      pass: cached.score.pass,
      inconclusive: false,
      accuracy: cached.score.accuracy,
      costUsd: 0,
    };
  }
  const fixture = generateFixture(1, effectiveBytes);
  progress(`  ${q.id}: probing ${effectiveBytes}B (${fixture.recordCount} records)…`);
  const res = await classifyPositional(
    q.id,
    "https://openrouter.ai/api",
    apiKey,
    fixture,
    buildPositionalSchema(fixture.recordCount),
    { fetchImpl: opts.fetchImpl },
  );
  const costUsd = estimateCostUsd(res.promptTokens, res.completionTokens, price);
  spend.record(`scout-accuracy:${q.id}`, costUsd);
  if (res.error !== null) {
    recordScoutAccuracy(q.id, hash, { pass: false, inconclusive: true, accuracy: 0 });
    return { ...base, costUsd, inconclusive: true };
  }
  const score = scoreAccuracy(fixture.expected, res.predicted);
  const pass = score.accuracy >= threshold;
  recordScoutAccuracy(q.id, hash, {
    pass,
    inconclusive: false,
    accuracy: score.accuracy,
  });
  progress(
    `  ${q.id}: ${pass ? "PASS" : "FAIL"} accuracy=${(score.accuracy * 100).toFixed(1)}% ` +
      `(${score.correct}/${score.total}) cost=$${costUsd.toFixed(6)}`,
  );
  return { ...base, pass, inconclusive: false, accuracy: score.accuracy, costUsd };
}

/**
 * Run the scout-accuracy benchmark. See the module header for the shape.
 */
export async function runScoutAccuracyBenchmark(
  opts: ScoutAccuracyOptions = {},
): Promise<ScoutAccuracyResult> {
  const progress = opts.onProgress ?? (() => {});
  const apiKey =
    opts.apiKey ||
    process.env.OPENROUTER_API_KEY ||
    process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Export it in your shell, or set the plugin option 'openrouter_api_key' via Claude Code's /plugin configure.",
    );
  }
  const settings = loadSettings();
  const threshold = scoutAccuracyThreshold(settings);
  const targetBytes = scoutAccuracyTargetBytes(settings);
  const ceiling = scoutPriceCeilingUsdPerM(settings);
  const hash = scoutAccuracyHash(threshold, targetBytes);
  progress(
    `scout-accuracy: threshold=${threshold} target=${targetBytes}B ceiling=$${ceiling}/M ` +
      `fixture=v${SCOUT_ACCURACY_FIXTURE_VERSION} hash=${hash}`,
  );

  // Spend backstop: the EXISTING daily-cap machinery, as-is (no second cap key).
  const spend = new SpendLedger(opts.budgetUsd ?? 2.0, { onBook: bookDailySpend });

  progress("Fetching OpenRouter model catalog…");
  const catalog = await (opts.catalogFetch ?? fetchProgrammingModels)();
  const candidates = catalog
    .map((m) => qualify(m, SCOUT_ACCURACY_CRITERIA))
    .filter((q): q is QualifiedModel => q !== null)
    .filter((q) => !q.id.endsWith(":free"))
    .filter((q) => withinPriceCeiling(q, ceiling))
    .sort(
      (a, b) =>
        a.inputDollarsPerMillion +
        a.outputDollarsPerMillion -
        (b.inputDollarsPerMillion + b.outputDollarsPerMillion),
    );
  progress(
    `${candidates.length} candidate(s) under the $${ceiling}/M scouting ceiling (cost-ascending).`,
  );
  if (candidates.length > 0) {
    // Paid-benchmark opt-in chokepoint, BEFORE the first send (same as triage).
    assertPaidBenchmarkAllowed(candidates);
  }

  const ledger = loadOrInit();
  const rows: ScoutCandidateRow[] = [];
  const survivors: QualifiedModel[] = [];
  let totalCost = 0;

  for (const q of candidates) {
    if (survivors.length >= SCOUT_SURVIVOR_CAP) break;
    // A1 clamp + A9b skip floor.
    const ctxCap = bytesCapFromPct(q.contextTokens, 0.5);
    const effectiveBytes = Math.min(targetBytes, ctxCap);
    if (effectiveBytes < MIN_FIXTURE_BYTES) {
      progress(
        `  ${q.id}: SKIPPED — context too small for fixture ` +
          `(effective ${effectiveBytes}B < min ${MIN_FIXTURE_BYTES}B).`,
      );
      rows.push({
        modelId: q.id,
        skipped: "context too small for fixture",
        pass: false,
        inconclusive: true,
        accuracy: 0,
        costUsd: 0,
        effectiveBytes,
        inputDollarsPerMillion: q.inputDollarsPerMillion,
        outputDollarsPerMillion: q.outputDollarsPerMillion,
      });
      continue;
    }
    const cacheKey = `${q.id}::${new Date().toISOString().slice(0, 10)}::${hash}`;
    const row = await probeCandidate(
      q,
      effectiveBytes,
      threshold,
      hash,
      apiKey,
      opts,
      ledger,
      spend,
      cacheKey,
      progress,
    );
    if (spend.tripped !== null) {
      progress(`  spend cap tripped: ${spend.tripped} — stopping.`);
      rows.push(row);
      break;
    }
    totalCost += row.costUsd;
    rows.push(row);
    if (row.pass && !row.inconclusive) survivors.push(q);
  }
  saveCache(loadOrInit());

  if (survivors.length === 0) {
    const best = rows
      .map((r) => `${r.modelId}: ${r.skipped ? `SKIPPED (${r.skipped})` : r.inconclusive ? "INCONCLUSIVE (error)" : `${(r.accuracy * 100).toFixed(1)}%`}`)
      .join("; ");
    return {
      ok: false,
      survivors: [],
      profileWritten: false,
      rows,
      costUsd: totalCost,
      summaryLine:
        `no model cleared the ${(threshold * 100).toFixed(0)}% scout-accuracy threshold — ` +
        `per-candidate best accuracy: ${best || "(no candidates under the ceiling)"}. ` +
        `Retune via scout_accuracy_threshold / scout_accuracy_target_bytes in settings.yaml ` +
        `(NOTE: retuning changes the dataset hash and re-probes every candidate).`,
    };
  }

  // Cost-ascending order is already the candidate order; survivors are pushed
  // in iteration order = cost order. Sort is defensive.
  survivors.sort(
    (a, b) =>
      a.inputDollarsPerMillion +
      a.outputDollarsPerMillion -
      (b.inputDollarsPerMillion + b.outputDollarsPerMillion),
  );
  const picked = survivors.slice(0, SCOUT_SURVIVOR_CAP);
  const settingsPath = join(getConfigDir(), "settings.yaml");
  const { previousHeadModelId } = writeScoutingProfile(
    settingsPath,
    picked.map((p) => ({ modelId: p.id })),
  );
  if (previousHeadModelId) {
    progress(`replaced existing scouting profile (previous model: ${previousHeadModelId})`);
  }
  progress(
    `scouting profile written: model=${picked[0]!.id} survivors=[${picked.map((p) => p.id).join(", ")}]`,
  );

  // Report (best-effort — the profile write is the deliverable).
  let jsonReportPath: string | undefined;
  try {
    const reportDir = opts.outputDir ?? benchmarkSubReportDir("scout-accuracy-benchmark", opts.mainRoot);
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    jsonReportPath = join(reportDir, `${stamp}-scout-accuracy.json`);
    const tmp = `${jsonReportPath}.tmp.${process.pid}`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          threshold,
          targetBytes,
          ceiling,
          fixtureVersion: SCOUT_ACCURACY_FIXTURE_VERSION,
          hash,
          costUsd: totalCost,
          rows,
          survivors: picked.map((p) => ({ modelId: p.id, in: p.inputDollarsPerMillion, out: p.outputDollarsPerMillion })),
        },
        null,
        2,
      ),
      "utf-8",
    );
    renameSync(tmp, jsonReportPath);
  } catch {
    jsonReportPath = undefined;
  }

  return {
    ok: true,
    survivors: picked,
    profileWritten: true,
    previousHeadModelId,
    rows,
    costUsd: totalCost,
    summaryLine:
      `scout-accuracy done — ${picked.length} survivor(s), scouting profile ` +
      `${previousHeadModelId ? "replaced" : "written"} (head ${picked[0]!.id}), spend $${totalCost.toFixed(6)}`,
    jsonReportPath,
  };
}
