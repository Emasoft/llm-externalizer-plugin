---
trdd-id: BL44BC32
title: index.test.ts spies on dynamicProfileGate and globalThis.fetch
column: backburner
status: tasked
created: 2026-11-04T13:32:13+0100
updated: 2026-11-19T11:21:41+0100
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
2026-11-19T11:11:33+0100 R10 of the T6F52GB8 final report (main agent ruling, delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): a stub is allowed only where a real call is impossible and carries the reason; passthrough spies are observers; not a 14.7.6 blocker; the card closes only after the 2026-10-31 ruling it names is read and each stub-fetch spy is checked against R10.
2026-11-19T11:21:40+0100 correction to the R10 note above: R10 of the T6F52GB8 final report was corrected in 7cf6c10b after the main agent read the 2026-10-31 ruling (ZB41KG62 card lines 85-89: PERMISSIVE, doubles allowed only as (a) fakes of what cannot be produced for real, (b) hand-built decision specs, (c) injected sinks and signal sources; R4: a seam that throws to assert non-use is not a double). The passthrough spies (dynamicProfileGate and two fetch spies) return real data and are not doubles; the four fetch spies that return a stub Response are doubles allowed only under (a), each with its reason at the stub. Not a 14.7.6 blocker.
