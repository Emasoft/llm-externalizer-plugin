#!/bin/sh
# SessionStart hook (matcher: startup|resume): make sure the mlx-decision
# singleton that llm-ext's local decider adopts exists as a macOS login agent.
#
# Why: llm-ext never starts mlx-decision (it adopts the one singleton on
# 127.0.0.1:8123). This hook installs that singleton as a login agent when the
# plugin is installed or updated and no other agent already provides it.
#
# Rules:
# - Only macOS on Apple silicon, only when the mlx-decision binary exists, the
#   model is already in the Hugging Face cache, and the machine has >= 32 GiB
#   of RAM (the model keeps ~15 GB resident). Otherwise it exits 0 (with a
#   systemMessage when the user can fix the cause).
#   The RAM and missing-cache refusals are shown once (stamp files under
#   ${LLM_EXT_CONFIG_DIR:-$HOME/.llm-externalizer}/state), cleared on install.
#   The missing-cache stamp records the refused cache path: a new HF_HOME shows the message again.
#   A binary path containing " $ ` or \ or a control character is refused with a systemMessage, shown once per
#   distinct path (badpath stamp), exit 0, after the other-agent check below, so a
#   machine with its own singleton agent stays silent.
# - If ANY other LaunchAgent plist mentions mlx-decision, nothing is installed:
#   a second agent would race the user's own singleton.
# - Writes only ~/Library/LaunchAgents/com.llm-externalizer.mlx-decision.plist,
#   only when the bytes differ, through a temp file and an atomic mv.
# - POSIX sh only, so a session start never depends on python.
# - LLM_EXT_NO_DECIDER_AGENT=1 turns the hook off.
# - A SessionStart hook's stderr is not shown on exit 0, so messages for the
#   user go out as JSON {"systemMessage": ...} on stdout. Only a failure to
#   write the plist exits 1, with one `llm-ext:` stderr line (Claude Code
#   shows only the first stderr line of a hook error).
#
# The agent's sh -c guard, and why each piece is there:
# - pgrep pattern "[m]lx-decision server": the [m] bracket keeps the guard's
#   own sh argv from matching itself. No other text in the guard may contain
#   the words "mlx-decision server" for the same reason. A running server on
#   ANY port means do not start a second (a second copy is another ~15 GB).
# - lockf -t 0 on $HOME/Library/Caches/mlx-decision/server.lock: that lock path
#   is shared on purpose with any other singleton agent, so the kernel refuses
#   a second copy even if two agents race.
# - ThrottleInterval 60 stops a crash loop from reloading the model.
# - HF_HUB_OFFLINE=1: a missing cache fails fast instead of downloading
#   ~22 GB at login. This hook also refuses to install without the cache.
# - Port 8123 and served model name elephant-1 MUST equal
#   DECIDER_SINGLETON_PORT (l2/local-fallback.ts) and SERVED_MODEL
#   (l2/local-decider.ts); decider-agent-hook.test.ts enforces it.

[ "${LLM_EXT_NO_DECIDER_AGENT:-}" = 1 ] && exit 0
[ "$(uname -s 2>/dev/null)" = Darwin ] && [ "$(uname -m 2>/dev/null)" = arm64 ] || exit 0

label='com.llm-externalizer.mlx-decision'
dir="$HOME/Library/LaunchAgents"
file="$dir/$label.plist"

notify() {
  msg=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"systemMessage": "%s"}\n' "$msg"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Refusals for RAM and for a missing model cache are shown ONCE, not every
# session: the same message on every startup is noise the user cannot act on
# faster. A stamp file per reason records that it was shown; the stamps are
# removed once the agent is installed, so a later regression is reported again.
statedir="${LLM_EXT_CONFIG_DIR:-$HOME/.llm-externalizer}/state"

# notify_once REASON MESSAGE [CONTENT]: notify unless REASON was already shown.
# With CONTENT, the stamp also records it and the message is shown again when
# the recorded CONTENT differs: the missing-cache stamp holds the refused cache
# path, because the user can fix the cache by pointing HF_HOME elsewhere, and a
# new path deserves the hint. Without CONTENT the stamp is show-once.
notify_once() {
  stamp="$statedir/decider-agent-refused-$1.stamp"
  if [ -e "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "${3-}" ]; then
    return 0
  fi
  notify "$2"
  # The whole stamp write must never fail the hook, and the message is already
  # out: a redirection error on a special builtin (":") can terminate a
  # POSIX-mode sh such as macOS /bin/sh, so the redirect runs inside a
  # silenced group on printf and every failure is ignored.
  mkdir -p "$statedir" 2>/dev/null || true
  { printf "%s" "${3-}" >"$stamp"; } 2>/dev/null || true
  return 0
}

clear_refusal_stamps() {
  rm -f "$statedir/decider-agent-refused-ram.stamp" "$statedir/decider-agent-refused-cache.stamp" "$statedir/decider-agent-refused-badpath.stamp"
}

# Binary: PATH first, then ~/.local/bin. None: nothing to run, stay silent.
bin=$(command -v mlx-decision 2>/dev/null)
case "$bin" in
  /*) ;;
  *) bin='' ;;
esac
if [ -z "$bin" ] && [ -x "$HOME/.local/bin/mlx-decision" ]; then
  bin="$HOME/.local/bin/mlx-decision"
fi
[ -n "$bin" ] || exit 0

# Another agent already provides a singleton: do not race it.
if [ -d "$dir" ]; then
  for other in "$dir"/*.plist; do
    [ -f "$other" ] || continue
    [ "$other" = "$file" ] && continue
    if grep -qF 'mlx-decision' "$other" 2>/dev/null; then
      exit 0
    fi
  done
fi

# Refuse a binary path that holds a double quote, dollar sign, backtick, backslash
# or control character. The path is spliced between double quotes into the agent's
# /bin/sh -c guard string, so any of these would break the quoting or inject
# shell code that launchd then runs at every login. Exit 0: this must never
# block the session. The refusal goes out through notify_once (a visible
# systemMessage, once per distinct path) and NOT to stderr: a SessionStart
# hook's stderr on exit 0 is never shown to the user, so a stderr line would
# make the refusal invisible. This check sits AFTER the other-agent loop above on
# purpose: a machine that already has its own mlx-decision singleton agent must
# stay completely silent, whatever its binary path looks like. It still runs
# before any plist generation. A control character (newline, tab, ESC) in the
# path would make the JSON systemMessage that notify prints invalid, because
# notify escapes only backslash and double quote.
case "$bin" in
  *\"* | *\$* | *\`* | *\\* | *[[:cntrl:]]*)
    notify_once badpath "llm-ext: the mlx-decision login agent was not installed: the binary path contains a double quote, dollar sign, backtick, backslash or control character ($(printf '%s' "$bin" | tr '\000-\037' ' '))" "$bin"
    exit 0
    ;;
esac

# RAM floor: the decider keeps ~15 GB resident.
mem=$(sysctl -n hw.memsize 2>/dev/null)
case "$mem" in
  '' | *[!0-9]*)
    notify "llm-ext: could not read this machine's RAM size, so the mlx-decision login agent was not installed."
    exit 0
    ;;
esac
if [ "$mem" -lt 34359738368 ]; then
  notify_once ram "llm-ext: this machine has less than 32 GiB of RAM, too small for the ~15 GB resident mlx-decision decider, so the login agent was not installed. This message is normally shown once; set LLM_EXT_NO_DECIDER_AGENT=1 to turn this hook off."
  exit 0
fi

# Model cache: install only when the agent can start offline.
hf="${HF_HOME:-$HOME/.cache/huggingface}"
if [ ! -d "$hf/hub/models--baselabs--elephant-1" ]; then
  notify_once cache "llm-ext: the mlx-decision login agent was not installed because baselabs/elephant-1 is not in the Hugging Face cache ($hf). Run: mlx-decision download baselabs/elephant-1 (then restart Claude Code), or set HF_HOME for Claude Code to the cache that holds it. This message is normally shown once per cache location; set LLM_EXT_NO_DECIDER_AGENT=1 to turn this hook off." "$hf"
  exit 0
fi

# Single quotes are deliberate: $HOME must reach the plist literally, so the
# agent's sh expands it at run time (launchd sets HOME for a user agent).
# shellcheck disable=SC2016
guard='if /usr/bin/pgrep -qf "[m]lx-decision server"; then echo "llm-ext agent: another mlx-decision singleton is already running; not starting a second one" >&2; /bin/sleep 120; exit 0; fi; /bin/mkdir -p "$HOME/Library/Caches/mlx-decision"; exec /usr/bin/lockf -t 0 "$HOME/Library/Caches/mlx-decision/server.lock" "'"$bin"'" server -m baselabs/elephant-1 --default-model elephant-1 --host 127.0.0.1 --port 8123'

guard_x=$(xml_escape "$guard")
path_x=$(xml_escape "$(dirname "$bin"):/opt/homebrew/bin:/usr/bin:/bin")
cache_x=$(xml_escape "$HOME/Library/Caches/mlx-decision")
logdir="$HOME/Library/Logs/mlx-decision"
log_x=$(xml_escape "$logdir/server.log")
env_x="    <key>PATH</key><string>$path_x</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>"
if [ -n "${HF_HOME:-}" ]; then
  env_x="$env_x
    <key>HF_HOME</key><string>$(xml_escape "$HF_HOME")</string>"
fi

plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <!-- Written by the llm-externalizer plugin. The sh guard starts the mlx-decision singleton only when none runs: pgrep with the bracket trick never matches the guard itself, lockf on the shared lock file makes the kernel refuse a second copy, ThrottleInterval stops a crash loop from reloading the model. -->
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$guard_x</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>WorkingDirectory</key><string>$cache_x</string>
  <key>StandardOutPath</key><string>$log_x</string>
  <key>StandardErrorPath</key><string>$log_x</string>
  <key>EnvironmentVariables</key>
  <dict>
$env_x
  </dict>
</dict>
</plist>"

existed=0
[ -e "$file" ] && existed=1

tmp="$dir/.$label.plist.tmp.$$"
trap 'rm -f "$tmp"' EXIT
if ! { mkdir -p "$dir" "$HOME/Library/Caches/mlx-decision" "$logdir" 2>/dev/null &&
  { printf '%s\n' "$plist" >"$tmp"; } 2>/dev/null; }; then
  echo "llm-ext: could not write the mlx-decision login agent at $file (set LLM_EXT_NO_DECIDER_AGENT=1 to turn this hook off)" >&2
  exit 1
fi
if [ "$existed" = 1 ] && cmp -s "$tmp" "$file"; then
  clear_refusal_stamps
  exit 0
fi
if ! mv -f "$tmp" "$file" 2>/dev/null; then
  echo "llm-ext: could not write the mlx-decision login agent at $file (set LLM_EXT_NO_DECIDER_AGENT=1 to turn this hook off)" >&2
  exit 1
fi

clear_refusal_stamps
uid=$(id -u)
domain="gui/$uid"
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  # Already loaded (an update). Reload only when nothing is serving: a bootout
  # would kill a running ~15 GB server.
  # WHY absolute: a PATH entry ahead of /usr/bin must not change what this SessionStart hook runs (same as the guard's /usr/bin/pgrep; TRDD-O93LFMF3)
  if /usr/bin/pgrep -qf '[m]lx-decision server'; then
    notify "llm-ext: updated the mlx-decision login agent ($file); a server is running, so the new agent applies at next login."
    exit 0
  fi
  launchctl bootout "$domain/$label" >/dev/null 2>&1
fi
if ! launchctl bootstrap "$domain" "$file" >/dev/null 2>&1; then
  notify "llm-ext: wrote the mlx-decision login agent ($file) but launchctl bootstrap failed; it will load at next login."
  exit 0
fi

if [ "$existed" = 1 ]; then
  notify "llm-ext: updated and reloaded the mlx-decision login agent ($file)."
else
  notify "llm-ext: installed a login agent ($file) that keeps a ~15 GB mlx-decision server resident, so local decisions share one server. Opt out with LLM_EXT_NO_DECIDER_AGENT=1; to remove it later run launchctl bootout $domain/$label and delete that file."
fi
exit 0
