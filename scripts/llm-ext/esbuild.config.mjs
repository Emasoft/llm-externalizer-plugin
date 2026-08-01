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

// Externalize native (C++) addons. esbuild can't bundle .node files, and
// any code that does `require('better-sqlite3')` walks node_modules to
// load the prebuilt binding for the current platform. Marking it external
// keeps the bundled file portable across Node versions; the actual
// node_modules/ is installed at runtime by the SessionStart hook into
// ${CLAUDE_PLUGIN_DATA}/node_modules and resolved via NODE_PATH (see
// hooks/hooks.json and scripts/hooks/install-mcp-deps.sh).
const nativeExternals = ["better-sqlite3"];

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
  // No source maps in the shipped bundles: they are debug-only artifacts that
  // bloat the distributed plugin and whose base64 mappings trip CPV's RC-70
  // "obfuscated-decode-near-exec-sink" security heuristic (a false positive on
  // generated maps). Flip back to true locally if you need to debug the bundle.
  sourcemap: false,
  external: [...nodeExternals, ...nativeExternals],
  banner: { js: banner },
};

await Promise.all([
  // The engine. No longer an MCP server — it exports boot() + dispatchCallTool()
  // and is consumed in-process by the CLI below. Still emitted as its own bundle
  // because publish.py's release check asserts this artifact exists; that check
  // moves to dist/llm-ext.js when the canonical-pipeline upgrade lands, and this
  // entry goes with it.
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
  // The user-facing binary: `llm-ext <command>`.
  build({
    ...shared,
    entryPoints: ["src/cli/main.ts"],
    outfile: "dist/llm-ext.js",
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

console.log(
  "Build complete: dist/index.js, dist/llm-ext.js, dist/cli.js, dist/benchmark.js (fully bundled)",
);
