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
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

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
    assert json.loads(extracted)["results"][0]["level"] == "MAJOR"


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
