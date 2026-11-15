/**
 * profiles/route-for-tier.ts — where ONE chain entry is sent (TRDD-SZ7TO9FW plan step W3, design/specs/profile-contract.md
 * sections 4.2 and 4.5).
 *
 * WHY: resolveChain (resolve-chain.ts) mixes tiers in one chain: a paid profile reaches the free pool, every profile ends
 * in the local tier (owner D1, D2, Q1). The send path takes `route` from the ACTIVE profile (`routesFor`, config.ts) and
 * `deps` from the active profile too, and routesFor answers an unlisted id with the catch-all groups. So a free-pool
 * model in a paid profile, or any local model, would reach the active profile endpoint with its key. This seam names,
 * per entry, the profile that owns the tier: its routes are where the request goes and its deps (makeProviderDeps) are
 * what sends it.
 *
 * Rules: pinned and own-pool entries (entry tier == the active category) use the active profile; free entries the
 * resolved `free` profile; paid entries the resolved `paid` profile; local entries the MANAGED local profile that LISTS
 * the model (local_llama, locals-mlx, or the active one), through its broker route. Listing wins over the own-pool rule
 * for the local tier: a local_llama run reaching a locals-mlx model must go to the Locals broker, not to llama-server.
 * A missing profile or route throws, naming tier and model. There is NO fallback to the active profile: that fallback is
 * the wrong-endpoint, wrong-key bug this seam removes.
 *
 * Pure: every input is injected, nothing is read or sent. Nothing calls it yet (W4 wires it into the chain walk).
 */

import type { ResolvedProfile, ResolvedRoute } from "../config.js";
import type { ChainCategory, ChainEntry } from "./resolve-chain.js";

/** The profile fields this seam reads; a ResolvedProfile satisfies it. */
export type TierProfile = Pick<ResolvedProfile, "name" | "model" | "secondModel" | "thirdModel" | "freeModels" | "server">;

export interface TierRouteContext<P extends TierProfile> {
  /** The profile the command runs under. */
  active: P;
  /** Its chain category, the same one resolveChain was given: its tier is the own pool. */
  activeCategory: ChainCategory;
  /** The resolved built-in or user `free` profile; null when none resolves. */
  free: P | null;
  /** The resolved `paid` profile; null when none resolves. */
  paid: P | null;
  /** The managed local profiles that may serve the local tier (local_llama, locals-mlx), in preference order. */
  locals: readonly P[];
  /** Every group of `profile` serving `modelId`, in group order (ResolvedProfile.routesFor in production). */
  routesFor(profile: P, modelId: string): ResolvedRoute[];
}

export interface TierRoute<P extends TierProfile> {
  /** The groups to try for this entry, in order, never empty (the walk tries one attempt per group, D6a). */
  routes: ResolvedRoute[];
  /** The profile whose deps send it (makeProviderDeps(depsProfile, ...)); the very object the caller injected. */
  depsProfile: P;
}

/** The model ids a profile lists itself: model, second, third, then free_models (a local profile probe order). */
function listsModel(profile: TierProfile, modelId: string): boolean {
  return [profile.model, profile.secondModel, profile.thirdModel, ...profile.freeModels].includes(modelId);
}

function fail(entry: ChainEntry, why: string): never {
  throw new Error(`no route for ${entry.tier}-tier model '${entry.modelId}': ${why}`);
}

/** The local tier: the managed profile listing the model, the active one first. Its broker serves only its primary group. */
function localRoute<P extends TierProfile>(entry: ChainEntry, ctx: TierRouteContext<P>): TierRoute<P> {
  const candidates = [ctx.active, ...ctx.locals.filter((p) => p !== ctx.active)];
  const listing = candidates.filter((p) => listsModel(p, entry.modelId));
  if (listing.length === 0) fail(entry, `no local profile lists it (checked: ${candidates.map((p) => p.name).join(", ")})`);
  const managed = listing.filter((p) => p.server !== null);
  if (managed.length === 0) fail(entry, `profile '${listing[0].name}' lists it but is not managed (server: managed), so no broker serves it`);
  const depsProfile = managed[0];
  // The broker runs only the profile own group (group #0); a model reaching another group would not be broker-served.
  const routes = ctx.routesFor(depsProfile, entry.modelId).filter((r) => r.primary === true);
  if (routes.length === 0) fail(entry, `profile '${depsProfile.name}' has no broker (primary) route for it`);
  return { routes, depsProfile };
}

/**
 * The routes and deps-source profile of `entry`. Throws (fail fast) when the tier owner profile is missing or serves no
 * route for the model; never answers with the active profile for another tier.
 */
export function routeForTier<P extends TierProfile>(entry: ChainEntry, ctx: TierRouteContext<P>): TierRoute<P> {
  if (entry.tier === "local") return localRoute(entry, ctx);
  let depsProfile: P;
  if (entry.tier === "pinned" || entry.tier === ctx.activeCategory) depsProfile = ctx.active;
  else {
    const owner = entry.tier === "free" ? ctx.free : ctx.paid;
    if (owner === null) fail(entry, `no resolved '${entry.tier}' profile to send it through`);
    depsProfile = owner;
  }
  const routes = ctx.routesFor(depsProfile, entry.modelId);
  if (routes.length === 0) fail(entry, `profile '${depsProfile.name}' has no route serving it`);
  return { routes, depsProfile };
}
