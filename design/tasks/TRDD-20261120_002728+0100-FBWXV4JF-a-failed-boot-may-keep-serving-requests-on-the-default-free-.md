---
trdd-id: FBWXV4JF
title: A failed boot may keep serving requests on the default free profile
column: todo
status: tasked
created: 2026-11-20T00:27:28+0100
updated: 2026-11-20T00:27:36+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T00:27:28+0100
---

# A failed boot may keep serving requests on the default free profile

by worker report reports_dev/settings-writers/20261119_232730+0100-i6kui1x6-gg44r65k.md (side finding, INFERRED, not run). After the boot catch (index.ts ~540) activeSettings is the default; evaluateSettingsValidity exempts the placeholder free profile, settingsValid becomes true and settingsError is not cleared, so the NOT CONFIGURED gate (index.ts ~4831) does not fire. The catch predates 335e384e (ensureSettingsExist could already throw); 335e384e adds one more trigger, a null re-read after the migrations.

## Approval log

- 2026-11-20T00:27:28+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] a test boots with a settings load that throws and asserts a request is refused with the settings error, or the card records why requests are already refused.
