// TRDD-28BAL5ER: fall back from the profile's System One model to another System One model under a price ceiling.
// USER directive (parent TRDD-UT7UC025): "jev is only one for now ... the code must be ready to discover them and use them if jev is not working".
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config.js";
import { appendModelEvent } from "../model-events.js";
import type { DecisionsModel } from "./l0/catalog.js";
import { ClassifierError } from "./l0/errors.js";
import type { ResolvedModel } from "./l0/model.js";
import { BilledClassifierError } from "./l2/fan-out.js";

// WHY exactly these classes: 404 / "model does not exist" (not-found), 5xx and 408/409 (unavailable) and a spent deadline (timeout) say the MODEL is not working.
// auth (401/403), payment, key-limit and in-flight-budget are the KEY or ACCOUNT, which another model cannot fix; bad-request / context-overflow / too-large come from the request itself and would fail identically; rate-limited heals by pacing. A billed error means the model answered, so it never qualifies.
const MODEL_NOT_WORKING = new Set(["not-found", "unavailable", "timeout"]);

export function isModelNotWorking(e: unknown): boolean {
  return e instanceof ClassifierError && !(e instanceof BilledClassifierError) && MODEL_NOT_WORKING.has(e.class);
}

const sameModel = (m: DecisionsModel, ids: ReadonlySet<string>): boolean => ids.has(m.id) || ids.has(m.canonicalSlug);

/** Catalog System One models that are not aliases and have a known price, at or below `ceiling`, cheapest first then by id. */
function systemOneByPrice(catalog: DecisionsModel[], exclude: ReadonlySet<string>, ceiling: number): DecisionsModel[] {
  return catalog
    .filter((m) => m.systemOne && m.aliasTarget === undefined && !sameModel(m, exclude) && m.promptUsdPerM !== null && m.promptUsdPerM <= ceiling)
    .sort((a, b) => a.promptUsdPerM! - b.promptUsdPerM! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The other System One models a run may fall back to, in the order to try them.
 * WHY the price ceiling is the profile model's RESOLVED (alias target) prompt price: a fallback must never cost more than the model the user chose; an unknown price cannot prove "at or below", so a null ceiling yields none (the runner says so).
 * WHY cheapest first, then id: a deterministic order (no catalog-order dependence) that also minimises spend.
 * WHY aliases and the excluded ids are left out: an alias resolves to the very model that just failed.
 */
export function systemOneFallbackCandidates(exclude: ReadonlySet<string>, ceiling: number | null, catalog: DecisionsModel[]): DecisionsModel[] {
  return ceiling === null ? [] : systemOneByPrice(catalog, exclude, ceiling);
}

// WHY a small state file and not a scan of model-events.log: the log is shared with every health event and can be large, so "the last matching line" is unbounded work on every run; this file is O(1). The event is still written to the log (drift ledger) when the alias moves.
interface SystemOneState { aliases: Record<string, string>; prices: Record<string, number> }
const statePath = (): string => join(getConfigDir(), "system-one-state.json");

function readState(): SystemOneState {
  const empty: SystemOneState = { aliases: {}, prices: {} };
  if (!existsSync(statePath())) return empty;
  try {
    const p = JSON.parse(readFileSync(statePath(), "utf-8")) as Partial<SystemOneState>;
    return { aliases: p.aliases ?? {}, prices: p.prices ?? {} };
  } catch {
    // WHY fail-open: the state only remembers what was last seen; a damaged file costs one repeated event or an unknown last price, never a failed classification.
    return empty;
  }
}

function writeState(s: SystemOneState): void {
  try {
    const tmp = `${statePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, statePath());
  } catch {
    // WHY best effort, like appendModelEvent: remembering must never break the tool call.
  }
}

const UNRECORDED = "(unrecorded)";

/**
 * Writes alias_target_change when the profile's alias resolves to another target than the last one recorded for it; nothing for a non-alias.
 * WHY a first sighting writes too ("(unrecorded)→target"): without a baseline the next change could never be noticed. WHY once: the comparison is against the recorded target, so a repeated run with the same target writes nothing.
 */
export function noteAliasTarget(resolved: ResolvedModel): void {
  const { requested, effective } = resolved;
  if (requested.aliasTarget === undefined) return;
  const state = readState();
  const recorded = state.aliases[requested.id];
  if (recorded === effective.id) return;
  appendModelEvent(requested.id, "alias_target_change", `${recorded ?? UNRECORDED}→${effective.id}`);
  writeState({ ...state, aliases: { ...state.aliases, [requested.id]: effective.id } });
}

/** Remembers the resolved prompt price of a model that answered, so a later run can price a replacement if the model is removed from the catalog. */
export function noteModelPrice(model: string, usdPerM: number | null): void {
  if (usdPerM === null) return;
  const state = readState();
  if (state.prices[model] === usdPerM) return;
  writeState({ ...state, prices: { ...state.prices, [model]: usdPerM } });
}

export interface RemovedModelCeiling { ceiling: number; rule: string }

/**
 * The price ceiling for replacing a profile model that is absent from the catalog; undefined when the model IS in the catalog or no System One model has a price.
 * Rule 1: the last recorded price of that model. Rule 2 (never recorded): the cheapest System One model in the catalog. The output names the rule.
 */
export function removedModelCeiling(model: string, catalog: DecisionsModel[]): RemovedModelCeiling | undefined {
  if (catalog.some((m) => m.id === model || m.canonicalSlug === model)) return undefined;
  const recorded = readState().prices[model];
  if (typeof recorded === "number") return { ceiling: recorded, rule: `its last recorded prompt price (${recorded} USD per million tokens)` };
  const cheapest = systemOneByPrice(catalog, new Set(), Infinity)[0];
  return cheapest === undefined ? undefined : { ceiling: cheapest.promptUsdPerM!, rule: `the cheapest System One model in the catalog (${cheapest.id}), because no price was ever recorded for it` };
}
