---
trdd-id: 118TUPJJ
title: A global flag before the group is refused as an unknown command
column: complete
status: archived
created: 2026-10-31T03:55:34+0100
updated: 2026-10-31T05:28:34+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-31T03:55:34+0100
implementation-commits: [510b8edd]
---

# A global flag before the group is refused as an unknown command

llm-ext --quiet scan --help exits with unknown command --quiet although global help advertises --quiet. Reproduced on the built CLI on 2026-10-31. Fix in src/cli/main.ts: global flags must be accepted before the group, with one test.

## Approval log

- 2026-10-31T03:55:34+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T05:28:34+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column todo).

## Notes

2026-10-31: closed by commit 510b8edd; src/cli/classify-launch-cli.test.ts and src/cli/estimate-positional-cli.test.ts passing on 2026-10-31.

## Acceptance

- [x] src/cli/classify-launch-cli.test.ts and src/cli/estimate-positional-cli.test.ts pass on 2026-10-31 (commit 510b8edd): a global flag before the group is accepted.
