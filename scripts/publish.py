#!/usr/bin/env python3
"""Publish a new release: bump version, update changelog, tag, push, create GitHub release.

Usage:
    uv run scripts/publish.py              # bump chosen by git-cliff from commit types
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
    Only `git push --no-verify` skips the hook; this script never passes it.

Steps (in order — validate is FIRST, no skipping):
    1. Pre-flight: working tree clean + required tools present
    2. Validate (MANDATORY — all checks 0 errors): npm ci, typecheck,
       lint, build, test, ruff, shellcheck, plugin.json, CPV
    3. Determine next version (git-cliff --bumped-version or flag override)
    4. Generate CHANGELOG.md (git-cliff)
    5. Sync version to plugin.json, package.json, cli/main.ts, pyproject.toml
    6. Rebuild dist (with new version)
    7. Update README.md badges
    8. Commit as `chore(release): vX.Y.Z`
    9. Create annotated git tags vX.Y.Z AND {plugin-name}--vX.Y.Z
       (the second is the plugin-dependency resolver tag, CC >= 2.1.110)
   10. Push --follow-tags (pre-push hook walks ancestry, finds publish.py)
   11. gh release create
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

# CPV's integrity self-check bypass — the ONLY environment override this
# pipeline passes to a child process. The VALUE is printed and written to the
# on-disk report, not just the key: an auditor must be able to see the
# EFFECTIVE value of the disable in the artifact.
CPV_INTEGRITY_BYPASS = "PLUGIN_SKIP_GITHUB_INTEGRITY"


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
    if start_idx == -1 or end_idx == -1 or end_idx < start_idx:
        return False
    build_color = "brightgreen" if build_ok else "red"
    build_label = "passing" if build_ok else "failing"
    # Centered HTML badge block — auto-regenerated on every publish run.
    # Keep this format in sync with the initial block in README.md so the
    # visual layout (center-aligned, one <a><img> per badge) doesn't drift.
    badges = f"""{start_marker}
<p align="center">
<a href="#"><img alt="version" src="https://img.shields.io/badge/version-{version}-blue"></a>
<a href="#"><img alt="build" src="https://img.shields.io/badge/build-{build_label}-{build_color}"></a>
<a href="#"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.x-blue"></a>
<a href="#"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen"></a>
<a href="#"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
<a href="https://github.com/Emasoft/emasoft-plugins"><img alt="marketplace" src="https://img.shields.io/badge/marketplace-emasoft--plugins-purple"></a>
<a href="#"><img alt="platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey"></a>
</p>
{end_marker}"""
    new_content = content[:start_idx] + badges + content[end_idx + len(end_marker) :]
    readme_path.write_text(new_content, encoding="utf-8")
    return True


def run(
    cmd: list[str],
    *,
    check: bool = True,
    capture: bool = True,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Run a command, printing it first. Fail-fast on error.

    ``env`` REPLACES the child's whole environment — subprocess.run does
    not merge it with the parent's. When ``env`` is given it must therefore
    be a COMPLETE environment for the child (the parent environment plus the
    overrides), never a delta: a partial dict would silently strip PATH (and
    every other inherited variable) from every child process. ``env=None``
    means "inherit the parent environment", which is why every call site
    other than the two CPV ones is unaffected.
    THE CONCRETE SYMPTOM of a partial env is a FileNotFoundError (or
    "command not found") for the EXECUTABLE ITSELF: the child's PATH
    REPLACES the parent's, so subprocess resolves the executable against the
    DEFAULT path ('/bin', '/usr/bin') rather than the parent's, and the
    failure names the missing binary rather than the bug that stripped the
    environment — so the symptom appears ONLY IF that binary is not in the
    default path (uvx under /opt/homebrew/bin is not; ls under /bin is).
    Look there first when a call site passes ``env``.
    """
    print(f"  $ {shlex.join(cmd)}")
    return subprocess.run(  # ubs:ignore -- generic runner for tests/git push/CPV publish steps with no known upper bound; a timeout would kill a legitimate long publish
        cmd,
        check=check,
        capture_output=capture,
        text=True,
        encoding="utf-8",
        cwd=cwd,
        env=env,
    )


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
      6. no bumpable commits → fail-fast (exit 1; user must pass an explicit bump flag)
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
    # git-cliff returned the current version (no bumpable commits) or failed.
    # Fail-fast: a release must not be forced when there is nothing to release.
    # Use --patch, --minor, --major, or --set to override explicitly.
    print(
        "ERROR: git-cliff found no bumpable commits since the last tag.\n"
        "  Use --patch, --minor, --major, or --set <x.y.z> to bump manually.",
        file=sys.stderr,
    )
    sys.exit(1)


def resolver_tag_for(plugin_name: str, release_tag: str) -> str:
    """The plugin-dependency resolver tag `{plugin-name}--v{version}`.

    Claude Code (>= 2.1.110) resolves a version-constrained plugin
    dependency ONLY against a git tag of this exact shape — the plain
    release tag `vX.Y.Z` is invisible to it. A dependent pinning us to a
    version range on a repo that carries only `vX.Y.Z` tags gets the
    misleading `no git tag satisfying <range>`, so we push both.

    Raises ValueError on an empty/whitespace name: a `--vX.Y.Z` tag with
    no name in front resolves nothing and would ship the very failure this
    tag exists to prevent. (issue #11 / ai-maestro TRDD-JT3U4ZVM.)
    """
    name = str(plugin_name).strip()
    if not name:
        raise ValueError("plugin manifest has no 'name' — cannot form resolver tag")
    return f"{name}--{release_tag}"


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
    ("uv", "curl -LsSf https://astral.sh/uv/install.sh | sh"),
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
      10. uv run pytest   — Python test suite under tests/ (mirrors the
          release workflow's marker filter; TRDD-CCS6ENHU: these tests
          previously ran only at release time, after the artifact was
          already being shipped, so a regression here reached CI unnoticed)
    """
    mcp_dir = str(repo_root / "scripts" / "llm-ext")
    reports = _reports_dir(repo_root)
    print(f"  Reports: {reports}")

    # 1. Clean dependency install. Always — no conditional skip. A publish
    # must run against a reproducible dep tree, not whatever the local
    # node_modules happens to have.
    if not _run_check("npm-ci", ["npm", "ci", "--ignore-scripts"], mcp_dir, repo_root):
        return False

    # 1b. Rebuild native modules. `--ignore-scripts` above blocks every
    # package's install hook for supply-chain safety, but `better-sqlite3`
    # ships as a native addon (.node binary) that the mass-scouting tests
    # require at runtime. Without an explicit rebuild step, the test suite
    # fails with "Could not locate the bindings file" — the lifecycle
    # script that builds the platform-specific .node was skipped.
    #
    # `npm rebuild <pkg>` only reruns build hooks for the named package, so
    # the supply-chain protection on every other dependency is preserved.
    # `--no-ignore-scripts` is mandatory: phardener installs
    # `ignore-scripts=true` into ~/.npmrc, and a global flag silently
    # overrides `npm rebuild`'s default behaviour. Without the explicit
    # override, the rebuild reports "rebuilt dependencies successfully"
    # but never actually runs better-sqlite3's `prebuild-install`
    # invocation — the .node file is missing afterward.
    if not _run_check(
        "rebuild-native",
        ["npm", "rebuild", "better-sqlite3", "--no-ignore-scripts"],
        mcp_dir,
        repo_root,
    ):
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
        "node_modules",
        ".git",
        "scripts_dev",
        "docs_dev",
        "samples_dev",
        "examples_dev",
        "tests_dev",
        "downloads_dev",
        "libs_dev",
        "builds_dev",
        ".claude",
        "dist",
        "reports_dev",
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

    # 10. Python test suite under tests/ (TRDD-CCS6ENHU). Mirrors
    # .github/workflows/release.yml's marker filter exactly, so a test
    # that would fail the release workflow fails the local gate first —
    # before CCS6ENHU these 200+ tests ran only at release time, after
    # the artifact was already being shipped. `--extra dev` is REQUIRED:
    # pytest lives only in pyproject.toml's optional "dev"/"test" extras,
    # not a base [project] dependency, so a bare `uv run pytest` fails
    # with "Failed to spawn: pytest" on a machine with no pytest elsewhere
    # on PATH (verified empirically under a stripped PATH) — a machine with
    # pytest elsewhere on PATH masks this. `--ignore=tests/dogfood` excludes the CLI
    # harness module (no test_* functions, contributes zero test items
    # either way) from collection.
    if not _run_check(
        "pytest",
        ["uv", "run", "--extra", "dev", "pytest", "tests/", "--ignore=tests/dogfood", "-m", "not integration and not slow"],
        str(repo_root),
        repo_root,
    ):
        return False

    return True


# ── CPV skillaudit-advisory bootstrap (upstream bug Emasoft/claude-plugins-validation#41) ──
#
# CPV's native skillaudit scanner emits KNOWN false positives that flag this
# plugin's own benign pattern-source files (scanner test fixtures, rule
# catalogs, security-scan helper strings) as CRITICAL/MAJOR. Issue #41 tracks
# the upstream fix. Until it lands, a publish can OPT IN — via plugin.json's
# `cpv.skillaudit_advisory: true` — to DOWNGRADE skillaudit-tagged
# CRITICAL/MAJOR findings to advisory (printed, never hidden) so they no
# longer block the release.
#
# This NEVER weakens the gate for a real finding: ANY non-skillaudit
# CRITICAL/MAJOR still fails the publish, and with the opt-in absent the gate
# behaves EXACTLY as before (strict, returncode-based).
#
# The skillaudit tag is identified from CPV's JSON `results[].message`, which
# the native scanner prefixes with `[skillaudit:<category> <rule_id>]`
# (validate_plugin.py:2355, cpv_skillaudit_native.py:2497). CPV's --json
# emitter exposes only level/message/file/line per finding — there is no
# separate rule/category field — so classification keys off the message tag.

# Severities that block a publish (CPV exits non-zero on either).
_CPV_BLOCKING_LEVELS = frozenset({"CRITICAL", "MAJOR"})


def _is_skillaudit_finding(message: str) -> bool:
    """True if a CPV finding message carries the skillaudit threat tag.

    The native skillaudit scanner prefixes every finding's message with
    ``[skillaudit:<category> <rule_id>]``. We match on the substring
    ``skillaudit`` (case-insensitive) so a future tag-format tweak that
    keeps the word still classifies correctly. Matching is deliberately
    broad-but-anchored to the literal threat-domain token: a non-skillaudit
    finding never contains it.
    """
    return "skillaudit" in (message or "").lower()


def _extract_cpv_json(raw: str) -> str | None:
    """Extract the trailing top-level JSON object from cpv-remote-validate --json.

    The wrapper prints a human-readable lint preamble FIRST (a banner +
    per-language file counts), then the JSON object, whose opening ``{`` sits
    at column 0 on its own line. So ``json.loads(raw)`` fails on the preamble
    ("Expecting value: line 2"). We slice from the first line-anchored ``{``
    to EOF. Returns None when no line-anchored ``{`` exists, so the caller
    falls back to the strict gate (never fail-open).
    """
    match = re.search(r"(?m)^\{", raw)
    return raw[match.start() :] if match else None


def classify_cpv_findings(
    json_text: str, *, skillaudit_advisory: bool
) -> tuple[bool, list[dict], list[dict]]:
    """Pure parse/classify of CPV --json output. No I/O, no subprocess.

    Returns ``(parse_ok, advisory, blocking)``:
      * ``parse_ok``   — False if the JSON could not be parsed into the
                         expected shape. The caller MUST then fall back to
                         the strict returncode-based decision (fail-closed,
                         never fail-open).
      * ``advisory``   — skillaudit-tagged CRITICAL/MAJOR findings that the
                         opt-in downgrades to advisory. Only populated when
                         ``skillaudit_advisory`` is True; ALWAYS printed by
                         the caller (never hidden).
      * ``blocking``   — CRITICAL/MAJOR findings that still fail the publish.
                         When the opt-in is False this is every CRITICAL/MAJOR
                         (identical to today's behavior). When the opt-in is
                         True it is every NON-skillaudit CRITICAL/MAJOR.

    The pass/fail decision is simply ``not blocking`` — the caller computes
    it so this stays a pure classifier that is trivially unit-testable.
    """
    extracted = _extract_cpv_json(json_text)
    if extracted is None:
        # No line-anchored JSON object in the output → fall back to strict.
        return False, [], []
    try:
        data = json.loads(extracted)
        results = data["results"]
    except (json.JSONDecodeError, TypeError, KeyError):
        # Malformed / unexpected shape → signal the caller to fall back to
        # the strict returncode path. We do NOT decide pass/fail here.
        return False, [], []
    if not isinstance(results, list):
        return False, [], []

    advisory: list[dict] = []
    blocking: list[dict] = []
    for finding in results:
        # Defensive: a non-dict entry means the shape drifted — bail to
        # the strict fallback rather than silently mis-classifying.
        if not isinstance(finding, dict):
            return False, [], []
        if finding.get("level") not in _CPV_BLOCKING_LEVELS:
            continue
        if skillaudit_advisory and _is_skillaudit_finding(finding.get("message", "")):
            advisory.append(finding)
        else:
            blocking.append(finding)

    return True, advisory, blocking


def _read_skillaudit_advisory_optin(repo_root: Path) -> bool:
    """Read plugin.json's ``cpv.skillaudit_advisory`` opt-in (default False).

    Mirrors how the canon opt-out reads plugin.json's ``cpv`` block. Any
    read/parse error or a non-bool value resolves to False — the opt-in must
    be EXPLICITLY true to have any effect, so the gate defaults to strict.
    """
    plugin_json = repo_root / ".claude-plugin" / "plugin.json"
    try:
        manifest = json.loads(plugin_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, FileNotFoundError, OSError):
        return False
    cpv = manifest.get("cpv")
    if not isinstance(cpv, dict):
        return False
    return cpv.get("skillaudit_advisory") is True


def _format_finding(finding: dict) -> str:
    """One-line human render of a CPV finding dict (level/message/file/line)."""
    file_info = f" ({finding['file']})" if finding.get("file") else ""
    line_info = f":{finding['line']}" if finding.get("line") else ""
    return f"[{finding.get('level')}] {finding.get('message', '')}{file_info}{line_info}"


def _cpv_env() -> dict[str, str]:
    """Environment for the two CPV invocations — see the comment at the call site.

    It is a COMPLETE environment (the parent environment plus the bypass),
    because subprocess.run REPLACES the child's environment rather than
    merging into it.
    """
    return {**os.environ, CPV_INTEGRITY_BYPASS: "1"}


def run_cpv_validation(repo_root: Path) -> bool:
    """Run CPV remote validation. Fail if any CRITICAL or MAJOR issue found.

    CPV (claude-plugins-validation) is a third-party validator for Claude
    Code plugins. It enforces strict structural rules on skills / agents /
    hooks / commands. Publish aborts if CPV returns a non-zero exit code,
    which it does when CRITICAL or MAJOR issues are present.

    Skillaudit-advisory bootstrap (upstream bug #41): when plugin.json sets
    ``cpv.skillaudit_advisory: true``, KNOWN-FP skillaudit-tagged
    CRITICAL/MAJOR findings are downgraded to advisory (printed, not
    blocking). Any non-skillaudit CRITICAL/MAJOR still fails, and with the
    opt-in absent the gate is byte-for-byte the strict behavior it always was.
    If --json parsing fails for ANY reason we fall back to the strict
    returncode decision — never fail open.
    """
    # ONE environment snapshot for BOTH invocations below: the text run and
    # the --json run must be the SAME validator run, so they share one env.
    cpv_env = _cpv_env()
    # The bypass record is built ONCE and written to BOTH sinks (stdout and
    # the on-disk report), so the audit trail can never depend on whether the
    # operator's shell already exported the flag.
    bypass_note = (
        f"CPV INTEGRITY SELF-CHECK DISABLED via {CPV_INTEGRITY_BYPASS}=1 "
        f"— CPV's GitHub-anchored hash check was NOT run for this validation"
    )
    # ---------------------------------------------------------------------
    # DISABLE (not a workaround): CPV's GitHub integrity self-check is
    # skipped on the two CPV invocations below, via the env var
    # PLUGIN_SKIP_GITHUB_INTEGRITY=1 — a deliberate DISABLE of a check that
    # cannot pass under the `uvx --from git+...` transport.
    # CPV's own classification: "a defence against tampering, NOT a publish
    # gate" (generate_plugin_repo.py:3408; env var exempt at :3437) — as of
    # v5.22.0, 2026-10-21. What it verifies: CPV's OWN validator tree
    # against CPV's OWN GitHub manifest (_plugin_verify_hashes.py:320;
    # plugin_root defaults to CPV's own package dir at :369; manifest from
    # REPO_RAW_TAG_URL at :73) — same version/date. No CPV call site ever
    # passes OUR plugin's root, so no check of our bytes is skipped — none
    # existed. Measured mismatch totals: 3495 at v3.19.1 and 3403 at v5.22.0
    # under the uvx transport; 2 and 7 from a clone — CPV's own source
    # files and site-packages, not our plugin's bytes.
    # WHAT THE DISABLED CHECK WOULD HAVE CAUGHT: it compares the INSTALLED
    # tree against the manifest published for the TAG being installed — so it
    # is what would detect a MOVED TAG or a tampered local uv cache, not
    # merely wrong bytes. A TAG IS MOVABLE; A COMMIT SHA IS NOT. Pinning
    # the SHA (v5.22.0's release commit) is what closes that exposure: the
    # transport's provenance is fixed by the ref itself rather than by the
    # check that is disabled. RESIDUAL EXPOSURE that remains: the local uv
    # cache could be tampered with.
    # WHY A SHA AND NOT A TAG: a tag's target can be moved under us, so the
    # pin would silently change meaning; a commit SHA is immutable. The SHA
    # must be UPDATED by hand whenever the pin moves — the pin-bump
    # policy's trigger is unchanged (upstream #243 / #256), and the order
    # rule still holds: remove the bypass FIRST, then update the SHA.
    # THE TRANSPORT RESOLVES THE SHA — MEASURED, not assumed, under BOTH
    # transports the gate can use.
    # (1) FRESH VENV (uv venv <path> --python 3.12; VIRTUAL_ENV=<path> uv pip
    # install "git+https://github.com/Emasoft/claude-plugins-validation@d5d6149735c4f0055bb3b83a56b28036079682ad")
    # leaves an installed dist-info whose direct_url.json records BOTH
    # "requested_revision" AND "commit_id" equal to the pinned SHA. uv does
    # NOT silently resolve a SHA-ref to a branch tip: the SHA-ref is fetched
    # AS that commit. (Measured 2026-10-21, fresh venv.)
    # (2) UVX — the transport the pipeline ACTUALLY uses. Running the gate's
    # own command (PLUGIN_SKIP_GITHUB_INTEGRITY=1 uvx --from
    # git+https://github.com/Emasoft/claude-plugins-validation@d5d6149735c4f0055bb3b83a56b28036079682ad
    # --with pyyaml cpv-remote-validate --help) installs a dist-info whose
    # direct_url.json records BOTH "requested_revision" AND "commit_id" equal
    # to the pinned SHA. The SHA PINS under uvx too. By contrast, this
    # machine's uv cache holds SEVEN entries whose requested_revision is the
    # TAG "v5.22.0" and whose commit_id is the OTHER commit
    # 77b3762f0691a4d97d6f31226366a992f5dab439 — plus one tag entry that
    # resolved to d5d61497 (the tag's current target). So under uvx the TAG
    # resolved to BOTH commits at different times, while the SHA resolved
    # to exactly one. (Measured 2026-10-21: the SHA-pinned uvx install
    # above records commit_id = requested_revision = the pinned SHA; a
    # fresh-cache uvx install of the TAG recorded commit_id d5d61497 and
    # requested_revision "v5.22.0".)
    # THE OPERATOR CAN CHECK IT — and the PATH DIFFERS between the two
    # transports, so look in the right place: under the fresh venv it is the
    # installed dist-info's direct_url.json in that venv's site-packages
    # (<venv>/lib/python*/site-packages/claude_plugins_validation-*.dist-info/direct_url.json);
    # under uvx it is the installed dist-info's direct_url.json inside uv's
    # CACHE archive directory
    # (~/.cache/uv/archive-v0/*/lib/python*/site-packages/claude_plugins_validation-*.dist-info/direct_url.json),
    # because uvx keeps its tool environment in the cache, not in a venv the
    # operator holds. That file is how anyone confirms WHICH validator
    # actually ran, so the comment names the path rather than leaving the
    # evidence implicit.
    # Without the bypass the validator sys.exit(2)s BEFORE its first phase
    # (validate_plugin.py:9361 -> _plugin_verify_hashes.py:508), producing NO
    # findings and NO --json output. SHARED ROOT CAUSE: the `uvx --from
    # git+...` transport can never satisfy a whole-repo manifest — in CI and
    # locally alike; CI has set PLUGIN_SKIP_GITHUB_INTEGRITY=1 since commit
    # cde97948 (release.yml:71): PRECEDENT, not the reason.
    # COST of the pin: ZERO today — v5.22.0 IS CPV's newest tag and no tag
    # of any vintage passes the uvx transport, so the pin changes no local
    # behaviour today; the cost is purely future (no upstream fix reaches the
    # gate until the pin moves). REMOVAL CONDITION: remove this disable when
    # upstream ships a wheel-scoped / transport-correct integrity manifest
    # (upstream #243, fix proposed in #256) so the check can pass under the
    # uvx transport. SCOPE: only the two CPV invocations below; every other
    # run() call site is unaffected because env defaults to None.
    # ORDER OF OPERATIONS: remove the bypass FIRST, then move the pin (i.e.
    # update the SHA). Moving the pin first would make the gate abort again
    # with NO verdict — the new ref would still ship a whole-repo manifest, so
    # the integrity check would still exit(2) before its first phase and the
    # release would have NO gate at all.
    # TRACKER: this debt is tracked by card TRDD-PQW0XDS1 (PROJECT scope), so
    # the removal condition is visible to anyone who clones this repo and not
    # only to whoever remembers the upstream issue numbers.
    # ---------------------------------------------------------------------
    base_cmd = [
        "uvx",
        "--from",
        "git+https://github.com/Emasoft/claude-plugins-validation@d5d6149735c4f0055bb3b83a56b28036079682ad",  # v5.22.0
        "--with",
        "pyyaml",
        "cpv-remote-validate",
        "plugin",
        str(repo_root),
    ]

    # Run 1 — human-readable text, always written to the CPV report file
    # (reports_dev/publish/cpv.log under the repo root — a gitignored
    # artifact, never a committed file).
    cpv_result = run(base_cmd, capture=True, check=False, env=cpv_env)
    report = _reports_dir(repo_root) / "cpv.log"
    output = (cpv_result.stdout or "") + (cpv_result.stderr or "")
    # The bypass record leads the artifact: an auditor opening the report
    # sees the disable at the top, not only in the release log on stdout.
    print(f"  cpv: {bypass_note}")
    report.write_text(f"# {bypass_note}\n{output}", encoding="utf-8")

    # Clean run (CPV exit 0) — nothing to classify, pass exactly as today.
    if cpv_result.returncode == 0:
        print("  OK: cpv")
        return True

    skillaudit_advisory = _read_skillaudit_advisory_optin(repo_root)

    # Opt-in absent → STRICT, byte-for-byte the original behavior. We don't
    # even spend a second CPV invocation; any non-zero exit fails.
    if not skillaudit_advisory:
        return _cpv_strict_fail(report, cpv_result)

    # Opt-in present → Run 2 with --json so we can classify findings. cpv's
    # `plugin` validator forwards unknown args, so --json reaches it.
    json_result = run([*base_cmd, "--json"], capture=True, check=False, env=cpv_env)
    # The --json run's payload is the EVIDENCE the gate's verdict rests on:
    # classify_cpv_findings parses it and its finding counts decide pass or
    # fail. cpv.log holds only the TEXT run's output, so without this second
    # artifact an auditor sees the disable and the prose but not the
    # classified findings — and on a FAILING release not even the blocking
    # ones. Write it WHENEVER the --json run happens (it is the evidence of a
    # PASSING gate too). The --json run happens ONLY when the
    # skillaudit-advisory opt-in is present, so on the STRICT path (opt-in
    # absent) the --json run never happens and NO findings artifact is
    # written at all: there cpv.log alone is the record, and the ABSENCE of a
    # sibling findings file is EXPECTED, not a bug. The write is placed
    # BEFORE the parse_ok check below, so a parse-fail DOES still leave the
    # --json payload on disk. The file leads with the same bypass note as
    # cpv.log, so BOTH artifacts carry the disable record. It is a gitignored
    # artifact (reports_dev/), never a committed file.
    # The leading note line makes this file invalid JSON, so the extension is
    # .txt and NOT .json: a .json file that json.loads rejects is a trap for
    # whoever reaches for jq first.
    findings_report = _reports_dir(repo_root) / "cpv-findings.txt"
    findings_report.write_text(
        f"# {bypass_note}\n{json_result.stdout or ''}", encoding="utf-8"
    )
    parse_ok, advisory, blocking = classify_cpv_findings(
        json_result.stdout or "", skillaudit_advisory=skillaudit_advisory
    )

    # JSON parse failed → fall back to strict returncode behavior. NEVER
    # fail open: a malformed JSON must not let a real finding through.
    if not parse_ok:
        print(
            "  WARNING: CPV --json output could not be parsed; "
            "falling back to strict gate.",
            file=sys.stderr,
        )
        return _cpv_strict_fail(report, cpv_result)

    # Always surface advisory findings — never hidden.
    if advisory:
        print(
            f"  ADVISORY (skillaudit FP, #41): {len(advisory)} skillaudit "
            f"finding(s) downgraded to advisory via cpv.skillaudit_advisory opt-in:"
        )
        for finding in advisory:
            print(f"    {_format_finding(finding)}")

    # Any non-skillaudit CRITICAL/MAJOR remains → FAIL, exactly as today.
    if blocking:
        print("ERROR: CPV validation failed — see", report, file=sys.stderr)
        for finding in blocking:
            print(f"  {_format_finding(finding)}", file=sys.stderr)
        return False

    # Only skillaudit FPs remained, opt-in active → PASS.
    print("  OK: cpv (only skillaudit FPs remained — advisory, see #41)")
    return True


def _cpv_strict_fail(report: Path, cpv_result: subprocess.CompletedProcess) -> bool:
    """Strict, original CPV failure path: print tail of output, return False."""
    print("ERROR: CPV validation failed — see", report, file=sys.stderr)
    if cpv_result.stdout:
        for line in cpv_result.stdout.strip().split("\n")[-40:]:
            print(f"  {line}", file=sys.stderr)
    return False


def main():
    parser = argparse.ArgumentParser(description="Publish a new release")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--patch", action="store_true", help="Bump patch version")
    group.add_argument("--minor", action="store_true", help="Bump minor version")
    group.add_argument("--major", action="store_true", help="Bump major version")
    group.add_argument("--set", type=str, metavar="VERSION", help="Set explicit version (x.y.z)")
    parser.add_argument("--dry-run", "-n", action="store_true", help="Preview without making changes")
    parser.add_argument(
        "--check-only",
        action="store_true",
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
        line
        for line in (pf_status.stdout or "").strip().splitlines()
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
    # Fail fast naming the file; a bare JSONDecodeError would not say which manifest is corrupt.
    try:
        manifest = json.loads(plugin_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"ERROR: {plugin_json} is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(1)
    current = manifest.get("version", "0.0.0")
    new_version = determine_next_version(args, current)
    tag = f"v{new_version}"
    # Also push the plugin-dependency resolver tag (see resolver_tag_for).
    try:
        resolver_tag = resolver_tag_for(manifest.get("name", ""), tag)
    except ValueError as exc:
        print(f"ERROR: {plugin_json}: {exc}", file=sys.stderr)
        sys.exit(1)

    # Verify neither tag already exists (local + remote) — a stale copy of
    # either aborts, since both are pushed together.
    for t in (tag, resolver_tag):
        local = run(["git", "tag", "--list", t], check=False)
        if local.stdout and local.stdout.strip() == t:
            print(f"ERROR: tag '{t}' already exists locally", file=sys.stderr)
            sys.exit(1)
        remote = run(["git", "ls-remote", "--tags", "origin", t], check=False)
        if remote.stdout and remote.stdout.strip():
            print(f"ERROR: tag '{t}' already exists on remote origin", file=sys.stderr)
            sys.exit(1)

    print(f"  Planned: {current} -> {new_version} (tags: {tag}, {resolver_tag})")
    print()

    # ── dry-run exits here, after checks pass AND version is determined ──
    if args.dry_run:
        print("[DRY RUN] All checks passed.")
        print(f"[DRY RUN] Would bump {current} -> {new_version}")
        print(f"[DRY RUN] Would generate CHANGELOG.md, sync version, commit, tag {tag} + {resolver_tag}, push")
        return

    # ── 4. Generate CHANGELOG.md via git-cliff ──
    # PREPEND mode: only the unreleased commits are rendered (under the
    # new tag) and inserted at the top of the existing CHANGELOG.md.
    # This replaced full-history --output regen (TRDD-WIO13P1P): the
    # full regen took ~16 minutes per publish on this repo and rewrote
    # every past entry, whereas prepend takes seconds and leaves
    # pre-2026-08-19 full-body entries untouched. git-cliff strips the
    # configured [changelog].header from the old file and re-writes
    # header + new section + rest, so the header must stay in sync with
    # the file's first lines. commit_parsers control the section layout.
    print("── 4. Generate CHANGELOG.md ──")
    cliff_result = run(
        ["git-cliff", "--unreleased", "--tag", tag, "--prepend", str(changelog)],
        capture=True,
        check=False,
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

    # Sync version to scripts/llm-ext/package.json
    pkg_json = repo_root / "scripts" / "llm-ext" / "package.json"
    if pkg_json.exists():
        # Fail fast naming the file; a bare JSONDecodeError would not say which package.json is corrupt.
        try:
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"ERROR: {pkg_json} is not valid JSON: {exc}", file=sys.stderr)
            sys.exit(1)
        pkg["version"] = new_version
        pkg_json.write_text(
            json.dumps(pkg, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"  Synced version to {pkg_json.relative_to(repo_root)}")

    # NOTE: mcp-server/server.json (the MCP registry manifest) was deleted with
    # the server in the CLI migration. Its sync block is gone with it — it was
    # dead code behind an `exists()` guard that can never be true again, and
    # leaving it invited a future reader to re-add server.json as a version
    # anchor that nothing reads. The anchors are now exactly: plugin.json,
    # scripts/llm-ext/package.json, scripts/llm-ext/src/cli/main.ts and pyproject.toml.

    # Sync the hardcoded version in the CLI source (cli/main.ts VERSION).
    #
    # This anchor used to be the `version:` field of the `McpServer`
    # constructor in index.ts. That constructor was deleted with the server, so
    # the old regex matched nothing AND the already-at-target check could never
    # pass either — meaning every release from that point on aborted here. The
    # CLI is the only entrypoint now, so its VERSION constant is the anchor.
    #
    # No-op tolerance (canonical-pipeline pattern):
    # `re.subn` returns (new_text, count). When count == 0 the regex did
    # not match — but in this codebase that case has two distinct causes:
    #   (a) the literal really is missing (build was edited; structural bug)
    #   (b) the literal already shows new_version (republish, retry, or a
    #       prior step bumped it ahead of us — perfectly legal idempotent
    #       state)
    # We can tell which by re-checking whether new_version is ALREADY in
    # the file with the expected shape. If yes → idempotent skip. If no
    # → real structural bug, abort.
    index_ts = repo_root / "scripts" / "llm-ext" / "src" / "cli" / "main.ts"
    if index_ts.exists():
        src = index_ts.read_text(encoding="utf-8")
        pattern = r"""(const VERSION = (["'`]))[^"'`]+\2"""
        updated, count = re.subn(
            pattern,
            rf"\g<1>{new_version}\g<2>",
            src,
        )
        if count == 0:
            # No replacement happened. Check whether the file already
            # carries new_version in the expected shape — if so this is
            # a benign idempotent republish, not a structural bug.
            already_at_target = re.search(
                rf"""const VERSION = ["'`]{re.escape(new_version)}["'`]""",
                src,
            )
            if already_at_target:
                print(
                    f"  cli/main.ts already at {new_version} — idempotent skip"
                )
            else:
                print(
                    "ERROR: regex failed to match `const VERSION = \"...\"` in "
                    "scripts/llm-ext/src/cli/main.ts (and the file is not already "
                    f"at {new_version}). Likely the constant was renamed, "
                    "reformatted onto multiple lines, or computed instead of "
                    "being a literal.",
                    file=sys.stderr,
                )
                sys.exit(1)
        else:
            index_ts.write_text(updated, encoding="utf-8")
            print(f"  Synced version to {index_ts.relative_to(repo_root)}")

    # Sync version to pyproject.toml (project-level Python tooling package).
    # Must stay aligned with plugin.json so users don't see three disagreeing
    # numbers when inspecting the repo.
    #
    # No-op tolerance (canonical-pipeline pattern, see cli/main.ts block above):
    # `re.subn` distinguishes count==0 (no match) from count>=1 (replaced).
    # On count==0 we re-check whether the file already carries new_version
    # in the expected shape — if so the file is at target and the skip is
    # benign (idempotent republish). If not, the field shape changed and
    # we abort.
    pyproject = repo_root / "pyproject.toml"
    if pyproject.exists():
        src = pyproject.read_text(encoding="utf-8")
        updated, count = re.subn(
            r'(?m)^(version\s*=\s*")[^"]+(")',
            rf"\g<1>{new_version}\g<2>",
            src,
            count=1,
        )
        wrote_pyproject = False
        if count == 0:
            already_at_target = re.search(
                rf'(?m)^version\s*=\s*"{re.escape(new_version)}"',
                src,
            )
            if already_at_target:
                print(
                    f"  pyproject.toml already at {new_version} — idempotent skip"
                )
            else:
                print(
                    "ERROR: regex failed to match version in pyproject.toml "
                    f"(and file is not already at {new_version}). The "
                    "`version = \"...\"` line was likely removed or moved.",
                    file=sys.stderr,
                )
                sys.exit(1)
        else:
            pyproject.write_text(updated, encoding="utf-8")
            print(f"  Synced version to {pyproject.relative_to(repo_root)}")
            wrote_pyproject = True

        # Regenerate uv.lock so its root-package version matches pyproject.toml.
        # `uv lock` is fast (no network if nothing changed) and deterministic.
        # Run unconditionally when pyproject exists: even an idempotent skip
        # benefits from `uv lock` because uv.lock may itself have drifted
        # from a different cause (transitive dep churn since last lock).
        lock_result = run(["uv", "lock"], capture=True, check=False, cwd=str(repo_root))
        if lock_result.returncode != 0:
            print("ERROR: `uv lock` failed after pyproject.toml bump.", file=sys.stderr)
            if lock_result.stderr:
                print(f"  {lock_result.stderr.strip()}", file=sys.stderr)
            sys.exit(1)
        if wrote_pyproject:
            print("  Regenerated uv.lock")
        else:
            print("  uv.lock re-resolved (no-op if already current)")
    print()

    # ── 6. Rebuild dist (with new version) ──
    print("── 6. Rebuild dist ──")
    mcp_dir = str(repo_root / "scripts" / "llm-ext")
    rebuild = run(["npm", "run", "build"], capture=True, check=False, cwd=mcp_dir)
    if rebuild.returncode != 0:
        print("ERROR: dist rebuild failed.", file=sys.stderr)
        if rebuild.stderr:
            print(f"  {rebuild.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    # Assert the SHIPPED bundle carries the new version. This is the gate that
    # catches a build that silently no-oped, so it must point at the artifact
    # users actually run: dist/llm-ext.js (the CLI). It used to check
    # dist/index.js — the MCP server bundle, which no longer carries a version
    # literal at all, so the check would fail every release.
    dist_cli = repo_root / "scripts" / "llm-ext" / "dist" / "llm-ext.js"
    if not dist_cli.exists():
        print(
            "ERROR: scripts/llm-ext/dist/llm-ext.js missing after build — the CLI "
            "bundle is the shipped artifact and cannot be absent.",
            file=sys.stderr,
        )
        sys.exit(1)
    if new_version not in dist_cli.read_text(encoding="utf-8"):
        print(
            f"ERROR: version '{new_version}' not found in dist/llm-ext.js",
            file=sys.stderr,
        )
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
    pkg_json_path = repo_root / "scripts" / "llm-ext" / "package.json"
    if changelog.exists():
        files_to_stage.append(str(changelog))
    if readme.exists():
        files_to_stage.append(str(readme))
    if pkg_json_path.exists():
        files_to_stage.append(str(pkg_json_path))
    # Must be the SAME file the version-sync block above rewrote, or the bump
    # is left unstaged: the release commit ships without it and the very next
    # publish starts on a dirty tree. (server.json was the MCP registry
    # manifest and is gone.)
    cli_main_ts_path = repo_root / "scripts" / "llm-ext" / "src" / "cli" / "main.ts"
    if cli_main_ts_path.exists():
        files_to_stage.append(str(cli_main_ts_path))
    pyproject_path = repo_root / "pyproject.toml"
    if pyproject_path.exists():
        files_to_stage.append(str(pyproject_path))
    uv_lock_path = repo_root / "uv.lock"
    if uv_lock_path.exists():
        files_to_stage.append(str(uv_lock_path))
    dist_dir = repo_root / "scripts" / "llm-ext" / "dist"
    if dist_dir.exists():
        files_to_stage.append(str(dist_dir))
    run(["git", "add"] + files_to_stage, capture=False)
    # Warn if any modified files were missed
    porcelain = run(["git", "status", "--porcelain"], check=False)
    if porcelain.stdout:
        unstaged = [
            line for line in porcelain.stdout.strip().splitlines() if len(line) >= 2 and line[1] not in (" ", "?")
        ]
        if unstaged:
            print("WARNING: unstaged modified files detected:", file=sys.stderr)
            for line in unstaged:
                print(f"  {line}", file=sys.stderr)
    run(["git", "commit", "-m", f"chore(release): {tag}"], capture=False)
    print()

    # ── 9. Tag ──
    # Two annotated tags on the release commit: the human-facing release
    # tag and the resolver tag the plugin-dependency system requires. Both
    # are annotated so `git push --follow-tags` carries them.
    print("── 9. Tag ──")
    run(["git", "tag", "-a", tag, "-m", f"Release {tag}"], capture=False)
    run(["git", "tag", "-a", resolver_tag, "-m", f"Dependency-resolver tag for {tag}"], capture=False)
    print()

    # ── 10. Push ──
    # The pre-push hook walks the process ancestry and finds THIS script as an
    # ancestor of `git push`, which is what authorises the push. There is no
    # lock file and no env var — both are spoofable, ancestry is not.
    print("── 10. Push ──")
    push_result = run(["git", "push", "--follow-tags"], capture=True, check=False)
    if push_result.returncode != 0:
        print("ERROR: push failed. Rolling back commit and tag.", file=sys.stderr)
        if push_result.stderr:
            print(f"  {push_result.stderr.strip()}", file=sys.stderr)
        run(["git", "reset", "--hard", "HEAD~1"], check=False, capture=False)
        run(["git", "tag", "-d", tag], check=False, capture=False)
        run(["git", "tag", "-d", resolver_tag], check=False, capture=False)
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
