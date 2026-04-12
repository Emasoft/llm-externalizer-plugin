#!/usr/bin/env python3
"""Publish a new release: bump version, update changelog, tag, push, create GitHub release.

Usage:
    uv run scripts/publish.py              # bump patch (default)
    uv run scripts/publish.py --patch      # 3.2.0 -> 3.2.1
    uv run scripts/publish.py --minor      # 3.2.0 -> 3.3.0
    uv run scripts/publish.py --major      # 3.2.0 -> 4.0.0
    uv run scripts/publish.py --set 4.0.0  # explicit version
    uv run scripts/publish.py --dry-run    # preview without changes
    uv run scripts/publish.py --check-only # run full check suite only

Push policy:
    Direct `git push` is REFUSED by the pre-push hook (.githooks/pre-push).
    The only path to push is this script. The hook uses PROCESS ANCESTRY
    (walks parent PIDs via `ps`) to verify publish.py is the caller — not
    a lock file, not an env var, nothing spoofable. Since subprocess.run
    spawns git as a child of this script's Python interpreter, publish.py
    will be the grandparent of the hook whenever the push comes from here.
    No bypass exists.

Steps (in order — validate is FIRST, no skipping):
    1. Pre-flight: working tree clean + required tools present
    2. Validate (MANDATORY — all checks 0 errors): npm ci, typecheck,
       lint, build, test, ruff, shellcheck, plugin.json, CPV
    3. Determine next version (git-cliff --bumped-version or flag override)
    4. Generate CHANGELOG.md (git-cliff)
    5. Sync version to plugin.json, package.json, server.json, index.ts
    6. Rebuild dist (with new version)
    7. Update README.md badges
    8. Commit as `chore(release): vX.Y.Z`
    9. Create annotated git tag vX.Y.Z
   10. Push --follow-tags (pre-push hook walks ancestry, finds publish.py)
   11. gh release create
"""

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


def update_readme_badges(readme_path: Path, version: str, build_ok: bool) -> bool:
    """Update shields.io badges between <!--BADGES-START--> and <!--BADGES-END--> markers.

    Returns True if badges were updated, False if markers not found.
    """
    if not readme_path.exists():
        return False
    content = readme_path.read_text(encoding="utf-8")
    start_marker = "<!--BADGES-START-->"
    end_marker = "<!--BADGES-END-->"
    start_idx = content.find(start_marker)
    end_idx = content.find(end_marker)
    if start_idx == -1 or end_idx == -1:
        return False
    build_color = "brightgreen" if build_ok else "red"
    build_label = "passing" if build_ok else "failing"
    badges = f"""{start_marker}
![version](https://img.shields.io/badge/version-{version}-blue)
![build](https://img.shields.io/badge/build-{build_label}-{build_color})
![typescript](https://img.shields.io/badge/typescript-5.x-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)
![marketplace](https://img.shields.io/badge/marketplace-emasoft--plugins-purple)
{end_marker}"""
    new_content = content[:start_idx] + badges + content[end_idx + len(end_marker):]
    readme_path.write_text(new_content, encoding="utf-8")
    return True


def run(
    cmd: list[str], *, check: bool = True, capture: bool = True, cwd: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a command, printing it first. Fail-fast on error."""
    print(f"  $ {shlex.join(cmd)}")
    return subprocess.run(cmd, check=check, capture_output=capture, text=True, cwd=cwd)


def bump_version(current: str, part: str) -> str:
    """Bump a semver string by the specified part."""
    parts = current.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        print(f"ERROR: '{current}' is not valid semver (x.y.z)", file=sys.stderr)
        sys.exit(1)
    major, minor, patch = int(parts[0]), int(parts[1]), int(parts[2])
    if part == "major":
        return f"{major + 1}.0.0"
    elif part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def git_cliff_bumped_version() -> str | None:
    """Ask git-cliff to compute the next version from unreleased commits.

    git-cliff inspects the commits since the last matching tag and uses
    the conventional-commit types (feat / fix / BREAKING CHANGE / etc.)
    to decide major / minor / patch. Returns the bumped version string
    WITHOUT the leading 'v' (so it can be compared against semver).

    Returns None if git-cliff decides there's nothing to bump or fails.
    """
    result = run(
        ["git-cliff", "--bumped-version"],
        check=False,
        capture=True,
    )
    if result.returncode != 0:
        return None
    raw = (result.stdout or "").strip()
    if not raw:
        return None
    # git-cliff output follows the configured tag_pattern; strip the
    # leading 'v' for semver comparison and downstream file writes.
    version = raw.lstrip("v")
    if not re.match(r"^\d+\.\d+\.\d+$", version):
        return None
    return version


def determine_next_version(args, current: str) -> str:
    """Pick the next version. Flags override, otherwise git-cliff auto-detects.

    Order of precedence:
      1. --set <x.y.z>   → explicit
      2. --major         → bump major
      3. --minor         → bump minor
      4. --patch         → bump patch
      5. default         → git-cliff --bumped-version (based on commit types)
      6. fallback        → patch bump (if git-cliff has nothing to say)
    """
    if args.set:
        if not re.match(r"^\d+\.\d+\.\d+$", args.set):
            print(f"ERROR: '{args.set}' is not valid semver (x.y.z)", file=sys.stderr)
            sys.exit(1)
        return args.set
    if args.major:
        return bump_version(current, "major")
    if args.minor:
        return bump_version(current, "minor")
    if args.patch:
        return bump_version(current, "patch")
    # Auto-detection via git-cliff (conventional commits).
    auto = git_cliff_bumped_version()
    if auto and auto != current:
        print(f"  git-cliff --bumped-version: {current} -> {auto}")
        return auto
    # Fallback: no bumpable commits detected (or git-cliff returned the
    # same version). Default to patch bump so the release still happens.
    print("  git-cliff found no bumpable commits — defaulting to patch bump")
    return bump_version(current, "patch")


def extract_release_notes(changelog_path: Path, version: str) -> str:
    """Extract the changelog entry for a specific version."""
    if not changelog_path.exists():
        return f"Release v{version}"
    content = changelog_path.read_text(encoding="utf-8")
    pattern = rf"^## \[{re.escape(version)}\].*?\n(.*?)(?=^## \[|\Z)"
    match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
    if not match:
        return f"Release v{version}"
    return match.group(1).strip()


def _reports_dir(repo_root: Path) -> Path:
    d = repo_root / "reports_dev" / "publish"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _run_check(
    name: str,
    cmd: list[str],
    cwd: str,
    repo_root: Path,
) -> bool:
    """Run a check command, redirect output to a report file, return True on success."""
    report = _reports_dir(repo_root) / f"{name}.log"
    result = run(cmd, check=False, cwd=cwd)
    output = (result.stdout or "") + (result.stderr or "")
    report.write_text(output, encoding="utf-8")
    if result.returncode != 0:
        print(f"ERROR: {name} failed — see {report}", file=sys.stderr)
        # Print last 40 lines inline for immediate visibility
        lines = output.strip().split("\n")
        for line in lines[-40:]:
            print(f"  {line}", file=sys.stderr)
        return False
    print(f"  OK: {name}")
    return True


REQUIRED_TOOLS: list[tuple[str, str]] = [
    ("git", "https://git-scm.com/"),
    ("node", "https://nodejs.org/ (>= 18)"),
    ("npm", "comes with Node.js"),
    ("npx", "comes with Node.js"),
    ("gh", "brew install gh  OR  https://cli.github.com/"),
    ("uvx", "curl -LsSf https://astral.sh/uv/install.sh | sh"),
    ("ruff", "uv tool install ruff"),
    ("shellcheck", "brew install shellcheck"),
    ("git-cliff", "brew install git-cliff  OR  cargo install git-cliff"),
    ("claude", "npm install -g @anthropic-ai/claude-code  (Claude Code CLI)"),
]


def require_tools() -> None:
    """Verify every required tool is on PATH. Die if any is missing.

    This is the first gate — publish.py cannot proceed if any tool is
    missing. No 'SKIP because tool not installed' paths anywhere in
    run_checks(), so a missing tool must be caught here upfront.
    """
    missing: list[tuple[str, str]] = []
    for tool, hint in REQUIRED_TOOLS:
        if not shutil.which(tool):
            missing.append((tool, hint))
    if missing:
        print("ERROR: required tools missing from PATH:", file=sys.stderr)
        for tool, hint in missing:
            print(f"  {tool:<14} → {hint}", file=sys.stderr)
        print(
            "\nAll these tools are MANDATORY — publish.py will not run any checks "
            "or mutations until they are installed.",
            file=sys.stderr,
        )
        sys.exit(1)


def run_checks(repo_root: Path) -> bool:
    """Run every mandatory check on the plugin. Fail-fast on any error.

    STRICT MODE: every check is mandatory. There are NO conditional SKIP
    paths. If a check tool is not available, require_tools() should have
    aborted earlier. If a check fails, this returns False and the caller
    must abort the publish — no exceptions, no overrides.

    The full list of checks (all mandatory, all must return 0):
      1. npm ci          — clean dependency install (always, not conditional)
      2. npm run typecheck — tsc --noEmit
      3. npm run lint     — eslint --max-warnings 0
      4. npm run build    — full esbuild bundle (catches issues tsc misses)
      5. npm test         — vitest run (all tests must pass)
      6. ruff check       — lint all Python scripts
      7. shellcheck       — lint all .sh files in the main tree
      8. plugin.json parse — manifest must be valid JSON
      9. claude plugin validate — authoritative Claude Code plugin validator
    """
    mcp_dir = str(repo_root / "mcp-server")
    reports = _reports_dir(repo_root)
    print(f"  Reports: {reports}")

    # 1. Clean dependency install. Always — no conditional skip. A publish
    # must run against a reproducible dep tree, not whatever the local
    # node_modules happens to have.
    if not _run_check("npm-ci", ["npm", "ci", "--ignore-scripts"], mcp_dir, repo_root):
        return False

    # 2. TypeScript compile check
    if not _run_check("typecheck", ["npm", "run", "typecheck"], mcp_dir, repo_root):
        return False

    # 3. ESLint (--max-warnings 0 configured in package.json)
    if not _run_check("lint", ["npm", "run", "lint"], mcp_dir, repo_root):
        return False

    # 4. Full build — esbuild bundle, catches runtime import errors and
    # bundler issues that tsc --noEmit doesn't see.
    if not _run_check("build", ["npm", "run", "build"], mcp_dir, repo_root):
        return False

    # 5. Tests — all must pass. No flakes allowed, no skips allowed.
    if not _run_check("test", ["npm", "test"], mcp_dir, repo_root):
        return False

    # 6. Ruff on all Python scripts (mandatory — require_tools verified it).
    if not _run_check("ruff", ["ruff", "check", "scripts/"], str(repo_root), repo_root):
        return False

    # 7. Shellcheck on every .sh file in the main tree (mandatory).
    exclude_dirs = {
        "node_modules", ".git", "scripts_dev", "docs_dev", "samples_dev",
        "examples_dev", "tests_dev", "downloads_dev", "libs_dev",
        "builds_dev", ".claude", "dist", "reports_dev",
    }
    sh_files: list[Path] = []
    for f in repo_root.rglob("*.sh"):
        if not any(part in exclude_dirs for part in f.relative_to(repo_root).parts):
            sh_files.append(f)
    if sh_files:
        if not _run_check(
            "shellcheck",
            ["shellcheck", *(str(f) for f in sh_files)],
            str(repo_root),
            repo_root,
        ):
            return False
    else:
        # Absence of .sh files is not a failure — there's nothing to check.
        # This is NOT a skip of the check tool; the tool is installed and
        # would run if there were files.
        print("  OK: shellcheck (no .sh files in main tree)")

    # 8. Plugin manifest JSON check
    plugin_json = repo_root / ".claude-plugin" / "plugin.json"
    try:
        json.loads(plugin_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"ERROR: plugin.json invalid: {e}", file=sys.stderr)
        return False
    print("  OK: plugin.json")

    # 9. Authoritative Claude Code plugin validator. Catches schema drift
    # in plugin.json, skills, commands, agents, hooks — anything the
    # current Claude Code CLI version considers non-compliant.
    if not _run_check(
        "claude-plugin-validate",
        ["claude", "plugin", "validate", "."],
        str(repo_root),
        repo_root,
    ):
        return False

    return True


def run_cpv_validation(repo_root: Path) -> bool:
    """Run CPV remote validation. Fail if any CRITICAL or MAJOR issue found.

    CPV (claude-plugins-validation) is a third-party validator for Claude
    Code plugins. It enforces strict structural rules on skills / agents /
    hooks / commands. Publish aborts if CPV returns a non-zero exit code,
    which it does when CRITICAL or MAJOR issues are present.
    """
    # uvx is verified by require_tools() — this is mandatory.
    cpv_result = run(
        [
            "uvx", "--from",
            "git+https://github.com/Emasoft/claude-plugins-validation",
            "--with", "pyyaml",
            "cpv-remote-validate", "plugin", str(repo_root),
        ],
        capture=True, check=False,
    )
    report = _reports_dir(repo_root) / "cpv.log"
    output = (cpv_result.stdout or "") + (cpv_result.stderr or "")
    report.write_text(output, encoding="utf-8")
    if cpv_result.returncode != 0:
        print("ERROR: CPV validation failed — see", report, file=sys.stderr)
        if cpv_result.stdout:
            for line in cpv_result.stdout.strip().split("\n")[-40:]:
                print(f"  {line}", file=sys.stderr)
        return False
    print("  OK: cpv")
    return True


def main():
    parser = argparse.ArgumentParser(description="Publish a new release")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--patch", action="store_true", help="Bump patch version (default)"
    )
    group.add_argument("--minor", action="store_true", help="Bump minor version")
    group.add_argument("--major", action="store_true", help="Bump major version")
    group.add_argument(
        "--set", type=str, metavar="VERSION", help="Set explicit version (x.y.z)"
    )
    parser.add_argument(
        "--dry-run", "-n", action="store_true", help="Preview without making changes"
    )
    parser.add_argument(
        "--check-only", action="store_true",
        help="Run checks only (build, manifest, CPV) without publishing. Used by pre-push hook.",
    )
    args = parser.parse_args()

    # Gate #1 — every required tool must be present. No mode skips this
    # (dry-run, check-only, and normal publish all need the full tool set
    # because they all run the full check suite). This replaces the old
    # per-mode `shutil.which("gh")` guard which only covered one tool.
    require_tools()

    # Resolve paths from script location
    repo_root = Path(__file__).resolve().parent.parent
    plugin_json = repo_root / ".claude-plugin" / "plugin.json"
    changelog = repo_root / "CHANGELOG.md"

    # No lock file / env var needed: the pre-push hook uses process
    # ancestry (walks parent PIDs via `ps`) to verify publish.py is the
    # caller. Since subprocess.run(["git", "push", ...]) makes publish.py
    # the grandparent of the hook, the hook can reliably detect our
    # presence without any spoofable markers.
    _run_publish(args, repo_root, plugin_json, changelog)


def _run_publish(args, repo_root: Path, plugin_json: Path, changelog: Path) -> None:

    # ── --check-only: run full validation without publishing ──
    # Used by the pre-push hook. Checks are the SAME as the main publish
    # flow — same run_checks(), same run_cpv_validation(). No shortcuts.
    if args.check_only:
        print("\n── Check-only mode ──")
        if not run_checks(repo_root):
            print("ERROR: checks failed — see reports_dev/publish/.", file=sys.stderr)
            sys.exit(1)
        if not run_cpv_validation(repo_root):
            sys.exit(1)
        print("All checks passed.")
        return

    # ── 1. Pre-flight: working tree must be clean ──
    # Mutating version in a dirty tree mixes user changes with publish artifacts.
    print("\n── 1. Pre-flight: working tree check ──")
    pf_status = run(["git", "status", "--porcelain"], check=False)
    pf_dirty = [
        line for line in (pf_status.stdout or "").strip().splitlines()
        if line and not line.startswith("??")  # untracked files are ok
    ]
    if pf_dirty:
        print("ERROR: working tree has uncommitted changes:", file=sys.stderr)
        for line in pf_dirty:
            print(f"  {line}", file=sys.stderr)
        print("Commit or stash changes before publishing.", file=sys.stderr)
        sys.exit(1)
    print("  Working tree is clean")
    print()

    # ── 2. Validate — FIRST thing after pre-flight ──
    # MANDATORY. Every check runs on the CURRENT code (no version bump
    # yet), so the validation result reflects the exact state being
    # released. If anything fails, publish aborts without touching any
    # file and the working tree is guaranteed untouched.
    #
    # Order matters: validation must pass BEFORE we compute the next
    # version or generate the changelog. There's no point determining
    # a version for code that won't build.
    print("── 2. Validate (MANDATORY — all checks must pass with 0 errors) ──")
    if not run_checks(repo_root):
        print("ERROR: validation failed. Aborting.", file=sys.stderr)
        print("Working tree is unchanged — fix the issues and re-run.", file=sys.stderr)
        sys.exit(1)
    if not run_cpv_validation(repo_root):
        print("ERROR: CPV validation failed. Aborting.", file=sys.stderr)
        sys.exit(1)
    print("  All checks passed")
    print()

    # ── 3. Determine next version ──
    # Default: git-cliff --bumped-version (uses conventional commit
    # types to decide major/minor/patch). Flags --patch/--minor/--major/--set
    # override the auto-detection for manual control.
    print("── 3. Determine next version ──")
    if not plugin_json.exists():
        print(f"ERROR: {plugin_json} not found", file=sys.stderr)
        sys.exit(1)
    manifest = json.loads(plugin_json.read_text(encoding="utf-8"))
    current = manifest.get("version", "0.0.0")
    new_version = determine_next_version(args, current)
    tag = f"v{new_version}"

    # Verify tag does not already exist (local + remote)
    tag_check = run(["git", "tag", "--list", tag], check=False)
    if tag_check.stdout and tag_check.stdout.strip() == tag:
        print(f"ERROR: tag '{tag}' already exists locally", file=sys.stderr)
        sys.exit(1)
    remote_tag_check = run(["git", "ls-remote", "--tags", "origin", tag], check=False)
    if remote_tag_check.stdout and remote_tag_check.stdout.strip():
        print(f"ERROR: tag '{tag}' already exists on remote origin", file=sys.stderr)
        sys.exit(1)

    print(f"  Planned: {current} -> {new_version} (tag: {tag})")
    print()

    # ── dry-run exits here, after checks pass AND version is determined ──
    if args.dry_run:
        print("[DRY RUN] All checks passed.")
        print(f"[DRY RUN] Would bump {current} -> {new_version}")
        print(f"[DRY RUN] Would generate CHANGELOG.md, sync version, commit, tag {tag}, push")
        return

    # ── 4. Generate CHANGELOG.md via git-cliff ──
    # git-cliff re-generates the full CHANGELOG from all commits since
    # the initial tag. The unreleased commits get grouped under the new
    # tag. commit_parsers in cliff.toml control the section layout.
    print("── 4. Generate CHANGELOG.md ──")
    cliff_result = run(
        ["git-cliff", "--tag", tag, "--output", str(changelog)],
        capture=True, check=False,
    )
    cliff_output = (cliff_result.stderr or "") + (cliff_result.stdout or "")
    if "were skipped" in cliff_output:
        print(f"  WARNING: {cliff_output.strip()}", file=sys.stderr)
        print(
            "  ERROR: git-cliff skipped commits. Ensure cliff.toml has "
            "filter_unconventional = false and a catch-all parser.",
            file=sys.stderr,
        )
        sys.exit(1)
    if cliff_result.returncode != 0:
        print(f"  ERROR: git-cliff failed (exit {cliff_result.returncode})", file=sys.stderr)
        if cliff_result.stderr:
            print(f"  {cliff_result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    print("  OK: CHANGELOG.md regenerated")
    print()

    # ── 5. Sync version to all files ──
    print("── 5. Sync version to files ──")
    # Update plugin.json
    manifest["version"] = new_version
    plugin_json.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    # Sync version to mcp-server/package.json and server.json
    pkg_json = repo_root / "mcp-server" / "package.json"
    if pkg_json.exists():
        pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
        pkg["version"] = new_version
        pkg_json.write_text(
            json.dumps(pkg, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"  Synced version to {pkg_json.relative_to(repo_root)}")

    srv_json = repo_root / "mcp-server" / "server.json"
    if srv_json.exists():
        srv = json.loads(srv_json.read_text(encoding="utf-8"))
        if "version" in srv:
            srv["version"] = new_version
        for pkg_entry in srv.get("packages", []):
            if "version" in pkg_entry:
                pkg_entry["version"] = new_version
        srv_json.write_text(
            json.dumps(srv, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"  Synced version to {srv_json.relative_to(repo_root)}")

    # Sync hardcoded version in MCP server source (index.ts Server constructor)
    index_ts = repo_root / "mcp-server" / "src" / "index.ts"
    if index_ts.exists():
        src = index_ts.read_text(encoding="utf-8")
        updated = re.sub(
            r'(\{\s*name:\s*"llm-externalizer",\s*version:\s*")[^"]+(")',
            rf"\g<1>{new_version}\2",
            src,
        )
        if updated == src:
            print("ERROR: regex failed to match version in index.ts Server constructor", file=sys.stderr)
            sys.exit(1)
        index_ts.write_text(updated, encoding="utf-8")
        print(f"  Synced version to {index_ts.relative_to(repo_root)}")
    print()

    # ── 6. Rebuild dist (with new version) ──
    print("── 6. Rebuild dist ──")
    mcp_dir = str(repo_root / "mcp-server")
    rebuild = run(["npm", "run", "build"], capture=True, check=False, cwd=mcp_dir)
    if rebuild.returncode != 0:
        print("ERROR: dist rebuild failed.", file=sys.stderr)
        if rebuild.stderr:
            print(f"  {rebuild.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    dist_index = repo_root / "mcp-server" / "dist" / "index.js"
    if dist_index.exists():
        dist_content = dist_index.read_text(encoding="utf-8")
        if new_version not in dist_content:
            print(f"ERROR: version '{new_version}' not found in dist/index.js", file=sys.stderr)
            sys.exit(1)
    print("  OK: dist rebuilt with updated version")
    print()

    # ── 7. Update README badges ──
    readme = repo_root / "README.md"
    print("── 7. Update README badges ──")
    if update_readme_badges(readme, new_version, True):
        print(f"  Updated badges in {readme.relative_to(repo_root)}")
    else:
        print("  No badge markers found in README.md, skipping")
    print()

    # ── 8. Commit — conventional release commit ──
    # Single commit with 'chore(release): vX.Y.Z' format. The
    # cliff.toml commit_parsers skip-rule for '^chore\\(release\\)'
    # excludes this commit from future changelog generation.
    print("── 8. Commit ──")
    files_to_stage = [str(plugin_json)]
    pkg_json_path = repo_root / "mcp-server" / "package.json"
    srv_json_path = repo_root / "mcp-server" / "server.json"
    if changelog.exists():
        files_to_stage.append(str(changelog))
    if readme.exists():
        files_to_stage.append(str(readme))
    if pkg_json_path.exists():
        files_to_stage.append(str(pkg_json_path))
    if srv_json_path.exists():
        files_to_stage.append(str(srv_json_path))
    index_ts_path = repo_root / "mcp-server" / "src" / "index.ts"
    if index_ts_path.exists():
        files_to_stage.append(str(index_ts_path))
    dist_dir = repo_root / "mcp-server" / "dist"
    if dist_dir.exists():
        files_to_stage.append(str(dist_dir))
    run(["git", "add"] + files_to_stage, capture=False)
    # Warn if any modified files were missed
    porcelain = run(["git", "status", "--porcelain"], check=False)
    if porcelain.stdout:
        unstaged = [
            line for line in porcelain.stdout.strip().splitlines()
            if len(line) >= 2 and line[1] not in (" ", "?")
        ]
        if unstaged:
            print("WARNING: unstaged modified files detected:", file=sys.stderr)
            for line in unstaged:
                print(f"  {line}", file=sys.stderr)
    run(["git", "commit", "-m", f"chore(release): {tag}"], capture=False)
    print()

    # ── 9. Tag ──
    print("── 9. Tag ──")
    run(["git", "tag", "-a", tag, "-m", f"Release {tag}"], capture=False)
    print()

    # ── 10. Push (pre-push hook sees the lock file and skips its own checks) ──
    print("── 10. Push ──")
    push_result = run(["git", "push", "--follow-tags"], capture=True, check=False)
    if push_result.returncode != 0:
        print("ERROR: push failed. Rolling back commit and tag.", file=sys.stderr)
        if push_result.stderr:
            print(f"  {push_result.stderr.strip()}", file=sys.stderr)
        run(["git", "reset", "--soft", "HEAD~1"], check=False, capture=False)
        run(["git", "tag", "-d", tag], check=False, capture=False)
        sys.exit(1)
    print()

    # ── 11. GitHub release ──
    print("── 11. Create GitHub release ──")
    notes = extract_release_notes(changelog, new_version)
    run(
        ["gh", "release", "create", tag, "--title", tag, "--notes", notes],
        capture=False,
    )

    print(f"\nPublished {tag}")


if __name__ == "__main__":
    main()
