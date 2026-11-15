---
trdd-id: 428Y247Y
title: classify requirements hybrid command with Jev scoring and free-LLM grouping
column: backburner
status: tasked
created: 2026-11-04T12:11:50+0100
updated: 2026-11-04T12:15:09+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T12:11:50+0100
npt: [S5KOOT2S]
---

# classify requirements hybrid command with Jev scoring and free-LLM grouping

Derived from TRDD-S5KOOT2S per its approved plan Decision 5: round 3 (2026-11-04) passed Jev for requirement scoring (held-out F1 0.961 vs free LLM 0.976) but not for grouping (goal example grouped as [[s2,s3]]), so grouping stays on the free-LLM llm ask recipe. A single command doing both needs two profile slots, because classify commands accept only classifier profiles and text commands only local/free/paid (tools/definitions.ts ACCEPTED_PROFILE_TYPES). Until this card ships, the skill documents the two-step flow: classify requirements labels every sentence, then llm ask groups them, receiving every sentence with its Jev label (not only the requirements), so continuation sentences labelled other, such as exceptions and examples, survive into grouping. Evidence: reports_dev/req-extract/20261104_121049+0100-round3-report.md (machine-local raw data; the numbers are recorded on TRDD-S5KOOT2S).

## Approval log

- 2026-11-04T12:11:50+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
