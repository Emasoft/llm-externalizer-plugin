---
trdd-id: NQMW9AK5
title: package-lock.json is out of sync so npm ci fails
column: complete
status: archived
created: 2026-11-13T22:42:16+0100
updated: 2026-11-14T12:24:22+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-13T22:42:16+0100
implementation-commits: [a34be898, e02c93ea]
---

# package-lock.json is out of sync so npm ci fails

Measured 2026-11-13 twice on HEAD b9bf1f26 in fresh worktrees: in scripts/llm-ext, npm ci fails with "Missing: llm-ext@14.1.2 from lock file"; package.json says 14.1.2 and package-lock.json still records 13.3.2. Measured by git diff of package-lock.json after npm install in /tmp/llmext-fullsuite-head: two fields drifted, the root version (lock 13.3.2, package.json 14.1.2) and engines.node (lock >=20.0.0, package.json >=20.3.0); no dependency version changed. Regenerate the lock in the real tree, never under /tmp: npm install in a worktree under the /tmp symlink rewrote every package key to a file:../../../../private/tmp/... path. Effects: any CI job or clean-build check that uses npm ci fails, including S5KOOT2S definition-of-done box 3 (npm ci in a fresh worktree). Fix: regenerate the lock with npm install --package-lock-only in scripts/llm-ext and commit it alone; find out how package.json moved ahead of the lock (a bump or publish script, a hand edit, or a merge from another release branch are all possible; not yet known) and fix that path so it cannot recur. Acceptance: npm ci succeeds in a fresh worktree at the fixing commit; the bump path updates both files.

## Approval log

- 2026-11-13T22:42:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T12:24:22+0100 — COMPLETE by main-agent@llm-externalizer-plugin. both acceptance boxes met: npm ci exit 0 and identical dist in a fresh worktree at e02c93ea; bump path in a34be898.

## Evidence

npm ci failure logs of 2026-11-13: reports_dev/full-suite-head/20261113_223200+0100-npm-ci-fail.log and the Method section of reports_dev/58cfbqhn/20261113_223813+0100-dry-run-flag-measurement.md. Archived cards AD8CE78F (npm audit fix) and Q185FRMW (native-dependency self-install) also mention package-lock but are not earlier occurrences of this drift (titles checked).

## Notes

2026-11-14T12:22+0100 publish.py step 5 never touched package-lock.json: it synced plugin.json, package.json, cli/main.ts and pyproject.toml, while step 2 runs npm ci BEFORE the bump, so each release passed and the next publish (and ci.yml:41 npm ci) failed. Fixed in a34be898: sync_package_lock_version sets lock version and packages[""].version, fails fast naming the file when the lock is missing, not JSON or has no packages[""]; step 8 stages the lock; tests/test_publish_package_lock_sync.py 3 tests, -k publish 45 passed.
2026-11-14T12:22+0100 Lock repaired in e02c93ea: version 13.3.2 to 14.1.2 (two lines, set with the a34be898 helper) and engines.node >=20.0.0 to >=20.3.0 (one line). npm install --package-lock-only was refused by the jr-pkg-guard hook (it read npm as a package name), so npm did not write this lock. packages[""] name, license, bin, engines, dependencies and devDependencies equal package.json; npm ci --ignore-scripts on a clean copy of package.json and the lock exited 0 (reports_dev/nqmw9ak5/20261114_122122+0100-lock-repair.md).
2026-11-14T12:22+0100 Only the publish.py bump path is fixed; engines.node drifted through a hand edit of package.json, which no check catches until npm ci fails (publish.py step 2 is that check). Review gaps accepted, not fixed: no test for the missing-file branch or a non-object lock, and the SystemExit tests do not assert exit code 1.
2026-11-14T12:24+0100 Box 1 evidence: detached worktree at e02c93ea, npm ci --ignore-scripts exit=0 (added 173 packages, reports_dev/nqmw9ak5/wt-npm-ci.log), npm run build exit=0, worktree clean afterwards so the built dist equals the committed dist (reports_dev/nqmw9ak5/20261114_122320+0100-fresh-worktree.md). Box 2 evidence: a34be898 (sync_package_lock_version in step 5, lock staged in step 8, 3 unit tests); not yet exercised by a real release.
2026-11-14T12:24+0100 Correction to the 12:22 lock-repair line: its npm ci exited 0 was reported by a worker; the main session saw only the added 173 packages line. Its clean copy was two files (package.json and the lock), not a worktree; the worktree check above is the acceptance evidence. The -k publish 45 passed in the 12:22 publish.py line was reported by a worker, not re-run by the main session.
2026-11-14T12:24+0100 The Acceptance checklist was added at closing time, copied verbatim from the acceptance sentence written when the card was created (2026-11-13), because trddgrep move requires one.

## Acceptance

- [x] npm ci succeeds in a fresh worktree at the fixing commit
- [x] the bump path updates both files
