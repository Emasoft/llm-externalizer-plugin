---
trdd-id: XTKTCSU6
title: Five published releases carry no SBOM, SHA256SUMS or validation report
column: todo
status: tasked
created: 2026-11-20T02:00:32+0100
updated: 2026-11-20T02:04:49+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T02:00:32+0100
---

# Five published releases carry no SBOM, SHA256SUMS or validation report

## Approval log

- 2026-11-20T02:00:32+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

GitHub releases v14.2.0, v14.3.0, v14.3.1, v14.4.0 and v14.6.3 exist with 0 assets (gh release view, 2026-11-20); the 5 green releases checked (v14.1.0, v14.4.1, v14.6.4, v14.7.6, v14.7.7) each carry 3: sbom.spdx.json, SHA256SUMS, validation-report.txt. Their Release runs failed before the upload step: v14.2.0 run 41154186904 (statusline tests), v14.3.0 43766956958, v14.3.1 43879347088, v14.4.0 43936686211 (git-cliff missing on the runner), v14.6.3 44162479702 (mypy). By a worker's grep-level read of the failed logs, the causes are fixed in later code (c4dc6bd5, ffdc019b, 716805e5 + 3c44ef2a); the five releases stay incomplete.

## Plan

Edit the notes of each of the five releases to state that its Release run failed, that it has no SBOM/SHA256SUMS/validation assets, and which later version to use (gh release edit --notes-file). Re-running the old tag workflows is not an option: the old workflow code fails the same way. Outward-facing: public release text.
Approval: outward-facing public text; main agent under the USER delegation of 2026-11-18, to be done after the 14.7.8 publish.

## Acceptance

- [ ] each of the five release notes names the failed run and the replacing version
- [ ] gh release view shows the edited notes for all five
