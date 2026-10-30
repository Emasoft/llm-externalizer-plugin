"""Timeout paths of the statusline installer and its diagnostic (review m4, m5).

Real code paths, real child processes: a fake installer / fake `agentlenspro`
script sleeps past a 1 s timeout (the module constant is monkeypatched down from
its production value). HOME points at a tmp dir so no real ~/.claude is touched.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, _ROOT / rel)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _sleeper(path: Path) -> Path:
    """Write an executable script that sleeps far longer than the test timeout."""
    path.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(60)\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_check_statusline_fix_reports_installer_timeout_as_failed_fix(tmp_path, monkeypatch, capsys):
    """--fix with a hung installer returns 1 with a clear message instead of a TimeoutExpired traceback."""
    mod = _load("check_statusline_under_test", "scripts/diagnostics/check-statusline.py")
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "settings.json").write_text(
        json.dumps({"statusLine": {"type": "command", "command": "/usr/bin/false"}}), encoding="utf-8"
    )
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["check-statusline.py", "--fix"])
    monkeypatch.setattr(mod, "INSTALLER", _sleeper(tmp_path / "fake_installer.py"))
    monkeypatch.setattr(mod, "INSTALLER_TIMEOUT_S", 1)
    assert mod.main() == 1
    assert "timed out after 1s" in capsys.readouterr().err


def test_check_statusline_outer_timeout_exceeds_installer_inner_timeout():
    """The diagnostic must wait longer than the installer waits on its wrapper."""
    check = _load("check_statusline_under_test2", "scripts/diagnostics/check-statusline.py")
    inst = _load("install_statusline_under_test2", "scripts/install_statusline.py")
    assert check.INSTALLER_TIMEOUT_S > inst.WRAPPER_TIMEOUT_S


def test_installer_wrapper_timeout_reports_lost_capture_wrap(tmp_path, monkeypatch, capsys):
    """A hung agentlenspro wrapper takes the lost-wrap path (warning + LOST line), not a traceback."""
    mod = _load("install_statusline_under_test3", "scripts/install_statusline.py")
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "settings.json").write_text(
        json.dumps({"statusLine": {"type": "command", "command": "agentlenspro statusline --inner x"}}),
        encoding="utf-8",
    )
    bindir = tmp_path / "bin"
    bindir.mkdir()
    _sleeper(bindir / "agentlenspro")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ.get("PATH", ""))
    monkeypatch.setattr(sys, "argv", ["install_statusline.py"])
    monkeypatch.setattr(mod, "WRAPPER_TIMEOUT_S", 1)
    mod.main()
    cap = capsys.readouterr()
    assert "NOT in settings.json" in cap.err
    assert "capture wrap LOST" in cap.out
