/**
 * Profile-based configuration for the LLM Externalizer MCP server.
 *
 * Single source of truth for settings.yaml loading, validation,
 * and resolution. Used by the server (index.ts), CLI (cli.ts), and tests.
 *
 * Settings file: ~/.llm-externalizer/settings.yaml
 *
 * Cross-platform: uses os.homedir() + path.join() for all paths.
 * Works on macOS, Linux, and Windows WSL.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse as yamlParse, Document as YamlDocument, isScalar, parseDocument, Scalar } from "yaml";
import { registeredTools } from "./model-qualification/registry.js";
import { parseLocalsModel } from "./local-locals-server.js";
import { parseManagedModel } from "./local-llama-server.js";
// PT-02: cyclic with default-profiles-state (it imports getConfigDir); safe because both sides only call the other inside functions.
import { isMigrationStepApplied } from "./default-profiles-state.js";

// ── Types ────────────────────────────────────────────────────────────

export type ApiProtocol = "lmstudio_api" | "openai_api" | "openrouter_api";
export type Mode = "local" | "remote" | "remote-ensemble";

export interface ApiPreset {
  /** Underlying API protocol */
  protocol: ApiProtocol;
  /** Default server URL (empty = user must set explicitly) */
  defaultUrl: string;
  /** Default env var for auth (e.g. '$LM_API_TOKEN'), empty = no auth */
  defaultAuthEnv: string;
  /** Default request timeout in seconds */
  defaultTimeout: number;
  /** Default app name (OpenRouter dashboard) */
  defaultAppName: string;
  /** Default HTTP referer (OpenRouter analytics) */
  defaultHttpReferer: string;
  /** Default context window override (0 = auto-detect) */
  defaultContextWindow: number;
  /** true for local backends, false for remote */
  isLocal: boolean;
  /**
   * The provider bills nothing, whatever the model id says. Absent ⟺ false.
   *
   * This exists because the free_only cost gate is a STRING test — a model is
   * judged free by a ':free' suffix, which is an OpenRouter naming convention,
   * not a fact about money. chat.b.ai is free at the provider and its ids carry
   * no suffix, so the suffix rule would refuse every one of its models while
   * refusing nothing that could actually bill. Marking the PROVIDER free lets
   * assertFreeOnlyModel keep the strict suffix rule exactly where spend is
   * possible (OpenRouter) and skip it only where it is provably meaningless.
   *
   * Set this ONLY for a provider that cannot charge for the models it serves.
   * It is a spend guard: a wrong `true` here is how a paid model gets sent
   * under a free profile.
   */
  isFreeProvider?: boolean;
}

/**
 * One provider a profile routes some of its models to (multi-provider profiles).
 *
 * Routing is EXPLICIT — each binding lists the models it serves — rather than
 * inferred from a prefix on the model id. Inference was the alternative and it
 * loses on the case that matters: an OpenRouter id already looks like
 * `vendor/model:free`, so any prefix scheme is one new upstream vendor away from
 * a silent collision that would send a model, and the API key with it, to the
 * wrong provider. An explicit list cannot collide, and a model id stays exactly
 * the string its own provider calls it.
 */
export interface ProviderBinding {
  /**
   * Explicit group name (D6a, TRDD-90DM5YHO). Referenced by name in
   * ensemble.reserved's `provider:` (D5) and in error text. Absent → the name
   * is derived from `api`, with a `-2`/`-3` suffix on repeats within the
   * profile. A group with no `api` MUST carry an explicit name (E-P2).
   */
  name?: string;
  /**
   * API preset name from API_PRESETS. OPTIONAL (D6a): a group without `api`
   * is a raw endpoint — `name` and `url` are then REQUIRED (E-P2), and its
   * protocol is detected at first use (D6b). Absent here also means the
   * group carries no preset defaults, so `url`/`api_key` have no fallback.
   */
  api?: string;
  /** API key — env var ref ($VAR_NAME) or direct value. Defaults to the preset's. */
  api_key?: string;
  /** Override the preset's default URL. */
  url?: string;
  /**
   * The models this group serves. OPTIONAL (D6a): a group without `models` is
   * a CATCH-ALL — it serves every id no named group claims (the `or-backup`
   * alternate-account shape: "no `models:` = alternate for every model not
   * bound to another group"). `resolveGroups`' routesFor falls back to group #0
   * plus every catch-all group when no group lists the id.
   */
  models?: string[];
}

/** A provider group (ProviderBinding, or the profile-level primary) with its
 *  preset merged in and its env refs resolved. */
export interface ResolvedRoute {
  /**
   * Group name (D6a): an explicit `name`, else derived from `api` with a
   * `-2`/`-3` suffix on repeats within the profile. Group #0 (the primary)
   * is always named after its `api` and cannot be renamed. Error text and
   * D4's credit message read this; D5's `ensemble.reserved[].provider`
   * references it.
   */
  name: string;
  /** API preset name. */
  api: string;
  protocol: ApiProtocol;
  url: string;
  authToken: string;
  /**
   * Credential reference WITHOUT the secret (D6a, credentialFingerprint
   * precedent): the env-var name for a `$VAR` ref, `sha256:<12 hex>` of a
   * literal key, or `none` for an unauthenticated local endpoint. D4 keys
   * per-credential dead-marking on `url + keyRef`.
   */
  keyRef: string;
  /**
   * True only for group #0 — the profile-level `api`/`url`/`api_key`. A
   * primary route takes the backend send path in resolveConnection (LM
   * Studio probe, apiHeaders()); every other group takes the routed path.
   */
  primary?: boolean;
  /**
   * From the preset — a local server. Carried per-route for the same reason
   * ResolvedProfile carries it: billability is a property of the ENDPOINT, and a
   * route has a different endpoint from the primary. Omitting it made every
   * routed LOCAL model (ollama/vllm in a `providers:` list) look billable, so
   * free_only refused a server that cannot charge — a regression on the
   * `remote+local` profile shape.
   */
  isLocal: boolean;
  /** From the preset — see ApiPreset.isFreeProvider. */
  isFreeProvider: boolean;
  /**
   * Models this group serves, in declared order. EMPTY for a catch-all
   * group (no `models:`) — a catch-all serves every id no named group
   * claims, which routesFor decides, not this list.
   */
  models: string[];
}

/**
 * `Profile.selection` (D0, TRDD-AL8GIZYA) — "how llm-ext auto-picks this
 * profile's models". `price_ceiling_usd_per_million` is the ONLY key D0
 * recognizes, and only on `paid` (SELECTION_ALLOWED_KEYS below); it is
 * untyped-loose here on purpose — validateProfile's E-L1 check is what
 * actually enforces the shape, the same split HighQualityModel uses.
 */
export interface ProfileSelection {
  price_ceiling_usd_per_million?: number;
}

/**
 * `Profile.ensemble` (D5, TRDD-90DM5YHO) — "this profile's ensemble, outside
 * what llm-ext picks". The ONLY key recognized is `reserved`, a list of at
 * most 2 entries (E-E2); a map shape is enforced by E-E1. Untyped-loose here
 * on purpose — validateProfile's E-E1..E-E6 checks are what actually enforce
 * the shape, the same split ProfileSelection uses.
 */
export interface ProfileEnsemble {
  /** At most 2 reserved members (E-E2), read in written order. */
  reserved?: ProfileReservedSlot[];
}

/**
 * One reserved ensemble member (D5). `model` is required (E-E3);
 * `provider` names a provider GROUP of this profile (E-E4) that serves the
 * model (E-E5). Omitted → every group that serves the model, in group order
 * (routesFor(model)). Duplicates of a (provider, model) pair are refused
 * (E-E6); duplicate MODEL ids too, on a free_only profile whose slots would
 * reach a billable group with a non-':free' id (E-E6's second arm reuses the
 * free_only wording).
 */
export interface ProfileReservedSlot {
  provider?: string;
  model: string;
}


// WHY defined here: Profile.endpoint needs it and config.ts must not import from classifiers/ (cycle); l0/transport.ts re-exports it.
export type DecisionsEndpoint = "decisions" | "systemone";

/**
 * One block of request options (TRDD-1OOAH3LD increment 1). YAML 1.2 loads an
 * unquoted `on`/`off` as a STRING, so `thinking` accepts true|false|"on"|"off".
 * Defined here, not in provider/, because config.ts must not import provider/*
 * (cycle rule).
 */
export interface RequestOptionBlock {
  thinking?: boolean | "on" | "off";
  max_output_tokens?: number;
  temperature?: number;
  top_k?: number;
  repeat_penalty?: number;
}

/** `default` block plus one block per tool name. */
export type RequestOptionsConfig = { default?: RequestOptionBlock } & Record<string, RequestOptionBlock>;
export interface Profile {
  /**
   * One of PROFILE_TYPES. Typed `string` on purpose: an untrusted YAML value
   * must be representable so profileTypeErrors can reject it (E81d).
   */
  "profile-type"?: string;
  mode: Mode;
  /** API preset name from API_PRESETS */
  api: string;
  /** Model identifier */
  model: string;
  /** Override preset default URL */
  url?: string;
  /** API key — env var ref ($VAR_NAME) or direct value */
  api_key?: string;
  /** Auth token for local servers — env var ref ($VAR_NAME) or direct value */
  api_token?: string;
  /** Classifier profiles only: the decisions endpoint called (validateClassifierProfile checks the value). */
  endpoint?: DecisionsEndpoint;
  /**
   * Additional provider groups this profile routes models to, in GROUP
   * ORDER after group #0 (the primary `api`/`model`/`api_key` above, which
   * stays the profile's first group). D6a (TRDD-90DM5YHO): each binding is
   * a NAMED group — an explicit `name`, else derived from `api` with a
   * `-2`/`-3` suffix on repeats — and one model id MAY be served by several
   * groups (two accounts of one provider): routesFor(id) returns every
   * serving group in group order and the chain walk tries each in turn, so
   * `second_model: glm-5.3-flash` with two `bai` groups tries bai, then
   * bai-2. Billability of a served id is "ANY serving group billable"
   * (fails closed). This comment previously described the duplicate-id
   * first-binding-wins behaviour as a hole; validateProfile's cross-group
   * duplicate refusal is REMOVED as of D6a — that shape is now legal and
   * meaningful, not silently half-served.
   */
  providers?: ProviderBinding[];
  /** Second model for remote-ensemble mode */
  second_model?: string;
  /** Third model for remote-ensemble mode (optional) */
  third_model?: string;
  /**
   * Free-only switch (TRDD-8b6b3646). When true, this profile uses ONLY the
   * `free_models` pool — `model` / `second_model` / `third_model` are ignored.
   * The top free models (benchmark-filtered) form the ensemble; the rest are the
   * rate-limit fallback pool. EVERY `free_models` entry MUST end with `:free`
   * (validateProfile enforces this) so the profile can never bill.
   */
  free_only?: boolean;
  /** Free-model pool for `free_only`, in preference order (all must be `:free`). */
  free_models?: string[];
  /**
   * Dynamic `paid` only: the ranked pool of passing paid models (best first),
   * the fallback chain every tool walks after its tool_models head
   * (resolveModelChain). llm-ext owns this list on the built-in `paid`
   * profile — a hand-written entry is validated the same way (non-empty
   * string, no `:free` suffix — that pool is free_models).
   */
  paid_models?: string[];
  /**
   * Reserved ensemble slots (D5, TRDD-90DM5YHO — replaces `ensemble_pins`,
   * which had no runtime reader and is REFUSED outright by E-D2).
   * USER-OWNED on every dynamic profile (free/paid/local): every regeneration
   * preserves this node exactly as written. At most 2 entries; each names a
   * model and optionally the provider GROUP that serves it. Read ONLY by
   * index.ts's getEnsembleModels (ensemble commands never touch the plain
   * chain), marked manual via ResolvedProfile.manualModels — never
   * benchmarked, never price-gated, never queued. Refused on a static
   * profile (E-S1): a static ensemble is model/second_model/third_model.
   */
  ensemble?: ProfileEnsemble;
  /**
   * Optional per-tool model overrides (TRDD-f45eeaa0). Keyed by LLM-using tool
   * name (must be one of model-qualification/registry's registeredTools()). When
   * a tool has an entry here, that model is used for the tool instead of this
   * profile's `model`; when absent, the tool falls back to its own default
   * (back-compat). A model assigned here SHOULD pass that tool's benchmark —
   * see resolveModelForTool() and the security-triage benchmark.
   */
  tool_models?: Record<string, string>;
  /**
   * Optional high-quality-scan model config (TRDD-DBUSM55E). Absent → built-in
   * defaults (GLM 5.2 @ xhigh reasoning, cache on, fp8+ quant, GMICloud). The
   * `high_quality_scan` tool reads this to run ONE strong model instead of the
   * cheap 3-model ensemble. See HighQualityModel.
   */
  high_quality_model?: HighQualityModel;
  /**
   * Auto-pick constraint config for a DYNAMIC profile (D0, TRDD-AL8GIZYA) —
   * USER-OWNED: every regeneration preserves this node exactly as written.
   * `paid` reads `price_ceiling_usd_per_million`; `free`/`local` recognize no
   * key here yet (an empty map is allowed and left untouched). Refused on a
   * static profile (E-S1) — nothing on one is auto-picked.
   */
  selection?: ProfileSelection;
  /**
   * GENERATED on `local` only (D6a rename, TRDD-90DM5YHO): the probe output
   * local-profile.ts's buildLocalProfileSection writes — what `providers`
   * held before 14.1.0. The user's own groups live under `providers` (now
   * USER-OWNED on `local` too); the generated routes must not share the key
   * with them, or the ownership boundary would differ per profile and the
   * writer would have to merge inside one list. Resolved as groups by
   * resolveGroups alongside `providers`. E-S2 refuses it on any NON-local
   * profile ("written by llm-ext for 'local' only").
   */
  detected_providers?: ProviderBinding[];
  /** Request timeout in seconds */
  timeout?: number;
  /** Context window override (0 = auto-detect) */
  context_window?: number;
  /**
   * TRDD-1OOAH3LD increment 1: per-tool request options (sampling, thinking,
   * output cap) for a local llama.cpp profile. `default` plus one block per
   * tool. Absent = the request path is unchanged. Local profiles only.
   */
  request_options?: RequestOptionsConfig;
  /**
   * TRDD-1OOAH3LD, TRDD-ZGSGGHQG: `managed` = requests to the profile's own llamacpp-local or locals-local
   * group go through the per-engine broker, which starts llama-server on first
   * use and swaps models in it. Absent = llm-ext never starts a server. Local profiles only.
   */
  server?: "managed";
  /** App name for OpenRouter dashboard */
  app_name?: string;
  /** HTTP Referer for OpenRouter analytics */
  http_referer?: string;
}

export interface Settings {
  /**
   * True once the PT-02 migration has written `profile-type` into every
   * profile; from then on a profile without it fails the load (E81g). Set by
   * PT-02 from its migration record; absent until then.
   */
  profileTypesMigrated?: boolean;
  // WHY (TRDD-G6XT3AY9): `active:` is a live selector again -- precedence is
  // `--profile` flag > this key > the built-in default (effectiveProfileName()
  // implements exactly that). loadSettings() copies the raw YAML value in
  // unmodified; overrideActiveProfile()/the reload path then overwrite it
  // in-memory with whatever profile actually ran, so display paths always
  // agree with what was selected.
  active?: string;
  /**
   * PF-03 (E82): the default classifier profile, used by `classify` when no
   * --profile is given (plan section 8). Raw value from settings.yaml; naming a
   * profile the file does not define is a load error (activeClassifierErrors).
   */
  active_classifier?: string;
  /** Named profiles */
  profiles: Record<string, Profile>;
  /**
   * D0 (TRDD-AL8GIZYA): the top-level `ensemble_price_ceiling_usd_per_million`
   * key is a LEGACY position — `migrateSettingsTo141`'s `price-ceiling-into-paid`
   * step moves it into `profiles.paid.selection.price_ceiling_usd_per_million`
   * (getEnsemblePriceCeiling() reads only that new position now). This is the
   * RAW value read straight off disk, uncoerced, so settingsLevelErrors (E-D3)
   * can quote whatever the user actually wrote: after migration the key
   * should never survive except in the ambiguous case (both positions set, to
   * different values), which migration deliberately leaves untouched so this
   * can refuse it with the fix. Undefined when the key is absent.
   */
  legacyEnsemblePriceCeiling?: number;
  /**
   * Master paid-spend switch (USER directive, this session). DEFAULT false —
   * "only free models are viable, everything runs free by default". While false,
   * every remote (OpenRouter) profile is FORCED to free mode at boot regardless of
   * its configured `model` fields, and paid *benchmarks* are refused too — one
   * switch governs every kind of paid spend. Set true to restore paid sends +
   * paid benchmarks (per-profile `free_only` then remains an opt-in). Absent ⟺
   * false, so a settings file that never heard of this key is safely free.
   */
  allow_paid_models?: boolean;
  /**
   * Daily USD spend cap for PAID benchmark runs (the `paid` dynamic profile's
   * maintainer). Absent/invalid ⟹ DEFAULT_PAID_DAILY_CAP_USD. See
   * paidDailyCapUsd(). Does not govern ordinary sends — only the maintainer's
   * own benchmark spend, which is the one paid-spend path with no per-call
   * user in the loop to notice a runaway bill.
   */
  paid_benchmark_daily_cap_usd?: number;
  /**
   * Scouting price ceiling (USD per million tokens, input AND output) for the
   * scout-accuracy benchmark candidate pool (TRDD-FKAR9VPK D2). Absent or
   * invalid -> DEFAULT_SCOUT_PRICE_CEILING_USD_PER_M. See
   * scoutPriceCeilingUsdPerM().
   */
  scout_price_ceiling_usd_per_million?: number;
  /**
   * Target fixture size (bytes) for the scout-accuracy benchmark
   * (TRDD-FKAR9VPK D2). Absent or invalid ->
   * DEFAULT_SCOUT_ACCURACY_TARGET_BYTES. Per-candidate effective size is
   * CLAMPED to 50% of the model context window (TRDD-FKAR9VPK A1). See
   * scoutAccuracyTargetBytes().
   */
  scout_accuracy_target_bytes?: number;
  /**
   * Minimum positional accuracy (0..1) a candidate must score to PASS the
   * scout-accuracy benchmark (TRDD-FKAR9VPK D2). Absent or invalid ->
   * DEFAULT_SCOUT_ACCURACY_THRESHOLD. Retuning it changes the ledger hash and
   * re-probes every candidate by design. See scoutAccuracyThreshold().
   */
  scout_accuracy_threshold?: number;
  /**
   * P6c-a (fix-queue 25): the DYNAMIC profile names (`free`/`paid`) whose
   * settings.yaml section is present but does NOT carry GENERATED_MARKER —
   * i.e. sections llm-ext did not write. In-memory only: it is derived from
   * the document's KEY COMMENTS, which `yamlParse` throws away, so it is
   * computed once in loadSettings() and never serialized back.
   *
   * It exists because those two names are RESERVED: llm-ext owns their
   * sections and rewrites them on every dispatch, so a hand-authored profile
   * under either name would be silently replaced. The first migration run
   * adopts or backs-up-and-regenerates what it finds (addendum K); after that
   * validateSettings REFUSES an unmarked one rather than regenerating it over
   * and over. Absent (undefined) on a Settings built in memory — only a real
   * on-disk load can answer the question, and "unknown" must never refuse.
   */
  unmarkedDynamicProfiles?: string[];
}

/** Fully resolved profile with concrete values (no env var refs) */
export interface ResolvedProfile {
  name: string;
  /** D36 spend type, read by the allow_paid_models gate (shouldForceFreeMode). */
  profileType: ProfileType;
  mode: Mode;
  protocol: ApiProtocol;
  url: string;
  model: string;
  authToken: string;
  secondModel: string;
  thirdModel: string;
  /** Free-only mode active (TRDD-8b6b3646). When true, freeModels is the source of truth. */
  freeOnly: boolean;
  /** Free-model pool in preference order (empty unless freeOnly OR mode
   *  "local" — TRDD-C9SXX7HO: local's own probe order is the fallback
   *  chain, and it reuses this field rather than a third one; entries end
   *  `:free` only under freeOnly, never for local's own model ids). */
  freeModels: string[];
  /** Per-tool model overrides (empty object when none). See resolveModelForTool. */
  toolModels: Record<string, string>;
  timeout: number;
  contextWindow: number;
  /** TRDD-1OOAH3LD: the profile request_options block, null when the profile sets none. */
  requestOptions: RequestOptionsConfig | null;
  /**
   * The broker engine of a managed profile (server: managed): "llama" for
   * api llamacpp-local (TRDD-1OOAH3LD), "locals" for locals-local
   * (TRDD-ZGSGGHQG); null when the profile starts no server.
   */
  server: "llama" | "locals" | null;
  appName: string;
  httpReferer: string;
  /** Resolved high-quality-scan model config (TRDD-DBUSM55E; defaults filled). */
  highQualityModel: ResolvedHighQualityModel;
  /**
   * The PRIMARY provider's preset is a local one (`ApiPreset.isLocal`).
   *
   * This is the honest source for "can a send cost money?", and it exists
   * because `BackendConfig.type` is NOT: type answers "which request format",
   * and a remote OpenAI-compatible preset resolves to type "local" while being
   * a real internet endpoint holding a real key. See assertFreeOnlyModel.
   */
  isLocal: boolean;
  /** The primary provider is free-by-nature (`ApiPreset.isFreeProvider`). */
  isFreeProvider: boolean;
  /**
   * Extra providers this profile routes to, in preference order (empty for a
   * single-provider profile, which is every pre-existing profile). Index 0 is
   * tried FIRST — this is the ordering the "b.ai first, OpenRouter as fallback"
   * behaviour reads.
   */
  routes: ResolvedRoute[];
  /**
   * model id → EVERY group that serves it, in group order (D6a). No group
   * lists the id → the catch-all groups (group #0 plus every group without
   * `models:`), in order. Replaces D0's `routeByModel` (first-binding-wins),
   * which could not represent two accounts serving one id.
   */
  routesFor: (modelId: string) => ResolvedRoute[];
  /**
   * Thin wrapper: `routesFor(id)[0] ?? null` — the route a request uses
   * today (billability checks, the queue pruning, the free rotation pool).
   * The chain walk (D6a) uses the full list instead.
   */
  routeForModel: (modelId: string) => ResolvedRoute | null;
  /**
   * True iff this profile's NAME is one of DYNAMIC_PROFILE_NAMES ("free"/"paid"/"local")
   * — set by resolveProfile from isDynamicProfileName(name). Optional (not
   * `dynamic: boolean`) so a hand-built ResolvedProfile fixture elsewhere in
   * the codebase (test-helpers.ts's local test backend, which this phase does
   * not own) keeps compiling without listing it; every caller through
   * resolveProfile always gets a concrete true/false. resolveModelChain reads
   * this to pick STATIC ("exactly what is written") vs DYNAMIC (head + ranked
   * fallback pool) behaviour.
   */
  dynamic?: boolean;
  /**
   * Dynamic `paid` only: the ranked pool of passing paid models (best first),
   * from `Profile.paid_models` (default `[]`). Optional for the same
   * compile-safety reason as `dynamic` above. resolveModelChain's fallback
   * pool for a dynamic non-free_only profile.
   */
  paidModels?: string[];
  /**
   * Provenance set (TRDD-FDI9NYAS D3b): every model id the USER hand-listed
   * in this profile — a STATIC profile's `chainModelIds(name, profile)`
   * (model/second_model/third_model/free_models/paid_models/tool_models plus
   * an explicit high_quality_model.id); empty for a DYNAMIC profile, since
   * D3b's auto-picked ranking has nothing manual yet (D5 adds reserved slots
   * later). This is what `ProviderDeps.isManualModel` reads to exempt a
   * hand-listed id from the benchmark-verdict and price gates that exist to
   * protect against an AUTO-PICKED id — exemption follows where a model CAME
   * FROM, not the profile's type, per the accepted provenance principle
   * (TRDD-DS6OM3KX). Optional for the same compile-safety reason as `dynamic`
   * above (a hand-built ResolvedProfile fixture elsewhere keeps compiling); a
   * caller reading it treats `undefined` as "no manual models" (empty set).
   */
  manualModels?: ReadonlySet<string>;
  /**
   * The reserved ensemble slots (D5, TRDD-90DM5YHO): at most 2, in written
   * order, from `Profile.ensemble.reserved`. Each member carries the model id
   * and its serving groups — the named `provider` group when the slot names
   * one (single-element array), else routesFor(model) (every group that
   * serves it, in group order; the `no provider:` = every group shape).
   * Read ONLY by index.ts's getEnsembleModels (design 2.2: "ignored outside
   * ensemble commands" — profileChain never sees these). Optional for the
   * same compile-safety reason as `dynamic`/`manualModels` above (a
   * hand-built ResolvedProfile fixture keeps compiling); a caller treats
   * undefined as "no reserved slots".
   */
  reservedSlots?: ResolvedReservedSlot[];
}

/** One resolved reserved ensemble slot (D5): the model id plus the groups
 *  that will serve it (see ResolvedProfile.reservedSlots). */
export interface ResolvedReservedSlot {
  modelId: string;
  routes: ResolvedRoute[];
}

/**
 * Optional per-profile "high-quality model" config (TRDD-DBUSM55E). Drives the
 * `high_quality_scan` tool: ONE strong model run at max reasoning instead of the
 * cheap 3-model ensemble, with deterministic OpenRouter provider/quantization
 * routing and prompt caching. Every sub-field is optional — an absent block (or
 * absent field) falls back to HIGH_QUALITY_MODEL_DEFAULTS, so `high_quality_scan`
 * works out-of-the-box on any OpenRouter profile.
 */
export interface HighQualityModel {
  /** OpenRouter model id. Default "z-ai/glm-5.2". */
  id?: string;
  /**
   * Reasoning effort: off|low|medium|high|xhigh|max. "max" is an alias for the
   * real OpenRouter ceiling "xhigh" (there is no literal "max" wire value).
   * Default "max".
   */
  reasoning_effort?: string;
  /** Enable prompt caching (cache_control breakpoint on the system prompt). Default true. */
  cache?: boolean;
  /**
   * Minimum acceptable quantization, expanded to "this precision or higher" for
   * OpenRouter's provider.quantizations filter. Default "fp8".
   */
  min_quantization?: string;
  /**
   * Preferred OpenRouter provider slug (may carry a quant variant suffix, e.g.
   * "gmicloud/fp8"), used as provider.order[0]. Default "gmicloud/fp8".
   */
  provider?: string;
  /**
   * Allow OpenRouter to fall back to other providers if the preferred one is
   * unavailable. Default false (pin the preferred provider).
   */
  allow_fallbacks?: boolean;
}

/**
 * Fully resolved high-quality-model config: defaults filled, "max"→"xhigh",
 * min_quantization expanded to the fp8-or-higher whitelist. Always present on a
 * ResolvedProfile (resolveHighQualityModel never returns null).
 */
export interface ResolvedHighQualityModel {
  id: string;
  /** One of off|xhigh|high|medium|low (the "max" alias already mapped to xhigh). */
  reasoningEffort: string;
  cache: boolean;
  /** OpenRouter provider.order list (the preferred provider slug). */
  providerOrder: string[];
  /** OpenRouter provider.quantizations whitelist (min_quantization expanded). */
  quantizations: string[];
  /** OpenRouter provider.allow_fallbacks. */
  allowFallbacks: boolean;
}

// ── High-quality model constants (TRDD-DBUSM55E) ────────────────────────────
// Quantization precision tiers, low → high. "fp8 or higher" = fp8 and every tier
// to its right. "unknown" is intentionally excluded (we want a KNOWN high-precision
// endpoint). Mirrors OpenRouter's provider.quantizations values.
const QUANT_TIERS: readonly string[] = Object.freeze([
  "int4",
  "fp4",
  "int8",
  "fp6",
  "fp8",
  "fp16",
  "bf16",
  "fp32",
]);

/** Built-in defaults for the high-quality scan model (the spec asked for). */
export const HIGH_QUALITY_MODEL_DEFAULTS: ResolvedHighQualityModel = {
  id: "z-ai/glm-5.2",
  reasoningEffort: "xhigh", // "max" maps here — the real OpenRouter ceiling
  cache: true,
  providerOrder: ["gmicloud/fp8"],
  quantizations: ["fp8", "fp16", "bf16", "fp32"], // fp8-or-higher
  allowFallbacks: false,
};

/** Accepted reasoning_effort tokens in YAML ("max" is an alias for "xhigh"). */
const VALID_HQ_REASONING: ReadonlySet<string> = new Set([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Ready-to-apply high-quality-scan request knobs, derived from a
 * ResolvedHighQualityModel at the high_quality_scan dispatch site and threaded
 * down the single-model scan path (ScanFolderDeps → processFileCheck →
 * ensembleStreaming → chatCompletionSimple). Defined in this leaf module so both
 * index.ts and scan-folder/core.ts can share ONE type (core.ts must not import
 * from index.ts). All fields optional → a no-op for every non-high_quality_scan
 * caller. `provider` is the OpenRouter provider-routing block (a control field
 * that survives the supported-params filter); `reasoning` is the wire effort
 * string ("xhigh" etc., cast to the effort union inside index.ts); `cache`
 * toggles the system-prompt cache_control breakpoint.
 */
export interface HighQualityRequest {
  provider?: Record<string, unknown>;
  reasoning?: string;
  cache?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── API Presets ──────────────────────────────────────────────────────
// Each preset bundles protocol + default connection settings.
// Names use -local / -remote suffix to prevent mode/preset mismatches.

/** TRDD-ZGSGGHQG: Locals (MLX) runs on macOS on Apple silicon only; the first darwin check in llm-ext. */
export function localsPlatformSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}
/**
 * The model-id errors of a locals-local profile or binding. Always refused: a
 * GGUF file (llama.cpp's format) and the `mlx/` prefix (Locals' stock mlx-lm
 * engine, which has no memory guard). Managed (the broker starts Locals with
 * `--model <id>` and checks /stats.model against it): the id must also be a
 * Hugging Face repo id, the broker's own parseLocalsModel rule (review F-8),
 * so a short alias or a path fails here, not at the first request.
 */
export function localsModelErrors(where: string, models: readonly string[], managed: boolean): string[] {
  const out: string[] = [];
  for (const m of models) {
    if (/\.gguf$/i.test(m)) out.push(`${where}: '${m}' is a GGUF model; api locals-local runs MLX models (use llamacpp-local for GGUF)`);
    else if (m.startsWith("mlx/")) out.push(`${where}: '${m}' selects Locals' stock mlx engine, which has no memory guard; use the plain model id`);
    else if (managed) {
      const p = parseLocalsModel(m);
      if ("error" in p) out.push(`${where}: ${p.error} (server: managed)`);
    }
  }
  return out;
}
export const API_PRESETS: Record<string, ApiPreset> = {
  // ── Local presets ─────────────────────────────────────────────────
  "lmstudio-local": {
    protocol: "lmstudio_api",
    defaultUrl: "http://localhost:1234",
    defaultAuthEnv: "$LM_API_TOKEN",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "ollama-local": {
    protocol: "openai_api",
    defaultUrl: "http://localhost:11434",
    defaultAuthEnv: "",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "vllm-local": {
    protocol: "openai_api",
    defaultUrl: "http://localhost:8000",
    defaultAuthEnv: "$VLLM_API_KEY",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "llamacpp-local": {
    protocol: "openai_api",
    defaultUrl: "http://localhost:8080",
    defaultAuthEnv: "",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "generic-local": {
    protocol: "openai_api",
    defaultUrl: "",
    defaultAuthEnv: "$LM_API_TOKEN",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  // TRDD-ZGSGGHQG: the Locals server (MLX models, macOS on Apple silicon only).
  // No default url: Locals' own default port (8321) is the user's own server,
  // and a managed profile's url binds nothing (the broker picks the port).
  // 1800 s: a Locals request held for memory or a slot produces no bytes.
  "locals-local": {
    protocol: "openai_api",
    defaultUrl: "",
    defaultAuthEnv: "",
    defaultTimeout: 1800,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  // ── Remote presets ────────────────────────────────────────────────
  "openrouter-remote": {
    protocol: "openrouter_api",
    defaultUrl: "https://openrouter.ai/api",
    defaultAuthEnv: "$OPENROUTER_API_KEY",
    defaultTimeout: 600, // 10 min — reasoning models (Qwen, etc.) need extended thinking time

    defaultAppName: "llm-externalizer",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: false,
  },
  // chat.b.ai — a second REMOTE provider, free at the provider (no per-token
  // billing), OpenAI-compatible. Base URL omits the `/v1` because
  // resolveConnection appends `/v1/chat/completions`; verified live returning a
  // standard OpenAI body for `glm-5.3-flash`.
  //
  // protocol is "openai_api", NOT "openrouter_api", and that choice is
  // load-bearing rather than cosmetic. makeBackendFromProfile() maps
  // `openrouter_api` → `backend.type === "openrouter"`, which switches on the
  // whole OpenRouter-specific request path: the `reasoning: {effort}` field,
  // provider routing, credit/402 auto-free, ensemble fan-out, and — fatally —
  // assertFreeOnlyModel()'s rule that every model id must end in ':free'.
  // b.ai ids carry no such suffix, so under the master free-by-default switch
  // (shouldForceFreeMode forces free for ANY remote profile) every request
  // would be refused before the wire. "openai_api" keeps this backend on the
  // plain OpenAI POST, which is exactly what b.ai serves.
  //
  // Consequence worth knowing: backend.type is therefore "local" for this
  // preset, so resolveConnection runs detectLMStudio() once. b.ai answers the
  // native probe path (/api/v1/models) with 403, so the probe falls through to
  // the OpenAI-compat path and the result is cached per baseUrl — one wasted
  // request per process, no misdetection.
  "chat-b-ai-remote": {
    protocol: "openai_api",
    defaultUrl: "https://api.b.ai",
    defaultAuthEnv: "$BAI_API_KEY",
    // b.ai serves its models at no per-token cost, and its ids carry no ':free'
    // suffix. See ApiPreset.isFreeProvider — this is what lets a free_only
    // profile use `glm-5.3-flash` without weakening the suffix rule that guards
    // OpenRouter, where spend is actually possible.
    isFreeProvider: true,
    // Matches openrouter-remote: glm-5.3-flash is a reasoning model and spends
    // most of its completion budget on reasoning tokens before emitting content.
    defaultTimeout: 600,

    defaultAppName: "llm-externalizer",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: false,
  },
};

// ── Paths ────────────────────────────────────────────────────────────
// Cross-platform: homedir() + join() works on macOS, Linux, Windows WSL.

/** Config directory: ~/.llm-externalizer (or LLM_EXT_CONFIG_DIR for CI) */
export function getConfigDir(): string {
  const raw = resolve(process.env.LLM_EXT_CONFIG_DIR || join(homedir(), ".llm-externalizer"));
  // Resolve symlinks in the deepest existing ancestor so that a symlink like
  // $HOME/.evil -> /etc is followed even when the full path doesn't exist yet.
  // Without this, mkdirSync(dir, { recursive: true }) follows symlinks in the
  // existing prefix while the guard sees only the unresolved string, allowing
  // directory creation outside allowed paths.
  function resolveDeepestExisting(p: string): string {
    try { return realpathSync(p); } catch { /* p doesn't exist */ }
    const parent = join(p, "..");
    if (parent === p) return p; // filesystem root
    const resolvedParent = resolveDeepestExisting(parent);
    return join(resolvedParent, p.slice(parent.length + (parent.endsWith("/") || parent.endsWith("\\") ? 0 : 1)));
  }
  const dir = resolveDeepestExisting(raw);
  // M8: Path traversal guard — config dir must be under homedir() or /tmp.
  // Resolve home and /tmp through symlinks so the comparison uses canonical paths
  // (e.g. /tmp → /private/tmp on macOS; homedir() may also be a symlink).
  const home = (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })();
  const tmpCanonical = (() => { try { return realpathSync("/tmp"); } catch { return "/tmp"; } })();
  const sep = process.platform === "win32" ? "\\" : "/";
  const underHome = dir.startsWith(home + sep) || dir === home;
  const underTmp = dir.startsWith(tmpCanonical + sep) || dir === tmpCanonical;
  if (!underHome && !underTmp) {
    throw new Error(`Config directory '${dir}' is outside allowed paths (${home} or ${tmpCanonical})`);
  }
  return dir;
}

/** Settings file: ~/.llm-externalizer/settings.yaml */
export function getSettingsPath(): string {
  return join(getConfigDir(), "settings.yaml");
}

// ── Env var resolution ──────────────────────────────────────────────

// Map of env-var names that have a corresponding plugin.json userConfig key.
// When the user sets a value via the Claude Code plugin config UI, Claude
// exports it as CLAUDE_PLUGIN_OPTION_<KEY> to this subprocess. We transparently
// map that into the canonical env-var name the rest of the code reads from,
// so both new (userConfig) and old (shell env var) setups work unchanged.
// Preference: userConfig wins over shell env if both are set.
// WHY exported: l0-independent callers (classifiers/l2/profile.ts) name this variable in an error text and must not duplicate the string.
export const OPENROUTER_PLUGIN_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY";
const USER_CONFIG_ENV_MAP: Record<string, string> = {
  OPENROUTER_API_KEY: OPENROUTER_PLUGIN_OPTION_ENV,
};

/**
 * Resolve a value that may be an env var reference.
 * - Values starting with '$' are env var names → resolved from process.env
 * - All other values are direct values → returned as-is
 * - Empty/undefined → returns ''
 *
 * For env vars in USER_CONFIG_ENV_MAP, the corresponding CLAUDE_PLUGIN_OPTION_*
 * var takes precedence if non-empty. This means plugin.json userConfig values
 * override shell env vars — users can migrate to userConfig without changing
 * anything else in their setup.
 */
export function resolveEnvValue(value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("$")) {
    // M9: Trim env var name to prevent whitespace injection (e.g. "$VAR_NAME ")
    const name = value.slice(1).trim();
    const userConfigVar = USER_CONFIG_ENV_MAP[name];
    if (userConfigVar) {
      const userConfigVal = process.env[userConfigVar];
      // Whitespace-only is "not set": it must not shadow a real value of the named variable.
      if (userConfigVal && userConfigVal.trim().length > 0) return userConfigVal;
    }
    return process.env[name] || "";
  }
  return value;
}

// ── URL validation ──────────────────────────────────────────────────

// EVERY alternative is anchored with `([:/]|$)`. Without it the private-IP
// branches match as a PREFIX, so `http://127.0.0.1.evil.com` — a perfectly
// routable internet host — was classified LOCAL. Verified before the fix:
// `//127.`, `//192.168.`, `//10.` and `//172.16-31.` all returned true for
// `<private-ip>.<attacker-domain>`; `localhost` was already anchored and did not.
//
// That is the UNSAFE direction. isLocalUrl now feeds a billability decision
// (ResolvedProfile.isLocal / ResolvedRoute.isLocal), where "local" means "cannot
// charge me" — so a false positive marks a billable host free and free_only lets
// the send through. It also hardens validateProfile's older "Remote mode cannot
// use local URL" check, which had the same blind spot.
// The terminator class is `[:/?#]` — port, path, QUERY, FRAGMENT — or end of
// string. `?` and `#` are load-bearing: `http://127.0.0.1?x=1` is a legitimate
// local URL, and anchoring on `[:/]` alone would classify it REMOTE. `[::1]` is
// anchored too; leaving one alternative unanchored reopens the hole for
// `http://[::1].evil.com` exactly as it was open for the IPv4 forms.
// `String.raw` is MANDATORY here, not a style choice. Quoted strings eat the
// backslashes, silently and without an error, and the damage runs in BOTH
// directions at once — so there is no "safe failure" to fall back on:
//
//   `\d` → `d`   the four private-IP alts demand a literal "d": `//127\.\d+…`
//                becomes `//127.d+…`, so `//127.0.0.1` stops matching (NARROWS).
//   `\.` → `.`   an alt with `\.` but NO `\d` only widens: `\/\/0\.0\.0\.0`
//                becomes `//0.0.0.0`, and `//0X0Y0Z0` matches (WIDENS).
//   `\[` → `[`   `\[::1\]` becomes the CHARACTER CLASS `[::1]` — any one of `:`
//                or `1` — so `//1:8080`, `//1/`, `//::x` read as LOCAL (WIDENS).
//   `\/` → `/`   INERT, and that is why it is not in the list above. `/` is only
//                special in a regex LITERAL (it terminates the pattern); in a
//                `new RegExp` string it is an ordinary character either way. So
//                `\/\/localhost…`, whose only escapes are `\/`, survives the
//                collapse UNCHANGED — do not read its survival as evidence that
//                the collapse is harmless.
//
// All three measured in node. The two patterns are INCOMPARABLE — neither is a
// superset of the other, and BOTH damages are live at once: alternatives are
// OR-ed, so one widened alt is enough to admit a host that must not be admitted
// (`//0X0Y0Z0`, `//1:8080` — collapsed matches, correct does not), while the
// narrowed alts simultaneously reject real local hosts (`//127.0.0.1` — correct
// matches, collapsed does not). Three drafts of this comment each claimed a
// single direction ("widens", "the narrowing dominates", "MORE permissive"); all
// three were wrong, because the direction is per-alternative. Do not reason
// about which way it fails — keep the backticks.
const LOCAL_TERM = String.raw`([:/?#]|$)`;
const LOCAL_URL_PATTERN = new RegExp(
  [
    String.raw`\/\/localhost${LOCAL_TERM}`,
    // mDNS .local hostnames (item A3c/D3): anchored by a hostname-char class on
    // the left and LOCAL_TERM on the right, so `mymac.local.evil.com` does NOT
    // match (real remote host) and `mymac.local:1234` DOES.
    String.raw`\/\/[a-zA-Z0-9-]+\.local${LOCAL_TERM}`,
    String.raw`\/\/127\.\d+\.\d+\.\d+${LOCAL_TERM}`,
    String.raw`\/\/192\.168\.\d+\.\d+${LOCAL_TERM}`,
    String.raw`\/\/10\.\d+\.\d+\.\d+${LOCAL_TERM}`,
    String.raw`\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+${LOCAL_TERM}`,
    String.raw`\/\/\[::1\]${LOCAL_TERM}`,
    String.raw`\/\/0\.0\.0\.0${LOCAL_TERM}`,
  ].join("|"),
  "i",
);

/** Check if a URL points to a local/private network address */
export function isLocalUrl(url: string): boolean {
  return LOCAL_URL_PATTERN.test(url);
}

// ── Settings load / save ────────────────────────────────────────────

/**
 * Does `profiles.<name>` in this parsed document carry GENERATED_MARKER?
 * Returns "absent" when there is no such section at all.
 *
 * THE ONE READER, shared by loadSettings (the reserved-name refusal),
 * writeDynamicProfileSection (the hand-authored-section backup) and the
 * migration — three places that must agree on "did we write this", because
 * they disagree into either a destroyed user section or an unusable config.
 *
 * WHY it is not just `item.key.commentBefore`: the `yaml` library attaches a
 * comment that precedes the FIRST key of a collection to the COLLECTION, not
 * to that key (measured, 2026-09-17). `free` is the first entry in every
 * generated settings.yaml, so reading only the key said "unmarked" about the
 * file llm-ext had just written itself — which would have made the maintainer
 * back the file up and print "your previous version was saved" on every single
 * write. The comment is still EMITTED from the key (that round-trips fine); it
 * is the read side that has to look in both places.
 */
export function profileSectionMarkerState(
  doc: ReturnType<typeof parseDocument>,
  name: string,
): "absent" | "marked" | "unmarked" {
  const profilesMap = doc.get("profiles", true) as
    | { items?: Array<{ key: Scalar | string }>; commentBefore?: unknown }
    | undefined;
  const items = profilesMap?.items;
  if (!Array.isArray(items)) return "absent";
  const index = items.findIndex(
    (it) => (it.key instanceof Scalar ? it.key.value : it.key) === name,
  );
  if (index < 0) return "absent";
  const item = items[index];
  // A raw-string key cannot carry a comment at all, so "no marker" is the
  // correct reading for one — not an omission.
  let comment = item.key instanceof Scalar ? item.key.commentBefore : undefined;
  if (typeof comment !== "string" && index === 0) {
    comment = typeof profilesMap?.commentBefore === "string" ? profilesMap.commentBefore : undefined;
  }
  return typeof comment === "string" && comment.includes(GENERATED_MARKER)
    ? "marked"
    : "unmarked";
}

/**
 * Which DYNAMIC-named sections in this settings.yaml text are NOT ours.
 *
 * Reads the document (comments and all) rather than the parsed object, since
 * the marker is a comment. Never throws: unparseable text yields `[]` — the
 * caller's own parse is what reports that failure.
 *
 * Fails toward "marked" on doubt: an UNMARKED verdict is what refuses the
 * user's whole configuration, so it is only ever returned for a section we
 * positively found and positively could not see a marker on.
 */
function unmarkedDynamicProfileNames(raw: string): string[] {
  try {
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) return [];
    // WHY `or-jev` is not asked for the marker (PF-04, plan E83 "migration leaves it, warns"): an existing hand-written `or-jev` is the user's own and the migration leaves the file byte-identical, so an unmarked one must still load; it is validated as a profile of its declared type like any custom one. Only a fresh install and the migration's "absent" branch write it with the marker.
    return MARKED_PROFILE_NAMES.filter(
      (name) => name !== "or-jev" && profileSectionMarkerState(doc, name) === "unmarked",
    );
  } catch {
    return [];
  }
}

/**
 * Load settings.yaml from the config directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadSettings(): Settings | null {
  const settingsPath = getSettingsPath();
  try {
    if (!existsSync(settingsPath)) return null;
    const raw = readFileSync(settingsPath, "utf-8");
    // H10: Sanitize YAML output to strip __proto__ and prevent prototype pollution
    const parsed = JSON.parse(JSON.stringify(yamlParse(raw)));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      // WHY (TRDD-G6XT3AY9): active: is a live selector again -- this is the
      // raw value effectiveProfileName()/validateSettings() read. undefined
      // (not empty string) when absent, so callers can tell "no active key"
      // apart from "set to empty" (both fall back to DEFAULT_PROFILE_NAME).
      active: typeof parsed.active === "string" && parsed.active ? parsed.active : undefined,
      // PF-03: raw like `active`; a non-string or empty value reads as absent, a dangling name is reported by activeClassifierErrors.
      active_classifier: typeof parsed.active_classifier === "string" && parsed.active_classifier ? parsed.active_classifier : undefined,
      profiles: parsed.profiles || {},
      // PT-02: E81g turns on only once the migration has written the type into every profile (see profileTypesSettingsErrors); the migration record is the single source.
      profileTypesMigrated: isMigrationStepApplied(PROFILE_TYPE_STEP),
      // Absent / any non-true value <=> false: the safe (free) side. A YAML that
      // predates this key, or sets it to a typo, never accidentally enables paid.
      allow_paid_models: parsed.allow_paid_models === true,
      // D0 (TRDD-AL8GIZYA): the RAW value, uncoerced — this key is only ever
      // DETECTED now (never read by getEnsemblePriceCeiling(), which reads
      // profiles.paid.selection instead), so settingsLevelErrors' E-D3 needs
      // the actual value the user wrote, not a pre-validated/defaulted one.
      legacyEnsemblePriceCeiling: parsed.ensemble_price_ceiling_usd_per_million as
        | number
        | undefined,
      // fix-queue 74: this field was NEVER copied out of `parsed` here, so a
      // configured cap silently fell back to DEFAULT_PAID_DAILY_CAP_USD (0.5)
      // and appendCapErrors' validation below was unreachable through the real
      // load path. Copy the RAW value, not coerced/validated here --
      // appendCapErrors NEEDS the actual invalid value to report a useful
      // error, so validating it here would erase the evidence first (the
      // same reason legacyEnsemblePriceCeiling above is copied raw).
      paid_benchmark_daily_cap_usd: parsed.paid_benchmark_daily_cap_usd as number | undefined,
      // Raw copies (same reason as paid_benchmark_daily_cap_usd above): the
      // scout getters validate in one place; a malformed value must stay
      // visible, not be silently defaulted at load time.
      scout_price_ceiling_usd_per_million:
        parsed.scout_price_ceiling_usd_per_million as number | undefined,
      scout_accuracy_target_bytes: parsed.scout_accuracy_target_bytes as number | undefined,
      scout_accuracy_threshold: parsed.scout_accuracy_threshold as number | undefined,
      // Computed from the raw text, because `yamlParse` discards comments and
      // the marker IS a comment. Only when a marked-name section is actually
      // present, so the ordinary load costs no second parse. PT-04: `scouting` carries the marker too, so it is checked here (MARKED_PROFILE_NAMES), not only the three dynamic names.
      unmarkedDynamicProfiles: MARKED_PROFILE_NAMES.some(
        (n) => parsed.profiles && typeof parsed.profiles === "object" && n in parsed.profiles,
      )
        ? unmarkedDynamicProfileNames(raw)
        : [],
    };
  } catch (err) {
    process.stderr.write(
      `[llm-externalizer] Warning: Failed to read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

// ── Dynamic built-in profiles (owner directive) ─────────────────────────────
//
// EXACTLY THREE profiles are MACHINE-OWNED: `free`, `paid` and `local` (PT-01:
// the FIVE built-in templates are BUILTIN_PROFILE_NAMES; `scouting` and `or-jev`
// are built-ins too but do not populate themselves). Unlike every
// other profile (hand-written by the user or the setup-wizard agent), these
// carry NO predefined model ids — llm-ext owns their settings.yaml sections
// and keeps them working: availability, price and specs are re-checked on
// every dispatch (dynamic-maintainer.ts) and candidates are benchmarked in
// the background.
//
//   free — the passing free ('*:free', plus any non-billable provider route)
//          pool, best-first: `model` is freeModels[0] and the rest are the
//          rotation fallbacks, so a 429 on the head has somewhere to go.
//   paid — the PAID models whose input AND output price are both at or under
//          DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M (override via
//          `profiles.paid.selection.price_ceiling_usd_per_million`, D0), plus
//          the per-tool heads.
//
// P6c-a (spec item 5, addendum E): the earlier five-name machine-owned list
// and its three extra placeholder helpers are GONE. They were the pre-dynamic
// design (a separate machine-owned profile per SHAPE), and keeping them
// alongside the dynamic pair meant TWO maintenance engines could write the
// same settings.yaml. `free`/`paid` absorb every shape: the ensemble slots ARE
// the top-3 of the same pool, and the mass-scout head is a `tool_models`
// entry. Every other profile is STATIC: used exactly as written, never
// modified, fails fast.
//
// TRDD-C9SXX7HO (D2): `local` joins as the third MACHINE-OWNED profile — its
// content comes from local_discovery/scan.ts's probe, never the OpenRouter
// catalog, so it is maintained by a COMPLETELY SEPARATE engine (the
// scan-only detector row in profile-detector.ts's DETECTORS table +
// benchmark/index.ts's `runPopulateLocalDefaultProfile`) that never runs
// `decideDynamicProfile`/`maintainOneDynamicProfile` — those two remain
// catalog-price-ranking engines, and running them for `local` would rank and
// PRUNE local endpoints by a nonexistent catalog price, which the card
// explicitly forbids.
export const DYNAMIC_PROFILE_NAMES = ["free", "paid", "local"] as const;
export type DynamicProfileName = (typeof DYNAMIC_PROFILE_NAMES)[number];
export function isDynamicProfileName(name: string): name is DynamicProfileName {
  return (DYNAMIC_PROFILE_NAMES as readonly string[]).includes(name);
}

// PT-04: `scouting` is a built-in written with the generated marker and a closed key set, but it does NOT populate itself (only `benchmark scout-accuracy` fills it). WHY a separate list: keying it on DYNAMIC_PROFILE_NAMES would hand it to the maintainer, detectors and populate flags, which would rewrite it from the catalog. Marker, closed-key and writer checks key on this list; self-population keeps keying on DYNAMIC_PROFILE_NAMES.
export const MARKED_PROFILE_NAMES = [...DYNAMIC_PROFILE_NAMES, "scouting", "or-jev"] as const;
export type MarkedProfileName = (typeof MARKED_PROFILE_NAMES)[number];
export function isMarkedProfileName(name: string): name is MarkedProfileName {
  return (MARKED_PROFILE_NAMES as readonly string[]).includes(name);
}

/** The profile a command uses when no --profile is given. */
export const DEFAULT_PROFILE_NAME: DynamicProfileName = "free";

/**
 * The closed set of keys `writeDynamicProfileSection` ever rewrites in a
 * dynamic profile's section, per profile name (design section 3.1's final
 * end-state table — it never grows: a key llm-ext generates today keeps
 * being generated by the end of 14.1.0; only DYNAMIC_USER_OWNED_KEYS below
 * grows slice by slice). `validateProfile`'s closed-key check (E-D1) refuses
 * anything in a dynamic section that is in neither this nor
 * DYNAMIC_USER_OWNED_KEYS[name].
 *
 * D0 fix-up (TRDD-AL8GIZYA): design section 3.1's own table stages
 * `providers` out of D0 entirely (it lands with D5/D6a). But
 * `default-profiles.ts`'s unpopulated-`free` arm and `benchmark/index.ts`'s
 * free-benchmark child already write a `providers[]` b.ai binding on `free`
 * TODAY, and `local-profile.ts`'s `buildLocalProfileSection` already writes
 * `providers` (not yet renamed `detected_providers`) on `local` TODAY — a
 * live feature, and every D-slice ships in the same 14.1.0 release with no
 * release in between (section 6's preface). Landing the table literally
 * would make E-D1 refuse llm-ext's own write mid-release. So `providers` is
 * GENERATED here for `free` and `local` from D0 on — matching what already
 * runs — until D5 (free) / D6a (local, with the rename) change its
 * ownership per the design. No generator writes `providers` on `paid`
 * today, so it is USER-OWNED there from D0 on (below) instead — the
 * design's own D6a end state, early, at no conflict cost (nothing
 * regenerates it).
 */
export const DYNAMIC_GENERATED_KEYS: Readonly<Record<MarkedProfileName, readonly string[]>> = {
  free: ["mode", "api", "url", "api_key", "free_only", "free_models", "model", "second_model", "third_model", "tool_models"],
  paid: ["mode", "api", "url", "api_key", "model", "second_model", "third_model", "paid_models", "tool_models"],
  local: ["mode", "api", "url", "api_token", "model", "free_models", "detected_providers"],
  // PT-04: `scouting` has no paid_models (nothing reads it, profile-fallback.ts) and no user-owned subsections but the type.
  scouting: ["mode", "api", "url", "api_key", "model"],
  // PF-03: `or-jev` is marked but nothing regenerates it; these are the template's own keys. The classifier's other fields (endpoint, concurrency, ...) stay legal through PROFILE_TYPE_FIELDS.classifier (profileTypeFieldIssues), so they are not repeated here.
  "or-jev": ["api", "api_key", "model"],
};

/**
 * Keys the user owns inside a dynamic profile section, per profile name —
 * every regeneration preserves their YAML nodes (comments, key order)
 * exactly. D0 shipped `selection` and `high_quality_model` on every dynamic
 * profile. `providers` is ALSO user-owned on `paid` from D0 on (see
 * DYNAMIC_GENERATED_KEYS's comment above — no generator writes it there
 * today, so nothing conflicts). D6a added it for `local` too (renamed —
 * `local`'s GENERATED table above carries the key, so D6a only
 * needed to rename it, not move it here). D5 (TRDD-90DM5YHO) completes the
 * design section 3.1 end-state: `providers` joins `free`'s USER-OWNED set
 * (the generated b.ai binding stopped being written this slice — the b.ai
 * route is the user's own group now, seeded once by the
 * `bai-binding-to-reserved-slot` / `bai-reserved-seed` migration steps), and
 * `ensemble` joins EVERY dynamic profile's USER-OWNED set.
 */
export const DYNAMIC_USER_OWNED_KEYS: Readonly<Record<MarkedProfileName, readonly string[]>> = {
  // PT-01: `profile-type` is USER-OWNED, not GENERATED, although PT-02 writes it:
  // writeDynamicProfileSection deletes every generated key its patch omits, and
  // the unpopulated placeholders carry no type, so a generated key would strip
  // the migrated type on the next regeneration. User-owned keys are preserved.
  free: ["selection", "high_quality_model", "providers", "ensemble", "profile-type"],
  paid: ["selection", "high_quality_model", "providers", "ensemble", "profile-type"],
  // TRDD-1OOAH3LD: request_options is user-written; without this the dynamic-section regeneration would delete it from the built-in `local` profile.
  // TRDD-1OOAH3LD 2a-core: server is user-written too; same deletion risk as request_options.
  local: ["selection", "high_quality_model", "providers", "ensemble", "profile-type", "request_options", "server"],
  scouting: ["profile-type"],
  "or-jev": ["profile-type"],
};

/**
 * The keys `Profile.selection` itself recognizes, per dynamic profile (D0
 * ships only `paid`'s ceiling — section 1.2: "free and local: none yet, an
 * empty map is allowed"). Any other key inside `selection` is E-L1's
 * "unknown key" case.
 */
const SELECTION_ALLOWED_KEYS: Readonly<Record<DynamicProfileName, readonly string[]>> = {
  free: [],
  paid: ["price_ceiling_usd_per_million"],
  local: [],
};


// ── Profile types (PT-01, TRDD-QRF04JVJ; user ruling 2026-10-07) ────────────
//
// Every profile has ONE of five types, written as `profile-type:` (the user's
// own spelling, D20 — every other new key stays snake_case). THIS table is the
// single source for which fields a type may carry, which built-in profile is
// its template, and whether its calls are gated by `allow_paid_models` (D36);
// validation, templates and `settings new` (PT-08) read it, nothing re-lists it.
export const PROFILE_TYPES = ["local", "free", "paid", "scouting", "classifier"] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];
export function isProfileType(value: unknown): value is ProfileType {
  return typeof value === "string" && (PROFILE_TYPES as readonly string[]).includes(value);
}

/**
 * D36 spend rules: `gated` = billed calls need `allow_paid_models: true` (paid,
 * scouting); `never-bills` = cannot spend (free, local); `ungated` = billed by
 * design, only the per-run `--max-budget` caps it (classifier, D2).
 */
export type ProfileTypeSpend = "gated" | "never-bills" | "ungated";

export interface ProfileTypeFields {
  /** The built-in profile that is this type's template. */
  readonly template: string;
  /** Fields only this type may carry (PT-06 rejects them on other types). */
  readonly own: readonly string[];
  /** Fields the type shares with other types. */
  readonly shared: readonly string[];
  readonly spend: ProfileTypeSpend;
}

export const PROFILE_TYPE_FIELDS: Readonly<Record<ProfileType, ProfileTypeFields>> = {
  // PT-06: app_name/http_referer are read by resolveProfile for every chat profile (OpenRouter dashboard attribution) but the plan's field table omitted them; without them in `shared` the strict check would reject a valid custom profile.
  local: {
    template: "local",
    own: ["api_token", "detected_providers"],
    // TRDD-1OOAH3LD: request_options is local-only (never on free/paid/scouting); without being listed here the strict unknown-field check rejects it.
    // TRDD-1OOAH3LD 2a-core: server (the managed llama-server opt-in) is local-only for the same reason.
    // P5: second_model/third_model too, but only with server: managed (profileTypeFieldIssues).
    shared: ["profile-type", "mode", "api", "url", "model", "second_model", "third_model", "free_models", "timeout", "context_window", "tool_models", "providers", "app_name", "http_referer", "request_options", "server"],
    spend: "never-bills",
  },
  free: {
    template: "free",
    own: ["free_only"],
    shared: ["profile-type", "mode", "api", "url", "api_key", "model", "second_model", "third_model", "free_models", "timeout", "context_window", "tool_models", "providers", "high_quality_model", "app_name", "http_referer"],
    spend: "never-bills",
  },
  paid: {
    template: "paid",
    own: ["selection", "ensemble"],
    shared: ["profile-type", "mode", "api", "url", "api_key", "model", "second_model", "third_model", "paid_models", "timeout", "context_window", "tool_models", "providers", "high_quality_model", "app_name", "http_referer"],
    spend: "gated",
  },
  scouting: {
    template: "scouting",
    // The scout-accuracy pass record lives in the benchmark ledger, not in the profile, so no own field. PT-04: no paid_models (plan section 8 field table; nothing reads it).
    own: [],
    shared: ["profile-type", "mode", "api", "url", "api_key", "model"],
    spend: "gated",
  },
  classifier: {
    template: "or-jev",
    own: ["endpoint", "max_requests_per_call", "concurrency", "timeout_ms", "max_attempts", "context_tokens", "provider", "session_id", "user", "trace"],
    shared: ["profile-type", "api", "api_key", "model"],
    spend: "ungated",
  },
};

// WHY a second list beside DYNAMIC_PROFILE_NAMES: the built-in templates are
// FIVE (free, paid, local, scouting, or-jev), each with a FIXED type, but only
// the first three populate themselves (dynamic-maintainer.ts,
// `--populate-default-profile`). Self-population therefore keeps keying on
// DYNAMIC_PROFILE_NAMES; fixed types key on this list. The marker and
// closed-key checks key on MARKED_PROFILE_NAMES (the dynamic three plus
// `scouting`, PT-04, and `or-jev`, PF-03: a fresh install writes it marked). An
// EXISTING hand-written `or-jev` stays as the user wrote it (PF-04, E83): the
// reserved-name refusal and the closed-key set skip `or-jev`; the writer refusal
// (refuseDynamicProfileWrite) still keys on the name.
const BUILTIN_TYPE_BY_NAME: ReadonlyMap<string, ProfileType> = new Map(
  PROFILE_TYPES.map((t): [string, ProfileType] => [PROFILE_TYPE_FIELDS[t].template, t]),
);
export const BUILTIN_PROFILE_NAMES: readonly string[] = [...BUILTIN_TYPE_BY_NAME.keys()];
export function builtinProfileType(name: string): ProfileType | undefined {
  return BUILTIN_TYPE_BY_NAME.get(name);
}

export function isPaidGatedProfileType(type: ProfileType): boolean {
  return PROFILE_TYPE_FIELDS[type].spend === "gated";
}

/**
 * The type a profile has today: the explicit `profile-type`, else the rules
 * that applied before the field existed (plan section 8). PT-02 writes the
 * field into every profile and then DELETES the inferred branch of this
 * function, leaving one way to know a type. An invalid explicit value throws
 * the profileTypeErrors message, so the spend gate never sees a bogus type.
 */
export function inferProfileType(name: string, profile: Profile): ProfileType {
  // WHY throw: the spend gate indexes PROFILE_TYPE_FIELDS by this value; an unvalidated bogus type would be a TypeError (or an ungated bypass) instead of the load error.
  const typeErrors = profileTypeErrors(name, profile);
  if (typeErrors.length > 0) throw new Error(typeErrors[0]);
  const explicit = profile["profile-type"];
  if (explicit !== undefined) return explicit as ProfileType;
  const builtin = builtinProfileType(name);
  // WHY `mode` excludes the name rule for `or-jev` (PF-04, E83): a hand-written chat profile that happens to be named `or-jev` is left untouched by the migration; typing it `classifier` by its name would give a billed chat profile the ungated classifier spend rule. A classifier has no `mode` (validateClassifierProfile).
  if (builtin !== undefined && !(name === "or-jev" && profile.mode !== undefined)) return builtin;
  if (profile.free_only === true) return "free";
  if (profile.mode === "local") return "local";
  return "paid";
}


/** The profile types a text command (and `active:`) may use; profile-accept.ts TEXT_PROFILE_TYPES is the same list (it imports this file, so the list cannot be imported back). */
const TEXT_TYPES: readonly ProfileType[] = ["local", "free", "paid"];

/**
 * True when no profile is a TEXT profile (local, free or paid). WHY one shared predicate: the self-heal of the built-in default `free`
 * (index.ts overrideActiveProfile) and every other "this file has no profiles yet" check must not count the classifier `or-jev` (PF-04
 * adds it to a file that has no profile at all) or a scouting profile as "the user has profiles". A profile whose type cannot be
 * inferred counts as a text profile: it is the user's, and its own error is reported where it is used.
 */
export function hasNoTextProfile(profiles: Readonly<Record<string, Profile>>): boolean {
  return Object.entries(profiles).every(([name, profile]) => {
    try {
      return !TEXT_TYPES.includes(inferProfileType(name, profile));
    } catch {
      return false;
    }
  });
}

/** migrationsApplied step id of the PT-02 migration; loadSettings derives `profileTypesMigrated` from it. */
export const PROFILE_TYPE_STEP = "profile-type-written";

/**
 * The keys of `profile` that the strict per-type check (PT-06, D33) will reject
 * for a profile of `type`: a field of another type, or unknown to every type.
 * PT-02 prints these so nothing starts failing without warning. Generated and
 * user-owned keys of the dynamic sections are legitimate and never listed.
 */
export function profileTypeFieldIssues(name: string, profile: Profile, type: ProfileType): string[] {
  const fieldsOf = (t: ProfileType): readonly string[] => [...PROFILE_TYPE_FIELDS[t].own, ...PROFILE_TYPE_FIELDS[t].shared];
  const allowed = new Set<string>(fieldsOf(type));
  if (isMarkedProfileName(name)) {
    for (const k of [...DYNAMIC_GENERATED_KEYS[name], ...DYNAMIC_USER_OWNED_KEYS[name]]) allowed.add(k);
  }
  const issues: string[] = [];
  for (const key of Object.keys(profile)) {
    if (allowed.has(key)) continue;
    const owners = PROFILE_TYPES.filter((t) => t !== type && fieldsOf(t).includes(key));
    issues.push(
      owners.length > 0
        ? `profiles.${name}.${key} belongs to type ${owners.join("/")}, not '${type}'. Fix: delete the key, or set profile-type to ${owners.join(" or ")}`
        : `profiles.${name}.${key} is unknown to every profile type. Fix: delete the key`,
    );
  }
  // P5 (TRDD-1OOAH3LD, TRDD-ZGSGGHQG): a local profile may name three models
  // only when the local-model broker serves it: server: managed AND api
  // llamacpp-local or locals-local (review m6: the api is checked here too,
  // so a typo in an unselected profile fails at load like every PT-06 issue;
  // validateProfile repeats the server/api rule for the selected profile).
  // The broker starts each model's server in turn. An unmanaged local url
  // serves what its own server loaded, so a second id there would silently be
  // the same model.
  const brokerServed = profile.server === "managed" && (profile.api === "llamacpp-local" || profile.api === "locals-local");
  if (type === "local" && !brokerServed) {
    for (const key of ["second_model", "third_model"] as const) {
      if (profile[key] !== undefined) issues.push(`profiles.${name}.${key} needs server: managed with api llamacpp-local or locals-local on a local profile (only the local-model broker serves several models of one profile). Fix: set both, or delete the key`);
    }
  }
  return issues;
}

/** E81d + E113: an explicit `profile-type` must be one of the five and, on a built-in name, its fixed type. */
export function profileTypeErrors(name: string, profile: Profile): string[] {
  const raw: unknown = profile["profile-type"];
  if (raw === undefined) return [];
  if (!isProfileType(raw)) {
    return [`Profile '${name}': profile-type '${String(raw)}' is not one of ${PROFILE_TYPES.join(", ")}`];
  }
  const fixed = builtinProfileType(name);
  if (fixed !== undefined && fixed !== raw) {
    // WHY the fix in the message (PF-04, E113): the migration leaves a hand-written section byte-identical (E83), so the user is the one who resolves the collision, and no command renames a profile.
    return [`Profile '${name}': built-in profile '${name}' has the fixed profile-type '${fixed}', not '${raw}'. A built-in name has a fixed type. Fix: rename the profile to another name in settings.yaml (and in 'active:' or '--profile' if they name it), or make it a '${fixed}' profile.`];
  }
  return [];
}

/**
 * OpenRouter ProviderPreferences keys (openrouter.ai provider-routing docs, read 2026-10-10); the provider mapping of a classifier profile may carry only these (PF-08).
 * A MAINTAINED CONTRACT, deliberately closed: plan section 8 says "provider (strict OpenRouter ProviderPreferences keys) ... Unknown keys fail" and PF-08 "strict provider keys". A key OpenRouter adds later is refused until it is added here; that is the owner's ruling, because OpenRouter ignores a misspelt routing key silently. Update this list when the docs change.
 */
const OPENROUTER_PROVIDER_KEYS: readonly string[] = [
  "order", "only", "ignore", "allow_fallbacks", "require_parameters", "data_collection", "zdr", "enforce_distillable_text",
  "quantizations", "sort", "max_price", "preferred_min_throughput", "preferred_max_latency",
];
/** Trace keys OpenRouter defines; any other key is allowed and passed through (PF-08). */
const OPENROUTER_TRACE_KEYS: readonly string[] = ["trace_id", "trace_name", "span_name", "generation_name", "parent_span_id"];

/** Plan section 8 classifier defaults; the single source for loaders and `settings new` (PF-04). */
export const CLASSIFIER_DEFAULTS = {
  endpoint: "decisions",
  max_requests_per_call: 8,
  concurrency: 8,
  timeout_ms: 60000,
  max_attempts: 3,
} as const;

/**
 * PF-01 (E84): offline schema check of a `profile-type: classifier` profile.
 * WHY it replaces validateProfile's chat checks: a classifier has no `mode`, and
 * `mode` is not in its field row, so a chat profile merely relabelled `classifier`
 * (it still carries `mode`) fails here as an unknown key; that is what lets the
 * spend gate treat a profile that loads as a classifier as truly a classifier (D2).
 * Catalog-dependent checks (model, endpoint support, context_tokens) are PF-02;
 * provider/trace content is PF-08; key resolution is PF-11. Never touches the network.
 */
export function validateClassifierProfile(name: string, profile: Profile): string[] {
  const errors = [...profileTypeErrors(name, profile)];
  errors.push(...profileTypeFieldIssues(name, profile, "classifier").map((i) => `Profile '${name}': ${i}`));
  const p = profile as unknown as Record<string, unknown>;
  const where = `Profile '${name}'`;
  if (p.api !== "openrouter-remote") errors.push(`${where}: a classifier profile requires api: openrouter-remote, got '${String(p.api)}'`);
  if (typeof p.model !== "string" || p.model.length === 0) errors.push(`${where}: missing required field: model`);
  // WHY only a `$NAME` reference, and the value never in the message: plan section 8 gives the classifier `api_key` as `$VAR` and PF-11 says the key is never written; a literal key in settings.yaml would travel through every resolved profile, log and report.
  if (p.api_key !== undefined && (typeof p.api_key !== "string" || !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(p.api_key))) errors.push(`${where}: api_key must be a reference to an environment variable such as $OPENROUTER_API_KEY; the key itself is never stored in settings.yaml`);
  if (p.endpoint !== undefined && p.endpoint !== "decisions" && p.endpoint !== "systemone") errors.push(`${where}: endpoint must be 'decisions' or 'systemone', got '${String(p.endpoint)}'`);
  for (const key of ["max_requests_per_call", "concurrency", "timeout_ms", "max_attempts", "context_tokens"]) {
    const v = p[key];
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v > 0)) errors.push(`${where}: ${key} must be a positive integer, got '${String(v)}'`);
  }
  for (const key of ["session_id", "user"]) {
    const v = p[key];
    if (v !== undefined && (typeof v !== "string" || v.length === 0 || v.length > 256)) errors.push(`${where}: ${key} must be a string of 1 to 256 characters`);
  }
  for (const key of ["provider", "trace"]) {
    const v = p[key];
    if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) errors.push(`${where}: ${key} must be a mapping`);
  }
  // PF-08. WHY strict provider keys: the mapping is forwarded to OpenRouter as-is, and an unknown key (a typo of `allow_fallbacks`) is silently ignored there, so routing would differ from what the user wrote. WHY trace keys are only type-checked: OpenRouter documents five known keys and allows custom ones.
  const provider = p.provider;
  if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
    for (const key of Object.keys(provider)) {
      if (!OPENROUTER_PROVIDER_KEYS.includes(key)) errors.push(`${where}: provider.${key} is not an OpenRouter provider preference. Allowed keys: ${OPENROUTER_PROVIDER_KEYS.join(", ")}`);
    }
  }
  const trace = p.trace;
  if (trace !== null && typeof trace === "object" && !Array.isArray(trace)) {
    for (const key of OPENROUTER_TRACE_KEYS) {
      const v = (trace as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== "string") errors.push(`${where}: trace.${key} must be a string`);
    }
  }
  return errors;
}

/**
 * Settings-level profile-type errors for EVERY profile (a typo in a profile
 * that is not selected must still fail the load): E81g when `profileTypesMigrated`
 * is set, plus E81d/E113 for every profile except `skip`, which validateProfile
 * already reports (the effective profile).
 * WHY `profileTypesMigrated` and not "always": until PT-02 has written the
 * field into existing files every profile lacks it, and failing them all would
 * brick every install; PT-02 sets the flag from its migration record.
 */
export function profileTypesSettingsErrors(settings: Settings, skip?: string): string[] {
  const errors: string[] = [];
  for (const [name, profile] of Object.entries(settings.profiles)) {
    if (profile === null || typeof profile !== "object") continue;
    if (profile["profile-type"] === undefined) {
      if (settings.profileTypesMigrated === true) {
        errors.push(`Profile '${name}' has no profile-type. Add the line 'profile-type: <type>' to it by hand (one of ${PROFILE_TYPES.join(", ")}).`);
      }
    } else if (name !== skip) {
      const typeErrors = profileTypeErrors(name, profile);
      errors.push(...typeErrors);
      // PT-06 (D33): same strict field check validateProfile applies to the effective profile; a typo in an unselected profile must fail the load too.
      if (typeErrors.length === 0) errors.push(...profileTypeFieldIssues(name, profile, profile["profile-type"] as ProfileType).map((i) => `Profile '${name}': ${i}`));
    }
  }
  return errors;
}

/**
 * E82 (PF-03): `active_classifier` must name a profile the file defines. WHY at
 * load and not at `classify` time: unlike a dangling `active:` (which the CLI
 * selection step reports), nothing else would ever notice the typo until the
 * first classifier run, and `settings validate` must show it.
 */
export function activeClassifierErrors(settings: Settings): string[] {
  const name = settings.active_classifier;
  if (name === undefined || name in settings.profiles) return [];
  // WHY the fix in the message: the usual cause is a deleted `or-jev` (PF-04 never brings it back once recorded), and the user has no command that edits this key.
  return [`active_classifier names profile '${name}', which settings.yaml does not define. Available: ${Object.keys(settings.profiles).join(", ") || "(none)"}. Fix: delete the 'active_classifier:' line, or set it to the name of another classifier profile.`];
}

/**
 * The comment stamped before a `profiles.free` / `profiles.paid` KEY to mark
 * the section as llm-ext-generated. Its presence is what tells the migration
 * (and writeDynamicProfileSection's backup guard) "we wrote this, overwriting
 * it destroys nothing the user typed".
 *
 * Owned HERE, not in benchmark/pick.ts where it used to live, because
 * renderDefaultSettingsYaml() below must stamp it on a FRESH install and
 * config.ts cannot import benchmark/pick.ts (pick.ts imports config.ts).
 * pick.ts re-exports it, so every existing importer is unchanged.
 */
export const GENERATED_MARKER = "<-- do not touch, generated by llm-ext -->";

/**
 * validateSettings' refusal for a hand-authored section under a RESERVED
 * dynamic name, exported so the message has one spelling (docs and the test
 * both quote it rather than retyping it).
 *
 * WHY a refusal and not another backup-and-regenerate: the first migration run
 * already did that once (addendum K). Doing it again on every dispatch would
 * mean llm-ext silently discarding the user's edit each time they made it,
 * with a backup file per attempt — a loop the user cannot win. Refusing names
 * the collision and hands them the fix.
 *
 * D0 (TRDD-AL8GIZYA, design section 3.2 rule 5): the wording now names the
 * option that did not exist before the ownership boundary — keep the
 * section and add the user-owned subsections inside it, instead of renaming.
 */
export function reservedDynamicProfileNameError(names: readonly string[]): string {
  // D0 fix-up 2 (TRDD-AL8GIZYA): the old wording hardcoded
  // 'providers'/'ensemble'/'selection'/'high_quality_model' for every
  // profile, which is false in D0 -- 'ensemble' is refused everywhere
  // until a later slice, and 'providers' is user-owned only on 'paid'
  // (DYNAMIC_USER_OWNED_KEYS.free/.local carry no 'providers'). Deriving
  // the per-name key list from the same table validateProfile enforces
  // means this text can never drift from the actual check again.
  const perProfile = names
    .map((n) => {
      const keys = DYNAMIC_USER_OWNED_KEYS[n as MarkedProfileName] ?? [];
      return `'${n}' (${keys.map((k) => `'${k}'`).join("/")})`;
    })
    .join(", ");
  return (
    `settings.yaml defines '${names.join("', '")}' by hand, but '${MARKED_PROFILE_NAMES.join("' and '")}' are ` +
    `RESERVED: llm-ext generates and rewrites those sections itself, so anything you write there is lost. ` +
    `Keep the marker line and add the keys it owns inside the generated section -- ${perProfile}; ` +
    `to hand-pick every model, use a profile with another name.`
  );
}


/** The profile NAME a `Settings` object currently designates. Precedence
 *  (TRDD-G6XT3AY9): the in-memory `active` field when set -- either the raw
 *  settings.yaml `active:` key as loadSettings() parsed it, or whatever
 *  overrideActiveProfile()/the reload path overwrote it with once a `--profile`
 *  flag or a live reload picked a different one -- else the built-in
 *  DEFAULT_PROFILE_NAME. One function so every reader (the CLI selection
 *  path, validateSettings, boot, the reload path, settings show/status)
 *  agrees on what "no profile designated" resolves to, instead of
 *  re-deriving "omitted -> free" locally at each site. */
export function effectiveProfileName(settings: Settings): string {
  return settings.active ?? DEFAULT_PROFILE_NAME;
}

/**
 * CLI commands that must keep running when the SELECTION at cli/main.ts's
 * call site fails to resolve `active:` to an existing profile and no
 * `--profile` flag was given (TRDD-G6XT3AY9 amendment). Each of these reads
 * `activeSettings.profiles` / `effectiveProfileName(activeSettings)` /
 * `formatActiveProfileSummary` directly (see index.ts's `discover` /
 * `get_settings` / `list_profiles` / `profile` cases) and already tolerates
 * an unresolved active profile -- a dangling `active:` must not brick the
 * commands that let the user SEE and fix the broken key. `settings status`
 * maps to `discover` (launcher.ts's GROUPS table), which is why `discover`
 * covers it too.
 *
 * ponytail: this is a hand-maintained allow-list, checked at SELECTION time
 * for every tool whether or not it ever calls a completion. TRDD-OE27RD7I
 * 14.1-C2 §3b's cleaner shape -- resolve the profile LAZILY, at the first
 * real need (chatCompletionWithProfileFallback / the maintainer gate), and
 * delete this set entirely, since a tool that never asks for a resolved
 * profile then trivially never fails on a missing one -- was not taken here
 * because cli/active-precedence.test.ts drives `shouldFailProfileSelection`
 * directly as a unit under test; deleting it would require rewriting that
 * file too, outside this phase's file set. Upgrade path: once that test file
 * is folded into the lazy design (or replaced), delete this set and the
 * gate in cli/main.ts together.
 */
export const CLI_TOOLS_WITHOUT_RESOLVED_PROFILE: ReadonlySet<string> = new Set([
  "discover",
  "get_settings",
  "list_profiles",
  "profile",
]);

/**
 * Whether cli/main.ts should fail the whole invocation (`die()`) after
 * `overrideActiveProfile()` could not resolve the effective profile.
 * `selectionOk` is that call's `result.ok`; `hadProfileFlag` is whether the
 * user passed `--profile` explicitly. Pure so the gate is unit-testable
 * without spawning the compiled CLI (main.ts runs `main().catch()` at
 * import, so it can never be imported directly in a test).
 *
 * An explicit `--profile <typo>` always fails here (the user just typed it,
 * so silently ignoring it would run the wrong profile); a dangling
 * `active:` with no flag fails ONLY for a tool that actually needs a
 * resolved profile to dispatch -- see CLI_TOOLS_WITHOUT_RESOLVED_PROFILE.
 */
export function shouldFailProfileSelection(
  selectionOk: boolean,
  toolName: string,
  hadProfileFlag: boolean,
): boolean {
  return !selectionOk && (hadProfileFlag || !CLI_TOOLS_WITHOUT_RESOLVED_PROFILE.has(toolName));
}

/** Ensemble profile price ceiling (USD / million tokens, input AND output),
 *  overridable via `profiles.paid.selection.price_ceiling_usd_per_million`
 *  (D0, TRDD-AL8GIZYA). Single source of truth — never hardcode 1.3
 *  elsewhere. Signature UNCHANGED by D0 (design section 1.3): only the body
 *  moved to the new position, so D3a's predicate and all three callers stay
 *  untouched. */
export const DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M = 1.3;

/** Resolve the effective ensemble price ceiling: the `paid` profile's
 *  `selection.price_ceiling_usd_per_million` override when present and valid
 *  (a bad value falls back rather than erroring here — validateProfile's
 *  E-L1 is what refuses it), else the built-in default. */
export function getEnsemblePriceCeiling(settings: Settings | null | undefined): number {
  const raw = settings?.profiles?.paid?.selection?.price_ceiling_usd_per_million;
  return typeof raw === "number" && isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M;
}

/** The one price gate every ensemble comparison site uses: admits a model
 *  when BOTH its input AND output price are AT OR UNDER the ceiling. USER
 *  2026-09-18: "each price must be under $1.3" resolved to <= ("One ceiling,
 *  <=" — the exact-at-ceiling case is accepted, not rejected). Single source
 *  of truth so the SUM-based gates (default-profiles.ts) and the
 *  strict-`<`-EACH gate (benchmark/pick.ts) cannot independently drift from
 *  the user's rule again — every comparison site in the codebase must call
 *  this, never re-derive the inequality itself. */
export function withinPriceCeiling(
  m: { inputDollarsPerMillion: number; outputDollarsPerMillion: number },
  ceiling: number,
): boolean {
  return m.inputDollarsPerMillion <= ceiling && m.outputDollarsPerMillion <= ceiling;
}

/** Default daily spend cap for PAID benchmark runs (USD), when
 *  `paid_benchmark_daily_cap_usd` is absent/invalid. Single source of truth —
 *  never hardcode 0.5 elsewhere. */
export const DEFAULT_PAID_DAILY_CAP_USD = 0.5;

/** Resolve the effective paid-benchmark daily spend cap: the settings override
 *  when present and valid (>= 0 — 0 legitimately means "no paid benchmarking
 *  today"), else the built-in default. Mirrors getEnsemblePriceCeiling's shape. */
export function paidDailyCapUsd(settings: Settings | null | undefined): number {
  const raw = settings?.paid_benchmark_daily_cap_usd;
  return typeof raw === "number" && isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_PAID_DAILY_CAP_USD;
}

/**
 * Default scouting price ceiling (USD / million tokens, input AND output) for
 * the scout-accuracy candidate pool. Single source of truth - never hardcode
 * this elsewhere.
 */
export const DEFAULT_SCOUT_PRICE_CEILING_USD_PER_M = 0.05;

/** Resolve the effective scouting price ceiling: the top-level
 *  scout_price_ceiling_usd_per_million override when present and valid (> 0),
 *  else the built-in default. Mirrors getEnsemblePriceCeiling's shape. */
export function scoutPriceCeilingUsdPerM(settings: Settings | null | undefined): number {
  const raw = settings?.scout_price_ceiling_usd_per_million;
  return typeof raw === "number" && isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_SCOUT_PRICE_CEILING_USD_PER_M;
}

/**
 * Default scout-accuracy target fixture size (bytes) - the calibration test's
 * largest tested size (250KB). Per-candidate effective size is CLAMPED to 50%
 * of the model context window (TRDD-FKAR9VPK A1).
 */
export const DEFAULT_SCOUT_ACCURACY_TARGET_BYTES = 250_000;

/** Resolve the effective scout-accuracy target size: the top-level
 *  scout_accuracy_target_bytes override when present and valid (> 0), else the
 *  built-in default. */
export function scoutAccuracyTargetBytes(settings: Settings | null | undefined): number {
  const raw = settings?.scout_accuracy_target_bytes;
  return typeof raw === "number" && isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_SCOUT_ACCURACY_TARGET_BYTES;
}

/**
 * Default minimum positional accuracy a scout-accuracy candidate must score
 * to PASS. 0.95 - the floor the calibration report reads as good.
 */
export const DEFAULT_SCOUT_ACCURACY_THRESHOLD = 0.95;

/** Resolve the effective scout-accuracy pass threshold: the top-level
 *  scout_accuracy_threshold override when present and valid (0 < t <= 1), else
 *  the built-in default. */
export function scoutAccuracyThreshold(settings: Settings | null | undefined): number {
  const raw = settings?.scout_accuracy_threshold;
  return typeof raw === "number" && isFinite(raw) && raw > 0 && raw <= 1
    ? raw
    : DEFAULT_SCOUT_ACCURACY_THRESHOLD;
}

/**
 * Sentinel model id marking an unpopulated default-profile PLACEHOLDER. Never
 * a real OpenRouter model id (deliberately unroutable), so a placeholder that
 * somehow reached the wire would 404 rather than silently bill or mis-route.
 */
export const PLACEHOLDER_MODEL_ID = "placeholder/unpopulated-default-profile";

/**
 * True iff `profile` is a not-yet-populated default-profile placeholder.
 *
 * The signal differs by profile SHAPE, and that is load-bearing:
 *  - free_only  → an EMPTY free_models pool. Its models live in the pool, and
 *    applyFreePoolToSettings (the writer that populates it) never touches
 *    `model`. Keying on the sentinel id here would leave `free` looking
 *    unpopulated forever and re-run its benchmark on every single command.
 *  - everything else → `model` is the unroutable sentinel, which the slot
 *    writers (applyPicksToSettings / applyEnsembleSlotToSettings) DO overwrite.
 */
export function isPlaceholderProfile(profile: Profile): boolean {
  if (profile.free_only === true) {
    // A MALFORMED free_models (a YAML scalar where a list belongs) is a broken
    // profile, not an empty one — coerceFreeModels flattens it to [], so
    // treating "coerces to empty" as "placeholder" would silently reclassify a
    // user's typo as "not benchmarked yet", swallow the "must be a YAML list"
    // error, and quietly overwrite their line with benchmark output.
    if (profile.free_models !== undefined && !Array.isArray(profile.free_models)) {
      return false;
    }
    return coerceFreeModels(profile.free_models).length === 0;
  }
  return profile.model === PLACEHOLDER_MODEL_ID;
}

/**
 * True iff this is a MACHINE-OWNED default profile that simply has not been
 * benchmarked yet — the one case where an "invalid" profile is expected and
 * self-healing rather than a user error.
 *
 * The name check is load-bearing: an arbitrary user profile with an empty
 * free_models list is a genuine misconfiguration and must keep failing
 * validation. Only the three DYNAMIC_PROFILE_NAMES populate themselves (the
 * other two built-ins, scouting and or-jev, are filled by their own commands).
 */
export function isUnpopulatedDefaultProfile(name: string, profile: Profile): boolean {
  return isDynamicProfileName(name) && isPlaceholderProfile(profile);
}

/**
 * True iff this profile is invalid ONLY because it has not been populated yet —
 * and for no other reason.
 *
 * The boot exemption used to key on the PROFILE (a default name in placeholder
 * state) and then discard the WHOLE error list. That is one condition
 * suppressing every unrelated rule: a YAML typo in `providers:` on `free` — or
 * on `paid`, where the population state produces no error of its own — booted
 * silently, the binding was dropped, and its models fell through to the primary
 * provider with the primary's key. The user saw "has not been benchmarked yet"
 * for a mistake that had nothing to do with benchmarking.
 *
 * So the question has to be about the ERRORS, not the profile. It is answered by
 * re-validating a POPULATED copy rather than by matching error strings: message
 * texts drift, semantics do not. Fill in the pool (or the model id); if the
 * profile is valid now, every complaint was about population. If anything else
 * still fails, it was a real misconfiguration hiding behind the exemption.
 *
 * WHAT "POPULATED" HAS TO COVER — measured, not guessed. The first version
 * substituted only the pool, and that BRICKED a first run: every default
 * profile carries `$OPENROUTER_API_KEY`, so on a machine where that env var is
 * not exported the Remote-auth rule SURVIVES the substitution, the helper says
 * false, and a fresh install boots to NOT CONFIGURED — precisely the outcome
 * the exemption exists to prevent. It passed locally only because this shell
 * exports the key; `env -u OPENROUTER_API_KEY` turned it red immediately.
 *
 * So a missing key is substituted too. That is not a hole: an unset env var is
 * the OTHER first-run condition (you have not pasted a key yet), it is
 * self-healing in exactly the same way, and this helper only ever runs for the
 * three machine-owned dynamic names. A `providers:` typo is still caught.
 *
 *  - free_only  → two ':free' ids clear both "non-empty" and remote-ensemble ">= 2".
 *  - otherwise  → a real-looking `model`. This one changes no verdict on its
 *    own (PLACEHOLDER_MODEL_ID is a non-empty string and the only rule is
 *    `!profile.model`), so it is written for symmetry, not because a rule keys
 *    on the sentinel.
 *  - unresolvable auth → a literal key, ONLY when it does not already resolve.
 */
export function isInvalidOnlyBecauseUnpopulated(
  name: string,
  profile: Profile,
): boolean {
  if (!isUnpopulatedDefaultProfile(name, profile)) return false;
  const preset = profile.api ? API_PRESETS[profile.api] : undefined;
  // Computed as "does it NEED substituting", not "does it resolve": an unknown
  // preset and a local one do not resolve auth either — the question simply
  // does not arise for them, and naming that `authResolves` invites someone to
  // "fix" a true value on a profile whose key plainly does not resolve.
  //
  // `!preset.isLocal` mirrors validateProfile's own Remote-auth guard. It is
  // sound while BOTH hold: (a) Remote-auth is that function's only auth rule
  // — verified by a full read, there is no `api_token` check — and (b) every
  // DYNAMIC_PROFILE_NAMES entry is remote. Break either and this becomes a silent
  // hole; note (b) is only covered accidentally, by the boot-lock test
  // iterating whatever profiles the generator happens to produce.
  const needsAuthKey =
    preset !== undefined &&
    !preset.isLocal &&
    resolveEnvValue(profile.api_key || preset.defaultAuthEnv) === "";
  const populated: Profile = {
    ...profile,
    ...(profile.free_only === true
      ? { free_models: ["placeholder/a:free", "placeholder/b:free"] }
      : { model: "placeholder/populated" }),
    ...(needsAuthKey ? { api_key: "placeholder-key" } : {}),
  };
  return validateProfile(name, populated).valid;
}

/** The UNPOPULATED `free` section. `mode: "remote"` — resolveProfile's
 *  free_only branch still exposes the FULL free_models pool as the rotation
 *  fallback chain; only `model` (the single best pick, freeModels[0]) is what
 *  a non-ensemble mode actually sends. See resolveProfile's free_only comment.
 *
 *  EXPORTED (P6c-a): index.ts's overrideActiveProfile used to carry a
 *  byte-identical private copy (`unpopulatedDynamicProfileStub`). Two copies
 *  of "what an unpopulated section looks like" is how the migration's
 *  shipped-shape table and the writer that produces the shape drift apart —
 *  and the migration ADOPTS a section by matching exactly this object. */
export function unpopulatedFreeProfile(): Profile {
  return {
    mode: "remote",
    api: "openrouter-remote",
    free_only: true,
    free_models: [],
    // Ignored at runtime — resolveProfile's free_only branch overrides `model`
    // from free_models[0]. Present because the field is required, and the
    // unroutable sentinel is the only honest value for an unpopulated slot.
    model: PLACEHOLDER_MODEL_ID,
    api_key: "$OPENROUTER_API_KEY",
  };
}

/** The UNPOPULATED `paid` section (see unpopulatedFreeProfile for why this is
 *  exported). `mode: "remote"`: the maintainer promotes it to
 *  `remote-ensemble` once the pool has enough members to fan out. */
export function unpopulatedPaidProfile(): Profile {
  return {
    mode: "remote",
    api: "openrouter-remote",
    model: PLACEHOLDER_MODEL_ID,
    api_key: "$OPENROUTER_API_KEY",
  };
}

/**
 * The UNPOPULATED `local` section (TRDD-C9SXX7HO). MUST stay byte-identical
 * to `buildLocalProfileSection([])` in local-profile.ts — pinned by a
 * round-trip test there — because the migration's shipped-shape table
 * (benchmark/pick.ts's SHIPPED_PLACEHOLDER_SHAPES) adopts a section by
 * matching this exact shape, same contract unpopulatedFreeProfile/
 * unpopulatedPaidProfile already have with the writer that produces them.
 *
 * Hand-written HERE rather than imported from local-profile.ts because that
 * module already imports `Profile`/`ProviderBinding`/`PLACEHOLDER_MODEL_ID`
 * FROM config.ts — importing it back would be a cycle. `api` names
 * PROBE_TARGETS[0]'s preset (`local_discovery/scan.ts`, "lmstudio-local")
 * only to satisfy validateProfile's mode<->preset check; it is never read
 * since there are no providers and nothing can serve.
 *
 * D0 fix-up (TRDD-AL8GIZYA): `providers: []` IS carried here. `local`'s
 * GENERATED set (DYNAMIC_GENERATED_KEYS.local) includes `providers` from D0
 * on — see that constant's docblock: `local-profile.ts`'s
 * `buildLocalProfileSection` already writes it TODAY, so refusing it here
 * would fail llm-ext's own unpopulated placeholder against its own
 * validateProfile call. D6a renames the key to `detected_providers`.
 */
export function unpopulatedLocalProfile(): Profile {
  return {
    mode: "local",
    api: "lmstudio-local",
    model: PLACEHOLDER_MODEL_ID,
    free_models: [],
    detected_providers: [],
  };
}

/**
 * The UNPOPULATED `scouting` section (PT-04, D19). Same shape as `paid`'s
 * placeholder: the sentinel model means "not benchmarked yet", and only
 * `llm-ext benchmark scout-accuracy` replaces it (mass scouting refuses until
 * then). Hand-written HERE like its siblings: config.ts cannot import
 * benchmark/scout-accuracy.ts (cycle), whose buildScoutingProfile writes the
 * populated shape with the same generated keys.
 */
export function unpopulatedScoutingProfile(): Profile {
  return {
    mode: "remote",
    api: "openrouter-remote",
    model: PLACEHOLDER_MODEL_ID,
    api_key: "$OPENROUTER_API_KEY",
  };
}

/**
 * The built-in `or-jev` classifier profile (PF-03, D19, D24), the template of the
 * classifier type. WHY the alias `~typesafe/jev-latest` and not a pinned build: the
 * owner's ruling (D24) keeps the alias; every result records the served build and
 * the drift watcher reports when the alias moves. Unlike its siblings it is not a
 * placeholder: it is complete and usable as written (only `OPENROUTER_API_KEY` is
 * needed). Hand-written here for the same reason as unpopulatedScoutingProfile
 * (config.ts cannot import the classifier layers).
 */
export function orJevProfile(): Profile {
  return {
    "profile-type": "classifier",
    api: "openrouter-remote",
    model: "~typesafe/jev-latest",
    api_key: "$OPENROUTER_API_KEY",
  } as unknown as Profile;
}

/**
 * Per-slot context (tokens) the local-model broker starts a managed server with
 * when the profile sets no context_window (calibration design review F11,
 * coordinator decision 4). Without it the server would load the model's whole
 * default context (262k for LFM3 and Qwen3.5), a KV cache of many GB. Order:
 * the profile's context_window, then (P6) the model's calibration record, then
 * this provisional value.
 */
export const PROVISIONAL_LOCAL_CTX = 8192;

/**
 * TRDD-1OOAH3LD / TRDD-ZGSGGHQG (P5): the two built-in local profiles the user
 * asked for, three models each, both served by the local-model broker
 * (`server: managed`). Added ONCE by the `local-profile-added:<name>` steps
 * of migrateSettingsTo141 (benchmark/pick.ts): only when no profile of that
 * name exists, never made active, never re-added after the user deletes it.
 *
 * Model ids (sources in reports/llama-cpp-profile, P5 report):
 * - GGUF: the files the six-model smoke loaded (reports/locals-mlx/20261028_200451+0100-six-model-smoke.md):
 *   AtomicChat LFM3 by its quant tag AD-Q6_K (file LFM3-1.7B-Uncensored-AD-Q6_K.gguf), the other two by
 *   repo/file.gguf as the user named them.
 * - MLX: the Hugging Face repo ids; the broker sends Locals the `-thinking`
 *   id it lists when a request asks for thinking (localsOutgoingModel).
 * No context_window (review of the calibration design, open point 1): a value llm-ext writes here is
 * indistinguishable from one the user wrote, and a user value wins over the calibration record for
 * ever. Until a model is calibrated (P6) the broker starts its server with PROVISIONAL_LOCAL_CTX per slot.
 * The url binds nothing under the broker (it is the key the fallback walker marks dead): the ports the user named.
 */
export interface BuiltinLocalProfile {
  name: string;
  /** Comment lines written above the profile key (without the leading "#"). */
  header: string[];
  profile: Profile;
  /** Whether this machine can run it. A profile that cannot run here is left out of the file (it would load, unselected: only the selected profile gets the full check). */
  supported: (platform?: string, arch?: string) => boolean;
}
export function builtinLocalProfiles(): BuiltinLocalProfile[] {
  return [
    {
      name: "local_llama",
      // The user's comment header, word for word (TRDD-1OOAH3LD user directive); its command line is commented out, as YAML requires.
      header: [
        " The local_llama profile will run llama.cpp locally as inference engine, with any llama.cpp compatible model.",
        " WARNING: You need a llama.cpp build with LFM3 support (merged in llama.cpp #31252; produced at llama.cpp 19cce69).",
        " The first model added to the profile is `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K`.",
        " The profile must automatically download it from huggingface or using the llama-cli command to download it,",
        " cache it automatically, and run it, like this:",
        ' llama-cli -hf AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6 -p "The prompt content goes here."',
      ],
      profile: {
        "profile-type": "local",
        mode: "local",
        api: "llamacpp-local",
        url: "http://127.0.0.1:8181",
        server: "managed",
        model: "AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K",
        second_model: "bartowski/Nanbeige_Nanbeige4.2-3B-GGUF/Nanbeige_Nanbeige4.2-3B-Q6_K.gguf",
        third_model: "insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF-Q8_0.gguf",
      } as unknown as Profile,
      supported: () => true,
    },
    {
      name: "locals-mlx",
      header: [
        " The locals-mlx profile runs MLX models locally through the Locals server (https://github.com/Generated-Computers/Locals), macOS on Apple silicon only.",
        " llm-ext starts and stops the Locals server itself (server: managed), one model at a time.",
      ],
      profile: {
        "profile-type": "local",
        mode: "local",
        api: "locals-local",
        url: "http://127.0.0.1:9090",
        server: "managed",
        model: "LiquidAI/LFM3-1.7B-MLX-4bit",
        second_model: "mlx-community/Nanbeige4.2-3B-OptiQ-4bit",
        third_model: "mlx-community/Qwen3.5-4B-MLX-4bit",
      } as unknown as Profile,
      supported: (platform, arch) => localsPlatformSupported(platform, arch),
    },
  ];
}

/**
 * ONE per-profile table for "what does an unpopulated section of NAME look
 * like" — replaces every `name === "free" ? unpopulatedFreeProfile() :
 * unpopulatedPaidProfile()` binary ternary (index.ts's dynamic-profile stub,
 * benchmark/pick.ts's migration regeneration) with a call that already knows
 * about `local`, so a future fourth dynamic profile is one more `case`, never
 * a search-and-fix across every call site.
 */
export function unpopulatedDefaultProfile(name: MarkedProfileName): Profile {
  // PT-02: the section carries its fixed type, so a file llm-ext writes from it is never rejected by E81g, and the in-memory section equals what the writer puts on disk (the maintainer compares the two to detect a concurrent write).
  const type = builtinProfileType(name);
  switch (name) {
    case "free":
      return { ...unpopulatedFreeProfile(), "profile-type": type };
    case "paid":
      return { ...unpopulatedPaidProfile(), "profile-type": type };
    case "local":
      return { ...unpopulatedLocalProfile(), "profile-type": type };
    case "scouting":
      return { ...unpopulatedScoutingProfile(), "profile-type": type };
    case "or-jev":
      return orJevProfile();
  }
}

/** Default settings: `active: free` (the default-profile pointer, live again
 *  per TRDD-G6XT3AY9) plus the three dynamic, machine-owned profiles, each an
 *  unpopulated PLACEHOLDER (see isPlaceholderProfile). The maintainer
 *  (dynamic-maintainer.ts) populates them; nothing here hardcodes a model id.
 *  These placeholders do NOT pass validateProfile — an empty pool genuinely
 *  cannot serve a request — so the boot path must recognise them via
 *  isUnpopulatedDefaultProfile() and route them to population rather than to a
 *  misconfiguration error.
 *
 *  `active` is `DEFAULT_PROFILE_NAME` ("free"), matching what a fresh install
 *  already selects with no flags -- a visible, editable pointer instead of a
 *  fact the user could only learn from --help. */
export function generateDefaultSettings(): Settings {
  return {
    // WHY: first top-level key, so a fresh settings.yaml shows the selector
    // before anything else -- renderDefaultSettingsYaml comments it in place.
    active: DEFAULT_PROFILE_NAME,
    // PF-03 (D19): the classifier counterpart of `active`, pointing at the built-in `or-jev`.
    active_classifier: "or-jev",
    // Explicit free-safe default (USER: free-by-default).
    allow_paid_models: false,
    profiles: {
      free: unpopulatedDefaultProfile("free"),
      paid: unpopulatedDefaultProfile("paid"),
      // TRDD-C9SXX7HO (D2): a fresh install ships all three machine-owned
      // sections, `local` included — the card's own acceptance line ("a
      // fresh install writes all three").
      local: unpopulatedDefaultProfile("local"),
      // PT-04 (D19): the fifth built-in template, a marked placeholder until `benchmark scout-accuracy` fills it.
      scouting: unpopulatedDefaultProfile("scouting"),
      // PF-03 (D19): the classifier template, marked like the others.
      "or-jev": unpopulatedDefaultProfile("or-jev"),
    },
  };
}

/**
 * PT-07: the example of a profile type shown in the trailing comment of a fresh settings.yaml, under the name `my-<type>`.
 * WHY generated from the type's template (the built-in profile of that type) and never typed by hand: a hand-typed example drifts the moment the template changes (the drift that retired SETTINGS_TEMPLATE); a copy of the template is valid by construction.
 * The first line is a caption, the rest is the template's YAML; a placeholder `model` must be replaced by hand.
 */
export function profileExample(type: ProfileType): Profile {
  const template = PROFILE_TYPE_FIELDS[type].template;
  // WHY a check and not a cast: a new profile type whose template is not a marked built-in would otherwise ship without an example (or crash far from here); it must fail the first render.
  if (!isMarkedProfileName(template)) throw new Error(`profile type '${type}' has template '${template}', which is not a marked built-in profile; add it to MARKED_PROFILE_NAMES`);
  return unpopulatedDefaultProfile(template);
}

/** PT-07: the ensemble is a MODE of a paid profile, not a type, so it has no template of its own; it is the paid template plus the two extra model keys (what the retired hand-written `my-ensemble` showed). */
export function ensembleExample(): Profile {
  return { ...profileExample("paid"), mode: "remote-ensemble", second_model: PLACEHOLDER_MODEL_ID, third_model: PLACEHOLDER_MODEL_ID };
}

function exampleLines(name: string, caption: string, profile: Profile): string[] {
  return [caption, ...new YamlDocument({ [name]: profile }).toString({ indent: 2 }).trimEnd().split("\n")];
}

export function profileExampleLines(type: ProfileType): string[] {
  const profile = profileExample(type);
  // WHY derived from the profile and not from the type name: validateProfile refuses an EMPTY free_models only under free_only ("free_only requires a non-empty 'free_models' list"), so only such an example needs the note. `local` also ships `free_models: []`, but there it is a legal fallback chain (a field of the local type, PROFILE_TYPE_FIELDS.local.shared) that detection fills, and a caption demanding a model would be wrong.
  const pool = profile.free_only === true && Array.isArray(profile.free_models) && profile.free_models.length === 0 ? " and list at least one model under free_models" : "";
  return exampleLines(`my-${type}`, `${type} profile (copy of the built-in '${PROFILE_TYPE_FIELDS[type].template}' template; replace the placeholder model (if any)${pool}):`, profile);
}

export function ensembleExampleLines(): string[] {
  return exampleLines("my-ensemble", "paid ensemble (the paid template with mode remote-ensemble and two more models; replace every placeholder model):", ensembleExample());
}

/**
 * Render the on-disk default settings.yaml — a commented file GENERATED from
 * generateDefaultSettings(), so the shipped defaults have exactly ONE source.
 *
 * This used to be a hand-maintained SETTINGS_TEMPLATE string literal sitting
 * beside generateDefaultSettings(), and the two drifted the moment the default
 * profiles changed: the template still declared the five old hand-written
 * profiles while the code claimed to write three machine-managed ones, and the
 * template was the copy that actually reached disk. A generated file cannot
 * drift from the object it is generated from — the test asserts a round-trip.
 */
export function renderDefaultSettingsYaml(): string {
  const doc = new YamlDocument(generateDefaultSettings());

  doc.commentBefore = [
    " ──────────────────────────────────────────────────────────────────────",
    " LLM Externalizer — Settings",
    " ──────────────────────────────────────────────────────────────────────",
    " Profile-based configuration. Each profile defines a complete LLM backend",
    " setup. Edit this file by hand, then run `llm-ext settings reset` to reload.",
    "",
    " Location: ~/.llm-externalizer/settings.yaml",
    "",
    " The profiles below (free, paid, local, scouting, or-jev) are GENERATED and RESERVED:",
    " llm-ext chooses their model ids, re-checks them on every run, and",
    " rewrites the sections itself — do not hand-edit them, and do not name a",
    " profile of your own 'free', 'paid', 'local', 'scouting' or 'or-jev'. 'free', 'paid', 'local' and 'scouting' start EMPTY; a",
    " placeholder model id means 'not benchmarked yet', not 'broken'. The",
    " 'selection'/'high_quality_model' keys inside each (and 'providers' inside",
    " 'paid' only) ARE yours to hand-edit — llm-ext preserves them across",
    " every rewrite. 'scouting' is filled by `llm-ext benchmark scout-accuracy`.",
    " 'or-jev' is complete as written and llm-ext never rewrites it; its classifier",
    " fields (concurrency, timeout_ms, ...) are yours to tune.",
    "",
    " Any profile you add yourself is left alone, forever: nothing here rewrites",
    " a profile it does not own. Select one with `--profile <name>` on any",
    " command; with no flag, the `active:` key below decides, and '" +
      DEFAULT_PROFILE_NAME +
      "' is used when that is absent too.",
    " ──────────────────────────────────────────────────────────────────────",
  ].join("\n");

  // WHY (TRDD-G6XT3AY9): NO commentBefore/comment on the `active` scalar
  // itself -- either one forces this yaml library to break the value onto
  // its own line (see `allow_paid_models:` below, which does exactly that),
  // and the spec requires `active: free` stay the single top-level line
  // config-default-settings.test.ts asserts. The explanation lives in the
  // document banner above instead ("with no flag, the `active:` key below
  // decides").

  const paidNode = doc.get("allow_paid_models", true);
  if (isScalar(paidNode)) {
    paidNode.commentBefore = [
      " ── Master paid-spend switch ─────────────────────────────────────────",
      " DEFAULT false — only FREE models are used, everywhere, by default. While",
      " this is false (or absent), every remote profile is forced to its free pool",
      " no matter which 'model' it configures, and the generated `paid` profile",
      " refuses to auto-benchmark itself, because benchmarking a paid model sends",
      " billable requests. Set it to true to allow paid models — then `paid`",
      " populates on first use, bounded by `paid_benchmark_daily_cap_usd`.",
    ].join("\n");
  }

  // Stamp the generated marker on both keys. A fresh install's sections MUST
  // carry it: the migration (P6c-a item 3) reads exactly this comment to tell
  // "llm-ext wrote this" from "the user wrote this", and an unmarked `free:`
  // would be backed up and regenerated on the very next run — of a file
  // llm-ext had just generated itself.
  const profilesMap = doc.get("profiles", true) as {
    items?: Array<{ key: Scalar | string }>;
  };
  for (const name of MARKED_PROFILE_NAMES) {
    const item = profilesMap?.items?.find(
      (it) => (it.key instanceof Scalar ? it.key.value : it.key) === name,
    );
    if (!item) continue;
    // A raw-string key carries no comment at all, so promote it first (the
    // same shape bug P6b item 0 fixed in writeDynamicProfileSection).
    if (!(item.key instanceof Scalar)) item.key = new Scalar(item.key);
    item.key.commentBefore = ` ${GENERATED_MARKER}`;
  }

  // The commented template for the user's OWN (static) profiles. A trailing
  // document comment rather than a disabled `profiles:` entry: anything inside
  // `profiles:` would have to be valid YAML the loader then validates, and a
  // half-filled example profile fails validateProfile on every command.
  doc.comment = [
    " ──────────────────────────────────────────────────────────────────────",
    " YOUR OWN PROFILES — copy one of these under `profiles:` and edit it.",
    " A profile you add is STATIC: used exactly as written, never modified.",
    " Pick it with `--profile <name>`. One example per profile type (local, free,",
    " paid, scouting, classifier), then the paid ensemble.",
    ...[...PROFILE_TYPES.map(profileExampleLines), ensembleExampleLines()].flatMap((lines) => ["", ...lines.map((l) => `   ${l}`)]),
    " ──────────────────────────────────────────────────────────────────────",
  ].join("\n");

  return doc.toString({ indent: 2 });
}

/** Local-time timestamp `YYYYMMDD_HHMMSS±HHMM` for a corrupt-settings backup
 *  filename (never UTC — ties the backup to the user's own wall clock). */
function formatLocalTimestamp(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offMin = -d.getTimezoneOffset(); // minutes EAST of UTC
  const sign = offMin >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offMin) / 60));
  const offM = pad(Math.abs(offMin) % 60);
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${sign}${offH}${offM}`
  );
}

/**
 * Ensure settings.yaml exists AND parses. Regenerates the two dynamic
 * profiles (free/paid, as unpopulated placeholders) when the file is MISSING
 * or CORRUPT/UNPARSEABLE.
 *
 * CRITICAL data-safety invariant: a corrupt file is NEVER silently overwritten.
 * It is first copied verbatim to a timestamped `settings.yaml.corrupt-<ts>`
 * backup (local-time±offset, so a user can find "the file from this afternoon")
 * — only then does a fresh default template get written. The user's own
 * profiles inside a corrupt file cannot be recovered automatically (the parser
 * couldn't read them either), so this says so plainly instead of pretending.
 * Also warns if old settings.yml exists (migration hint).
 */
export function ensureSettingsExist(): Settings {
  const settingsPath = getSettingsPath();
  const configDir = getConfigDir();

  // Warn about old settings.yml if it exists alongside new path
  const oldSettingsPath = join(configDir, "settings.yml");
  if (existsSync(oldSettingsPath) && !existsSync(settingsPath)) {
    process.stderr.write(
      `[llm-externalizer] Found old settings.yml — the new format is settings.yaml with profiles.\n` +
        `[llm-externalizer] Generating new settings.yaml. Your old settings.yml is preserved but no longer read.\n`,
    );
  }

  if (!existsSync(settingsPath)) {
    mkdirSync(configDir, { recursive: true });
    // First run: write the commented defaults, GENERATED from
    // generateDefaultSettings() so the on-disk file can never disagree with the
    // in-memory fallback (they were two hand-maintained copies, and drifted).
    writeFileSync(settingsPath, renderDefaultSettingsYaml(), "utf-8");
    // Restrict permissions immediately — users may add API keys to the template,
    // so default umask (0644) is not safe.
    try { chmodSync(settingsPath, 0o600); } catch { /* Windows may not support chmod */ }
    process.stderr.write(
      `[llm-externalizer] Generated default settings at ${settingsPath}\n`,
    );
  } else if (!loadSettings()) {
    // File exists but is corrupt/unparseable. Back it up BEFORE writing a
    // fresh one — never destroy data we could not read; the user's hand-
    // written profiles may still be recoverable by hand from the backup.
    const backupPath = `${settingsPath}.corrupt-${formatLocalTimestamp()}`;
    const raw = readFileSync(settingsPath, "utf-8");
    writeFileSync(backupPath, raw, "utf-8");
    try { chmodSync(backupPath, 0o600); } catch { /* Windows may not support chmod */ }
    process.stderr.write(
      `[llm-externalizer] WARNING: ${settingsPath} could not be parsed as YAML. ` +
        `Your original file has been preserved at ${backupPath} — inspect it by ` +
        `hand to recover any custom profiles; they could NOT be recovered ` +
        `automatically. Regenerating ${settingsPath} with the generated ` +
        `profiles (${DYNAMIC_PROFILE_NAMES.join(", ")}).\n`,
    );
    writeFileSync(settingsPath, renderDefaultSettingsYaml(), "utf-8");
    try { chmodSync(settingsPath, 0o600); } catch { /* Windows may not support chmod */ }
  }

  const settings = loadSettings();
  if (!settings) {
    // Should be unreachable (we just wrote renderDefaultSettingsYaml(), which
    // is valid YAML by construction — a round-trip test proves it) — but never
    // silently proceed with a null settings object.
    throw new Error(`Failed to parse ${settingsPath}. Check YAML syntax.`);
  }

  return settings;
}

/**
 * P14.1 (row 79): the ONE place that decides whether a STATIC (non-dynamic
 * name) free_only profile has tool_models blanked/dead. Shared by
 * resolveProfile (`toolModels: ... ? {} : coerceToolModels(...)`) and
 * chainModelIds (below) so the gate and the validator can never disagree
 * about whether tool_models is actually dispatched — two copies of this one
 * condition is exactly how they drifted before (see chainModelIds JSDoc,
 * P6b-fix4 B1). A DYNAMIC free_only profile (e.g. "free") still serves
 * tool_models; only a STATIC one blanks it. Does NOT govern
 * high_quality_model — that field is dead under ANY free_only profile
 * (static or dynamic; see chainModelIds explicitHq), so it uses its own,
 * narrower predicate.
 */
function blanksToolModelsUnderFreeOnly(freeOnly: boolean, dynamic: boolean): boolean {
  return freeOnly && !dynamic;
}

// ── Profile validation ──────────────────────────────────────────────

/**
 * The model ids a profile would ACTUALLY send to, mirroring resolveProfile's
 * own chain semantics. Exactly what is checked, in both branches:
 *
 *  - `free_only` ⇒ the `free_models` pool ONLY (`model`/`second_model`/
 *    `third_model`/`paid_models` are inert under free_only — resolveProfile
 *    overwrites `model` from free_models[0]).
 *  - otherwise ⇒ `model`, `second_model`, `third_model`, `paid_models`, AND
 *    `free_models` — ALWAYS, unconditionally. A non-free_only profile is
 *    still served from its own `free_models` whenever the global forced-free
 *    switch (allow_paid_models:false, or auto-free) is on (index.ts
 *    activeFreePool -> approvedFreePoolFromSettings), and that switch is not
 *    visible to this per-profile function, so the chain fails closed by
 *    counting free_models unconditionally rather than trying to see the
 *    switch.
 *
 * In BOTH cases: every `tool_models` value — EXCEPT under a STATIC (non-dynamic
 * name) free_only profile, where resolveProfile blanks tool_models to `{}`
 * (`toolModels: freeOnly && !dynamic ? {} : coerceToolModels(...)`), so it is
 * genuinely dead there and must not be counted — and `high_quality_model.id`
 * ONLY when the profile sets it EXPLICITLY — never HIGH_QUALITY_MODEL_DEFAULTS
 * (the defaulted id is never actually configured by the user, and counting it
 * would force a route/credential requirement on every profile that never set
 * one, re-bricking the b.ai-only machine fix4 unbricked) — AND never under
 * ANY free_only profile, static or dynamic (highQualityScanRefusal refuses
 * high_quality_scan unconditionally there, unlike tool_models).
 *
 * P6b-fix4 B1: this lived as a private copy in dynamic-maintainer.ts (the §3.3
 * gate's `chainModelIds`). validateProfile's Remote-auth rule below now needs
 * the SAME list, and two copies of "what does this profile send" is exactly how
 * the gate and the validator would come to disagree about whether a profile can
 * serve — one refusing a profile the other just accepted. Owned here, next to
 * resolveProfile, which defines the semantics.
 *
 * Getting this wrong in either direction is a real bug, which is why it is not
 * a flat "read every model-ish field": treating a free_only profile's inert
 * `model` as part of the chain would refuse every healthy `free` profile (its
 * stub `model` is the placeholder forever), and ignoring `paid_models` would
 * let an unpopulated paid slot through.
 *
 * `name` is required (not optional) because the static/dynamic distinction
 * above needs it — every caller already has a profile name in scope
 * (validateProfile's own parameter, or the dynamic profile name inside
 * dynamicProfileGate, which only ever runs on a dynamic name already).
 */
export function chainModelIds(name: string, profile: Profile | undefined): string[] {
  if (!profile) return [];
  // Array.isArray, not `?? []` — a YAML scalar is neither null nor undefined,
  // so `??` does not fire and spreading it throws.
  const paid = Array.isArray(profile.paid_models) ? profile.paid_models : [];
  // fix-queue 52 (fix4-review S-A): free_models is now UNCONDITIONAL, not just
  // under free_only — under forced free (allow_paid_models:false, or auto-free)
  // a non-free_only profile is served from its own configured free_models too
  // (index.ts activeFreePool -> approvedFreePoolFromSettings), and that global
  // switch is not visible to this per-profile function, so including it always
  // is the only way to fail closed without threading a new parameter through
  // every caller. Likewise every tool_models value is a real send surface.
  const free = Array.isArray(profile.free_models) ? profile.free_models : [];
  const dynamic = isDynamicProfileName(name);
  // R-1: a DYNAMIC free_only profile must still count tool_models, because
  // resolveModelChain uses `toolModels[tool] || model` as the chain head, so
  // an uncovered head would be sent to the base api with no credential.
  const toolModelsBlanked = blanksToolModelsUnderFreeOnly(profile.free_only === true, dynamic);
  const toolModels = toolModelsBlanked ? [] : Object.values(coerceToolModels(profile.tool_models));
  // Row 79: explicit hq has its OWN predicate, narrower than tool_models' —
  // it is dead under ANY free_only profile, static or dynamic, because
  // highQualityScanRefusal refuses high_quality_scan unconditionally
  // whenever free_only is set (index.ts feeds it the RUNTIME free state,
  // which for a resolved profile is just its own free_only field — the
  // static/dynamic distinction that matters for tool_models does not apply
  // here). The defaulted id (HIGH_QUALITY_MODEL_DEFAULTS) is still never
  // counted — only an EXPLICITLY configured id is a real send surface.
  //
  // resolveProfile's freeOnly is `profile.free_only === true` for every mode
  // (mode only widens the free_models pool); hqBlanked reads that field
  // directly, never via blanksToolModelsUnderFreeOnly — that helper's
  // `!dynamic` term must not apply to hq (see the Row 79 paragraph above).
  //
  // KNOWN, DELIBERATELY-DEFERRED GAP: under forced free mode on a
  // NON-free_only profile (allow_paid_models: false, a settings-level
  // switch this per-profile function cannot see), high_quality_scan is ALSO
  // refused, yet neither tool_models nor explicit hq is blanked here for
  // that case (profile.free_only is still false) — narrowing further would
  // need threading the global switch through every caller.
  const hqBlanked = profile.free_only === true;
  const explicitHq =
    !hqBlanked &&
    typeof profile.high_quality_model?.id === "string" &&
    profile.high_quality_model.id.length > 0
      ? [profile.high_quality_model.id]
      : [];
  const base =
    profile.free_only === true
      ? free // free_models only (model/second/third/paid are inert under free_only)
      : [profile.model, profile.second_model, profile.third_model, ...paid, ...free];
  return [...base, ...toolModels, ...explicitHq].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/**
 * P6b-fix4 B1(1): true iff EVERY model this profile would send is bound to a
 * `providers[]` route that carries its own working credential — so the profile
 * can serve requests without the base `api`'s key resolving at all.
 *
 * WHY this exemption has to exist: on a machine with only `$BAI_API_KEY`
 * exported, the maintainer writes a `free` section whose whole pool is the b.ai
 * route (its `providers[]` binding reads `$BAI_API_KEY`), while the section's own
 * `api_key` stays `$OPENROUTER_API_KEY` — unset. The Remote-auth rule read only
 * that field, so llm-ext REJECTED its own write: the reload printed
 * `⚠ settings.yaml change rejected` and the NEXT boot served NOT CONFIGURED for
 * every tool. The profile was perfectly able to serve; the rule was asking the
 * wrong question.
 *
 * FAILS CLOSED, three ways, because the answer authorizes booting on a profile
 * with no primary credential:
 *  - an EMPTY chain is never covered (nothing proven servable; the free_only
 *    "non-empty pool" and the `model` requirement already report that case),
 *  - a chain entry with NO route falls through to the base api, which is
 *    precisely the case the rule must still catch,
 *  - a route whose own credential does not resolve does not count (a local
 *    preset needs none — the same `isLocal` test the `providers[]` block uses
 *    when it decides whether to require a binding `api_key`).
 *
 * resolveGroups is safe here even on an otherwise-invalid profile (it never
 * throws), and it drops malformed bindings — which also fails closed: a dropped
 * binding leaves its models uncovered.
 */
function servedEntirelyByProviderRoutes(name: string, profile: Profile): boolean {
  const chain = chainModelIds(name, profile);
  if (chain.length === 0) return false;
  const { routesFor } = resolveGroups(profile);
  // D6a "every serving group": a chain id is covered only when EVERY group
  // that serves it carries a working credential (or is local). One
  // non-billable group plus one credential-less catch-all serving the same
  // id would send that id through the catch-all at send time, so the
  // exemption must not claim it — fail closed on the ANY-ungrouped case.
  return chain.every((id) =>
    routesFor(id).every((route) => {
      const bindingPreset = API_PRESETS[route.api];
      if (bindingPreset === undefined) return false;
      return bindingPreset.isLocal || route.authToken.length > 0;
    }),
  );
}

/**
 * `Profile.selection` errors (E-L1, E-S1 — D0, TRDD-AL8GIZYA). Factored out
 * of validateProfile so validateUserOwnedKeys (dynamic-maintainer.ts's
 * regeneration gate, design section 3.2 rule 4) can ask "is the user's
 * selection block OK" without also running every GENERATED-key check
 * validateProfile runs — those would report defects that are llm-ext's own
 * fault to fix, not the user's, and rule 4 must never conflate the two.
 */
function selectionErrors(name: string, profile: Profile): string[] {
  if (!isDynamicProfileName(name)) {
    // E-S1: nothing on a static profile is auto-picked — its ensemble is
    // model/second_model/third_model.
    return profile.selection !== undefined
      ? [
          `Profile '${name}': 'selection' only applies to free/paid/local. Your profile's ensemble is model/second_model/third_model, and nothing in it is auto-picked.`,
        ]
      : [];
  }
  const sel = profile.selection;
  if (sel === undefined) return [];
  const msg = `Profile '${name}': selection.price_ceiling_usd_per_million must be a number > 0 (USD per million tokens, input and output each)`;
  if (typeof sel !== "object" || sel === null || Array.isArray(sel)) return [msg];
  const selRecord = sel as Record<string, unknown>;
  const allowedKeys = SELECTION_ALLOWED_KEYS[name];
  const hasUnknownKey = Object.keys(selRecord).some((k) => !allowedKeys.includes(k));
  const raw = selRecord.price_ceiling_usd_per_million;
  const ceilingInvalid = raw !== undefined && (typeof raw !== "number" || !isFinite(raw) || raw <= 0);
  return hasUnknownKey || ceilingInvalid ? [msg] : [];
}

/**
 * `Profile.high_quality_model` errors (TRDD-DBUSM55E). Factored out of
 * validateProfile for the same reason as selectionErrors above — it is a
 * DYNAMIC_USER_OWNED_KEYS entry (D0), so validateUserOwnedKeys needs it too.
 * Optional block; blank YAML key → null → "no override, use defaults". A
 * non-null non-object is a real mistake. Sub-fields are validated when
 * present; resolveHighQualityModel still fills defaults for any field
 * omitted or wrong.
 */
function highQualityModelErrors(name: string, profile: Profile): string[] {
  const errors: string[] = [];
  const rawHq: unknown = profile.high_quality_model;
  if (rawHq === undefined || rawHq === null) return errors;
  if (typeof rawHq !== "object" || Array.isArray(rawHq)) {
    errors.push(
      `Profile '${name}': high_quality_model must be a map of {id, reasoning_effort, cache, min_quantization, provider, allow_fallbacks}`,
    );
    return errors;
  }
  const hq = rawHq as Record<string, unknown>;
  if (hq.id !== undefined && (typeof hq.id !== "string" || hq.id.length === 0)) {
    errors.push(`Profile '${name}': high_quality_model.id must be a non-empty model-id string`);
  }
  if (
    hq.reasoning_effort !== undefined &&
    (typeof hq.reasoning_effort !== "string" || !VALID_HQ_REASONING.has(hq.reasoning_effort.toLowerCase()))
  ) {
    errors.push(
      `Profile '${name}': high_quality_model.reasoning_effort must be one of off|low|medium|high|xhigh|max`,
    );
  }
  if (hq.cache !== undefined && typeof hq.cache !== "boolean") {
    errors.push(`Profile '${name}': high_quality_model.cache must be a boolean`);
  }
  if (
    hq.min_quantization !== undefined &&
    (typeof hq.min_quantization !== "string" || !QUANT_TIERS.includes(hq.min_quantization.toLowerCase()))
  ) {
    errors.push(
      `Profile '${name}': high_quality_model.min_quantization must be one of ${QUANT_TIERS.join("|")}`,
    );
  }
  if (hq.provider !== undefined && (typeof hq.provider !== "string" || hq.provider.length === 0)) {
    errors.push(`Profile '${name}': high_quality_model.provider must be a non-empty provider slug string`);
  }
  if (hq.allow_fallbacks !== undefined && typeof hq.allow_fallbacks !== "boolean") {
    errors.push(`Profile '${name}': high_quality_model.allow_fallbacks must be a boolean`);
  }
  return errors;
}

/**
 * Validate ONLY the user-owned subsections of a dynamic profile (D0's set:
 * `selection`, `high_quality_model`) — used by the maintainer's regeneration
 * gate (design section 3.2 rule 4). A user-owned-key error must NEVER
 * trigger a regeneration: it is the user's own data, and validateProfile's
 * full verdict would also fold in any GENERATED-key defect, which is
 * llm-ext's fault to fix, not a reason to back up and discard what the user
 * wrote.
 */
export function validateUserOwnedKeys(name: DynamicProfileName, profile: Profile): ValidationResult {
  const errors = [...selectionErrors(name, profile), ...highQualityModelErrors(name, profile)];
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single profile for correctness and consistency.
 * Returns { valid: true, errors: [] } or { valid: false, errors: [...] }.
 */
export function validateProfile(
  name: string,
  profile: Profile,
): ValidationResult {
  // PF-01: a classifier has its own schema (no mode); the chat checks below would reject it.
  if (profile["profile-type"] === "classifier") {
    const classifierErrors = validateClassifierProfile(name, profile);
    return { valid: classifierErrors.length === 0, errors: classifierErrors };
  }
  const errors: string[] = [];

  // ── Required fields ───────────────────────────────────────────────
  if (!profile.mode) {
    errors.push(`Profile '${name}': missing required field: mode`);
  } else if (!["local", "remote", "remote-ensemble"].includes(profile.mode)) {
    errors.push(
      `Invalid mode '${profile.mode}'. Must be: local, remote, or remote-ensemble`,
    );
  }

  if (!profile.api) {
    errors.push(`Profile '${name}': missing required field: api`);
  }

  // Under free_only the `model` field is supplied by free_models[0], so it is
  // optional here (the free_only block below validates free_models instead).
  if (!profile.model && !profile.free_only) {
    errors.push(`Profile '${name}': missing required field: model`);
  }

  // ── Preset existence ──────────────────────────────────────────────
  const preset = profile.api ? API_PRESETS[profile.api] : undefined;
  if (profile.api && !preset) {
    errors.push(
      `Unknown api preset '${profile.api}'. Valid presets: ${Object.keys(API_PRESETS).join(", ")}`,
    );
    // Can't validate further without a valid preset
    return { valid: false, errors };
  }

  if (!preset || !profile.mode) {
    return { valid: false, errors };
  }

  // ── Mode ↔ preset suffix compatibility ────────────────────────────
  if (profile.mode === "local" && !preset.isLocal) {
    errors.push(
      `Mode 'local' requires a -local api preset, got '${profile.api}'`,
    );
  }
  if (
    (profile.mode === "remote" || profile.mode === "remote-ensemble") &&
    preset.isLocal
  ) {
    errors.push(
      `Mode '${profile.mode}' requires a -remote api preset, got '${profile.api}'`,
    );
  }

  // NOTE — deliberately NO placeholder exemption here. An unpopulated default
  // profile genuinely CANNOT serve a request (no models), so reporting it valid
  // would be a lie, and the "free_only needs a non-empty pool" rule below is a
  // zero-spend invariant, not a formality. The distinction that actually
  // matters is "the USER misconfigured this" vs "the MACHINE has not populated
  // it yet" — and that belongs to the CALLER, which knows whether the profile
  // is machine-owned and can route it to population instead of to an error.
  // See isUnpopulatedDefaultProfile() and the boot gate in index.ts.

  // ── free_only rules (TRDD-8b6b3646) ───────────────────────────────
  // The switch can NEVER cause spend, so the constraints here are strict.
  if (profile.free_only) {
    if (preset.isLocal) {
      errors.push(
        `Profile '${name}': free_only requires a remote (OpenRouter) api preset — ':free' models are an OpenRouter concept. Got local preset '${profile.api}'.`,
      );
    }
    // free_models comes from YAML (untyped at runtime) — a scalar would crash the
    // checks below, so flag a non-list explicitly and coerce for the rest.
    if (profile.free_models !== undefined && !Array.isArray(profile.free_models)) {
      errors.push(
        `Profile '${name}': free_models must be a YAML list of ':free' model ids.`,
      );
    }
    const pool = coerceFreeModels(profile.free_models);
    if (pool.length === 0) {
      errors.push(
        `Profile '${name}': free_only requires a non-empty 'free_models' list.`,
      );
    }
    // A non-':free' id is still allowed IFF it is served ONLY by `providers[]`
    // routes that cannot bill — D6a "every serving group" (a billable group
    // sharing the id would bill on the walk's second entry). Reuses
    // billableForRoute, the SAME decider assertFreeOnlyModel uses at send
    // time, so this can never drift from the runtime rule (addendum item 5).
    // resolveGroups is safe to call here even on an otherwise-invalid
    // profile: it never throws (see its own doc).
    const { routesFor, routes: allGroups } = resolveGroups(profile);
    // D6a-review F2: D6a deleted the cross-group duplicate refusal, so a
    // free_only profile may now legally carry a BILLABLE group (validation
    // passes where the old refusal fired) and the failure moved to send
    // time — fail-closed and correct, but late and far from its cause. A
    // boot-time warning names each BILLABLE providers[] GROUP so the
    // misconfiguration surfaces where the user edits; the send-time
    // chokepoint stays the enforcement point (advisory — never fails
    // validation). The PRIMARY group is skipped: every free_only profile's
    // primary IS the billable OpenRouter api by design, so warning on it
    // would fire on every free_only profile ever written.
    for (const r of allGroups.slice(1)) {
      if (billableForRoute(r, false)) {
        process.stderr.write(
          `[llm-externalizer] Warning: Profile '${name}' is free_only but its group '${r.name}' (${r.url}) can bill — ` +
            `ids it serves will be refused at send time unless another serving group covers them for free.\n`,
        );
      }
    }
    const nonFree = pool.filter((m) => {
      if (m.endsWith(":free")) return false;
      const serving = routesFor(m);
      const exemptByRoute = serving.length > 0 && serving.every((r) => !billableForRoute(r, false));
      return !exemptByRoute;
    });
    if (nonFree.length > 0) {
      errors.push(
        `Profile '${name}': free_only forbids non-':free' models unless served by a non-billable 'providers[]' route — every other free_models entry MUST end with ':free'. Offending: ${nonFree.join(", ")}`,
      );
    }
    // tool_models values must ALSO respect the free_only cost gate. resolveProfile
    // keeps tool_models populated for a DYNAMIC free_only profile ("free") — P1's
    // whole point (TRDD-97ef8b63 item 4) — so an entry naming a PAID model would
    // otherwise reach resolveModelForTool unblocked. A STATIC free_only profile
    // still blanks tool_models at resolve time, but checking it here too costs
    // nothing and keeps the invariant in one place instead of two. Reuse the SAME
    // route-exemption decider as the free_models pool above (routesFor /
    // billableForRoute) so this can never drift from what assertFreeOnlyModel
    // allows at send time. Only string values are checked — a non-string value is
    // already reported separately by the tool_models shape-validation block below.
    const nonFreeToolModels = Object.entries(coerceToolModels(profile.tool_models)).filter(
      ([, m]) => {
        if (typeof m !== "string" || m.endsWith(":free")) return false;
        const serving = routesFor(m);
        const exemptByRoute = serving.length > 0 && serving.every((r) => !billableForRoute(r, false));
        return !exemptByRoute;
      },
    );
    if (nonFreeToolModels.length > 0) {
      errors.push(
        `Profile '${name}': free_only forbids a non-':free' model in tool_models unless served by a non-billable 'providers[]' route — every tool_models entry MUST end with ':free'. Offending: ${nonFreeToolModels.map(([t, m]) => `${t}=${m}`).join(", ")}`,
      );
    }
    if (profile.mode === "remote-ensemble" && pool.length < 2) {
      // D5: reserved ensemble slots COUNT toward the floor — they are real
      // fan-out members (getEnsembleModels puts them in slots 0..n before the
      // ranking). Without this, the bai-binding-to-reserved-slot migration
      // would migrate a 2-member pool to 1 ranked member + 1 reserved slot
      // and the section would fail validation llm-ext itself had just
      // written. resolveReservedSlots never throws and drops malformed
      // entries, so it is safe on an otherwise-invalid profile here.
      const reservedCount = resolveReservedSlots(profile).reservedSlots.length;
      if (pool.length + reservedCount < 2) {
        errors.push(
          `Profile '${name}': free_only + mode 'remote-ensemble' needs at least 2 ensemble members (reserved slots count); got ${pool.length} free_models + ${reservedCount} reserved. Use mode 'remote' for a single free model.`,
        );
      }
    }
  }

  // ── second_model / third_model rules ──────────────────────────────
  // Under free_only the ensemble models come from free_models, so second_model
  // is not required (and is ignored if set).
  if (
    profile.mode === "remote-ensemble" &&
    !profile.second_model &&
    !profile.free_only
  ) {
    errors.push("Mode 'remote-ensemble' requires 'second_model'");
  }
  // A STATIC profile's model/second_model/third_model is a manual fallback
  // sequence, "all manual, no benchmarks or updates" (USER spec 3.1) — it is
  // allowed in EVERY mode (USER: "Allow second/third_model" in every mode),
  // because profileChain already walks [model, secondModel, thirdModel] for
  // a static profile regardless of `mode` (see profileChain's own doc). Only
  // a DYNAMIC profile (free/paid — llm-ext's own auto-picked ensemble) keeps
  // these mode restrictions: its second/third are machine-written by the
  // maintainer for remote-ensemble specifically, so a hand-set one outside
  // that mode is a real misconfiguration, not a manual fallback list.
  if (isDynamicProfileName(name)) {
    if (profile.mode === "local" && profile.second_model) {
      errors.push("Mode 'local' does not support 'second_model'");
    }
    if (profile.mode === "remote" && profile.second_model) {
      errors.push(
        "Mode 'remote' does not support 'second_model'. Use 'remote-ensemble'",
      );
    }
    if (profile.third_model && profile.mode !== "remote-ensemble") {
      errors.push("'third_model' is only supported in 'remote-ensemble' mode");
    }
  }

  // ── LM Studio native API constraints ──────────────────────────────
  if (profile.api === "lmstudio-local") {
    if (profile.second_model) {
      errors.push("LM Studio native API does not support second_model");
    }
  }

  // ── URL validation ────────────────────────────────────────────────
  const effectiveUrl = profile.url || preset.defaultUrl;
  if (effectiveUrl) {
    const urlIsLocal = isLocalUrl(effectiveUrl);
    if (
      (profile.mode === "remote" || profile.mode === "remote-ensemble") &&
      urlIsLocal
    ) {
      errors.push(`Remote mode cannot use local URL '${effectiveUrl}'`);
    }
  }

  // generic-local and locals-local require an explicit url (no default; for
  // locals-local, Locals' own default port 8321 is the user's own server).
  if ((profile.api === "generic-local" || profile.api === "locals-local") && !profile.url) {
    errors.push(`Api preset '${profile.api}' requires explicit 'url'`);
  }

  // ── Numeric field validation ─────────────────────────────────────
  if (
    profile.timeout !== undefined &&
    (typeof profile.timeout !== "number" ||
      !isFinite(profile.timeout) ||
      profile.timeout < 0)
  ) {
    errors.push(
      `Profile '${name}': timeout must be a non-negative finite number`,
    );
  }
  if (
    profile.context_window !== undefined &&
    (typeof profile.context_window !== "number" ||
      !isFinite(profile.context_window) ||
      profile.context_window < 0)
  ) {
    errors.push(
      `Profile '${name}': context_window must be a non-negative finite number`,
    );
  }

  // M10: Upper bounds on numeric overrides to prevent resource abuse
  if (typeof profile.timeout === "number" && profile.timeout > 3600) {
    errors.push(`Profile '${name}': timeout must be <= 3600 (1 hour)`);
  }
  if (typeof profile.context_window === "number" && profile.context_window > 10_000_000) {
    errors.push(`Profile '${name}': context_window must be <= 10,000,000`);
  }

  // ── Remote auth ───────────────────────────────────────────────────
  if (!preset.isLocal) {
    const rawAuth = profile.api_key || preset.defaultAuthEnv;
    const resolved = resolveEnvValue(rawAuth);
    // P6b-fix4 B1(1): the base credential is REQUIRED unless nothing this
    // profile sends would go through the base api. servedEntirelyByProviderRoutes
    // says why, and fails closed on every ambiguity — an uncovered chain entry,
    // an empty chain, or a route with no credential of its own all keep the rule
    // firing. Checked SECOND so the common case costs nothing.
    if (!resolved && !servedEntirelyByProviderRoutes(name, profile)) {
      const hint = rawAuth?.startsWith("$")
        ? ` (env var ${rawAuth} is not set)`
        : "";
      errors.push(`Remote api '${profile.api}' requires 'api_key'${hint}`);
    }
  }

  // ── Multi-provider bindings (providers) ───────────────────────────
  // Validated against the RAW value, never against coerceProviderBindings():
  // the coercer's job is to survive bad YAML, so it DROPS a malformed binding
  // silently. Validating the coerced list would therefore inspect exactly the
  // entries that are already fine and never see the one that vanished — the
  // profile would pass, the provider would simply never be used, and the models
  // would fall through to the PRIMARY provider and be sent with the PRIMARY's
  // key. "Provider silently ignored" is the failure mode this whole block
  // exists to convert into a startup error.
  const rawProviders: unknown = profile.providers;
  if (rawProviders !== undefined && rawProviders !== null) {
    if (!Array.isArray(rawProviders)) {
      errors.push(
        `Profile '${name}': providers must be a YAML list of {api, models} bindings`,
      );
    } else {
      // D6a (design section 4, E-P1..E-P4): each binding is a NAMED group and
      // one model id MAY be served by several groups — "the same id in two
      // groups is no longer an error: it means tried in group order". The
      // D0 cross-group duplicate refusal is REMOVED; it was the documented
      // ceiling on multi-account profiles, and the latent bug it caused
      // (buildLocalProfileSection emitting one id under two detected
      // endpoints, so llm-ext's own local section failed validation) is the
      // case D6a legalizes. What replaces it: E-P1 (names), E-P2 (a group
      // without `api` needs `name`+`url`), E-P3 (one group per (url,
      // keyRef) — duplicate ENDPOINT+KEY is still meaningless), E-P4 (the
      // per-group models checks below, unchanged).
      const seenNames = new Set<string>();
      const seenEndpoints = new Map<string, number>();
      rawProviders.forEach((entry: unknown, i: number) => {
        const at = `providers[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push(`Profile '${name}': ${at} must be a map with 'api' and 'models'`);
          return;
        }
        const e = entry as Record<string, unknown>;
        const hasApi = typeof e.api === "string" && e.api.length > 0;
        // E-P2 (design section 4): a group with no preset name has no URL or
        // default key to fall back to — it is a raw endpoint, so `name` (its
        // identity) and `url` (its address) are both REQUIRED.
        if (!hasApi && (typeof e.name !== "string" || e.name.length === 0 || typeof e.url !== "string" || e.url.length === 0)) {
          errors.push(
            `Profile '${name}': ${at}: a group without 'api' needs 'name' and 'url' (its protocol is detected)`,
          );
        }
        // E-P1 (design section 4): explicit names must match the group-name
        // grammar, be unique within the profile, and not collide with a
        // DERIVED name (deriveGroupNames mints `api`, `api-2`, … — a user
        // group named the same would make `ensemble.reserved[].provider:`
        // ambiguous). Derived collisions are impossible by construction; only
        // explicit names are checked here against each other and against the
        // full derived set.
        if (e.name !== undefined && e.name !== null) {
          if (typeof e.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(e.name)) {
            errors.push(
              `Profile '${name}': ${at}.name '${String(e.name)}' must match ^[a-z0-9][a-z0-9-]{0,39}$ (lowercase letters, digits, dashes)`,
            );
          } else if (seenNames.has(e.name)) {
            errors.push(
              `Profile '${name}': group name '${e.name}' is already used; names must be unique within the profile`,
            );
          } else {
            seenNames.add(e.name);
          }
        }
        if (typeof e.api !== "string" || !e.api) {
          // E-P2 already reported the name/url requirement when api is
          // absent; without an api there is nothing preset-based left to
          // check on this entry.
          if (typeof e.api === "string" || e.api !== undefined) {
            if (typeof e.api !== "string" || e.api.length === 0) {
              // present but empty → E-P2's message above covers the
              // no-usable-api case; fall through to the generic message
              // for a WRONG-typed api below only when api is a non-string.
            }
          }
          if (e.api !== undefined && e.api !== null && typeof e.api !== "string") {
            errors.push(`Profile '${name}': ${at}.api must be a non-empty preset name`);
          }
          if (e.api === undefined || e.api === null) {
            // A name+url group (no api) — its protocol is detected at first
            // use (D6b). Nothing preset-based to validate; the URL/key type
            // checks below still apply.
            if (e.url !== undefined && e.url !== null && typeof e.url !== "string") {
              errors.push(`Profile '${name}': ${at}.url must be a string`);
            }
            if (e.api_key !== undefined && e.api_key !== null && typeof e.api_key !== "string") {
              errors.push(`Profile '${name}': ${at}.api_key must be a string (an env-var ref like '$BAI_API_KEY', or the key itself)`);
            }
            return;
          }
          return;
        }
        const bp = API_PRESETS[e.api];
        if (!bp) {
          errors.push(
            `Profile '${name}': ${at} has unknown api preset '${e.api}'. Valid presets: ${Object.keys(API_PRESETS).join(", ")}`,
          );
          return;
        }
        // LM Studio's native API lives at /api/v1/chat and is chosen by probing
        // the PRIMARY backend. A routed model always goes to
        // `${route.url}/v1/chat/completions`, so binding this preset here would
        // send OpenAI-compat requests to a server selected for its native API —
        // reachable only as the profile-level `api`, never as a binding.
        if (e.api === "lmstudio-local") {
          errors.push(
            `Profile '${name}': ${at} cannot use 'lmstudio-local' — its native API is only reachable as the profile-level 'api'. Use 'generic-local' with an explicit url for a routed LM Studio server.`,
          );
        }
        if (!Array.isArray(e.models)) {
          errors.push(
            `Profile '${name}': ${at}.models must be a YAML list of model ids (a bare string is dropped silently, which reads as 'this provider is never used')`,
          );
          return;
        }
        const bad = e.models.filter((m) => typeof m !== "string" || m.length === 0);
        if (bad.length > 0) {
          errors.push(
            `Profile '${name}': ${at}.models entries must be non-empty model-id strings`,
          );
        }
        const ids = e.models.filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        );
        if (ids.length === 0) {
          errors.push(`Profile '${name}': ${at}.models must list at least one model id`);
        }
        // Review F-8: a locals-local binding gets the same platform and model checks as a locals-local profile (never managed: only the profile's own group is).
        if (e.api === "locals-local") {
          if (!localsPlatformSupported()) errors.push(`Profile '${name}': ${at} uses locals-local, which needs macOS on Apple silicon`);
          errors.push(...localsModelErrors(`Profile '${name}': ${at}`, ids, false));
        }
        // (D6a) The D0 cross-group duplicate refusal is GONE: the same id in
        // two groups means "tried in group order" (E-P4 keeps only the
        // per-group checks above). E-P3 below refuses the meaningless
        // duplicate — same endpoint AND same key.
        // A wrong-TYPED optional field is the quietest failure of all: the
        // coercer and this validator both read it as `typeof x === "string" ?
        // x : fallback`, so they AGREE and neither complains — the value simply
        // vanishes. `url: 8080` sends to the preset's default endpoint; a
        // numeric `api_key` resolves the preset's default env var, i.e. a
        // DIFFERENT ACCOUNT than the one written. Config that reads as written
        // and is not is exactly what this block exists to reject.
        // `!== null` alongside `!== undefined`: a blank YAML key (`url:` with
        // nothing after it) parses to null and MEANS "absent" — the same
        // null-is-absent precedent `tool_models` and `high_quality_model`
        // already set in this function. Rejecting it would fail a profile that
        // is merely verbose.
        if (e.url !== undefined && e.url !== null && typeof e.url !== "string") {
          errors.push(`Profile '${name}': ${at}.url must be a string`);
        }
        if (e.api_key !== undefined && e.api_key !== null && typeof e.api_key !== "string") {
          errors.push(`Profile '${name}': ${at}.api_key must be a string (an env-var ref like '$BAI_API_KEY', or the key itself)`);
        }
        const bUrl = typeof e.url === "string" ? e.url : undefined;
        if ((e.api === "generic-local" || e.api === "locals-local") && !bUrl) {
          errors.push(`Profile '${name}': ${at} uses '${String(e.api)}', which requires an explicit 'url'`);
        }
        // A binding carries its OWN account. An unresolvable key here is fatal
        // for the same reason as the profile-level one, and MORE silent: the
        // route would still be built, so the request goes out with an empty
        // Authorization header rather than not going out at all.
        if (!bp.isLocal) {
          const rawAuth = typeof e.api_key === "string" ? e.api_key : bp.defaultAuthEnv;
          if (!resolveEnvValue(rawAuth)) {
            const hint = rawAuth?.startsWith("$") ? ` (env var ${rawAuth} is not set)` : "";
            errors.push(
              `Profile '${name}': ${at} api '${e.api}' requires 'api_key'${hint}`,
            );
          }
        }
        // E-P3 (D6a, design section 4): two groups with the same normalized
        // (url, keyRef) are the same endpoint AND the same key — credit is
        // per key, so a second copy adds a dead re-try to every walk, never a
        // second opinion. List one group per key. Same-host comparison as
        // overridesEndpoint (host carries the port; scheme matters).
        const eUrl = typeof e.url === "string" && e.url ? e.url : bp.defaultUrl;
        const eKeyRef = routeKeyRef(
          typeof e.api_key === "string" ? e.api_key : bp.defaultAuthEnv,
          resolveEnvValue(typeof e.api_key === "string" ? e.api_key : bp.defaultAuthEnv),
        );
        try {
          const norm = new URL(eUrl);
          const epKey = `${norm.host}${norm.pathname.replace(/\/+$/, "")}|${eKeyRef}`;
          const first = seenEndpoints.get(epKey);
          if (first !== undefined) {
            errors.push(
              `Profile '${name}': providers[${first}] and ${at} use the same endpoint AND key; credit is per key, so list one group per key`,
            );
          } else {
            seenEndpoints.set(epKey, i);
          }
        } catch {
          // Unparseable URL: overridesEndpoint already fails closed on it and
          // the generic-local/preset checks above have fired where relevant;
          // E-P3 cannot compare what it cannot parse.
        }
      });
    }
  }

  // ── Paid-model pool (paid_models) — dynamic `paid` profile's fallback chain ──
  // Optional; validated generically (untrusted YAML) regardless of which
  // profile carries it. Ids must be real model-id strings and must never
  // carry ':free' — that pool is free_models, and the two must never mix, or
  // resolveModelChain's dynamic fallback could hand a 'paid' tool a ':free'
  // id it never benchmarked as paid (or vice-versa: a free_only tool getting
  // a paid id it was never meant to see).
  const rawPaidModels: unknown = profile.paid_models;
  if (rawPaidModels !== undefined && rawPaidModels !== null) {
    if (!Array.isArray(rawPaidModels)) {
      errors.push(`Profile '${name}': paid_models must be a YAML list of model ids`);
    } else {
      const badPaid = rawPaidModels.filter((m) => typeof m !== "string" || m.length === 0);
      if (badPaid.length > 0) {
        errors.push(
          `Profile '${name}': paid_models entries must be non-empty model-id strings`,
        );
      }
      const freeSuffixed = rawPaidModels.filter(
        (m): m is string => typeof m === "string" && m.endsWith(":free"),
      );
      if (freeSuffixed.length > 0) {
        errors.push(
          `Profile '${name}': paid_models must not contain ':free' ids (that pool is free_models): ${freeSuffixed.join(", ")}`,
        );
      }
    }
  }

  // ── Per-tool model overrides (tool_models) ────────────────────────
  // Optional map {toolName: modelId} (TRDD-f45eeaa0). Validated as untrusted
  // YAML: keys must be known LLM-using tools (the registry is the single source
  // of truth), values must be non-empty model-id strings. Catches typos like
  // `securty_scan:` that would otherwise silently never apply.
  // `tool_models:` left blank in YAML parses to null — treat null (and
  // undefined) as "no overrides", consistent with resolveProfile/coerceToolModels.
  // A non-null non-map value (string / array / number) is still a real mistake.
  const rawToolModels: unknown = profile.tool_models;
  if (rawToolModels !== undefined && rawToolModels !== null) {
    if (typeof rawToolModels !== "object" || Array.isArray(rawToolModels)) {
      errors.push(
        `Profile '${name}': tool_models must be a map of {tool: model}`,
      );
    } else {
      const known = new Set(registeredTools());
      for (const [toolName, modelId] of Object.entries(
        rawToolModels as Record<string, unknown>,
      )) {
        if (!known.has(toolName)) {
          errors.push(
            `Profile '${name}': tool_models has unknown tool '${toolName}'. ` +
              `Known LLM tools: ${registeredTools().join(", ")}`,
          );
        }
        if (typeof modelId !== "string" || modelId.length === 0) {
          errors.push(
            `Profile '${name}': tool_models['${toolName}'] must be a non-empty model-id string`,
          );
        }
      }
    }
  }

  // ── request_options (TRDD-1OOAH3LD increment 1) ───────────────────
  // Untrusted YAML. Local profiles only (PROFILE_TYPE_FIELDS rejects the key
  // elsewhere). Unknown tool names and unknown fields are refused so a typo
  // cannot silently never apply (same rationale as tool_models above). A
  // `default.max_output_tokens` is REQUIRED: max_tokens is always explicit on
  // this path, and every tool block falls back to the default block.
  const rawRequestOptions: unknown = profile.request_options;
  // O6: a key written with no value (null, e.g. lost indentation) must not silently switch the feature off.
  if (rawRequestOptions === null || (typeof rawRequestOptions === "object" && !Array.isArray(rawRequestOptions) && Object.keys(rawRequestOptions).length === 0)) {
    errors.push(`Profile '${name}': request_options is empty; remove the key or add a default block`);
  } else if (rawRequestOptions !== undefined) {
    // O1: request_options are only sent on the OpenAI-compatible llama-server path; the LM Studio native API never receives them, so refuse instead of ignoring.
    if (profile.api !== undefined && API_PRESETS[profile.api]?.protocol === "lmstudio_api") {
      errors.push(`Profile '${name}': request_options is not supported on api '${profile.api}' (LM Studio native protocol); use a llama.cpp (openai_api) preset`);
    }
    if (typeof rawRequestOptions !== "object" || Array.isArray(rawRequestOptions)) {
      errors.push(`Profile '${name}': request_options must be a map of {default|tool: block}`);
    } else {
      const knownTools = new Set(registeredTools());
      const fieldNames = ["thinking", "max_output_tokens", "temperature", "top_k", "repeat_penalty"];
      const opts = rawRequestOptions as Record<string, unknown>;
      for (const [blockName, rawBlock] of Object.entries(opts)) {
        const where = `Profile '${name}': request_options['${blockName}']`;
        if (blockName !== "default" && !knownTools.has(blockName)) {
          errors.push(
            `Profile '${name}': request_options has unknown tool '${blockName}'. ` +
              `Use 'default' or one of: ${registeredTools().join(", ")}`,
          );
        }
        if (typeof rawBlock !== "object" || rawBlock === null || Array.isArray(rawBlock)) {
          errors.push(`${where} must be a map of option fields`);
          continue;
        }
        const block = rawBlock as Record<string, unknown>;
        for (const key of Object.keys(block)) {
          if (!fieldNames.includes(key)) {
            errors.push(`${where} has unknown field '${key}'. Known fields: ${fieldNames.join(", ")}`);
          }
        }
        const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
        if (block.thinking !== undefined && block.thinking !== true && block.thinking !== false && block.thinking !== "on" && block.thinking !== "off") {
          errors.push(`${where}.thinking must be true, false, "on" or "off"`);
        }
        if (block.max_output_tokens !== undefined) {
          const v = block.max_output_tokens;
          if (!isNum(v) || !Number.isInteger(v) || v < 1 || v > 10_000_000) {
            errors.push(`${where}.max_output_tokens must be an integer between 1 and 10,000,000`);
          } else if (typeof profile.context_window === "number" && profile.context_window > 0 && v >= profile.context_window) {
            errors.push(`${where}.max_output_tokens (${v}) must be smaller than context_window (${profile.context_window})`);
          }
        }
        if (block.temperature !== undefined && (!isNum(block.temperature) || block.temperature < 0 || block.temperature > 2)) {
          errors.push(`${where}.temperature must be a number between 0 and 2`);
        }
        if (block.top_k !== undefined && (!isNum(block.top_k) || !Number.isInteger(block.top_k) || block.top_k < 0 || block.top_k > 1000)) {
          errors.push(`${where}.top_k must be an integer between 0 and 1000`);
        }
        if (block.repeat_penalty !== undefined && (!isNum(block.repeat_penalty) || block.repeat_penalty <= 0 || block.repeat_penalty > 10)) {
          errors.push(`${where}.repeat_penalty must be a number above 0 and at most 10`);
        }
      }
      const def = opts.default;
      const defTokens = typeof def === "object" && def !== null ? (def as Record<string, unknown>).max_output_tokens : undefined;
      if (defTokens === undefined) {
        errors.push(`Profile '${name}': request_options.default.max_output_tokens is required (max_tokens is always explicit)`);
      }
    }
  }
  // ── server: managed (TRDD-1OOAH3LD, per-engine broker) ─────────────
  // Untrusted YAML. Under the broker design (local-engine-broker-design.md)
  // only the PROFILE's own group is managed: the broker runs at most one main
  // llama-server per engine, on a free port it picks itself, and swaps models
  // in it. So providers[] routes are never managed (the per-route target was
  // dropped) and the url's port binds nothing; the url is only the key the
  // fallback walker marks dead.
  const rawServer: unknown = (profile as unknown as Record<string, unknown>).server;
  if (rawServer !== undefined) {
    if (rawServer !== "managed") {
      errors.push(`Profile '${name}': server must be 'managed' (the only accepted value); remove the key to start no server`);
    } else if (profile.api !== "llamacpp-local" && profile.api !== "locals-local") {
      errors.push(
        `Profile '${name}': server: managed needs the profile's own api to be llamacpp-local or locals-local (only the profile's primary group is managed), got ${typeof profile.api === "string" ? `'${profile.api}'` : "none"}`,
      );
    }
  }
  // P5: every model of a managed llamacpp-local profile is started by the
  // broker, so each must be a form it can serve (parseManagedModel); a bad id
  // fails here, not at its first request.
  if (rawServer === "managed" && profile.api === "llamacpp-local") {
    for (const m of [profile.model, profile.second_model, profile.third_model]) {
      if (typeof m !== "string" || m === "") continue;
      const p = parseManagedModel(m);
      if ("error" in p) errors.push(`Profile '${name}': ${p.error}`);
    }
  }
  // ── locals-local (TRDD-ZGSGGHQG L1) ───────────────────────────────
  // Locals runs MLX models on Apple silicon only, so the profile is refused
  // elsewhere instead of failing at its first request. The MLX gate refuses
  // the inputs known to be wrong: a GGUF file (llama.cpp's format) and the
  // `mlx/` prefix, which selects Locals' stock mlx-lm engine, the one with no
  // memory guard (Locals docs). Locals itself enforces the MLX format.
  if (profile.api === "locals-local") {
    if (!localsPlatformSupported()) errors.push(`Profile '${name}': api locals-local needs macOS on Apple silicon (Locals runs MLX models only there)`);
    const models = [profile.model, profile.second_model, profile.third_model].filter((m): m is string => typeof m === "string" && m !== "");
    errors.push(...localsModelErrors(`Profile '${name}'`, models, rawServer === "managed"));
  }
  // ── ensemble (E-D2, E-E1..E-E6 — D5, TRDD-90DM5YHO) ───────────────
  // `ensemble_pins` was REMOVED in 14.1.0: it never had a runtime reader, so
  // it never did anything. E-D2 refuses it on ANY profile (static ones are
  // never rewritten, so no migration can clear them — the fix is deletion).
  // On a dynamic profile the replacement is `ensemble: {reserved: [...]}`.
  const rawEnsemblePins: unknown = (profile as unknown as Record<string, unknown>).ensemble_pins;
  if (rawEnsemblePins !== undefined && rawEnsemblePins !== null) {
    errors.push(
      `Profile '${name}': 'ensemble_pins' was removed in 14.1.0 — it was never read, so it never did anything. On free/paid/local reserve up to 2 members with 'ensemble: {reserved: [...]}'; on your own profile the ensemble is model/second_model/third_model. Delete the key.`,
    );
  }

  // `ensemble` (E-S1 on a static profile; E-E1..E-E6 on a dynamic one). A
  // static profile's ensemble is model/second_model/third_model and nothing
  // in it is auto-picked, so the whole subsection is refused there — the
  // same rule selectionErrors applies to `selection`.
  const rawEnsemble: unknown = profile.ensemble;
  if (rawEnsemble !== undefined) {
    if (!isDynamicProfileName(name)) {
      errors.push(
        `Profile '${name}': 'ensemble' only applies to free/paid/local. Your profile's ensemble is model/second_model/third_model, and nothing in it is auto-picked.`,
      );
    } else if (typeof rawEnsemble !== "object" || rawEnsemble === null || Array.isArray(rawEnsemble)) {
      // E-E1: not a map (or a list where a map belongs).
      errors.push(`Profile '${name}': ensemble must be a map with 'reserved'`);
    } else {
      const ensRec = rawEnsemble as Record<string, unknown>;
      const unknownEnsKeys = Object.keys(ensRec).filter((k) => k !== "reserved");
      if (unknownEnsKeys.length > 0) {
        errors.push(`Profile '${name}': ensemble must be a map with 'reserved'`);
      }
      const rawReserved: unknown = ensRec.reserved;
      if (rawReserved !== undefined && rawReserved !== null) {
        if (!Array.isArray(rawReserved) || rawReserved.length > 2) {
          // E-E2: not a list, or more than 2 entries.
          errors.push(
            `Profile '${name}': ensemble.reserved holds at most 2 members; the third always comes from the profile's ranking`,
          );
        } else {
          const { routes, routesFor } = resolveGroups(profile);
          const seenPairs = new Set<string>();
          rawReserved.forEach((entry: unknown, i: number) => {
            const at = `ensemble.reserved[${i}]`;
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              // E-E3 (map-shape arm): an entry that is not a map cannot carry
              // a model.
              errors.push(`Profile '${name}': ${at}.model must be a model id`);
              return;
            }
            const slot = entry as Record<string, unknown>;
            if (typeof slot.model !== "string" || slot.model.length === 0) {
              // E-E3: the model id is required and must be a non-empty string.
              errors.push(`Profile '${name}': ${at}.model must be a model id`);
              return;
            }
            const provider = slot.provider;
            if (provider !== undefined && provider !== null) {
              if (typeof provider !== "string" || provider.length === 0) {
                errors.push(`Profile '${name}': ${at}.provider must be a provider group name of this profile (groups: ${routes.map((r) => r.name).join(", ")})`);
                return;
              }
              const named = routes.filter((r) => r.name === provider);
              if (named.length === 0) {
                // E-E4: the named group does not exist in this profile.
                errors.push(
                  `Profile '${name}': ${at}.provider '${provider}' is not a provider group of this profile (groups: ${routes.map((r) => r.name).join(", ")})`,
                );
                return;
              }
              // E-E5: the named group must serve the model — listed in its
              // `models:`, or a catch-all (empty `models:` serves every id no
              // named group claims).
              const slotModel: string = slot.model;
              const serves = named.some((r) => r.models.includes(slotModel) || (r.models.length === 0 && !r.primary));
              if (!serves) {
                errors.push(
                  `Profile '${name}': ${at}.provider '${provider}' does not serve '${slot.model}' — add it to that group's models, or drop 'provider:'`,
                );
              }
              const pairKey = `${provider}\u0000${slot.model}`;
              if (seenPairs.has(pairKey)) {
                // E-E6 (duplicate arm): the same (provider, model) pair twice
                // would fan the same send out twice to the same group.
                errors.push(
                  `Profile '${name}': ${at} duplicates an earlier ensemble.reserved entry (same provider and model)`,
                );
              }
              seenPairs.add(pairKey);
            } else {
              const otherModelSlots = (rawReserved as unknown[]).filter(
                (e2) =>
                  e2 !== entry &&
                  e2 !== null &&
                  typeof e2 === "object" &&
                  !Array.isArray(e2) &&
                  (e2 as Record<string, unknown>).model === slot.model &&
                  (e2 as Record<string, unknown>).provider === undefined,
              );
              if (otherModelSlots.length > 0 && !seenPairs.has(`\u0000${slot.model}`)) {
                // E-E6 (duplicate arm, no-provider shape): the same model
                // reserved twice without a provider would duplicate members.
                errors.push(
                  `Profile '${name}': ${at} duplicates an earlier ensemble.reserved entry (same model, no provider)`,
                );
              }
              seenPairs.add(`\u0000${slot.model}`);
            }
          });
          // E-E6 (free_only arm): a free_only profile's ensemble must never be
          // able to bill — a slot whose model is non-':free' and whose serving
          // groups include a BILLABLE one would send a paid id under a free
          // profile. Reuses the same route-exemption decider
          // (billableForRoute) the free_models pool and tool_models checks
          // above use, so all three can never drift from what
          // assertFreeOnlyModel allows at send time.
          if (profile.free_only === true) {
            for (const pairKey of seenPairs) {
              const modelId = pairKey.split("\u0000")[1];
              const billable = routesFor(modelId).some((r) => billableForRoute(r, false));
              if (!modelId.endsWith(":free") && billable) {
                errors.push(
                  `Profile '${name}': free_only forbids non-':free' models unless served by a non-billable 'providers[]' route — every other free_models entry MUST end with ':free'. Offending: ${modelId}`,
                );
              }
            }
          }
        }
      }
    }
  }

  // ── Ownership boundary (E-D1) — D0, TRDD-AL8GIZYA ──────────────────
  // A dynamic section may hold only GENERATED ∪ USER-OWNED keys. This is
  // what makes the allowlist safe: a misspelt key is refused loudly instead
  // of being silently dropped by the next regeneration (design section 3.2
  // rule 1). Static profiles are unaffected — they keep ignoring unknown
  // keys, as today.
  // PT-04: the closed key set also covers `scouting` (a marked, benchmark-written section), so a misspelt key there fails loudly instead of being silently ignored.
  // PF-04: not `or-jev`: its keys are checked by the classifier field table (validateClassifierProfile), and a hand-written one (E83) must not be judged by the generated key set.
  if (isMarkedProfileName(name) && name !== "or-jev") {
    const allowed = new Set<string>([...DYNAMIC_GENERATED_KEYS[name], ...DYNAMIC_USER_OWNED_KEYS[name]]);
    for (const key of Object.keys(profile)) {
      if (!allowed.has(key)) {
        errors.push(
          `Profile '${name}': '${key}' is not allowed in a generated profile. llm-ext writes ${DYNAMIC_GENERATED_KEYS[name].join(", ")}; you may add ${DYNAMIC_USER_OWNED_KEYS[name].join(", ")}. To choose every model yourself, create a profile with another name.`,
        );
      }
    }
  }

  // selection (E-L1, E-S1) and high_quality_model — both DYNAMIC_USER_OWNED_KEYS
  // (D0). Shared with validateUserOwnedKeys (dynamic-maintainer.ts's
  // regeneration gate) so the two never drift apart on what "valid" means.
  errors.push(...selectionErrors(name, profile));
  errors.push(...highQualityModelErrors(name, profile));
  // E81d + E113 (PT-01): an invalid or wrong-for-a-built-in-name profile-type fails the load.
  const typeErrors = profileTypeErrors(name, profile);
  errors.push(...typeErrors);
  // PT-06 (D33): a field of another type, or unknown to every type, fails the load. WHY only with an explicit profile-type: until PT-02 has written it, the type is inferred and a not-yet-migrated file must still load (same gate as E81g); WHY skipped on a type error: the field table is indexed by a valid type.
  if (profile["profile-type"] !== undefined && typeErrors.length === 0) {
    errors.push(...profileTypeFieldIssues(name, profile, profile["profile-type"] as ProfileType).map((i) => `Profile '${name}': ${i}`));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Fold the Settings-level `paid_benchmark_daily_cap_usd` check into a
 * profile's ValidationResult. A tiny wrapper (not inlined into
 * validateSettings) so the two early-return branches in validateSettings
 * (no active profile / active profile not found) never need to duplicate
 * this check — the cap is orthogonal to which profile is active.
 */
function appendCapErrors(result: ValidationResult, settings: Settings): ValidationResult {
  if (settings.paid_benchmark_daily_cap_usd === undefined) return result;
  const cap = settings.paid_benchmark_daily_cap_usd;
  if (typeof cap === "number" && isFinite(cap) && cap >= 0) return result;
  return {
    valid: false,
    errors: [
      ...result.errors,
      `paid_benchmark_daily_cap_usd must be a finite number >= 0, got '${cap}'`,
    ],
  };
}

/**
 * Every settings-level error validateSettings can produce, independent of
 * which profile is effective: the reserved-name refusal and the
 * paid_benchmark_daily_cap_usd check (row 75). Reuses
 * reservedDynamicProfileNameError and appendCapErrors so the message text
 * has one source of truth; index.ts's evaluateSettingsValidity placeholder
 * exemption calls this to ask "is there ANY settings-level error" instead of
 * only checking the reserved-name case. Unlike validateSettings, which
 * early-returns the reserved-name error alone (it never even looks at the
 * cap once a reserved-name collision refuses the document outright), this
 * concatenates both so a caller checking "any settings-level error at all"
 * sees the full set regardless of which one(s) apply.
 */
export function settingsLevelErrors(settings: Settings): string[] {
  const errors: string[] = [];
  const unmarked = settings.unmarkedDynamicProfiles;
  if (unmarked !== undefined && unmarked.length > 0) {
    errors.push(reservedDynamicProfileNameError(unmarked));
  }
  // E-D3 (D0, TRDD-AL8GIZYA): the top-level ceiling key only survives
  // migrateSettingsTo141's `price-ceiling-into-paid` step in the AMBIGUOUS
  // case (both positions set, to different values) — any other survival
  // means that step has not run yet (a direct validateSettings() call before
  // boot's migration, or a config-dir migration failure), and refusing it
  // the same way is correct either way: the fix is identical.
  if (settings.legacyEnsemblePriceCeiling !== undefined) {
    const paidCeiling = settings.profiles.paid?.selection?.price_ceiling_usd_per_million;
    // D0 fix-up 2 (TRDD-AL8GIZYA): the top-level key can survive here for
    // TWO different reasons -- (a) it's genuinely ambiguous (both positions
    // set, to different values -- migrateSettingsTo141 refuses to guess and
    // leaves both), or (b) migrateSettingsTo141 never got to write
    // profiles.paid.selection at all (e.g. settings.yaml is read-only), in
    // which case `paidCeiling` is undefined and printing it as "Y" would
    // read as "undefined" -- a real, previously-shipped bug. Branch on
    // whether the paid side is actually set so each case gets an accurate
    // message and, for (b), the real reason (a write failure) instead of a
    // false "set twice" claim.
    errors.push(
      paidCeiling !== undefined
        ? `settings.yaml sets the paid price ceiling twice (top-level ${settings.legacyEnsemblePriceCeiling}, profiles.paid.selection ${paidCeiling}). Keep profiles.paid.selection.price_ceiling_usd_per_million and delete the top-level key.`
        : `settings.yaml still has the top-level ensemble_price_ceiling_usd_per_million; llm-ext moves it to profiles.paid.selection.price_ceiling_usd_per_million on start, but could not write the file — make settings.yaml writable or move the key by hand.`,
    );
  }
  // PT-01: E81g / E81d / E113 are settings-level too (any profile, not just the effective one).
  errors.push(...profileTypesSettingsErrors(settings));
  errors.push(...activeClassifierErrors(settings));
  return appendCapErrors({ valid: errors.length === 0, errors }, settings).errors;
}

/**
 * Validate settings against the EFFECTIVE profile (TRDD-G6XT3AY9:
 * `--profile` flag > `active:` in settings.yaml > the built-in default --
 * see effectiveProfileName()). WHY (amendment, 2026-09-17): a dangling
 * `active:` (naming a profile settings.yaml does not have) is NOT rejected
 * HERE any more -- this function still runs at boot, before the CLI knows
 * whether the invocation even needs a resolved profile (`settings show` /
 * `discover` / `--profile <existing>` must keep running so the user can see
 * and fix the broken key), so it cannot be the fail-fast gate. The
 * `!profile` branch below still reports "not found" (needed so boot's
 * evaluateSettingsValidity marks the settings unresolved and skips
 * resolveProfile() rather than crashing on an undefined profile object) but
 * with the ordinary "unknown profile" wording; the `active:`-specific
 * message that names the key AND the value now lives at the CLI selection
 * call site (cli/main.ts -> overrideActiveProfile), which is the only place
 * that knows the value was actually SELECTED (no --profile given).
 */
export function validateSettings(settings: Settings): ValidationResult {
  // P6c-a (fix-queue 25, amendment 1): a hand-authored section under a
  // RESERVED dynamic name is refused OUTRIGHT, before any profile rule and
  // whichever profile is effective — the collision breaks the OTHER profile,
  // not this one, so gating it on "is `free` the effective profile" would let
  // a `--profile mine` run keep silently losing the user's `free:` section on
  // every dispatch. The first migration run has already adopted or backed up
  // whatever it found (addendum K), so anything unmarked here was written
  // AFTER llm-ext took ownership of the name.
  const unmarked = settings.unmarkedDynamicProfiles;
  if (unmarked !== undefined && unmarked.length > 0) {
    return { valid: false, errors: [reservedDynamicProfileNameError(unmarked)] };
  }
  const name = effectiveProfileName(settings);
  const profile = settings.profiles[name];
  if (!profile) {
    const available = Object.keys(settings.profiles);
    // WHY (TRDD-G6XT3AY9 amendment): generic wording, not the `active:`-named
    // one -- see this function's docblock. A dangling `active:` legitimately
    // reaches here at boot (before selection); the CLI-selection call site is
    // where that specific case gets its own message and decides whether to
    // fail the invocation at all.
    return {
      valid: false,
      errors: [`Profile '${name}' not found. Available: ${available.join(", ") || "(none)"}`],
    };
  }

  // PT-01: E81g and the explicit-type errors of every OTHER profile (a typo in
  // an unselected profile must still fail the load). The effective profile's
  // own explicit-type errors already come from validateProfile, hence `skip`.
  const typeErrors = [...profileTypesSettingsErrors(settings, name), ...activeClassifierErrors(settings)];
  const result = validateProfile(name, profile);
  return appendCapErrors(
    typeErrors.length === 0 ? result : { valid: false, errors: [...result.errors, ...typeErrors] },
    settings,
  );
}

// ── Profile resolution ──────────────────────────────────────────────

/**
 * Coerce an untrusted `tool_models` value into a plain string-map. null /
 * undefined / arrays / non-objects (e.g. a stray scalar) all collapse to `{}`
 * so resolution stays safe even on the best-effort settings-read paths that do
 * NOT pre-validate (e.g. the security_scan model injection). validateProfile is
 * what reports a malformed value to the user; this just never throws or mangles.
 */
function coerceToolModels(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, string>) };
}

/**
 * Coerce an untrusted `request_options` value (TRDD-1OOAH3LD) into the map the
 * request path reads. null / undefined / arrays / scalars -> null ("no request
 * options"); never throws, because resolveProfile runs on best-effort paths that
 * do NOT pre-validate. validateProfile is what reports a malformed value.
 */
function coerceRequestOptions(raw: unknown): RequestOptionsConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return { ...(raw as RequestOptionsConfig) };
}

/**
 * Coerce an untrusted `free_models` value (from YAML) into a clean string[].
 * A scalar / object / null collapses to [] and non-string entries are dropped,
 * so neither resolveProfile (which spreads the value) nor validateProfile (which
 * filters it) can throw on a malformed settings.yaml. validateProfile reports a
 * bad value to the user; this just never throws or mangles (e.g. it must NOT let
 * a stray string spread into an array of single characters).
 */
function coerceFreeModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === "string");
}

/**
 * A profile's configured `free_models`, WITHOUT the `free_only` gate that
 * resolveProfile applies.
 *
 * resolveProfile returns `freeModels: []` unless the profile sets `free_only`
 * (see its freeModels line), because there it feeds model/second_model/
 * third_model — a runtime invariant that must not change. But free mode is now
 * normally enabled by the TOP-LEVEL `allow_paid_models: false` master switch,
 * whose users have no per-profile `free_only` at all. Anything that wants the
 * pool ITSELF (rather than the resolved ensemble) must therefore read it
 * unconditionally, or it silently sees an empty list and falls back to a
 * hardcoded seed — which is exactly how --bench-free-pool ended up benchmarking
 * stale seed ids instead of the user's real pool.
 */
export function profileFreeModels(profile: Profile | undefined): string[] {
  return coerceFreeModels(profile?.free_models);
}

// ── High-quality model resolution (TRDD-DBUSM55E) ───────────────────────────

/**
 * Map a config reasoning_effort token to the wire value ("max" → "xhigh"). An
 * unrecognized value falls back to the default (validateProfile reports it).
 */
function mapReasoningEffort(raw: string | undefined): string {
  if (typeof raw !== "string") return HIGH_QUALITY_MODEL_DEFAULTS.reasoningEffort;
  const v = raw.toLowerCase();
  if (v === "max") return "xhigh";
  return VALID_HQ_REASONING.has(v)
    ? v
    : HIGH_QUALITY_MODEL_DEFAULTS.reasoningEffort;
}

/**
 * Expand a min_quantization into the "this-precision-or-higher" whitelist for
 * OpenRouter's provider.quantizations filter. An unknown value falls back to the
 * default fp8+ set (validateProfile reports the bad value; this never throws).
 */
function expandMinQuantization(raw: string | undefined): string[] {
  if (typeof raw !== "string")
    return [...HIGH_QUALITY_MODEL_DEFAULTS.quantizations];
  const idx = QUANT_TIERS.indexOf(raw.toLowerCase());
  if (idx < 0) return [...HIGH_QUALITY_MODEL_DEFAULTS.quantizations];
  return QUANT_TIERS.slice(idx);
}

/**
 * Resolve a (possibly absent / partial / null) high_quality_model block into a
 * fully-defaulted ResolvedHighQualityModel. Untrusted YAML: a non-object collapses
 * to all-defaults; each field falls back to HIGH_QUALITY_MODEL_DEFAULTS when
 * omitted or the wrong type (validateProfile is what reports a malformed value to
 * the user; this just never throws or mangles).
 */
export function resolveHighQualityModel(raw: unknown): ResolvedHighQualityModel {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...HIGH_QUALITY_MODEL_DEFAULTS };
  }
  const hq = raw as HighQualityModel;
  const id =
    typeof hq.id === "string" && hq.id.length > 0
      ? hq.id
      : HIGH_QUALITY_MODEL_DEFAULTS.id;
  const provider =
    typeof hq.provider === "string" && hq.provider.length > 0
      ? hq.provider
      : HIGH_QUALITY_MODEL_DEFAULTS.providerOrder[0];
  return {
    id,
    reasoningEffort: mapReasoningEffort(hq.reasoning_effort),
    cache:
      typeof hq.cache === "boolean"
        ? hq.cache
        : HIGH_QUALITY_MODEL_DEFAULTS.cache,
    providerOrder: [provider],
    quantizations: expandMinQuantization(hq.min_quantization),
    allowFallbacks:
      typeof hq.allow_fallbacks === "boolean"
        ? hq.allow_fallbacks
        : HIGH_QUALITY_MODEL_DEFAULTS.allowFallbacks,
  };
}

/**
 * Build the OpenRouter `provider` routing block for a high_quality_scan request
 * from a resolved high-quality model (TRDD-DBUSM55E). `allow_fallbacks` is always
 * present; `order` (the preferred provider, e.g. gmicloud/fp8) and `quantizations`
 * (the fp8+ whitelist) are included only when non-empty, so we never send an empty
 * array. The result is attached as the request's `provider` control field, which
 * survives the supported-params filter to the wire.
 */
export function buildHighQualityProvider(
  hq: ResolvedHighQualityModel,
): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    allow_fallbacks: hq.allowFallbacks,
  };
  if (hq.providerOrder.length > 0) provider.order = hq.providerOrder;
  if (hq.quantizations.length > 0) provider.quantizations = hq.quantizations;
  return provider;
}

/**
 * Fail-fast gate for high_quality_scan (TRDD-DBUSM55E). The tool runs a PAID
 * high-quality model, so it must refuse (never silently downgrade) when the
 * backend cannot deliver it: a non-OpenRouter backend can't reach the remote
 * model, free_only mode forbids any non-':free' model, and exhausted credit
 * would 402 every file and fall back to the free pool — defeating the quality
 * promise. Returns the user-facing refusal message, or null when allowed.
 */
export function highQualityScanRefusal(
  backendType: string,
  freeOnly: boolean,
  creditExhausted: boolean,
  // The master paid switch (getAllowPaidModels()). Only shapes the free-mode
  // MESSAGE — under the global free-default the fix is the switch, not a
  // per-profile edit. Defaults true so the pre-switch 3-arg callers (and their
  // tests) keep the original "disable free_only" wording unchanged.
  allowPaidModels: boolean = true,
): string | null {
  if (backendType !== "openrouter") {
    return (
      `high_quality_scan requires the OpenRouter backend (it runs a remote ` +
      `high-quality model); the active backend is ${backendType}. Switch to a ` +
      `remote profile, or use scan_folder for the local backend.`
    );
  }
  if (freeOnly) {
    // Deliberately a REFUSAL, not a silent downgrade: high_quality_scan's whole
    // contract is "ONE strong (paid) model". Degrading it to a free model would
    // return free-tier results under a name that promises better — worse than an
    // honest refusal. Under the master switch the actionable fix is the switch.
    if (!allowPaidModels) {
      return (
        `high_quality_scan runs ONE paid high-quality model, and paid models are ` +
        `off (allow_paid_models: false). Set allow_paid_models: true in ` +
        `~/.llm-externalizer/settings.yaml to enable it, or use scan_folder (the ` +
        `free 3-model ensemble).`
      );
    }
    return (
      `high_quality_scan uses a paid high-quality model and cannot run under ` +
      `free_only mode. Disable free_only in your profile, or use scan_folder ` +
      `(which honours the free pool).`
    );
  }
  if (creditExhausted) {
    return (
      `high_quality_scan needs OpenRouter credit for its paid high-quality model, ` +
      `but credit is exhausted (a 402 was seen this session). Add credit, or use ` +
      `scan_folder.`
    );
  }
  return null;
}

/**
 * Coerce the untyped YAML `providers:` value into bindings. Anything malformed
 * is DROPPED here and reported separately by validateProfile — resolve must not
 * throw on bad user YAML, because it runs on every boot and a crash would take
 * the whole CLI down over one mistyped key.
 */
/**
 * Does `url` point somewhere other than the endpoint `preset` vouches for?
 *
 * Shared by the PRIMARY provider (resolveProfile) and each BINDING
 * (resolveRoutes) so the two cannot drift — a free-provider exemption that held
 * on one path and not the other would be worse than either rule alone.
 *
 * Compares HOST and SCHEME:
 *  - host, not hostname: host carries the port, and a different port is a
 *    different service (ollama :11434 vs vllm :8000 would collapse under
 *    hostname). An explicit default port is safe — WHATWG elides it, so
 *    `https://api.b.ai:443`.host === `api.b.ai`. Do not "simplify" to hostname.
 *  - scheme: host alone would let `http://api.b.ai` keep a free-provider claim
 *    while shipping a real bearer token in cleartext.
 *
 * Unparseable (or a preset with no default URL) ⟹ TRUE. A claim we cannot verify
 * must fail closed. Never throws: resolveProfile runs at boot on EVERY command,
 * so throwing here would brick `settings show` — the command someone runs to
 * diagnose the very profile that is broken.
 */
export function overridesEndpoint(url: string | undefined, preset: ApiPreset): boolean {
  if (!url) return false;
  try {
    const want = new URL(preset.defaultUrl);
    const got = new URL(url);
    return got.host !== want.host || got.protocol !== want.protocol;
  } catch {
    return true;
  }
}

export function coerceProviderBindings(raw: unknown): ProviderBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderBinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.api !== "string" || !e.api) continue;
    const models = Array.isArray(e.models)
      ? e.models.filter((m): m is string => typeof m === "string" && m.length > 0)
      : [];
    // D6a: an ABSENT `models` key is the catch-all group ("serves every model
    // no other group claims") — it must survive coercion or the catch-all
    // silently disappears from resolution. A PRESENT-but-empty or malformed
    // `models` still drops: E-P4 reports the empty list, and a non-list has
    // nothing to claim. YAML null (`models:` with nothing after) means absent,
    // per the codebase-wide null-is-absent precedent.
    const modelsKeyAbsent = e.models === undefined || e.models === null;
    if (models.length === 0 && !modelsKeyAbsent) continue;
    // D6a: the explicit group name must SURVIVE coercion — deriveGroupNames
    // reads it, and dropping it here would rename every named group after
    // its api and desync the E-P1 name checks from resolution.
    out.push({
      api: e.api,
      // Catch-all groups keep `models` undefined (not []): resolveGroups reads
      // `binding.models ?? []` either way, but the distinction documents WHY
      // the group has no list.
      ...(modelsKeyAbsent ? {} : { models }),
      ...(typeof e.name === "string" && e.name.length > 0 ? { name: e.name } : {}),
      ...(typeof e.api_key === "string" ? { api_key: e.api_key } : {}),
      ...(typeof e.url === "string" ? { url: e.url } : {}),
    });
  }
  return out;
}

/**
 * Merge each provider binding with its preset and resolve its env refs, then
 * index every model to its route.
 *
 * TWO DROP PATHS, both silent HERE by construction and both now REJECTED at
 * validate time (see validateProfile's `providers` block). They are listed
 * separately because they fail differently, and collapsing them hides that:
 *
 *  1. Unknown preset (`if (!preset) continue`). The binding SURVIVED coercion,
 *     so its `models` list exists.
 *  2. Malformed binding, dropped by coerceProviderBindings (e.g. `models:`
 *     written as a scalar instead of a list). Nothing survives, so there is no
 *     model list left to inspect — which is exactly why validation reads the RAW
 *     `profile.providers` and not the coerced output.
 *
 * Untouched, both end the same way: the models are absent from the index, so
 * they fall through to the PRIMARY provider and are sent with the PRIMARY's key
 * — "that provider is never used" rather than an error. This function stays
 * silent; the gate is validateProfile, with tests behind it, because a comment
 * is not a gate.
 *
 * First binding wins on a duplicate model id — see ProviderBinding.models.
 */
/** Derive a ResolvedRoute's keyRef WITHOUT the secret (D6a, design 2.1): the
 *  env-var name for a `$VAR` ref (the config's own spelling — the secret
 *  never enters the route), `sha256:<12 hex>` of a literal key, or `none`
 *  for an unauthenticated local endpoint. D4 keys per-credential dead-marking
 *  on `url + keyRef`; error text never needs the secret itself. */
export function routeKeyRef(rawAuthRef: string | undefined, authToken: string): string {
  if (authToken.length === 0) return "none";
  if (rawAuthRef && rawAuthRef.startsWith("$")) return rawAuthRef;
  return `sha256:${createHash("sha256").update(authToken).digest("hex").slice(0, 12)}`;
}

/** Derive the group names for one profile's bindings (D6a, design 2.1): an
 *  explicit `name` wins; otherwise the name comes from `api`, with `-2`,
 *  `-3`, … appended on repeats within the profile, in group order. Group #0
 *  is named after its `api` and cannot be renamed. Exported for the E-P1
 *  collision check in validateProfile — the validator must refuse a user
 *  name that would collide with a DERIVED name, and it needs the same
 *  derivation to know what those are. */
export function deriveGroupNames(
  primaryApi: string,
  bindings: readonly ProviderBinding[],
): { primary: string; groups: string[] } {
  const used = new Set<string>();
  const claim = (base: string): string => {
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    return name;
  };
  const primary = claim(primaryApi);
  // A no-api group derives its name from the EXPLICIT name (E-P2 makes `name`
  // required when `api` is absent); one that somehow has neither falls back to
  // a placeholder so the resolver still yields a stable, unique name — the
  // validator reports the real defect separately.
  const groups = bindings.map((b) => (b.name ? claim(b.name) : claim(b.api ?? "unnamed")));
  return { primary, groups };
}

/**
 * Resolve a profile's provider GROUPS (D6a, design 2.1 — replaces D0's
 * resolveRoutes): group #0 is the profile-level `api`/`url`/`api_key`
 * (`primary: true`), then `providers[]`, then `detected_providers[]`
 * (local's generated routes — a second `providers`-shaped key on the same
 * profile, never written by `providers[]` users). Every group gets a name
 * (explicit, else derived with `-2`/`-3` on repeats) and a keyRef (no
 * secret). `routesFor(id)` returns EVERY group whose `models` lists the id,
 * in group order; no group lists it → the catch-all groups (#0 plus every
 * group without `models:`), in order — the D6a replacement for D0's
 * first-binding-wins `routeByModel`, which could not represent two accounts
 * serving one id.
 *
 * Never throws, and never refuses: malformed bindings are DROPPED here and
 * rejected separately by validateProfile's `providers` block (see the two
 * drop paths below) — this runs at boot on EVERY command, and a crash here
 * would brick `settings show`.
 */
export function resolveGroups(
  profile: Profile,
): { routes: ResolvedRoute[]; routesFor: (modelId: string) => ResolvedRoute[]; routeForModel: (modelId: string) => ResolvedRoute | null } {
  const bindings = coerceProviderBindings(profile.providers);
  const detected = coerceProviderBindings(
    (profile as Profile & { detected_providers?: unknown }).detected_providers,
  );
  const { primary: primaryName, groups: groupNames } = deriveGroupNames(profile.api, [...bindings, ...detected]);

  const primaryPreset = API_PRESETS[profile.api];
  const routes: ResolvedRoute[] = [];
  if (primaryPreset) {
    const rawAuth = primaryPreset.isLocal
      ? profile.api_token || profile.api_key || primaryPreset.defaultAuthEnv
      : profile.api_key || primaryPreset.defaultAuthEnv;
    const url = profile.url || primaryPreset.defaultUrl;
    const authToken = resolveEnvValue(rawAuth);
    routes.push({
      name: primaryName,
      api: profile.api,
      protocol: primaryPreset.protocol,
      url,
      authToken,
      keyRef: routeKeyRef(rawAuth, authToken),
      primary: true,
      isLocal: primaryPreset.isLocal && isLocalUrl(url),
      isFreeProvider: primaryPreset.isFreeProvider === true && !overridesEndpoint(profile.url, primaryPreset),
      models: [],
    });
  }
  // bindings + detected share the name space from deriveGroupNames above;
  // groupNames[i] is the name of all[i] (the primary's name is returned
  // separately and already set on the group #0 push).
  const all: ProviderBinding[] = [...bindings, ...detected];
  all.forEach((binding, i) => {
    const api = binding.api;
    const preset = api ? API_PRESETS[api] : undefined;
    if (!api || !preset) return; // a no-api group has no preset to resolve; validateProfile's E-P2 owns that case
    // Does this binding point somewhere OTHER than the preset's own host?
    //
    // Compare HOSTS, not mere presence of the key. `!binding.url` was the first
    // attempt and it is wrong in both directions: `url: ""` is falsy so it KEPT
    // the exemption, while `url: "https://api.b.ai"` — the preset's own default,
    // written out explicitly, which config linters and generated YAML do
    // routinely — VOIDED it, silently refusing a correctly configured profile.
    //
    // Unparseable URL (or a preset with no default) voids the exemption: a free
    // claim we cannot verify must fail closed. The try/catch is load-bearing
    // because resolveProfile runs at boot on EVERY command, so letting `new URL`
    // throw here would brick `settings show` — the one command someone runs to
    // diagnose the very profile that is broken.
    const url = binding.url || preset.defaultUrl;
    const rawAuth = binding.api_key || preset.defaultAuthEnv;
    const authToken = resolveEnvValue(rawAuth);
    routes.push({
      name: groupNames[i],
      api,
      protocol: preset.protocol,
      url,
      authToken,
      keyRef: routeKeyRef(rawAuth, authToken),
      // `preset.isLocal AND the URL is actually local`. The preset flag alone is
      // a claim about the DEFAULT endpoint, and `url:` can move a local preset
      // anywhere — `generic-local` exists precisely to be pointed at an
      // arbitrary host. Without the second half, `api: ollama-local, url:
      // https://ollama.example.com` reads as non-billable and free_only waves
      // every model through to a remote server.
      //
      // isLocalUrl (not overridesEndpoint) is the right test here: it asks "is
      // this address local/private?", which is the actual question. Using
      // overridesEndpoint would break generic-local outright — its defaultUrl is
      // "", so ANY url would count as an override and mark it billable.
      isLocal: preset.isLocal && isLocalUrl(url),
      // Redirecting the endpoint VOIDS the free-provider claim — see
      // overridesEndpoint, which the PRIMARY provider path now shares, so the
      // two cannot disagree.
      isFreeProvider: preset.isFreeProvider === true && !overridesEndpoint(binding.url, preset),
      models: binding.models ?? [],
    });
  });

  const catchAlls = routes.filter((r) => !r.primary && r.models.length === 0);
  const routesFor = (modelId: string): ResolvedRoute[] => {
    const named = routes.filter((r) => r.models.includes(modelId));
    if (named.length > 0) return named;
    // Catch-all semantics (design 2.1): no group claims the id → group #0
    // plus every `models:`-less group, in group order. A profile with no
    // resolvable primary (#0 absent) falls back to the catch-alls alone.
    const primary = routes.filter((r) => r.primary);
    return [...primary, ...catchAlls];
  };
  return {
    routes,
    routesFor,
    routeForModel: (modelId: string) => routesFor(modelId)[0] ?? null,
  };
}

/**
 * Resolve a profile's reserved ensemble slots (D5, design 2.1): at most 2
 * entries, in written order. A slot naming a `provider:` group carries THAT
 * group alone; one without carries routesFor(model) — every group that
 * serves the id, in group order. Malformed entries are DROPPED here (never
 * throws — this runs at boot on every command via resolveProfile; the real
 * shape errors are validateProfile's E-E3/E-E4/E-E5, reported separately,
 * exactly the split resolveGroups uses for malformed bindings).
 */
function resolveReservedSlots(profile: Profile): { reservedSlots: ResolvedReservedSlot[] } {
  const raw = (profile.ensemble as ProfileEnsemble | undefined)?.reserved;
  if (!Array.isArray(raw)) return { reservedSlots: [] };
  const { routes, routesFor } = resolveGroups(profile);
  const reservedSlots: ResolvedReservedSlot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || typeof (entry as ProfileReservedSlot).model !== "string") continue;
    const modelId = (entry as ProfileReservedSlot).model;
    const provider = (entry as ProfileReservedSlot).provider;
    if (typeof provider === "string" && provider.length > 0) {
      const named = routes.filter((r) => r.name === provider);
      if (named.length === 0) continue; // E-E4 refuses; the resolver never throws
      reservedSlots.push({ modelId, routes: named });
    } else {
      reservedSlots.push({ modelId, routes: routesFor(modelId) });
    }
  }
  return { reservedSlots };
}

/**
 * Resolve a profile to concrete connection values.
 * Merges profile overrides with preset defaults and resolves env var refs.
 */
export function resolveProfile(
  name: string,
  profile: Profile,
): ResolvedProfile {
  const preset = API_PRESETS[profile.api];
  if (!preset) {
    throw new Error(`Unknown api preset '${profile.api}'`);
  }

  // Auth: api_token preferred for local presets, api_key accepted as fallback;
  // api_key is the canonical field for remote presets.
  const rawAuth = preset.isLocal
    ? profile.api_token || profile.api_key || preset.defaultAuthEnv
    : profile.api_key || preset.defaultAuthEnv;

  // Free-only (TRDD-8b6b3646): the free_models pool is the source of truth — the
  // top three become model / secondModel / thirdModel, so the existing ensemble
  // machinery (getEnsembleModels, which reads these) runs the free top-3 with no
  // hot-path change. The configured model/second_model/third_model are ignored.
  // (Benchmark/requirements filtering of the pool happens downstream in
  // getEnsembleModels, where the catalog is available.)
  const freeOnly = profile.free_only === true;
  // TRDD-C9SXX7HO: `mode: "local"` also reads its own free_models pool
  // unconditionally of free_only — buildLocalProfileSection (local-profile.ts)
  // writes it as the walkable fallback chain (D1b), and this is the ONE place
  // ResolvedProfile.freeModels is populated, so local's own chain-walkers
  // (profileChain, resolveModelChain — both keyed on freeOnly) need this
  // widened condition to ever see it.
  const freeModels = freeOnly || profile.mode === "local" ? coerceFreeModels(profile.free_models) : [];
  const model = freeOnly ? (freeModels[0] ?? "") : profile.model;
  const secondModel = freeOnly
    ? (freeModels[1] ?? "")
    : profile.second_model || "";
  const thirdModel = freeOnly
    ? (freeModels[2] ?? "")
    : profile.third_model || "";

  const dynamic = isDynamicProfileName(name);
  const paidModels = Array.isArray(profile.paid_models)
    ? profile.paid_models.filter((m): m is string => typeof m === "string")
    : [];
  // D3b provenance (TRDD-FDI9NYAS): a STATIC profile's manual set is exactly
  // what chainModelIds already computes as "everything this profile would
  // send" (model/second/third/free/paid/tool_models + explicit hq id) —
  // reusing it keeps the manual-set definition and the "what does this
  // profile send" definition from ever disagreeing. A DYNAMIC profile's
  // manual set is its reserved-slot ids (D5) plus an explicit
  // high_quality_model.id — the slots are the user's own hand-listed models,
  // exempt from the benchmark/price gates by the same provenance rule (the
  // b.ai benchmark-exemption decision rides on this: reserved ids are manual,
  // and the D3b gate already skips manual models — no extra hook).
  const { reservedSlots } = resolveReservedSlots(profile);
  const manualModels: ReadonlySet<string> = dynamic
    ? new Set([...reservedSlots.map((s) => s.modelId), ...(profile.high_quality_model?.id ? [profile.high_quality_model.id] : [])])
    : new Set(chainModelIds(name, profile));

  return {
    name,
    profileType: inferProfileType(name, profile),
    mode: profile.mode,
    protocol: preset.protocol,
    url: profile.url || preset.defaultUrl,
    model,
    authToken: resolveEnvValue(rawAuth),
    secondModel,
    thirdModel,
    freeOnly,
    freeModels,
    // Under STATIC free_only the free pool overrides EVERY per-tool choice
    // (TRDD-97ef8b63): blanked to {} so resolveModelForTool, get_settings, and
    // drift all agree that free models win. Under DYNAMIC free_only ("free"),
    // resolveModelForTool no longer short-circuits on freeOnly (P1 addendum
    // item 4), so its tool_models overrides must stay populated — blanking
    // them here would make T-P1-1 unreachable regardless of that fix.
    // Row 79: reads the ONE shared predicate (blanksToolModelsUnderFreeOnly)
    // chainModelIds now also gates its tool_models counting on, so the gate
    // and this resolver can never disagree about which profile shapes have
    // tool_models blanked.
    toolModels: blanksToolModelsUnderFreeOnly(freeOnly, dynamic) ? {} : coerceToolModels(profile.tool_models),
    timeout: profile.timeout ?? preset.defaultTimeout,
    contextWindow: profile.context_window ?? preset.defaultContextWindow,
    requestOptions: coerceRequestOptions(profile.request_options),
    server: profile.server !== "managed" ? null : profile.api === "locals-local" ? "locals" : "llama",
    appName: profile.app_name ?? preset.defaultAppName,
    httpReferer: profile.http_referer ?? preset.defaultHttpReferer,
    // High-quality-scan model (TRDD-DBUSM55E): always resolved (defaults filled),
    // independent of mode — the high_quality_scan tool reads it; other tools ignore it.
    highQualityModel: resolveHighQualityModel(profile.high_quality_model),
    // Same rule as a route's isLocal (see resolveRoutes): the preset flag is a
    // claim about the DEFAULT endpoint, and `url:` can move a local preset to a
    // remote host, where it can absolutely bill.
    isLocal: preset.isLocal && isLocalUrl(profile.url || preset.defaultUrl),
    // The PRIMARY provider's free claim is voided by a host/scheme override for
    // exactly the reason the per-binding one is (see resolveRoutes) — the claim
    // is attached to a preset NAME, so redirecting the endpoint carries it
    // somewhere the preset never vouched for. This is the primary-path half of
    // that guard, which the earlier binding-only fix did NOT cover.
    isFreeProvider: preset.isFreeProvider === true && !overridesEndpoint(profile.url, preset),
    dynamic,
    paidModels,
    manualModels,
    reservedSlots,
    // Spread LAST deliberately: the computed routes must win over any key of the
    // same name added above. tsc flags a duplicate literal key, so a collision
    // cannot be silent.
    ...resolveGroups(profile),
  };
}

// ── Profile display (settings-rename: `settings show` / `settings profiles`) ──
// Single source of truth for both the `profile --show <name>` formatting and
// `settings show`'s "print the active profile's resolved settings" requirement
// — never duplicate this shape in two places.

/** One resolved profile's full detail, as display lines (no trailing newline). */
export function formatResolvedProfileLines(
  resolved: ResolvedProfile,
  profile: Profile,
  isActive: boolean,
): string[] {
  const lines: string[] = [
    `Profile: ${resolved.name}${isActive ? " (ACTIVE)" : ""}`,
    `Mode: ${resolved.mode}`,
    `Backend: ${profile.api} (${resolved.protocol})`,
    `URL: ${resolved.url}`,
  ];
  if (resolved.freeOnly) {
    lines.push(`Free only: true`);
    lines.push(`Free pool: ${resolved.freeModels.join(", ") || "(empty)"}`);
  } else {
    // fix-queue 89: `settings show`/`discover` (via formatActiveProfileSummary,
    // this helper's only caller) printed PLACEHOLDER_MODEL_ID verbatim for an
    // unpopulated dynamic (paid) section -- the internal sentinel config.ts
    // uses for "profile never populated", never meant to reach the user. Same
    // population-state wording index.ts's writeBootBanner/`settings status`
    // use, so every surface agrees.
    lines.push(
      `Model: ${
        resolved.model === PLACEHOLDER_MODEL_ID
          ? `${resolved.name}: not benchmarked yet`
          : resolved.model
      }`,
    );
    if (resolved.secondModel) lines.push(`Second model: ${resolved.secondModel}`);
    if (resolved.thirdModel) lines.push(`Third model: ${resolved.thirdModel}`);
  }
  if (resolved.routes.length > 1) {
    // D6a: a multi-group profile lists its groups (name, preset, endpoint) —
    // group #0 is the primary the Backend line already shows, so only 1..n.
    lines.push(
      `Groups: ${resolved.routes
        .slice(1)
        .map((r) => `${r.name} (${r.api})`)
        .join(", ")}`,
    );
  }
  // D5: the profile's reserved ensemble slots (user-owned `ensemble.reserved`),
  // at most 2 — shown so `settings show` displays the same members the runtime
  // will serve for ensemble commands.
  if (resolved.reservedSlots && resolved.reservedSlots.length > 0) {
    lines.push(
      `Reserved ensemble: ${resolved.reservedSlots
        .map((s) => s.modelId)
        .join(", ")}`,
    );
  }
  if (Object.keys(resolved.toolModels).length > 0) {
    lines.push(
      `Per-tool overrides: ${Object.entries(resolved.toolModels)
        .map(([tool, m]) => `${tool}=${m}`)
        .join(", ")}`,
    );
  }
  lines.push(`Timeout: ${resolved.timeout}s`);
  lines.push(`Context window: ${resolved.contextWindow.toLocaleString()} tokens`);
  lines.push(
    `Auth: ${resolved.authToken ? `set (${resolved.authToken.length} chars)` : "NOT SET"}`,
  );
  return lines;
}

/**
 * `settings show` (TRDD settings-rename, requirement B): the EFFECTIVE
 * profiles resolved configuration, ready to print to stdout. Reads
 * settings.yaml fresh (via getSettingsPath()/loadSettings(), both
 * env-var-aware) instead of relying on any module-scoped cache, so it is
 * independently unit-testable and reflects the file as it is on disk right
 * now. Read-only -- never writes settings.yaml. Never throws: every failure
 * mode (file missing, unparseable, effective profile absent, resolution
 * error) returns a plain-text message instead.
 *
 * `effectiveName`/`source` let the caller (index.ts, which already knows
 * what THIS invocation resolved via overrideActiveProfile/--profile) report
 * the real in-memory selection instead of re-deriving it from a fresh disk
 * read -- effectiveProfileName(settings) is only the fallback for a direct
 * caller (e.g. a test) that has no live invocation state to hand in.
 */
export function formatActiveProfileSummary(
  effectiveName?: string,
  source: "flag" | "default" = "default",
): string {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    return (
      `No settings file found at ${settingsPath}.\n` +
      `It is created automatically the first time any llm-ext command runs.`
    );
  }
  const settings = loadSettings();
  if (!settings) {
    return `Failed to read/parse ${settingsPath}. Check YAML syntax.`;
  }
  const name = effectiveName ?? effectiveProfileName(settings);
  const profile = settings.profiles[name];
  // WHY (TRDD-G6XT3AY9): `active:` is a live selector again, so "source" now
  // has three real answers, not two -- the deprecation note that used to sit
  // here is gone because it would now be describing the key it just used.
  const sourceLabel =
    source === "flag" ? "--profile" : settings.active !== undefined ? "active:" : "built-in default";
  const header = `Effective profile: ${name} (source: ${sourceLabel})`;
  if (!profile) {
    return [
      header,
      `Effective profile '${name}' not found in ${settingsPath}.`,
      `Available profiles: ${Object.keys(settings.profiles).join(", ") || "(none)"}`,
    ].join("\n");
  }
  try {
    const resolved = resolveProfile(name, profile);
    return [header, ...formatResolvedProfileLines(resolved, profile, true)].join("\n");
  } catch (err) {
    return [
      header,
      `Failed to resolve effective profile '${name}': ${err instanceof Error ? err.message : String(err)}`,
    ].join("\n");
  }
}

/**
 * `settings profiles` / `list_profiles` (TRDD settings-rename, requirement C):
 * every profile defined in settings.yaml, one line each, with a `*` marker on
 * the EFFECTIVE one for this invocation (design (e) site 4 -- no longer
 * `settings.active`, which is inert). Reads settings.yaml only -- never
 * mutates it. Never throws: a missing file is reported plainly instead (it
 * is created automatically the first time any llm-ext command runs).
 */
export function formatProfilesList(effectiveName?: string): string {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    return (
      `No settings file found at ${settingsPath}.\n` +
      `It is created automatically the first time any llm-ext command runs.`
    );
  }
  const settings = loadSettings();
  if (!settings) {
    return `Failed to read/parse ${settingsPath}. Check YAML syntax.`;
  }
  const profileNames = Object.keys(settings.profiles);
  if (profileNames.length === 0) {
    return (
      `No profiles defined in ${settingsPath}.\n` +
      `Settings file is present but its 'profiles' map is empty.`
    );
  }
  const name = effectiveName ?? effectiveProfileName(settings);
  const lines = [`Settings file: ${settingsPath}`, ""];
  let anyUnpopulated = false;
  for (const profileName of profileNames) {
    const profile = settings.profiles[profileName];
    const marker = profileName === name ? "* " : "  ";
    const owner = isDynamicProfileName(profileName) ? " [machine-managed]" : "";

    // An unpopulated default profile must NOT print its sentinel model id.
    // `placeholder/unpopulated-default-profile` looks like a broken config the
    // user is expected to fix by hand, when in fact it is a normal pre-benchmark
    // state that resolves itself — so say what it actually means.
    let modelSummary: string;
    if (isUnpopulatedDefaultProfile(profileName, profile)) {
      anyUnpopulated = true;
      // TRDD-C9SXX7HO (fix-queue 83 review): `local` is SCANNED, not
      // benchmarked — "not benchmarked yet" would be a category error for a
      // profile that never ran a benchmark in the first place.
      modelSummary =
        profileName === "local"
          ? "no local endpoint detected yet — populates once one is found"
          : "not benchmarked yet — populates on first use";
    } else if (profile.free_only) {
      modelSummary = `free_only (${(profile.free_models ?? []).length} models)`;
    } else {
      modelSummary = [profile.model, profile.second_model, profile.third_model]
        .filter(Boolean)
        .join(", ");
    }

    // WHY the type and not `mode` for a classifier or scouting profile: a classifier has no `mode` (it printed "undefined"), and the type is what tells the user which commands accept it.
    const kind = profile["profile-type"] === "classifier" || profile["profile-type"] === "scouting" ? profile["profile-type"] : profile.mode;
    lines.push(
      `${marker}${profileName}${owner} — ${kind} / ${profile.api} — ${modelSummary}`,
    );
  }
  lines.push("", "* = effective profile (this invocation). Use --show <name> for full resolved detail.");
  if (profileNames.some((n) => isDynamicProfileName(n))) {
    lines.push(
      `[machine-managed] = ${DYNAMIC_PROFILE_NAMES.join(" / ")}.`,
      "These pick and refresh their own models from benchmark results; every other",
      "profile is yours and is never modified.",
    );
  }
  if (anyUnpopulated) {
    lines.push(
      "",
      "Unpopulated profiles are expected on a fresh install: 'free' works immediately from a",
      "bundled seed pool while it benchmarks, and the paid profiles populate on first use once",
      "allow_paid_models is true.",
    );
  }
  return lines.join("\n");
}

/**
 * The model chain a tool walks for one call, head first: `resolveModelForTool`
 * IS `resolveModelChain(...)[0]` (P1 addendum item 4).
 *
 *  - STATIC profile (every profile except the two DYNAMIC names) → exactly
 *    `[head]`, where head is `toolModels[tool] || resolved.model` — no
 *    fallback pool, ever; a static profile is used exactly as written.
 *  - DYNAMIC profile ("free"/"paid") → `[head, ...pool]`, where pool is
 *    `freeModels` (freeOnly) or `paidModels` (otherwise), excluding the head
 *    and, when `validated` is non-empty, filtered to ids that set contains.
 *
 * `validated` is a parameter rather than an import of
 * benchmark/validated.ts::validatedModelsForTool: that module imports
 * config.ts for getConfigDir, so importing it back here would close a cycle.
 * The empty-set default means "no filtering" (the P1 addendum's explicit
 * fallback), so a caller with no validated set yet gets the unfiltered chain
 * instead of a crash or an import error.
 */
export function resolveModelChain(
  resolved: ResolvedProfile,
  tool: string,
  validated: Set<string> = new Set(),
): string[] {
  const head = resolved.toolModels[tool] || resolved.model;
  if (!resolved.dynamic) return [head]; // STATIC: exactly what is written
  // TRDD-C9SXX7HO: `local` has no `paidModels` (nothing populates it — it has
  // no catalog, no price) — its own fallback chain lives in `freeModels`
  // (see resolveProfile's widened condition above), same field free_only
  // already uses, so it takes the SAME arm rather than a third one here.
  const pool =
    resolved.freeOnly || resolved.mode === "local" ? resolved.freeModels : (resolved.paidModels ?? []);
  const rest = pool.filter(
    (id) => id !== head && (validated.size === 0 || validated.has(id)),
  );
  return [head, ...rest]; // DYNAMIC: head, then ranked fallbacks
}

/**
 * Pick the model for `tool` under `resolved`, per the resolution order:
 *   1. The profile's per-tool override `tool_models[tool]`, when set non-empty.
 *   2. The caller-supplied `fallback` (a tool's OWN default, e.g. security_scan's
 *      DEFAULT_MODEL) — pass `undefined` to fall through to step 3.
 *   3. The profile's main `model`.
 *
 * Back-compat: a profile with no `tool_models` (the common case) and a caller
 * that passes no `fallback` always returns `resolved.model` — identical to the
 * pre-#97 behavior. A model assigned via `tool_models` is NEVER auto-selected;
 * the operator sets it deliberately (and SHOULD confirm it passes that tool's
 * benchmark — see the security-triage benchmark).
 *
 * free_only override (TRDD-97ef8b63): when the profile is STATIC free_only,
 * the free pool overrides EVERY per-tool choice — `tool_models` AND any caller
 * `fallback` are ignored, and the top free model (`resolved.model` =
 * free_models[0]) wins for single-model resolution. This is the "free models
 * override every customized choice of the tools" guarantee; combined with the
 * resolveConnection chokepoint guard it makes a paid model unreachable under
 * free_only.
 *
 * DYNAMIC profiles (P1 addendum item 4) lose that short-circuit: the built-in
 * "free" profile keeps its per-tool choices, delegating to resolveModelChain's
 * head so the two never drift apart. `fallback` has no meaning for a dynamic
 * profile (its own pool IS the fallback chain — see resolveModelChain), so it
 * is not consulted there.
 */
export function resolveModelForTool(
  resolved: ResolvedProfile,
  tool: string,
  fallback?: string,
): string {
  if (resolved.freeOnly && !resolved.dynamic) return resolved.model; // STATIC free_only: unchanged
  if (resolved.dynamic) return resolveModelChain(resolved, tool)[0];
  const override = resolved.toolModels[tool];
  if (typeof override === "string" && override.length > 0) return override;
  if (fallback !== undefined) return fallback;
  return resolved.model;
}

// ── Free-pool seed list (TRDD-f1510055) ────────────────────────────────────
// Runtime "never dark" fallback pool: used when a remote profile has no
// configured `free_models` of its own, so free_only / cost-safety code paths
// always have a usable free pool to fall back to. This list is NOT copied
// into generated settings.yaml (see renderDefaultSettingsYaml() above) —
// the two are independent now; keep this comment free of any template
// cross-reference.
//
// Selection criteria (curated 2026-05-27): OpenRouter `:free` tier models that
//   - meet the per-tool requirements floor (context >= 128K, max_output >= 8K,
//     structured_outputs OR response_format, reasoning OR include_reasoning)
//   - cover a spread of providers (no single-provider dependency)
//   - have non-zero uptime at curation time
//
// This is the SEED that the auto-benchmark trigger scores when the user first
// activates `free_only: true` with no cached `:free` benchmark results. The
// trigger feeds each id into the keyword + security-triage benchmarks; passers
// become the active ensemble (top-N by meanF1 + cost asc).
export const FREE_POOL_SEED: readonly string[] = Object.freeze([
  "poolside/laguna-m.1:free",
  "deepseek/deepseek-v4-flash:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "arcee-ai/trinity-large-thinking:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "minimax/minimax-m2.5:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
  "qwen/qwen3-coder:free",
  "z-ai/glm-4.5-air:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
]);

// ── Process-wide free_only flag (TRDD-97ef8b63) ────────────────────────────
// The pure subsystem modules (security_scan/judge.ts, mass_scouting/scout.ts,
// benchmark/runner.ts) each fetch OpenRouter directly and cannot import
// index.ts's `activeResolved` (cycle + they are intentionally pure). They read
// the active free_only state through this one accessor instead. The owner of the
// active profile (index.ts on load/reload; the standalone CLIs in their main())
// calls setActiveFreeOnly() right where it resolves the profile, so there is a
// SINGLE write point per process and the flag never drifts from the live profile.
//
// TRDD-FDI9NYAS D3c-2 (C4d): before the first setActiveFreeOnly() the state is
// UNSET, not "paid allowed" — the old `false` default made any spend-site read
// that raced ahead of settings load fail OPEN on a free_only machine. Unset now
// reads as free_only (fail closed): every publisher writes a concrete boolean,
// so only never-published processes (tests, a spend site reached before its
// entrypoint's publish) see the closed posture.
let _activeFreeOnly: boolean | undefined = undefined;

/** Record whether the active profile is free_only. Call wherever the active
 *  profile is resolved (index.ts load/reload; CLI main()). */
export function setActiveFreeOnly(freeOnly: boolean): void {
  _activeFreeOnly = freeOnly;
}

/** True iff the active profile is free_only. Read by the subsystem spend sites.
 *  UNSET (no setActiveFreeOnly yet) reads TRUE — fail closed. */
export function getActiveFreeOnly(): boolean {
  return _activeFreeOnly ?? true;
}

/** Test-only: return the flag to its UNSET posture (fail-closed). */
export function resetActiveFreeOnlyForTests(): void {
  _activeFreeOnly = undefined;
}

// Mirrors connection.ts's routed-model billable derivation (see resolveConnection's
// `billable` comment above `assertFreeOnlyModel`) so callers outside the
// ProviderDeps chain — mass_scouting/cli.ts, scout.ts, security_scan/judge.ts —
// don't reimplement the rule and drift from it. A routed model is judged by ITS
// OWN route's billability; everything else falls back to the primary backend's.
export function billableForRoute(
  route: ResolvedRoute | null | undefined,
  backendBillable: boolean,
): boolean {
  return route ? !route.isLocal && !route.isFreeProvider : backendBillable;
}

// Active routing state, mirrored from _activeFreeOnly (see setActiveFreeOnly
// above): index.ts calls setActiveRouting() wherever it resolves the active
// profile, so the pure subsystem spend sites (judge/scout/mass_scout CLI) can
// derive a model's real billability without importing index.ts or duplicating
// resolveConnection's route-vs-backend logic. D6a: the state is the profile's
// routesFor (every serving group), not D0's first-binding-wins map.
let _activeRoutesFor: ((modelId: string) => ResolvedRoute[]) | null = null;
let _activeBackendBillable = false;

/** Record the active profile's route lookup + primary backend billability. Call
 *  wherever the active profile is resolved (mirrors setActiveFreeOnly). */
export function setActiveRouting(
  routesFor: (modelId: string) => ResolvedRoute[],
  backendBillable: boolean,
): void {
  _activeRoutesFor = routesFor;
  _activeBackendBillable = backendBillable;
}

/** True iff a send to `model` under the active profile can bill — route-aware,
 *  same derivation resolveConnection uses. D6a "ANY serving group billable"
 *  (design 2.1): one billable group among several serving the same id makes
 *  the id billable — fails closed. Defaults to the primary backend's
 *  billability when the model isn't routed (no serving group at all — the
 *  primary IS group #0, so this is now only a profile-without-groups case). */
export function getActiveBillableForModel(model: string): boolean {
  const serving = _activeRoutesFor?.(model) ?? [];
  // Reachable only from test stubs (setActiveRouting(() => [], ..)) or an unknown api: resolveGroups always emits group #0 whenever the api preset exists. Kept as the fail-closed default for a profile with no serving group.
  if (serving.length === 0) return _activeBackendBillable;
  return serving.some((r) => !r.isLocal && !r.isFreeProvider);
}

// Master paid-spend switch (Settings.allow_paid_models). The STATE lives in the
// leaf module ./paid-switch.js — NOT here — because benchmark/discover.ts also
// reads it, and config.ts → model-qualification/registry.ts → benchmark/discover.ts
// is already a chain; discover.ts importing config.ts would close that into a
// cycle that leaves TOOL_MODEL_REGISTRY undefined at init. config.ts re-exports so
// its own consumers (index.ts / cli.ts / benchmark/index.ts) import from here as
// before, while discover.ts imports the leaf directly.
export { setAllowPaidModels, getAllowPaidModels } from "./paid-switch.js";

/**
 * The pure force-free decision (USER: free-by-default). Free mode is FORCED for a
 * remote profile whenever paid is globally off. LOCAL profiles are $0/offline and
 * never forced; a null mode (invalid/absent active profile) is not forced because
 * there is nothing to run. Extracted so the rule is unit-testable in isolation;
 * index.ts's recomputeForceFree is the single caller that supplies the live inputs.
 */
export function shouldForceFreeMode(
  allowPaidModels: boolean,
  mode: Mode | null,
  type: ProfileType,
): boolean {
  if (mode === null || mode === "local") return false;
  // D2/PF-01: a real classifier profile has no chat `mode` (validateClassifierProfile rejects it as
  // an unknown key), so a classifier-typed profile WITHOUT a mode is ungated; one that still carries
  // a mode is a relabelled chat profile and stays gated like paid.
  if (type === "classifier" && !mode) return false;
  // D36: free and local types cannot bill, so they stay in free mode whatever the switch says.
  if (PROFILE_TYPE_FIELDS[type].spend === "never-bills") return true;
  // paid, scouting and a relabelled classifier are gated.
  return !allowPaidModels;
}

/**
 * Airtight free_only cost-safety gate (TRDD-97ef8b63). Under a free_only profile
 * EVERY OpenRouter request — across EVERY subsystem (the main chat/scan path via
 * resolveConnection, the security_scan judge, the mass_scout fan-out, the
 * security-triage / keyword benchmark) — MUST target a ':free' model. Each
 * subsystem fetches OpenRouter independently, so each calls this guard right
 * before its request: a non-':free' id throws BEFORE the fetch, so a config or
 * logic leak fails fast instead of billing. No-op when free_only is off, and for
 * local backends (':free' is an OpenRouter concept; local is always $0). PURE —
 * `freeOnly` is passed in (callers pass getActiveFreeOnly(), or an explicit value
 * in tests) so every call site is offline-testable.
 *
 * Lives in config.ts (a leaf module) so index.ts AND the pure subsystem modules
 * (judge.ts, scout.ts, benchmark/runner.ts) can all import it with no cycle.
 */
export function assertFreeOnlyModel(
  freeOnly: boolean,
  // WAS `backendType: "local" | "openrouter"`, and that was the D1 bug. The old
  // parameter conflated two different questions — "which request format?" and
  // "can this endpoint charge me?" — because historically local ⟺ free. That
  // stopped being true the moment a REMOTE preset used `protocol: "openai_api"`
  // (chat-b-ai-remote), which makeBackendFromProfile maps to type "local". A
  // profile could then point a `url:` at any paid host and this guard, reading
  // "local", would wave every model through.
  //
  // The parameter now asks ONLY the question the guard actually needs: can this
  // send cost money? Derived from `preset.isLocal` (a property of the endpoint),
  // never from the request format. The string union is deliberately gone so a
  // stale `"local"` / `"openrouter"` argument is a TYPE ERROR rather than a
  // silently-truthy string — `"local"` passed to a boolean would have been true,
  // i.e. billable, i.e. fail-closed, but only by luck.
  billable: boolean,
  model: string,
  // The model resolved to a provider that cannot bill (ApiPreset.isFreeProvider).
  // Defaults FALSE so every existing 3-arg call site keeps the strict rule — a
  // provider has to opt IN, and a caller that forgets fails safe (refuses).
  isFreeProvider = false,
): void {
  if (freeOnly && isFreeProvider) return;
  if (freeOnly && billable && !model.endsWith(":free")) {
    throw new Error(
      // Names the BILLABLE endpoint generically, not "OpenRouter" — a second
      // paid provider would otherwise be told its model was rejected by a
      // service it never touched. And no "please report it": under a
      // multi-provider profile the usual cause is a `url:` override that voided
      // a provider's free status, which is config, not a bug.
      `free_only cost-safety: refusing to send non-free model '${model}' to a billable endpoint. ` +
        `Under a free_only profile every model MUST be free — either a ':free' id, or served by a ` +
        `provider marked free (which a 'url:' override to a different host voids).`,
    );
  }
}

