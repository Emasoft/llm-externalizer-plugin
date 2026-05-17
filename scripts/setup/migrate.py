#!/usr/bin/env python3
"""v9.10.0 startup migration — clean up artifacts from v9.5.x and v9.8.x upgrades.

Idempotent. Safe to run on every plugin launch.

Actions
-------
1. settings.yml → settings.yaml: v9.5.x shipped `.yml`; v9.6.0+ uses `.yaml`.
   Rename only when `.yaml` is absent. If BOTH exist, leave both alone —
   `.yaml` wins by convention, `.yml` is a user backup we must not touch.
2. Stale `~/.llm-externalizer/.publish.lock`: a publish killed mid-run leaves
   a lock that blocks the next publish forever. Remove if older than 1 hour.
3. Broken `mcp-server/node_modules` symlink: v9.5–v9.7's bash SessionStart
   hook can leave dangling symlinks. Remove them so launcher.mjs's
   `linkNodeModules()` rebuilds cleanly.

Exit 0 on success regardless of action count. Verbose by default; `--quiet`
prints only when an action is actually taken. Honors `LLM_EXT_PLUGIN_ROOT`
env var for tests / dev setups.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

LOCK_MAX_AGE_SECONDS = 3600  # 1 hour — see docstring step 2


def _say(msg: str, *, quiet: bool) -> None:
    if not quiet:
        print(msg)


def _action(msg: str, *, quiet: bool) -> None:
    # Contract: print only on mutation. Prefix [ACTION] in verbose mode so the
    # reader can scan decision logs vs mutations at a glance.
    print(msg if quiet else f"[ACTION] {msg}")


def migrate_settings_yml(cfg_dir: Path, *, quiet: bool) -> bool:
    """Rename settings.yml → settings.yaml only when .yaml is absent."""
    yml, yaml = cfg_dir / "settings.yml", cfg_dir / "settings.yaml"
    if not yml.is_file():
        _say(f"settings.yml not found at {yml} — nothing to migrate.", quiet=quiet)
        return False
    if yaml.exists():
        _say(f"both .yml and .yaml present at {cfg_dir} — leaving both untouched.", quiet=quiet)
        return False
    yml.rename(yaml)
    _action(f"renamed {yml} → {yaml}", quiet=quiet)
    return True


def remove_stale_publish_lock(cfg_dir: Path, *, quiet: bool) -> bool:
    """Remove .publish.lock when it is older than LOCK_MAX_AGE_SECONDS."""
    lock = cfg_dir / ".publish.lock"
    if not lock.exists():
        _say(f".publish.lock not present at {lock} — nothing to do.", quiet=quiet)
        return False
    try:
        age = time.time() - lock.stat().st_mtime
    except OSError as exc:
        _say(f"cannot stat {lock}: {exc} — leaving alone.", quiet=quiet)
        return False
    if age <= LOCK_MAX_AGE_SECONDS:
        _say(f".publish.lock {int(age)}s old (<{LOCK_MAX_AGE_SECONDS}s) — leaving alone.", quiet=quiet)
        return False
    try:
        lock.unlink()
    except OSError as exc:
        _say(f"failed to remove stale .publish.lock at {lock}: {exc}", quiet=quiet)
        return False
    _action(f"removed stale .publish.lock at {lock} (age {int(age)}s)", quiet=quiet)
    return True


def remove_broken_node_modules_symlink(plugin_root: Path, *, quiet: bool) -> bool:
    """Remove mcp-server/node_modules when it is a broken symlink."""
    nm = plugin_root / "mcp-server" / "node_modules"
    if not nm.is_symlink():
        # Real dir = user ran `npm install` directly; never touch. Absent = nothing to do.
        _say(
            f"{nm} {'is a real directory' if nm.exists() else 'not present'} — leaving alone.",
            quiet=quiet,
        )
        return False
    try:
        target = nm.resolve(strict=False)
        target_ok = target.exists()
    except OSError as exc:
        _say(f"cannot resolve symlink {nm}: {exc} — leaving alone.", quiet=quiet)
        return False
    if target_ok:
        _say(f"{nm} → {target} is a working symlink — leaving alone.", quiet=quiet)
        return False
    try:
        nm.unlink()
    except OSError as exc:
        _say(f"failed to remove broken symlink {nm}: {exc}", quiet=quiet)
        return False
    _action(f"removed broken symlink {nm} → {target}", quiet=quiet)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="v9.10.0 startup migration — clean up artifacts from v9.5.x / v9.8.x upgrades."
    )
    parser.add_argument(
        "--quiet", action="store_true",
        help="Print only when an action is actually taken (default: verbose).",
    )
    args = parser.parse_args(argv)

    home = Path(os.environ.get("HOME") or os.path.expanduser("~"))
    cfg_dir = home / ".llm-externalizer"
    plugin_root_env = os.environ.get("LLM_EXT_PLUGIN_ROOT")
    # scripts/setup/migrate.py → plugin root is two `parent` up.
    plugin_root = Path(plugin_root_env) if plugin_root_env else Path(__file__).resolve().parent.parent.parent

    _say(f"migrate.py: HOME={home}, cfg_dir={cfg_dir}, plugin_root={plugin_root}", quiet=args.quiet)

    # cfg_dir may not exist on fresh install — skip the calls entirely so we
    # don't paper over a more interesting failure later.
    if cfg_dir.exists():
        migrate_settings_yml(cfg_dir, quiet=args.quiet)
        remove_stale_publish_lock(cfg_dir, quiet=args.quiet)
    else:
        _say(f"cfg_dir {cfg_dir} does not exist — skipping yml/lock migrations.", quiet=args.quiet)
    remove_broken_node_modules_symlink(plugin_root, quiet=args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
