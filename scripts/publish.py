#!/usr/bin/env python3
"""Publish a new release: bump version, update changelog, tag, push, create GitHub release.

Usage:
    uv run scripts/publish.py              # bump patch (default)
    uv run scripts/publish.py --patch      # 3.2.0 -> 3.2.1
    uv run scripts/publish.py --minor      # 3.2.0 -> 3.3.0
    uv run scripts/publish.py --major      # 3.2.0 -> 4.0.0
    uv run scripts/publish.py --set 4.0.0  # explicit version
    uv run scripts/publish.py --dry-run    # preview without changes
    uv run scripts/publish.py --check-only # run checks only (used by pre-push hook)

Steps:
    1. Bump version (always — marketplace needs version change to detect updates)
       Sync to plugin.json, package.json, server.json, index.ts
    2. Rebuild dist (with new version)
    3. Validate (build check + CPV — blocks if any issue)
    4. Update README.md badges
    5. Generate CHANGELOG.md (git-cliff)
    6. Commit everything
    7. Create annotated git tag (vX.Y.Z)
    8. Push (pre-push hook skips — lock file present)
    9. Create GitHub release
"""

import argparse
import json
import os
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


def run_checks(repo_root: Path) -> bool:
    """Run lint + typecheck + shellcheck + ruff on the plugin. Fail-fast on any error."""
    mcp_dir = str(repo_root / "mcp-server")
    reports = _reports_dir(repo_root)
    print(f"  Reports: {reports}")

    if not (repo_root / "mcp-server" / "node_modules").exists():
        print("  Installing dependencies...")
        result = run(
            ["npm", "ci", "--ignore-scripts"],
            check=False, cwd=mcp_dir,
        )
        if result.returncode != 0:
            print("ERROR: npm ci failed", file=sys.stderr)
            if result.stderr:
                print(result.stderr, file=sys.stderr)
            return False

    # 1. TypeScript compile check
    if not _run_check("tsc", ["npx", "tsc", "--noEmit"], mcp_dir, repo_root):
        return False

    # 2. ESLint
    if not _run_check("eslint", ["npx", "eslint", "src", "--max-warnings", "0"], mcp_dir, repo_root):
        return False

    # 3. Ruff on Python scripts (if ruff is available)
    ruff_check = run(["which", "ruff"], check=False)
    if ruff_check.returncode == 0:
        if not _run_check("ruff", ["ruff", "check", "scripts/"], str(repo_root), repo_root):
            return False
    else:
        print("  SKIP: ruff not installed (install with: uv tool install ruff)")

    # 4. Shellcheck on any .sh files (if shellcheck is available)
    shellcheck_bin = run(["which", "shellcheck"], check=False)
    if shellcheck_bin.returncode == 0:
        # Only check .sh files in the main plugin tree (exclude dev/tmp/vendored dirs)
        exclude_dirs = {"node_modules", ".git", "scripts_dev", "docs_dev",
                        "samples_dev", "examples_dev", "tests_dev",
                        "downloads_dev", "libs_dev", "builds_dev", ".claude",
                        "dist", "reports_dev"}
        sh_files: list[Path] = []
        for f in repo_root.rglob("*.sh"):
            if not any(part in exclude_dirs for part in f.relative_to(repo_root).parts):
                sh_files.append(f)
        if sh_files:
            if not _run_check("shellcheck", ["shellcheck", *(str(f) for f in sh_files)], str(repo_root), repo_root):
                return False
        else:
            print("  SKIP: no .sh files in main tree")
    else:
        print("  SKIP: shellcheck not installed (install with: brew install shellcheck)")

    # 5. Plugin manifest JSON check
    plugin_json = repo_root / ".claude-plugin" / "plugin.json"
    try:
        json.loads(plugin_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"ERROR: plugin.json invalid: {e}", file=sys.stderr)
        return False
    print("  OK: plugin.json")

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

    # gh is only required for actual publishing
    if not args.check_only and not shutil.which("gh"):
        print("ERROR: 'gh' (GitHub CLI) not found on PATH. Install it first.", file=sys.stderr)
        sys.exit(1)

    # Resolve paths from script location
    repo_root = Path(__file__).resolve().parent.parent
    plugin_json = repo_root / ".claude-plugin" / "plugin.json"
    changelog = repo_root / "CHANGELOG.md"
    lock_file = repo_root / ".publish.lock"

    # Lock file: tells the pre-push hook that publish.py is the caller.
    # publish.py exits before git push if any check fails, so lock presence
    # at push time guarantees validation passed.
    if not args.check_only:
        lock_file.write_text(str(os.getpid()), encoding="utf-8")
    try:
        _run_publish(args, repo_root, plugin_json, changelog, lock_file)
    finally:
        if lock_file.exists():
            try:
                lock_file.unlink()
            except OSError:
                pass


def _run_publish(args, repo_root: Path, plugin_json: Path, changelog: Path, lock_file: Path) -> None:

    # ── --check-only: run validation without publishing ──
    if args.check_only:
        print("\n── Check-only mode ──")
        checks_ok = run_checks(repo_root)
        if not checks_ok:
            print("ERROR: build checks failed.", file=sys.stderr)
            sys.exit(1)
        print("  build: passing | manifest: valid")
        if shutil.which("uvx"):
            cpv_result = run(
                ["uvx", "--from", "git+https://github.com/Emasoft/claude-plugins-validation",
                 "--with", "pyyaml", "cpv-remote-validate", "plugin", str(repo_root)],
                capture=True, check=False,
            )
            if cpv_result.returncode != 0:
                print("ERROR: CPV validation failed:", file=sys.stderr)
                if cpv_result.stdout:
                    print(cpv_result.stdout, file=sys.stderr)
                sys.exit(1)
            print("  CPV: passed")
        else:
            print("ERROR: 'uvx' not found. CPV validation is required.", file=sys.stderr)
            sys.exit(1)
        print("All checks passed.")
        return

    # ── 0. Pre-flight: working tree must be clean ──
    # Mutating version in a dirty tree mixes user changes with publish artifacts.
    print("\n── 0. Pre-flight: working tree check ──")
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

    # ── 1. Plan version bump (no file writes yet) ──
    print("── 1. Plan version bump ──")
    if not plugin_json.exists():
        print(f"ERROR: {plugin_json} not found", file=sys.stderr)
        sys.exit(1)
    manifest = json.loads(plugin_json.read_text(encoding="utf-8"))
    current = manifest.get("version", "0.0.0")

    if args.set:
        if not re.match(r"^\d+\.\d+\.\d+$", args.set):
            print(f"ERROR: '{args.set}' is not valid semver (x.y.z)", file=sys.stderr)
            sys.exit(1)
        new_version = args.set
    elif args.major:
        new_version = bump_version(current, "major")
    elif args.minor:
        new_version = bump_version(current, "minor")
    else:
        new_version = bump_version(current, "patch")

    tag = f"v{new_version}"

    # Verify tag does not already exist (local + remote) — read-only checks
    tag_check = run(["git", "tag", "--list", tag], check=False)
    if tag_check.stdout and tag_check.stdout.strip() == tag:
        print(f"ERROR: tag '{tag}' already exists locally", file=sys.stderr)
        sys.exit(1)
    remote_tag_check = run(["git", "ls-remote", "--tags", "origin", tag], check=False)
    if remote_tag_check.stdout and remote_tag_check.stdout.strip():
        print(f"ERROR: tag '{tag}' already exists on remote origin", file=sys.stderr)
        sys.exit(1)

    print(f"  Planned: {current} -> {new_version} (tag: {tag})")

    if args.dry_run:
        print(
            "\n[DRY RUN] Would update plugin.json, README.md badges, CHANGELOG.md"
        )
        print(f"[DRY RUN] Would commit, tag {tag}, push, and create GitHub release")
        return

    # ── 2. Validate CURRENT code BEFORE any mutations ──
    # All linters + typecheck + CPV run on the current working tree.
    # If any fail, abort — working tree is unchanged.
    print("\n── 2. Validate (linting + typecheck + CPV) ──")
    if not run_checks(repo_root):
        print("ERROR: validation failed. Aborting BEFORE version bump.", file=sys.stderr)
        print("Working tree is unchanged — fix the issues and re-run.", file=sys.stderr)
        sys.exit(1)
    if not shutil.which("uvx"):
        print("ERROR: 'uvx' not found. CPV validation is required.", file=sys.stderr)
        sys.exit(1)
    cpv_pre = run(
        ["uvx", "--from", "git+https://github.com/Emasoft/claude-plugins-validation",
         "--with", "pyyaml", "cpv-remote-validate", "plugin", str(repo_root)],
        capture=True, check=False,
    )
    if cpv_pre.returncode != 0:
        print("ERROR: CPV validation failed:", file=sys.stderr)
        if cpv_pre.stdout:
            print(cpv_pre.stdout, file=sys.stderr)
        sys.exit(1)
    print("  CPV: passed")
    print("  All checks passed — safe to bump version and commit")
    print()

    # ── 3. Apply version bump to files ──
    print("── 3. Apply version bump ──")
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

    # ── 4. Rebuild dist (with new version) ──
    print("── 4. Rebuild dist ──")
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

    # ── 5. Update README badges ──
    readme = repo_root / "README.md"
    print("── 5. Update README badges ──")
    if update_readme_badges(readme, new_version, True):
        print(f"  Updated badges in {readme.relative_to(repo_root)}")
    else:
        print("  No badge markers found in README.md, skipping")
    print()

    # ── 6. Update CHANGELOG.md with git-cliff ──
    print("── 6. Update changelog ──")
    if shutil.which("git-cliff"):
        cliff_result = run(
            ["git-cliff", "--tag", tag, "--output", str(changelog)],
            capture=True,
            check=False,
        )
        # Check for skipped commits in stderr
        cliff_output = (cliff_result.stderr or "") + (cliff_result.stdout or "")
        if "were skipped" in cliff_output:
            print(
                f"  WARNING: {cliff_output.strip()}",
                file=sys.stderr,
            )
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
        print("  OK: changelog generated, no commits skipped")
    else:
        print("ERROR: git-cliff not found on PATH. Install it first.", file=sys.stderr)
        sys.exit(1)
    print()

    # ── 7. Commit ──
    print("── 7. Commit ──")
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
    # Stage rebuilt dist files
    dist_dir = repo_root / "mcp-server" / "dist"
    if dist_dir.exists():
        files_to_stage.append(str(dist_dir))
    run(["git", "add"] + files_to_stage, capture=False)
    # M: Detect any unstaged modified files that may have been missed
    porcelain = run(["git", "status", "--porcelain"], check=False)
    if porcelain.stdout:
        # Check working-tree column (2nd char) for modifications not yet staged
        # Porcelain format: XY where X=index status, Y=worktree status
        # ' '=unmodified, '?'=untracked — anything else in Y means worktree changes
        unstaged = [
            line for line in porcelain.stdout.strip().splitlines()
            if len(line) >= 2 and line[1] not in (" ", "?")
        ]
        if unstaged:
            print("WARNING: unstaged modified files detected:", file=sys.stderr)
            for line in unstaged:
                print(f"  {line}", file=sys.stderr)
    run(["git", "commit", "-m", f"Release {tag}"], capture=False)
    print()

    # ── 8. Tag ──
    print("── 8. Tag ──")
    run(["git", "tag", "-a", tag, "-m", f"Release {tag}"], capture=False)
    print()

    # ── 9. Push (pre-push hook skips — lock file present) ──
    print("── 9. Push ──")
    push_result = run(["git", "push", "--follow-tags"], capture=True, check=False)
    if push_result.returncode != 0:
        print("ERROR: push failed. Rolling back commit and tag.", file=sys.stderr)
        if push_result.stderr:
            print(f"  {push_result.stderr.strip()}", file=sys.stderr)
        # Undo the commit (keep changes staged) and delete the local tag
        run(["git", "reset", "--soft", "HEAD~1"], check=False, capture=False)
        run(["git", "tag", "-d", tag], check=False, capture=False)
        sys.exit(1)
    print()

    # ── 10. GitHub release ──
    print("── 10. Create GitHub release ──")
    notes = extract_release_notes(changelog, new_version)
    run(
        ["gh", "release", "create", tag, "--title", tag, "--notes", notes],
        capture=False,
    )

    print(f"\nPublished {tag}")


if __name__ == "__main__":
    main()
