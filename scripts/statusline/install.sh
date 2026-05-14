#!/usr/bin/env bash
# Installer for the multi-tier Claude Code statusline.
#
# Copies statusline.py to ~/.claude/statusline.py and patches
# ~/.claude/settings.json so CC invokes it with a 3-second refreshInterval
# (so terminal-resize tier reselection happens within 3s).
#
# Idempotent: re-running is safe. Existing files are backed up with a
# timestamp suffix before any change.
#
# Requirements: bash, python3 (for settings.json patching). No other deps.

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SRC="$SCRIPT_DIR/statusline.py"
DEST="$HOME/.claude/statusline.py"
SETTINGS="$HOME/.claude/settings.json"
REFRESH_INTERVAL="${REFRESH_INTERVAL:-3}"  # seconds; override via env

ts="$(date +%Y%m%d_%H%M%S%z)"

echo "==> Installer: Claude Code multi-tier statusline"
echo "    src      : $SRC"
echo "    dest     : $DEST"
echo "    settings : $SETTINGS"
echo "    refresh  : ${REFRESH_INTERVAL}s"
echo

# 1. Sanity: source must exist
if [[ ! -f "$SRC" ]]; then
  echo "ERROR: missing source: $SRC" >&2
  exit 1
fi

# 2. Sanity: ~/.claude must exist (CC creates it on first run)
if [[ ! -d "$HOME/.claude" ]]; then
  echo "ERROR: $HOME/.claude does not exist." >&2
  echo "       Run Claude Code at least once before installing." >&2
  exit 1
fi

# 3. python3 must be on PATH (the statusline runs via python3, and the
#    settings.json patcher below uses it too).
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found on PATH." >&2
  exit 1
fi

# 4. Backup + copy the script. Backup only if the existing file actually
#    differs from the new one — keeps the dotfile dir tidy on re-runs.
if [[ -f "$DEST" ]]; then
  if cmp -s "$SRC" "$DEST"; then
    echo "==> $DEST already up to date — skipping copy."
  else
    cp -p "$DEST" "$DEST.bak.$ts"
    echo "==> backed up old $DEST → $DEST.bak.$ts"
    cp -p "$SRC" "$DEST"
    chmod +x "$DEST"
    echo "==> installed $DEST"
  fi
else
  cp -p "$SRC" "$DEST"
  chmod +x "$DEST"
  echo "==> installed $DEST"
fi

# 5. Patch settings.json. Use python3 to load+modify+rewrite atomically
#    (tmp + rename) so a failed write never corrupts the existing config.
#    JSONC comments aren't expected in user settings.json, but we tolerate
#    pure-JSON only — if the file is invalid we abort instead of overwrite.
if [[ ! -f "$SETTINGS" ]]; then
  echo "==> creating new $SETTINGS"
  echo '{}' > "$SETTINGS"
fi

cp -p "$SETTINGS" "$SETTINGS.bak.$ts"
echo "==> backed up old $SETTINGS → $SETTINGS.bak.$ts"

python3 - <<PY
import json, os, sys, tempfile
settings_path = "$SETTINGS"
dest_path = "$DEST"
refresh = int("$REFRESH_INTERVAL")

with open(settings_path) as f:
    raw = f.read()

try:
    data = json.loads(raw) if raw.strip() else {}
except json.JSONDecodeError as e:
    print(f"ERROR: $SETTINGS is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)

# Pick the right interpreter at install time. The literal name python3 is unreliable: it
# doesn't exist on native Windows, on NixOS without nix-shell, or on
# PEP-668 macOS where the bare symlink points at Apple's CLT stub. Use
# shlex.join to quote paths containing spaces.
import shutil, shlex
interp = shutil.which("python3") or shutil.which("python") or sys.executable
if not interp:
    print("ERROR: cannot locate a Python interpreter for the statusline.", file=sys.stderr)
    sys.exit(2)
statusline_cmd = shlex.join([interp, dest_path])
# Replace the statusLine block. We deliberately rewrite (not merge) the
# inner dict so a stale "args" or other obsolete field can't survive.
data["statusLine"] = {
    "type": "command",
    "command": statusline_cmd,
    "refreshInterval": refresh,
}

# Atomic write: tmp file in same dir, then os.replace.
fd, tmp = tempfile.mkstemp(prefix=".settings.", dir=os.path.dirname(settings_path))
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, settings_path)
except Exception:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise

print("==> patched", settings_path)
print("    statusLine.command         =", data["statusLine"]["command"])
print("    statusLine.refreshInterval =", data["statusLine"]["refreshInterval"])
PY

echo
echo "Done. The statusline updates within ${REFRESH_INTERVAL}s of a terminal resize."
echo "If it doesn't appear immediately, exit and relaunch Claude Code once —"
echo "settings changes can require a session restart to register."
