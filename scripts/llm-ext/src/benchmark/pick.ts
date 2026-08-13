/**
 * Top-N model picker + atomic settings.yaml writer for the benchmark
 * CLI. Read by `llm-ext-benchmark --pick-top-n N [--apply-profile P]`.
 *
 * Selection algorithm (deterministic, no LLM in the loop):
 *
 *   1. Keep only successful runs (ok === true).
 *   2. Drop baselines — they're for comparison only, not auto-selection.
 *   3. Drop anything below `minMeanF1` (defaults to 0.95 — the keyword
 *      classifier should be near-perfect on the 71-function fixture).
 *   4. Drop anything whose schema-compliance flag is false. The ensemble
 *      relies on strict JSON; loose responses break downstream parsers.
 *   5. Sort by meanF1 descending. Ties broken by actualCost ascending,
 *      then by latencyMs ascending. Stable on remaining ties.
 *   6. Take the first N. Hard error if fewer than N qualify.
 *
 * The cost rule (< $1/M input AND < $1/M output, strictly less) is
 * enforced earlier in `discover.qualify()` so it isn't repeated here —
 * anything that made it to the cache already passes the filter, unless
 * it was --include'd as a baseline (filtered out in step 2).
 */

import { readFileSync, writeFileSync, renameSync as renameSyncCb, existsSync } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { registeredTools } from "../model-qualification/registry.js";
import { DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M } from "../config.js";

export interface CachedResult {
  modelId: string;
  name: string;
  isBaseline: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  supportsStructured: boolean;
  supportsReasoning: boolean;
  ok: boolean;
  error?: string;
  httpStatus?: number | null;
  pass?: boolean;
  meanF1?: number;
  kw1F1?: number;
  kw2F1?: number;
  kw3F1?: number;
  schemaCompliant?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  latencyMs: number;
  actualCost?: number;
  providerFinishReason?: string;
  hallucinatedNames?: string[];
}

export interface CachedReport {
  timestamp: string;
  keywords: string[];
  groundTruth: Record<string, number>;
  roster: { candidates: string[]; baselines: string[] };
  results: CachedResult[];
}

export interface PickedModel {
  modelId: string;
  meanF1: number;
  actualCost: number;
  latencyMs: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
}

export interface PickOptions {
  topN: number;
  minMeanF1: number;
  /** Require schemaCompliant === true to qualify. Default true. */
  requireSchema: boolean;
}

export const DEFAULT_PICK_OPTIONS: PickOptions = {
  topN: 3,
  minMeanF1: 0.95,
  requireSchema: true,
};

/** Apply the selection algorithm. Pure function; no IO. Throws when
 *  fewer than `topN` results qualify so the caller can decide whether to
 *  fall back to baselines, lower the threshold, or abort. */
export function pickTopN(results: readonly CachedResult[], opts: PickOptions = DEFAULT_PICK_OPTIONS): PickedModel[] {
  const survivors: PickedModel[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    if (r.isBaseline) continue;
    const f1 = r.meanF1 ?? 0;
    if (f1 < opts.minMeanF1) continue;
    if (opts.requireSchema && r.schemaCompliant === false) continue;
    survivors.push({
      modelId: r.modelId,
      meanF1: f1,
      actualCost: r.actualCost ?? 0,
      latencyMs: r.latencyMs ?? 0,
      inputDollarsPerMillion: r.inputDollarsPerMillion,
      outputDollarsPerMillion: r.outputDollarsPerMillion,
    });
  }
  survivors.sort((a, b) => {
    if (b.meanF1 !== a.meanF1) return b.meanF1 - a.meanF1;
    if (a.actualCost !== b.actualCost) return a.actualCost - b.actualCost;
    return a.latencyMs - b.latencyMs;
  });
  if (survivors.length < opts.topN) {
    throw new Error(
      `pickTopN: only ${survivors.length} model(s) cleared minMeanF1=${opts.minMeanF1} + schema gate, ` +
        `need ${opts.topN}. Either lower --min-f1 or rerun the benchmark with more candidates.`,
    );
  }
  return survivors.slice(0, opts.topN);
}

/**
 * The ':free' models that PASSED a keyword sweep, best-first — exactly the pool
 * `--apply-free-pool` writes into `free_models`.
 *
 * Extracted (P3) because `--update-all --free` needs the SAME rule: two spellings of
 * "which free models earned their place in the pool" would drift, and the drift would
 * be invisible until one command wrote a pool the other considered wrong.
 *
 * Only ':free' ids are eligible: a $0 open-beta model with no ':free' suffix is
 * benchmarkable, but config.ts REJECTS it inside `free_models` under free_only — so
 * pinning one would brick the very config this maintains (see applyFreePoolToSettings).
 */
export function passingFreePoolIds(results: readonly CachedResult[]): string[] {
  return results
    .filter(
      (r) =>
        r.ok && r.pass === true && r.schemaCompliant !== false && r.modelId.endsWith(":free"),
    )
    .sort((a, b) => (b.meanF1 ?? 0) - (a.meanF1 ?? 0) || a.latencyMs - b.latencyMs)
    .map((r) => r.modelId);
}

/** Read the JSON sidecar produced by `llm-ext-benchmark` (always written
 *  to ~/.llm-externalizer/benchmark-results.json). Throws on missing or
 *  malformed file — the caller can catch and tell the user to run a
 *  fresh benchmark first. */
export function loadCachedReport(path: string): CachedReport {
  if (!existsSync(path)) {
    throw new Error(
      `No cached benchmark results at ${path}. Run \`llm-ext-benchmark\` first (without --from-cache).`,
    );
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cached results at ${path} are not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as CachedReport).results)) {
    throw new Error(`Cached results at ${path} missing 'results' array.`);
  }
  return parsed as CachedReport;
}

/** Build a settings.yaml ensemble block from a top-N pick. Returns the
 *  fragment as a YAML string the operator can paste into settings.yaml
 *  manually if `--apply-profile` isn't used. */
export function renderEnsembleBlock(profileName: string, picks: readonly PickedModel[]): string {
  if (picks.length < 1) throw new Error("renderEnsembleBlock: need at least one pick");
  const block: Record<string, unknown> = {
    mode: picks.length >= 2 ? "remote-ensemble" : "remote",
    api: "openrouter-remote",
    model: picks[0].modelId,
  };
  if (picks.length >= 2) block.second_model = picks[1].modelId;
  if (picks.length >= 3) block.third_model = picks[2].modelId;
  block.api_key = "$OPENROUTER_API_KEY";
  const wrapped = { [profileName]: block };
  // Indent 2 spaces so the block lines up under `profiles:` when pasted.
  return yamlStringify(wrapped, { indent: 2 });
}

/** Atomic settings.yaml mutation: load YAML → update profile's three
 *  model slots → write to a tmp file → rename over original. The
 *  rest of the YAML (other profiles, `active:`, comments) is preserved
 *  by-key — the YAML library re-emits anything we didn't change.
 *  Returns the old values so the caller can show a diff. */
export interface YamlMutationResult {
  oldEnsemble: { model: string; second_model?: string; third_model?: string };
  newEnsemble: { model: string; second_model?: string; third_model?: string };
}

/** The narrow shape every writer below mutates. */
type SettingsRoot = { active?: string; profiles?: Record<string, Record<string, unknown>> };

/**
 * Shared load+validate step for EVERY settings writer in this file: existsSync
 * guard → yamlParse with a clear error → top-level-object guard → profiles-map
 * guard. One spelling of these four errors, so a new writer cannot drift from
 * the established (and tested) messages.
 */
function loadSettingsRoot(settingsPath: string): SettingsRoot {
  if (!existsSync(settingsPath)) {
    throw new Error(`settings.yaml not found at ${settingsPath}`);
  }
  const raw = readFileSync(settingsPath, "utf-8");
  let doc: unknown;
  try {
    doc = yamlParse(raw);
  } catch (err) {
    throw new Error(`settings.yaml at ${settingsPath} is not valid YAML: ${(err as Error).message}`, { cause: err });
  }
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`settings.yaml at ${settingsPath} must be a YAML object at the top level.`);
  }
  const root = doc as SettingsRoot;
  if (!root.profiles || typeof root.profiles !== "object") {
    throw new Error(`settings.yaml at ${settingsPath} missing 'profiles' map.`);
  }
  return root;
}

/**
 * Shared load+validate step for every writer that mutates an EXISTING named
 * profile: loadSettingsRoot() plus the named-profile guard. (addProfileToSettings
 * below adds a brand-new profile, so it uses loadSettingsRoot() directly — the
 * named-profile guard would reject the exact thing it's there to create.)
 */
function loadProfileForMutation(
  settingsPath: string,
  profileName: string,
): { root: SettingsRoot; profile: Record<string, unknown> } {
  const root = loadSettingsRoot(settingsPath);
  const profile = root.profiles![profileName];
  if (!profile || typeof profile !== "object") {
    throw new Error(
      `settings.yaml at ${settingsPath} has no profile named '${profileName}'. ` +
        `Existing profiles: ${Object.keys(root.profiles!).join(", ")}.`,
    );
  }
  return { root, profile };
}

/**
 * Shared atomic write: serialize → tmp file → rename over the original. rename is
 * atomic on POSIX; on Windows it is atomic too when both paths sit on the same
 * volume — which they always do here (the tmp lives in the target's own dir). A
 * crash mid-write therefore leaves the ORIGINAL settings.yaml intact, never a
 * half-written one: these writers run unattended (CLI/cron), so a torn config file
 * would silently break every later tool call.
 */
function writeSettingsAtomic(settingsPath: string, root: SettingsRoot): void {
  const newRaw = yamlStringify(root, { indent: 2 });
  const tmp = settingsPath + ".tmp." + process.pid;
  writeFileSync(tmp, newRaw, "utf-8");
  renameSyncCb(tmp, settingsPath);
}

export function applyPicksToSettings(
  settingsPath: string,
  profileName: string,
  picks: readonly PickedModel[],
): YamlMutationResult {
  if (picks.length < 1) throw new Error("applyPicksToSettings: need at least one pick");
  const { root, profile } = loadProfileForMutation(settingsPath, profileName);
  const oldEnsemble: YamlMutationResult["oldEnsemble"] = {
    model: typeof profile.model === "string" ? profile.model : "",
    ...(typeof profile.second_model === "string" ? { second_model: profile.second_model } : {}),
    ...(typeof profile.third_model === "string" ? { third_model: profile.third_model } : {}),
  };
  // Update in-place; preserve every other key (mode, api, api_key, url,
  // timeout, etc.).
  profile.mode = picks.length >= 2 ? "remote-ensemble" : "remote";
  profile.model = picks[0].modelId;
  if (picks.length >= 2) profile.second_model = picks[1].modelId;
  else delete profile.second_model;
  if (picks.length >= 3) profile.third_model = picks[2].modelId;
  else delete profile.third_model;

  writeSettingsAtomic(settingsPath, root);
  return {
    oldEnsemble,
    newEnsemble: {
      model: picks[0].modelId,
      ...(picks.length >= 2 ? { second_model: picks[1].modelId } : {}),
      ...(picks.length >= 3 ? { third_model: picks[2].modelId } : {}),
    },
  };
}

// ── Per-tool model writer (TRDD-828238b5 A7-P2) ──────────────────────────────
//
// READ-ONLY-MCP GUARDRAIL: this function MUTATES settings.yaml and MUST NEVER be
// called from an MCP tool handler. The MCP surface stays incapable of rewriting
// its own config; only a human-run CLI command or a scheduled cron may adopt the
// auto-replace planner's advisory recommendation by calling this. The advisory
// half (model-qualification/auto-replace.ts) computes the recommendation but
// never writes — this is the deliberate write step kept out of the server.

/** Result of writing a per-tool model override (mirrors YamlMutationResult). */
export interface ToolModelMutationResult {
  profileName: string;
  tool: string;
  /** The tool's previous model in tool_models (empty string when unset). */
  oldModelId: string;
  newModelId: string;
}

/**
 * Atomically set ONE tool's `tool_models[tool]` entry on a named profile.
 * Copies applyPicksToSettings's safety pattern exactly: existsSync guard →
 * yamlParse with a clear error → top-level-object guard → profiles-map guard →
 * named-profile guard → tmp+rename atomic write. Every OTHER key on the profile
 * (mode, api, model, api_key, …) and every OTHER tool_models entry is preserved
 * by-key — the YAML library re-emits anything we didn't touch.
 *
 * Validates that `tool` is a registered LLM-using tool (registeredTools()) and
 * that `modelId` is a non-empty string, throwing otherwise — a typo'd tool name
 * or an empty model would silently break per-tool resolution, so it fails fast.
 */
export function applyToolModelToSettings(
  settingsPath: string,
  profileName: string,
  tool: string,
  modelId: string,
): ToolModelMutationResult {
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("applyToolModelToSettings: modelId must be a non-empty string");
  }
  const known = registeredTools();
  if (!known.includes(tool)) {
    throw new Error(
      `applyToolModelToSettings: unknown tool '${tool}'. ` +
        `Registered LLM-using tools: ${known.join(", ")}.`,
    );
  }
  const { root, profile } = loadProfileForMutation(settingsPath, profileName);
  // Read the existing tool_models map defensively: a malformed value (null, a
  // scalar, an array) must NOT crash — treat it as empty so we still write a
  // valid map. Preserve every existing tool entry by spreading the old object.
  const existing = profile.tool_models;
  const oldToolModels: Record<string, string> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, string>) }
      : {};
  const oldModelId = typeof oldToolModels[tool] === "string" ? oldToolModels[tool] : "";

  profile.tool_models = { ...oldToolModels, [tool]: modelId };

  writeSettingsAtomic(settingsPath, root);
  return { profileName, tool, oldModelId, newModelId: modelId };
}

// ── free_models pool writer (P1 zero-token model pipeline) ────────────────────
//
// READ-ONLY-MCP GUARDRAIL — with ONE deliberate, narrow carve-out.
//
// The general invariant still holds: an MCP TOOL HANDLER must never rewrite config
// as a side-effect of the user's requested action, and the tool_models / ensemble
// writers (applyToolModelToSettings / applyPicksToSettings) are STILL never reachable
// from the MCP — only the CLI (`--update-all --apply`) writes those.
//
// The carve-out (TRDD-8b6b3646 autoconfiguration): this function — and ONLY this one,
// the free_models pool writer — MAY be called by the auto-reconcile PRE-FLIGHT
// (model-reconcile.ts), which runs on both the MCP and CLI surfaces before work. It
// is safe precisely because it is the narrowest possible write: `free_models` only
// (never model/tool_models/api), `:free` ids only (enforced below — so $0), throttled
// to ≤1×/hour, and disable-able via LLM_EXT_DISABLE_AUTO_RECONCILE. It can neither
// select a paid model nor spend money, so it cannot do the harm the read-only rule
// exists to prevent. Adopting a PAID/cheaper model still requires the explicit CLI
// command. Before this, the free pool was hand-edited by the operator — which is why
// the free-pool commands used to end with "now go edit settings.yaml yourself".

/** Result of rewriting a profile's free_models pool. */
export interface FreePoolMutationResult {
  profileName: string;
  oldPool: string[];
  newPool: string[];
}

/**
 * Atomically REPLACE a named profile's `free_models` list. Every other key on the
 * profile (mode, api, model, tool_models, free_only, …) and every other profile is
 * preserved by-key.
 *
 * Fails fast when any id does not end in `:free`. This is NOT pedantry: config.ts's
 * validateProfile REJECTS a non-`:free` entry under `free_only`, so writing one here
 * would produce a settings.yaml that no longer loads — i.e. the writer would brick
 * the very config it is maintaining. Better to refuse at write time with a precise
 * message than to hand the user an unloadable file. (A zero-cost NON-`:free` model
 * such as an open-beta id is still benchmarkable via --bench-free-pool's catalog
 * price check; it just cannot be pinned into the `free_models` list.)
 *
 * Duplicates are collapsed (first occurrence wins) so a re-run is idempotent.
 */
export function applyFreePoolToSettings(
  settingsPath: string,
  profileName: string,
  modelIds: readonly string[],
): FreePoolMutationResult {
  if (modelIds.length < 1) {
    throw new Error("applyFreePoolToSettings: need at least one model id (an empty free_models pool would break free_only)");
  }
  const bad = modelIds.filter((id) => typeof id !== "string" || !id.endsWith(":free"));
  if (bad.length > 0) {
    throw new Error(
      `applyFreePoolToSettings: every free_models entry MUST end with ':free' — ` +
        `settings.yaml validation rejects anything else under free_only. Offending: ${bad.join(", ")}.`,
    );
  }
  const newPool = [...new Set(modelIds)];
  const { root, profile } = loadProfileForMutation(settingsPath, profileName);
  const existing = profile.free_models;
  const oldPool: string[] = Array.isArray(existing)
    ? existing.filter((v): v is string => typeof v === "string")
    : [];

  profile.free_models = newPool;

  writeSettingsAtomic(settingsPath, root);
  return { profileName, oldPool, newPool };
}

// ── New-arrival adoption writer (P1 zero-token model pipeline) ────────────────
//
// READ-ONLY-MCP GUARDRAIL: as above — CLI/cron only, NEVER an MCP tool handler.
// This is the missing scripted half of `--new-arrivals`: the discover command used
// to end with "if it wins, edit settings.yaml by hand", so adopting a new model
// always cost a human (or an agent) a manual edit. Adoption is now one CLI call.

/** The three ensemble slots a model can be adopted into. */
export type EnsembleSlot = "model" | "second_model" | "third_model";
export const ENSEMBLE_SLOTS: readonly EnsembleSlot[] = ["model", "second_model", "third_model"];

/** Result of adopting a model into one ensemble slot. */
export interface EnsembleSlotMutationResult {
  profileName: string;
  slot: EnsembleSlot;
  /** The slot's previous model (empty string when the slot was unset). */
  oldModelId: string;
  newModelId: string;
}

/**
 * Atomically set ONE ensemble slot (`model` / `second_model` / `third_model`) on a
 * named profile. Copies applyPicksToSettings's safety pattern exactly, but writes a
 * single slot instead of a whole top-3 — that is the shape new-arrival adoption
 * needs (swap ONE incumbent for ONE arrival, leave the rest of a working ensemble
 * alone).
 *
 * Refuses to fill `second_model`/`third_model` on a non-ensemble profile: those keys
 * are IGNORED unless `mode: remote-ensemble`, so writing one would report success
 * while changing nothing the runtime reads — a silent no-op, which is the exact
 * failure class the fail-fast rule exists to prevent. The caller must switch the
 * profile's mode deliberately (that is a real decision, not a side effect).
 */
export function applyEnsembleSlotToSettings(
  settingsPath: string,
  profileName: string,
  slot: EnsembleSlot,
  modelId: string,
): EnsembleSlotMutationResult {
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("applyEnsembleSlotToSettings: modelId must be a non-empty string");
  }
  if (!ENSEMBLE_SLOTS.includes(slot)) {
    throw new Error(
      `applyEnsembleSlotToSettings: unknown slot '${slot}'. Valid slots: ${ENSEMBLE_SLOTS.join(", ")}.`,
    );
  }
  const { root, profile } = loadProfileForMutation(settingsPath, profileName);
  if (slot !== "model" && profile.mode !== "remote-ensemble") {
    throw new Error(
      `applyEnsembleSlotToSettings: profile '${profileName}' has mode '${String(profile.mode)}' — ` +
        `'${slot}' is only read under mode 'remote-ensemble', so writing it would silently do nothing. ` +
        `Switch the profile to remote-ensemble first, or adopt into 'model'.`,
    );
  }
  const oldModelId = typeof profile[slot] === "string" ? (profile[slot] as string) : "";
  profile[slot] = modelId;

  writeSettingsAtomic(settingsPath, root);
  return { profileName, slot, oldModelId, newModelId: modelId };
}

// ── New-profile writer (`scan_local_llm_services --pick N`) ─────────────────
//
// Unlike every writer above (which mutate ONE field on an EXISTING profile),
// this one ADDS a brand-new profile section — the whole point of the
// `scan_local_llm_services` command — and optionally activates it. It only
// ever runs when the user has explicitly picked a numbered entry from that
// command's scan list; it is never called on its own.

/** Result of adding (or overwriting) a profile section. */
export interface NewProfileMutationResult {
  profileName: string;
  /** false when a profile with this name already existed and was overwritten. */
  created: boolean;
  activated: boolean;
}

/**
 * Atomically ADD a brand-new named profile to settings.yaml (or overwrite an
 * existing one with the same name), and optionally set it as the active
 * profile. Every other profile and every other top-level key is preserved
 * by-key — same tmp+rename atomicity as every other writer in this file.
 */
export function addProfileToSettings(
  settingsPath: string,
  profileName: string,
  profile: Record<string, unknown>,
  opts: { setActive?: boolean } = {},
): NewProfileMutationResult {
  if (typeof profileName !== "string" || profileName.length === 0) {
    throw new Error("addProfileToSettings: profileName must be a non-empty string");
  }
  const root = loadSettingsRoot(settingsPath);
  const created = !(profileName in root.profiles!);
  root.profiles![profileName] = profile;
  if (opts.setActive) root.active = profileName;

  writeSettingsAtomic(settingsPath, root);
  return { profileName, created, activated: opts.setActive === true };
}

// ── Dynamic default-profile selectors + updaters (owner directive) ──────────
//
// The `ensemble` default profile: top 3 PAID models whose input AND output
// price are BOTH strictly under the ceiling (default
// DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M, overridable via the settings.yaml
// global `ensemble_price_ceiling_usd_per_million` key — see config.ts's
// getEnsemblePriceCeiling). Ranked by quality (meanF1) among the ceiling
// survivors, cost/latency as tiebreakers — same shape as pickTopN, but the
// gate is PRICE, not a meanF1 floor.

export function pickEnsembleByPriceCeiling(
  results: readonly CachedResult[],
  opts: { priceCeilingUsdPerM?: number; requireSchema?: boolean; topN?: number } = {},
): PickedModel[] {
  const ceiling = opts.priceCeilingUsdPerM ?? DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M;
  const requireSchema = opts.requireSchema ?? true;
  const topN = opts.topN ?? 3;
  const survivors: PickedModel[] = [];
  for (const r of results) {
    if (!r.ok || r.isBaseline) continue;
    // The ensemble default profile is a PAID pool by construction — a ':free'
    // id belongs to the `free` default profile, never here.
    if (r.modelId.endsWith(":free")) continue;
    if (requireSchema && r.schemaCompliant === false) continue;
    if (!(r.inputDollarsPerMillion < ceiling && r.outputDollarsPerMillion < ceiling)) continue;
    survivors.push({
      modelId: r.modelId,
      meanF1: r.meanF1 ?? 0,
      actualCost: r.actualCost ?? 0,
      latencyMs: r.latencyMs ?? 0,
      inputDollarsPerMillion: r.inputDollarsPerMillion,
      outputDollarsPerMillion: r.outputDollarsPerMillion,
    });
  }
  survivors.sort((a, b) => {
    if (b.meanF1 !== a.meanF1) return b.meanF1 - a.meanF1;
    if (a.actualCost !== b.actualCost) return a.actualCost - b.actualCost;
    return a.latencyMs - b.latencyMs;
  });
  // Return what the catalog actually offers rather than throwing below topN.
  // applyPicksToSettings DERIVES the profile's mode from the pick count (3 →
  // remote-ensemble with all slots, 1 → remote), so a short list is a valid,
  // self-consistent profile — whereas throwing would leave the profile
  // unpopulated and re-trigger the benchmark on the next command. Callers that
  // genuinely require 3 check the length themselves. Same contract as pickTopN's
  // consumers in index.ts, which derive topN from the slots the profile runs.
  return survivors.slice(0, topN);
}

/**
 * Pick the single best `mass-scout` model: ultra-low cost (input+output price
 * ascending is the primary sort key), quality as the tiebreaker. NEVER a
 * ':free' id — mass-scouting fires thousands of requests and would be
 * rate-limited on a free tier; this filter is enforced in CODE (not merely
 * documented) so a caller cannot accidentally hand back a free id.
 */
export function pickMassScoutModel(
  results: readonly CachedResult[],
  opts: { requireSchema?: boolean } = {},
): PickedModel {
  const requireSchema = opts.requireSchema ?? true;
  const survivors: PickedModel[] = [];
  for (const r of results) {
    if (!r.ok || r.isBaseline) continue;
    if (r.modelId.endsWith(":free")) continue; // hard rule — never a free id
    if (requireSchema && r.schemaCompliant === false) continue;
    survivors.push({
      modelId: r.modelId,
      meanF1: r.meanF1 ?? 0,
      actualCost: r.actualCost ?? 0,
      latencyMs: r.latencyMs ?? 0,
      inputDollarsPerMillion: r.inputDollarsPerMillion,
      outputDollarsPerMillion: r.outputDollarsPerMillion,
    });
  }
  survivors.sort((a, b) => {
    const costA = a.inputDollarsPerMillion + a.outputDollarsPerMillion;
    const costB = b.inputDollarsPerMillion + b.outputDollarsPerMillion;
    if (costA !== costB) return costA - costB;
    return b.meanF1 - a.meanF1;
  });
  if (survivors.length === 0) {
    throw new Error(
      "pickMassScoutModel: no non-':free' candidate cleared the schema gate.",
    );
  }
  // Defense in depth — the loop above already excludes ':free' ids, but a
  // hard-fail assertion here means a future refactor of the loop can never
  // silently reintroduce a free selection for mass-scout.
  if (survivors[0].modelId.endsWith(":free")) {
    throw new Error(
      `pickMassScoutModel: refusing to select ':free' model '${survivors[0].modelId}' — ` +
        `mass-scout must never use a free-tier model (rate-limit risk at scale).`,
    );
  }
  return survivors[0];
}

// Default-profile UPDATERS — thin wrappers that reuse the EXISTING atomic
// writers above, always targeting the exact machine-owned profile name. This
// IS the ownership invariant: applyFreePoolToSettings / applyPicksToSettings /
// applyEnsembleSlotToSettings each mutate ONLY the named profile object
// in-place (loadProfileForMutation) and re-serialize the rest of the document
// untouched by-key, so a user-authored profile elsewhere in settings.yaml can
// never be reached by these calls.

/** Repopulate the `free` default profile's free_models pool. */
export function updateFreeDefaultProfile(
  settingsPath: string,
  freeModelIds: readonly string[],
): FreePoolMutationResult {
  return applyFreePoolToSettings(settingsPath, "free", freeModelIds);
}

/** Repopulate the `ensemble` default profile's top-3 model slots. */
export function updateEnsembleDefaultProfile(
  settingsPath: string,
  picks: readonly PickedModel[],
): YamlMutationResult {
  return applyPicksToSettings(settingsPath, "ensemble", picks);
}

/** Repopulate the `mass-scout` default profile's single model slot. */
export function updateMassScoutDefaultProfile(
  settingsPath: string,
  pick: PickedModel,
): EnsembleSlotMutationResult {
  if (pick.modelId.endsWith(":free")) {
    throw new Error(
      `updateMassScoutDefaultProfile: refusing to write ':free' model '${pick.modelId}' into ` +
        `mass-scout — mass-scout must never use a free-tier model (rate-limit risk at scale).`,
    );
  }
  return applyEnsembleSlotToSettings(settingsPath, "mass-scout", "model", pick.modelId);
}
