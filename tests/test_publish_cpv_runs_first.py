"""Publisher preflight regression coverage for TRDD-88IBHLIS."""

import runpy
from pathlib import Path

_PUBLISH_PATH = Path(__file__).resolve().parent.parent / "scripts" / "publish.py"


def test_reports_preflight_stops_before_validation_setup(tmp_path, capsys):
    """Reject a nested report before creating check logs or installing dependencies."""
    report = tmp_path / "reports" / "component" / "result.md"
    report.parent.mkdir(parents=True)
    report.write_text("Final report\n", encoding="utf-8")
    run_checks = runpy.run_path(str(_PUBLISH_PATH))["run_checks"]

    assert run_checks(tmp_path) is False
    assert "reports/ contains files" in capsys.readouterr().err
    assert not (tmp_path / "reports_dev").exists()
    assert report.read_text(encoding="utf-8") == "Final report\n"
