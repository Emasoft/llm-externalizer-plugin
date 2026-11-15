---
trdd-id: VUPK2NM7
title: classify ping no_call says the key is ok while the account cannot pay
column: complete
status: archived
created: 2026-11-14T17:19:58+0100
updated: 2026-11-14T17:40:18+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T17:19:58+0100
implementation-commits: [6e6e87b2]
---

# classify ping no_call says the key is ok while the account cannot pay

Found 2026-11-14 during the TRDD-WYY3SPDX live check. `classify ping --no_call` printed "key check: ok (... spent <N> USD, no spend limit)" while every paid decision call failed with HTTP 402 Insufficient credits. A worker read "ok" as "remote calls will work", and 9 paid runs silently became local-decider runs (the hidden error is TRDD-XJE5DDK2).

Fix: make the --no_call output say what it checked. For example: "key check: ok (the key is valid; the credit balance is not checked, run without --no_call to test a real call)". First confirm in the code which endpoint the key check reads, and whether it returns a usable balance or remaining-limit field. If it does, report it rather than adding the caveat. Test the new wording with a recorded key-endpoint reply. Docs: classify.md, the ping section, marked "needs a release that includes it".

## Approval log

- 2026-11-14T17:19:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T17:40:18+0100 — COMPLETE by main-agent@llm-externalizer-plugin. fixed in 6e6e87b2, verified live.

## Acceptance

- [x] The key endpoint returns no account balance (GET /api/v1/key: usage, limit, limit_remaining, already printed), so the --no_call line now says the balance is not checked and points to a real call; exit code unchanged (6e6e87b2).
- [x] ping.test.ts asserts the wording and failed before the change; live run of the built CLI printed the new line, exit 0.
- [x] classify.md and SKILL.md say --no_call checks the key, not the balance.
