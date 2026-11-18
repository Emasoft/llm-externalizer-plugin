---
trdd-id: 09905HDI
title: session-summary generic-failure error lists every tried model
column: complete
status: tasked
created: 2026-11-18T13:53:29+0100
updated: 2026-11-18T15:06:34+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T13:53:29+0100
implementation-commits: [3cb60045]
release-via: publish
---

# session-summary generic-failure error lists every tried model

GitHub issue 15 item 6 (verification: reports_dev/issue15-verify/20261118_134848+0100-report-consolidated.md). The terminal generic-failure message at driver.ts callWithRetry ('failed after N attempt(s) on model X') named only the last model; only allModelsExhausted listed every tried model. Changed: callWithRetry takes the run-shared triedModelIds and appends 'Models already tried in this run: id (reason), ...' when non-empty; 'Checkpoint saved at' sentence kept; no-tried case byte-identical. allModelsExhausted wording (TRDD-TYHKAKCB local sentence) untouched. Test in driver.test.ts.

## Approval log

- 2026-11-18T13:53:29+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T15:06:34+0100 — column → complete by main-agent@llm-externalizer-plugin. implemented in 3cb60045 and verified (driver.test.ts 85/85, until-done 15/15, driver-abort 4/4 one file at a time, tsc and eslint 0, mutation check fails as expected); acceptance boxes ticked or struck with reason; ships in 14.7.3; approved by the main agent under the USER delegation of 2026-11-18

## Verification

2026-11-18 14:31 commit 3cb60045: driver.test.ts 85/85 pass; until-done.test.ts 15/15 pass; driver-abort.test.ts 4/4 pass (one file at a time); tsc and eslint exit 0; the clause sits after the underlying error text: "... on model X: <err>. Models already tried in this run: id (reason), ... . Checkpoint saved at ..."; mutation (tried-models clause removed) fails the "already tried" test (vitest-mutation2), driver.ts restored cmp-identical.

## Acceptance

- [x] "callWithRetry takes the run-shared triedModelIds and appends 'Models already tried in this run: id (reason), ...' when non-empty" (source: card line 22)
- [x] "'Checkpoint saved at' sentence kept" (source: card line 22)
- [x] "no-tried case byte-identical" (source: card line 22)
- [x] "allModelsExhausted wording (TRDD-TYHKAKCB local sentence) untouched" (source: card line 22)
- [x] "Test in driver.test.ts." (source: card line 22)

## Acceptance evidence

box 1: commit 3cb60045 driver.ts: callWithRetry gains a triedModels parameter, call site passes triedModelIds, message appends "Models already tried in this run: ${modelId} (${reason}), ..." when triedModels.length > 0; driver.test.ts test asserts the message contains "Models already tried in this run: <FREE_MODEL> (gone)." and "failed after 1 attempt(s) on model '<FALLBACK_MODEL>'"; mutation (clause removed) fails that test (vitest-mutation2) — shows the clause is appended, after the error text, with id (reason)
box 2: driver.test.ts new test asserts msg contains "Checkpoint saved at"; diff keeps the sentence "Checkpoint saved at ${checkpointPath} — fix the underlying issue and re-run to resume." unchanged — shows the sentence is kept
box 3: ? inferred — by reading the 3cb60045 diff, with an empty triedModels the template yields "${lastMsg}. " + "" + "Checkpoint saved at ...", equal to the old string; no test asserts byte identity of the no-tried message; not ticked
box 4: git show 3cb60045 -- driver.ts has 4 hunks (imports, callWithRetry signature, stop handling and message, call site); none touches allModelsExhausted — shows its wording is untouched
box 5: driver.test.ts "the generic failure message also names the models already tried in this run, with their reasons" (3cb60045); driver.test.ts 85/85 pass (report-revision2) — shows the test exists and passes
box 3, main agent 2026-11-18, verified by reading git show 3cb60045 -- driver.ts: with triedModels empty the message is "${lastMsg}. " + "" + "Checkpoint saved at ${checkpointPath} — fix the underlying issue and re-run to resume.", the same text as the old single template literal. No test asserts byte identity.
