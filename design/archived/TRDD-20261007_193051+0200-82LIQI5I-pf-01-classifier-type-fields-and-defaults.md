---
trdd-id: 82LIQI5I
title: PF-01 Classifier-type fields and defaults
column: complete
status: archived
created: 2026-10-07T19:30:51+0200
updated: 2026-10-09T23:30:18+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:30:51+0200
implementation-commits: [4d0191bf]
---

# PF-01 Classifier-type fields and defaults

## Goal
Implement the classifier row of the §8 field table with the §8 defaults.

## Approval log

- 2026-10-07T19:30:51+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:30:17+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:30:17+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:30:18+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§8 (classifier schema), D2, D9; E84.

## Depends on

PT-01 (TRDD-QRF04JVJ)

## Files

- `scripts/llm-ext/src/config.ts` (`validateClassifierProfile`, field table row)
- tests and the vitest include entry: to be listed at card start

## Reuse

- the PT-01 field table
- read the code at card start for existing profile validators

## Steps

1. Add the classifier fields: `profile-type`, `api: openrouter-remote`, `api_key` (`$VAR`), `model`, `endpoint` (`decisions` default | `systemone`), `max_requests_per_call` (8), `concurrency` (8), `timeout_ms` (60000), `max_attempts` (3), `context_tokens` (override only when the catalog reports none), `provider` (strict OpenRouter ProviderPreferences keys), `session_id` and `user` (at most 256 characters), `trace` (known keys plus custom keys allowed).
2. Unknown keys fail at load.
3. The schema is checked at load, offline; loading never touches the network.
4. No `allow_paid` field exists (D2).
5. Add WHY comments.

## Acceptance

- [x] the classifier row of §8's field table implemented, with defaults of §8
- [x] E84: unknown key in a classifier profile → load error
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 4d0191bf — validateClassifierProfile + CLASSIFIER_DEFAULTS in config.ts, classifier-profile.test.ts. The paid gate is ungated for a real classifier profile (no chat mode) and stays gated for a relabelled chat profile, which fails the schema check (USER ruling D2). Note: in shouldForceFreeMode the new classifier line is redundant, a profile without mode already returns false one line earlier. Edits were made with a scripted exact-string replace; the coordinator re-read every changed line. Same commit carries the PT-02 restore-lockout fix (docs_dev/20261009-PT-02-restore-fix-report.md). Whole package, run by the coordinator on the committed tree: npm test 215 files passed / 4 skipped, 3414 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet, build 0 per the integration worker; the real settings.yaml hash unchanged.

## Out of scope

Catalog-dependent checks (PF-02), provider/trace/session_id/user validation detail (PF-08), key resolution (PF-11).
