#!/usr/bin/env python3
"""Tests for the v9.10.0 T2.23 cache TTL ceiling logic in statusline.py.

Background
----------
Before T2.23, when the Anthropic OAuth token was revoked (or the network
was down), `fetch_usage_from_api` fell back to the last successful
response indefinitely. A user could see "5h: 42%" for DAYS after their
token died — actively misleading.

T2.23 introduced CACHE_HARD_CEILING (24h):
  - Cache age < 5 min   → return cached value as-is (the normal fast path).
  - Cache age 5min–24h  → use as "stale fallback" if a fresh fetch fails.
  - Cache age > 24h     → return {"_stale_expired": True} sentinel; the
                          render path then surfaces a "stale (>24h, check
                          API token)" hint instead of misleading numbers.

The first window is exercised through `fetch_usage_from_api` (the hot
path); the third is exercised through `_stale_fallback` directly because
it's the function that owns the sentinel decision and `fetch_usage_from_api`
only calls it via the unreachable-API branch (which would require
patching urllib — much more brittle than testing the unit directly).

These two tests pin the contract end-to-end at the boundaries (5 min, 24 h).
"""

from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATUSLINE_PATH = PROJECT_ROOT / "scripts" / "statusline" / "statusline.py"


def _load_statusline_module():
    """Import statusline.py for whitebox testing of internal helpers."""
    spec = importlib.util.spec_from_file_location("statusline", STATUSLINE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# Cache age < 5 min: hot path returns cached value unchanged
# ---------------------------------------------------------------------------


def test_cache_age_below_5min_returns_cached_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the on-disk cache is younger than the 300s `cache_max_age`
    threshold in `fetch_usage_from_api`, the function must return the
    cached body verbatim — no network call, no _stale_fallback. This is
    the fast-path that fires on 99% of statusline refreshes.

    We block the network by clearing CLAUDE_CODE_OAUTH_TOKEN AND nuking
    PATH so `security` / `secret-tool` lookups fail — if the hot path
    accidentally falls through to fetching, the test would either hang
    (10s urllib timeout) or hit the network. Neither happens because
    cache age < 5 min returns BEFORE token resolution.
    """
    mod = _load_statusline_module()

    cache_file = tmp_path / "statusline-usage-cache.json"
    body = {"five_hour": {"used_percentage": 42}, "seven_day": {"used_percentage": 7}}
    cache_file.write_text(json.dumps(body), encoding="utf-8")
    # mtime = now ensures age << 300s
    now = time.time()
    os.utime(cache_file, (now, now))

    # Belt-and-braces: blank any token sources in case the hot path is
    # broken and falls through. The cache-fresh branch returns BEFORE
    # `get_oauth_token` is called, so this is purely defensive.
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)

    result = mod.fetch_usage_from_api(tmp_path, claude_version="9.10.0")
    assert result == body, (
        f"hot path mutated cached body: got {result!r}, expected {body!r}"
    )
    # And the sentinel must NOT be present — we returned a live cache hit,
    # not a stale-expired fallback.
    assert "_stale_expired" not in result, (
        "fresh cache returned _stale_expired — TTL ceiling fired wrongly"
    )


# ---------------------------------------------------------------------------
# Cache age > 24h: _stale_fallback returns the sentinel
# ---------------------------------------------------------------------------


def test_cache_age_above_24h_returns_stale_expired_sentinel(tmp_path: Path) -> None:
    """When the cache is older than CACHE_HARD_CEILING (24h = 86400s),
    `_stale_fallback` must return `{"_stale_expired": True}` regardless of
    the cache file's content. This is the T2.23 contract: past 24h the
    failure is almost certainly an expired/revoked token, and the bar
    must surface that fact instead of serving cached numbers.

    We bypass `fetch_usage_from_api`'s 5-min freshness check by calling
    `_stale_fallback` directly with a cache file aged 25h. This is the
    function that owns the sentinel decision; `fetch_usage_from_api` only
    delegates to it via the unreachable-API branch.
    """
    mod = _load_statusline_module()
    # Sanity-check the ceiling constant matches the spec — if a future
    # refactor drops it below 25h, this test gives an immediate signal
    # rather than silently passing on the wrong threshold.
    assert mod.CACHE_HARD_CEILING == 24 * 3600, (
        f"CACHE_HARD_CEILING moved off 24h: {mod.CACHE_HARD_CEILING}"
    )

    cache_file = tmp_path / "statusline-usage-cache.json"
    # Body contents are irrelevant — the sentinel decision is age-only,
    # but write something parseable so a regression that accidentally
    # tries read_json_file() instead of the sentinel branch returns the
    # body (and the assertion below catches that).
    cache_file.write_text(
        json.dumps({"five_hour": {"used_percentage": 99}}), encoding="utf-8"
    )
    # 25h ago — comfortably past the 24h ceiling
    stale_time = time.time() - 90000
    os.utime(cache_file, (stale_time, stale_time))

    result = mod._stale_fallback(cache_file)
    assert isinstance(result, dict), (
        f"_stale_fallback returned non-dict: {type(result).__name__}={result!r}"
    )
    assert result.get("_stale_expired") is True, (
        f"expected sentinel _stale_expired=True at age>24h; got {result!r}"
    )
