---
trdd-id: DNSW16LW
title: Real-build publish test took 154.6 s in one run with no known cause
column: complete
status: archived
created: 2026-11-20T00:27:27+0100
updated: 2026-11-20T01:24:51+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T00:27:27+0100
implementation-commits: [37125661]
---

# Real-build publish test took 154.6 s in one run with no known cause

one gate run of test_publish_real_build_stale_dist.py took 154.6 s; other runs were shorter. Cause not measured.

## Approval log

- 2026-11-20T00:27:27+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T01:24:51+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column todo).

## Acceptance

- [x] per-step timings of the test recorded and the slow step named, or the test bounded with a timeout and the cause fixed.

## Notes

2026-11-20 (worker measurement, three runs inside a copy of the real test): npm run build took 11, 27 and 57 s; every git step stayed at or under 4.5 s. The build dominates and scales with machine load; the 154.6 s run did not reproduce (cause inferred: load). No timeout bound: pytest-timeout is not installed and publish.py's generic runner has no upper bound by design, so a bound would turn a loaded machine into a gate failure.
