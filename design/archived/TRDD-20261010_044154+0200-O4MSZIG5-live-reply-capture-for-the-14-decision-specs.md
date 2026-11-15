---
trdd-id: O4MSZIG5
title: Live reply capture for the 14 decision specs
column: complete
status: archived
created: 2026-10-10T04:41:54+0200
updated: 2026-11-04T09:51:08+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T04:41:54+0200
unblock-when: [decision:owner provides OPENROUTER_API_KEY in the environment and says go]
implementation-commits: [e41d64d8, 12e74e64]
---

# Live reply capture for the 14 decision specs

## Goal

For each of the 14 registered specs (verify, screen, filter, label, rank, find, decide, compare, extract, audit, review, check, findings, test-output) send one real request built by the spec's `build` from a small fixed input through the real decisions endpoint and save the reply as a fixture, then run that spec's `project` on it.

Constraints (verbatim): "the API key is read only from the environment and never printed or written; raw replies with account data stay under gitignored reports/; a fixture committed to the public repo carries no account data; it needs network and the key on the owner's machine; Jev cost needs no cap or go-ahead (owner ruling)".

Plan refs: D12, D21, section 16 SP preamble (each SP card captures one live reply from its own build, sanitized like P-03).

## Acceptance

- [x] verify: reply captured, fixture committed, project test on it passes
- [x] screen: reply captured, fixture committed, project test on it passes
- [x] filter: reply captured, fixture committed, project test on it passes
- [x] label: reply captured, fixture committed, project test on it passes
- [x] rank: reply captured, fixture committed, project test on it passes
- [x] find: reply captured, fixture committed, project test on it passes
- [x] decide: reply captured, fixture committed, project test on it passes
- [x] compare: reply captured, fixture committed, project test on it passes
- [x] extract: reply captured, fixture committed, project test on it passes
- [x] audit: reply captured, fixture committed, project test on it passes
- [x] review: reply captured, fixture committed, project test on it passes
- [x] check: reply captured, fixture committed, project test on it passes
- [x] findings: reply captured, fixture committed, project test on it passes
- [x] test-output: reply captured, fixture committed, project test on it passes
- [x] decide: one capture with more than 9 options
- [x] token estimate compared with the usage the API reports for these 14 requests (over- and under-estimate table)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T04:41:54+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T05:04:05+0200 — column → backburner by main-agent@llm-externalizer-plugin. needs the owner's key and a go; cannot be pulled by an agent
- 2026-10-31T12:08:40+0100 — column → testing by main-agent@llm-externalizer-plugin. capture committed e41d64d8; include list and full suite pending
- 2026-11-04T09:51:08+0100 — COMPLETE by main-agent@llm-externalizer-plugin. definition of done met 2026-11-04; evidence in Notes.

## Notes

2026-10-10: waits for the owner: OPENROUTER_API_KEY in the environment and a go; the coordinator will ask. Moved to backburner so the board does not instruct pulling it; unblock-when carries the human-only predicate [decision:owner provides OPENROUTER_API_KEY in the environment and says go], but the tool cannot express a block without a card id or probe. Also: mandate true with mandated-by none is the tool's default for a card minted by the main agent, not an owner mandate.
2026-10-31: live capture done at e41d64d8 (14 fixtures under src/classifiers/__fixtures__/o4, catalog/live-capture.test.ts, 18 tests pass). Open: definition-of-done (include list, full npm test). Follow-up: envelope under-estimates small requests by up to 55%.
2026-11-04: definition of done met. catalog/live-capture.test.ts is in the explicit vitest include list (vitest.config.ts line 770) and runs in phase 1 (vitest list with the phase-1 flags: 15 tests); tsc --noEmit exit 0; npm run lint and eslint --quiet exit 0 (lint fix 12e74e64); full npm test green in all 3 phases run separately (phase 1: 306 files, 5680 passed, 7 skipped; phase 2: 216 passed, 3 skipped; phase 3: 12 passed); no test doubles beyond the GlobalFetch seam. The governor round 4 #7 RAM precondition that failed phase 2 earlier is governor code (TRDD-ZTO9K8EK), fixed in 9d902ace, not part of this card.
