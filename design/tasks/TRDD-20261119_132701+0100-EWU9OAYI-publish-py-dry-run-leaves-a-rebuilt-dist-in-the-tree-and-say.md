---
trdd-id: EWU9OAYI
title: publish.py dry run leaves a rebuilt dist in the tree and says the tree is unchanged
column: complete
status: tasked
created: 2026-11-19T13:27:01+0100
updated: 2026-11-19T22:36:01+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T13:27:01+0100
implementation-commits: [cf77f1c9, 15e53512]
release-via: publish
---

# publish.py dry run leaves a rebuilt dist in the tree and says the tree is unchanged

publish.py validate (step 2, run_checks) runs npm run build, which rewrites the tracked scripts/llm-ext/dist files whenever they are stale against the source, and run_checks never restores them (lines 332-480 hold no git checkout, restore or stash). When run_checks then fails, publish.py prints "Working tree is unchanged — fix the issues and re-run" (line 944), which is false, and the pre-flight of the next run refuses the dirty tree; the comment at lines 933-937 also says the tree is guaranteed untouched. A CPV failure (line 946) or a passing dry run (return at line 992) leaves the same rebuilt files behind with no message (read from the code, not observed). Observed 2026-11-19 in the 14.7.6 attempt: the dry run at 96e0682e rebuilt dist/llm-ext.js and dist/benchmark.js (stale since the v14.7.5 release commit f0766476), failed one test, printed that line, and the real publish stopped at pre-flight with both files modified; b1f17f31 committed the rebuild to recover. Task: after validate (and at the dry-run or check-only exit) compare git status with the pre-flight result and name every tracked file the checks changed, instead of claiming the tree is unchanged; or build into a directory outside the tree. Acceptance: (1) a validate that changes tracked files ends with a message naming those files, never "Working tree is unchanged"; (2) a test runs the check with a stale dist and asserts that message.

## Approval log

- 2026-11-19T13:27:01+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T21:22:38+0100 — column → complete by main-agent@llm-externalizer-plugin. fixed in cf77f1c9, ships in the next release
- 2026-11-19T21:30:22+0100 — column → dev by main-agent@llm-externalizer-plugin. box 2 reopened: the test uses a stand-in for the build, not a real stale dist; the fix itself is in cf77f1c9
- 2026-11-19T22:36:01+0100 — column → complete by main-agent@llm-externalizer-plugin. box 1 in cf77f1c9, box 2 in 15e53512; ships in the next release

## Notes

2026-11-19T21:22:36+0100 main agent: fixed in cf77f1c9. publish.py names every tracked file the checks changed (git diff --name-only -z HEAD in the repo root) at each stop after validate: validate failure, CPV failure, the dry-run exit and the three --check-only exits; "Working tree is unchanged." only when git says so; a rebuilt dist is called a regeneration to commit, with a quoted git restore for other files. Tests: tests/test_publish_reports_changed_files.py (real git, real report_working_tree and _run_publish), 11 passed with test_publish_runs_git_in_repo_root.py; ruff, ruff format --check, mypy clean. Acceptance (2) is met in a narrower form: run_checks is replaced by a function that rewrites the dist file, no test drives the real npm run build against a stale dist. scripts/publish.py is already in plugin.json cpv.pipeline.intentional_divergence.
2026-11-19T21:33:19+0100 main agent: box 2 is open again (Approval log 21:30:22). The words "Acceptance (2) is met in a narrower form" in the 21:22:36 note are superseded: the narrower evidence does not meet box 2. Still missing: a test that drives the real npm run build against a stale dist.
2026-11-19T22:35:46+0100 main agent: box 2 met in 15e53512 (Acceptance box 2 text). Evidence: the test passed alone on the committed HEAD 15e53512 (1 passed in 17.41s), and together with tests/test_publish_reports_changed_files.py and tests/test_publish_runs_git_in_repo_root.py before the commit, when HEAD was d802a2d3, so the archived build source did not yet hold the 335e384e boot fix (12 passed in 17.76s). It builds from git archive HEAD, so uncommitted source is not covered, and it needs the live scripts/llm-ext/node_modules (it installs nothing). release.yml now runs setup-node v7.1.0 and npm ci --ignore-scripts before pytest; ci.yml setup-node moved to v7.1.0. The test has not run in CI yet.

## Acceptance

- [x] (1) a validate that changes tracked files ends with a message naming those files, never "Working tree is unchanged" (cf77f1c9)
- [x] (2) a test runs the check with a stale dist and asserts that message. Met in 15e53512: tests/test_publish_real_build_stale_dist.py runs the real npm run build (publish.run_build_check, tsc and esbuild) over a stale committed dist and asserts that report_working_tree names scripts/llm-ext/dist/llm-ext.js and does not say the tree is unchanged. The earlier evidence of cf77f1c9 (tests/test_publish_reports_changed_files.py) used a stand-in for the build.
