#!/usr/bin/env python3
"""Pre-flight validator for a scan report before a fixer agent is dispatched.

Given one `--report <path>` (an LLM Externalizer per-file `.md` report), this
script mechanically verifies the references in the report:

  1. The report file exists and is a readable `.md`.
  2. The report contains a parseable `File:` / `## File:` / `Source:` line
     pointing to the source file the report covers.
  3. The referenced source file actually exists on disk (absolute; relative
     paths are resolved against `--project-dir`).
  4. The source file stays inside `--project-dir` (path-traversal guard).
  5. Every line-range reference in the report (e.g. `lines 12-40`, `L12-L40`,
     `:12-40`) is within the actual line count of the source file.

This script is INTENDED to be run by the orchestrator command BEFORE
dispatching a fixer agent. An agent cannot be trusted to enforce these
invariants — a script can.

On success: prints the validated absolute source file path and exits 0.
On failure: prints one ERROR line on stderr and exits with a non-zero code.

Exit codes:
  0 — report is valid
  2 — report file missing / unreadable
  3 — report has no parseable source-file reference
  4 — source file does not exist / not a regular file
  5 — source file escapes --project-dir (path-traversal)
  6 — a line range in the report is out of bounds for the source file
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_FILE_PATTERNS = (
    # The canonical format emitted by code_task / scan_folder in mode 0:
    #   - **Input file**: `<absolute-path>`
    re.compile(
        r"^\s*-\s*\*\*\s*(?:Input\s*file|File|Source(?:\s*file)?)\s*\*\*\s*:\s*`?(?P<path>[^`\n]+?)`?\s*$",
        re.MULTILINE | re.IGNORECASE,
    ),
    # Plain bullet / heading / bare line variants (kept for hand-written reports).
    re.compile(r"^\s*#{1,6}\s*File\s*:\s*`?(?P<path>[^`\n]+?)`?\s*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^\s*-\s*File\s*:\s*`?(?P<path>[^`\n]+?)`?\s*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^\s*File\s*:\s*`?(?P<path>[^`\n]+?)`?\s*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^\s*-?\s*Source(?:\s*file)?\s*:\s*`?(?P<path>[^`\n]+?)`?\s*$", re.MULTILINE | re.IGNORECASE),
)

_LINE_RANGE_RE = re.compile(
    r"(?:(?:^|[\s(\[])(?:lines?|L)\s*[:=]?\s*(\d+)(?:\s*[-–]\s*L?(\d+))?|:(\d+)(?:\s*[-–]\s*(\d+))?)",
    re.IGNORECASE,
)


def _extract_source(text: str, project_dir: Path) -> Path | None:
    for pattern in _FILE_PATTERNS:
        match = pattern.search(text)
        if match:
            raw = match.group("path").strip().strip("`\"'")
            if not raw:
                continue
            path = Path(raw)
            if not path.is_absolute():
                path = (project_dir / path).resolve()
            return path
    return None


def _extract_line_ranges(text: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for match in _LINE_RANGE_RE.finditer(text):
        start_raw = match.group(1) or match.group(3)
        end_raw = match.group(2) or match.group(4)
        start = int(start_raw)
        end = int(end_raw) if end_raw else start
        ranges.append((min(start, end), max(start, end)))
    return ranges


def _count_lines(path: Path) -> int:
    count = 0
    with path.open("rb") as handle:
        for _ in handle:
            count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--report", required=True, type=Path, help="Absolute path to an LLM Externalizer per-file report"
    )
    parser.add_argument(
        "--project-dir",
        required=True,
        type=Path,
        help="Project root; relative paths in the report resolve against this",
    )
    args = parser.parse_args()

    report: Path = args.report
    project_dir: Path = args.project_dir.resolve()

    if not report.is_file():
        print(f"ERROR: report not found: {report}", file=sys.stderr)
        return 2
    try:
        text = report.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        print(f"ERROR: cannot read report {report}: {exc}", file=sys.stderr)
        return 2

    source = _extract_source(text, project_dir)
    if source is None:
        print(f"ERROR: no parseable File: reference in {report}", file=sys.stderr)
        return 3

    if not source.is_file():
        print(f"ERROR: source file not found: {source}", file=sys.stderr)
        return 4

    try:
        resolved = source.resolve()
    except OSError as exc:
        print(f"ERROR: cannot resolve source {source}: {exc}", file=sys.stderr)
        return 4
    try:
        resolved.relative_to(project_dir)
    except ValueError:
        print(f"ERROR: source escapes project-dir: {resolved} not under {project_dir}", file=sys.stderr)
        return 5

    try:
        total_lines = _count_lines(resolved)
    except OSError as exc:
        print(f"ERROR: cannot count lines of {resolved}: {exc}", file=sys.stderr)
        return 4

    for start, end in _extract_line_ranges(text):
        if start < 1 or end > total_lines:
            print(
                f"ERROR: line range {start}-{end} out of bounds for {resolved} ({total_lines} lines)",
                file=sys.stderr,
            )
            return 6

    print(str(resolved))
    return 0


if __name__ == "__main__":
    sys.exit(main())
