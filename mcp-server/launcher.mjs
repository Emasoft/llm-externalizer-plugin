// launcher.mjs — pre-flight check before launching the MCP server.
//
// The plugin's MCP server has a native dependency (better-sqlite3) that
// esbuild marks external; it must be present in node_modules at runtime.
// node_modules is installed by the SessionStart hook into
//   ${CLAUDE_PLUGIN_DATA}/node_modules
// and a symlink at
//   ${CLAUDE_PLUGIN_ROOT}/mcp-server/node_modules
// points to it so Node's natural upward-walking module resolution finds
// it. NODE_PATH is intentionally NOT used: empirically (Node 25) it is
// not honored for ESM bare-specifier imports, only for CJS require().
//
// If the SessionStart hook hasn't completed yet (race on first install)
// or failed, this launcher emits a clear error instead of letting Node
// die with a raw "Cannot find package 'better-sqlite3'" stack trace.
//
// Kept as a static .mjs (not bundled) so the dynamic import below is left
// as-is by esbuild and does NOT inline index.js.

try {
  await import("better-sqlite3");
} catch (err) {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? "<CLAUDE_PLUGIN_DATA unset>";
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? "<CLAUDE_PLUGIN_ROOT unset>";
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[llm-externalizer] FATAL: native module 'better-sqlite3' could not be loaded.\n\n` +
      `Cause: the SessionStart hook installs MCP server dependencies into\n` +
      `  ${dataDir}/node_modules\n` +
      `and symlinks them at\n` +
      `  ${pluginRoot}/mcp-server/node_modules\n` +
      `but Node could not resolve better-sqlite3 from there.\n\n` +
      `Try in this order:\n` +
      `  1. Wait ~30 s for the SessionStart hook to finish (first install only).\n` +
      `  2. Restart Claude Code with a cold start (do NOT use --resume).\n` +
      `  3. Manually install the deps and create the symlink:\n` +
      `       mkdir -p "${dataDir}"\n` +
      `       cp "${pluginRoot}/mcp-server/package.json" "${dataDir}/"\n` +
      `       cd "${dataDir}" && npm install --omit=dev --no-ignore-scripts\n` +
      `       ln -sfn "${dataDir}/node_modules" "${pluginRoot}/mcp-server/node_modules"\n\n` +
      `Original error: ${message}\n`,
  );
  process.exit(1);
}

// Hand off to the bundled server. Use a URL-based dynamic import so
// esbuild leaves the path alone if this file ever passes through it.
const indexUrl = new URL("./dist/index.js", import.meta.url).href;
await import(indexUrl);
