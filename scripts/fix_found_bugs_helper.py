#!/usr/bin/env python3
"""fix_found_bugs_helper — backend for the llm-externalizer-fix-found-bugs command.

Each subcommand does one mechanical task (report aggregation, path resolution,
canonical-format check, state counting, snapshot diffing, fallback-prompt
templating, output-dir init, summary writing) and prints machine-readable
stdout. The command's prose calls these subcommands instead of restating the
logic.

Typical orchestration:

    # If a merged report is supplied as an argument:
    fix_found_bugs_helper.py aggregate-reports \\
        --merged-report /abs/path/merged.md \\
        --output /abs/path/reports/llm-externalizer/<RUN_TS>.fix-found-bugs.bugs-to-fix.md

    # Otherwise, scan the default reports dir for per-file reports that still
    # contain unfixed bugs (i.e. no '.fixer.' sibling indicating prior success),
    # aggregate findings across all auditors (ensemble responses) for each
    # source file, and emit a canonical fix-bugs list:
    fix_found_bugs_helper.py aggregate-reports \\
        --reports-dir ./reports/llm-externalizer \\
        --skip-if-fixer-exists \\
        --output /abs/path/reports/llm-externalizer/<RUN_TS>.fix-found-bugs.bugs-to-fix.md

    # Then the fix-found-bugs loop runs:
    fix_found_bugs_helper.py init-run
    fix_found_bugs_helper.py count --file <bug-list>
    # loop: dispatch bug-fixer subagent, diff-fixed, repeat
    fix_found_bugs_helper.py save-summary --file <bug-list> --output <SUMMARY>

Run `python3 fix_found_bugs_helper.py --help` for the full subcommand list, or
`python3 fix_found_bugs_helper.py <subcommand> --help` for per-command flags.
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

# ── Output layout ────────────────────────────────────────────────────────────

REPORTS_SUBDIR = Path("reports") / "llm-externalizer"
TS_FORMAT = "%Y%m%dT%H%M%S%z"


def _now_ts() -> str:
    """Local time, ISO-8601 basic, with UTC offset. Sortable."""
    return datetime.now().astimezone().strftime(TS_FORMAT)


def _reports_dir(base: str | None) -> Path:
    """Return absolute path to <base>/reports/llm-externalizer, creating it."""
    root = Path(base).expanduser().resolve() if base else Path.cwd().resolve()
    target = (root / REPORTS_SUBDIR).resolve()
    target.mkdir(parents=True, exist_ok=True)
    return target


# ── Canonical bug-file regexes ───────────────────────────────────────────────

CANONICAL_SEVERITIES = {"## High severity", "## Medium severity", "## Low severity"}
BUG_HEADING_RE = re.compile(r"^### \d+\. .+$")
FIXED_HEADING_RE = re.compile(r"^### .*\bFIXED\b.*$")
ANY_H3_RE = re.compile(r"^### ")
ANY_H2_RE = re.compile(r"^## ")
BULLET_BUG_RE = re.compile(r"^- \*\*[^*]+\*\*")
SEVERITY_WORD_RE = re.compile(r"\b(critical|high|medium|low|minor)\b", re.IGNORECASE)

# ── LLM-Externalizer report parsing regexes ──────────────────────────────────

INPUT_FILE_RE = re.compile(
    r"^\s*-?\s*\*\*\s*(?:Input\s*file|Source(?:\s*file)?|File)\s*:?\s*\*\*\s*:?\s*"
    r"`?(?P<path>[^\n`]+?)`?\s*$",
    re.MULTILINE | re.IGNORECASE,
)
FILE_HEADING_RE = re.compile(
    r"^##\s+File:\s*`?(?P<path>[^\n`]+?)`?\s*$", re.MULTILINE
)
RESPONSE_HEADER_RE = re.compile(
    r"^##\s+Response\b[^\n]*?(?:\(\s*(?:Model\s*:\s*)?(?P<model>[^)]+?)\s*\))?\s*$",
    re.MULTILINE,
)
# A "finding" is either a ### heading or a numbered list item at column 0.
# Numbered items must be followed by whitespace so we don't match version refs.
FINDING_H3_RE = re.compile(r"^###\s+(?P<title>.+?)\s*$", re.MULTILINE)
FINDING_NUM_RE = re.compile(r"^(?P<num>\d+)\.\s+(?P<title>.+?)\s*$", re.MULTILINE)
# Sidecar-file markers (names we never treat as bug reports)
SIDECAR_MARKERS = (
    ".fixer.",
    ".final-report.",
    ".summary.",
    ".snapshot.",
    ".initial-state.",
    ".progress.",
    ".bugs-to-fix.",
    "fix-bugs.",
    "fix-found-bugs.",
)

# ── Severity keyword tables ──────────────────────────────────────────────────

HIGH_KEYWORDS = {
    "security vulnerability",
    "security issue",
    "exploit",
    "injection",
    "sql injection",
    "xss",
    "csrf",
    "ssrf",
    "auth bypass",
    "authentication bypass",
    "authorization bypass",
    "privilege escalation",
    "path traversal",
    "remote code execution",
    "rce",
    "unsafe deserialization",
    "secret exposure",
    "credential leak",
    "crash",
    "segfault",
    "data loss",
    "data corruption",
    "race condition",
    "deadlock",
    "infinite loop",
    "unbounded growth",
    "memory leak",
    "buffer overflow",
    "integer overflow",
    "null deref",
    "use-after-free",
    "double free",
    "logic bug",
    "off-by-one",
    "broken reference",
}
LOW_KEYWORDS = {
    "code style",
    "naming convention",
    "readability",
    "consider using",
    "could be more",
    "suggestion",
    "nitpick",
    "minor",
    "typo in comment",
    "refactoring opportunity",
    "cosmetic",
    "documentation",
    "docstring",
    "missing comment",
}

# ── Fallback prompt (general-purpose dispatch) ───────────────────────────────

FALLBACK_PROMPT_TEMPLATE = """You are fixing exactly ONE bug from the markdown file at {path}.

Rules:
1. Read {path}. The highest-severity unfixed bug is the first '### ' heading under '## High severity' (then Medium, then Low) that does NOT contain the word FIXED.
2. Read the code files referenced by that bug entry. Understand the root cause — do not pattern-match a shallow fix.
3. Implement the fix using Edit / Write.
4. Regression check: re-read your diff and trace the modified code paths. If you introduced a new bug, fix it in the same iteration. If you discover a pre-existing bug that wasn't listed, append it as a new '### N. <title>' entry under the appropriate '## <severity> severity' section — do NOT fix it this iteration.
5. Update the target bug's entry: append ' — FIXED' to its '### ' heading, and rewrite its body to describe (a) what the bug was and (b) what the fix was. Keep it concise — match the style of existing FIXED entries.
6. Do NOT commit. Do NOT touch any other unfixed bug. Do NOT run the app.
7. Return EXACTLY ONE LINE to the orchestrator: 'Fixed: <bug title>' on success, or '[FAILED] <one-line reason>' if you couldn't make progress.
"""

# ── Helpers ──────────────────────────────────────────────────────────────────


def _read_lines(path: str) -> list[str]:
    return Path(path).read_text(encoding="utf-8").splitlines()


def _titles(path: str) -> tuple[list[str], list[str]]:
    lines = _read_lines(path)
    all_titles: list[str] = []
    fixed_titles: list[str] = []
    for line in lines:
        if not ANY_H3_RE.match(line):
            continue
        stripped = re.sub(r"^### ", "", line)
        stripped = re.sub(r"\s*[—-]?\s*FIXED.*$", "", stripped).strip()
        all_titles.append(stripped)
        if FIXED_HEADING_RE.match(line):
            fixed_titles.append(stripped)
    return all_titles, fixed_titles


def _classify_severity(title: str, body: str) -> str:
    text = (title + " " + body).lower()
    for kw in HIGH_KEYWORDS:
        if kw in text:
            return "High"
    for kw in LOW_KEYWORDS:
        if kw in text:
            return "Low"
    return "Medium"


def _is_sidecar(name: str) -> bool:
    lower = name.lower()
    return any(marker in lower for marker in SIDECAR_MARKERS)


def _extract_source_file(text: str, default: str) -> str:
    m = INPUT_FILE_RE.search(text)
    if m:
        return m.group("path").strip()
    m = FILE_HEADING_RE.search(text)
    if m:
        return m.group("path").strip()
    return default


def _extract_findings_from_section(
    section: str, source_file: str, auditor: str | None = None
) -> list[dict]:
    """Pull findings out of a report section. A finding is either a '### '
    heading or a numbered list item. The body runs until the next finding
    marker or the end of the section.
    """
    # Locate all finding start positions (heading or numbered item)
    markers: list[tuple[int, str, str]] = []  # (offset, title, kind)
    for m in FINDING_H3_RE.finditer(section):
        title = m.group("title").strip()
        # Skip well-known non-finding ### headings emitted by the report format
        if title.lower() in {"findings", "issues", "bugs", "summary"}:
            continue
        markers.append((m.start(), title, "h3"))
    for m in FINDING_NUM_RE.finditer(section):
        # Numbered items inside fenced code blocks would be false positives;
        # the simple regex above doesn't check for that, so filter obvious ones.
        title = m.group("title").strip()
        if len(title) < 3:
            continue
        markers.append((m.start(), title, "num"))
    markers.sort(key=lambda t: t[0])
    if not markers:
        return []
    findings: list[dict] = []
    for i, (offset, title, _) in enumerate(markers):
        # Body runs from end-of-title-line to next marker (or end)
        next_offset = markers[i + 1][0] if i + 1 < len(markers) else len(section)
        body_start = section.find("\n", offset)
        if body_start == -1 or body_start >= next_offset:
            body = ""
        else:
            body = section[body_start + 1 : next_offset].strip()
        findings.append(
            {
                "source_file": source_file,
                "title": title,
                "body": body,
                "auditor": auditor,
            }
        )
    return findings


def _parse_report(path: Path) -> list[dict]:
    """Parse one llm-externalizer report into a list of findings dicts.

    Handles three shapes:
      1. Merged report (multiple '## File:' sections) — parse each per-file
         section and collect findings.
      2. Ensemble per-file report (multiple '## Response' sections) — collect
         findings from each auditor, annotated with the model name.
      3. Single-model per-file report — treat the whole body as one section.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    # Merged?
    file_matches = list(FILE_HEADING_RE.finditer(text))
    if len(file_matches) >= 2:
        findings: list[dict] = []
        for i, m in enumerate(file_matches):
            source = m.group("path").strip()
            start = m.end()
            end = file_matches[i + 1].start() if i + 1 < len(file_matches) else len(text)
            findings.extend(_extract_findings_from_section(text[start:end], source))
        return findings
    # Single file — extract source then check for ensemble
    source = _extract_source_file(text, default=path.stem)
    response_matches = list(RESPONSE_HEADER_RE.finditer(text))
    if len(response_matches) >= 2:
        findings = []
        for i, m in enumerate(response_matches):
            model = (m.group("model") or "unknown").strip()
            start = m.end()
            end = (
                response_matches[i + 1].start()
                if i + 1 < len(response_matches)
                else len(text)
            )
            findings.extend(
                _extract_findings_from_section(text[start:end], source, auditor=model)
            )
        return findings
    # Single-model: strip the '# Report' header block heuristically
    header_end = 0
    for m in re.finditer(r"^##?\s+\S", text, re.MULTILINE):
        header_end = m.start()
        break
    body = text[header_end:] if header_end else text
    return _extract_findings_from_section(body, source)


def _find_report_files(reports_dir: Path, skip_if_fixer_exists: bool) -> list[Path]:
    if not reports_dir.is_dir():
        return []
    candidates = [p for p in reports_dir.iterdir() if p.is_file() and p.suffix == ".md"]
    candidates = [p for p in candidates if not _is_sidecar(p.name)]
    if not skip_if_fixer_exists:
        return sorted(candidates)
    # Filter: skip any report whose stem prefix matches a '.fixer.' sibling
    fixer_prefixes: set[str] = set()
    for p in reports_dir.iterdir():
        if p.is_file() and ".fixer." in p.name.lower():
            # prefix = everything up to the '.fixer.' marker
            idx = p.name.lower().find(".fixer.")
            fixer_prefixes.add(p.name[:idx])
    kept: list[Path] = []
    for p in candidates:
        if any(p.name.startswith(prefix) for prefix in fixer_prefixes):
            continue
        kept.append(p)
    return sorted(kept)


# ── Subcommand: aggregate-reports ────────────────────────────────────────────


def cmd_aggregate_reports(args: argparse.Namespace) -> int:
    """Parse llm-externalizer per-file or merged reports and emit a canonical
    fix-bugs list. This is the entry point for the fix-found-bugs command.
    """
    if args.merged_report and args.reports_dir:
        print(
            "ERROR: pass EITHER --merged-report OR --reports-dir, not both",
            file=sys.stderr,
        )
        return 1
    if args.merged_report:
        merged = Path(args.merged_report).expanduser().resolve()
        if not merged.is_file():
            print(f"ERROR: merged report not found: {merged}", file=sys.stderr)
            return 1
        report_files = [merged]
        source_label = f"merged report {merged}"
    else:
        reports_dir = Path(args.reports_dir).expanduser().resolve()
        if not reports_dir.is_dir():
            print(f"ERROR: reports directory not found: {reports_dir}", file=sys.stderr)
            return 1
        report_files = _find_report_files(reports_dir, args.skip_if_fixer_exists)
        source_label = f"{len(report_files)} report(s) from {reports_dir}"
    findings: list[dict] = []
    for rpath in report_files:
        findings.extend(_parse_report(rpath))
    if not findings:
        print(
            f"WARNING: no findings aggregated from {source_label}", file=sys.stderr
        )
        # Still write an (empty) canonical file so the caller can handle it uniformly
    # Group findings by severity
    severity_groups: dict[str, list[dict]] = {"High": [], "Medium": [], "Low": []}
    for f in findings:
        sev = _classify_severity(f["title"], f["body"])
        severity_groups[sev].append(f)
    # Emit the canonical bug file
    lines: list[str] = [
        "# Bugs to fix — aggregated from llm-externalizer reports",
        "",
        f"- Source: {source_label}",
        f"- Generated: `{_now_ts()}`",
        f"- Total findings: {len(findings)}",
        "",
    ]
    counter = 0
    for sev in ("High", "Medium", "Low"):
        items = severity_groups[sev]
        if not items:
            continue
        lines.append(f"## {sev} severity")
        lines.append("")
        for item in items:
            counter += 1
            title = item["title"].strip()
            # Keep titles short but informative
            if len(title) > 120:
                title = title[:117] + "..."
            lines.append(f"### {counter}. {title}")
            lines.append("")
            lines.append(f"**File:** `{item['source_file']}`")
            if item.get("auditor"):
                lines.append(f"**Reported by:** `{item['auditor']}`")
            lines.append("")
            body = item["body"].strip()
            if body:
                lines.append(body)
                lines.append("")
    out = Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print(str(out.resolve()))
    return 0


# ── Subcommand: resolve-path ─────────────────────────────────────────────────


def cmd_resolve_path(args: argparse.Namespace) -> int:
    raw = args.arg.lstrip("@").strip()
    if not raw:
        print(
            "ERROR: argument is empty; tag the bug file with @ (e.g. /fix-bugs @BUGS.md)",
            file=sys.stderr,
        )
        return 1
    path = Path(raw).expanduser().resolve()
    if not path.is_file():
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        return 1
    print(str(path))
    return 0


# ── Subcommand: is-canonical ─────────────────────────────────────────────────


def cmd_is_canonical(args: argparse.Namespace) -> int:
    lines = _read_lines(args.file)
    reasons: list[str] = []
    for i, line in enumerate(lines, start=1):
        if ANY_H3_RE.match(line) and not BUG_HEADING_RE.match(line):
            reasons.append(
                f"line {i}: ### heading is not '### N. Title' form: {line!r}"
            )
        if ANY_H2_RE.match(line):
            stripped = line.strip()
            if stripped not in CANONICAL_SEVERITIES and SEVERITY_WORD_RE.search(stripped):
                reasons.append(f"line {i}: non-canonical severity section: {line!r}")
        if BULLET_BUG_RE.match(line):
            reasons.append(
                f"line {i}: bullet-item bug (must be promoted to '### N. Title'): {line!r}"
            )
    if reasons:
        for r in reasons[:5]:
            print(r, file=sys.stderr)
        if len(reasons) > 5:
            print(f"... and {len(reasons) - 5} more", file=sys.stderr)
        return 1
    return 0


# ── Subcommand: count ────────────────────────────────────────────────────────


def cmd_count(args: argparse.Namespace) -> int:
    all_titles, fixed_titles = _titles(args.file)
    total = len(all_titles)
    fixed = len(fixed_titles)
    unfixed = total - fixed
    max_iter = max(unfixed * 2 + 5, 5)
    print(f"TOTAL={total} FIXED={fixed} UNFIXED={unfixed} MAX_ITER={max_iter}")
    return 0


# ── Subcommand: fixed-titles ─────────────────────────────────────────────────


def cmd_fixed_titles(args: argparse.Namespace) -> int:
    _, fixed_titles = _titles(args.file)
    for t in sorted(fixed_titles):
        print(t)
    return 0


# ── Subcommand: diff-fixed ───────────────────────────────────────────────────


def cmd_diff_fixed(args: argparse.Namespace) -> int:
    _, cur_fixed_list = _titles(args.file)
    cur_fixed = set(cur_fixed_list)
    prev: set[str] = set()
    prev_path = Path(args.previous)
    if prev_path.is_file():
        for line in prev_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                prev.add(line.strip())
    newly_fixed = sorted(cur_fixed - prev)
    all_titles, _ = _titles(args.file)
    unfixed_now = len(all_titles) - len(cur_fixed_list)
    for t in newly_fixed:
        print(f"Fixed: {t} — {unfixed_now} unfixed remaining")
    return 0


# ── Subcommand: print-fallback-prompt ────────────────────────────────────────


def cmd_print_fallback_prompt(args: argparse.Namespace) -> int:
    sys.stdout.write(FALLBACK_PROMPT_TEMPLATE.format(path=args.file))
    return 0


# ── Subcommand: timestamp ────────────────────────────────────────────────────


def cmd_timestamp(args: argparse.Namespace) -> int:
    del args
    print(_now_ts())
    return 0


# ── Subcommand: init-run ─────────────────────────────────────────────────────


def cmd_init_run(args: argparse.Namespace) -> int:
    ts = _now_ts()
    outdir = _reports_dir(args.base)
    print(f"RUN_TS={ts}")
    print(f"OUTDIR={outdir}")
    print(f"BUGS_TO_FIX={outdir / f'{ts}.fix-found-bugs.bugs-to-fix.md'}")
    print(f"INITIAL_STATE={outdir / f'{ts}.fix-found-bugs.initial-state.txt'}")
    print(f"SNAPSHOT={outdir / f'{ts}.fix-found-bugs.snapshot.txt'}")
    print(f"SUMMARY={outdir / f'{ts}.fix-found-bugs.summary.md'}")
    print(f"PROGRESS_LOG={outdir / f'{ts}.fix-found-bugs.progress.log'}")
    return 0


# ── Subcommand: save-summary ─────────────────────────────────────────────────


def cmd_save_summary(args: argparse.Namespace) -> int:
    all_titles, fixed_titles = _titles(args.file)
    total = len(all_titles)
    fixed = len(fixed_titles)
    unfixed = total - fixed
    fixed_set = set(fixed_titles)
    unfixed_titles = [t for t in all_titles if t not in fixed_set]
    ts = _now_ts()
    lines: list[str] = [
        "# fix-found-bugs run summary",
        "",
        f"- Generated: `{ts}`",
        f"- Bug file: `{args.file}`",
        f"- Total bugs: {total}",
        f"- Fixed: {fixed}",
        f"- Unfixed: {unfixed}",
    ]
    if args.run_start_ts:
        lines.append(f"- Run started: `{args.run_start_ts}`")
    lines.append("")
    lines.append("## Fixed this inventory")
    lines.append("")
    if fixed_titles:
        for t in fixed_titles:
            lines.append(f"- {t}")
    else:
        lines.append("_(none)_")
    lines.append("")
    lines.append("## Still unfixed")
    lines.append("")
    if unfixed_titles:
        for t in unfixed_titles:
            lines.append(f"- {t}")
    else:
        lines.append("_(none — all bugs fixed)_")
    lines.append("")
    out_path = Path(args.output).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(str(out_path.resolve()))
    return 0


# ── Main parser ──────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fix_found_bugs_helper",
        description=(
            "Backend helper for the llm-externalizer-fix-found-bugs command. "
            "Each subcommand does one mechanical task and prints "
            "machine-readable stdout. The command prose calls these instead "
            "of restating the logic."
        ),
        epilog=(
            "Typical orchestration flow:\n"
            "  1. aggregate-reports [--merged-report F | --reports-dir D] --output BUGS_TO_FIX\n"
            "     (scans llm-externalizer reports OR a single merged report and emits a\n"
            "      canonical fix-bugs list grouped into High/Medium/Low severity sections)\n"
            "  2. init-run                                   -> RUN_TS, OUTDIR, paths...\n"
            "  3. count --file $BUGS_TO_FIX                  -> TOTAL/UNFIXED/MAX_ITER\n"
            "  4. fixed-titles --file $BUGS_TO_FIX > $SNAPSHOT\n"
            "  5. (dispatch llm-externalizer-serial-fixer-agent subagent per iteration)\n"
            "  6. diff-fixed --file $BUGS_TO_FIX --previous $SNAPSHOT\n"
            "  7. save-summary --file $BUGS_TO_FIX --output $SUMMARY\n"
            "\n"
            "Output location: all persistent artifacts land under\n"
            "<cwd>/reports/llm-externalizer/ with a sortable local-TZ\n"
            "ISO-8601 prefix (e.g. 20260418T153045+0200.fix-found-bugs.summary.md)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True, metavar="SUBCOMMAND")

    p = sub.add_parser(
        "aggregate-reports",
        help=(
            "Parse llm-externalizer per-file reports (or a single merged report) "
            "and emit a canonical fix-bugs list. Handles ensemble mode (3 "
            "per-model 'Response' sections per report) by collecting findings "
            "from each auditor. Assigns severity via keyword heuristics."
        ),
    )
    p.add_argument(
        "--reports-dir",
        metavar="DIR",
        default=None,
        help="Directory to scan for per-file reports (e.g. ./reports/llm-externalizer). Mutually exclusive with --merged-report.",
    )
    p.add_argument(
        "--merged-report",
        metavar="PATH",
        default=None,
        help="Single merged report (answer_mode=2 output). Only this file's findings are aggregated. Mutually exclusive with --reports-dir.",
    )
    p.add_argument(
        "--skip-if-fixer-exists",
        action="store_true",
        help="When scanning a directory, skip any report that has a '.fixer.' sibling (i.e. was already processed by scan-and-fix).",
    )
    p.add_argument(
        "--output",
        required=True,
        metavar="PATH",
        help="Output path for the canonical bug-list markdown (typically the BUGS_TO_FIX path from init-run).",
    )
    p.set_defaults(func=cmd_aggregate_reports)

    p = sub.add_parser(
        "resolve-path",
        help="Resolve an @-tagged or bare bug-file path to absolute form. Exit 1 if missing/invalid.",
    )
    p.add_argument(
        "--arg",
        required=True,
        metavar="ARG",
        help="Raw $ARGUMENTS from the command invocation (may include a leading @).",
    )
    p.set_defaults(func=cmd_resolve_path)

    p = sub.add_parser(
        "is-canonical",
        help="Check whether a bug file matches the canonical format. Exit 0 = canonical, 1 = needs normalisation.",
    )
    p.add_argument("--file", required=True, metavar="PATH", help="Absolute path to the bug file.")
    p.set_defaults(func=cmd_is_canonical)

    p = sub.add_parser(
        "count",
        help="Print TOTAL, FIXED, UNFIXED, and MAX_ITER (= max(UNFIXED * 2 + 5, 5)) as shell-parseable key=value pairs.",
    )
    p.add_argument("--file", required=True, metavar="PATH", help="Absolute path to the bug file.")
    p.set_defaults(func=cmd_count)

    p = sub.add_parser(
        "fixed-titles",
        help="Print all FIXED bug titles, one per line (sorted). Snapshot this between iterations for diff-fixed.",
    )
    p.add_argument("--file", required=True, metavar="PATH", help="Absolute path to the bug file.")
    p.set_defaults(func=cmd_fixed_titles)

    p = sub.add_parser(
        "diff-fixed",
        help="Print titles FIXED since a previous fixed-titles snapshot. Output: 'Fixed: <title> — N unfixed remaining' per newly-FIXED bug.",
    )
    p.add_argument("--file", required=True, metavar="PATH", help="Absolute path to the bug file (current state).")
    p.add_argument(
        "--previous", required=True, metavar="SNAPSHOT",
        help="Path to the previous 'fixed-titles' snapshot file.",
    )
    p.set_defaults(func=cmd_diff_fixed)

    p = sub.add_parser(
        "print-fallback-prompt",
        help="Print the fix-one-bug prompt for a general-purpose Task dispatch (used when the custom llm-externalizer-serial-fixer-agent is NOT installed).",
    )
    p.add_argument(
        "--file", required=True, metavar="PATH",
        help="Absolute path to the bug file; substituted into the prompt template.",
    )
    p.set_defaults(func=cmd_print_fallback_prompt)

    p = sub.add_parser(
        "timestamp",
        help="Print a fresh sortable local-timezone ISO-8601 basic timestamp (e.g. 20260418T153045+0200).",
    )
    p.set_defaults(func=cmd_timestamp)

    p = sub.add_parser(
        "init-run",
        help=(
            "Create ./reports/llm-externalizer/ (relative to --base or cwd) and "
            "emit the full set of TS-prefixed output paths as shell-parseable "
            "lines: RUN_TS, OUTDIR, BUGS_TO_FIX, INITIAL_STATE, SNAPSHOT, "
            "SUMMARY, PROGRESS_LOG."
        ),
    )
    p.add_argument(
        "--base", metavar="DIR", default=None,
        help="Base directory (default: current working directory).",
    )
    p.set_defaults(func=cmd_init_run)

    p = sub.add_parser(
        "save-summary",
        help="Write a final markdown summary (counts + FIXED/unfixed title lists) of the current bug file state to --output.",
    )
    p.add_argument("--file", required=True, metavar="PATH", help="Absolute path to the bug file.")
    p.add_argument("--output", required=True, metavar="PATH", help="Output path (typically SUMMARY from init-run).")
    p.add_argument(
        "--run-start-ts", metavar="TS", default=None,
        help="Optional: the RUN_TS from init-run, included in the summary for audit.",
    )
    p.set_defaults(func=cmd_save_summary)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
