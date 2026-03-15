#!/bin/bash
# Installs the LLM Externalizer statusline for Claude Code.
# Shows model, context usage, MCP token/cost stats, and OpenRouter budget.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
SRC="$PLUGIN_ROOT/mcp-server/statusline.sh"
DEST="$HOME/.claude/statusline.sh"
SETTINGS="$HOME/.claude/settings.json"

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed."
    echo "Install it with: brew install jq (macOS) or apt install jq (Linux)"
    exit 1
fi

if [ ! -f "$SRC" ]; then
    echo "Error: statusline.sh not found in $PLUGIN_ROOT/mcp-server/"
    echo "Run scripts/setup.sh first to ensure all files are in place."
    exit 1
fi

mkdir -p "$HOME/.claude"

if [ -f "$DEST" ]; then
    cp "$DEST" "${DEST}.bak"
    echo "Backed up existing statusline to ${DEST}.bak"
fi

cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "Installed statusline.sh to $DEST"

if [ -f "$SETTINGS" ]; then
    tmp=$(mktemp)
    jq --arg cmd "bash $DEST" '.statusLine = {"type": "command", "command": $cmd}' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
    echo "Updated $SETTINGS with statusLine configuration"
else
    cat > "$SETTINGS" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "bash $DEST"
  }
}
EOF
    echo "Created $SETTINGS with statusLine configuration"
fi

echo ""
echo "Done! Restart Claude Code to see the new status line."
