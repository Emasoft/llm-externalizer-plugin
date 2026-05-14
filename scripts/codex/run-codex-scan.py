#!/usr/bin/env -S uv run --python 3.12 --script
# /// script
# dependencies = []
# requires-python = ">=3.12"
# ///
"""run-codex-scan.py — Externalize a per-file scan to OpenAI GPT-5.5 via Codex.

Invokes `codex exec` with the multi-agent feature enabled and the
per-file scan prompt template (`codex-scan-prompts.md`). On rate-limit
or token-limit response from Codex, falls back to spawning an Opus
subagent for the remaining batches.

The output is N per-batch markdown reports under the user-specified
output directory (default: `$MAIN_ROOT/reports/llm-externalizer/`).
Each report is a sequence of `## File: <path>` sections matching the
shape that `splitPerFileSections` (mcp-server/src/grouping.ts)
expects, so the existing parallel-fixer / serial-fixer agents can
consume the output without modification.

Usage:
  run-codex-scan.py --folder /path/to/src --ext .py,.ts
  run-codex-scan.py --files file1.py file2.ts --out-dir /tmp/reports
  run-codex-scan.py --folder /path/to/src --max-bytes-per-batch 400000

Exit codes:
  0 — all batches completed (possibly with Opus fallback on some)
  1 — invalid arguments / Codex not installed AND no Opus fallback available
  2 — Codex AND Opus both failed (no review produced)
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

# ── Constants ────────────────────────────────────────────────────────

# Codex CLI rate-limit / token-limit detection patterns. We scan stderr
# (and stdout, since Codex sometimes mixes them) for any of these.
# Be conservative: false positives just trigger fallback, false negatives
# leave the user with a cryptic Codex error and no fallback.
RATE_LIMIT_PATTERNS = [
    re.compile(r"\brate.?limit", re.IGNORECASE),
    re.compile(r"\bquota.?exceed", re.IGNORECASE),
    re.compile(r"\b429\b"),
    re.compile(r"\btoken.?limit", re.IGNORECASE),
    re.compile(r"\busage.?cap", re.IGNORECASE),
    re.compile(r"\binsufficient.?credit", re.IGNORECASE),
]

# Files whose extension we never scan (binary or LFS-managed).
SKIP_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
    ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
    ".mp3", ".mp4", ".wav", ".mov", ".avi",
    ".woff", ".woff2", ".ttf", ".eot",
    ".so", ".dylib", ".dll", ".exe", ".bin",
    ".pyc", ".pyo", ".class", ".jar", ".o",
    ".lock", ".min.js", ".min.css",
})

# Default per-batch payload cap. Chosen to fit comfortably within
# GPT-5.5's context window with room for the prompt + response.
DEFAULT_MAX_BYTES_PER_BATCH = 200_000

# How many concurrent codex invocations we permit. Codex exec is
# itself a heavyweight LLM call, so 1 (sequential) is the safe default.
# Increase only if you've verified Codex's rate-limiter won't block on
# burst.
DEFAULT_CONCURRENCY = 1


@dataclass
class Batch:
    """One LLM call's worth of files. The wrapper bin-packs each batch
    up to `max_bytes_per_batch` using First-Fit Decreasing — the same
    algorithm llm-externalizer's MCP server uses for the OpenRouter
    backend."""
    paths: list[Path]
    total_bytes: int


@dataclass
class BatchResult:
    """Outcome of one batch invocation."""
    batch_index: int
    report_path: Path
    backend: str   # 'codex' or 'opus-fallback'
    elapsed_sec: float
    findings_count: int  # parsed from the report, best-effort


# ── Codex detection + setup ─────────────────────────────────────────


def find_codex() -> Path | None:
    """Return the resolved path to the Codex binary, or None."""
    p = shutil.which("codex")
    return Path(p) if p else None


def ensure_codex_multi_agent_config() -> None:
    """Mirror review-loop-opus's setup: ensure `multi_agent = true` is
    set in `~/.codex/config.toml`. Idempotent."""
    config = Path.home() / ".codex" / "config.toml"
    if not config.exists():
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text("[features]\nmulti_agent = true\n", encoding="utf-8")
        print(f"[codex-scan] Created {config} with multi_agent enabled", file=sys.stderr)
        return
    text = config.read_text(encoding="utf-8", errors="replace")
    if re.search(r"^\s*multi_agent\s*=\s*true", text, re.MULTILINE):
        return
    if re.search(r"^\[features\]", text, re.MULTILINE):
        text = re.sub(r"^\[features\]\s*\n", "[features]\nmulti_agent = true\n",
                       text, count=1, flags=re.MULTILINE)
    else:
        text = text.rstrip() + "\n\n[features]\nmulti_agent = true\n"
    config.write_text(text, encoding="utf-8")
    print(f"[codex-scan] Enabled multi_agent in {config}", file=sys.stderr)


# ── File discovery + bin packing ─────────────────────────────────────


def discover_files(
    folder: Path | None,
    extensions: list[str] | None,
    explicit_files: list[Path],
    use_gitignore: bool = True,
) -> list[Path]:
    """Find files to scan.

    If `explicit_files` is provided, use those (filtered by binary
    check). Otherwise walk `folder` and pick files matching
    `extensions`. Honors `.gitignore` when `use_gitignore` is True
    (uses `git ls-files`).
    """
    if explicit_files:
        return [p for p in explicit_files
                if p.is_file() and p.suffix.lower() not in SKIP_EXTENSIONS]

    if not folder or not folder.is_dir():
        return []

    ext_set: set[str] | None = None
    if extensions:
        ext_set = {e if e.startswith(".") else "." + e for e in extensions}

    if use_gitignore and (folder / ".git").exists():
        # Use git ls-files for honoring .gitignore + tracked files
        try:
            result = subprocess.run(
                ["git", "-C", str(folder), "ls-files"],
                capture_output=True, text=True, timeout=30, check=False,
            )
            if result.returncode == 0:
                paths = []
                for rel in result.stdout.splitlines():
                    p = folder / rel
                    if not p.is_file():
                        continue
                    if p.suffix.lower() in SKIP_EXTENSIONS:
                        continue
                    if ext_set is not None and p.suffix.lower() not in ext_set:
                        continue
                    paths.append(p)
                return paths
        except (subprocess.SubprocessError, OSError):
            pass

    # Fallback: rglob walk
    paths: list[Path] = []
    for p in folder.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() in SKIP_EXTENSIONS:
            continue
        if ext_set is not None and p.suffix.lower() not in ext_set:
            continue
        # Hard-coded excludes for sanity (matches scan_folder)
        parts = {x.lower() for x in p.parts}
        if parts & {"node_modules", ".git", "dist", "build", ".venv",
                    "__pycache__", ".idea", ".vscode", "tmp", "vendor"}:
            continue
        paths.append(p)
    return paths


def pack_batches(paths: list[Path], max_bytes: int) -> list[Batch]:
    """First-Fit Decreasing bin packing into batches up to `max_bytes`."""
    # Annotate each path with its size
    sized: list[tuple[Path, int]] = []
    for p in paths:
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        if sz > max_bytes:
            # Lone file too big — give it its own batch
            sized.append((p, sz))
        else:
            sized.append((p, sz))

    sized.sort(key=lambda x: -x[1])  # Decreasing

    batches: list[Batch] = []
    for path, sz in sized:
        placed = False
        for b in batches:
            if b.total_bytes + sz <= max_bytes:
                b.paths.append(path)
                b.total_bytes += sz
                placed = True
                break
        if not placed:
            batches.append(Batch(paths=[path], total_bytes=sz))
    return batches


# ── Prompt assembly ──────────────────────────────────────────────────


def load_prompt_template() -> str:
    """Read the GPT-5.5 calibrated per-file scan prompt template.

    The template lives in its own .txt file (NOT inside the .md docs)
    so it has zero markdown-escaping ambiguity and the wrapper's
    parser doesn't need to deal with nested fenced blocks. The .md
    file (`codex-scan-prompts.md`) is the human-readable doc; the
    .txt file is what Codex actually sees.
    """
    script_dir = Path(__file__).resolve().parent
    template_path = script_dir / "codex-scan-prompt.txt"
    text = template_path.read_text(encoding="utf-8")
    if "{FILES_BLOCK}" not in text:
        raise RuntimeError(
            f"{template_path} is missing the {{FILES_BLOCK}} placeholder"
        )
    return text


def build_files_block(batch: Batch) -> str:
    """Render the batch's files as the {FILES_BLOCK} placeholder body."""
    parts: list[str] = []
    for p in batch.paths:
        try:
            content = p.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            content = f"(could not read: {e})"
        parts.append(f"## File: {p}\n\n```\n{content}\n```")
    return "\n\n---\n\n".join(parts)


def build_prompt(batch: Batch, template: str) -> str:
    return template.replace("{FILES_BLOCK}", build_files_block(batch))


# ── Codex invocation ────────────────────────────────────────────────


def run_codex(prompt: str, timeout_sec: int = 600) -> tuple[int, str, str]:
    """Invoke `codex exec` with the prompt. Returns (exit_code, stdout, stderr)."""
    codex = find_codex()
    if codex is None:
        return (127, "", "codex binary not found on PATH")
    args = [
        str(codex),
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        prompt,
    ]
    try:
        result = subprocess.run(
            args, capture_output=True, text=True,
            timeout=timeout_sec, check=False,
        )
        return (result.returncode, result.stdout, result.stderr)
    except subprocess.TimeoutExpired as e:
        # e.stdout / e.stderr can be bytes when capture_output but no encoding;
        # since we pass text=True they're str | None, but normalise defensively.
        out = e.stdout if isinstance(e.stdout, str) else (
            e.stdout.decode("utf-8", errors="replace") if isinstance(e.stdout, (bytes, bytearray)) else ""
        )
        err = e.stderr if isinstance(e.stderr, str) else (
            e.stderr.decode("utf-8", errors="replace") if isinstance(e.stderr, (bytes, bytearray)) else f"codex timed out after {timeout_sec}s"
        )
        return (124, out, err)
    except (subprocess.SubprocessError, OSError) as e:
        return (1, "", f"codex invocation failed: {e}")


def looks_like_rate_limit(stdout: str, stderr: str) -> bool:
    """Best-effort detection of rate-limit / token-limit responses."""
    combined = (stdout or "") + "\n" + (stderr or "")
    return any(p.search(combined) for p in RATE_LIMIT_PATTERNS)


# ── Opus fallback ────────────────────────────────────────────────────


def run_opus_fallback(prompt: str, out_path: Path) -> tuple[bool, str]:
    """Fallback to Opus: write the prompt + an instruction file under
    .claude/ so the orchestrator can pick it up.

    This script CANNOT spawn an Agent itself — that's a Claude Code
    primitive. Instead, we write a marker file and return; the
    dispatching command sees the marker and spawns the Opus agent on
    the main session's behalf.

    Returns (success, message).
    """
    fallback_dir = Path.cwd() / ".claude" / "llm-externalizer-codex-fallback"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S%z")
    prompt_path = fallback_dir / f"opus-prompt-{stamp}.txt"
    marker_path = fallback_dir / f"opus-marker-{stamp}.txt"
    prompt_path.write_text(prompt, encoding="utf-8")
    marker_path.write_text(
        f"out: {out_path}\nprompt: {prompt_path}\n"
        f"reason: codex-rate-limit\n"
        f"created: {datetime.now().isoformat()}\n",
        encoding="utf-8",
    )
    return (
        True,
        f"Wrote Opus fallback marker: {marker_path} — orchestrator will dispatch.",
    )


# ── Report writing + finding count ───────────────────────────────────


def write_report(out_dir: Path, batch_index: int, batch: Batch,
                  backend: str, content: str) -> Path:
    """Write the batch report. The content is whatever Codex / Opus
    produced (already shaped as `## File: <path>` sections per the
    prompt template). We prepend a small header for traceability."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S%z")
    fname = f"{stamp}-codex-scan-batch-{batch_index:03d}.md"
    out_path = out_dir / fname
    header_lines = [
        f"<!-- llm-externalizer codex-scan batch {batch_index} -->",
        f"<!-- backend: {backend} -->",
        f"<!-- files in batch: {len(batch.paths)} -->",
        f"<!-- total bytes: {batch.total_bytes} -->",
        f"<!-- generated: {datetime.now().isoformat()} -->",
        "",
    ]
    out_path.write_text("\n".join(header_lines) + content, encoding="utf-8")
    return out_path


def count_findings(report_text: str) -> int:
    """Best-effort count of findings in a report. Looks for the
    severity-tagged line shape `- [<severity>] line N:`."""
    return len(re.findall(
        r"^\s*-\s*\[(?:critical|high|medium|low)\]",
        report_text, re.MULTILINE | re.IGNORECASE,
    ))


# ── Main ─────────────────────────────────────────────────────────────


def resolve_main_root() -> Path:
    """Find the main-repo root using git worktree list (per
    ~/.claude/rules/agent-reports-location.md)."""
    try:
        result = subprocess.run(
            ["git", "worktree", "list"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            first = result.stdout.splitlines()[0]
            # `git worktree list` format: "<path>  <sha> [<branch>]"
            return Path(first.split()[0])
    except (subprocess.SubprocessError, OSError):
        pass
    cpd = os.environ.get("CLAUDE_PROJECT_DIR")
    if cpd:
        return Path(cpd)
    return Path.cwd()


def main() -> int:
    description = (__doc__ or "Run a Codex/GPT-5.5 scan").splitlines()[0]
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--folder", type=Path,
                        help="Folder to scan (recursive). Mutually exclusive with --files.")
    parser.add_argument("--files", type=Path, nargs="*",
                        help="Explicit file paths to scan. Mutually exclusive with --folder.")
    parser.add_argument("--ext", type=str,
                        help="Comma-separated extension filter for --folder (e.g. '.py,.ts').")
    parser.add_argument("--out-dir", type=Path,
                        help="Output directory for reports. Default: $MAIN_ROOT/reports/llm-externalizer/")
    parser.add_argument("--max-bytes-per-batch", type=int,
                        default=DEFAULT_MAX_BYTES_PER_BATCH,
                        help=f"Max bytes per LLM call. Default: {DEFAULT_MAX_BYTES_PER_BATCH}.")
    parser.add_argument("--no-gitignore", action="store_true",
                        help="Walk all files (don't honor .gitignore).")
    parser.add_argument("--no-fallback", action="store_true",
                        help="Abort instead of falling back to Opus when Codex rate-limits.")
    parser.add_argument("--timeout-sec", type=int, default=600,
                        help="Timeout per Codex invocation. Default: 600.")
    args = parser.parse_args()

    if args.folder and args.files:
        print("error: --folder and --files are mutually exclusive", file=sys.stderr)
        return 1
    if not args.folder and not args.files:
        print("error: must provide --folder or --files", file=sys.stderr)
        return 1

    # Decide output dir
    if args.out_dir:
        out_dir = args.out_dir.resolve()
    else:
        main_root = resolve_main_root()
        out_dir = main_root / "reports" / "llm-externalizer"

    # Discover files
    extensions = [e.strip() for e in args.ext.split(",")] if args.ext else None
    explicit_files = [p.resolve() for p in (args.files or [])]
    folder = args.folder.resolve() if args.folder else None
    paths = discover_files(folder, extensions, explicit_files,
                            use_gitignore=not args.no_gitignore)
    if not paths:
        print("error: no files found matching the criteria", file=sys.stderr)
        return 1
    print(f"[codex-scan] Discovered {len(paths)} files", file=sys.stderr)

    # Bin-pack
    batches = pack_batches(paths, args.max_bytes_per_batch)
    print(f"[codex-scan] Packed into {len(batches)} batch(es)", file=sys.stderr)

    # Codex setup
    codex_available = find_codex() is not None
    if codex_available:
        ensure_codex_multi_agent_config()
    elif args.no_fallback:
        print("error: codex not on PATH and --no-fallback set", file=sys.stderr)
        return 1
    else:
        print("[codex-scan] codex not on PATH — using Opus fallback for all batches",
              file=sys.stderr)

    # Load prompt template
    template = load_prompt_template()

    # Process batches
    results: list[BatchResult] = []
    use_codex_for_remaining = codex_available
    for i, batch in enumerate(batches, start=1):
        print(f"[codex-scan] Batch {i}/{len(batches)} "
              f"({len(batch.paths)} files, {batch.total_bytes} bytes)",
              file=sys.stderr)
        prompt = build_prompt(batch, template)
        start = datetime.now()

        if use_codex_for_remaining:
            exit_code, stdout, stderr = run_codex(prompt, timeout_sec=args.timeout_sec)
            if exit_code != 0 and looks_like_rate_limit(stdout, stderr):
                print(f"[codex-scan] Rate-limit detected on batch {i}; "
                      f"falling back to Opus for batch {i}+",
                      file=sys.stderr)
                use_codex_for_remaining = False
                if args.no_fallback:
                    print("error: rate-limit hit and --no-fallback set", file=sys.stderr)
                    return 2
                # Fall through to Opus fallback path below
            elif exit_code != 0:
                print(f"[codex-scan] Codex returned non-zero ({exit_code}) "
                      f"on batch {i} (non-rate-limit). stderr first 500: "
                      f"{(stderr or '')[:500]}",
                      file=sys.stderr)
                if args.no_fallback:
                    return 2
                use_codex_for_remaining = False
            else:
                out_path = write_report(out_dir, i, batch, "codex", stdout)
                elapsed = (datetime.now() - start).total_seconds()
                results.append(BatchResult(
                    batch_index=i, report_path=out_path, backend="codex",
                    elapsed_sec=elapsed, findings_count=count_findings(stdout),
                ))
                continue

        # Opus fallback for this batch
        out_path = out_dir / (
            datetime.now().strftime("%Y%m%d_%H%M%S%z")
            + f"-codex-scan-batch-{i:03d}-opus-pending.md"
        )
        ok, msg = run_opus_fallback(prompt, out_path)
        elapsed = (datetime.now() - start).total_seconds()
        if ok:
            # Write a placeholder report so the user sees something exists
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(
                f"<!-- llm-externalizer codex-scan batch {i} (Opus fallback pending) -->\n"
                f"<!-- {msg} -->\n\n"
                f"## OPUS FALLBACK PENDING\n\n"
                f"The orchestrator should pick up the marker file under "
                f"`.claude/llm-externalizer-codex-fallback/` and spawn an "
                f"Opus agent to produce the actual report.\n",
                encoding="utf-8",
            )
            results.append(BatchResult(
                batch_index=i, report_path=out_path, backend="opus-fallback",
                elapsed_sec=elapsed, findings_count=0,
            ))
        else:
            print(f"[codex-scan] FAILED batch {i}: {msg}", file=sys.stderr)
            return 2

    # Final summary
    codex_batches = sum(1 for r in results if r.backend == "codex")
    opus_batches = sum(1 for r in results if r.backend == "opus-fallback")
    total_findings = sum(r.findings_count for r in results)
    print(f"[codex-scan] Done: {codex_batches} codex, {opus_batches} opus-fallback, "
          f"{total_findings} findings total", file=sys.stderr)
    # Output report paths to stdout (one per line) for orchestrator consumption
    for r in results:
        print(f"{r.report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
