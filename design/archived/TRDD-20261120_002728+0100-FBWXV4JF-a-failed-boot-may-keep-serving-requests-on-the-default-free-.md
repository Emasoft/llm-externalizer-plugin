---
trdd-id: FBWXV4JF
title: A failed boot may keep serving requests on the default free profile
column: complete
status: archived
created: 2026-11-20T00:27:28+0100
updated: 2026-11-20T01:54:28+0100
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
implementation-commits: [6f1089eb]
---

# A failed boot may keep serving requests on the default free profile

by worker report reports_dev/settings-writers/20261119_232730+0100-i6kui1x6-gg44r65k.md (side finding, INFERRED, not run). After the boot catch (index.ts ~540) activeSettings is the default; evaluateSettingsValidity exempts the placeholder free profile, settingsValid becomes true and settingsError is not cleared, so the NOT CONFIGURED gate (index.ts ~4831) does not fire. The catch predates 335e384e (ensureSettingsExist could already throw); 335e384e adds one more trigger, a null re-read after the migrations.

## Approval log

- 2026-11-20T00:27:28+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T01:54:28+0100 — COMPLETE by main-agent@llm-externalizer-plugin. USER delegation 2026-11-18: solve all issues yourself; 6f1089eb ships the boot-failure test (src/boot-failed-settings.test.ts) that satisfies the acceptance box.

## Acceptance

- [x] a test boots with a settings load that throws and asserts a request is refused with the settings error, or the card records why requests are already refused.

## Notes

2026-11-20: 6f1089eb adds settingsLoadFailed in index.ts: after a settings load that throws at boot, settings stay invalid, overrideActiveProfile returns the load error and the inline repair does not run; a reload that reads a valid file clears it. Test src/boot-failed-settings.test.ts (settings.yaml made a directory): a scan_folder dispatch is refused with NOT CONFIGURED naming the error; discover, get_settings, list_profiles and profile still run without --profile. On the unfixed code the request was refused only by the empty free pool; serving on a populated default pool was not demonstrated.
