"""Tests for the CPV skillaudit-advisory bootstrap in publish.py.

Guards the gate added for upstream bug Emasoft/claude-plugins-validation#41:
CPV's native skillaudit scanner emits KNOWN false positives against this
plugin's own benign pattern-source files. The bootstrap lets a publish OPT IN
(plugin.json `cpv.skillaudit_advisory: true`) to DOWNGRADE skillaudit-tagged
CRITICAL/MAJOR findings to advisory — WITHOUT ever weakening the gate for a
real finding, and with the opt-in absent behaving byte-for-byte as before.

These tests exercise the PURE classifier `classify_cpv_findings` and the
opt-in reader `_read_skillaudit_advisory_optin` in isolation. No real CPV is
invoked — CPV's --json shape (`results[].{level,message,file,line}`, with the
skillaudit tag `[skillaudit:<category> <rule_id>]` embedded in `message`) is
reproduced as fixture JSON.

The last section guards the increment-3 wiring: the scoped integrity bypass
(PLUGIN_SKIP_GITHUB_INTEGRITY=1) rides on ONE environment snapshot shared by
both CPV invocations, and EVERY gate in the repo names the SAME pinned CPV ref.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

_PUBLISH_PATH = Path(__file__).resolve().parent.parent / "scripts" / "publish.py"
_spec = importlib.util.spec_from_file_location("publish", _PUBLISH_PATH)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)


# ── fixture builders (mirror CPV's print_json shape) ─────────────────────


def _finding(level: str, message: str, file: str | None = None, line: int | None = None) -> dict:
    return {"level": level, "message": message, "file": file, "line": line}


def _skillaudit(level: str = "MAJOR") -> dict:
    """A skillaudit-tagged finding (message prefixed by the native scanner)."""
    return _finding(
        level,
        "[skillaudit:credential_exfiltration SA-014] suspicious base64 blob",
        "skills/foo/SKILL.md",
        12,
    )


def _real(level: str = "MAJOR") -> dict:
    """A genuine non-skillaudit CRITICAL/MAJOR finding."""
    return _finding(level, "Skill frontmatter missing required `name` field", "skills/bar/SKILL.md", 1)


def _cpv_json(results: list[dict]) -> str:
    return json.dumps({"exit_code": 2, "counts": {}, "results": results})


# ── classification: the four required scenarios ──────────────────────────


def test_only_skillaudit_with_optin_passes() -> None:
    """(a) only-skillaudit + opt-in ⇒ pass (downgraded to advisory)."""
    parse_ok, advisory, blocking = publish.classify_cpv_findings(
        _cpv_json([_skillaudit("CRITICAL"), _skillaudit("MAJOR")]),
        skillaudit_advisory=True,
    )
    assert parse_ok is True
    assert len(advisory) == 2
    assert blocking == []  # not blocking ⇒ the caller passes


def test_only_skillaudit_without_optin_fails() -> None:
    """(b) only-skillaudit + no opt-in ⇒ fail (strict default, unchanged)."""
    parse_ok, advisory, blocking = publish.classify_cpv_findings(
        _cpv_json([_skillaudit("CRITICAL"), _skillaudit("MAJOR")]),
        skillaudit_advisory=False,
    )
    assert parse_ok is True
    assert advisory == []  # opt-in off ⇒ nothing downgraded
    assert len(blocking) == 2  # every CRITICAL/MAJOR still blocks


def test_one_real_major_with_optin_still_fails() -> None:
    """(c) one non-skillaudit MAJOR + opt-in ⇒ still fail; FP is advisory only."""
    parse_ok, advisory, blocking = publish.classify_cpv_findings(
        _cpv_json([_skillaudit("MAJOR"), _real("MAJOR")]),
        skillaudit_advisory=True,
    )
    assert parse_ok is True
    assert len(advisory) == 1  # the skillaudit FP is still surfaced
    assert len(blocking) == 1  # the real MAJOR still fails the publish
    assert publish._is_skillaudit_finding(blocking[0]["message"]) is False


def test_clean_passes() -> None:
    """(d) clean (no CRITICAL/MAJOR) ⇒ pass regardless of opt-in."""
    for optin in (True, False):
        parse_ok, advisory, blocking = publish.classify_cpv_findings(
            _cpv_json([_finding("MINOR", "cosmetic"), _finding("NIT", "whitespace")]),
            skillaudit_advisory=optin,
        )
        assert parse_ok is True
        assert advisory == []
        assert blocking == []  # not blocking ⇒ pass


# ── safety: fail-closed on malformed input, never fail open ──────────────


def test_malformed_json_signals_fallback() -> None:
    """Garbage JSON ⇒ parse_ok False so the caller falls back to strict."""
    parse_ok, advisory, blocking = publish.classify_cpv_findings(
        "not json at all {", skillaudit_advisory=True
    )
    assert parse_ok is False
    assert advisory == [] and blocking == []


def test_missing_results_key_signals_fallback() -> None:
    """Valid JSON but no `results` key ⇒ fallback (shape drift)."""
    parse_ok, _, _ = publish.classify_cpv_findings(
        json.dumps({"exit_code": 2, "counts": {}}), skillaudit_advisory=True
    )
    assert parse_ok is False


def test_results_not_a_list_signals_fallback() -> None:
    """`results` present but not a list ⇒ fallback rather than mis-classify."""
    parse_ok, _, _ = publish.classify_cpv_findings(
        json.dumps({"results": {"oops": 1}}), skillaudit_advisory=True
    )
    assert parse_ok is False


def test_non_dict_finding_signals_fallback() -> None:
    """A non-dict entry in results ⇒ fallback (defensive, never fail open)."""
    parse_ok, _, _ = publish.classify_cpv_findings(
        json.dumps({"results": ["a string, not a finding"]}), skillaudit_advisory=True
    )
    assert parse_ok is False


# ── skillaudit tag detection ─────────────────────────────────────────────


def test_is_skillaudit_finding_matches_tag() -> None:
    """The `[skillaudit:...]` message prefix is detected (case-insensitive)."""
    assert publish._is_skillaudit_finding("[skillaudit:exfil SA-1] x") is True
    assert publish._is_skillaudit_finding("[SkillAudit:exfil SA-1] x") is True


def test_is_skillaudit_finding_rejects_plain_message() -> None:
    """A normal structural finding message is not classified as skillaudit."""
    assert publish._is_skillaudit_finding("Skill frontmatter missing `name`") is False
    assert publish._is_skillaudit_finding("") is False


# ── opt-in reader: default strict, explicit-true required ─────────────────


def test_optin_reader_true_when_set(tmp_path: Path) -> None:
    """plugin.json with cpv.skillaudit_advisory:true ⇒ reader returns True."""
    cp = tmp_path / ".claude-plugin"
    cp.mkdir()
    (cp / "plugin.json").write_text(json.dumps({"cpv": {"skillaudit_advisory": True}}))
    assert publish._read_skillaudit_advisory_optin(tmp_path) is True


def test_optin_reader_false_when_absent(tmp_path: Path) -> None:
    """No cpv block (the DEFAULT shipped state) ⇒ reader returns False."""
    cp = tmp_path / ".claude-plugin"
    cp.mkdir()
    (cp / "plugin.json").write_text(json.dumps({"name": "x", "version": "1.0.0"}))
    assert publish._read_skillaudit_advisory_optin(tmp_path) is False


def test_optin_reader_false_when_cpv_present_but_flag_absent(tmp_path: Path) -> None:
    """A cpv block WITHOUT the flag (e.g. only allow_pipeline_drift) ⇒ False."""
    cp = tmp_path / ".claude-plugin"
    cp.mkdir()
    (cp / "plugin.json").write_text(json.dumps({"cpv": {"allow_pipeline_drift": ["x.py"]}}))
    assert publish._read_skillaudit_advisory_optin(tmp_path) is False


def test_optin_reader_false_when_flag_not_strict_true(tmp_path: Path) -> None:
    """Truthy-but-not-True values (1, "true") must NOT enable the opt-in."""
    cp = tmp_path / ".claude-plugin"
    cp.mkdir()
    (cp / "plugin.json").write_text(json.dumps({"cpv": {"skillaudit_advisory": "true"}}))
    assert publish._read_skillaudit_advisory_optin(tmp_path) is False


def test_optin_reader_false_when_plugin_json_missing(tmp_path: Path) -> None:
    """No plugin.json at all ⇒ reader returns False (fail strict)."""
    assert publish._read_skillaudit_advisory_optin(tmp_path) is False


# ── regression: real --json output has a lint preamble BEFORE the JSON ────
# The first bootstrap run failed because `cpv-remote-validate plugin <root>
# --json` prints a human-readable lint banner + per-language file counts on
# stdout FIRST, then the JSON object (its `{` at column 0). `json.loads` of
# the whole stdout died on "Expecting value: line 2 column 1", the classifier
# returned parse_ok=False, and the gate fell back to strict and blocked on
# advisory-only FPs. `_extract_cpv_json` slices from the trailing object.


def _cpv_json_with_preamble(results: list[dict]) -> str:
    preamble = (
        "\n\x1b[1m═══ [REPO LINT] (15 languages) ═══\x1b[0m\n"
        "  Detected languages: javascript, json, markdown, python\n"
        "  [JS/TS] 99 file(s)\n"
        "  [JSON] 12 file(s)\n"
    )
    return preamble + json.dumps({"exit_code": 2, "counts": {}, "results": results})


def test_extract_cpv_json_strips_preamble() -> None:
    """_extract_cpv_json returns the trailing JSON object, dropping the preamble."""
    extracted = publish._extract_cpv_json(_cpv_json_with_preamble([_skillaudit("MAJOR")]))
    assert extracted is not None
    assert json.loads(extracted)["results"][0]["level"] == "MAJOR"  # ubs:ignore -- extracted is the function output under test; a malformed value fails the assert loudly


def test_extract_cpv_json_none_when_no_object() -> None:
    """No line-anchored '{' ⇒ None ⇒ caller falls back to strict (never fail-open)."""
    assert publish._extract_cpv_json("just lint text, no json here\n  more text\n") is None


def test_classify_handles_real_preamble_prefixed_output() -> None:
    """REGRESSION (#41 bootstrap): classify must parse the real preamble+JSON
    output and downgrade the skillaudit FPs to advisory (was parse_ok=False)."""
    parse_ok, advisory, blocking = publish.classify_cpv_findings(
        _cpv_json_with_preamble([_skillaudit("MAJOR"), _skillaudit("MAJOR")]),
        skillaudit_advisory=True,
    )
    assert parse_ok is True
    assert len(advisory) == 2
    assert blocking == []


def test_classify_preamble_with_real_finding_still_blocks() -> None:
    """Preamble + a genuine non-skillaudit MAJOR ⇒ still blocks (never fail-open)."""
    parse_ok, advisory, blocking = publish.classify_cpv_findings(
        _cpv_json_with_preamble([_skillaudit("MAJOR"), _real("MAJOR")]),
        skillaudit_advisory=True,
    )
    assert parse_ok is True
    assert len(advisory) == 1
    assert len(blocking) == 1



# ── the increment-3 wiring: the shared env snapshot and the one pinned ref ──
# Increment 3 added a scoped integrity bypass (PLUGIN_SKIP_GITHUB_INTEGRITY=1
# on the two local CPV invocations) and pinned BOTH gates to one CPV ref.
# These tests guard the properties that make the change honest: the two
# invocations are the SAME validator run (one env snapshot, full environment
# with the bypass set), the local gate and CI really name one ref, and the
# bypass record reaches the ON-DISK report and not only stdout.

# The SHA both gates are pinned to: CPV v5.22.0's release commit.
_PINNED_CPV_SHA = "d5d6149735c4f0055bb3b83a56b28036079682ad"


def _recording_run(calls: list[tuple[list[str], dict | None]]):
    """A stand-in for subprocess.run that RECORDS each CPV invocation."""

    def fake_run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
        calls.append((cmd, kwargs.get("env")))
        if "--json" in cmd:
            return subprocess.CompletedProcess(cmd, 2, _cpv_json([_skillaudit("MAJOR")]), "")
        return subprocess.CompletedProcess(cmd, 1, "phase lines\n", "")

    return fake_run


def _opt_in(tmp_path: Path) -> None:
    """Enable the skillaudit-advisory opt-in so the gate reaches run 2."""
    (tmp_path / ".claude-plugin").mkdir(exist_ok=True)
    (tmp_path / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"cpv": {"skillaudit_advisory": True}})
    )


def _tracked_entries(repo_root: Path) -> list[tuple[str, str]]:
    """Every TRACKED entry in the repo, relative to the root, with its MODE.

    Tracked, not merely present: an untracked path is not part of the
    release, so it cannot be a gate. `git ls-files` is the enumeration, and
    `git ls-files -s` adds the MODE: 120000 is a symlink, 160000 is a
    gitlink (a submodule), 100644/100755 are ordinary files. The mode is
    what lets the caller SEE the entries a plain read_text() would
    silently skip.
    """
    out = subprocess.run(
        ["git", "ls-files", "-s", "-z"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        timeout=60,  # git ls-files on a local repo; a hang must fail the test, not stall the suite
    )
    entries: list[tuple[str, str]] = []
    for record in out.stdout.split("\0"):
        if not record:
            continue
        meta, _, rel = record.partition("\t")
        if not rel:
            continue
        mode = meta.split(" ", 1)[0]
        entries.append((rel, mode))
    return entries


def _yaml_env_blocks(workflow_src: str) -> list[str]:
    """The TEXT of every `env:` mapping block in a workflow file.

    A workflow's `env:` block is an indented mapping under a key named
    `env`. This extracts the block's own lines so an assertion can search
    INSIDE it — a COMMENT elsewhere in the file that happens to contain the
    same text must not satisfy a flag assertion.
    """
    blocks: list[str] = []
    lines = workflow_src.splitlines()
    for idx, line in enumerate(lines):
        if not re.match(r"^\s*env:\s*$", line):
            continue
        indent = len(line) - len(line.lstrip())
        body: list[str] = []
        for follow in lines[idx + 1 :]:
            if follow.strip() == "":
                body.append(follow)
                continue
            follow_indent = len(follow) - len(follow.lstrip())
            if follow_indent <= indent:
                break
            body.append(follow)
        blocks.append("\n".join(body))
    return blocks


def test_cpv_invocations_share_one_env_snapshot_with_bypass_set(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The two CPV invocations share ONE env snapshot, bypass set, full env."""
    calls: list[tuple[list[str], dict | None]] = []
    monkeypatch.setattr(publish.subprocess, "run", _recording_run(calls))
    # FAIL FAST if the interception seam ever breaks: if publish.py stopped
    # calling subprocess.run, the REAL uvx validator would run over the
    # network inside this unit test. Popen is the other way in, so block it.
    def _no_popen(*args, **kwargs):
        raise AssertionError("real subprocess.Popen invoked — the interception seam is broken")

    monkeypatch.setattr(publish.subprocess, "Popen", _no_popen)
    _opt_in(tmp_path)

    verdict = publish.run_cpv_validation(tmp_path)

    assert verdict is True, "the gate must return True when only skillaudit FPs remain"
    cpv_calls = [c for c in calls if "cpv-remote-validate" in c[0]]
    assert len(cpv_calls) == 2, cpv_calls
    for cmd, env in cpv_calls:
        assert env is not None
        assert env.get("PLUGIN_SKIP_GITHUB_INTEGRITY") == "1", env
        # A FULL environment, not a delta — independent of the ambient shell.
        assert len(env) >= len(os.environ), "the child must get a FULL environment, not a delta"
    assert cpv_calls[0][1] is cpv_calls[1][1], "both invocations share ONE env snapshot"


def test_both_gates_pin_the_same_cpv_ref() -> None:
    """EVERY gate in the repo names the SAME pinned CPV commit SHA.

    The property under test is repo-wide, not two-file: a THIRD gate
    anywhere in the repo could name a different ref and the two-file scan
    would never see it. So the scan enumerates the TRACKED files (an
    untracked path is not part of the release) and asserts that EVERY
    literal CPV ref a GATE-bearing file carries is the one pinned SHA.

    THE COST IS DELIBERATE: the scan reads EVERY tracked file on EVERY
    test run, so it costs more than a two-file check. That is the price
    of catching a third gate ANYWHERE — a scan of only the two known
    files could never find the gate nobody thought of, which is the
    whole point of the property.

    The TRDD corpus under design/ is excluded from the "every ref" sweep:
    those cards are PROSE that must record the pre-pin tag measurement
    (the tag-pinned run this change replaced) and the upstream tag that
    resolves to one of two commits — they document refs, they do not
    install one, so a card naming a tag is not a drifting gate. The
    two-file scan above still holds both real gates to the SHA.
    """
    repo_root = Path(__file__).resolve().parent.parent
    publish_src = (repo_root / "scripts" / "publish.py").read_text(encoding="utf-8")
    workflow_src = (repo_root / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")

    # Narrow to the LITERAL URL so a prose mention of another version in a
    # comment cannot break the match.
    pattern = r"git\+https://github\.com/Emasoft/claude-plugins-validation@([0-9a-f]{7,40}|[^\s'\"#]+)"
    local_refs = set(re.findall(pattern, publish_src))
    ci_refs = set(re.findall(pattern, workflow_src))
    assert local_refs, "no CPV ref found in scripts/publish.py"
    assert ci_refs, "no CPV ref found in .github/workflows/release.yml"
    assert local_refs == ci_refs, (
        f"the two gates name different refs — scripts/publish.py: {local_refs}, "
        f".github/workflows/release.yml: {ci_refs}"
    )
    for ref in local_refs:
        assert re.fullmatch(r"[0-9a-f]{40}", ref), (
            f"the CPV ref must be a 40-hex COMMIT SHA, not a tag: {ref}"
        )
    assert local_refs == {_PINNED_CPV_SHA}, (
        f"both gates must name the pinned CPV SHA {_PINNED_CPV_SHA}, found {local_refs}"
    )

    # REPO-WIDE: every tracked, gate-bearing file that names the CPV URL
    # must name the SAME SHA. A third gate anywhere in the repo is caught
    # here; the TRDD corpus (design/) is prose, not a gate — see the
    # docstring.
    url = "git+https://github.com/Emasoft/claude-plugins-validation@"
    offenders: list[str] = []
    scanned: list[str] = []
    # TRACKED symlinks and gitlinks are the scan's BLIND SPOT: read_text()
    # on a symlink FOLLOWS the link (reading outside the repo, or raising
    # OSError on a broken link) and on a gitlink it raises IsADirectoryError
    # (an OSError subclass). Either way the entry is silently skipped — so
    # a CPV gate living inside one would never be seen. Enumerate them
    # EXPLICITLY and make the blind spot a VISIBLE failure instead of a
    # silent pass.
    unscannable: list[str] = []
    for rel, mode in _tracked_entries(repo_root):
        if mode in ("120000", "160000"):
            unscannable.append(f"{rel} (mode {mode})")
            continue
        if rel.startswith("design/"):
            continue  # prose that documents refs, not a gate that installs one
        path = repo_root / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # not a text file — nothing to scan
        if url not in text:
            continue
        scanned.append(rel)
        for ref in re.findall(pattern, text):
            if ref != _PINNED_CPV_SHA:
                offenders.append(f"{rel}: {ref}")
    assert "scripts/publish.py" in scanned, scanned
    assert ".github/workflows/release.yml" in scanned, scanned
    assert not offenders, (
        "these tracked files name a CPV ref other than the pinned SHA "
        f"{_PINNED_CPV_SHA}: {offenders}"
    )
    assert not unscannable, (
        "this repo tracks SYMLINKS or GITLINKS that the repo-wide scan "
        "cannot see into (git ls-files -s modes 120000/160000): "
        f"{unscannable}. The scan cannot read a CPV gate inside one, so a "
        "human must check each by hand. Add an explicit check here, or "
        "remove the entry, before shipping a gate that claims to be "
        "repo-wide."
    )


def test_ci_workflow_sets_the_integrity_bypass_flag() -> None:
    """CI sets PLUGIN_SKIP_GITHUB_INTEGRITY=1, like the local gate does.

    The local gate sets the bypass through `_cpv_env()` and CI sets it
    through the job's `env:` block; nothing tied them together, so a future
    edit could change one and not the other and the two gates would then
    disagree about whether the integrity check ran. This assertion closes
    that drift.
    """
    repo_root = Path(__file__).resolve().parent.parent
    workflow_src = (repo_root / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    env_blocks = _yaml_env_blocks(workflow_src)
    assert env_blocks, "no env: block found in the CI workflow"
    flag = re.compile(
        r"^\s*PLUGIN_SKIP_GITHUB_INTEGRITY:\s*[\"\x27]1[\"\x27]\s*$", re.MULTILINE
    )
    assert any(flag.search(block) for block in env_blocks), (
        "the CI workflow must set PLUGIN_SKIP_GITHUB_INTEGRITY to \"1\" inside "
        "an env: block — the same bypass the local gate sets via _cpv_env()"
    )
    # The local gate's own key must be the same string the CI sets.
    assert publish.CPV_INTEGRITY_BYPASS == "PLUGIN_SKIP_GITHUB_INTEGRITY", (
        f"the local gate's bypass key drifted: {publish.CPV_INTEGRITY_BYPASS}"
    )


def test_bypass_record_reaches_the_on_disk_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The bypass record lands in the on-disk report, flag exported or not.

    Also asserts the GATE'S VERDICT and the SECOND artifact: the --json run's
    payload is the evidence the verdict rests on, so it must reach disk too
    (and must carry the same bypass note). Asserting the verdict here closes
    the asymmetry with the sibling test in this file, which already did: a
    change that broke the gate's DECISION would otherwise still pass this
    test on file contents alone. The fake --json run returns a single MAJOR
    skillaudit finding, which with the opt-in enabled classifies as
    ADVISORY, so the gate returns True.
    """
    for already_exported in (False, True):
        calls: list[tuple[list[str], dict | None]] = []
        monkeypatch.setattr(publish.subprocess, "run", _recording_run(calls))
        _opt_in(tmp_path)
        if already_exported:
            # The MAJOR 2 regression case: with the flag already in the
            # operator's environment a delta-based print goes SILENT. The
            # record must still be written.
            monkeypatch.setenv("PLUGIN_SKIP_GITHUB_INTEGRITY", "1")

        verdict = publish.run_cpv_validation(tmp_path)

        assert verdict is True, (
            "the gate must return True when only skillaudit FPs remain — the "
            f"artifact must exist AND the decision must be recorded "
            f"(flag already exported: {already_exported})"
        )
        report = publish._reports_dir(tmp_path) / "cpv.log"
        assert report.exists(), f"the CPV report file was not written: {report}"
        content = report.read_text(encoding="utf-8")
        assert "CPV INTEGRITY SELF-CHECK DISABLED" in content, (
            f"the bypass record is missing from {report} "
            f"(flag already exported: {already_exported})"
        )
        assert "PLUGIN_SKIP_GITHUB_INTEGRITY=1" in content, (
            f"the bypass record must name the EFFECTIVE value, not just the key: {report}"
        )
        # The --json run's payload — the evidence the verdict was decided on —
        # must reach disk as its own artifact, and carry the same note.
        findings = publish._reports_dir(tmp_path) / "cpv-findings.txt"
        assert findings.exists(), (
            f"the CPV findings artifact was not written: {findings} "
            f"(flag already exported: {already_exported})"
        )
        findings_content = findings.read_text(encoding="utf-8")
        assert "CPV INTEGRITY SELF-CHECK DISABLED" in findings_content, (
            f"the bypass record is missing from {findings} "
            f"(flag already exported: {already_exported})"
        )
        assert "PLUGIN_SKIP_GITHUB_INTEGRITY=1" in findings_content, (
            f"the bypass record must name the EFFECTIVE value, not just the key: {findings}"
        )
        monkeypatch.delenv("PLUGIN_SKIP_GITHUB_INTEGRITY", raising=False)
