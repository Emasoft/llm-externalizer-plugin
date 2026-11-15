---
trdd-id: 7ZA3EE6Z
title: classify filter takes a context flag for earlier messages
column: todo
status: tasked
created: 2026-11-14T17:11:46+0100
updated: 2026-11-14T17:11:46+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T17:11:46+0100
---

# classify filter takes a context flag for earlier messages

Increment B of TRDD-WYY3SPDX. Increment A (3d089c03) gave `--context FILE` to `classify label`, whose instruction already uses the shared context. `classify filter` was left out on purpose: its text-items instruction (classifiers/catalog/filter.ts, about line 85, `${i.question} ${dataGuard("the text in the state")}`) never mentions `shared.context`, although filter.ts sets `sharedState = i.context ?? null` (about line 61). Adding the flag alone would send the context and have it ignored.

Scope:
1. Make the filter text-items instruction reference the context when one is set (the same sentence label and requirements use: "Use `shared.context` as background."), and add the `--context` flag entry (file: true, - reads stdin), modelled on label.ts.
2. The golden prompt pins in filter.test.ts (about lines 15, 104-105, 126) change only when a context is set; a run without context must send byte-identical questions. Test both.
3. A live check, pre-registered before running: (a) a flip case, where an item is ambiguous without the context and the context decides it, so the verdict changes; (b) a control, the same item without context; (c) an irrelevant context that must not change the verdict. Record the scores. If the context moves scores in a way that changes accepted verdicts for existing users, that is a USER decision before shipping.
4. Decide, and record here, whether find and compare need a context input too (WYY3SPDX asked for that decision); neither has a context field today.
5. Docs: classify.md filter flag row and request-shape note, plus the SKILL.md routing row (extend the label row), marked "needs a release that includes it".

Tests go through the recorded-reply GlobalFetch seam, the same as the label tests in input-args.test.ts (describe "TRDD-WYY3SPDX"). The tool definitions test in tools/definitions-classify.test.ts that pins `context` to label and requirements only must be updated to include filter.

## Approval log

- 2026-11-14T17:11:46+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
