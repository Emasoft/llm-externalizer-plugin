---
trdd-id: BH1XNP06
title: Unify the free-memory reading of calibration and the governor off darwin
column: backburner
status: tasked
created: 2026-11-01T03:40:23+0100
updated: 2026-11-01T03:40:23+0100
current-owner: main-agent@llm-externalizer
created-by: main-agent@llm-externalizer
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer
approval-datetime: 2026-11-01T03:40:23+0100
---

# Unify the free-memory reading of calibration and the governor off darwin

Off darwin, calibration/memory.ts freeMemory uses os.freemem (MemFree, page cache excluded) while governor/ram.ts uses MemTotal minus MemAvailable. Calibration therefore sees far less free memory than the governor admits and writes memory-limited records that the governor would grant. Found by the unit 6 review (m2, TRDD-ZTO9K8EK). Fix: one reading for both, so the comments in governor/settings.ts and calibration/record.ts that say both judge RAM by one limit are true on every platform.

## Approval log

- 2026-11-01T03:40:23+0100 — MANDATE issued by main-agent@llm-externalizer (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
