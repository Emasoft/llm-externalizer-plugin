---
trdd-id: 8GE0OJ5R
title: classifyUnavailable treats a 401 User not found as a gone model
column: complete
status: archived
created: 2026-10-10T09:49:48+0200
updated: 2026-10-10T10:05:09+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T09:49:48+0200
implementation-commits: [4b7eeab6]
---

# classifyUnavailable treats a 401 User not found as a gone model

## Goal

A 401 must never make free rotation mark a model gone. classifyUnavailable (scripts/llm-ext/src/free-rotation.ts:562-704) lowercases the error text and has no 401 guard, so 'API error 401 (openrouter): User not found.' matches s.includes("not found") in the gone block and returns gone, contradicting its own comments (~611, ~640) that a 401 is never rotated past. The callWithFreeRotation catch then records a cooldown and rotates whenever classifyUnavailable is non-null (free-rotation.ts:1449, 1464): with a dead key every free model can be walked and marked gone.

## Evidence

Read, not run: Fable advisor report docs_dev/20261010-yg72-inc3-advisor.md section D (Q1 evidence). 'User not found.' is OpenRouter's body in the real fixture scripts/llm-ext/src/classifiers/__fixtures__/p01/dec-err401.json (decisions endpoint). Not traced: the rotation loop's bounds, and whether scan-path 401 bodies carry that text (the ledger has 624 bare 401 details).

## Acceptance

- [x] a test feeds the real 401 body through classifyUnavailable and gets null (not gone), and fails before the fix
- [x] a callWithFreeRotation test with a 401 records no cooldown and does not rotate
- [x] definition of done: typecheck, lint and eslint . --quiet clean, full npm test green, one commit with the TRDD id in its subject, WHY comment at the guard

## Related

TRDD-YG72CYY7 (decision D14; that plan keeps classifyUnavailable unchanged, hence this separate card). Whether a 401 should stop at once is the owner's open question Q1 there; this card only stops the false gone verdict.

## Approval log

- 2026-10-10T09:49:48+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T10:05:09+0200 — column → dev by main-agent@llm-externalizer-plugin. worked from todo in this session (code in 4b7eeab6)
- 2026-10-10T10:05:09+0200 — COMPLETE by main-agent@llm-externalizer-plugin. 4b7eeab6 landed; every acceptance box proven by named tests.

## Notes

2026-10-10T10:05:07+0200 4b7eeab6: 401 guard in classifyUnavailable (free-rotation.ts:567-574). Box 1 and 2: 'classifyUnavailable returns null for the real 401 User not found body' and 'callWithFreeRotation rethrows a 401: no cooldown recorded, no rotation to the next model' (free-rotation.test.ts), both failed before the fix (before: all three free models called). Box 3: verified on the combined tree with YG72CYY7 round A (build, tsc, eslint . --quiet, 4879 tests passed, both tests by name); dist rebuilt in 241e00c2. A 403 'No auth credentials found' was already null. The guard, like STATUS_CODE_RE (404/410), is not anchored to the start of the text; anchoring both is a possible separate card.
