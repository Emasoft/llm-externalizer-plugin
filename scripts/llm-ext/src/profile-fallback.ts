/**
 * profile-fallback.ts — the single-profile fallback iterator (phase
 * 14.1-C1, TRDD-OE27RD7I addenda 2/3/4, fix-queue rows 3/14/15).
 *
 * USER addendum 4 (2026-09-17, verbatim, no exceptions): "no switching to
 * free models (or local models) must exist anymore. llm-ext must stick to
 * the selected profile ... if no fallback is found working in a profile,
 * llm-ext will exit with error (for normal profiles) or trigger the
 * updating processes (if the profile is one of the 3 dynamic integrated
 * profiles: free/paid/local)." This module is the ONE place that walks a
 * resolved profile's own model chain. Every cross-profile borrow — 402 ->
 * free, paid -> free, remote -> local, a runtime read of
 * FREE_MODEL_ID/FREE_POOL_SEED — was deleted at its call sites in
 * provider/completion.ts (see that file's chatCompletionWithRetry); this
 * iterator never reaches for a model outside `profile`.
 *
 * Wiring this into chatCompletionWithRetry's caller (so a real command
 * actually advances through the chain and catches ProfileExhaustedError) is
 * phase 14.1-C2 — CompletionDeps (provider/types.ts) carries no resolved
 * profile yet, and types.ts/index.ts are out of this phase's file set.
 */
import { DYNAMIC_PROFILE_NAMES, type DynamicProfileName, type ResolvedProfile, type ResolvedRoute } from "./config.js";
import { getProfileRecord } from "./default-profiles-state.js";
import { IRON_RULE_REFUSAL_PREFIX } from "./benchmark/validated.js";

function isDynamicProfileName(name: string): name is DynamicProfileName {
  return (DYNAMIC_PROFILE_NAMES as readonly string[]).includes(name);
}

/** One entry in a profile's fallback chain: the model id to try next, and
 *  the base URL that will serve it (for per-ENDPOINT dead-marking below).
 *  D6a (TRDD-90DM5YHO): `route` is the SPECIFIC serving group this entry
 *  targets — a model served by two groups is expanded to two entries
 *  (model-major, group order), and each entry carries the group it tries.
 *  Absent only when the profile has no group for the id at all (the
 *  primary-backend fallback, pre-D6a behaviour). */
export interface ChainEntry {
  modelId: string;
  baseUrl: string;
  route?: ResolvedRoute;
}

/**
 * What the caller reports back after failing on a yielded entry, via
 * `.next(failure)`. `"endpoint"` marks the entry's `baseUrl` dead for the
 * REST of this chain walk — every later entry sharing it is skipped without
 * a request (addendum 2: a connection failure means every model behind that
 * base URL is equally unreachable, so there is nothing to gain from asking
 * again). `"credit"` (D4, design section 6) marks the entry's CREDENTIAL
 * (`url + keyRef`) dead for the walk — a 402 is about the key, not the
 * model, so the SAME id's next group (a different key) is still worth
 * trying, but every other id behind the same key is skipped without a
 * request. Anything else (`"model"`, or no feedback at all) just advances to
 * the next entry without marking anything dead.
 */
export type ChainFailureKind = "model" | "endpoint" | "credit";
export interface ChainFailure {
  kind: ChainFailureKind;
  /** The error that failed this entry. Collected into the thrown
   *  ProfileExhaustedError's `causes`, so a caller can tell a chain that ran
   *  out on a service-level cause (402, every model dead) from one that ran
   *  out on something specific to this one request (a 413 for one file). */
  error?: unknown;
}

// USER-specified sentence (TRDD-OE27RD7I Rule / addendum 3) — do not reword it.
// Exported (14.1-C2 §1) so the CLI exit-mapping, the dynamic-profile paths that end
// on an actionable error instead of an update (index.ts failDynamicProfile: the key,
// credit and request-specific verdicts), and every test that pins the exact wording
// all read the SAME one constant instead of copies that could drift apart.
export const STATIC_PROFILE_EXHAUSTED_MESSAGE =
  "the models in the selected profile are all failing; retry later or change the profile";
// USER ruling 2026-10-24 (TRDD-VAORGKVF), verbatim: "When every cause is an IRON RULE
// refusal, drop only \"retry later\" from the sentence and keep \"change the profile\",
// for every profile kind." A refusal is a $0 verdict reached before anything is sent;
// a retry cannot change it, so "retry later" would be false.
export const REFUSED_PROFILE_EXHAUSTED_MESSAGE =
  "the models in the selected profile are all failing; change the profile";
// D2 (USER 2026-09-18, verbatim: "the profile updating must happens in background,
// so no message is needed, except if all models of the current profile are failing,
// in which case the message should appear saying to retry later since the updating
// process is underway and will be finished soon"). The ONE text for a DYNAMIC
// profile with no working model -- every model failed, or the pool is still empty --
// and it names the profile. It replaced "updating the profile due to changes; waiting
// for the update": no command waits for an update any more, so that sentence would
// promise a wait that never happens.
//
// D3c-2 (TRDD-DS6OM3KX worker default): "soon" was dropped — the update-requested
// marker waits out the benchmark failure backoff (recordBenchmarkFailure:
// 15 min → 1 h → 4 h → 24 h), so an update the message implies is imminent can be
// a day away. The text states that deferral window instead; when the profile has a
// cooldown recorded, it names the actual retry time.
const BACKOFF_WINDOW_TEXT = "15 minutes to 24 hours";
export function dynamicProfileRetryLaterMessage(profileName: string): string {
  const record = isDynamicProfileName(profileName) ? getProfileRecord(profileName) : undefined;
  const cooldownUntil = record?.cooldownUntil ?? 0;
  const wait =
    cooldownUntil > Date.now()
      ? `the last benchmark attempt failed and the next one is scheduled after ${new Date(cooldownUntil).toISOString()}`
      : `failed benchmark attempts back off for ${BACKOFF_WINDOW_TEXT}`;
  return (
    `no model of the '${profileName}' profile is working right now; the profile update is ` +
    `underway in the background and may take a while — ${wait} — retry later`
  );
}

/**
 * Thrown once every entry in the chain has been tried and failed. A caller
 * branches on `.kind`, never on the message text, but the CLI prints the
 * message verbatim.
 *
 * D2: kind "dynamic" carries the retry-later message. profileChain's own
 * dynamic exhaustion never reaches a user as-is: index.ts's
 * chatCompletionWithProfileFallback hands it to failDynamicProfile, which
 * either starts the background update and throws a "dynamic" one, or throws
 * a "static" one carrying the actionable (credit / key / per-file) error.
 */
export class ProfileExhaustedError extends Error {
  readonly code = "PROFILE_EXHAUSTED";
  readonly profileName: string;
  readonly kind: "static" | "dynamic";
  /** Every per-entry error that exhausted the chain, in walk order (empty
   *  when none was reported). classifyError (index.ts) keys its verdict on
   *  these, never on this exception type alone: a pinned model's 402 must
   *  abort the whole batch, but a 413 for one oversized file must not. */
  readonly causes: readonly unknown[];

  /** `detail` (static only) is appended to the message so message and stack agree; used for a breaker abort, which is a provider outage, not a model failure. */
  constructor(profileName: string, kind: "static" | "dynamic", causes: readonly unknown[] = [], detail?: string) {
    super(
      (kind === "static"
        ? causes.length > 0 &&
          causes.every((c) => (c instanceof Error ? c.message : String(c)).startsWith(IRON_RULE_REFUSAL_PREFIX))
          ? REFUSED_PROFILE_EXHAUSTED_MESSAGE
          : STATIC_PROFILE_EXHAUSTED_MESSAGE
        : dynamicProfileRetryLaterMessage(profileName)) +
        (detail === undefined ? "" : ` — ${detail}`),
    );
    this.name = "ProfileExhaustedError";
    this.profileName = profileName;
    this.kind = kind;
    this.causes = causes;
  }
}

function dedupe(ids: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Yields `profile`'s own model chain, in fallback order, and throws
 * `ProfileExhaustedError` once every entry has been tried and failed. Never
 * yields a model outside `profile` — that is the whole point.
 *
 * STATIC, non-free_only profile: `model`, `secondModel`, `thirdModel`, in
 * the order written — the "three listed models" addendum 3 describes.
 *
 * STATIC free_only profile: `freeModels`, the manually authored pool
 * (addendum 3: "normal profiles ... stick to the manually defined list").
 *
 * DYNAMIC profile (`profile.dynamic` — free/paid/local, TRDD-C9SXX7HO D2):
 * the head, then the written pool — `freeModels` under free_only OR
 * `mode: "local"` (local's own probe-order fallback chain, per
 * resolveProfile's widened `freeModels` condition — it has no `paidModels`,
 * there being no catalog to derive one from), else `paidModels`. Already
 * stored in benchmark-rating order (free/paid) or probe order (local) by
 * pick.ts's writeDynamicProfileSection (read only, not edited, this phase).
 *
 * This reimplements config.ts's chainModelIds ordering rather than calling
 * it: chainModelIds takes the raw snake_case `Profile` type, a different
 * shape from the already-resolved camelCase `ResolvedProfile` this function
 * takes, and config.ts is out of this phase's file set (phase A owns it).
 * `resolveModelChain` was considered too, but for a STATIC profile it
 * returns only `[head]` (the single per-tool pick) — the wrong shape for
 * "walk all three listed models".
 *
 * `tool` selects the per-tool head via `toolModels[tool]`, defaulting to
 * the profile's plain `model` when unset — the same resolution order
 * `resolveModelChain` uses for its own head.
 */
export function* profileChain(
  profile: ResolvedProfile,
  tool = "default",
): Generator<ChainEntry, void, ChainFailure | undefined> {
  const head = profile.toolModels[tool] || profile.model;
  const ids = profile.dynamic
    ? dedupe([
        head,
        ...(profile.freeOnly || profile.mode === "local" ? profile.freeModels : (profile.paidModels ?? [])),
      ])
    : profile.freeOnly
      ? dedupe(profile.freeModels)
      : dedupe([head, profile.secondModel, profile.thirdModel]);

  const deadBaseUrls = new Set<string>();
  // D4: per-CREDENTIAL dead-marking — `url + keyRef` (the route's own id for
  // the credential; a `sha256:` literal ref or an env-var name, never the
  // secret itself). A 402 means THIS key has no credit, so every other id
  // behind the same key is skipped without a request, while the SAME id's
  // next group (a different key) is still tried.
  const deadCredentials = new Set<string>();
  // Why each entry failed, carried on the exhaustion error so the caller can
  // tell "no credit / every model dead" (abort the batch) from "this one
  // request is unservable" (fail just this file) -- see ChainFailure.error.
  const causes: unknown[] = [];
  // D6a model-major expansion (design 2.2): each id becomes one entry per
  // serving group, in group order — (id1,g1) (id1,g2) (id2,g1) … The listed
  // id order is kept, group order breaks ties. A "model" failure skips the
  // id's REMAINING groups (a 404/400/5xx on one key would repeat on a second
  // key of the same provider) — the `modelFailed` set; "endpoint" still
  // marks the base URL for the whole walk (D4 adds the per-credit group
  // kind). No serving group at all → one entry with no route, the
  // pre-D6a primary-backend fallback.
  const modelFailed = new Set<string>();
  // D4 review F1: entries skipped for a dead credential are otherwise silent —
  // the caller cannot tell why a cheap sibling model was never tried. One
  // aggregate line at walk end (not per skip) names the count and the
  // secret-free credential keys.
  const skippedCredentials = new Map<string, number>();
  let skippedForDeadCredential = 0;
  outer: for (const modelId of ids) {
    const serving = profile.routesFor(modelId);
    const entries: { modelId: string; baseUrl: string; route?: ResolvedRoute }[] =
      serving.length > 0
        ? serving.map((r) => ({ modelId, baseUrl: r.url, route: r }))
        : [{ modelId, baseUrl: profile.url }];
    for (const entry of entries) {
      if (modelFailed.has(modelId)) continue outer;
      // Endpoint already proven dead earlier in THIS walk — skip without a
      // request (addendum 2's "the second is skipped without a request").
      if (deadBaseUrls.has(entry.baseUrl)) continue;
      // D4: the credential (url + keyRef) already proven credit-dead —
      // skip without a request; the SAME id's next group has a different
      // credential, so it survives this skip.
      if (entry.route && deadCredentials.has(credentialKeyOf(entry.route))) {
        skippedForDeadCredential++;
        skippedCredentials.set(
          credentialKeyOf(entry.route),
          (skippedCredentials.get(credentialKeyOf(entry.route)) ?? 0) + 1,
        );
        continue;
      }
      const failure = yield entry;
      if (failure?.kind === "endpoint") deadBaseUrls.add(entry.baseUrl);
      if (failure?.kind === "credit" && entry.route)
        deadCredentials.add(credentialKeyOf(entry.route));
      if (failure?.error !== undefined) causes.push(failure.error);
      // A model-level failure (wrong shape, 4xx on the request, 5xx) would
      // repeat on every other group serving the SAME id — skip those too,
      // and advance to the next id. A "credit" failure is NOT model-level:
      // the same id on a different key is still live.
      if (failure?.kind === "model") modelFailed.add(modelId);
    }
  }
  if (skippedForDeadCredential > 0) {
    const detail = [...skippedCredentials.entries()]
      .map(([cred, n]) => `${cred} x${n}`)
      .join(", ");
    process.stderr.write(
      `[llm-externalizer] Skipped ${skippedForDeadCredential} chain entr${skippedForDeadCredential === 1 ? "y" : "ies"} on credit-dead credential(s): ${detail}\n`,
    );
  }
  throw new ProfileExhaustedError(profile.name, profile.dynamic ? "dynamic" : "static", causes);
}

/** D4: the walk's per-credential identity — the route's url plus its keyRef
 *  (the secret-free credential reference). Two groups sharing both are the
 *  same key behind the same endpoint (E-P3 already refuses that pair), so
 *  this key uniquely identifies "the credential a 402 killed". */
function credentialKeyOf(route: ResolvedRoute): string {
  return `${route.url}::${route.keyRef}`;
}
