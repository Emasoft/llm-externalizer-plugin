---
trdd-id: XZZ2NSWY
title: Runner awaits a spec prepare step so classify extract runs the regex worker
column: blocked
status: tasked
created: 2026-10-10T05:28:57+0200
updated: 2026-10-10T08:44:07+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T05:28:57+0200
blocked-by: [ZB41KG62]
unblock-when: [decision:test-doubles-ruling]
pre-block-column: dev
implementation-commits: [1111c2f6]
blocker-probe: 'grep -qF OWNER-RULING-test-doubles: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_050214+0200-ZB41KG62-classifiers-command-group-system-one-inference-with-the-jev-.md'
blocker-holds-if: exit-nonzero
---

# Runner awaits a spec prepare step so classify extract runs the regex worker

## Goal

Make classify extract run the regex worker (SP-22, withMatches in classifiers/catalog/extract.ts) from the command line: today nothing calls it, so the command ends in no regex matches.

## Plan refs

Section 9 (classify extract), SP-22 (TRDD-DTDGVXWV, commit 0db9627e), C4-01 (TRDD-BUL4EEBP) runner, C4-03 (TRDD-4Q1IVJOE) launcher.

## Depends on

SP-22 (TRDD-DTDGVXWV, complete), C4-01 (TRDD-BUL4EEBP)

## Design

- The runner awaits an optional async prepare step on the spec before build. It runs after the cheap flag refusals and the -o check, so a refused invocation never starts a worker.
- The prepared input goes to the result step too, not only to build.
- Production passes only { signal } to withMatches, never spawn.
- Extract tests that hand in dummy matches are rewritten to go through the prepare step.
- One test runs against the real built CLI.

## Out of scope

Per-command input flags (TRDD-EVORI1LK), line positions (line-index mode card).

## Approval log

- 2026-10-10T05:28:57+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:16:46+0200 — column → blocked by main-agent@llm-externalizer-plugin. waits on the owner ruling about test doubles (plan card ZB41KG62, OWNER DECISION single open item)

## Acceptance

- [x] runner awaits an optional async prepare step on the spec before build, after the cheap flag refusals and the -o check (test: a refused invocation starts no worker)
- [x] the prepared input reaches the result step as well as build (test)
- [x] production passes only { signal } to withMatches, never spawn (test or code read named)
- [x] extract tests that hand in dummy matches go through the prepare step
- [x] one test runs classify extract against the real built CLI
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Notes

Depends on the runner code already committed (643d7887), not on BUL4EEBP closing. It edits run-decision.ts, the same file as the BUL4EEBP test-double rework: run the two in sequence, never in parallel.
2026-10-10T08:13:23+0200 1111c2f6: classify extract now runs the regex worker: the runner awaits an optional spec.prepare after the cheap refusals and the -o check and before build; only extract sets it, and its prepare calls withMatches with only { signal }; the prepared input reaches build, chunkDefaults and project; a built-CLI test finds a one-match field with no model call. Deviation from the brief: profile and key checks stay after build, because a no-question build (E65) needs no profile and that is known only after prepare; a keyless extract run does local regex work before it is refused. A fraction --candidate-cap reaches prepare and is refused by withMatches before any worker; the test counts prepare calls, not workers. Definition-of-done box waits on the owner ruling (hand-built spec wrappers in its tests).
2026-10-10T08:44:06+0200 pre-block-column set to dev: the card was worked from todo (code in 1111c2f6), so a release must put it back in dev.
