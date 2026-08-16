// data-dir.mjs — where the plugin's native deps (better-sqlite3) live.
//
// ONE fixed, user-owned location: `~/.llm-externalizer/native`, the same root
// that already holds settings.yaml and the runtime state sidecars, honouring
// the same LLM_EXT_CONFIG_DIR override as `getConfigDir()` in src/config.ts.
//
// It used to be `<root>/plugins/data/<plugin>-<marketplace>`, DERIVED from the
// launcher's own position inside `<root>/plugins/cache/<marketplace>/<plugin>/
// <version>/…`. That is why headless callers broke: the deps' address was a
// function of an install path they could not see, so a hook-spawned or
// daemon-spawned child (no CLAUDE_PLUGIN_DATA in its environment) had to GUESS
// it — and a wrong guess self-installs a second native module into a directory
// nothing else reads. Anchoring on the plugin cache also made the address
// version-shaped: it moves whenever the plugin layout does.
//
// A fixed home-relative path has no derivation to get wrong, no environment to
// inherit, and survives plugin upgrades, reinstalls and cache wipes.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The config root: `~/.llm-externalizer`, or LLM_EXT_CONFIG_DIR when set.
 *
 * Mirrors `getConfigDir()` in src/config.ts. It is duplicated here rather than
 * imported because this module runs BEFORE the bundle is loadable — resolving
 * the deps directory is the very step that makes importing the bundle possible.
 * Kept to the two lines the two must agree on: same env var, same default.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function configDir(env = process.env) {
  const override = typeof env.LLM_EXT_CONFIG_DIR === "string" ? env.LLM_EXT_CONFIG_DIR.trim() : "";
  return resolve(override || join(homedir(), ".llm-externalizer"));
}

/**
 * The directory the native deps are installed into (it receives package.json
 * and node_modules). A subdirectory, so machine-generated build output never
 * mixes with the user's hand-edited settings.yaml.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function nativeDepsDir(env = process.env) {
  return join(configDir(env), "native");
}
