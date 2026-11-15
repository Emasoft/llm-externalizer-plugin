"""Tests for publish.py sync_package_lock_version (TRDD-NQMW9AK5)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_PUBLISH_PATH = Path(__file__).resolve().parent.parent / "scripts" / "publish.py"
_spec = importlib.util.spec_from_file_location("publish", _PUBLISH_PATH)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

_REAL_LOCK = Path(__file__).resolve().parent.parent / "scripts" / "llm-ext" / "package-lock.json"
NEW_VERSION = "0.0.0-locktest"


def test_sync_rewrites_only_the_two_root_version_lines(tmp_path: Path) -> None:
    """Syncing the real lock changes exactly the top-level and packages[""] version lines."""
    original = _REAL_LOCK.read_text(encoding="utf-8")
    old = json.loads(original)["version"]
    lock = tmp_path / "package-lock.json"
    lock.write_text(original, encoding="utf-8")

    publish.sync_package_lock_version(lock, NEW_VERSION)

    old_line = f'"version": "{old}"'
    assert original.count(old_line) >= 2
    expected = original.replace(old_line, f'"version": "{NEW_VERSION}"', 2)
    assert lock.read_text(encoding="utf-8") == expected
    parsed = json.loads(lock.read_text(encoding="utf-8"))
    assert parsed["version"] == NEW_VERSION
    assert parsed["packages"][""]["version"] == NEW_VERSION


def test_invalid_json_exits_and_leaves_file_unchanged(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """A lock that is not valid JSON makes the sync exit 1 naming the path, file untouched."""
    lock = tmp_path / "package-lock.json"
    lock.write_bytes(b"{ not json")

    with pytest.raises(SystemExit):
        publish.sync_package_lock_version(lock, NEW_VERSION)

    assert str(lock) in capsys.readouterr().err
    assert lock.read_bytes() == b"{ not json"


def test_missing_root_package_entry_exits_and_leaves_file_unchanged(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A lock without packages[""] makes the sync exit 1 naming the path, file untouched."""
    lock = tmp_path / "package-lock.json"
    content = b'{"version": "1.0.0", "packages": {"node_modules/x": {}}}'
    lock.write_bytes(content)

    with pytest.raises(SystemExit):
        publish.sync_package_lock_version(lock, NEW_VERSION)

    assert str(lock) in capsys.readouterr().err
    assert lock.read_bytes() == content
