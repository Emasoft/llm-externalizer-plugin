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
    1. Verify clean working tree
    2. Run build check (TypeScript compiles cleanly)
    3. Bump version in plugin.json
    4. Update README.md badges (version, build status)
    5. Run git-cliff to regenerate CHANGELOG.md (aborts if commits skipped)
    6. Commit version bump + changelog + badges
    7. Create annotated git tag (vX.Y.Z)
    8. Push commits and tags (pre-push hook runs validation again as gate)
    9. Create GitHub release with changelog entry as release notes
"""

import argparse
import json
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
            ["npm", "install", "--ignore-scripts"],
            check=False,
        )
        if result.returncode != 0:
            print("ERROR: npm install failed", file=sys.stderr)
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
    import os
    saved_cwd = os.getcwd()
    os.chdir(repo_root / "mcp-server")
    checks_ok = run_checks(repo_root)
    os.chdir(saved_cwd)
    if not checks_ok:
        print("ERROR: checks failed. Fix issues before publishing.", file=sys.stderr)
        sys.exit(1)
    print("  build: passing | manifest: valid")
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

    # Verify tag does not already exist
    tag_check = run(["git", "tag", "--list", tag], check=False)
    if tag_check.stdout and tag_check.stdout.strip() == tag:
        print(f"ERROR: tag '{tag}' already exists", file=sys.stderr)
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
        print("  git-cliff not found, skipping changelog generation")
    print()

    # ── 5. Commit ──
    print("── 5. Commit ──")
    files_to_stage = [str(plugin_json)]
    if changelog.exists():
        files_to_stage.append(str(changelog))
    if readme.exists():
        files_to_stage.append(str(readme))
    run(["git", "add"] + files_to_stage, capture=False)
    run(["git", "commit", "-m", f"Release {tag}"], capture=False)
    print()

    # ── 6. Tag ──
    print("── 6. Tag ──")
    run(["git", "tag", "-a", tag, "-m", f"Release {tag}"], capture=False)
    print()

    # ── 7. Push (pre-push hook runs validation) ──
    print("── 7. Push ──")
    run(["git", "push", "--follow-tags"], capture=False)
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
