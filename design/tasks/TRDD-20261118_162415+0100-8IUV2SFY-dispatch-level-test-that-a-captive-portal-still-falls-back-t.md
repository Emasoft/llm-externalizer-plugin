---
trdd-id: 8IUV2SFY
title: Dispatch-level test that a captive portal still falls back to the local profile
column: backburner
status: tasked
created: 2026-11-18T16:24:15+0100
updated: 2026-11-18T16:24:15+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:24:15+0100
---

# Dispatch-level test that a captive portal still falls back to the local profile

Moved from TRDD-WSPV40Y5 section 6 case 4: CAPTIVE PORTAL, a real node:http server answering 302 and 200 HTML on /v1/models while requests fail with ECONNREFUSED still falls back to the local profile; a server answering a real JSON models list while requests fail does not. Only the probe-level half exists (network-give-up.test.ts strictProviderAnswer, TRDD-PN0N4290); no dispatch-level test found by grep for captive or 302 in the fallback test files. Real servers and real processes, no mocks.

## Acceptance

- [ ] dispatch-level test: a captive portal (302 and 200 HTML) with requests failing ECONNREFUSED still falls back to the ready local profile, and a real JSON models list does not

## Approval log

- 2026-11-18T16:24:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
