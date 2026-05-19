#!/usr/bin/env python3
"""Tests for scripts/setup/migrate.py — v9.10.0 T2.24 startup migration.

Covers the three migration actions and the idempotency contract:
  1. CLI --help renders cleanly (smoke for argparse wiring).
  2. Running twice on a clean HOME is a no-op idempotent.
  3. Stale `settings.yml` is renamed to `settings.yaml` (only when .yaml absent).
  4. Stale `.publish.lock` older than 1h is removed.

migrate.py reads HOME from os.environ['HOME'] (with a tilde-expansion
fallback), so we redirect HOME via monkeypatch.setenv to a per-test
tmp_path. The script does NOT support a --home flag — we drive it through
the env var, which matches how it actually runs in production (the
launcher exports HOME before invoking).
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATE_PATH = PROJECT_ROOT / "scripts" / "setup" / "migrate.py"


def _run_migrate(home: Path, *, quiet: bool = False) -> subprocess.CompletedProcess:
    """Invoke migrate.py as a subprocess with HOME redirected to `home`.

    Returns the CompletedProcess for the caller to inspect (rc, stdout, stderr).
    """
    args = [sys.executable, str(MIGRATE_PATH)]
    if quiet:
        args.append("--quiet")
    env = {
        "HOME": str(home),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        # Pin plugin_root so the broken-symlink check looks somewhere harmless
        # (the tmp_path itself — no mcp-server/ inside, so the check is a noop).
        "LLM_EXT_PLUGIN_ROOT": str(home),
        "LANG": "C.UTF-8",
    }
    return subprocess.run(args, capture_output=True, text=True, env=env, timeout=20)


# ---------------------------------------------------------------------------
# 1. CLI surface
# ---------------------------------------------------------------------------


def test_migrate_help_exits_0() -> None:
    """`migrate.py --help` must exit 0 and print argparse usage. Smoke test
    for the script's CLI wiring — if this fails, every other test below
    is meaningless because migrate.py never reaches main()."""
    r = subprocess.run(
        [sys.executable, str(MIGRATE_PATH), "--help"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert r.returncode == 0, f"non-zero exit: {r.returncode}, stderr={r.stderr}"
    combined = (r.stdout + r.stderr).lower()
    assert "usage" in combined, f"no 'usage' in output: {combined!r}"
    # Verify --quiet flag is advertised (the script's only flag).
    assert "--quiet" in combined


# ---------------------------------------------------------------------------
# 2. Idempotency on a clean HOME
# ---------------------------------------------------------------------------


def test_migrate_clean_home_is_idempotent_no_op(tmp_path: Path) -> None:
    """Running migrate.py twice on a HOME with no ~/.llm-externalizer/ at
    all must exit 0 both times (the script handles the missing-cfg-dir
    case by skipping the yml/lock checks, then runs the symlink check
    which is also a noop since LLM_EXT_PLUGIN_ROOT points at the same
    bare tmp_path with no mcp-server/)."""
    # First run — nothing exists yet
    r1 = _run_migrate(tmp_path)
    assert r1.returncode == 0, f"first run failed: rc={r1.returncode}, stderr={r1.stderr}"

    # Second run — still nothing exists; idempotency must hold
    r2 = _run_migrate(tmp_path)
    assert r2.returncode == 0, f"second run failed: rc={r2.returncode}, stderr={r2.stderr}"

    # Neither run should have created ~/.llm-externalizer/ (the script
    # is OBSERVING, not provisioning — provisioning is install.sh's job).
    assert not (tmp_path / ".llm-externalizer").exists(), (
        "migrate.py created ~/.llm-externalizer/ — it should never provision"
    )


# ---------------------------------------------------------------------------
# 3. settings.yml → settings.yaml rename
# ---------------------------------------------------------------------------


def test_migrate_renames_stale_settings_yml_to_yaml(tmp_path: Path) -> None:
    """The v9.5.x → v9.6.0 settings rename: if settings.yml exists and
    settings.yaml does NOT, the script must rename .yml → .yaml preserving
    content. If both exist, neither is touched (see test contract in
    migrate.py docstring step 1) — we don't cover that branch here, but
    the rename path is the hot path that actually fires on real users."""
    cfg_dir = tmp_path / ".llm-externalizer"
    cfg_dir.mkdir()
    src = cfg_dir / "settings.yml"
    sample = "model: opus\nmode: free\n"
    src.write_text(sample, encoding="utf-8")

    r = _run_migrate(tmp_path)
    assert r.returncode == 0, f"migrate failed: rc={r.returncode}, stderr={r.stderr}"

    dst = cfg_dir / "settings.yaml"
    assert dst.is_file(), f"settings.yaml not created at {dst}; stdout={r.stdout}"
    assert dst.read_text(encoding="utf-8") == sample, (
        "content drift across rename — yaml differs from original yml"
    )
    assert not src.exists(), (
        f"original settings.yml still present at {src} after rename; stdout={r.stdout}"
    )


# ---------------------------------------------------------------------------
# 4. Stale .publish.lock removal
# ---------------------------------------------------------------------------


def test_migrate_removes_stale_publish_lock_older_than_1h(tmp_path: Path) -> None:
    """A `.publish.lock` older than LOCK_MAX_AGE_SECONDS (3600s) must be
    removed — a killed publish.py leaves these locks and they otherwise
    block the next publish forever. The script reads st_mtime, so we set
    it to now-7200 (2h ago, comfortably over the 1h threshold)."""
    cfg_dir = tmp_path / ".llm-externalizer"
    cfg_dir.mkdir()
    lock = cfg_dir / ".publish.lock"
    lock.write_text("pid=99999\n", encoding="utf-8")
    # Set mtime to 2h ago (atime too, since some FS update atime on open).
    stale_time = time.time() - 7200
    import os
    os.utime(lock, (stale_time, stale_time))

    r = _run_migrate(tmp_path)
    assert r.returncode == 0, f"migrate failed: rc={r.returncode}, stderr={r.stderr}"
    assert not lock.exists(), (
        f"stale .publish.lock not removed at {lock}; stdout={r.stdout}"
    )
