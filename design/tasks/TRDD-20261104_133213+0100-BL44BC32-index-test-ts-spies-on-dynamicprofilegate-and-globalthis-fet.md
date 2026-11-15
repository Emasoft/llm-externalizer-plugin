---
trdd-id: BL44BC32
title: index.test.ts spies on dynamicProfileGate and globalThis.fetch
column: backburner
status: tasked
created: 2026-11-04T13:32:13+0100
updated: 2026-11-04T13:41:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T13:32:13+0100
---

# index.test.ts spies on dynamicProfileGate and globalThis.fetch

Found 2026-11-04 by the KNSQAQ1S judgment pass: scripts/llm-ext/src/index.test.ts:1105 vi.spyOn(dynamicProfileGate), :1866 and :2119 vi.spyOn(globalThis.fetch). Pre-existing, owned by no classifier card under R2. Judge each against the 2026-10-31 ruling and R4 on TRDD-ZB41KG62: a globalThis.fetch spy may be the allowed GlobalFetch seam; the dynamicProfileGate spy needs a reason or a real path. Owner decision whether in scope before 14.x publish.

## Approval log

- 2026-11-04T13:32:13+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-04T13:39:36+0100 the owner decision on scope is TRDD-7X2BGHLH.
2026-11-04T13:41:31+0100 the owner decision card is now TRDD-M2H4RJVQ (7X2BGHLH superseded).
