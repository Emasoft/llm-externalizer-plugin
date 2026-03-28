#!/usr/bin/env python3
"""Publish a new release: bump version, update changelog, tag, push, create GitHub release.

Usage:
    uv run scripts/publish.py              # bump patch (default)
    uv run scripts/publish.py --patch      # 3.2.0 -> 3.2.1
    uv run scripts/publish.py --minor      # 3.2.0 -> 3.3.0
    uv run scripts/publish.py --major      # 3.2.0 -> 4.0.0
    uv run scripts/publish.py --set 4.0.0  # explicit version
    uv run scripts/publish.py --dry-run    # preview without changes

Steps:
    0. Verify clean working tree
    1. Run build check (TypeScript compiles cleanly)
    1b. CPV plugin validation (remote via uvx — blocks on critical/major)
    2. Bump version in plugin.json
    2b. Rebuild dist
    3. Update README.md badges (version, build status)
    4. Run git-cliff to regenerate CHANGELOG.md (aborts if commits skipped)
    5. Commit version bump + changelog + badges
    6. Create annotated git tag (vX.Y.Z)
    7. Push commits and tags (pre-push hook runs validation again as gate)
    8. Create GitHub release with changelog entry as release notes
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def update_readme_badges(readme_path: Path, version: str, build_ok: bool) -> bool:
    """Update shields.io badges between <!-- badges-start --> and <!-- badges-end --> markers.

    Returns True if badges were updated, False if markers not found.
    """
    if not readme_path.exists():
        return False
    content = readme_path.read_text(encoding="utf-8")
    start_marker = "<!-- badges-start -->"
    end_marker = "<!-- badges-end -->"
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
    cmd: list[str], *, check: bool = True, capture: bool = True
) -> subprocess.CompletedProcess:
    """Run a command, printing it first. Fail-fast on error."""
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, check=check, capture_output=capture, text=True)


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


def run_checks(repo_root: Path) -> bool:
    """Run build check on the MCP server. Return True if it compiles."""
    mcp_dir = repo_root / "mcp-server"

    if not (mcp_dir / "node_modules").exists():
        print("  Installing dependencies...")
        result = run(
            ["npm", "ci", "--ignore-scripts"],
            check=False,
        )
        if result.returncode != 0:
            print("ERROR: npm ci failed", file=sys.stderr)
            if result.stderr:
                print(result.stderr, file=sys.stderr)
            return False

    # TypeScript compile check
    result = run(
        ["npx", "tsc", "--noEmit"],
        check=False,
    )
    if result.returncode != 0:
        print("ERROR: TypeScript compilation failed", file=sys.stderr)
        if result.stdout:
            print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        return False

    # Plugin manifest JSON check
    plugin_json = repo_root / ".claude-plugin" / "plugin.json"
    try:
        json.loads(plugin_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"ERROR: plugin.json invalid: {e}", file=sys.stderr)
        return False

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
    args = parser.parse_args()

    # Verify required CLI tools are available
    if not shutil.which("gh"):
        print("ERROR: 'gh' (GitHub CLI) not found on PATH. Install it first.", file=sys.stderr)
        sys.exit(1)

    # Resolve paths from script location
    repo_root = Path(__file__).resolve().parent.parent
    plugin_json = repo_root / ".claude-plugin" / "plugin.json"
    changelog = repo_root / "CHANGELOG.md"

    # ── 0. Verify clean working tree ──
    print("\n── 0. Verify clean working tree ──")
    result = run(["git", "diff", "--quiet"], check=False, capture=False)
    if result.returncode != 0:
        print(
            "ERROR: uncommitted changes found. Commit or stash first.", file=sys.stderr
        )
        sys.exit(1)
    result = run(["git", "diff", "--cached", "--quiet"], check=False, capture=False)
    if result.returncode != 0:
        print("ERROR: staged changes found. Commit or stash first.", file=sys.stderr)
        sys.exit(1)
    print("OK: working tree clean\n")

    # ── 1. Run checks (before any file modifications) ──
    print("── 1. Run checks ──")
    saved_cwd = os.getcwd()
    try:
        os.chdir(repo_root / "mcp-server")
        checks_ok = run_checks(repo_root)
    finally:
        os.chdir(saved_cwd)
    if not checks_ok:
        print("ERROR: checks failed. Fix issues before publishing.", file=sys.stderr)
        sys.exit(1)
    print("  build: passing | manifest: valid")
    print()

    # ── 1b. CPV plugin validation (remote execution via uvx) ──
    print("── 1b. CPV plugin validation ──")
    if shutil.which("uvx"):
        cpv_result = run(
            [
                "uvx",
                "--from", "git+https://github.com/Emasoft/claude-plugins-validation",
                "--with", "pyyaml",
                "cpv-validate",
                str(repo_root),
            ],
            capture=True,
            check=False,
        )
        if cpv_result.returncode == 0:
            print("  OK: CPV validation passed")
        else:
            # Parse output to determine severity — block only on CRITICAL or MAJOR > 0
            output = cpv_result.stdout or ""
            has_critical = bool(re.search(r"CRITICAL:\s*[1-9]", output))
            has_major = bool(re.search(r"MAJOR:\s*[1-9]", output))
            if has_critical or has_major:
                print("ERROR: CPV validation found critical/major issues:", file=sys.stderr)
                print(output, file=sys.stderr)
                sys.exit(1)
            else:
                # Minor/warning/nit only — warn but don't block publish
                print("  WARNING: CPV found minor issues (non-blocking):")
                for line in output.strip().splitlines()[-5:]:
                    print(f"    {line}")
    else:
        print("  SKIP: 'uvx' not found on PATH (install uv for CPV validation)")
    print()

    # ── 2. Bump version ──
    print("── 2. Bump version ──")
    if not plugin_json.exists():
        print(
            f"ERROR: {plugin_json} not found — is this a claude-plugin repo?",
            file=sys.stderr,
        )
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

    if new_version == current:
        print(f"Version unchanged: {current}. Nothing to publish.")
        return

    tag = f"v{new_version}"

    # Verify tag does not already exist locally
    tag_check = run(["git", "tag", "--list", tag], check=False)
    if tag_check.stdout and tag_check.stdout.strip() == tag:
        print(f"ERROR: tag '{tag}' already exists locally", file=sys.stderr)
        sys.exit(1)

    # Verify tag does not already exist on remote
    remote_tag_check = run(["git", "ls-remote", "--tags", "origin", tag], check=False)
    if remote_tag_check.stdout and remote_tag_check.stdout.strip():
        print(f"ERROR: tag '{tag}' already exists on remote origin", file=sys.stderr)
        sys.exit(1)

    print(f"  {current} -> {new_version} (tag: {tag})")

    if args.dry_run:
        print(
            "\n[DRY RUN] Would update plugin.json, README.md badges, CHANGELOG.md"
        )
        print(f"[DRY RUN] Would commit, tag {tag}, push, and create GitHub release")
        return

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

    # ── 2b. Rebuild dist (so bundled version matches source) ──
    print("── 2b. Rebuild dist ──")
    saved_cwd2 = os.getcwd()
    try:
        os.chdir(repo_root / "mcp-server")
        rebuild = run(["npm", "run", "build"], capture=True, check=False)
    finally:
        os.chdir(saved_cwd2)
    if rebuild.returncode != 0:
        print("ERROR: dist rebuild failed after version sync.", file=sys.stderr)
        if rebuild.stderr:
            print(f"  {rebuild.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    # H9: Verify new version string appears in built dist
    dist_index = repo_root / "mcp-server" / "dist" / "index.js"
    if dist_index.exists():
        dist_content = dist_index.read_text(encoding="utf-8")
        if new_version not in dist_content:
            print(f"ERROR: version '{new_version}' not found in dist/index.js after rebuild", file=sys.stderr)
            sys.exit(1)
    print("  OK: dist rebuilt with updated version")
    print()

    # ── 3. Update README badges ──
    readme = repo_root / "README.md"
    print("── 3. Update README badges ──")
    if update_readme_badges(readme, new_version, checks_ok):
        print(f"  Updated badges in {readme.relative_to(repo_root)}")
    else:
        print("  No badge markers found in README.md, skipping")
    print()

    # ── 4. Update CHANGELOG.md with git-cliff ──
    print("── 4. Update changelog ──")
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

    # ── 5. Commit ──
    print("── 5. Commit ──")
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
        unstaged = [
            line for line in porcelain.stdout.strip().splitlines()
            if line and not line.startswith("A ") and not line.startswith("M ")
            and not line.startswith("?? ")
        ]
        if unstaged:
            print("WARNING: unstaged modified files detected:", file=sys.stderr)
            for line in unstaged:
                print(f"  {line}", file=sys.stderr)
    run(["git", "commit", "-m", f"Release {tag}"], capture=False)
    print()

    # ── 6. Tag ──
    print("── 6. Tag ──")
    run(["git", "tag", "-a", tag, "-m", f"Release {tag}"], capture=False)
    print()

    # ── 7. Push (pre-push hook runs validation) ──
    print("── 7. Push ──")
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

    # ── 8. GitHub release ──
    print("── 8. Create GitHub release ──")
    notes = extract_release_notes(changelog, new_version)
    run(
        ["gh", "release", "create", tag, "--title", tag, "--notes", notes],
        capture=False,
    )

    print(f"\nPublished {tag}")


if __name__ == "__main__":
    main()
