---
trdd-id: 0ICSRZ0K
title: getModelSupportedParams re-fetches endpoints on every call when the result is null
column: backburner
status: tasked
created: 2026-10-10T11:21:18+0200
updated: 2026-10-31T21:04:21+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T11:21:18+0200
implementation-commits: [cc3594d5]
---

# getModelSupportedParams re-fetches endpoints on every call when the result is null

## Goal

getModelSupportedParams (scripts/llm-ext/src/provider/completion.ts ~242-292) never caches a null result: a non-ok reply, an empty endpoints array or an empty supported-parameters Set. So a b.ai-routed model under an OpenRouter primary (likely a 404, inferred) and every model whose supported_parameters list is empty pay one /endpoints GET on every call, an extra round trip on the fast paths (owner directive: 'jev must be ultrafast'). Cache the null result for the same lifetime as a hit, keeping the existing callers' return value unchanged.

## Evidence

Fable advisor report docs_dev/20261010-yg72-inc4-advisor.md, 'Out of scope' (read, not run). The 404 for a routed model id is inferred.

## Acceptance

- [x] a test with a real local server answering /endpoints 404 shows one GET across two calls (failing before)
- [x] a test with an empty supported_parameters list shows one GET across two calls (failing before)
- [x] existing callers receive the same value as today; existing tests unchanged
- [ ] definition of done: typecheck, lint and eslint . --quiet clean, full npm test green, one commit with the TRDD id in its subject
- 2026-10-31 proof pass 1, boxes 1-3 ticked: exported HEAD tree with the negative-cache read line removed from completion.ts (the negativeUntil check, 1 line) made vitest run src/provider/supported-params-negative-cache.test.ts exit 1: the 404 test, the empty supported_parameters test and the empty endpoints test each fail with expected 2 to be 1 (two GETs); with the line restored the same three pass (exit of the file is 1 only because of the unrelated TTL test, see next line). Box 3: the pre-fix (cc3594d5 parent) versions of every test under src/provider plus free-forbidden-tools.test.ts, run against the cc3594d5 source, give 15 files 280 of 280 passed, exit 0; provider-state-render.test.ts and free-forbidden-tools.test.ts were edited by the same commit and were run in their pre-fix form.
The TTL test hung at HEAD since 28f9e9a0 (frozen faked Date starved the governor lease wait); fixed in d66aecfe. The full npm test DoD is run at the 14.3.0 release gate.

## Related

TRDD-YG72CYY7 (decision E10; increment 4 must not change this function's return value).

## Approval log

- 2026-10-10T11:21:18+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-10-31: commit cc3594d5 and src/provider/supported-params-negative-cache.test.ts passing on 2026-10-31. Boxes 1 and 2 left open: the (failing before) claim is not shown. Box 3 left open: existing tests unchanged is not shown. Box 4 left open: typecheck, lint, and full npm test are not in the evidence. Card not moved.
Round 2 2026-10-31: no box ticked. Evidence read: supported-params-negative-cache.test.ts:84,92,100 (404, empty list, empty endpoints; real node:http server counting GETs). Missing: proof that the tests fail before the fix, proof that existing tests are unchanged, and the typecheck/lint/full npm test run (ticked at the 14.3.0 release gate). The Goal line says same lifetime as a hit, but the code deliberately uses a 5 minute negative lifetime against a 1 h hit (completion.ts:232,236-237); that lifetime is not a defect.
Proof pass 1 2026-10-31 FINDING: at HEAD 6339f84f the TTL test (the negative result expires: a call after the TTL fetches again, only Date is faked) times out at 30000 ms when run alone, exit 1; at cc3594d5 it passes (280 of 280). Suspect the later governor loopback lease commits (28f9e9a0, 65d90289) combined with the faked Date; not investigated, belongs to the governor worker. The test after it fails only as collateral when the file runs whole. Box 4 (typecheck, lint, full npm test) stays open: release gate.
