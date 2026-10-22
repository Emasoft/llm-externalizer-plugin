---
trdd-id: QUJMEXA4
title: L2-05 Partial-failure semantics
column: complete
status: archived
created: 2026-10-07T19:21:50+0200
updated: 2026-10-10T03:10:17+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:50+0200
implementation-commits: [d01128bb, f651b119, da2da099]
---

# L2-05 Partial-failure semantics

## Goal
Define what happens when one request of a plan fails, per split class.

## Approval log

- 2026-10-07T19:21:50+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:08:57+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:08:59+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:10:17+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed.

## Plan refs

§5 (Partial failure, caller table), §3; E46.

## Depends on

L2-04 (TRDD-M2X02VG9)

## Files

- `scripts/llm-ext/src/classifiers/l2/fan-out.ts`
- `scripts/llm-ext/src/classifiers/l2/fan-out.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. A request that fails turns its units into `invalid_response` for per-item specs (§5).
2. For whole-result specs the whole result fails (§5).
3. The split class on the spec decides which rule applies (E46).

## Acceptance

- [x] per split class
- [x] E46: One chunk fails, others succeed → per-item `invalid_response` or whole failure by split class
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed d01128bb (one commit for L2-04 and L2-05), f651b119 (test include list), da2da099 (rebuilt dist) — l2/fan-out.ts runPlan takes split: SplitClass and returns status complete|partial|failed: per-item specs turn every question key of a request with no reply into invalid_response with the reason (invalid_response, aborted, not_sent_budget, not_sent_fatal) while the other requests' answers stand (status partial); whole-result specs fail as a whole (status failed, answers empty, failures[] lists all, billed usage kept). validateAnswers is called once per reply; a null or non-object answers body is a bad-response request failure; extra keys give one warning per request. fan-out.test.ts pins both classes (E46) including synthetic 200 replies with answers null. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. OPEN: a --max-budget stop on a whole-result spec returns status failed with no answers plus a warning counting the requests not sent (N of M, X USD spent), stopped budget still set; plan E86 does not say what a whole-result spec projects, so this is my reading and needs an owner decision. Note: the status failed for the whole-result budget stop discards finished replies' answers although their usage is kept.

## Out of scope

The fan-out itself (L2-04), the per-spec split class values (SP cards).
