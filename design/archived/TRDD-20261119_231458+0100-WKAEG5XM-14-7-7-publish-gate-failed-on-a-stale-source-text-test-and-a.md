---
trdd-id: WKAEG5XM
title: 14.7.7 publish gate failed on a stale source-text test and a racy fixture
column: complete
status: archived
created: 2026-11-19T23:14:58+0100
updated: 2026-11-20T00:28:15+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T23:14:58+0100
implementation-commits: [dbf35b15]
---

# 14.7.7 publish gate failed on a stale source-text test and a racy fixture

The 14.7.7 publish (publish.py --patch, 2026-11-19) failed at npm test with 2 failures. (1) src/free-rotation-coverage.test.ts:137 still looked for the migrateProfileSections call in index.ts after 335e384e moved it to boot-settings.ts; a regression of TRDD-VBAJX5A1, missed because only the test files covering the change were run and no sweep searched the tests for the moved string literal. (2) src/empty-pool-wait.test.ts:112 JSON.parse read a fake child's record while it was half written: the child writes with writeFileSync and records() lists *.json while children still run; the file passes alone. Also tests/test_publish_real_build_stale_dist.py and tests/test_publish_reports_changed_files.py call git through subprocess.run with no timeout (ubs py.security.subprocess-timeout). Fix in progress: the test follows the move, the child writes then renames, timeout=120 on the git calls.

## Approval log

- 2026-11-19T23:14:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:15+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column todo).

## Acceptance

- [x] the next publish gate passes the full test suite

## Notes

2026-11-20: the 14.7.7 publish gate passed the full test suite (publish.py exit 0, npm test OK); v14.7.7 pushed to main as 63451b7b.
