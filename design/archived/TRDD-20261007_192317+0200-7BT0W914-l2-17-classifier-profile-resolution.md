---
trdd-id: 7BT0W914
title: L2-17 Classifier profile resolution
column: complete
status: archived
created: 2026-10-07T19:23:17+0200
updated: 2026-10-10T03:13:05+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:23:17+0200
implementation-commits: [bf6bdbbd, f651b119, da2da099]
---

# L2-17 Classifier profile resolution

## Goal
Resolve the active classifier profile with a type check through PT-03 and no paid gate.

## Approval log

- 2026-10-07T19:23:17+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:13:00+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:13:01+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:13:05+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed.

## Plan refs

§3 (`l2/profile.ts`), §4 (row "Classifier profile schema": `validateClassifierProfile`), D2, §8 (profiles).

## Depends on

PF-01 (TRDD-82LIQI5I), PT-03 (TRDD-B9FWID59)

## Files

- `scripts/llm-ext/src/classifiers/l2/profile.ts`
- `scripts/llm-ext/src/classifiers/l2/profile.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`validateClassifierProfile` in `config.ts` (owner of the classifier profile schema, §4); the type check from PT-03.

## Steps

1. Resolve `active_classifier` to a profile. (derived from done-when)
2. Check the profile type through PT-03. (derived from done-when)
3. No paid gate and no `allow_paid` check (D2).

## Acceptance

- [x] `active_classifier` resolved
- [x] type check goes through PT-03
- [x] no paid gate (D2)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed bf6bdbbd (resolver and tests, with the PF-04 and PF-02 wiring), f651b119 (test include list), da2da099 (rebuilt dist) — l2/profile.ts resolveClassifierProfile({settings, profileFlag, command}): name is --profile else active_classifier; an unknown name errors; the type check goes through profileSelectionRefusal (PT-03) with the chosen name, so a non-classifier active_classifier or --profile is refused naming its type; schema through validateClassifierProfile; defaults from CLASSIFIER_DEFAULTS; no allow_paid_models check (D2); selectClassifierProfile adds the catalog checks (E19, E16). The per-call deadline timeoutMs is the profile's timeout_ms (default 60000) across attempts. A literal classifier api_key is refused (only a $VAR reference is accepted, the message does not echo the value) and the resolver returns only apiKeyEnv, the variable name; provider, session_id, user, trace pass through unvalidated until PF-08. profile.test.ts 12+ tests. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. OPEN ITEMS: none for this card.

## Out of scope

The profile schema (PF-01), the missing-profile error (PF-03).
