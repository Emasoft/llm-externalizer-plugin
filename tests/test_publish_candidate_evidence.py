"""Release candidate guards: real Git state and the GitHub API response boundary."""

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("publish", Path(__file__).resolve().parents[1] / "scripts/publish.py")
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

SHA = "a" * 40


@pytest.mark.parametrize("fault", [None, "missing", "repo", "workflow", "sha", "failed", "skipped"])
def test_verify_windows_run(monkeypatch, tmp_path, fault):
    """Only success for the exact candidate and required unit step counts."""
    status = {"status": "completed", "conclusion": "success"}
    workflow = {"id": 42, "path": publish.WINDOWS_WORKFLOW}
    run = {
        **status, "id": 20, "workflow_id": 42, "path": publish.WINDOWS_WORKFLOW,
        "event": "workflow_dispatch", "head_branch": f"release-candidates/{SHA}",
        "head_sha": SHA, "run_attempt": 2,
        "repository": {"full_name": publish.RELEASE_REPO},
        "head_repository": {"full_name": publish.RELEASE_REPO},
    }
    step = {**status, "name": "Unit tests (stage 1)"}
    job = {**status, "name": publish.WINDOWS_JOB, "head_sha": SHA, "steps": [step]}
    if fault == "repo":
        run["head_repository"] = {"full_name": "other/repo"}
    elif fault == "workflow":
        run["workflow_id"] = 43
    elif fault == "sha":
        run["head_sha"] = "b" * 40
    elif fault == "failed":
        run["conclusion"] = "failure"
    elif fault == "skipped":
        step["conclusion"] = "skipped"

    def api(cmd, *, cwd):
        assert cwd == str(tmp_path)
        endpoint = cmd[-1]
        if endpoint.endswith("/workflows/windows.yml"):
            payload = workflow
        elif endpoint.endswith("/runs/20"):
            if fault == "missing":
                raise subprocess.CalledProcessError(1, cmd)
            payload = run
        else:
            assert endpoint.endswith("/runs/20/attempts/2/jobs")
            payload = [{"jobs": [job]}]
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload))

    monkeypatch.setattr(publish, "run", api)
    if fault is None:
        publish.verify_windows_run(tmp_path, SHA, 20)
    else:
        error = subprocess.CalledProcessError if fault == "missing" else SystemExit
        with pytest.raises(error):
            publish.verify_windows_run(tmp_path, SHA, 20)


@pytest.mark.parametrize("drift", ["head", "index", "worktree", "untracked", "assume-unchanged", "skip-worktree"])
def test_snapshot_rejects_drift(tmp_path, drift):
    """A pinned release refuses changes to HEAD, the index, or visible inputs."""
    def git(*args):
        return subprocess.check_output(["git", "-C", str(tmp_path), *args], text=True, timeout=20).strip()

    git("init", "-q")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.com")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("candidate\n")
    git("add", "tracked.txt")
    git("commit", "-qm", "Candidate")
    sha = git("rev-parse", "HEAD")
    publish.require_release_snapshot(tmp_path, sha)
    if drift == "head":
        git("commit", "--allow-empty", "-qm", "Changed head")
    elif drift == "untracked":
        (tmp_path / "unexpected.txt").write_text("unexpected\n")
    elif drift in {"assume-unchanged", "skip-worktree"}:
        git("update-index", f"--{drift}", "tracked.txt")
    else:
        tracked.write_text("drift\n")
        if drift == "index":
            git("add", "tracked.txt")
    with pytest.raises(SystemExit, match="release candidate"):
        publish.require_release_snapshot(tmp_path, sha)
