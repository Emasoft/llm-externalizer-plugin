// L2-17, plan §3 (l2/profile.ts) and §8: resolve the classifier profile a run uses.
// Source: `--profile`, else `active_classifier:`. The type check goes through PT-03 (profile-accept.ts); the schema through validateClassifierProfile (config.ts).
// No paid gate and no allow_paid_models check (D2): classifier calls are billed by design, only `--max-budget` caps them.
import { CLASSIFIER_DEFAULTS, OPENROUTER_PLUGIN_OPTION_ENV, resolveEnvValue, validateClassifierProfile, type Profile, type Settings } from "../../config.js";
import { profileSelectionRefusal } from "../../profile-accept.js";
import type { DecisionsModel } from "../l0/catalog.js";
import type { DecisionsEndpoint, GlobalFetch } from "../l0/transport.js";
import { selectionCatalogErrors, type SelectionCheckOptions } from "../profile-checks.js";
import type { LimitsProfile } from "./planner.js";

export interface ClassifierProfileInput {
  settings: Pick<Settings, "active" | "active_classifier" | "profiles">;
  /** The value of `--profile`, when given. */
  profileFlag?: string;
  /** The command as the user typed it, for the refusal text. */
  command: string;
}

/** What the transport (L0) and the planner (L2) read from the selected profile; defaults are applied, nothing is looked up in the catalog. */
export interface ResolvedClassifierProfile {
  name: string;
  /** Which setting chose it. */
  source: "flag" | "active_classifier";
  /** As written in the profile; an alias is resolved against the catalog by the caller (l0/model.ts). */
  model: string;
  endpoint: DecisionsEndpoint;
  /** The NAME of the environment variable holding the key (default OPENROUTER_API_KEY). WHY a name and never a key: validateClassifierProfile accepts only a `$NAME` reference (plan §8, PF-11), so no key can reach this object, its logs or a report; the caller reads the variable at call time (PF-11). */
  apiKeyEnv: string;
  timeoutMs: number;
  maxAttempts: number;
  /** The planner's limits input (structural, l2/planner.ts LimitsProfile). `context_tokens` is an override the planner uses only when the catalog reports none. */
  limits: LimitsProfile;
  provider?: Record<string, unknown>;
  sessionId?: string;
  user?: string;
  trace?: Record<string, unknown>;
}

export type ClassifierProfileResult = { ok: true; profile: ResolvedClassifierProfile } | { ok: false; error: string };

const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";

/** Pure: no catalog, no network. */
export function resolveClassifierProfile(input: ClassifierProfileInput): ClassifierProfileResult {
  const { settings, profileFlag, command } = input;
  const source = profileFlag !== undefined ? "flag" : "active_classifier";
  const name = profileFlag ?? settings.active_classifier;
  if (name === undefined) {
    return { ok: false, error: `${command} needs a classifier profile: pass --profile <name>, or set 'active_classifier:' in settings.yaml.` };
  }
  const found = settings.profiles[name];
  if (found === undefined) {
    return { ok: false, error: `unknown profile '${name}'. Available profiles: ${Object.keys(settings.profiles).join(", ") || "(none)"}` };
  }
  // WHY the chosen name is passed as an explicit --profile: PT-03 checks `active:` for text commands and only a flag for a command that accepts no text type, so `active_classifier:` would otherwise never be type-checked (the point left open in PF-03).
  const refusal = profileSelectionRefusal({
    command,
    accepted: ["classifier"],
    viewsSettings: false,
    profileFlag: name,
    // WHY `active: undefined`: a classifier command never reads `active:` (it takes --profile or active_classifier:), so PT-03 must not refuse it because `active:` names a profile of another type; the commands that do read `active:` are checked in cli/main.ts.
    settings: { active: undefined, profiles: settings.profiles },
  });
  if (refusal !== undefined) {
    return { ok: false, error: source === "active_classifier" ? `${refusal} It is selected by 'active_classifier:' in settings.yaml.` : refusal };
  }
  const errors = validateClassifierProfile(name, found);
  if (errors.length > 0) return { ok: false, error: errors.join("\n") };
  const p = found as Profile & Record<string, unknown>;
  const num = (key: string): number | undefined => (p[key] as number | undefined);
  const profile: ResolvedClassifierProfile = {
    name,
    source,
    model: p.model as string,
    endpoint: (p.endpoint as DecisionsEndpoint | undefined) ?? CLASSIFIER_DEFAULTS.endpoint,
    apiKeyEnv: ((p.api_key as string | undefined) ?? `$${DEFAULT_API_KEY_ENV}`).slice(1), // validateClassifierProfile guarantees a `$NAME` reference
    timeoutMs: num("timeout_ms") ?? CLASSIFIER_DEFAULTS.timeout_ms,
    maxAttempts: num("max_attempts") ?? CLASSIFIER_DEFAULTS.max_attempts,
    limits: {
      max_requests_per_call: num("max_requests_per_call") ?? CLASSIFIER_DEFAULTS.max_requests_per_call,
      concurrency: num("concurrency") ?? CLASSIFIER_DEFAULTS.concurrency,
      ...(num("context_tokens") !== undefined ? { context_tokens: num("context_tokens") } : {}),
    },
    provider: p.provider as Record<string, unknown> | undefined,
    sessionId: p.session_id as string | undefined,
    user: p.user as string | undefined,
    trace: p.trace as Record<string, unknown> | undefined,
  };
  return { ok: true, profile };
}

/**
 * PF-11 (E85): the key a run sends, read from the environment at call time through the shared resolver (resolveEnvValue, which also honours the plugin userConfig override).
 * WHY a function and not a field of ResolvedClassifierProfile: the resolved profile is logged and put in reports, so it carries only the variable NAME; the value exists only in the caller's local variable.
 * WHY it throws: an unset variable must stop the run before any request, naming the variable and never a value.
 */
export function resolveClassifierApiKey(profile: Pick<ResolvedClassifierProfile, "name" | "apiKeyEnv">): string {
  // WHY trim: a variable holding only whitespace (or a trailing newline from a pasted key) is "not set" and must never be sent as a Bearer token.
  const key = resolveEnvValue(`$${profile.apiKeyEnv}`).trim();
  // WHY the plugin variable is named: resolveEnvValue (config.ts) lets the plugin option win for OPENROUTER_API_KEY only, so that is the one other variable that would have been accepted.
  const alsoAccepted = profile.apiKeyEnv === "OPENROUTER_API_KEY" ? ` (or the plugin option ${OPENROUTER_PLUGIN_OPTION_ENV})` : "";
  if (key === "") throw new Error(`Profile '${profile.name}': the environment variable ${profile.apiKeyEnv}${alsoAccepted} named by its api_key is not set. Fix: export ${profile.apiKeyEnv}=<your key>.`);
  return key;
}

/**
 * The classifier selection path (PF-02): resolve, then the catalog checks of a classifier profile (the model exists, E19; an expired
 * cache plus a failed refresh throws, E16). This is the only place a profile's catalog checks may fetch: plain loading never does.
 */
export async function selectClassifierProfile(input: ClassifierProfileInput, fetch: GlobalFetch, options: SelectionCheckOptions = {}, loadCatalog?: () => Promise<DecisionsModel[]>): Promise<ClassifierProfileResult> {
  const resolved = resolveClassifierProfile(input);
  if (!resolved.ok) return resolved;
  const { name, model, endpoint } = resolved.profile;
  const errors = await selectionCatalogErrors({ name, type: "classifier", model, endpoint, fetch, ...options }, loadCatalog);
  return errors.length > 0 ? { ok: false, error: errors.join("\n") } : resolved;
}
