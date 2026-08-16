// Types for data-dir.mjs.
//
// The implementation is hand-written ESM rather than compiled TypeScript
// because the launcher imports it BEFORE the bundle exists — resolving the
// native-deps directory is the step that makes loading the bundle possible, so
// it cannot depend on a build product. This declaration is what lets the test
// suite (TypeScript) type-check against it.

/** The config root: `~/.llm-externalizer`, or LLM_EXT_CONFIG_DIR when set. */
export function configDir(env?: NodeJS.ProcessEnv): string;

/** The directory the native deps (package.json + node_modules) install into. */
export function nativeDepsDir(env?: NodeJS.ProcessEnv): string;
