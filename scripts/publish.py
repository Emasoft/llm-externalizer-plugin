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
    4. Run git-cliff to regenerate CHANGELOG.md (if git-cliff is available)
    5. Commit version bump + changelog
    6. Create annotated git tag (vX.Y.Z)
    7. Push commits and tags (pre-push hook runs validation again as gate)
    8. Create GitHub release with changelog entry as release notes
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


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
            "\n[DRY RUN] Would update plugin.json, CHANGELOG.md"
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

    # ── 3. Update CHANGELOG.md with git-cliff ──
    print("── 3. Update changelog ──")
    if shutil.which("git-cliff"):
        run(["git-cliff", "--tag", tag, "--output", str(changelog)], capture=False)
    else:
        print("  git-cliff not found, skipping changelog generation")
    print()

    # ── 4. Commit ──
    print("── 4. Commit ──")
    files_to_stage = [str(plugin_json)]
    if changelog.exists():
        files_to_stage.append(str(changelog))
    run(["git", "add"] + files_to_stage, capture=False)
    run(["git", "commit", "-m", f"Release {tag}"], capture=False)
    print()

    # ── 5. Tag ──
    print("── 5. Tag ──")
    run(["git", "tag", "-a", tag, "-m", f"Release {tag}"], capture=False)
    print()

    # ── 6. Push (pre-push hook runs validation) ──
    print("── 6. Push ──")
    run(["git", "push", "--follow-tags"], capture=False)
    print()

    # ── 7. GitHub release ──
    print("── 7. Create GitHub release ──")
    notes = extract_release_notes(changelog, new_version)
    run(
        ["gh", "release", "create", tag, "--title", tag, "--notes", notes],
        capture=False,
    )

    print(f"\nPublished {tag}")


if __name__ == "__main__":
    main()
