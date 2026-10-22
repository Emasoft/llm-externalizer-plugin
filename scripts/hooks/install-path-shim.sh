#!/bin/sh
# SessionStart hook (matcher: startup|resume): install or refresh the global
# `llm-ext` shim at ~/.local/bin/llm-ext.
#
# Why: Claude Code puts this plugin's bin/ on PATH only inside its own
# sessions, so a plain terminal gets "command not found".
#
# Rules:
# - Writes only ~/.local/bin/llm-ext, and only when it is absent or is already
#   our shim (the marker on its second line). Anything else there is left alone.
# - No fallback to other PATH dirs: a session's PATH also holds other plugins'
#   cache bin/ dirs under $HOME, and writing there would plant a command in
#   someone else's plugin.
# - Writes only when the bytes differ, through a temp file and an atomic mv.
# - POSIX sh only, so a session start never depends on python (on macOS a
#   missing Xcode CLT turns /usr/bin/python3 into an install dialog).
# - LLM_EXT_NO_PATH_SHIM=1 turns the hook off.
# - A SessionStart hook's stderr is not shown on exit 0, so messages for the
#   user go out as JSON {"systemMessage": ...} on stdout. A real failure exits
#   1: Claude Code shows it as a non-blocking hook error and the session goes on.
#   That error shows only the FIRST stderr line, so the commands that can fail
#   are silenced and our own `llm-ext:` line is the one the user sees.
# - Skipped on native Windows shells: an sh script in ~/.local/bin is not
#   runnable from cmd or PowerShell.

[ "${LLM_EXT_NO_PATH_SHIM:-}" = 1 ] && exit 0
case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*) exit 0 ;;
esac

marker='# llm-externalizer-path-shim'
src="$(cd "$(dirname "$0")/../path-shim" 2>/dev/null && pwd)/llm-ext"
dir="$HOME/.local/bin"
dst="$dir/llm-ext"

notify() {
  msg=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"systemMessage": "%s"}\n' "$msg"
}

if [ ! -r "$src" ]; then
  echo "llm-ext: PATH shim source is missing: $src" >&2
  exit 1
fi

if [ -e "$dst" ] || [ -L "$dst" ]; then
  if [ ! -f "$dst" ] || ! head -n 5 "$dst" | grep -qF "$marker"; then
    notify "llm-ext: $dst exists and is not the llm-externalizer shim, so it was left untouched. Set LLM_EXT_NO_PATH_SHIM=1 to hide this message."
    exit 0
  fi
  if cmp -s "$src" "$dst"; then
    exit 0
  fi
fi

tmp="$dir/.llm-ext.tmp.$$"
trap 'rm -f "$tmp"' EXIT
if ! { mkdir -p "$dir" 2>/dev/null &&
  cp "$src" "$tmp" 2>/dev/null &&
  chmod 755 "$tmp" 2>/dev/null &&
  mv -f "$tmp" "$dst" 2>/dev/null; }; then
  echo "llm-ext: could not install the PATH shim at $dst (set LLM_EXT_NO_PATH_SHIM=1 to turn this hook off)" >&2
  exit 1
fi

msg="llm-ext: installed $dst so llm-ext works in any terminal (set LLM_EXT_NO_PATH_SHIM=1 to turn this off)."
case ":$PATH:" in
  *":$dir:"*) ;;
  *) msg="$msg $dir is not on this session's PATH; if llm-ext is not found in your terminal, add $dir to PATH." ;;
esac
notify "$msg"
exit 0
