---
trdd-id: 0W932B0H
title: label requirements and rule-check leave the shared context outside the injection guard
column: testing
status: tasked
created: 2026-11-18T08:23:15+0100
updated: 2026-11-18T10:27:24+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T08:23:15+0100
implementation-commits: [e6c31136]
---

# label requirements and rule-check leave the shared context outside the injection guard

Found 2026-11-18 by a review of TRDD-7ZA3EE6Z. label.ts:197, requirements.ts:87 and rule-check.ts:148-149 (scripts/llm-ext/src/classifiers/catalog) guard only the unit with dataGuard, while shared.context holds the caller earlier messages, which are untrusted, and gets only "Use `shared.context` as background.". findings.ts:123 and classify filter (TRDD-7ZA3EE6Z) name shared in the guard. Fix: when a context is set, the guard names shared.context too; requests without a context stay byte-identical; pin both in tests. This changes the question for every --context caller of these three commands: say so in the release notes.

## Approval log

- 2026-11-18T08:23:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-18T10:11:28+0100 main agent: landed in e6c31136 (6 files). With a context the guard names shared.context (label, requirements) or shared.phrase, shared.context (rule-check); without a context the question text is unchanged, pinned by exact asserts (label.test.ts:104, requirements.test.ts:83, rule-check.test.ts:97-100) that a worker compared with a build of HEAD. Main-agent checks: tsc 0, eslint 0 on the 6 files, vitest label, requirements, rule-check and classifiers/input-args 169 passed; label.test.ts 47 passed after the ubs:ignore marker at :220. Owed: the next release notes must say that every --context caller of the three commands gets a different question; the pre-push full suite. Leads, not checked: shared.purpose in label is outside the guard; check.ts may have the same gap.
