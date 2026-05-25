#!/usr/bin/env python3
"""build-snippet.py — Emit a safely-quoted settings.yaml profile snippet.

The wizard's previous flow had the Sonnet agent build the YAML snippet via a
Python f-string in its prompt. That worked for the happy path but broke (or
worse: silently produced YAML the user pasted as-is) when any value contained
a `:`, a `"`, an embedded quote in a HF repo name, or other YAML-special
characters.

This script centralises snippet generation so the agent never builds YAML by
hand. The agent invokes it with --runner/--model/--url/--context-window/
--profile-name (and optionally --mode), captures stdout, and shows the
result to the user. Every value is safely double-quoted via the local
`_yaml_dquote` helper (PyYAML is not in the wizard's runtime environment;
this is stdlib-only by design).

Output shape on stdout:

    <profile-name>:
      mode: local
      api: lmstudio-local
      model: "qwen2.5-coder:7b"
      url: "http://localhost:1234"
      context_window: 32768

The user then nests this under `profiles:` in
`~/.llm-externalizer/settings.yaml` (the agent narrative covers that step).

Exit codes:
  0 — snippet emitted on stdout
  1 — invalid argument value rejected by an in-function guard
      (runner/mode not in the supported set, context-window too low)
  2 — input violated a safety guard (control char / newline in a value,
      bad or YAML-reserved profile name) AND argparse usage errors
      (unknown flag, --runner/--mode outside `choices`); argparse
      always exits 2, so safety-guard raises use code 2 to match.
"""

from __future__ import annotations

import argparse
import re
import sys

# Runners → (api preset, default URL). Order matters: the wizard's table in
# Step 2 of the agent uses these names verbatim.
SUPPORTED_RUNNERS: dict[str, tuple[str, str]] = {
    "ollama":   ("ollama-local",     "http://localhost:11434/v1"),
    "lmstudio": ("lmstudio-local",   "http://localhost:1234"),
    "vllm":     ("vllm-local",       "http://localhost:8000/v1"),
    "llamacpp": ("llamacpp-local",   "http://localhost:8080/v1"),
    "jan":      ("generic-local",    "http://localhost:1337/v1"),
    "mlx":      ("generic-local",    "http://localhost:8082/v1"),
}

SUPPORTED_MODES = ("local", "remote", "remote-ensemble")

# Profile names must round-trip through YAML AND be searchable in the user's
# scrollback. Reject control chars, newlines, leading dot, and YAML-reserved
# tokens. The set is deliberately conservative; the agent picks names like
# `ollama-qwen2.5-coder-7b` which are already safe.
_PROFILE_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")

# YAML 1.1 boolean/null plain scalars: emitted UNQUOTED as a mapping key
# (`f"{name}:"`) a lenient reader would parse as a bool/null instead of a
# string. The regex above happily accepts the alphabetic ones, so reject
# them explicitly here. Compared case-insensitively (YAML treats `Yes`,
# `YES`, `yes` alike). `~` (null) can't match the regex, but list it for
# documentation completeness.
_YAML_RESERVED_NAMES = frozenset(
    {"null", "true", "false", "yes", "no", "on", "off", "~"}
)


def _yaml_dquote(value: str) -> str:
    """Return the value as a YAML double-quoted scalar.

    YAML double-quoted scalars support `\\` and `\"` escapes; we use that to
    safely embed any printable character without depending on PyYAML.
    Control characters (< 0x20, e.g. `\\n` and `\\r`) are REJECTED via
    SystemExit(2) — the wizard emits single-line YAML scalars and must never
    propagate them. Tab (the one allowed control char) is escaped as `\\t`.
    """
    for ch in value:
        code = ord(ch)
        if code < 0x20 and ch not in ("\t",):
            # Safety-guard violation → exit 2 (per the module docstring). A
            # bare SystemExit("...") would exit 1, so print the diagnostic
            # explicitly and raise the int code.
            print(
                f"refusing to serialise value containing control char "
                f"0x{code:02x} ({value!r})",
                file=sys.stderr,
            )
            raise SystemExit(2)
    # Backslash MUST be escaped first, then double-quote, then tab. Newlines
    # and carriage returns never reach here — the guard above rejects them.
    escaped = (value
               .replace("\\", "\\\\")
               .replace('"', '\\"')
               .replace("\t", "\\t"))
    return f'"{escaped}"'


def _validate_profile_name(name: str) -> str:
    # Both rejections are safety-guard violations → exit 2 (per the module
    # docstring). Use print()+SystemExit(2): a bare SystemExit("...") exits 1.
    if not _PROFILE_NAME_PATTERN.match(name):
        print(
            f"--profile-name {name!r} must match [A-Za-z][A-Za-z0-9._-]"
            "{0,63} (the agent's heuristic produces names that satisfy this)",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if name.lower() in _YAML_RESERVED_NAMES:
        print(
            f"--profile-name {name!r} is a YAML-reserved token; emitted "
            "unquoted as a mapping key it would parse as a boolean/null. "
            "Pick a name like `ollama-qwen2.5-coder-7b`.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return name


def _build_snippet(
    *,
    profile_name: str,
    runner: str,
    model: str,
    url: str | None,
    context_window: int,
    mode: str,
) -> str:
    if runner not in SUPPORTED_RUNNERS:
        raise SystemExit(
            f"--runner {runner!r} not in supported set "
            f"{sorted(SUPPORTED_RUNNERS)!r}"
        )
    if mode not in SUPPORTED_MODES:
        raise SystemExit(
            f"--mode {mode!r} not in supported set {list(SUPPORTED_MODES)!r}"
        )
    if context_window < 4096:
        raise SystemExit(
            f"--context-window {context_window} too low; the plugin's hard "
            "requirement is ≥32K but standalone users need ≥4096 at minimum"
        )

    api_preset, default_url = SUPPORTED_RUNNERS[runner]
    effective_url = url or default_url

    profile_name_safe = _validate_profile_name(profile_name)
    # Build the YAML manually — single source of truth for indentation and
    # quoting. Every dynamic value is wrapped via _yaml_dquote so a model id
    # like `qwen2.5-coder:7b` (colon would otherwise be parsed as a mapping
    # separator on lenient YAML readers) lands as `"qwen2.5-coder:7b"`.
    lines = [
        f"{profile_name_safe}:",
        f"  mode: {mode}",
        f"  api: {api_preset}",
        f"  model: {_yaml_dquote(model)}",
        f"  url: {_yaml_dquote(effective_url)}",
        f"  context_window: {int(context_window)}",
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Emit a safely-quoted llm-externalizer settings.yaml profile "
            "snippet. Output is unindented (caller nests it under "
            "`profiles:`)."
        ),
    )
    parser.add_argument("--profile-name", required=True,
                        help="Profile key (e.g. `ollama-qwen2.5-coder-7b`)")
    parser.add_argument("--runner", required=True,
                        choices=list(SUPPORTED_RUNNERS),
                        help="Runner the profile targets")
    parser.add_argument("--model", required=True,
                        help="Model id as the runner sees it")
    parser.add_argument("--url", default=None,
                        help="OpenAI-compatible API base. Defaults to the "
                             "runner's canonical localhost endpoint.")
    parser.add_argument("--context-window", type=int, default=32768,
                        help="Context window size in tokens (default: 32768 "
                             "— the plugin's hard requirement)")
    parser.add_argument("--mode", default="local",
                        choices=SUPPORTED_MODES,
                        help="Runtime mode (local / remote / remote-ensemble)")
    args = parser.parse_args(argv)

    snippet = _build_snippet(
        profile_name=args.profile_name,
        runner=args.runner,
        model=args.model,
        url=args.url,
        context_window=args.context_window,
        mode=args.mode,
    )
    sys.stdout.write(snippet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
