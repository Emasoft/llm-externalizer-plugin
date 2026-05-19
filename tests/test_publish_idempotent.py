"""Regression tests for publish.py version-sync idempotency.

Bug being guarded against (hit during v9.10.0 publish):

  Step 5 of publish.py rewrites the version literal in
  `mcp-server/src/index.ts` and `pyproject.toml`. The OLD code used
  `re.sub` then `if updated == src: error()`. That `==` check confused
  TWO distinct conditions: regex didn't match (real structural bug)
  versus regex matched but produced identical output (current ==
  target, an idempotent no-op). When current == target, the regex
  matches `[^"'`]+` against e.g. "9.10.0", substitutes with "9.10.0",
  and emits the same text — so `updated == src` even though the
  substitution ran fine. The script then aborted with
  `ERROR: regex failed to match version`.

  That failure mode prevents legitimate idempotent republishes — e.g.
  retrying after a network blip in step 10, or republishing the same
  version after manually fixing a release artifact. The v9.10.0
  publish hit this on `index.ts` AND `pyproject.toml` and required
  three throwaway downbump chore commits to work around it.

  The fix switches to `re.subn` so we can distinguish "no match"
  (count==0) from "matched and substituted" (count>=1). The
  count>=1 path just writes the file unconditionally (an idempotent
  no-op write when current == target). The count==0 path checks
  whether the target is already present in a different shape before
  declaring a structural bug.
"""

from __future__ import annotations

import re

INDEX_TS_PATTERN = (
    r"""(\{\s*name:\s*["'`]llm-externalizer["'`],\s*version:\s*(["'`]))[^"'`]+\2"""
)
PYPROJECT_PATTERN = r'(?m)^(version\s*=\s*")[^"]+(")'


def _sync_index_ts(src: str, new_version: str) -> tuple[str, str]:
    """Mirror of publish.py step-5 index.ts logic. Returns (new_src, action).

    Action is one of: "replaced", "already_at_target", "no_match".
    """
    updated, count = re.subn(
        INDEX_TS_PATTERN,
        rf"\g<1>{new_version}\g<2>",
        src,
    )
    if count == 0:
        already_at_target = re.search(
            rf"""\{{\s*name:\s*["'`]llm-externalizer["'`],\s*version:\s*["'`]{re.escape(new_version)}["'`]""",
            src,
        )
        return src, "already_at_target" if already_at_target else "no_match"
    return updated, "replaced"


def _sync_pyproject(src: str, new_version: str) -> tuple[str, str]:
    """Mirror of publish.py step-5 pyproject.toml logic."""
    updated, count = re.subn(
        PYPROJECT_PATTERN,
        rf"\g<1>{new_version}\g<2>",
        src,
        count=1,
    )
    if count == 0:
        already_at_target = re.search(
            rf'(?m)^version\s*=\s*"{re.escape(new_version)}"',
            src,
        )
        return src, "already_at_target" if already_at_target else "no_match"
    return updated, "replaced"


# ── index.ts ────────────────────────────────────────────────────────────

def test_index_ts_replaces_when_versions_differ() -> None:
    """Bumping 9.9.0 → 9.10.0 in the Server constructor literal."""
    src = '{ name: "llm-externalizer", version: "9.9.0" }'
    new_src, action = _sync_index_ts(src, "9.10.0")
    assert action == "replaced"
    assert '"9.10.0"' in new_src
    assert '"9.9.0"' not in new_src


def test_index_ts_idempotent_when_already_at_target() -> None:
    """current == target must NOT error (regression: v9.10.0 publish bug).

    The regex still MATCHES (count >= 1), the substitution produces an
    identical string, and the file write is an idempotent no-op. The
    OLD `if updated == src: error()` check would have aborted here.
    """
    src = '{ name: "llm-externalizer", version: "9.10.0" }'
    new_src, action = _sync_index_ts(src, "9.10.0")
    assert action == "replaced"
    assert new_src == src


def test_index_ts_aborts_when_constructor_literal_missing() -> None:
    """No constructor literal anywhere → real structural bug, must signal."""
    src = 'const server = makeServer({ id: "other-plugin" });'
    action = _sync_index_ts(src, "9.10.0")[1]
    assert action == "no_match"


def test_index_ts_supports_single_quotes() -> None:
    """The regex allows ', ", and ` — verify single-quote form replaces."""
    src = "{ name: 'llm-externalizer', version: '9.9.0' }"
    new_src, action = _sync_index_ts(src, "9.10.0")
    assert action == "replaced"
    assert "'9.10.0'" in new_src


# ── pyproject.toml ──────────────────────────────────────────────────────

def test_pyproject_replaces_when_versions_differ() -> None:
    """Standard bump path: 9.9.0 → 9.10.0 in [project] table."""
    src = '[project]\nname = "llm-externalizer-plugin"\nversion = "9.9.0"\n'
    new_src, action = _sync_pyproject(src, "9.10.0")
    assert action == "replaced"
    assert 'version = "9.10.0"' in new_src
    assert 'version = "9.9.0"' not in new_src


def test_pyproject_idempotent_when_already_at_target() -> None:
    """current == target must NOT error (regression: v9.10.0 publish bug).

    Same mechanism as the index.ts case: regex matches, substitution
    produces identical text, idempotent no-op write.
    """
    src = '[project]\nname = "llm-externalizer-plugin"\nversion = "9.10.0"\n'
    new_src, action = _sync_pyproject(src, "9.10.0")
    assert action == "replaced"
    assert new_src == src


def test_pyproject_aborts_when_version_line_missing() -> None:
    """No `version = "X"` line at all → structural bug, must signal."""
    src = '[project]\nname = "llm-externalizer-plugin"\n'
    action = _sync_pyproject(src, "9.10.0")[1]
    assert action == "no_match"


def test_pyproject_only_first_version_field_is_touched() -> None:
    """count=1 limits the sub to the first match.

    Without `count=1`, a `[tool.X]` table whose contributor accidentally
    pasted a `version = "..."` line would also be rewritten. The fix
    preserves the limit by passing count=1 to re.subn.
    """
    src = (
        '[project]\nversion = "9.9.0"\n'
        '\n[tool.example]\nversion = "1.0.0"\n'
    )
    new_src, action = _sync_pyproject(src, "9.10.0")
    assert action == "replaced"
    assert 'version = "9.10.0"' in new_src
    # second `version =` line must remain untouched
    assert 'version = "1.0.0"' in new_src


# ── cross-cutting: the v9.10.0 incident specifically ────────────────────

def test_v9_10_0_incident_now_idempotent() -> None:
    """End-to-end reproduction of the v9.10.0 publish workaround.

    Before the fix, this scenario (file already at target, publish.py
    invoked with --set 9.10.0) hard-aborted at step 5. After the fix
    both files write an idempotent no-op (action="replaced", text
    unchanged) and the publish proceeds.
    """
    index_src = '{ name: "llm-externalizer", version: "9.10.0" }'
    pyproject_src = '[project]\nversion = "9.10.0"\n'

    i_new, i_action = _sync_index_ts(index_src, "9.10.0")
    p_new, p_action = _sync_pyproject(pyproject_src, "9.10.0")

    # The regex matches, so action is "replaced"; the substitution
    # produces identical text, so the file content is unchanged. The
    # OLD code aborted on the second condition; the NEW code does not.
    assert i_action == "replaced"
    assert i_new == index_src
    assert p_action == "replaced"
    assert p_new == pyproject_src
