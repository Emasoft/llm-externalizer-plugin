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

export function applyPicksToSettings(
  settingsPath: string,
  profileName: string,
  picks: readonly PickedModel[],
): YamlMutationResult {
  if (picks.length < 1) throw new Error("applyPicksToSettings: need at least one pick");
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
  const root = doc as { profiles?: Record<string, Record<string, unknown>> };
  if (!root.profiles || typeof root.profiles !== "object") {
    throw new Error(`settings.yaml at ${settingsPath} missing 'profiles' map.`);
  }
  const profile = root.profiles[profileName];
  if (!profile || typeof profile !== "object") {
    throw new Error(
      `settings.yaml at ${settingsPath} has no profile named '${profileName}'. ` +
        `Existing profiles: ${Object.keys(root.profiles).join(", ")}.`,
    );
  }
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

  const newRaw = yamlStringify(root, { indent: 2 });
  const tmp = settingsPath + ".tmp." + process.pid;
  writeFileSync(tmp, newRaw, "utf-8");
  // rename is atomic on POSIX. On Windows it's also atomic when both
  // paths sit on the same volume — which they always do here (tmp lives
  // in the same dir as the target).
  renameSyncCb(tmp, settingsPath);
  return {
    oldEnsemble,
    newEnsemble: {
      model: picks[0].modelId,
      ...(picks.length >= 2 ? { second_model: picks[1].modelId } : {}),
      ...(picks.length >= 3 ? { third_model: picks[2].modelId } : {}),
    },
  };
}
