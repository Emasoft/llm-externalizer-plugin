---
trdd-id: AWAUDOGX
title: P10 command matrix with one real run and one fork quality evaluation per command on local_llama and locals-mlx
column: backburner
status: tasked
created: 2026-11-18T16:58:40+0100
updated: 2026-11-18T17:08:08+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:58:40+0100
parent-trdd: 1OOAH3LD
derived: true
---

# P10 command matrix with one real run and one fork quality evaluation per command on local_llama and locals-mlx

Child of TRDD-1OOAH3LD (local_llama) and TRDD-ZGSGGHQG (locals-mlx), both left open; this card is an eht of both. Runs after the calibration card of the same parent set (K1, see the Notes of 1OOAH3LD). Source: reports_dev/open-cards/20261118_162804+0100-set1-report.md. Scope: the P10 command table, one real run per command on both profiles, and one fork-agent quality evaluation per new command; it carries the USER ruling of 2026-10-08 (TRDD-ZB41KG62 line 62): "i want e2e tests for each new command. with an evaluation of the results quality made by a fork agent." (the sentence that the evaluation verdict BLOCKS the owning card done is labelled there a Coordinator reading, not a USER quote). It includes the live check whether llama-server and Locals put a think block in the reply content (note of 1OOAH3LD 2026-11-16 22:36 "Not verified live"; withLocalThinking at completion.ts:531 shipped in 97fdae64).

## Approval log

- 2026-11-18T16:58:40+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
