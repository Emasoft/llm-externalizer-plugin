---
trdd-id: IM2NBX1S
title: publish.py runs git in the caller directory instead of its own repository
column: testing
status: tasked
created: 2026-11-15T22:32:30+0100
updated: 2026-11-16T09:30:56+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T22:32:30+0100
implementation-commits: [e744d9c6]
---

# publish.py runs git in the caller directory instead of its own repository

## Approval log

- 2026-11-15T22:32:30+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T09:30:56+0100 — column → testing by main-agent@llm-externalizer-plugin. fix and tests landed; full suite owed pre-push

## Problem

- scripts/publish.py run() (about line 117) passes cwd=cwd, and every git call (preflight git status, git tag --list, git ls-remote, git add, git commit, git tag -a, git push --follow-tags) leaves cwd unset, so git acts on the CALLER'S working directory, not on repo_root (Path(__file__).resolve().parent.parent, about line 866).
- Observed 2026-11-15: publish.py of the release worktree builds_dev/release-14.3.0 was started from the main checkout. Steps 1-7 wrote files in the worktree, then `git add <worktree paths>` ran in the main checkout and was refused because builds_dev is gitignored there ("The following paths are ignored"). Had the paths not been ignored, the commit, tags and push would have acted on the main checkout and its branch release/13.6.1.
- So a dry run started from another directory checks that directory's tree cleanliness and tags, not the release tree's.

## Fix

- Pass cwd=repo_root to every git call in publish.py (or have run() default cwd to repo_root), and add a test that runs publish.py --dry-run from an unrelated directory and asserts its git checks target repo_root.

## Acceptance

- [x] every git invocation in publish.py runs with cwd=repo_root
- [x] a test started from a different directory proves the preflight and tag checks use repo_root

## Notes

2026-11-16T09:30:55+0100 fixed in e744d9c6. tests/test_publish_runs_git_in_repo_root.py + test_publish_failed_push.py + test_publish_resolver_tag.py: 12 passed (run by the main agent in builds_dev/dev-after-14.3.0); ruff clean. Not covered by the guard: the CPV uvx calls (lines 731, 753), which pass the repo path as an explicit argument. Full suite owed before the push.
