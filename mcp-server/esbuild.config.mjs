import { build } from "esbuild";
import { builtinModules } from "node:module";

// Bundle all dependencies into single self-contained files.
// This is required because Claude Code plugins pull from GitHub
// where node_modules is gitignored — the dist/ must be standalone.

// Externalize Node.js builtins (both "fs" and "node:fs" forms).
const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

// CJS deps like yaml use require("process") internally. In ESM output,
// esbuild wraps these in a __require shim that throws because `require`
// is not available in ESM. Injecting createRequire provides a real
// require() function so bundled CJS code works correctly.
const banner = `import { createRequire as __cjsCreateRequire } from "node:module";
import { fileURLToPath as __cjsFileURLToPath } from "node:url";
import { dirname as __cjsDirname } from "node:path";
const require = __cjsCreateRequire(import.meta.url);
const __filename = __cjsFileURLToPath(import.meta.url);
const __dirname = __cjsDirname(__filename);
`;

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  external: nodeExternals,
  banner: { js: banner },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
  build({
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
  }),
  build({
    ...shared,
    entryPoints: ["src/benchmark/index.ts"],
    outfile: "dist/benchmark.js",
  }),
]);

console.log("Build complete: dist/index.js, dist/cli.js, dist/benchmark.js (fully bundled)");
