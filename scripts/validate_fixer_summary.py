#!/usr/bin/env python3
"""Post-flight validator for a fixer summary written by `llm-ext-fixer`.

Given `--summary <path>` and `--reports-dir <path>`, verifies:

  1. The summary file exists and is non-empty.
  2. The basename contains the literal substring `.fixer.` (the join tag —
     lowercase, dot-delimited, shell-safe; replaces the earlier `[FIXER]`
     marker which was fragile against shell character-class globs).
  3. The resolved path is inside `--reports-dir` (no path-traversal escape).
  4. The summary opens with a `# Fixer Summary` H1 header.
  5. The summary contains at least one of the expected section markers:
     `## Findings`, `## Verification checks`, or `Total findings:`.

This script is INTENDED to be called by the orchestrator and/or the join
script — it mechanically proves a summary is well-formed without trusting
the agent that wrote it.

On success: prints `OK <absolute-path>` and exits 0.
On failure: prints an ERROR line on stderr and exits with a non-zero code.

Exit codes:
  0 — summary is valid
  2 — file missing / not a regular file / unreadable
  3 — filename missing the `.fixer.` tag
  4 — summary resolves outside --reports-dir (path-traversal)
  5 — summary missing the `# Fixer Summary` header
  6 — summary missing required section markers
  7 — summary is empty (0 bytes)
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_FIXER_TAG = ".fixer."
_HEADER_RE = re.compile(r"^#\s+Fixer\s+Summary", re.MULTILINE | re.IGNORECASE)
_SECTION_MARKERS = (
    re.compile(r"^##\s+Findings\b", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^##\s+Verification\s+checks\b", re.MULTILINE | re.IGNORECASE),
    re.compile(r"Total\s+findings\s*:", re.IGNORECASE),
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--summary", required=True, type=Path, help="Absolute path to a fixer .fixer. summary")
    parser.add_argument("--reports-dir", required=True, type=Path, help="Expected reports directory — summary must resolve inside this")
    args = parser.parse_args()

    summary: Path = args.summary
    reports_dir: Path = args.reports_dir.resolve()

    if not summary.is_file():
        print(f"ERROR: summary not found: {summary}", file=sys.stderr)
        return 2

    if summary.stat().st_size == 0:
        print(f"ERROR: summary is empty: {summary}", file=sys.stderr)
        return 7

    if _FIXER_TAG not in summary.name:
        print(f"ERROR: filename missing {_FIXER_TAG}: {summary.name}", file=sys.stderr)
        return 3

    try:
        resolved = summary.resolve()
    except OSError as exc:
        print(f"ERROR: cannot resolve {summary}: {exc}", file=sys.stderr)
        return 2
    try:
        resolved.relative_to(reports_dir)
    except ValueError:
        print(f"ERROR: summary outside reports-dir: {resolved} vs {reports_dir}", file=sys.stderr)
        return 4

    try:
        text = resolved.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        print(f"ERROR: cannot read {resolved}: {exc}", file=sys.stderr)
        return 2

    if not _HEADER_RE.search(text):
        print(f"ERROR: missing '# Fixer Summary' header: {resolved}", file=sys.stderr)
        return 5

    if not any(marker.search(text) for marker in _SECTION_MARKERS):
        print(f"ERROR: missing required section markers: {resolved}", file=sys.stderr)
        return 6

    print(f"OK {resolved}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
