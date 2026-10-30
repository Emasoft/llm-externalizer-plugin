"""Tests for scripts/install_statusline.py — TRDD-828238b5's re-opened residue.

WHY THESE EXIST NOW. Part F deferred this file at 188 LOC with an explicit
re-open condition: "a real test would be mostly fs-mock scaffolding, low value
per don't-over-engineer. Re-open if its logic grows." It is 273 LOC today, so the
condition FIRED — and, like TRDD-6HGJFPDR's classifier floor, a trigger nobody
checks is not a trigger. Measured 2026-08-30.

WHAT IS AND IS NOT TESTED, deliberately. `main()` is a ~195-line side-effecting
installer that writes ~/.claude — the real user's config. It is NEVER executed
here, not even with --help: the module is loaded by file location and only its
PURE helpers are called. That is not timidity, it is the documented hazard —
`main()`'s own argv guard exists because probing this script with any flag once
copied files and patched a real settings.json.

The deferral's reasoning ("mostly fs-mock scaffolding") is answered rather than
ignored: there are NO mocks here. `_atomic_write_json` is exercised against a
REAL file in a REAL tmp dir, which is both honest and the only way to observe the
property that matters — a torn write leaves the user's Claude Code unable to
start, so atomicity is the whole point of the function.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest

_MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "install_statusline.py"


def _load():
    """Load the installer WITHOUT running main().

    Import-time side effects were verified absent (the module is imports,
    function defs and one string constant). Loading by location rather than
    adding scripts/ to sys.path keeps that decision visible at the call site.
    """
    spec = importlib.util.spec_from_file_location("install_statusline_under_test", _MODULE_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def mod():
    return _load()


class TestAtomicWriteJson:
    """The property: a reader NEVER sees a partial settings.json."""

    def test_writes_readable_json(self, mod, tmp_path: Path) -> None:
        target = tmp_path / "settings.json"
        mod._atomic_write_json(target, {"statusLine": {"type": "command"}})
        assert json.loads(target.read_text(encoding="utf-8"))["statusLine"]["type"] == "command"  # ubs:ignore -- file was just written by the installer under test; a malformed file fails the assert loudly

    def test_ends_with_a_trailing_newline(self, mod, tmp_path: Path) -> None:
        # Not cosmetic: a file with no trailing newline is a diff-noise generator
        # in a config users hand-edit, and the writer promises one.
        target = tmp_path / "settings.json"
        mod._atomic_write_json(target, {"a": 1})
        assert target.read_text(encoding="utf-8").endswith("\n")

    def test_overwrites_an_existing_file_completely(self, mod, tmp_path: Path) -> None:
        # A shorter payload must not leave a tail of the longer previous one —
        # the classic truncate-vs-replace bug, which os.replace avoids and a
        # naive open("w") would too, but only if the write really is whole-file.
        target = tmp_path / "settings.json"
        target.write_text(json.dumps({"old": "x" * 500}), encoding="utf-8")
        mod._atomic_write_json(target, {"new": 1})
        assert json.loads(target.read_text(encoding="utf-8")) == {"new": 1}  # ubs:ignore -- file was just written by the installer under test; a malformed file fails the assert loudly

    def test_leaves_no_temp_file_behind_on_success(self, mod, tmp_path: Path) -> None:
        mod._atomic_write_json(tmp_path / "settings.json", {"a": 1})
        leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".settings.")]
        assert leftovers == []

    def test_cleans_up_its_temp_file_when_serialisation_FAILS(self, mod, tmp_path: Path) -> None:
        # The failure path is the one worth testing: json.dump raises partway,
        # and the function must remove its tmp file and re-raise rather than
        # leaving debris beside the user's config on every failed run.
        target = tmp_path / "settings.json"

        class Unserialisable:
            pass

        with pytest.raises(TypeError):
            mod._atomic_write_json(target, {"bad": Unserialisable()})

        leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".settings.")]
        assert leftovers == []

    def test_does_not_create_the_target_when_serialisation_fails(self, mod, tmp_path: Path) -> None:
        # Atomicity's other half: a failed write must not leave a truncated or
        # empty settings.json where a valid one did not exist.
        target = tmp_path / "settings.json"

        class Unserialisable:
            pass

        with pytest.raises(TypeError):
            mod._atomic_write_json(target, {"bad": Unserialisable()})
        assert not target.exists()

    def test_preserves_an_existing_file_when_serialisation_fails(self, mod, tmp_path: Path) -> None:
        # The worst realistic outcome would be destroying a WORKING config while
        # failing to write the new one. os.replace is never reached on failure,
        # so the original must survive byte-for-byte.
        target = tmp_path / "settings.json"
        original = json.dumps({"keep": "me"}, indent=2) + "\n"
        target.write_text(original, encoding="utf-8")

        class Unserialisable:
            pass

        with pytest.raises(TypeError):
            mod._atomic_write_json(target, {"bad": Unserialisable()})
        assert target.read_text(encoding="utf-8") == original

    def test_writes_utf8_without_escaping_non_ascii(self, mod, tmp_path: Path) -> None:
        # ensure_ascii=False is a deliberate choice in the writer; a path or label
        # with non-ASCII must round-trip rather than become \uXXXX soup.
        target = tmp_path / "settings.json"
        mod._atomic_write_json(target, {"cmd": "python3 ~/.claude/état.py"})
        raw = target.read_text(encoding="utf-8")
        assert "état" in raw
        assert json.loads(raw)["cmd"].endswith("état.py")  # ubs:ignore -- raw is the installer output under test; a malformed value fails the assert loudly


class TestTimestamp:
    """Backup suffixes must sort and must not collide across timezones."""

    def test_matches_the_project_wide_backup_format(self, mod) -> None:
        # YYYYMMDD_HHMMSS±HHMM — the same compact local-time-plus-offset form the
        # repo uses for every dated filename. The offset is what makes two hosts'
        # backups distinguishable, so its absence would be a real defect.
        ts = mod._timestamp()
        assert len(ts) == len("20260830_001122+0200")
        assert ts[8] == "_"
        assert ts[15] in "+-"
        assert ts[:8].isdigit() and ts[9:15].isdigit() and ts[16:].isdigit()

    def test_contains_no_filesystem_hostile_characters(self, mod) -> None:
        # A ':' in the offset would be rejected by Windows filesystems — the
        # documented reason the compact form is used instead of ISO 8601.
        assert ":" not in mod._timestamp()

    def test_is_local_time_not_utc(self, mod) -> None:
        # The docstring promises local time with the GMT offset. Under a fixed
        # non-UTC TZ the offset must reflect it, or the "local" claim is false.
        if not hasattr(sys, "getandroidapilevel") and os.name != "nt":
            os.environ["TZ"] = "Europe/Rome"
            try:
                time.tzset()
                assert mod._timestamp()[15:] in {"+0100", "+0200"}  # CET / CEST
            finally:
                del os.environ["TZ"]
                time.tzset()
