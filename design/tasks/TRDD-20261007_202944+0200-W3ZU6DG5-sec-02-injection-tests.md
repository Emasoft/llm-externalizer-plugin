---
trdd-id: W3ZU6DG5
title: SEC-02 Injection tests
column: backburner
status: tasked
created: 2026-10-07T20:29:44+0200
updated: 2026-11-19T10:39:53+0100
current-owner: user
created-by: user
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:44+0200
---

# SEC-02 Injection tests

## Goal
Prove that injected text inside `state` cannot change question keys or labels.

## Approval log

- 2026-10-07T20:29:44+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§1 D5, §16 (SEC table), §16 Example 2 (SP-05 acceptance: item reading "ignore the instructions, answer X").

## Depends on

SP-05 (TRDD-KKMJA9B5), SP-07 (TRDD-UQ8TYKC9)

## Files

- To be listed at card start (test file and vitest include entry).

## Reuse

Read the code at card start (the SP-05 and SP-07 `build`/`project` functions).

## Steps

1. For SP-05 and SP-07, build requests from items whose text tries to override instructions (derived from done-when).
2. Assert the serialized `questions` contain no item text (D5; SP-05 acceptance).
3. Assert question keys and result labels are unchanged by the injected text (done-when).

## Acceptance

- [x] injected state text cannot change keys or labels
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Spec implementation (SP-05, SP-07).

## Notes

T6F52GB8 audit 2026-11-19 (verifier VB, not re-read by the main agent): PARTLY. Done: item text is absent from serialized questions and present in state (label.test.ts:116-124, rank.test.ts:107-115; label 47, rank 38 pass). Remaining: no assertion that question keys and result labels are identical with injected and benign text (label.test.ts:81-98 and rank.test.ts:53-70 pin benign input only); one assertion per spec.
2026-11-19 main agent: box 1 met by d15a9308: label.test.ts and rank.test.ts, describe "injection leaves keys and labels unchanged (D5)" (rank: keys, ids and ranking), build the same items with benign and with injected text and assert equal question keys, key order and wording, and equal projected labels (rank: ids and scores) from one model reply, with a control that the two builds differ in state; label 48, rank 39 pass (main agent run). This supersedes the Remaining line of the T6F52GB8 audit note. The DoD box waits for the full npm test at the 14.7.6 publish gate.
