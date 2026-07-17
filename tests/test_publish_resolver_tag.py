"""Tests for the plugin-dependency resolver tag in publish.py.

Guards issue #11 / ai-maestro TRDD-JT3U4ZVM: Claude Code (>= 2.1.110)
resolves a version-constrained plugin dependency ONLY against a git tag
named `{plugin-name}--v{version}`. Our publish pipeline used to push only
the plain `vX.Y.Z` tag, which that resolver cannot see — so a dependent
pinning us to a range would get the misleading `no git tag satisfying
<range>` on a repo full of tags. The failure is invisible until the first
dependent appears, which is exactly why it needs a regression fence.

These import the REAL `resolver_tag_for` from publish.py (via importlib,
same pattern as test_publish_cpv_skillaudit.py) and exercise it directly —
no logic is mirrored here.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_PUBLISH_PATH = Path(__file__).resolve().parent.parent / "scripts" / "publish.py"
_spec = importlib.util.spec_from_file_location("publish", _PUBLISH_PATH)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)


def test_resolver_tag_has_the_spec_shape() -> None:
    """`{plugin-name}--v{version}` — the exact shape the CC resolver matches."""
    assert publish.resolver_tag_for("llm-externalizer", "v10.4.2") == "llm-externalizer--v10.4.2"


def test_resolver_tag_preserves_the_v_prefix_from_the_release_tag() -> None:
    """The release tag already carries the leading `v`; we must not add a second."""
    tag = publish.resolver_tag_for("llm-externalizer", "v1.0.0")
    assert tag == "llm-externalizer--v1.0.0"
    assert "vv" not in tag


def test_resolver_tag_trims_incidental_whitespace_in_the_name() -> None:
    """A manifest name with stray whitespace must not leak into the tag."""
    assert publish.resolver_tag_for("  llm-externalizer  ", "v2.3.4") == "llm-externalizer--v2.3.4"


def test_resolver_tag_rejects_an_empty_name() -> None:
    """A nameless manifest → ValueError, so publish fails fast.

    A `--vX.Y.Z` tag with no name in front resolves nothing; emitting it
    would ship the very failure the tag exists to prevent. main() turns
    this ValueError into an abort before any commit/tag/push.
    """
    with pytest.raises(ValueError):
        publish.resolver_tag_for("", "v1.0.0")


def test_resolver_tag_rejects_a_whitespace_only_name() -> None:
    """Whitespace-only is empty after strip — same fail-fast contract."""
    with pytest.raises(ValueError):
        publish.resolver_tag_for("   ", "v1.0.0")
