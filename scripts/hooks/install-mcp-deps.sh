#!/usr/bin/env bash
# install-mcp-deps.sh — install MCP server runtime deps into the persistent
# data directory documented at:
#   https://code.claude.com/docs/en/plugins-reference#persistent-data-directory
#
# Why this exists: `claude plugin install` does NOT run `npm install`.
# v9.4.x introduced a native dependency (better-sqlite3) that esbuild cannot
# bundle, so the dist/ output requires a real node_modules/ alongside it.
# The persistent data dir survives plugin updates, so installing once per
# package.json change avoids reinstalling on every session start.
#
# Triggered from hooks/hooks.json on SessionStart. Idempotent and fast on
# the no-op path: if the bundled package.json matches the cached copy, we
# exit immediately. Tries npm → pnpm → bun → nvm-shimmed npm → corepack-
# shimmed pnpm in that order, with the user's `~/.npmrc ignore-scripts`
# override forced off so native modules can fetch their prebuilt binaries.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-}"

if [[ -z "$PLUGIN_ROOT" || -z "$DATA_DIR" ]]; then
  echo "[llm-externalizer] install-mcp-deps: CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA unset, nothing to do" >&2
  exit 0
fi

SRC_PKG="$PLUGIN_ROOT/mcp-server/package.json"
SRC_LOCK="$PLUGIN_ROOT/mcp-server/package-lock.json"

if [[ ! -f "$SRC_PKG" ]]; then
  echo "[llm-externalizer] install-mcp-deps: $SRC_PKG missing — nothing to install" >&2
  exit 0
fi

# Fast path: bundled package.json matches the cached copy → deps are already
# installed for this manifest, no work to do.
if diff -q "$SRC_PKG" "$DATA_DIR/package.json" >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$DATA_DIR"

# Serialize concurrent SessionStart fires (rare but possible when two Claude
# Code sessions launch simultaneously). mkdir is the portable atomic lock.
LOCK_DIR="$DATA_DIR/.install-lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[llm-externalizer] install-mcp-deps: another install in progress, waiting..." >&2
  for _ in $(seq 1 240); do
    [[ -d "$LOCK_DIR" ]] || break
    sleep 0.5
  done
  # Re-check fast path after wait — peer may have completed for us.
  if diff -q "$SRC_PKG" "$DATA_DIR/package.json" >/dev/null 2>&1; then
    exit 0
  fi
fi
trap '[[ -d "$LOCK_DIR" ]] && rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

cd "$DATA_DIR"
cp -f "$SRC_PKG" .
[[ -f "$SRC_LOCK" ]] && cp -f "$SRC_LOCK" .

# Override npmrc settings that would break native module install.
# better-sqlite3 ships prebuilt binaries via prebuild-install, which runs
# from the package's `install` lifecycle script. If the user's ~/.npmrc has
# `ignore-scripts=true` (a security default in some setups), prebuild-install
# never runs and the gyp fallback is required. Forcing it off lets the fast
# prebuild path succeed.
export NPM_CONFIG_IGNORE_SCRIPTS=false
export NPM_CONFIG_AUDIT=false
export NPM_CONFIG_FUND=false
export NPM_CONFIG_UPDATE_NOTIFIER=false

# Cap the implicit network timeouts so a hung install doesn't block the
# session start past the hook timeout.
export NPM_CONFIG_FETCH_TIMEOUT=120000
export NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=60000

run_install() {
  local label="$1"
  shift
  echo "[llm-externalizer] installing MCP server deps with ${label}..." >&2
  if "$@" >/dev/null 2>&1; then
    echo "[llm-externalizer] deps installed via $label" >&2
    return 0
  fi
  return 1
}

# After a successful install we symlink the data-dir node_modules into the
# plugin root's mcp-server/ so Node's natural upward module-resolution walk
# finds it. Empirically NODE_PATH is NOT honored for ESM bare-specifier
# imports in Node 18+, despite what the official docs example suggests.
# The symlink works regardless of how the importing code is bundled.
link_node_modules() {
  local src="$DATA_DIR/node_modules"
  local dst="$PLUGIN_ROOT/mcp-server/node_modules"
  [[ -d "$src" ]] || return 1
  if [[ -L "$dst" || -e "$dst" ]]; then
    rm -f "$dst" 2>/dev/null || true
    rmdir "$dst" 2>/dev/null || true
  fi
  ln -sfn "$src" "$dst" 2>/dev/null || {
    echo "[llm-externalizer] symlink failed, falling back to bind copy" >&2
    rm -rf "$dst" 2>/dev/null || true
    cp -R "$src" "$dst"
  }
}

# 1. npm (the lockfile path is reproducible and faster, fall back to install
#    when the lockfile is missing or out of sync).
if command -v npm >/dev/null 2>&1; then
  if [[ -f package-lock.json ]] && run_install "npm ci" npm ci --omit=dev; then
    link_node_modules && exit 0
  fi
  if run_install "npm install" npm install --omit=dev --no-package-lock; then
    link_node_modules && exit 0
  fi
fi

# 2. pnpm (`--prod` is the equivalent of npm's --omit=dev).
if command -v pnpm >/dev/null 2>&1; then
  if run_install "pnpm install" pnpm install --prod --prefer-offline; then
    link_node_modules && exit 0
  fi
fi

# 3. bun (production install, but bun's prebuild support is incomplete on
#    some packages — keep as a fallback, not preferred).
if command -v bun >/dev/null 2>&1; then
  if run_install "bun install" bun install --production --no-progress; then
    link_node_modules && exit 0
  fi
fi

# 4. nvm-shimmed npm (the user may have node via nvm only, with npm not on
#    the PATH for non-interactive shells).
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  if (set +u; . "$HOME/.nvm/nvm.sh"; nvm use default >/dev/null 2>&1 && \
        command -v npm >/dev/null 2>&1 && npm install --omit=dev --no-package-lock >/dev/null 2>&1); then
    echo "[llm-externalizer] deps installed via nvm-shimmed npm" >&2
    link_node_modules && exit 0
  fi
fi

# 5. corepack-shimmed pnpm (corepack ships with Node 16.10+ and can install
#    pnpm/yarn shims on demand).
if command -v corepack >/dev/null 2>&1; then
  if corepack enable pnpm >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    if run_install "corepack pnpm" pnpm install --prod --prefer-offline; then
      link_node_modules && exit 0
    fi
  fi
fi

# All installers failed → wipe the cached manifest so the next session
# retries from scratch. Emit a clear error with manual recovery steps.
rm -f "$DATA_DIR/package.json" "$DATA_DIR/package-lock.json"

cat >&2 <<EOF
[llm-externalizer] ERROR: could not install MCP server dependencies into:
  $DATA_DIR

None of npm / pnpm / bun / nvm / corepack worked on this system.

Verify Node.js is installed and on PATH:
  node --version   # should be ≥ 18.0.0
  npm  --version

If Node is installed but missing from non-interactive shell PATH (common
with nvm), add this to your ~/.profile or ~/.zshenv:
  export PATH="\$HOME/.nvm/versions/node/\$(nvm current 2>/dev/null)/bin:\$PATH"

Manual recovery:
  cd "$DATA_DIR"
  cp "$SRC_PKG" .
  npm install --omit=dev --no-ignore-scripts

Then restart Claude Code.
EOF
exit 1
