---
trdd-id: CCS6ENHU
title: python tests under tests are not run by CI or publish.py
column: complete
created: 2026-09-16T15:55:31+0200
updated: 2026-09-23T23:39:19+0200
current-owner: agent
created-by: user
task-type: infra
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-16T15:55:31+0200
---

# python tests under tests are not run by CI or publish.py

Measured facts (2026-09-16, during T3/TRDD-VV0INGRT):
- scripts/publish.py::run_checks (around line 278-383) runs npm test (vitest), ruff check scripts/, shellcheck on *.sh in the main tree, manifest checks, and CPV validation. It never invokes pytest or uv run pytest anywhere.
- .github/workflows/ci.yml has zero references to pytest.
- .github/workflows/release.yml line ~161 is the ONLY place pytest runs: 'uv run pytest tests/ -v -m "not integration and not slow"' — gated behind a release, not CI, and not the local publish gate.
- Net effect: the Python tests under tests/ (and tests_dev/) can regress silently on every PR and every local publish.py run; they are only exercised at release time, after the artifact is already being shipped.
Not fixed here — filed as its own PROJECT TRDD per the T3 spec (a discovery made while implementing TRDD-VV0INGRT, out of that task's scope).

## Approval log

- 2026-09-16T15:55:31+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-23T23:39:19+0200 — COMPLETE by agent. archived → complete.

## Fresh check evidence

Fresh check 2026-09-23: scripts/publish.py:423-424 runs _run_check("pytest", ["uv", "run", "--extra", "dev", "pytest", "tests/", "--ignore=tests/dogfood", "-m", "not integration and not slow"]) inside run_checks (item 10 of its docstring, line 297). .github/workflows/ci.yml:92 runs 'uv run --extra dev pytest tests/ --ignore=tests/dogfood -v -m "not integration and not slow"'. Both hold — closing.

## Acceptance

- [x] pytest is run in both scripts/publish.py's run_checks (line 423-424) and .github/workflows/ci.yml (line 92)
