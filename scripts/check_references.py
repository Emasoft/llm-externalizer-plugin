#!/usr/bin/env python3
"""Validate internal references in plugin non-code files.

Walks the plugin tree and checks that every relative path-like reference
in `.md` / `.yml` / `.yaml` / `.json` / `.toml` files resolves to an actual
file or directory on disk. Covers the kinds of references that code linters
do NOT catch: skill docs pointing at other skills, agents referencing
scripts, commands referencing bundled binaries, README examples, YAML
workflow steps, CLAUDE.md references, marketplace metadata, etc.

Limits — what this tool CANNOT do:
  - **Dynamic references cannot be resolved** (e.g. `${CLAUDE_PLUGIN_ROOT}/$SUBDIR/x.py`,
    `${{ github.event.inputs.path }}`, `$(command)/foo`, `<PLACEHOLDER>/bar`).
    These are reported as WARNINGS (not ERRORS) and do NOT fail the exit
    code. A reference is classified DYNAMIC when the captured path contains
    any of: `$`, `%`, `{{`, or `}}`.
  - Only the reference patterns listed below are extracted. Paths that
    don't match any pattern are silently ignored (absolute `/etc/...`
    paths, HTTP URLs, `file://` URIs, etc.).

Detection patterns (applied in order):

  1. `${CLAUDE_PLUGIN_ROOT}/<path>` or `$CLAUDE_PLUGIN_ROOT/<path>`
     — resolved relative to the plugin root.

  2. Paths starting with a known plugin directory name:
       scripts/, agents/, commands/, skills/, hooks/, bin/, docs/,
       mcp-server/, examples/, references/, .github/, .claude-plugin/
     — resolved first relative to the containing file's directory, then
       relative to the plugin root.

  3. Markdown links `[text](./<rel>)` or `[text](<rel>)` where <rel> ends
     in a known file extension (.md, .py, .sh, .js, .ts, .json, .yml,
     .yaml, .toml, .sql, .html, .css) and does NOT look like an HTTP URL
     — resolved relative to the containing file's directory.

Exclusions (never scanned, never checked as targets):
  - CHANGELOG.md (historical — references dead/moved paths intentionally)
  - .mypy_cache/, .rechecker/, node_modules/, dist/, .claude/worktrees/
  - .git/, reports_dev/, docs_dev/, scripts_dev/, reports/,
    llm_externalizer_output/, .serena/, .venv/, __pycache__/

Usage:
  python3 scripts/check_references.py [--root <plugin-root>] [--verbose] [--quiet] [--strict]

Exit codes:
  0 — all static references resolve (dynamic refs reported as warnings only)
  1 — at least one broken STATIC reference
  2 — --root is not a valid directory

Under `--strict`, dynamic references also cause exit 1 (useful in CI if you
want zero unresolvable refs).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_SCAN_SUFFIXES = (".md", ".yml", ".yaml", ".json", ".toml")

_KNOWN_DIRS = (
    "scripts",
    "agents",
    "commands",
    "skills",
    "hooks",
    "bin",
    "docs",
    "mcp-server",
    "examples",
    "references",
    ".github",
    ".claude-plugin",
)

_KNOWN_LINK_SUFFIXES = (
    ".md",
    ".py",
    ".sh",
    ".js",
    ".ts",
    ".mjs",
    ".cjs",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".sql",
    ".html",
    ".css",
)

_EXCLUDE_PARTS = {
    ".git",
    ".mypy_cache",
    ".rechecker",
    "node_modules",
    "dist",
    "reports_dev",
    "docs_dev",
    "scripts_dev",
    "reports",
    "llm_externalizer_output",
    ".serena",
    ".venv",
    "__pycache__",
    "worktrees",
}

_EXCLUDE_FILE_BASENAMES = {
    "CHANGELOG.md",
    "package-lock.json",
}

# Characters that can never appear inside a path reference — used as
# terminators for the greedy path-consuming regexes. Intentionally broad so
# we never swallow punctuation, markdown syntax, JSON/YAML delimiters, or
# sentence-end marks into a supposed path. Forward slashes and dots ARE
# allowed inside paths; everything else listed here terminates a match.
_PATH_TERMINATORS = r"\s)'\"`>}{\[\]|:,;<(*"

_PLUGIN_ROOT_RE = re.compile(r"\$\{?CLAUDE_PLUGIN_ROOT\}?/(?P<path>[^" + _PATH_TERMINATORS + r"]+)")

_KNOWN_DIR_RE = re.compile(
    r"(?<![A-Za-z0-9_./-])(?P<path>(?:"
    + "|".join(re.escape(d) for d in _KNOWN_DIRS)
    + r")/[^"
    + _PATH_TERMINATORS
    + r"]+)"
)

_MD_LINK_RE = re.compile(r"\]\((?P<target>(?!https?://)(?!mailto:)(?!tel:)(?!#)[^\s)'\"`]+?)\)")


def _is_excluded(path: Path, root: Path) -> bool:
    try:
        rel = path.resolve().relative_to(root)
    except ValueError:
        return True
    if path.name in _EXCLUDE_FILE_BASENAMES:
        return True
    return any(part in _EXCLUDE_PARTS for part in rel.parts)


def _iter_scan_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in _SCAN_SUFFIXES:
            continue
        if _is_excluded(path, root):
            continue
        yield path


def _strip_trailing_punct(s: str) -> str:
    while s and s[-1] in ".,;:!?":
        s = s[:-1]
    return s


# A reference is DYNAMIC (unresolvable at static analysis time) when the
# captured path — AFTER the canonical `${CLAUDE_PLUGIN_ROOT}/` prefix is
# stripped by the PLUGIN_ROOT_RE — still contains one of these markers:
#   `$`       shell env var or command substitution (e.g. $VAR, $(cmd))
#   `%`       Windows env var (%VAR%) or printf-style placeholder
#   `{{`/`}}` GitHub Actions / Jinja / Mustache template expression
_DYNAMIC_MARKERS = ("$", "%", "{{", "}}")


def _is_dynamic(path_str: str) -> bool:
    return any(marker in path_str for marker in _DYNAMIC_MARKERS)


def _extract_references(text: str, source_file: Path, root: Path) -> list[tuple[str, str, Path | None, Path]]:
    """Return list of (raw_reference, target_rel_path, resolved_under_file_dir, resolved_under_root).

    `target_rel_path` is the path AFTER any known prefix (e.g. `${CLAUDE_PLUGIN_ROOT}/`)
    has been stripped — that's what the dynamic-marker check runs against, so
    the `$` inside `${CLAUDE_PLUGIN_ROOT}` doesn't spuriously flag static refs
    as dynamic.

    `resolved_under_file_dir` is None when resolution was explicitly plugin-root only
    (e.g. ${CLAUDE_PLUGIN_ROOT}/...).
    """
    found: list[tuple[str, str, Path | None, Path]] = []
    seen: set[str] = set()

    for m in _PLUGIN_ROOT_RE.finditer(text):
        raw = m.group(0)
        target_rel = _strip_trailing_punct(m.group("path"))
        if raw in seen:
            continue
        seen.add(raw)
        found.append((raw, target_rel, None, (root / target_rel)))

    for m in _KNOWN_DIR_RE.finditer(text):
        raw = _strip_trailing_punct(m.group("path"))
        if raw in seen:
            continue
        seen.add(raw)
        found.append((raw, raw, (source_file.parent / raw), (root / raw)))

    for m in _MD_LINK_RE.finditer(text):
        target = _strip_trailing_punct(m.group("target"))
        if not target.lower().endswith(_KNOWN_LINK_SUFFIXES):
            continue
        if target in seen:
            continue
        if any(target.startswith(d + "/") for d in _KNOWN_DIRS):
            continue
        seen.add(target)
        found.append((target, target, (source_file.parent / target), (root / target)))

    return found


def _exists_within(path: Path, root: Path) -> bool:
    """True when `path` exists AND its resolved form is inside `root`.

    This rejects `../`-traversal references that happen to point at a real
    file outside the plugin tree (e.g. a link like `[foo](../../../bar)`
    resolving to a system file).
    """
    if not path.exists():
        return False
    try:
        return path.resolve().is_relative_to(root)
    except (OSError, ValueError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Plugin root (default: parent of scripts/)",
    )
    parser.add_argument("--quiet", action="store_true", help="Print only broken references / warnings")
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print every detected reference and its resolution (for debugging the detector)",
    )
    parser.add_argument(
        "--strict", action="store_true", help="Treat dynamic references as errors (default: they are warnings only)"
    )
    args = parser.parse_args()

    root: Path = args.root.resolve()
    if not root.is_dir():
        print(f"ERROR: --root is not a directory: {root}", file=sys.stderr)
        return 2

    scanned = 0
    total_refs = 0
    broken: list[tuple[Path, str, str]] = []
    dynamic: list[tuple[Path, str]] = []

    for path in _iter_scan_files(root):
        scanned += 1
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            print(f"WARN: cannot read {path}: {exc}", file=sys.stderr)
            continue
        for raw, target_rel, rel_file, rel_root in _extract_references(text, path, root):
            total_refs += 1
            rel_source = path.relative_to(root)
            if _is_dynamic(target_rel):
                dynamic.append((rel_source, raw))
                if args.verbose:
                    print(f"{rel_source}: '{raw}' DYNAMIC (unresolvable — reported as warning)")
                continue
            resolved: Path | None = None
            if rel_file is not None and _exists_within(rel_file, root):
                resolved = rel_file
            elif _exists_within(rel_root, root):
                resolved = rel_root
            if args.verbose:
                verdict = f"OK -> {resolved.resolve().relative_to(root)}" if resolved else "BROKEN"
                print(f"{rel_source}: '{raw}' {verdict}")
            if resolved is None:
                tried = f"root/{target_rel}" if rel_file is None else f"{rel_file} | {rel_root}"
                broken.append((rel_source, raw, f"tried: {tried}"))

    if not args.quiet:
        print(
            f"scanned {scanned} files, {total_refs} references, {len(broken)} broken, {len(dynamic)} dynamic (warnings)"
        )

    for source_rel, raw in dynamic:
        print(f"{source_rel}: WARNING dynamic reference — cannot resolve statically: '{raw}'", file=sys.stderr)
    for source_rel, raw, detail in broken:
        print(f"{source_rel}: BROKEN '{raw}' ({detail})")

    if broken:
        return 1
    if args.strict and dynamic:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
