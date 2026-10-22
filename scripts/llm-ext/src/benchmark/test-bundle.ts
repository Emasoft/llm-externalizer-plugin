// row99c NIT: shared esbuild bundle-builder for the two suites that spawn a
// fresh benchmark.js bundle from CURRENT source (settings-resolution-
// failfast.test.ts, auto-replace-cli.test.ts) — extracted so a fix to the
// REQUIRE_SHIM/external list lands once instead of drifting between two
// hand-copies of the same ~25 lines.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

// Same shim esbuild.config.mjs injects for the real dist/benchmark.js build:
// bundled CJS deps (yaml) call require() internally, which ESM output has no
// require() for unless we provide one.
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";
import { fileURLToPath as __cjsFileURLToPath } from "node:url";
import { dirname as __cjsDirname } from "node:path";
const require = __cjsCreateRequire(import.meta.url);
const __filename = __cjsFileURLToPath(import.meta.url);
const __dirname = __cjsDirname(__filename);
`;

export interface TestBundle {
  bundleDir: string;
  benchJs: string;
}

/**
 * Build a fresh esbuild bundle of benchmark/index.ts, from CURRENT source, for
 * a test to spawn with `node`. `benchmarkDir` is the caller's own
 * `dirname(fileURLToPath(import.meta.url))` (src/benchmark/) so the bundle
 * always reflects the file the test itself lives next to.
 *
 * realpathSync: on macOS /tmp is a symlink to /private/tmp. index.ts's
 * self-execution guard compares `import.meta.url` (which Node resolves
 * through the symlink) against `pathToFileURL(process.argv[1])` (the raw argv
 * path) — spawning `node /tmp/....js` makes that comparison false and main()
 * silently never runs (no output, exit 0, no error). Resolve the real path
 * once here so argv[1] and import.meta.url agree.
 */
export async function buildBenchmarkTestBundle(benchmarkDir: string, tmpPrefix: string): Promise<TestBundle> {
  const bundleDir = realpathSync(mkdtempSync(join(tmpdir(), tmpPrefix)));
  const benchJs = join(bundleDir, "benchmark.js");
  await build({
    entryPoints: [join(benchmarkDir, "index.ts")],
    outfile: benchJs,
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    sourcemap: false,
    external: [...nodeExternals, "better-sqlite3"],
    banner: { js: REQUIRE_SHIM },
  });
  return { bundleDir, benchJs };
}

export function cleanupTestBundle(bundle: TestBundle): void {
  rmSync(bundle.bundleDir, { recursive: true, force: true });
}
