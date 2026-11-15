/**
 * profiles/resolve-chain.ts — the ordered candidate chain of ONE profile for ONE command kind (TRDD-SZ7TO9FW,
 * design/specs/profile-contract.md sections 4.2, 4.3, 4.5 and 5; increment 2 of section 10).
 *
 * WHY: three owner directives, verbatim on the card.
 *   D1 (2026-11-14): the local fallback is "implicit in every profile, even those fixed written by the user or by other
 *      tools" — so the local tier is appended to every chain, whatever the profile lists.
 *   D2 (2026-11-14): "every profile must ensure a fallback. if its not defined in the profile, llm-ext will use the
 *      default ones. [...] all must pass the benchmarks" — so only models whose verdict is `pass` for this kind enter,
 *      and a profile without its own `fallback` gets the category default.
 *   Owner answer Q1 (2026-11-14): paid chain = pinned passing -> paid passing -> free remote passing -> local passing;
 *      free chain = pinned passing -> free passing -> local passing (D2).
 * Agent decision Q2 (one-way rule, spec section 5): never local -> remote, never free -> paid, unless the profile lists
 *   that tier in its own `fallback`. Agent decision Q3: a pinned profile borrows only its OWN category's passing pool,
 *   then local (the paid default above also reaches free, because the owner's Q1 answer outranks the agent decision).
 *
 * Pure: every input is injected (pools, the ready-now local list, the verdict reader), it reads no file and sends
 * nothing. The caller freezes the result for the run (spec 4.2). Nothing calls it yet: wiring it into the request path
 * needs per-tier routes and backends (see reports_dev/smart-worker/*-sz7to9fw-inc2-resolution.md).
 */

import { isCommandKind, type CommandKind, type Verdict } from "./verdicts.js";

/** A tier of the chain. `pinned` is the profile's own models; the others are llm-ext's internal pools (spec 3). */
export type Tier = "pinned" | "paid" | "free" | "local";
export const TIERS: readonly Tier[] = Object.freeze(["pinned", "paid", "free", "local"]);

/** The profile categories that resolve through this chain; scouting and classifier keep their own (spec 4.5, 6). */
export type ChainCategory = "free" | "paid" | "local";

export interface ChainProfile {
  name: string;
  category: ChainCategory;
  /** `tool_models.<kind>` heads the pins (spec 4.2 step 2). */
  toolModels?: Readonly<Record<string, string | undefined>>;
  model?: string;
  secondModel?: string;
  thirdModel?: string;
  /** A free_only profile's own pool, pinned after model/second/third. */
  freeModels?: readonly string[];
  /** The profile's own `fallback` tier list (spec 2.2); absent = the category default (4.5). */
  fallback?: readonly Tier[];
}

export interface ChainInputs {
  profile: ChainProfile;
  /** The command's tool id. A kind without a benchmark (classify, no-model commands) throws: it has its own chain. */
  kind: string;
  /** verdict(model, kind) of verdicts.ts, bound to its sources by the caller. */
  verdictOf(modelId: string, kind: CommandKind): Verdict;
  /** llm-ext's internal category pools, each already in rating order (spec 4.2 step 3, #56). */
  pools: { paid: readonly string[]; free: readonly string[] };
  /** Calibrated local models that are ready NOW (record ok, engine on PATH, model on disk), in preference order. Never downloads or waits (spec 4.2 step 5). */
  localReady: readonly string[];
  /** True for a model that costs nothing to call; a free-category profile keeps only free pins (spec 4.5 "pinned (free only)"). */
  isFree(modelId: string): boolean;
}

export interface ChainEntry {
  modelId: string;
  tier: Tier;
}

export interface ChainResolution {
  /** The models to try, in order; empty when nothing passes (the caller raises error 8.2). */
  entries: ChainEntry[];
  /** Pins skipped because they are untested for this kind: the caller prints the 4.3 notice and queues one background test. */
  untestedPins: string[];
  /** Pins skipped because they fail this kind (a stale fail is re-probed by the caller, spec 4.1). */
  failedPins: string[];
}

/** The default tier order per category (spec 4.5, owner Q1 and D2). Local is last in every one (D1). */
const DEFAULT_TIERS: Readonly<Record<ChainCategory, readonly Tier[]>> = {
  free: ["pinned", "free", "local"],
  paid: ["pinned", "paid", "free", "local"],
  local: ["pinned", "local"],
};

/** The category's own pool tier: the pool a pinned profile may borrow from (agent decision Q3). */
const OWN_POOL: Readonly<Record<ChainCategory, Tier>> = { free: "free", paid: "paid", local: "local" };

/**
 * The tiers of this profile, in order. Spec 4.2: pinned, then the category's own pool, then the profile's `fallback`
 * (else the category default), local last. One-way rule (Q2): a tier outside the category default (paid for a free
 * profile, free or paid for a local one) appears ONLY when the profile lists it in its own `fallback`; listing it is the
 * user's explicit consent to leave the machine or to spend.
 */
export function tierOrder(profile: ChainProfile): Tier[] {
  const listed = profile.fallback ?? DEFAULT_TIERS[profile.category];
  for (const t of listed) if (!TIERS.includes(t)) throw new Error(`profile '${profile.name}': unknown fallback tier '${String(t)}' (allowed: ${TIERS.join(", ")})`);
  const order: Tier[] = [];
  // D1: local is implicit in every profile, so it is appended even when the profile's own list omits it (Q4).
  for (const t of ["pinned", OWN_POOL[profile.category], ...listed, "local"] as Tier[]) if (!order.includes(t)) order.push(t);
  // Local is the LAST tier (spec 4.2 step 5) unless this is a local profile, whose own pool it is.
  if (profile.category !== "local") order.push(...order.splice(order.indexOf("local"), 1));
  return order;
}

/** tool_models.<kind>, model, second_model, third_model, free_models — deduped, first occurrence wins. */
function orderedPins(profile: ChainProfile, kind: string): string[] {
  const ids = [profile.toolModels?.[kind], profile.model, profile.secondModel, profile.thirdModel, ...(profile.freeModels ?? [])];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * The chain for `profile` on `kind`. Only `pass` models enter (D2). An untested pin is skipped for this run, never
 * placed later (spec 4.3); an untested or failing pool or local model is skipped silently (spec 4.2 step 5: skip, never
 * wait, never throw). A model appears once, at its first tier.
 */
export function resolveChain(inputs: ChainInputs): ChainResolution {
  const { profile, kind } = inputs;
  // Fail fast: a kind with no benchmark would have no verdict to gate on (classify keeps its own chain, spec 6).
  if (!isCommandKind(kind)) throw new Error(`no resolution chain for command kind '${kind}': it has no benchmark verdict`);
  const entries: ChainEntry[] = [];
  const untestedPins: string[] = [];
  const failedPins: string[] = [];
  const seen = new Set<string>();
  const admit = (modelId: string, tier: Tier): Verdict => {
    const v = inputs.verdictOf(modelId, kind);
    if (v === "pass") {
      seen.add(modelId);
      entries.push({ modelId, tier });
    }
    return v;
  };
  for (const tier of tierOrder(profile)) {
    if (tier === "pinned") {
      for (const id of orderedPins(profile, kind)) {
        if (seen.has(id)) continue;
        // Spec 4.5: a free profile's pins are free only; a billable pin there would break the free intent silently.
        if (profile.category === "free" && !inputs.isFree(id)) continue;
        const v = admit(id, tier);
        if (v === "untested") untestedPins.push(id);
        else if (v === "fail") failedPins.push(id);
      }
      continue;
    }
    const pool = tier === "local" ? inputs.localReady : inputs.pools[tier];
    for (const id of pool) {
      if (seen.has(id)) continue;
      // One-way rule (Q2): the free tier holds only free models, even if a pool list was written wrong.
      if (tier === "free" && !inputs.isFree(id)) continue;
      admit(id, tier);
    }
  }
  return { entries, untestedPins, failedPins };
}
