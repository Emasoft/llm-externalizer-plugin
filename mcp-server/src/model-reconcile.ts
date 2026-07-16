// ── Auto model-reconcile: assess the model situation before doing work ──
//
// Every surface (MCP tool call, CLI command, and therefore every skill / slash
// command / agent that wraps them) runs this ONCE before it does real work. It
// answers: "have the OpenRouter models changed since we last looked — did a model
// we rely on DIE, or did a better free one ARRIVE?" and reconfigures the FREE
// class accordingly, at $0.
//
// Split of responsibility (cost-safety is the whole point):
//   • FREE models — detected AND adopted automatically. Adopting a ':free' model
//     costs nothing, and benchmarking it costs nothing, so the viable free class
//     can track the live catalog with zero spend.
//   • PAID models — detected only. A dead paid model is WARNED about (so the user
//     runs `--update-all --paid`); a new/cheaper paid model is never
//     auto-benchmarked or auto-adopted, because benchmarking a paid model SENDS
//     billable requests. The user's credit balance, not a benchmark, is the paid
//     budget — spending it is the credit-driven paid→free switch, not this.
//
// This module is the PURE CORE: `computeReconcile` takes plain data (the live
// catalog id-set, the configured models, the qualified free arrivals) and returns
// a verdict. It reads no files, fetches nothing, and has an injected clock via the
// throttle helper — so it is fully offline-testable. The IO shell that fetches the
// catalog, reads/writes settings.yaml, and launches the $0 benchmark lives in
// index.ts / the CLI mains and calls this.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  getConfigDir,
  getSettingsPath,
  loadSettings,
  resolveProfile,
} from "./config.js";
import { isFreeSuffixModelId } from "./benchmark/free-mode.js";
import { filterFreeModels, type FreeModelCatalogEntry } from "./free-rotation.js";
import { fetchProgrammingModels } from "./benchmark/discover.js";
import { applyFreePoolToSettings } from "./benchmark/pick.js";
import { benchmarkFailedModels } from "./benchmark/security-triage/index.js";
import { maybeTriggerFreePoolBench } from "./free-pool-auto-bench.js";

// ── Shapes ──────────────────────────────────────────────────────────────

export interface ReconcileInput {
  /**
   * Every model id currently in the live OpenRouter catalog. EMPTY means the
   * fetch failed / the catalog is cold — a critical distinction: we must NOT
   * declare every configured model "dead" just because we couldn't look. An
   * empty set forces a no-op verdict (fail-open).
   */
  catalogIds: ReadonlySet<string>;
  /** The active profile's ensemble model ids (model + second + third), any tier. */
  configuredEnsemble: readonly string[];
  /** The active profile's `free_models` pool, in preference order. */
  configuredFreePool: readonly string[];
  /** Every distinct model id pinned in `tool_models`. */
  configuredToolModels: readonly string[];
  /**
   * Catalog ':free' ids that PASS the free-model requirements gate (the context
   * floor), in the catalog's own order. Computed by the caller with
   * filterFreeModels over the catalog — passed in so this core stays pure.
   */
  catalogFreeQualified: readonly string[];
  /** Models with a recorded FAILING benchmark — never adopted, dropped if present. */
  benchmarkFailed: ReadonlySet<string>;
  /** Upper bound on the recomputed free pool, so it can't grow without limit. */
  maxFreePool?: number;
}

export interface ReconcileVerdict {
  /** Configured ids (any tier) positively ABSENT from the live catalog. */
  deadModels: string[];
  /** The ':free' subset of deadModels — dropped from the recomputed pool. */
  deadFreeModels: string[];
  /** The paid subset of deadModels — WARNED about, never auto-replaced. */
  deadPaidModels: string[];
  /** Qualifying ':free' arrivals not already in the pool — adopted. */
  newFreeModels: string[];
  /** The recomputed free pool: existing (minus dead/failed) + new arrivals, capped. */
  newFreePool: string[];
  /** True iff newFreePool differs from configuredFreePool (drives the settings write). */
  freePoolChanged: boolean;
  /** One human-readable line per paid-model issue, for the user to act on. */
  paidWarnings: string[];
}

// Free models die often (daily rate-limit caps), so the rotation needs a DEEP
// bench of fallbacks — 50, not a dozen (USER 2026-07-15). Cost-safety holds at any
// size: only ':free' ids ever enter (isFreeSuffixModelId), and only models the
// benchmark has NOT failed (filterFreeModels drops benchmarkFailed). Newly-adopted
// models are validated by the $0 free-pool benchmark the reconcile fires on every
// pool change, and any that FAIL it are pruned on the next reconcile — so a bigger
// pool means more validated fallbacks, never more token-wasting garbage models.
const DEFAULT_MAX_FREE_POOL = 50;

// ── Pure core ───────────────────────────────────────────────────────────

/**
 * Assess the model situation. Pure: same input → same verdict, no IO.
 *
 * Fail-open on an empty catalog (fetch failed): everything looks "present", so
 * nothing is dropped and nothing is added — the run proceeds on the existing
 * config exactly as it would have without reconcile.
 */
export function computeReconcile(input: ReconcileInput): ReconcileVerdict {
  const {
    catalogIds,
    configuredEnsemble,
    configuredFreePool,
    configuredToolModels,
    catalogFreeQualified,
    benchmarkFailed,
    maxFreePool = DEFAULT_MAX_FREE_POOL,
  } = input;

  const empty: ReconcileVerdict = {
    deadModels: [],
    deadFreeModels: [],
    deadPaidModels: [],
    newFreeModels: [],
    newFreePool: [...configuredFreePool],
    freePoolChanged: false,
    paidWarnings: [],
  };

  // Fail-open: a cold/failed catalog fetch must never be read as "all models
  // died". Without this guard a transient network blip would wipe the pool.
  if (catalogIds.size === 0) return empty;

  // Dead = any configured model the live catalog no longer lists. A local
  // backend id (no '/') is never an OpenRouter model, so never "dead" here.
  const allConfigured = new Set<string>([
    ...configuredEnsemble,
    ...configuredFreePool,
    ...configuredToolModels,
  ]);
  const deadModels: string[] = [];
  for (const id of allConfigured) {
    if (!id.includes("/")) continue; // local / non-OpenRouter id — not assessable
    if (!catalogIds.has(id)) deadModels.push(id);
  }
  const deadSet = new Set(deadModels);
  const deadFreeModels = deadModels.filter(isFreeSuffixModelId);
  const deadPaidModels = deadModels.filter((id) => !isFreeSuffixModelId(id));

  // New = a qualified ':free' arrival not already pooled and not benchmark-failed.
  const pooled = new Set(configuredFreePool);
  const newFreeModels = catalogFreeQualified.filter(
    (id) =>
      isFreeSuffixModelId(id) && !pooled.has(id) && !benchmarkFailed.has(id),
  );

  // Recompute: keep the user's existing order first (their stated preference),
  // dropping dead + benchmark-failed entries, then append the new arrivals.
  // Defense in depth: the final .filter(isFreeSuffixModelId) makes it structurally
  // impossible for a non-':free' id (e.g. the $0 router pseudo-model
  // `openrouter/free`) to reach the pool the cost-safety chokepoint will send.
  const kept = configuredFreePool.filter(
    (id) => !deadSet.has(id) && !benchmarkFailed.has(id),
  );
  const newFreePool = [...kept, ...newFreeModels]
    .filter(isFreeSuffixModelId)
    .filter((id, i, a) => a.indexOf(id) === i)
    .slice(0, maxFreePool);

  const freePoolChanged =
    newFreePool.length !== configuredFreePool.length ||
    newFreePool.some((id, i) => id !== configuredFreePool[i]);

  const paidWarnings = deadPaidModels.map(
    (id) =>
      `configured paid model '${id}' is no longer in the OpenRouter catalog — ` +
      `run \`llm-ext-benchmark --update-all --paid\` to pick a replacement ` +
      `(paid models are never auto-adopted, to avoid unrequested spend).`,
  );

  return {
    deadModels,
    deadFreeModels,
    deadPaidModels,
    newFreeModels,
    newFreePool,
    freePoolChanged,
    paidWarnings,
  };
}

// ── Throttle math (pure) ────────────────────────────────────────────────

/** Default: reconcile at most once an hour. The catalog barely changes and the
 *  fetch, though $0, is not free of latency — a per-call fetch on a 50-file scan
 *  would add 50 round-trips for no new information. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 3_600_000;

/**
 * Should a full reconcile run now, given when it last ran? Pure — the caller
 * injects both timestamps. `lastRunMs === null` (never run) always returns true.
 * A non-finite / negative interval falls back to the default rather than
 * hammering the catalog.
 */
export function shouldReconcile(
  lastRunMs: number | null,
  nowMs: number,
  intervalMs: number = DEFAULT_RECONCILE_INTERVAL_MS,
): boolean {
  if (lastRunMs === null) return true;
  // 0 is a valid interval meaning "always" (nowMs - lastRunMs >= 0). Only a
  // NEGATIVE or non-finite interval is nonsense → fall back to the default.
  // This must agree with parseReconcileInterval, which also lets 0 through.
  const interval =
    Number.isFinite(intervalMs) && intervalMs >= 0
      ? intervalMs
      : DEFAULT_RECONCILE_INTERVAL_MS;
  return nowMs - lastRunMs >= interval;
}

/** Parse LLM_EXT_RECONCILE_INTERVAL_MS. `0` DISABLES throttling (reconcile every
 *  call — for tests/debugging); a bad value → the default. Empty/unset → default. */
export function parseReconcileInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RECONCILE_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RECONCILE_INTERVAL_MS;
  return n; // 0 is intentionally allowed → "always reconcile"
}

export const DISABLE_RECONCILE_ENV = "LLM_EXT_DISABLE_AUTO_RECONCILE";
export const RECONCILE_INTERVAL_ENV = "LLM_EXT_RECONCILE_INTERVAL_MS";

// ── Throttle-state file (shared by the MCP server AND the CLI) ───────────
// One tiny JSON file records when a full reconcile last ran. Both processes read
// it so that a CLI run right after an MCP run doesn't re-fetch the catalog, and
// vice-versa — they share the once-an-hour budget, just like the cooldown file.

export function reconcileStateFilePath(): string {
  return join(getConfigDir(), "last-reconcile.json");
}

/** Epoch ms of the last reconcile, or null if never / unreadable. */
export function readLastReconcileMs(): number | null {
  try {
    const raw = readFileSync(reconcileStateFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as { lastRunMs?: unknown };
    return typeof parsed.lastRunMs === "number" && Number.isFinite(parsed.lastRunMs)
      ? parsed.lastRunMs
      : null;
  } catch {
    return null; // missing / corrupt → treat as "never" (reconcile will run)
  }
}

/** Best-effort atomic write of the last-reconcile timestamp. Never throws — an
 *  unwritable config dir must not fail a tool call; it just means the throttle
 *  degrades to "reconcile every call". */
export function writeLastReconcileMs(nowMs: number): void {
  try {
    const path = reconcileStateFilePath();
    mkdirSync(getConfigDir(), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastRunMs: nowMs }), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* persistence is an optimisation, not a correctness requirement */
  }
}

// ── The IO-shell orchestrator ───────────────────────────────────────────

export interface ReconcileConfigured {
  /** Ensemble ids (any tier). */
  ensemble: string[];
  /** The active profile's free_models pool. */
  freePool: string[];
  /** Distinct tool_models values. */
  toolModels: string[];
}

export interface ReconcileDeps {
  now: () => number;
  env: NodeJS.ProcessEnv;
  /** When did a full reconcile last run? Injected so tests never touch disk. */
  readLastRunMs: () => number | null;
  writeLastRunMs: (ms: number) => void;
  /**
   * Fetch the live catalog. Returns EVERY id, plus the ':free' ids that pass the
   * requirements gate (context floor). A throw here is caught and treated as a
   * cold catalog (fail-open). Returning an empty `ids` set means the same.
   */
  fetchCatalog: () => Promise<{ ids: Set<string>; freeQualified: string[] }>;
  /** The active configuration, or null when the backend is not OpenRouter (no
   *  catalog to reconcile against) or no profile is resolved. */
  getConfigured: () => ReconcileConfigured | null;
  benchmarkFailed: () => Set<string>;
  /** Persist the recomputed free pool to settings AND update the in-memory pool
   *  the current run reads. Returns true iff a write actually happened. */
  applyFreePool: (pool: string[]) => boolean;
  /** Fire-and-forget the $0 free-pool benchmark to score a changed class. */
  launchFreeBench: (reason: string) => void;
  log: (msg: string) => void;
  maxFreePool?: number;
}

export interface ReconcileOutcome {
  /** "skipped" (throttled / disabled / not OpenRouter / cold catalog) or "ran". */
  outcome: "skipped" | "ran";
  reason: string | null;
  verdict: ReconcileVerdict | null;
}

/**
 * Assess the model situation and reconfigure the FREE class, at $0, before real
 * work. Called at the two runtime funnels (the MCP dispatch and the CLI mains),
 * so every skill / command / agent that wraps them inherits it.
 *
 * Contract, in order:
 *   1. env opt-out            → skip.
 *   2. throttled (< interval) → skip (the common case — one reconcile/hour).
 *   3. not OpenRouter / no profile → skip.
 *   4. catalog fetch fails / empty → record the timestamp (we DID look) and skip
 *      the effects: fail-open, the run proceeds on the existing config.
 *   5. otherwise: compute the verdict, and ONLY when the free class changed,
 *      write settings + launch the $0 benchmark; always surface paid warnings.
 *
 * Every effect is injected, so this is fully offline-testable. It never throws
 * into the caller — a reconcile failure must never break the tool the user ran.
 */
export async function reconcileModelsBeforeWork(
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  if (deps.env[DISABLE_RECONCILE_ENV] === "1") {
    return { outcome: "skipped", reason: "disabled via env", verdict: null };
  }
  const now = deps.now();
  const interval = parseReconcileInterval(deps.env[RECONCILE_INTERVAL_ENV]);
  if (!shouldReconcile(deps.readLastRunMs(), now, interval)) {
    return { outcome: "skipped", reason: "throttled", verdict: null };
  }
  const cfg = deps.getConfigured();
  if (!cfg) {
    return { outcome: "skipped", reason: "not openrouter / no profile", verdict: null };
  }

  let catalog: { ids: Set<string>; freeQualified: string[] };
  try {
    catalog = await deps.fetchCatalog();
  } catch {
    // Fail-open: record that we looked (so we don't hammer on a flapping network)
    // and leave the config untouched.
    deps.writeLastRunMs(now);
    return { outcome: "skipped", reason: "catalog fetch failed", verdict: null };
  }

  const verdict = computeReconcile({
    catalogIds: catalog.ids,
    configuredEnsemble: cfg.ensemble,
    configuredFreePool: cfg.freePool,
    configuredToolModels: cfg.toolModels,
    catalogFreeQualified: catalog.freeQualified,
    benchmarkFailed: deps.benchmarkFailed(),
    maxFreePool: deps.maxFreePool,
  });

  // We looked — bank the timestamp before the effects so a throwing effect can't
  // cause a re-fetch storm on the next call.
  deps.writeLastRunMs(now);

  // Persist + re-benchmark ONLY when the free class actually changed, and never
  // with an empty pool (applyFreePoolToSettings rejects that — an empty
  // free_models would break free_only).
  if (verdict.freePoolChanged && verdict.newFreePool.length > 0) {
    // The effects are wrapped, not trusted. This function's contract is "never
    // throws into the caller" — it runs as a PRE-FLIGHT on every work tool, so a
    // throw here fails the tool the user actually asked for, over a background
    // config refresh they never requested. The injected effects reach the real
    // world (settings.yaml, a spawned process); each is individually best-effort
    // internally, but the contract must hold even if a future dep forgets that.
    try {
      const wrote = deps.applyFreePool(verdict.newFreePool);
      if (wrote) {
        deps.log(
          `[llm-externalizer] Model reconcile: free pool updated — ` +
            `added [${verdict.newFreeModels.join(", ") || "none"}], ` +
            `dropped [${verdict.deadFreeModels.join(", ") || "none"}]. ` +
            `Launching a $0 benchmark to score the new class.\n`,
        );
        deps.launchFreeBench(
          `reconcile: +${verdict.newFreeModels.length}/-${verdict.deadFreeModels.length}`,
        );
      }
    } catch (err) {
      deps.log(
        `[llm-externalizer] Model reconcile: applying the free pool failed (continuing on the existing config): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  for (const w of verdict.paidWarnings) deps.log(`[llm-externalizer] ${w}\n`);

  return { outcome: "ran", reason: null, verdict };
}

// ── Shared catalog mapping ──────────────────────────────────────────────

/**
 * Map a fetched catalog to the reconcile's `fetchCatalog` result shape — the
 * id-set plus the requirements-qualified ':free' arrivals. ONE copy, used by
 * BOTH surfaces (index.ts's runModelReconcile and makeCliReconcileDeps below):
 * they fetch through different clients (the MCP's cached fetchOpenRouterModels
 * vs the CLI's fetchProgrammingModels), but the QUALIFICATION rules must be the
 * same list, or the two surfaces silently reconcile different free classes.
 */
export function catalogForReconcile(
  cat: ReadonlyArray<{ id: string } & FreeModelCatalogEntry>,
): { ids: Set<string>; freeQualified: string[] } {
  const ids = new Set(cat.map((m) => m.id));
  const catalogById = new Map(cat.map((m) => [m.id, m]));
  const freeIds = cat.map((m) => m.id).filter(isFreeSuffixModelId);
  const freeQualified = filterFreeModels(freeIds, catalogById, benchmarkFailedModels());
  return { ids, freeQualified };
}

// ── CLI-side deps factory ───────────────────────────────────────────────
//
// The MCP server builds its own deps inline (it also updates in-memory state).
// The standalone CLI (cli.ts) is a separate process with no MCP state to touch —
// it reads/writes settings.yaml and re-reads the pool per command — so its deps
// are entirely settings-driven and live here, shared by every CLI entry that
// wants the pre-flight. Only CLI-safe modules are imported (never index.ts).

/** Build the reconcile deps for a standalone CLI process. Effects: fetch the full
 *  catalog, read the persisted pool, write settings.yaml, fire the $0 benchmark. */
export function makeCliReconcileDeps(): ReconcileDeps {
  return {
    now: () => Date.now(),
    env: process.env,
    readLastRunMs: readLastReconcileMs,
    writeLastRunMs: writeLastReconcileMs,
    // fetchProgrammingModels with no category = the full catalog.
    fetchCatalog: async () => catalogForReconcile(await fetchProgrammingModels()),
    getConfigured: (): ReconcileConfigured | null => {
      const s = loadSettings();
      const active = s?.profiles[s.active];
      if (!s || !active) return null;
      const r = resolveProfile(s.active, active);
      if (r.protocol !== "openrouter_api") return null; // only OpenRouter has a catalog
      const ensemble = [r.model, r.secondModel, r.thirdModel].filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
      const toolModels = Object.values(r.toolModels ?? {}).filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
      // The PERSISTED free_models, not resolveProfile's (which is empty on a paid
      // profile) — so the change-detection compares against what's on disk.
      const rawFree = active.free_models;
      const freePool = Array.isArray(rawFree)
        ? rawFree.filter((v): v is string => typeof v === "string")
        : [];
      return { ensemble, freePool, toolModels };
    },
    benchmarkFailed: () => benchmarkFailedModels(),
    applyFreePool: (pool) => {
      try {
        const s = loadSettings();
        if (!s) return false;
        applyFreePoolToSettings(getSettingsPath(), s.active, pool);
        return true; // the command re-reads settings.yaml, so no in-memory update needed
      } catch (err) {
        process.stderr.write(
          `[llm-externalizer] Model reconcile: could not write free pool: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        return false;
      }
    },
    launchFreeBench: (reason) => {
      maybeTriggerFreePoolBench({
        activeProfile: loadSettings()?.active ?? "unknown",
        freeOnlyActive: true,
        freeOnlyWasOn: null,
        log: (m) => process.stderr.write(m),
        force: true,
        env: { ...process.env, LLM_EXT_AUTO_BENCH_REASON: reason },
      });
    },
    log: (m) => process.stderr.write(m),
  };
}
