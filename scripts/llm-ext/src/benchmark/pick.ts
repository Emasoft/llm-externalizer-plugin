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
 * The cost rule (input AND output each <= the resolved ensemble price
 * ceiling, USER "one ceiling, <=") is enforced earlier in
 * `discover.qualify()` so it isn't repeated here — anything that made it
 * to the cache already passes the filter, unless it was --include'd as a
 * baseline (filtered out in step 2).
 */

import { readFileSync, writeFileSync, renameSync as renameSyncCb, existsSync, mkdirSync, rmSync, statSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify, parseDocument, Scalar, isMap as yamlIsMap, isScalar as yamlIsScalar, YAMLMap } from "yaml";

import { registeredTools } from "../model-qualification/registry.js";
// S5 (fix-queue review): only for the "could not persist the migration
// stamp" notice's path text below — migrateProfileSections still receives
// readStamp/writeStamp via opts, so this does not create a new coupling to
// how the stamp is actually stored, only to where the reader can find it.
import { dynamicProfilesStatePath } from "../default-profiles-state.js";
import {
  API_PRESETS,
  builtinProfileType,
  DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M,
  DYNAMIC_GENERATED_KEYS,
  DYNAMIC_PROFILE_NAMES,
  DYNAMIC_USER_OWNED_KEYS,
  GENERATED_MARKER,
  getConfigDir,
  inferProfileType,
  PROFILE_TYPE_STEP,
  profileTypeFieldIssues,
  isMarkedProfileName,
  orJevProfile,
  PLACEHOLDER_MODEL_ID,
  profileSectionMarkerState,
  resolveEnvValue,
  unpopulatedFreeProfile,
  unpopulatedPaidProfile,
  unpopulatedLocalProfile,
  unpopulatedDefaultProfile,
  validateClassifierProfile,
  withinPriceCeiling,
  type DynamicProfileName,
  type MarkedProfileName,
  type Profile,
  type ProfileType,
} from "../config.js";

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
 *  model slots → write to a tmp file → rename over original.
 *  Returns the old values so the caller can show a diff. */
export interface YamlMutationResult {
  oldEnsemble: { model: string; second_model?: string; third_model?: string };
  newEnsemble: { model: string; second_model?: string; third_model?: string };
}

/** The narrow shape every writer below reads from (a plain snapshot — never
 *  mutated directly; mutations go through `handle.doc.setIn`/`deleteIn`). */
type SettingsRoot = { active?: string; profiles?: Record<string, Record<string, unknown>> };

/**
 * A loaded settings.yaml: the live `yaml` Document (edited in place via
 * `setIn`/`deleteIn` so comments, blank lines and anchors survive) plus a
 * plain-object snapshot (`root`) used only for READING old values / running
 * guards. Never mutate `root` directly — it is not what gets written.
 */
export interface SettingsHandle {
  doc: ReturnType<typeof parseDocument>;
  root: SettingsRoot;
}

/**
 * Shared load+validate step for EVERY settings writer in this file: existsSync
 * guard → parseDocument with a clear error → top-level-object guard → profiles-map
 * guard. One spelling of these four errors, so a new writer cannot drift from
 * the established (and tested) messages.
 */
function loadSettingsRoot(settingsPath: string): SettingsHandle {
  if (!existsSync(settingsPath)) {
    throw new Error(`settings.yaml not found at ${settingsPath}`);
  }
  const raw = readFileSync(settingsPath, "utf-8");
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`settings.yaml at ${settingsPath} is not valid YAML: ${doc.errors[0].message}`, {
      cause: doc.errors[0],
    });
  }
  const root = doc.toJS() as SettingsRoot;
  if (typeof root !== "object" || root === null) {
    throw new Error(`settings.yaml at ${settingsPath} must be a YAML object at the top level.`);
  }
  if (!root.profiles || typeof root.profiles !== "object") {
    throw new Error(`settings.yaml at ${settingsPath} missing 'profiles' map.`);
  }
  return { doc, root };
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
): { handle: SettingsHandle; profile: Record<string, unknown> } {
  const handle = loadSettingsRoot(settingsPath);
  const profile = handle.root.profiles![profileName];
  if (!profile || typeof profile !== "object") {
    throw new Error(
      `settings.yaml at ${settingsPath} has no profile named '${profileName}'. ` +
        `Existing profiles: ${Object.keys(handle.root.profiles!).join(", ")}.`,
    );
  }
  return { handle, profile };
}

/**
 * Shared atomic write: serialize the live Document (edited in place via
 * `setIn`/`deleteIn`, so every comment, blank line and anchor the operator
 * wrote by hand survives) → tmp file → rename over the original. rename is
 * atomic on POSIX; on Windows it is atomic too when both paths sit on the same
 * volume — which they always do here (the tmp lives in the target's own dir). A
 * crash mid-write therefore leaves the ORIGINAL settings.yaml intact, never a
 * half-written one: these writers run unattended (CLI/cron), so a torn config file
 * would silently break every later tool call.
 */
function writeSettingsAtomic(settingsPath: string, handle: SettingsHandle): void {
  const newRaw = handle.doc.toString();
  const tmp = settingsPath + ".tmp." + process.pid;
  writeFileSync(tmp, newRaw, "utf-8");
  renameSyncCb(tmp, settingsPath);
}

/**
 * P6b-fix2 B-1: the ONE refusal every settings writer in this file shares.
 *
 * `profiles.free` / `profiles.paid` are GENERATED sections with exactly one
 * writer — writeDynamicProfileSection, which holds `<cfg>/settings.write.lock`,
 * stamps the generated marker and backs up a hand-authored section before
 * overwriting it. The writers below do none of those three things, so letting
 * any of them target a dynamic name is a SECOND, lockless engine writing the
 * same section: two writers interleave on one settings.yaml, and whatever this
 * one wrote loses its marker and is overwritten by the maintainer on the next
 * dispatch anyway. Only `applyFreePoolToSettings` carried this guard after
 * P6b-fix; the other three were still reachable from documented
 * `llm-ext-benchmark` commands on the SHIPPED DEFAULT config.
 *
 * Throwing (rather than returning a result) is deliberate: these functions
 * return a mutation RESULT, so there is no "nothing happened" value to return,
 * and a silent no-op would report a write that never occurred. The CLI refuses
 * this case UP FRONT (benchmark/index.ts's refuseGeneratedProfileTarget), so a
 * throw here is the last line of defence, never the user-facing path.
 */
function refuseDynamicProfileWrite(writer: string, profileName: string): void {
  // PT-04: `scouting` is marked and written only through writeDynamicProfileSection too, so a lockless second writer must be refused for it as well.
  if (!isMarkedProfileName(profileName)) return;
  throw new Error(
    `${writer}: '${profileName}' is a GENERATED ${profileName === "scouting" ? "" : "dynamic "}profile — its section is ` +
      `written only by writeDynamicProfileSection, under the settings write lock. ` +
      (profileName === "scouting"
        ? `Use 'llm-ext benchmark scout-accuracy' instead.`
        : `Use 'llm-ext-benchmark --populate-default-profile ${profileName}' instead.`),
  );
}

/**
 * PT-04: delete from `profiles.<name>` every key outside the closed set (GENERATED + USER-OWNED),
 * under the settings write lock; returns the removed keys. WHY: writeDynamicProfileSection leaves
 * the keys it does not own, and after it replaced a section it did not write (backup taken) a
 * stray key (the old unmarked `scouting` carried `paid_models`) would fail validateProfile's
 * closed-key check on the very next load.
 */
export function dropKeysOutsideClosedSet(settingsPath: string, name: MarkedProfileName): string[] {
  return withSettingsWriteLock(() => {
    const handle = loadSettingsRoot(settingsPath);
    const section = JSON.parse(JSON.stringify(handle.doc.getIn(["profiles", name]) ?? null)) as unknown;
    if (section === null || typeof section !== "object") return [];
    const closed = [...DYNAMIC_GENERATED_KEYS[name], ...DYNAMIC_USER_OWNED_KEYS[name]];
    const stray = Object.keys(section).filter((key) => !closed.includes(key));
    for (const key of stray) handle.doc.deleteIn(["profiles", name, key]);
    if (stray.length > 0) writeSettingsAtomic(settingsPath, handle);
    return stray;
  });
}

export function applyPicksToSettings(
  settingsPath: string,
  profileName: string,
  picks: readonly PickedModel[],
): YamlMutationResult {
  refuseDynamicProfileWrite("applyPicksToSettings", profileName);
  if (picks.length < 1) throw new Error("applyPicksToSettings: need at least one pick");
  const { handle, profile } = loadProfileForMutation(settingsPath, profileName);
  const oldEnsemble: YamlMutationResult["oldEnsemble"] = {
    model: typeof profile.model === "string" ? profile.model : "",
    ...(typeof profile.second_model === "string" ? { second_model: profile.second_model } : {}),
    ...(typeof profile.third_model === "string" ? { third_model: profile.third_model } : {}),
  };
  // Update in-place via the live Document; preserve every other key (mode,
  // api, api_key, url, timeout, etc.) AND every comment/blank line/anchor.
  const path = ["profiles", profileName];
  handle.doc.setIn([...path, "mode"], picks.length >= 2 ? "remote-ensemble" : "remote");
  handle.doc.setIn([...path, "model"], picks[0].modelId);
  if (picks.length >= 2) handle.doc.setIn([...path, "second_model"], picks[1].modelId);
  else handle.doc.deleteIn([...path, "second_model"]);
  if (picks.length >= 3) handle.doc.setIn([...path, "third_model"], picks[2].modelId);
  else handle.doc.deleteIn([...path, "third_model"]);

  writeSettingsAtomic(settingsPath, handle);
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
  refuseDynamicProfileWrite("applyToolModelToSettings", profileName);
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
  const { handle, profile } = loadProfileForMutation(settingsPath, profileName);
  // Read the existing tool_models map defensively: a malformed value (null, a
  // scalar, an array) must NOT crash — treat it as empty so we still write a
  // valid map.
  const existing = profile.tool_models;
  const oldToolModels: Record<string, string> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, string>) }
      : {};
  const oldModelId = typeof oldToolModels[tool] === "string" ? oldToolModels[tool] : "";

  // Written as one setIn on the whole `tool_models` map (not a nested setIn
  // on just `tool`): a nested setIn would throw when the existing value is
  // malformed (a scalar/array, not a map) instead of the defensive "treat as
  // empty" behavior above — so replace the whole map with the merged result,
  // same semantics the old plain-object writer had (`{...oldToolModels,
  // [tool]: modelId}`). Every other profile key / top-level comment is still
  // preserved via the Document API.
  handle.doc.setIn(["profiles", profileName, "tool_models"], { ...oldToolModels, [tool]: modelId });

  writeSettingsAtomic(settingsPath, handle);
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
  // P6b-fix B2 / P6b-fix2 B-1: the shared refusal above — this writer was the
  // only one that carried it after P6b-fix, and it carried its own copy.
  refuseDynamicProfileWrite("applyFreePoolToSettings", profileName);
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
  const { handle, profile } = loadProfileForMutation(settingsPath, profileName);
  const existing = profile.free_models;
  const oldPool: string[] = Array.isArray(existing)
    ? existing.filter((v): v is string => typeof v === "string")
    : [];

  handle.doc.setIn(["profiles", profileName, "free_models"], newPool);

  writeSettingsAtomic(settingsPath, handle);
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
  refuseDynamicProfileWrite("applyEnsembleSlotToSettings", profileName);
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("applyEnsembleSlotToSettings: modelId must be a non-empty string");
  }
  if (!ENSEMBLE_SLOTS.includes(slot)) {
    throw new Error(
      `applyEnsembleSlotToSettings: unknown slot '${slot}'. Valid slots: ${ENSEMBLE_SLOTS.join(", ")}.`,
    );
  }
  const { handle, profile } = loadProfileForMutation(settingsPath, profileName);
  if (slot !== "model" && profile.mode !== "remote-ensemble") {
    throw new Error(
      `applyEnsembleSlotToSettings: profile '${profileName}' has mode '${String(profile.mode)}' — ` +
        `'${slot}' is only read under mode 'remote-ensemble', so writing it would silently do nothing. ` +
        `Switch the profile to remote-ensemble first, or adopt into 'model'.`,
    );
  }
  const oldModelId = typeof profile[slot] === "string" ? (profile[slot] as string) : "";
  handle.doc.setIn(["profiles", profileName, slot], modelId);

  writeSettingsAtomic(settingsPath, handle);
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
}

/**
 * Atomically ADD a brand-new named profile to settings.yaml (or overwrite an
 * existing one with the same name). Every other profile and every other
 * top-level key (including `active:`) is preserved by-key — same tmp+rename
 * atomicity as every other writer in this file.
 *
 * WHY (TRDD-G6XT3AY9): still no `setActive` option here, deliberately (YAGNI)
 * -- `active:` is a live selector again, but this function's only caller
 * (scan_local_llm_services --pick, index.ts) already tells the user both ways
 * to select the profile it just added (--profile <name>, or hand-editing
 * `active: <name>`); writing `active:` FOR them is a separate feature nobody
 * has asked for yet, not a restoration of what this function used to do.
 *
 * It also gained `refuseDynamicProfileWrite`, which the other four writers in
 * this file have carried since P6b-fix2 B-1. It was left out because no caller
 * could reach it with `free`/`paid` — an argument about today's call sites,
 * not about the function, and the same argument was wrong about the other
 * three. The guard is what makes "one writer per generated section" a property
 * of the module rather than of its current callers.
 */
export function addProfileToSettings(
  settingsPath: string,
  profileName: string,
  profile: Record<string, unknown>,
): NewProfileMutationResult {
  if (typeof profileName !== "string" || profileName.length === 0) {
    throw new Error("addProfileToSettings: profileName must be a non-empty string");
  }
  refuseDynamicProfileWrite("addProfileToSettings", profileName);
  const handle = loadSettingsRoot(settingsPath);
  const created = !(profileName in handle.root.profiles!);
  // PT-02: a profile written without a type is rejected by E81g once the migration ran, so a file llm-ext wrote itself would fail to load. Stamp the inferred type (same rule as the migration) when the caller gave none.
  const typed =
    profile["profile-type"] === undefined
      ? { ...profile, "profile-type": inferProfileType(profileName, profile as unknown as Profile) }
      : profile;
  handle.doc.setIn(["profiles", profileName], typed);

  writeSettingsAtomic(settingsPath, handle);
  return { profileName, created };
}

// ── Dynamic default-profile selectors + updaters (owner directive) ──────────
//
// N-9 (TRDD-90DM5YHO): the standalone `paid-ensemble`/`paid-mass-scout`
// profiles this comment used to describe are RETIRED (P5) — their slots now
// live INSIDE the `paid` profile (paid_models pool + tool_models.mass_scout).
//
// The `paid` profile's ensemble slots: the single best (`topN: 1`, the
// profile's `model`) or top 3 (`topN: 3`, its `paid_models` pool) PAID models
// whose input AND output price are BOTH AT OR UNDER the ceiling (default
// DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M, overridable via the settings.yaml
// global `ensemble_price_ceiling_usd_per_million` key — see config.ts's
// getEnsemblePriceCeiling). Ranked by quality (meanF1) among the ceiling
// survivors, cost/latency as tiebreakers — same shape as pickTopN, but the
// gate is PRICE, not a meanF1 floor. Same function serves both slot counts,
// same benchmark sweep.

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
    // USER 2026-09-18 "one ceiling, <=": exactly-at-ceiling is ADMITTED, not
    // rejected -- withinPriceCeiling is the single source of truth (config.ts).
    if (!withinPriceCeiling(r, ceiling)) continue;
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
 * Pick the single best mass-scout model for the `paid` profile's
 * `tool_models.mass_scout` slot (the standalone `paid-mass-scout` profile
 * this once populated is RETIRED — P5, N-9/TRDD-90DM5YHO): ultra-low cost
 * (input+output price ascending is the primary sort key), quality (meanF1
 * from the SHARED keyword sweep) as the tiebreaker. NEVER a ':free' id — mass-scouting fires
 * thousands of requests and would be rate-limited on a free tier (and is why
 * there is deliberately NO free mass-scout profile); this filter is enforced
 * in CODE (not merely documented) so a caller cannot accidentally hand back a
 * free id.
 *
 * NOTE — this is a proxy criterion, not the ideal one. Mass-scouting's real
 * workload is extracting many small structured records at scale (e.g.
 * cataloguing thousands of skills' frontmatter), where the thing that matters
 * is "negligible cost AND holds classification accuracy at realistic payload
 * sizes" — not merely "cheapest model that passed the generic keyword sweep".
 * The purpose-built benchmark for that IS ALREADY WRITTEN —
 * src/mass_scouting/calibrate-payload-size.test.ts — but it is gated on
 * CALIBRATE=1 + OPENROUTER_API_KEY (real spend, ~$0.06/run, not run
 * automatically) and is NOT wired into this selection. Qualifying
 * `paid-mass-scout` against it would mean: run the calibration across the
 * cost-ascending candidates this function already ranks, keep only the ones
 * that hold accuracy at the target payload size, then pick cheapest among
 * those survivors — a deliberate future change, not a silent scope creep in
 * this pass.
 *
 * TRDD-FKAR9VPK D6: that future change has LANDED as `llm-ext-benchmark
 * --scout-accuracy`; the mass-scout DISPATCH model comes from the 'scouting'
 * profile / scout-accuracy ledger — this slot is no longer the mass-scout
 * dispatch head (it stays written by the paid maintainer).
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

// ── Dynamic-profile generated-section writer (design §2.6) ──────────────────
//
// The single writer for the `free`/`paid` dynamic profiles. `free` absorbs the
// pool that used to need a second ensemble profile, and `paid` absorbs the
// ensemble slots and the mass-scout head (they now live inside `paid`'s
// `paid_models` pool and `tool_models`). Callers (the maintainer /
// populate-default-profile in benchmark/index.ts) assemble the full
// `next: Profile` object for the shape and call this once per name.

// P6c-a: the marker's definition MOVED to config.ts, so
// renderDefaultSettingsYaml can stamp it on a fresh install (config.ts cannot
// import this file — this file imports config.ts). Re-exported here so every
// existing importer keeps working and there is still exactly one value.
export { GENERATED_MARKER };

const SETTINGS_WRITE_LOCK_STALE_MS = 60_000;

/** Test knob: override the settings-write-lock wait bound via
 *  LLM_EXT_SETTINGS_LOCK_WAIT_MS, read once at module load. Only a finite
 *  positive integer is honored; anything else (unset, non-numeric,
 *  zero/negative, non-integer) falls back to the 30s production default.
 *  Never used in production — it exists so pick-lock.test.ts can shrink the
 *  30s wait for its "held past the bound" case without mocking the lock.
 *  Exported (not just the resulting constant) so a fallback test can call
 *  it directly against an arbitrary env value without a process spawn. */
export function resolveLockWaitMs(): number {
  const raw = process.env.LLM_EXT_SETTINGS_LOCK_WAIT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30_000;
}

const SETTINGS_WRITE_LOCK_WAIT_MS = resolveLockWaitMs();


/** True iff `pid` is a live process. Any error OTHER than ESRCH (no such
 *  process) is treated as "alive" — e.g. EPERM means the process exists but
 *  we lack permission to signal it, which is still a live holder. Only a
 *  definitive ESRCH may take over a lock early. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Read the recorded holder of an existing lock dir. Returns null when the
 *  dir vanished between our failed mkdir and this stat (another waiter/the
 *  holder released it) — the caller retries the mkdir in that case. */
function readLockHolder(dir: string): { pid: number | null; ageMs: number } {
  const stat = statSync(dir); // throws (and propagates) if the dir vanished
  let pid: number | null = null;
  try {
    const raw = Number(readFileSync(join(dir, "pid"), "utf-8").trim());
    if (Number.isInteger(raw) && raw > 0) pid = raw;
  } catch {
    pid = null; // pid file missing/unreadable — holder unknown, fall back to staleness only
  }
  return { pid, ageMs: Date.now() - stat.mtimeMs };
}


/** Acquire the lock (blocking, synchronous). Returns once mkdir succeeds;
 *  throws once SETTINGS_WRITE_LOCK_WAIT_MS elapses without acquiring it — a
 *  write must never proceed without holding the lock. Split out of
 *  withSettingsWriteLock so the caller never juggles an `acquired` flag: if
 *  this returns at all, the lock is held; if it throws, it never was. */
function acquireSettingsWriteLock(dir: string): void {
  const deadline = Date.now() + SETTINGS_WRITE_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dir);
    } catch {
      let holder: { pid: number | null; ageMs: number };
      try {
        holder = readLockHolder(dir);
      } catch {
        // Row 76 fix (TRDD-90DM5YHO): this ALSO fires when mkdir fails
        // because the parent dir is unwritable — the dir was never created,
        // so readLockHolder's statSync throws ENOENT every single retry,
        // forever, with no deadline check. Nothing about the exception here
        // distinguishes "vanished between our failed mkdir and this stat"
        // (genuinely transient — retry is correct) from "this write can
        // never succeed" (permanent — must honor SETTINGS_WRITE_LOCK_WAIT_MS
        // like the held-by-a-live-pid branch below does), so apply the same
        // deadline here instead of assuming every case is transient.
        if (Date.now() > deadline) {
          throw new Error(
            `settings.yaml write lock at ${dir} could not be created or inspected after ${SETTINGS_WRITE_LOCK_WAIT_MS}ms — refusing to write without the lock`,
          );
        }
        continue; // lock vanished between the failed mkdir and the stat — retry
      }
      const stale = holder.ageMs > SETTINGS_WRITE_LOCK_STALE_MS;
      const holderDead = holder.pid !== null && !isPidAlive(holder.pid);
      if (stale || holderDead) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* another waiter already took it over — retry the mkdir */
        }
        continue;
      }
      // The lock is held by a live, non-stale holder: NEVER proceed without
      // it (a settings.yaml write from two racing writers can corrupt the
      // file or drop one writer's change) — keep waiting up to the bound,
      // then fail loudly instead of writing unlocked.
      if (Date.now() > deadline) {
        throw new Error(
          `settings.yaml write lock at ${dir} is still held by pid ${holder.pid ?? "unknown"} after ${SETTINGS_WRITE_LOCK_WAIT_MS}ms — refusing to write without the lock`,
        );
      }
      continue;
    }
    // mkdir succeeded — WE now hold the lock. This is a SEPARATE try/catch
    // from the mkdir above: if recording our pid fails (disk full, EACCES,
    // ...), we must release the dir we just created immediately, rather than
    // leaving an unrecognized orphan lock — readLockHolder would see no pid
    // file and a fresh mtime and judge it neither stale nor dead, so THIS
    // SAME process would then spin against its own orphaned lock for the
    // full SETTINGS_WRITE_LOCK_WAIT_MS before throwing "held by pid unknown".
    try {
      writeFileSync(join(dir, "pid"), String(process.pid));
    } catch (err) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup — the pid-write error below is what we report */
      }
      throw err; // a real environment failure, not lock contention — propagate it
    }
    return;
  }
}

/**
 * A synchronous mkdir spin-lock over `<cfg>/settings.write.lock` (mkdir is
 * atomic). A write NEVER happens without the lock: a lock is taken over only
 * when its recorded holder pid is dead, or it is older than
 * SETTINGS_WRITE_LOCK_STALE_MS; otherwise a waiter keeps polling up to
 * SETTINGS_WRITE_LOCK_WAIT_MS and then throws rather than writing unlocked.
 * Kept local rather than shared: this lock protects settings.yaml writes
 * specifically (the maintainer parent and a benchmark child can both write),
 * a different resource from the spend ledger's lock in daily-spend.ts.
 */
function withSettingsWriteLock<T>(fn: () => T): T {
  const dir = join(getConfigDir(), "settings.write.lock");
  acquireSettingsWriteLock(dir);
  try {
    return fn();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already removed — nothing further to do */
    }
  }
}

/** Deterministic stringify (keys sorted recursively) so two structurally-equal
 *  objects compare equal regardless of insertion order — the YAML round-trip
 *  (`node.toJSON()`) and our freshly-built `next` object need not share order.
 *  Exported (P6b-fix2 S-9) so the maintainer's "is this still the section I
 *  decided against?" check uses the SAME notion of equality the writer's own
 *  no-op check uses; two different comparisons would disagree on key order and
 *  the maintainer would either never write or never detect a concurrent one. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Back up settings.yaml into `<config dir>/backups/` before an overwrite that
 * must not lose the user's bytes — used by this file's §2.6 write path and by
 * dynamic-maintainer.ts's regenerate path. `prefix` differs per call site
 * (`settings-before-generated-` vs `settings-before-regenerate-`, both
 * documented in the README); `wrapError`, when given, turns a thrown
 * mkdir/write failure into the caller's own message instead of the raw error.
 */
export function backupSettingsFile(
  settingsPath: string,
  prefix: string,
  name: string,
  opts: { nowMs?: number; wrapError?: (err: unknown) => Error; dedupe?: boolean } = {},
): string {
  const backupsDir = join(getConfigDir(), "backups");
  try {
    mkdirSync(backupsDir, { recursive: true });
    try {
      chmodSync(backupsDir, 0o700);
    } catch {
      /* Windows may not support chmod */
    }
    const nowMs = opts.nowMs ?? Date.now();
    const d = new Date(nowMs);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const offAbs = Math.abs(offsetMin);
    const ts =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
      `${sign}${pad(Math.floor(offAbs / 60))}${pad(offAbs % 60)}`;
    const backupPath = join(backupsDir, `${prefix}-${name}-${ts}.yaml`);
    const content = readFileSync(settingsPath, "utf-8");
    if (opts.dedupe) {
      // WHY: a step that re-runs on every pass (a file a sync tool keeps reverting) would otherwise add one backup per pass; a byte-identical earlier backup already restores this content.
      // WHY the read is guarded: an unreadable or non-file entry with the prefix must count as "not identical", not abort the migration of the user's file; the real write below stays unguarded.
      const same = readdirSync(backupsDir).find((f) => {
        if (!f.startsWith(`${prefix}-${name}-`)) return false;
        try {
          return readFileSync(join(backupsDir, f), "utf-8") === content;
        } catch {
          return false;
        }
      });
      if (same) return join(backupsDir, same);
    }
    writeFileSync(backupPath, content, "utf-8");
    return backupPath;
  } catch (err) {
    throw opts.wrapError ? opts.wrapError(err) : err;
  }
}

export interface WriteDynamicProfileSectionResult {
  changed: boolean;
  backupPath: string | null;
}

/**
 * Write (or refresh) a dynamic profile's generated section in settings.yaml.
 *
 *   - Identical (on the GENERATED keys only) to what's already there ⇒ no
 *     write (`{changed:false}`).
 *   - Section exists WITHOUT the marker (hand-authored or pre-migration) ⇒
 *     back up the WHOLE settings file first; abort the write if the backup
 *     fails (never lose a user's section); notify the caller either way.
 *   - Section exists WITH the marker (a previous generation, hand-edited or
 *     not) ⇒ each GENERATED key (DYNAMIC_GENERATED_KEYS, D0) is set or
 *     deleted individually — never a whole-section replace. Any USER-OWNED
 *     key (DYNAMIC_USER_OWNED_KEYS: `selection`, `high_quality_model`, …) in
 *     `next` is IGNORED here — this writer never touches one, so their YAML
 *     nodes (comments, key order) survive byte for byte across every
 *     regeneration (design section 3.2 rule 2; see writeDynamicUserKeys for
 *     the counterpart writer).
 *   - Everything else in the document (other profiles, comments, blank
 *     lines, the user-owned keys of THIS profile) is untouched — only each
 *     generated `profiles.<name>.<key>` and the section key's leading
 *     comment are set.
 *
 * The whole load → compare → write sequence runs under `settings.write.lock`
 * so a document is never written after being parsed outside the lock
 * (addendum C) — the maintainer (parent) and a benchmark child can both call
 * this, and only one write may win a race.
 *
 * P6b-fix2 S-9 — WHY `patch` is a FUNCTION, not a finished `Profile`. Addendum
 * C is about the DOCUMENT, not just the file handle: the caller used to build
 * its replacement section from a `settings.yaml` it had parsed BEFORE the lock
 * was taken, so a benchmark child that populated the section in between had its
 * whole result replaced by the parent's stale base plus a provisional pool.
 * Taking the decision as `(currentSection) => nextSection` moves the read of
 * what is on disk INSIDE the lock, so the section a caller patches is always
 * the one it is about to overwrite. `currentSection` is `undefined` when there
 * is no `profiles.<name>` section at all; a caller that replaces the whole
 * section wholesale simply ignores the argument.
 */
export function writeDynamicProfileSection(
  settingsPath: string,
  name: MarkedProfileName,
  patch: (currentSection: Profile | undefined) => Profile,
  opts: { nowMs?: number; notify: (msg: string) => void },
): WriteDynamicProfileSectionResult {
  return withSettingsWriteLock(() => {
    const handle = loadSettingsRoot(settingsPath);
    // The live `profiles` YAMLMap, keepScalar so we can read/set the KEY's
    // commentBefore (the marker) and not just the value.
    // P6b-fix N5: the SAME Scalar-aware match as the post-write lookup below.
    // `it.key?.value === name` only matches a Scalar key; the `yaml` library
    // stores a freshly-`setIn` key as a RAW JS STRING, which has no `.value`.
    // Harmless on this side today (a brand-new key has nothing to find), but
    // leaving two different shapes of the same lookup four lines apart is how
    // the post-write half silently lost the marker in the first place — and if
    // a caller ever hands this function a document whose key was just created,
    // the mismatch would silently skip the hand-authored-section BACKUP.
    const profilesMap = handle.doc.get("profiles", true) as {
      items?: Array<{ key: Scalar | string; value?: unknown }>;
    };
    const item = profilesMap?.items?.find(
      (it) => (it.key instanceof Scalar ? it.key.value : it.key) === name,
    );
    const existingValue = item ? handle.doc.getIn(["profiles", name]) : undefined;
    // P6c-a: the ONE marker reader (config.ts). It used to be an inline
    // `item.key.commentBefore` read here, which cannot see the marker on the
    // FIRST key of `profiles:` — the yaml library attaches that comment to the
    // MAP. `free` is first in every generated file, so this backed the whole
    // settings.yaml up, and printed "your previous version was saved", on
    // every maintainer write to a file llm-ext itself had written.
    const hasMarker = profileSectionMarkerState(handle.doc, name) === "marked";

    // `existingValue` is a raw YAML node (YAMLMap/YAMLSeq instances, not plain
    // objects) — Object.keys() on it would see the CLASS's own properties, not
    // its entries. Route both sides through JSON.stringify first: it invokes
    // each node's toJSON() automatically (that's how yaml's own doc.toJS()
    // works too), producing plain, comparable data before stableStringify
    // makes the comparison key-order-independent.
    const existingPlain = existingValue === undefined ? undefined : (JSON.parse(JSON.stringify(existingValue)) as unknown);
    // P6b-fix2 S-9: the caller's decision is applied to the section as it is
    // RIGHT NOW, under the lock — never to one it parsed before waiting for it.
    const next = patch(existingPlain as Profile | undefined);
    // D0 (TRDD-AL8GIZYA, design section 3.2 rule 2): this writer touches ONLY
    // GENERATED keys — `next` may carry user-owned keys too (`patch` receives
    // the WHOLE current section so candidate validation can see reserved
    // slots/groups), but every key outside DYNAMIC_GENERATED_KEYS is ignored
    // here, never written. The no-op comparison below is therefore over the
    // GENERATED projection only — comparing the whole section would report
    // "changed" on a user-owned edit this writer never touches anyway.
    const generatedKeys = DYNAMIC_GENERATED_KEYS[name];
    const generatedProjection = (section: unknown): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      const rec = section as Record<string, unknown> | undefined;
      for (const key of generatedKeys) {
        if (rec?.[key] !== undefined) out[key] = rec[key];
      }
      return out;
    };
    if (
      existingPlain !== undefined &&
      stableStringify(generatedProjection(existingPlain)) === stableStringify(generatedProjection(next))
    ) {
      return { changed: false, backupPath: null };
    }

    let backupPath: string | null = null;
    if (existingValue !== undefined && !hasMarker) {
      // A section is already there and it is NOT ours — back up the whole
      // file before we overwrite it (migration data safety, design §2.6).
      // fix-queue row 72: shared with dynamic-maintainer.ts's own backup use
      // via backupSettingsFile (above); `wrapError` reproduces this call
      // site's original behavior — abort the write with a caller-readable
      // message rather than let mkdir/write's raw error escape.
      backupPath = backupSettingsFile(settingsPath, "settings-before-generated", name, {
        nowMs: opts.nowMs,
        wrapError: (err) =>
          new Error(
            `writeDynamicProfileSection: refusing to overwrite the hand-authored '${name}' profile — ` +
              `backing it up first failed: ${(err as Error).message}. Nothing was written.`,
            { cause: err },
          ),
      });
      opts.notify(
        `llm-ext: the '${name}' profile in settings.yaml is now generated by llm-ext; your previous version was saved to ${backupPath}`,
      );
    }

    // D0 review finding: a key in `next` that is NEITHER generated NOR
    // user-owned for THIS profile (e.g. `ensemble` on any dynamic profile
    // before D5 lands) used to be written; now it is silently ignored by the
    // loop below — "silently" is exactly the failure mode this whole
    // ownership boundary exists to eliminate, just moved from the READ side
    // to the WRITE side. One notice per write names what got dropped, so a
    // caller relying on a not-yet-generated key (a maintainer computing a
    // provider route, say) finds out immediately instead of discovering an
    // inert route later.
    const droppedKeys = Object.keys(next as unknown as Record<string, unknown>).filter(
      (k) => !generatedKeys.includes(k) && !DYNAMIC_USER_OWNED_KEYS[name].includes(k),
    );
    if (droppedKeys.length > 0) {
      opts.notify(
        `llm-ext: writeDynamicProfileSection('${name}'): '${droppedKeys.join("', '")}' ${droppedKeys.length === 1 ? "is" : "are"} not yet a generated or user-owned key here and ${droppedKeys.length === 1 ? "was" : "were"} NOT written.`,
      );
    }

    // D0: per-key merge, not a whole-section replace. `deleteIn` for a
    // generated key `next` dropped, `setIn` for one it set — a user-owned
    // YAML node (selection, high_quality_model, …) is never touched by
    // either call, so its comments and key order survive byte for byte
    // across every regeneration (design section 3.2 rule 2).
    for (const key of generatedKeys) {
      const v = (next as unknown as Record<string, unknown>)[key];
      if (v === undefined) {
        handle.doc.deleteIn(["profiles", name, key]);
      } else {
        handle.doc.setIn(["profiles", name, key], v);
      }
    }
    // PT-02: a section created here (first-run stub, regenerated section) has no type, and E81g rejects a profile without one once the migration ran. The type of a built-in name is fixed, so stamp it; an existing type (user-owned key) is kept.
    if (handle.doc.getIn(["profiles", name, "profile-type"]) === undefined) {
      handle.doc.setIn(["profiles", name, "profile-type"], builtinProfileType(name));
    }
    // Re-fetch the item: setIn may have replaced the map node when the key
    // did not exist before (addProfileToSettings-shaped insert).
    //
    // BUG FIXED (P6b item 0, TRDD-90DM5YHO): when `profiles.<name>` is a
    // BRAND NEW key (no prior section at all — the common first-run case,
    // e.g. overrideActiveProfile's stub creation), the `yaml` library's
    // setIn stores the freshly-created pair's key as a RAW JS STRING, not a
    // Scalar node — `it.key?.value` is then `undefined` (a string has no
    // `.value`), so `item.key?.value === name` never matched and the marker
    // was silently never written (pick-comment-preservation.test.ts's own
    // fixture always pre-seeded an EXISTING `free:` section, so this path
    // went untested — see the P6a report's open gap 4). Match either shape,
    // and promote a raw-string key to a Scalar before touching
    // commentBefore (a plain string has no such property to set).
    // P6c-a (fix-queue 40): the cast declares only `key`. It used to also
    // declare `commentBefore` on the ITEM, which no code reads and which is
    // not where the yaml library keeps it — the comment belongs to the KEY
    // scalar (`item2.key.commentBefore`, set below). A cast that names a field
    // in the wrong place is a false map of the node shape.
    const map2 = handle.doc.get("profiles", true) as {
      items?: Array<{ key: Scalar | string }>;
      commentBefore?: string;
    };
    const item2 = map2?.items?.find(
      (it) => (it.key instanceof Scalar ? it.key.value : it.key) === name,
    );
    if (item2) {
      if (!(item2.key instanceof Scalar)) item2.key = new Scalar(item2.key);
      item2.key.commentBefore = ` ${GENERATED_MARKER}`;
      // Row 69 fix (TRDD-90DM5YHO): when `name` is the FIRST key inside
      // `profiles:` (always true for `free`), the yaml library attaches a
      // leading comment to the MAP node on parse, not to the key
      // (profileSectionMarkerState's own map-level fallback exists because of
      // this quirk). We just stamped the marker on the KEY above; a stale
      // copy can still be sitting on the MAP from an earlier write's own
      // round trip through disk. Left in place, both survive serialization
      // and the file gains one more marker line on every write. The key is
      // now this section's single source of truth for the marker, so clear
      // the map-level copy whenever this is the map's first entry.
      if (map2.items?.[0] === item2 && typeof map2.commentBefore === "string") {
        map2.commentBefore = undefined;
      }
    }

    writeSettingsAtomic(settingsPath, handle);
    return { changed: true, backupPath };
  });
}

/**
 * The counterpart writer to writeDynamicProfileSection: touches ONLY
 * DYNAMIC_USER_OWNED_KEYS (D0: `selection`, `high_quality_model`), under the
 * SAME `settings.write.lock` (design section 3.2 rule 3). Only the one-time
 * migration and seed steps call this — nothing that runs on every dispatch
 * writes a user-owned key, or a routine maintenance pass could silently
 * overwrite the exact data this whole ownership boundary exists to protect.
 *
 * `mutate` receives the section AS IT IS UNDER THE LOCK (same P6b-fix2 S-9
 * reasoning as `patch` above) and returns the next full section; only its
 * user-owned keys are read out of the result and written — a generated key
 * in the return value is silently ignored, the mirror image of
 * writeDynamicProfileSection's own behaviour.
 */
export function writeDynamicUserKeys(
  settingsPath: string,
  name: DynamicProfileName,
  mutate: (currentSection: Profile | undefined) => Profile,
): void {
  withSettingsWriteLock(() => {
    const handle = loadSettingsRoot(settingsPath);
    const existingValue = handle.doc.getIn(["profiles", name]);
    const existingPlain =
      existingValue === undefined ? undefined : (JSON.parse(JSON.stringify(existingValue)) as Profile);
    const next = mutate(existingPlain);
    for (const key of DYNAMIC_USER_OWNED_KEYS[name]) {
      const v = (next as unknown as Record<string, unknown>)[key];
      if (v === undefined) {
        handle.doc.deleteIn(["profiles", name, key]);
      } else {
        handle.doc.setIn(["profiles", name, key], v);
      }
    }
    writeSettingsAtomic(settingsPath, handle);
  });
}

// ── One-time migration of pre-14.0.0 profile sections (P6c-a, addendum K) ────

/**
 * Every UNPOPULATED PLACEHOLDER section llm-ext has ever SHIPPED, keyed by the
 * profile name it shipped under. Enumerated from `git log -p --
 * scripts/llm-ext/src/config.ts` (the generator is the only thing that has
 * ever written one), and pinned by profile-migration.test.ts so a future
 * change to the generator cannot silently shrink this table.
 *
 * Provenance — two eras, both 2026-08-13 onward:
 *   e916f2a / 4d4c24b / effdad0 — three machine-owned names, `free` shipped as
 *     mode `remote-ensemble`.
 *   ec34030 … 72dfb95 — five machine-owned names, `free` shipped as mode
 *     `remote` (and index.ts's P6a `overrideActiveProfile` stub wrote the
 *     byte-identical `free`/`paid` shapes).
 * Nothing before e916f2a had placeholders at all: the generator shipped four
 * hand-written example profiles with real model ids, which are NOT ours and
 * are never touched.
 *
 * WHY match the whole object and not just the sentinel `model`: deleting or
 * overwriting a user's section is irreversible from their point of view, so
 * the only safe question is "is this EXACTLY something we wrote, in full".
 * A section with one extra key, one edited key, or a populated pool is theirs.
 */
export const SHIPPED_PLACEHOLDER_SHAPES: Readonly<Record<string, readonly Profile[]>> = {
  free: [
    unpopulatedFreeProfile(),
    // e916f2a era: same section, mode `remote-ensemble`.
    { ...unpopulatedFreeProfile(), mode: "remote-ensemble" },
  ],
  paid: [unpopulatedPaidProfile()],
  // TRDD-C9SXX7HO: `local` shipped in only ONE era (14.1.0 onward) — no prior
  // shape to enumerate, unlike `free`'s two. D6a renamed its generated routes
  // key, so BOTH the pre-D6a (`providers`) and post-D6a (`detected_providers`)
  // unpopulated shapes are "shipped by llm-ext" — the adoption path must
  // recognize each, not treat the other era's placeholder as a user edit.
  local: [
    unpopulatedLocalProfile(),
    // D6a era boundary: the pre-rename unpopulated local section carried the
    // generated routes under `providers` — recognize it so an unmarked
    // pre-D6a placeholder is still adopted, not backed up as a user edit.
    {
      mode: "local",
      api: "lmstudio-local",
      model: PLACEHOLDER_MODEL_ID,
      free_models: [],
      providers: [],
    },
  ],
  "free-ensemble": [
    {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      free_only: true,
      free_models: [],
      model: PLACEHOLDER_MODEL_ID,
      api_key: "$OPENROUTER_API_KEY",
    },
  ],
  "paid-ensemble": [
    {
      mode: "remote-ensemble",
      api: "openrouter-remote",
      model: PLACEHOLDER_MODEL_ID,
      second_model: PLACEHOLDER_MODEL_ID,
      third_model: PLACEHOLDER_MODEL_ID,
      api_key: "$OPENROUTER_API_KEY",
    },
  ],
  "paid-mass-scout": [
    {
      mode: "remote",
      api: "openrouter-remote",
      model: PLACEHOLDER_MODEL_ID,
      api_key: "$OPENROUTER_API_KEY",
    },
  ],
};

/** The machine-owned names retired in 14.0.0. They are spelled out here, and
 *  ONLY here, because a migration that removes a section has to name it. */
export const RETIRED_PROFILE_NAMES: readonly string[] = [
  "free-ensemble",
  "paid-ensemble",
  "paid-mass-scout",
];

/** True iff `section` is byte-for-byte (key order aside) one of the shapes
 *  llm-ext shipped under `name`. */
export function isShippedPlaceholder(name: string, section: unknown): boolean {
  const shapes = SHIPPED_PLACEHOLDER_SHAPES[name];
  if (shapes === undefined || section === null || typeof section !== "object") return false;
  // PT-01: PT-02 stamps `profile-type` into a placeholder it did not otherwise
  // change, so the key is ignored when matching the shipped shapes (the table
  // lists the shapes as they were generated, before the field existed). The
  // type must still be the one the name is fixed to, or the section is not ours.
  const { "profile-type": type, ...rest } = section as Profile;
  if (type !== undefined && type !== builtinProfileType(name)) return false;
  const key = stableStringify(rest);
  return shapes.some((shape) => stableStringify(shape) === key);
}

export interface ProfileMigrationResult {
  /** Retired sections removed because they were provably our placeholders. */
  removed: string[];
  /** Retired sections KEPT (the user changed them): now ordinary static profiles. */
  kept: string[];
  /** Unmarked dynamic sections adopted as-is (they were our placeholder). */
  adopted: string[];
  /** Unmarked dynamic sections backed up and regenerated. */
  regenerated: string[];
  /** True when the migration had already run (nothing was inspected). */
  alreadyDone: boolean;
}

/**
 * The ONE-TIME migration from the pre-14.0.0 settings.yaml layout. Runs at
 * boot, BEFORE the dispatch maintainer, so a section it adopts already carries
 * the generated marker by the time the maintainer looks at it — otherwise the
 * maintainer would see an unmarked section and back it up a second time.
 *
 * Three decisions, all of them "prove it is ours before touching it":
 *
 *  - A RETIRED name (`RETIRED_PROFILE_NAMES`) whose parsed data is exactly a
 *    shipped placeholder is DELETED: it is an empty stub of a profile that no
 *    longer exists, and leaving it would show the user a permanently
 *    unpopulated profile nothing will ever fill. Anything else is the user's
 *    now — it stays as an ordinary STATIC profile, with one notice.
 *
 *  - An UNMARKED `free`/`paid` section whose parsed data is a shipped
 *    placeholder is ADOPTED: only the marker is missing (P6a's very first run
 *    wrote these sections without one — the yaml library stores a brand-new
 *    key as a raw string, which cannot carry a comment). Stamping the marker
 *    loses nothing, so there is nothing to warn about.
 *
 *  - Any OTHER unmarked `free`/`paid` section is hand-authored, and llm-ext
 *    owns the name (USER decision 2): the whole file is backed up to
 *    `<config dir>/backups/` and the section is regenerated, with ONE notice
 *    naming the backup. This happens at most once — afterwards the section is
 *    marked, and a NEW hand-authored one is refused by validateSettings
 *    (config.ts's reservedDynamicProfileNameError) rather than silently
 *    regenerated on every dispatch.
 *
 * Never throws: a migration failure must not stop the command the user ran.
 * The `migratedAt` stamp is written only after a clean pass, so a failed run
 * retries on the next boot instead of being recorded as done.
 */
export function migrateProfileSections(
  settingsPath: string,
  opts: {
    notify: (msg: string) => void;
    /** Reads the persisted "migration already ran" stamp (epoch ms). */
    readStamp: () => number | undefined;
    /** Persists the stamp. Called only after a clean pass. Returns the write
     *  error (never throws it) — B-1 (fix-queue review correction): lets the
     *  caller quote the real cause of a dropped write instead of guessing one. */
    writeStamp: (nowMs: number) => Error | null;
    nowMs?: number;
  },
): ProfileMigrationResult {
  const empty: ProfileMigrationResult = {
    removed: [],
    kept: [],
    adopted: [],
    regenerated: [],
    alreadyDone: false,
  };
  if (!existsSync(settingsPath)) return { ...empty, alreadyDone: true };
  if (opts.readStamp() !== undefined) return { ...empty, alreadyDone: true };

  // S5 (fix-queue review): a settings.yaml with no `profiles:` key (or
  // `profiles: null`) is "nothing to migrate", not a broken file to retry
  // forever — it is the EXACT shape ensureSettingsExist() itself tolerates
  // (config.ts's loadSettings maps it to `profiles: {}` and does NOT
  // regenerate the file), so there is nothing here for this migration to
  // inspect. Recognized BEFORE loadSettingsRoot's own guard (which THROWS on
  // exactly this shape, a few lines below): unguarded, that throw landed in
  // the catch at the bottom and printed "could not migrate…" on EVERY single
  // command forever, because a document with no `profiles:` key never has
  // anything to write either, so the stamp that would normally end the retry
  // loop was never reached. Read raw + parse ourselves (loadSettingsRoot's
  // own read, below, would otherwise throw before we could tell "nothing to
  // do" apart from "genuinely broken YAML") — a parse failure here just falls
  // through to the real attempt, whose own catch already handles it.
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const doc = parseDocument(raw);
    const parsedRoot = doc.errors.length === 0 ? (doc.toJS() as SettingsRoot | null) : undefined;
    const hasNoProfilesMap =
      parsedRoot !== undefined &&
      typeof parsedRoot === "object" &&
      parsedRoot !== null &&
      (parsedRoot.profiles === undefined || parsedRoot.profiles === null);
    if (hasNoProfilesMap) {
      opts.writeStamp(opts.nowMs ?? Date.now());
      return { ...empty, alreadyDone: false };
    }
  } catch {
    // Fall through — the real attempt below re-reads and its catch handles
    // an unreadable/unparseable file the same way it always has.
  }

  const result: ProfileMigrationResult = { ...empty };
  const needsRegeneration: DynamicProfileName[] = [];
  try {
    // PASS 1 — everything that is a pure document edit, in one locked write:
    // the retired-name deletions and the marker stamps. Held apart from pass 2
    // because writeDynamicProfileSection takes the SAME lock and this one is
    // not re-entrant.
    withSettingsWriteLock(() => {
      const handle = loadSettingsRoot(settingsPath);
      const profilesMap = handle.doc.get("profiles", true) as {
        items?: Array<{ key: Scalar | string }>;
      };
      const items = profilesMap?.items ?? [];
      const findItem = (name: string): { key: Scalar | string } | undefined =>
        items.find((it) => (it.key instanceof Scalar ? it.key.value : it.key) === name);
      let dirty = false;

      for (const name of RETIRED_PROFILE_NAMES) {
        if (findItem(name) === undefined) continue;
        const section = handle.root.profiles![name];
        if (isShippedPlaceholder(name, section)) {
          handle.doc.deleteIn(["profiles", name]);
          result.removed.push(name);
          dirty = true;
        } else {
          result.kept.push(name);
        }
      }

      for (const name of DYNAMIC_PROFILE_NAMES) {
        const item = findItem(name);
        if (item === undefined) continue;
        if (profileSectionMarkerState(handle.doc, name) === "marked") continue;
        if (isShippedPlaceholder(name, handle.root.profiles![name])) {
          if (!(item.key instanceof Scalar)) item.key = new Scalar(item.key);
          item.key.commentBefore = ` ${GENERATED_MARKER}`;
          result.adopted.push(name);
          dirty = true;
        } else {
          needsRegeneration.push(name);
        }
      }

      if (dirty) writeSettingsAtomic(settingsPath, handle);
    });

    if (result.kept.length > 0) {
      opts.notify(
        `llm-ext: '${result.kept.join("', '")}' in settings.yaml ${result.kept.length === 1 ? "is" : "are"} ` +
          `no longer machine-managed, and you have edited ${result.kept.length === 1 ? "it" : "them"}, so ` +
          `${result.kept.length === 1 ? "it stays" : "they stay"} as an ordinary profile you own. ` +
          `Select ${result.kept.length === 1 ? "it" : "one"} with --profile <name>, or delete the section.`,
      );
    }

    // PASS 2 — the hand-authored sections. writeDynamicProfileSection does the
    // backup, the notice naming it, the write and the marker, under its own
    // lock; reusing it is what keeps "back up before overwriting a section we
    // did not write" in exactly one place.
    for (const name of needsRegeneration) {
      writeDynamicProfileSection(
        settingsPath,
        name,
        () => unpopulatedDefaultProfile(name),
        { nowMs: opts.nowMs, notify: opts.notify },
      );
      result.regenerated.push(name);
    }

    // S5 (fix-queue review) + B-1/S-3 (coordinator correction): stampProfileMigrationDone
    // (opts.writeStamp) is documented "Never throws" — it swallows its own
    // I/O error — but now RETURNS it, so we can tell "persisted" from
    // "silently dropped" without a second read (and without ever having to
    // guess a cause: the previous "(directory not writable)" wording asserted
    // something not always true — the test's own real failure is EISDIR from
    // a directory sitting at the stamp path, not a permission error).
    //
    // B-1 (BLOCKER): "any reserved-name refusal it found still applies now"
    // was also FALSE — a stamp that never persists means this function
    // re-runs on every command, and its own adopt-or-back-up-and-regenerate
    // path (pass 2 above) keeps REPLACING a hand-authored free:/paid: section
    // with a fresh generated one instead of ever letting validateSettings see
    // (and refuse) an unmarked one. The notice now says that plainly.
    //
    // S-3 (coordinator correction): no per-process latch. migrateProfileSections
    // has exactly one production caller (index.ts's boot IIFE; reloadSettingsFromDisk
    // calls loadSettings only, never this function), so a real process never
    // calls this twice — there was nothing here for a latch to deduplicate,
    // only extra state to keep in sync for tests. Notify once per CALL.
    const writeErr = opts.writeStamp(opts.nowMs ?? Date.now());
    if (writeErr) {
      opts.notify(
        `llm-ext: could not persist the profile-migration marker at ${dynamicProfilesStatePath()} ` +
          `(the write was silently dropped: ${writeErr.message}) — until this directory is writable, ` +
          `every command re-runs this migration, so a hand-authored free:/paid: section is backed up ` +
          `and regenerated on the next command instead of being refused.`,
      );
    }
  } catch (err) {
    // No stamp: the next boot tries again. One line, never a thrown error —
    // this runs before every command, and a config-dir hiccup must not make
    // llm-ext unusable.
    opts.notify(
      `llm-ext: could not migrate settings.yaml profile sections: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return result;
}

/** Settings files already warned about F-4 in this process (once per process). */
const warnedLegacyProvidersOnly = new Set<string>();
export interface Settings141MigrationResult {
  /** Step ids that actually ran (wrote something, or recorded "nothing to
   *  do") during THIS call. Empty when every step was already applied, or
   *  the ambiguous case left a step unrecorded on purpose. */
  applied: string[];
}

/**
 * The 14.1.0 migration list (design section 5): named steps, each recorded
 * SEPARATELY in dynamic-profiles-state.json's `migrationsApplied` as it
 * runs — never one `migratedAt`-shaped stamp, because the steps land in
 * different SLICES of the same release (there is no release between
 * slices), so a dev build that has only run D0's step must not mark a later
 * slice's step done. Runs at boot right after migrateProfileSections
 * (index.ts), so it only ever sees MARKED dynamic sections. Never throws:
 * a migration failure must not stop the command the user ran — same
 * contract as migrateProfileSections.
 *
 * D0 shipped one step, `price-ceiling-into-paid`; D6a adds
 * `local-detected-providers` (renames `providers` → `detected_providers` on a
 * MARKED local section — the generated probe routes moved keys, and the user's
 * own groups now own `providers` on local too). "Ambiguous" (design
 * section 5) means: leave the document exactly as it is, record nothing,
 * notify nothing — the validation error that the step would have fixed then
 * refuses the command with the fix, on this and every later call, until the
 * user resolves it by hand. No legacy reader survives 14.1.0: old keys are
 * only ever DETECTED from here on, never read.
 */
export function migrateSettingsTo141(
  settingsPath: string,
  opts: {
    notify: (msg: string) => void;
    /** Whether a given step id is already recorded as applied. */
    isApplied: (stepId: string) => boolean;
    /** Persists that a step ran. Called only after a clean pass. Returns the
     *  write error (never throws it), mirroring migrateProfileSections'
     *  writeStamp contract. */
    markApplied: (stepId: string) => Error | null;
    nowMs?: number;
  },
): Settings141MigrationResult {
  const result: Settings141MigrationResult = { applied: [] };
  if (!existsSync(settingsPath)) return result;

  const recordApplied = (stepId: string): void => {
    const writeErr = opts.markApplied(stepId);
    if (writeErr) {
      opts.notify(
        `llm-ext: could not persist the 14.1.0 migration marker for '${stepId}' at ` +
          `${dynamicProfilesStatePath()} (the write was silently dropped: ${writeErr.message}) — ` +
          `this step re-runs on the next command.`,
      );
    } else {
      result.applied.push(stepId);
    }
  };

  // ── Step `price-ceiling-into-paid` (D0) ──────────────────────────────
  const priceStep = "price-ceiling-into-paid";
  try {
    if (!opts.isApplied(priceStep)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) return result; // the ordinary load path reports the real parse failure
      const root = doc.toJS() as SettingsRoot & { ensemble_price_ceiling_usd_per_million?: unknown };
      const legacy = root.ensemble_price_ceiling_usd_per_million;
      const nowMs = opts.nowMs ?? Date.now();
      if (legacy === undefined) {
        // Nothing to migrate — record the step so a settings.yaml that never
        // had the top-level key isn't re-inspected on every single boot.
        recordApplied(priceStep);
      } else {
        const paidSection = root.profiles?.paid as Record<string, unknown> | undefined;
        const paidSelection = paidSection?.selection as Record<string, unknown> | undefined;
        const existingPaidCeiling = paidSelection?.price_ceiling_usd_per_million;
        if (existingPaidCeiling !== undefined && existingPaidCeiling !== legacy) {
          // Ambiguous (design section 5): both positions set, to different
          // values. Leave the document untouched, record nothing — see this
          // function's own docblock.
          return result;
        }

        // Backup before the first rewrite (design section 5's "Backup:" rule) —
        // best-effort: a backup failure falls through to the outer catch, which
        // notifies and leaves the step unrecorded so the next boot retries.
        backupSettingsFile(settingsPath, "settings-before-14.1", "migration", { nowMs });

        // Create the unpopulated `paid` section through the ordinary writer when
        // absent, so the value below has somewhere to land and the section still
        // gets its generated marker + generated keys the normal way.
        if (paidSection === undefined) {
          writeDynamicProfileSection(settingsPath, "paid", () => unpopulatedDefaultProfile("paid"), {
            nowMs,
            notify: opts.notify,
          });
        }
        writeDynamicUserKeys(settingsPath, "paid", (current) => ({
          ...(current ?? unpopulatedDefaultProfile("paid")),
          selection: { ...(current?.selection ?? {}), price_ceiling_usd_per_million: legacy as number },
        }));
        withSettingsWriteLock(() => {
          const handle = loadSettingsRoot(settingsPath);
          handle.doc.deleteIn(["ensemble_price_ceiling_usd_per_million"]);
          writeSettingsAtomic(settingsPath, handle);
        });

        recordApplied(priceStep);
      }
    }
  } catch (err) {
    // No stamp: the next boot tries again. One line, never a thrown error —
    // this runs before every command, and a config-dir hiccup must not make
    // llm-ext unusable.
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${priceStep}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step `local-detected-providers` (D6a, design section 5) ──────────
  // Detects: a MARKED local section carrying `providers` (the pre-14.1 key).
  // Does: renames it to `detected_providers` — a lossless key move of
  // llm-ext's OWN generated content (the probe output), not a user edit; the
  // user's own groups now own `providers` on local. Never runs on a
  // non-local section or an unmarked one (migrateProfileSections already
  // handled adoption/backup of those).
  const renameStep = "local-detected-providers";
  try {
    if (!opts.isApplied(renameStep)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) return result;
      const root = doc.toJS() as SettingsRoot;
      const localSection = root.profiles?.local as Record<string, unknown> | undefined;
      const nowMs = opts.nowMs ?? Date.now();
      const legacyProviders = localSection?.providers;
      const modernDetected = localSection?.detected_providers;
      if (localSection === undefined || legacyProviders === undefined) {
        // Nothing to rename — record the step so a settings.yaml without the
        // legacy key isn't re-inspected on every boot.
        recordApplied(renameStep);
      } else if (modernDetected !== undefined) {
        // D6a-review F1 (TRDD-90DM5YHO): BOTH keys present — the legacy
        // generated `providers` plus a hand-added `detected_providers`. The
        // rename would overwrite the user's own content, so REFUSE: leave
        // both keys untouched for validateProfile's E-D1 (dynamic-section
        // closed key set) to name. D4-review F3: the step is NOT stamped —
        // a user who later hand-resolves the collision (deletes one key)
        // must get the rename re-run on the next boot; the state is rare
        // and re-inspection is cheap. No backup on this branch (D4-review
        // filing F-3): nothing on disk changes, so a per-boot backup of a
        // byte-identical file would just litter backups/. The notice names
        // no backup at all (disposition review F-α/F-δ): whether a
        // settings-before-14.1 backup exists depends on WHICH path marked
        // the section (hand-authored regeneration backs up; shipped-
        // placeholder adoption does not), and a notice asserting one that
        // may not exist would send the user hunting for nothing.
        opts.notify(
          "llm-ext: the 14.1.0 'local-detected-providers' migration found BOTH 'providers' and " +
            "'detected_providers' in profiles.local — refusing to overwrite your hand-added " +
            "groups. Remove the legacy generated 'providers' key (or rename it yourself) and " +
            "re-run; both keys are left untouched.",
        );
      } else {
        backupSettingsFile(settingsPath, "settings-before-14.1", "migration", { nowMs });
        withSettingsWriteLock(() => {
          const handle = loadSettingsRoot(settingsPath);
          const profilesRoot = handle.doc.getIn(["profiles"]);
          const localNode =
            profilesRoot && yamlIsMap(profilesRoot)
              ? (profilesRoot.get("local", true) as YAMLMap | undefined)
              : undefined;
          if (localNode && yamlIsMap(localNode)) {
            const legacyNode = localNode.get("providers", true);
            if (legacyNode !== undefined) {
              localNode.deleteIn(["providers"]);
              localNode.setIn(["detected_providers"], legacyNode);
            }
          }
          writeSettingsAtomic(settingsPath, handle);
        });
        recordApplied(renameStep);
      }
    }
  } catch (err) {
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${renameStep}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // F-4 (TRDD-OE27RD7I D4): once the rename step is stamped it never looks again, so a
  // marked local section hand-cleaned down to ONLY the legacy `providers` key (no
  // `detected_providers`) made local resolution read nothing, silently. Warn once per
  // process; resolution behaviour is unchanged. Runs on every boot, outside the isApplied gate.
  try {
    if (opts.isApplied(renameStep) && !warnedLegacyProvidersOnly.has(settingsPath)) {
      const doc = parseDocument(readFileSync(settingsPath, "utf-8"));
      if (doc.errors.length === 0 && profileSectionMarkerState(doc, "local") === "marked") {
        const local = (doc.toJS() as SettingsRoot).profiles?.local as Record<string, unknown> | undefined;
        if (local?.providers !== undefined && local.detected_providers === undefined) {
          warnedLegacyProvidersOnly.add(settingsPath);
          opts.notify(
            `llm-ext: ${settingsPath} has a generated profiles.local section with a 'providers' key ` +
              `but no 'detected_providers', so the local probe results are read as empty. ` +
              `Rename 'providers' to 'detected_providers' in that file, or delete it.`,
          );
        }
      }
    }
  } catch {
    // Advisory only: an unreadable file is reported by the ordinary load path.
  }
  // ── Step `bai-binding-to-reserved-slot` (D5, design section 5) ───────
  // Detects: a MARKED free section whose `providers` is EXACTLY the generated
  // b.ai binding llm-ext's two writers produced ({api: chat-b-ai-remote,
  // api_key: <preset default>, models: [one id]}). Does: that binding becomes
  // the USER group `bai` (named in place, same content — the user's to edit
  // from here on), its id is removed from every GENERATED key it sat in
  // (free_models/model/second_model/third_model/tool_models — it was never a
  // benchmarked OpenRouter ranking member), and
  // `ensemble.reserved: [{provider: bai, model: <id>}]` is added. Both this
  // step and `bai-reserved-seed` are recorded — the seed must not re-add a
  // slot after this one just created it. Any OTHER `providers` content (a
  // second group, a name:, a literal key) is the user's own edit — kept as
  // user groups, no slot, one notice, and the step is recorded (design
  // section 5's "any other providers content" row).
  const baiConvertStep = "bai-binding-to-reserved-slot";
  try {
    if (!opts.isApplied(baiConvertStep)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) return result;
      const root = doc.toJS() as SettingsRoot;
      const freeSection = root.profiles?.free as Record<string, unknown> | undefined;
      const nowMs = opts.nowMs ?? Date.now();
      const generatedBaiBinding = (section: Record<string, unknown> | undefined): string | null => {
        const providers = section?.providers;
        if (!Array.isArray(providers) || providers.length !== 1) return null;
        const g = providers[0] as Record<string, unknown> | undefined;
        if (!g || typeof g !== "object") return null;
        // The GENERATED shape only: the chat-b-ai-remote preset, the preset's
        // own env-var auth, ONE model, no name/url overrides. Anything else is
        // a user edit — not ours to move.
        if (g.api !== "chat-b-ai-remote") return null;
        if (g.api_key !== API_PRESETS["chat-b-ai-remote"]?.defaultAuthEnv) return null;
        if (g.name !== undefined || g.url !== undefined) return null;
        const models = g.models;
        if (
          !Array.isArray(models) ||
          models.length !== 1 ||
          typeof models[0] !== "string" ||
          models[0].length === 0
        ) {
          return null;
        }
        return models[0];
      };
      const baiId = generatedBaiBinding(freeSection);
      if (freeSection === undefined || baiId === null) {
        // Nothing to convert — record the step so a settings.yaml without the
        // generated binding isn't re-inspected on every boot.
        recordApplied(baiConvertStep);
      } else {
        backupSettingsFile(settingsPath, "settings-before-14.1", "migration", { nowMs });
        withSettingsWriteLock(() => {
          const handle = loadSettingsRoot(settingsPath);
          const profilesRoot = handle.doc.getIn(["profiles"]);
          const freeNode =
            profilesRoot && yamlIsMap(profilesRoot)
              ? (profilesRoot.get("free", true) as YAMLMap | undefined)
              : undefined;
          if (freeNode && yamlIsMap(freeNode)) {
            // 1. The binding becomes the user group `bai`: name it in place.
            const providersSeq = freeNode.get("providers", true) as { get?: (idx: number, kt: boolean) => unknown } | undefined;
            if (providersSeq && typeof providersSeq.get === "function" && yamlIsMap(providersSeq.get(0, true))) {
              (providersSeq.get(0, true) as YAMLMap).set("name", "bai");
            }
            // 2. Remove the id from every GENERATED key it sits in. User-owned
            // keys (`ensemble`, a hand-listed `providers` model) are never
            // touched here.
            for (const key of ["free_models", "model", "second_model", "third_model"]) {
              const node = freeNode.get(key, true) as unknown;
              if (node === undefined || node === null) continue;
              if (Array.isArray(node) || (node instanceof YAMLMap === false && typeof node === "object" && "items" in (node as object))) {
                const seq = node as unknown as { items: Array<{ value?: unknown }> };
                seq.items = seq.items.filter(
                  (it) => !(typeof it.value === "string" && it.value === baiId),
                );
                if (seq.items.length === 0) freeNode.deleteIn([key]);
              } else if (yamlIsScalar(node)) {
                if (node.value === baiId) freeNode.deleteIn([key]);
              }
            }
            const toolModelsNode = freeNode.get("tool_models", true) as YAMLMap | undefined;
            if (toolModelsNode && yamlIsMap(toolModelsNode)) {
              for (const pair of [...toolModelsNode.items]) {
                const v = pair.value;
                if (yamlIsScalar(v) && v.value === baiId) toolModelsNode.delete(pair.key);
              }
              if (toolModelsNode.items.length === 0) freeNode.deleteIn(["tool_models"]);
            }
            // 3. Add the reserved slot. `ensemble` is a USER-OWNED key — only
            // this one-time migration may write it (design section 3.2 rule
            // 3); routine writes never do.
            freeNode.setIn(["ensemble", "reserved"], [{ provider: "bai", model: baiId }]);
            writeSettingsAtomic(settingsPath, handle);
          }
        });
        // Record BOTH steps: the conversion already created the slot the seed
        // would add, and recording the seed here is what design section 5's
        // row prescribes ("both this step and bai-reserved-seed are recorded").
        recordApplied("bai-reserved-seed");
        recordApplied(baiConvertStep);
      }
    }
  } catch (err) {
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${baiConvertStep}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step `bai-reserved-seed` (D5, design section 5 + section 3.2 rule 6) ──
  // Runs when: the step is not yet recorded, $BAI_API_KEY resolves, and
  // profiles.free exists. Adds the group `{name: bai, api: chat-b-ai-remote,
  // api_key: $BAI_API_KEY, models: [glm-5.3-flash]}` (an existing group named
  // `bai` with the same preset is reused; a DIFFERENT preset skips with a
  // notice) and `ensemble.reserved: [{provider: bai, model: glm-5.3-flash}]`
  // when there is room and no slot already names the id. Once stamped it
  // never runs again — deleting the slot, the group, or the whole free
  // section does not bring it back. A machine with no BAI_API_KEY records
  // nothing, so the slot appears on the first boot after the key is exported.
  const baiSeedStep = "bai-reserved-seed";
  try {
    if (!opts.isApplied(baiSeedStep)) {
      const baiKey = resolveEnvValue(API_PRESETS["chat-b-ai-remote"]?.defaultAuthEnv ?? "$BAI_API_KEY");
      const raw = readFileSync(settingsPath, "utf-8");
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) return result;
      const root = doc.toJS() as SettingsRoot;
      const freeSection = root.profiles?.free as Record<string, unknown> | undefined;
      if (freeSection === undefined || baiKey === "") {
        // No free section (or no key): record the step — nothing to seed, and
        // the design's rule is one seed attempt per machine state: a key that
        // appears later does NOT re-seed a stamped machine. (An UNSTAMPED
        // machine gains the slot on the first boot after the key is exported,
        // which is the arm the design names.)
        recordApplied(baiSeedStep);
      } else {
        const nowMs = opts.nowMs ?? Date.now();
        const BAI_SEED_MODEL = "glm-5.3-flash";
        const providers = Array.isArray(freeSection.providers)
          ? (freeSection.providers as Record<string, unknown>[])
          : [];
        const existingBai = providers.filter(
          (g) => g && typeof g === "object" && (g.name === "bai" || g.api === "chat-b-ai-remote"),
        );
        const presetMatches = existingBai.every(
          (g) => g.api === "chat-b-ai-remote",
        );
        const ensemble = freeSection.ensemble as Record<string, unknown> | undefined;
        const reserved = Array.isArray(ensemble?.reserved)
          ? (ensemble.reserved as Record<string, unknown>[])
          : [];
        const alreadySlotted = reserved.some(
          (s) => s && typeof s === "object" && s.model === BAI_SEED_MODEL && (s.provider === undefined || s.provider === "bai"),
        );
        if (!presetMatches) {
          // A `bai` group with a DIFFERENT preset: ambiguous — notice, record,
          // change nothing (the user's own group is not ours to override).
          opts.notify(
            `llm-ext: the 14.1.0 'bai-reserved-seed' migration found a 'bai' provider group in profiles.free that does not use the chat-b-ai-remote preset — skipping the reserved-slot seed. Your group is untouched; add 'ensemble: {reserved: [{provider: bai, model: ${BAI_SEED_MODEL}}]}' by hand if you want it reserved.`,
          );
          recordApplied(baiSeedStep);
        } else if (alreadySlotted || reserved.length >= 2) {
          // Slot already there, or no room for one: nothing to do, record.
          recordApplied(baiSeedStep);
        } else {
          backupSettingsFile(settingsPath, "settings-before-14.1", "migration", { nowMs });
          withSettingsWriteLock(() => {
            const handle = loadSettingsRoot(settingsPath);
            const profilesRoot = handle.doc.getIn(["profiles"]);
            const freeNode =
              profilesRoot && yamlIsMap(profilesRoot)
                ? (profilesRoot.get("free", true) as YAMLMap | undefined)
                : undefined;
            if (freeNode && yamlIsMap(freeNode)) {
              if (existingBai.length === 0) {
                // Add the group under `providers` (creating the key when absent).
                const binding = new YAMLMap();
                binding.set("name", "bai");
                binding.set("api", "chat-b-ai-remote");
                binding.set("api_key", API_PRESETS["chat-b-ai-remote"].defaultAuthEnv);
                binding.set("models", [BAI_SEED_MODEL]);
                const list = freeNode.get("providers", true) as { add?: (item: unknown) => unknown } | undefined;
                if (list === undefined || list === null) freeNode.set("providers", [binding]);
                else if (typeof list.add === "function") list.add(binding); // YAMLSeq
                else if (yamlIsMap(list)) (list as YAMLMap).set(binding.get("name") as string, binding);
              }
              const reservedEntry = new YAMLMap();
              reservedEntry.set("provider", "bai");
              reservedEntry.set("model", BAI_SEED_MODEL);
              const ens = freeNode.get("ensemble", true) as
                | (YAMLMap & { get?: (k: string, kt?: boolean) => unknown })
                | undefined;
              if (ens === undefined || !yamlIsMap(ens)) freeNode.setIn(["ensemble", "reserved"], [reservedEntry]);
              else {
                const res = ens.get("reserved", true) as { add?: (item: unknown) => unknown } | undefined;
                if (res === undefined || res === null) ens.set("reserved", [reservedEntry]);
                else if (typeof res.add === "function") res.add(reservedEntry); // YAMLSeq
              }
              writeSettingsAtomic(settingsPath, handle);
            }
          });
          recordApplied(baiSeedStep);
        }
      }
    }
  } catch (err) {
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${baiSeedStep}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step `dynamic-unknown-keys` (D5 — the last slice that changes the key
  // tables, design section 5) ──────────────────────────────────────────
  // Detects: a MARKED dynamic section carrying keys outside the FINAL
  // GENERATED ∪ USER-OWNED tables (e.g. `ensemble_pins`, a hand-added
  // `timeout`). Removes them, with one notice naming each key — these are
  // llm-ext's sections, and the child's full rewrite used to drop such keys
  // anyway. The step runs once, after every table change has landed, so a key
  // D5 turned user-owned (`ensemble`) is never removed by it.
  const unknownKeysStep = "dynamic-unknown-keys";
  try {
    if (!opts.isApplied(unknownKeysStep)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) return result;
      const root = doc.toJS() as SettingsRoot;
      const nowMs = opts.nowMs ?? Date.now();
      const removals: Array<{ name: DynamicProfileName; keys: string[] }> = [];
      for (const name of DYNAMIC_PROFILE_NAMES) {
        const section = root.profiles?.[name] as Record<string, unknown> | undefined;
        if (section === undefined) continue;
        const allowed = new Set<string>([...DYNAMIC_GENERATED_KEYS[name], ...DYNAMIC_USER_OWNED_KEYS[name]]);
        const unknown = Object.keys(section).filter((k) => !allowed.has(k));
        if (unknown.length > 0) removals.push({ name, keys: unknown });
      }
      if (removals.length === 0) {
        recordApplied(unknownKeysStep);
      } else {
        backupSettingsFile(settingsPath, "settings-before-14.1", "migration", { nowMs });
        withSettingsWriteLock(() => {
          const handle = loadSettingsRoot(settingsPath);
          for (const { name, keys } of removals) {
            for (const key of keys) handle.doc.deleteIn(["profiles", name, key]);
          }
          writeSettingsAtomic(settingsPath, handle);
        });
        const allKeys = removals.flatMap((r) => r.keys.map((k) => `profiles.${r.name}.${k}`));
        opts.notify(
          `llm-ext: the 14.1.0 'dynamic-unknown-keys' migration removed ${allKeys.length === 1 ? "the key" : "the keys"} ${allKeys.join(", ")} — llm-ext owns the generated ${DYNAMIC_PROFILE_NAMES.join("/")} sections and no longer recognizes ${allKeys.length === 1 ? "it" : "them"}. A backup of settings.yaml was saved first.`,
        );
        recordApplied(unknownKeysStep);
      }
    }
  } catch (err) {
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${unknownKeysStep}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step `scouting-section-marked` (PT-04, TRDD-N2L9BN1Q) ──────────
  // `benchmark scout-accuracy` used to write `profiles.scouting` with no marker
  // (and a `paid_models` list nothing reads). `scouting` is now a marked
  // built-in with a closed key set, so an existing unmarked section would fail
  // the load (reservedDynamicProfileNameError) — this step is the path that
  // keeps it loading: backup, stamp the marker, drop the keys outside the closed
  // set (paid_models) and say so. Runs before `profile-type-written`, which then
  // types the section. A file without an unmarked `scouting` only records the step.
  const scoutingStep = "scouting-section-marked";
  try {
    // WHY not gated on the record (same as profile-type-written): a restored backup or a file synced from another machine brings the unmarked section back while the record says done, and the load would fail for good. The record keeps one meaning: the step ran once.
    {
      const firstRun = !opts.isApplied(scoutingStep);
      const raw = readFileSync(settingsPath, "utf-8");
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) return result;
      const section = (doc.toJS() as SettingsRoot).profiles?.scouting as unknown;
      if (
        profileSectionMarkerState(doc, "scouting") !== "unmarked" ||
        section === null ||
        typeof section !== "object" ||
        Array.isArray(section)
      ) {
        if (firstRun) recordApplied(scoutingStep);
      } else {
        const allowed = new Set<string>([...DYNAMIC_GENERATED_KEYS.scouting, ...DYNAMIC_USER_OWNED_KEYS.scouting]);
        const dropped = Object.keys(section).filter((k) => !allowed.has(k));
        backupSettingsFile(settingsPath, "settings-before-14.1", "scouting-marker", { nowMs: opts.nowMs ?? Date.now(), dedupe: true });
        withSettingsWriteLock(() => {
          const handle = loadSettingsRoot(settingsPath);
          for (const key of dropped) handle.doc.deleteIn(["profiles", "scouting", key]);
          const map = handle.doc.get("profiles", true) as { items?: Array<{ key: Scalar | string }> };
          const item = map?.items?.find((it) => (it.key instanceof Scalar ? it.key.value : it.key) === "scouting");
          if (item) {
            if (!(item.key instanceof Scalar)) item.key = new Scalar(item.key);
            // Keep a comment the user put on the key: the section was unmarked, so the marker is added in front, never over it.
            item.key.commentBefore = ` ${GENERATED_MARKER}` + (item.key.commentBefore ? `\n${item.key.commentBefore}` : "");
          }
          writeSettingsAtomic(settingsPath, handle);
        });
        opts.notify(
          `llm-ext: the 14.1.0 '${scoutingStep}' migration marked profiles.scouting as generated by llm-ext (a backup of settings.yaml exists in ${join(getConfigDir(), "backups")})` +
            (dropped.length > 0 ? ` and removed ${dropped.length === 1 ? "the key" : "the keys"} ${dropped.map((k) => `profiles.scouting.${k}`).join(", ")}, which ${dropped.length === 1 ? "is" : "are"} not part of the scouting profile.` : "."),
        );
        if (firstRun) recordApplied(scoutingStep);
        else result.applied.push(scoutingStep); // index.ts re-reads settings.yaml only when a step applied
      }
    }
  } catch (err) {
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${scoutingStep}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // PF-04: the sixth built-in, `or-jev` (see migrateOrJevSection).
  runOrJevStep(settingsPath, opts, recordApplied);
  // ── Step `profile-type-written` (PT-02, TRDD-IQTF34TC, D32) ──────────
  // Writes the inferred `profile-type` into every profile, built-in and custom,
  // so the field is explicit. WHY it rewrites custom profiles although the code
  // otherwise never does (D32): one explicit way to know a type beats inferring
  // it at every load; the user is shown every inferred type and the backup. Runs
  // LAST so it sees the profiles the steps above created. Recorded only after a
  // clean pass: a profile whose type cannot be inferred leaves the file
  // untouched and the step unrecorded, so E81g (strict) never switches on for it.
  try {
    // WHY it is not gated on the record (PT-02 lockout fix): restoring the backup this step made, an older file or one synced from another machine gives an untyped settings.yaml while the record still says migrated, so E81g would reject every profile and a gated step would never run again. Stamping is idempotent (backup, locked write, only the missing ones); the record keeps one meaning, "this file went through the migration once", which is what turns E81g on.
    const firstRun = !opts.isApplied(PROFILE_TYPE_STEP);
    const raw = readFileSync(settingsPath, "utf-8");
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) return result;
    const root = doc.toJS() as SettingsRoot;
    const nowMs = opts.nowMs ?? Date.now();
    const missing: Array<{ name: string; type: ProfileType }> = [];
    const report: string[] = [];
    const problems: string[] = [];
    for (const [name, value] of Object.entries(root.profiles ?? {})) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        problems.push(`profiles.${name} is not a map`);
        continue;
      }
      const profile = value as unknown as Profile;
      let type: ProfileType;
      try {
        type = inferProfileType(name, profile);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (profile["profile-type"] === undefined) {
        missing.push({ name, type });
        report.push(`profiles.${name}: profile-type '${type}' (inferred)`);
      }
      // Field issues are reported once, on the first pass; a re-stamp of a restored file reports only what it wrote.
      if (firstRun) report.push(...profileTypeFieldIssues(name, profile, type).map((i) => `will be rejected at load (PT-06): ${i}`));
    }
    if (problems.length > 0) {
      opts.notify(
        `llm-ext: the 14.1.0 '${PROFILE_TYPE_STEP}' migration left settings.yaml untouched because a profile type cannot be inferred: ${problems.join("; ")}. Fix it by hand and re-run.`,
      );
    } else {
      if (missing.length > 0) {
        backupSettingsFile(settingsPath, "settings-before-14.1", "profile-type", { nowMs, dedupe: true });
        withSettingsWriteLock(() => {
          const handle = loadSettingsRoot(settingsPath);
          for (const { name, type } of missing) handle.doc.setIn(["profiles", name, "profile-type"], type);
          writeSettingsAtomic(settingsPath, handle);
        });
      }
      if (report.length > 0) {
        opts.notify(
          `llm-ext: the 14.1.0 '${PROFILE_TYPE_STEP}' migration ${missing.length > 0 ? `wrote profile-type into your profiles (a backup of settings.yaml exists in ${join(getConfigDir(), "backups")}; edit a wrong type by hand):` : "found:"}\n  ${report.join("\n  ")}`,
        );
      }
      if (firstRun) recordApplied(PROFILE_TYPE_STEP);
      else if (missing.length > 0) result.applied.push(PROFILE_TYPE_STEP); // index.ts re-reads settings.yaml only when a step applied
    }
  } catch (err) {
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${PROFILE_TYPE_STEP}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return result;
}

/** PF-04 step id: adds the built-in `or-jev` classifier profile to an existing install, or marks the user's own (E83). */
const OR_JEV_STEP = "or-jev-section-added";

/**
 * PF-04 (TRDD-4GZJL3NH, E83): the `or-jev-section-added` step of migrateSettingsTo141, run once:
 *  - no `or-jev`: add the template section (with the marker) and `active_classifier: or-jev` when unset, after a backup;
 *  - an `or-jev` the user already has: plan E83 says "migration leaves it, warns", so settings.yaml stays BYTE-IDENTICAL (no marker, no backup,
 *    no active_classifier) and one warning says what llm-ext expects of a profile with that name. Such a section still loads: config.ts does not
 *    ask `or-jev` for the marker (unmarkedDynamicProfileNames), it is validated as a profile of its declared type.
 * Runs before `profile-type-written`. Throws on I/O failure; runOrJevStep reports it.
 */
function migrateOrJevSection(
  settingsPath: string,
  opts: { notify: (msg: string) => void; isApplied: (stepId: string) => boolean; nowMs?: number },
  recordApplied: (stepId: string) => void,
): void {
  // WHY the whole step is gated on the record: with no `or-jev` it adds the template ONCE (a user who deleted it must not get it back at every start); with one it only warns, ONCE.
  if (opts.isApplied(OR_JEV_STEP)) return;
  const doc = parseDocument(readFileSync(settingsPath, "utf-8"));
  if (doc.errors.length > 0) return; // the ordinary load path reports the real parse failure
  const state = profileSectionMarkerState(doc, "or-jev");
  if (state === "absent") {
    // WHY not loadSettingsRoot here: its "missing profiles map" guard serves writers of an EXISTING profile; this step must also give a file with no, a null or an empty `profiles:` its first profile, so that every file ends loadable.
    const loadAllowingNoProfiles = (): SettingsHandle => {
      const d = parseDocument(readFileSync(settingsPath, "utf-8"));
      if (d.errors.length > 0) throw new Error(`settings.yaml at ${settingsPath} is not valid YAML: ${d.errors[0].message}`, { cause: d.errors[0] });
      if (!yamlIsMap(d.get("profiles", true))) d.set("profiles", d.createNode({}));
      return { doc: d, root: (d.toJS() ?? {}) as SettingsRoot };
    };
    backupSettingsFile(settingsPath, "settings-before-14.1", "or-jev", { nowMs: opts.nowMs ?? Date.now(), dedupe: true });
    let setActive = false;
    withSettingsWriteLock(() => {
      const handle = loadAllowingNoProfiles();
      handle.doc.setIn(["profiles", "or-jev"], orJevProfile());
      stampGeneratedMarker(handle.doc, "or-jev");
      setActive = setActiveClassifierAfterActive(handle.doc);
      writeSettingsAtomic(settingsPath, handle);
    });
    opts.notify(
      `llm-ext: the 14.1.0 '${OR_JEV_STEP}' migration added the classifier profile 'or-jev' (model ~typesafe/jev-latest, key $OPENROUTER_API_KEY) to settings.yaml` +
        (setActive ? " and set active_classifier: or-jev" : "") +
        `. A backup of settings.yaml exists in ${join(getConfigDir(), "backups")}.`,
    );
  } else if (state === "unmarked") {
    // E83: the user's own section stays byte-identical: no marker, no backup (nothing is written), no active_classifier; the warning says what to do.
    const section = (doc.toJS() as SettingsRoot).profiles?.["or-jev"] as unknown;
    const isMap = section !== null && typeof section === "object" && !Array.isArray(section);
    const problems = isMap ? validateClassifierProfile("or-jev", section as Profile) : ["profiles.or-jev is not a map"];
    const selected = doc.get("active_classifier") === "or-jev";
    opts.notify(
      `llm-ext: settings.yaml already has a profile named 'or-jev', which is also the name of llm-ext's built-in classifier profile. The 14.1.0 '${OR_JEV_STEP}' migration left settings.yaml untouched (nothing added, no backup). ` +
        `llm-ext expects a profile with that name to be a classifier profile: profile-type: classifier, api: openrouter-remote, a model, and api_key as a $VAR reference such as $OPENROUTER_API_KEY. ` +
        (problems.length > 0
          ? `Yours does not match (${problems[0]}). Rename it to another name, or make it a classifier profile; until then settings.yaml fails to load with that message.`
          : selected
            ? "Yours matches and is the active classifier."
            : "Yours matches; set 'active_classifier: or-jev' to use it for the classify commands."),
    );
  }
  recordApplied(OR_JEV_STEP);
}

/** PF-04: never throws, like every step of migrateSettingsTo141 (a migration failure must not stop the command the user ran). */
function runOrJevStep(
  settingsPath: string,
  opts: { notify: (msg: string) => void; isApplied: (stepId: string) => boolean; nowMs?: number },
  recordApplied: (stepId: string) => void,
): void {
  try {
    migrateOrJevSection(settingsPath, opts, recordApplied);
  } catch (err) {
    opts.notify(
      `llm-ext: could not run the 14.1.0 '${OR_JEV_STEP}' migration step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Stamp the generated marker on `profiles.<name>`'s key. WHY a raw-string key is promoted first: setIn stores a new key as a plain string, which carries no comment. A comment of the user above the key is kept after the marker.
 */
function stampGeneratedMarker(doc: ReturnType<typeof parseDocument>, name: string): void {
  const map = doc.get("profiles", true) as { items?: Array<{ key: Scalar | string }>; commentBefore?: string };
  const item = map?.items?.find((it) => (it.key instanceof Scalar ? it.key.value : it.key) === name);
  if (!item) return;
  if (!(item.key instanceof Scalar)) item.key = new Scalar(item.key);
  // WHY: the yaml library puts a leading comment of the FIRST key on the map. Moving it onto the key (after the marker) keeps the user's comment and avoids a second copy being emitted.
  const first = map.items?.[0] === item;
  const lead = [item.key.commentBefore, first ? map.commentBefore : undefined].filter((c): c is string => typeof c === "string" && c.length > 0);
  item.key.commentBefore = [` ${GENERATED_MARKER}`, ...lead].join("\n");
  if (first) map.commentBefore = undefined;
}


/**
 * Set `active_classifier: or-jev` when the key is absent; true when it wrote. WHY right after `active:` and not at the end of the file (where `set` appends): the two selectors belong together in the header (generateDefaultSettings writes them in that order). Without an `active:` key it is appended.
 */
function setActiveClassifierAfterActive(doc: ReturnType<typeof parseDocument>): boolean {
  if (doc.get("active_classifier") !== undefined) return false;
  const root = doc.contents;
  const at = yamlIsMap(root) ? root.items.findIndex((it) => (it.key instanceof Scalar ? it.key.value : it.key) === "active") : -1;
  if (yamlIsMap(root) && at >= 0) root.items.splice(at + 1, 0, doc.createPair("active_classifier", "or-jev"));
  else doc.set("active_classifier", "or-jev");
  return true;
}
