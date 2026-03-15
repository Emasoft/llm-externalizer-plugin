#!/bin/bash
# Build the LLM Externalizer MCP server.
# Run this after cloning the plugin repository.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
MCP_DIR="$PLUGIN_ROOT/mcp-server"

if [ ! -f "$MCP_DIR/package.json" ]; then
    echo "Error: mcp-server/package.json not found at $MCP_DIR"
    exit 1
fi

echo "Installing dependencies..."
cd "$MCP_DIR"
npm install --ignore-scripts

echo "Building TypeScript..."
npm run build

echo ""
echo "LLM Externalizer MCP server built successfully."
echo "Output: $MCP_DIR/dist/"
echo ""
echo "The plugin is now ready to use in Claude Code."
