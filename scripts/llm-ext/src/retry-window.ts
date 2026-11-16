/**
 * retry-window.ts — the remote retry window and the largest network give-up window it can still contain. A dependency-free leaf
 * module: provider/http.ts (the retry clock), config.ts (the settings key) and cli/timeout-flags.ts (the flag) all read it, and
 * config.ts must not import provider/* (cycle rule).
 */

/** Wall-clock window for retrying one logical call, measured from its FIRST failure. Independent of the settings.yaml request timeout, which bounds a single request, not the whole retry story. */
export const RETRY_DEADLINE_MS = 300_000;

/**
 * The largest network give-up window, whole seconds (TRDD-PN0N4290 finding N3). WHY below the retry window: the shared retry clock
 * closes at RETRY_DEADLINE_MS, so a give-up window of that length or more can never fire first, and the dispatch then ends with no
 * local fallback. One constant for the settings key and the flag, so their ranges can never disagree.
 */
export const NETWORK_GIVE_UP_MAX_S = RETRY_DEADLINE_MS / 1000 - 1;

/** Why the limit exists, for the error of a value above it (one text for the settings key and the flag). */
export const NETWORK_GIVE_UP_MAX_WHY = `the remote retry window closes after ${RETRY_DEADLINE_MS / 1000} s, so a larger give-up window could never fire`;
