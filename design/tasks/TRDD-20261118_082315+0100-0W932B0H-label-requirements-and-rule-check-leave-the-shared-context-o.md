---
trdd-id: 0W932B0H
title: label requirements and rule-check leave the shared context outside the injection guard
column: testing
status: tasked
created: 2026-11-18T08:23:15+0100
updated: 2026-11-19T01:06:05+0100
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
2026-11-18T15:53:20+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): The owed release-note sentence was added to the v14.7.2 GitHub release notes on 2026-11-18, section Behaviour change: classify label, requirements and rule-check with --context (read back with gh release view v14.7.2: it says these commands now send a different question with --context and that without --context the text is byte for byte unchanged). Still owed: the pre-push full suite; the leads not checked (shared.purpose in label, check.ts) stay as noted above.
2026-11-18T16:24:37+0100 main agent check: gh release view v14.7.2 --json body shows line 37 ### Behaviour change: classify label, requirements and rule-check with --context.
2026-11-18T16:28:17+0100 note writer (batch-2 worker): the 16:24 check note above and box 3 were supplied by the main agent in the brief; the writer did not re-run gh release view.
2026-11-19T01:06:05+0100 main agent (written by worker): box 4 ticked. e6c31136 is an ancestor of v14.7.3 (verified by the main agent 2026-11-19). v14.7.3 published 2026-11-19T00:57+0100 (release commit ac3fcdef, release https://github.com/Emasoft/llm-externalizer-plugin/releases/tag/v14.7.3); publish log reports_dev/publish/20261118-14.7.3-publish.log line 20 reads 'OK: test' (the publish.py full-suite gate, run 7). Per-test counts are not in that log line; the test stages of run 6 (same code before the CPV fix 1b7b3d82) were unit 6593 passed, broker stage 222, burn, e2e, per the main agent facts of 2026-11-19.

## Acceptance

- [x] when a context is set the guard names shared.context too (label, requirements: shared.context; rule-check: shared.phrase and shared.context): commit e6c31136 (6 files), an ancestor of tag v14.7.2; tests label.test.ts, requirements.test.ts and rule-check.test.ts exist and assert shared.context in the question text (rule-check.test.ts lines 90-105, requirements.test.ts line 76)
- [x] requests without a context stay byte-identical and both cases are pinned in tests: exact asserts at label.test.ts:104, requirements.test.ts:83 and rule-check.test.ts:97-100 per the card note 2026-11-18T10:11:28 (the three files exist; line contents not re-read)
- [x] the release notes say that every --context caller of the three commands gets a different question: the card note says it was added to the v14.7.2 GitHub release notes; GitHub not read in this run, and CHANGELOG.md 14.7.2 carries the Fix line (line 38) but no behaviour-change sentence
- [x] pre-push full test suite (owed by note 2026-11-18T10:11:28): the 14.7.3 publish gate is to re-run it; no run log checked this run
