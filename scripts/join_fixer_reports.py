#!/usr/bin/env python3
"""Join .fixer.-tagged reports into one final report — with validation.

Discovers every `.md` file under `--input-dir` whose basename contains the
literal substring `.fixer.` (shell-safe — replaces the earlier `[FIXER]`
marker which was fragile against shell character-class globs like
`*[FIXER]*.md`). Each candidate is validated with the same checks as
`validate_fixer_summary.py` (missing header / missing markers / empty file
/ escapes reports dir); survivors are sorted deterministically by name and
concatenated into `--output` with per-file headers and horizontal-rule
separators.

Invalid summaries are recorded in the final-report header (count + names)
but NOT included in the joined body — the orchestrator can see from the
header that N summaries were rejected and why.

Never writes report *contents* to stdout — only the final path on success.

Stdlib only. Exit codes:
  0 — success, final report written, path printed to stdout
  2 — --input-dir missing or not a directory
  3 — no .fixer.-tagged reports found in --input-dir
  4 — --output parent cannot be created
  5 — every .fixer.-tagged report failed validation (nothing to join)
"""

from __future__ import annotations

import argparse
import datetime as _dt
import re
import sys
from pathlib import Path

_FIXER_TAG = ".fixer."
_DESCRIPTION = "Join .fixer.-tagged LLM-Externalizer fixer reports into one final report."
_HEADER_RE = re.compile(r"^#\s+Fixer\s+Summary", re.MULTILINE | re.IGNORECASE)
_SECTION_MARKERS = (
    re.compile(r"^##\s+Findings\b", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^##\s+Verification\s+checks\b", re.MULTILINE | re.IGNORECASE),
    re.compile(r"Total\s+findings\s*:", re.IGNORECASE),
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=_DESCRIPTION)
    parser.add_argument("--input-dir", required=True, type=Path, help="Directory containing .fixer.-tagged .md reports")
    parser.add_argument(
        "--output", required=True, type=Path, help="Absolute path of the final joined report (parent dirs auto-created)"
    )
    return parser.parse_args()


def _find_candidates(input_dir: Path) -> list[Path]:
    return sorted(p for p in input_dir.rglob("*.md") if _FIXER_TAG in p.name and p.is_file())


def _validate(report: Path, reports_dir: Path) -> tuple[bool, str]:
    """Return (is_valid, reason) — mirrors validate_fixer_summary.py checks."""
    try:
        if report.stat().st_size == 0:
            return False, "empty file (0 bytes)"
    except OSError as exc:
        return False, f"cannot stat: {exc}"
    try:
        resolved = report.resolve()
        resolved.relative_to(reports_dir)
    except ValueError:
        return False, "escapes reports-dir"
    except OSError as exc:
        return False, f"resolve failed: {exc}"
    try:
        text = resolved.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return False, f"read failed: {exc}"
    if not _HEADER_RE.search(text):
        return False, "missing '# Fixer Summary' header"
    if not any(marker.search(text) for marker in _SECTION_MARKERS):
        return False, "missing required section markers"
    return True, ""


def _write_joined(valid: list[Path], rejected: list[tuple[Path, str]], output: Path, input_dir: Path) -> None:
    ts = _dt.datetime.now().astimezone().isoformat(timespec="seconds")
    with output.open("w", encoding="utf-8") as out:
        out.write("# LLM Externalizer — Final Fixer Report\n\n")
        out.write(f"- Generated (local with UTC offset): {ts}\n")
        out.write(f"- Valid summaries joined: {len(valid)}\n")
        out.write(f"- Rejected (validation failed): {len(rejected)}\n")
        out.write(f"- Input dir: `{input_dir}`\n\n")
        if rejected:
            out.write("## Rejected summaries\n\n")
            for path, reason in rejected:
                out.write(f"- `{path.name}` — {reason}\n")
            out.write("\n")
        out.write("---\n\n")
        for index, report in enumerate(valid, start=1):
            out.write(f"## [{index}/{len(valid)}] {report.name}\n\n")
            out.write(f"Source report: `{report}`\n\n")
            try:
                content = report.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                out.write(f"<!-- ERROR reading report {report}: {exc} -->\n\n")
                content = ""
            out.write(content)
            if not content.endswith("\n"):
                out.write("\n")
            out.write("\n---\n\n")


def main() -> int:
    args = _parse_args()
    input_dir: Path = args.input_dir
    output: Path = args.output

    if not input_dir.is_dir():
        print(f"ERROR: input dir not found or not a directory: {input_dir}", file=sys.stderr)
        return 2

    reports_dir = input_dir.resolve()
    candidates = _find_candidates(input_dir)
    if not candidates:
        print(f"ERROR: no {_FIXER_TAG}-tagged .md reports in {input_dir}", file=sys.stderr)
        return 3

    valid: list[Path] = []
    rejected: list[tuple[Path, str]] = []
    for path in candidates:
        ok, reason = _validate(path, reports_dir)
        if ok:
            valid.append(path)
        else:
            rejected.append((path, reason))

    if not valid:
        print(f"ERROR: all {len(candidates)} {_FIXER_TAG} reports failed validation", file=sys.stderr)
        for path, reason in rejected:
            print(f"  - {path.name}: {reason}", file=sys.stderr)
        return 5

    try:
        output.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"ERROR: cannot create output parent {output.parent}: {exc}", file=sys.stderr)
        return 4

    _write_joined(valid, rejected, output, reports_dir)
    print(str(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
