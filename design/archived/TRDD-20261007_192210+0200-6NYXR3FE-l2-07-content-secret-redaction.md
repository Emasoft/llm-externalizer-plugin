---
trdd-id: 6NYXR3FE
title: L2-07 Content secret redaction
column: complete
status: archived
created: 2026-10-07T19:22:10+0200
updated: 2026-10-10T00:50:26+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:10+0200
implementation-commits: [298323bc, e8d7d255, 0421472e]
---

# L2-07 Content secret redaction

## Goal
Redact secrets inside file content before send, using one adopted `redactSecrets`, with a warning that carries the count.

## Approval log

- 2026-10-07T19:22:10+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:50:16+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:50:22+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:50:26+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§4 (row "Content secret redaction"), §2b (buchmark/claude-jev); E37.

## Depends on

L2-06 (TRDD-SNZ17S5L)

## Files

To be listed at card start (the adopted `redactSecrets` and its caller in `l2/inputs.ts`), plus the test file and `scripts/llm-ext/vitest.config.ts`.

## Reuse

The two existing `redactSecrets` (`scan-pipeline.ts:487`, `security_scan/intake.ts:91`).

## Steps

1. Run both existing `redactSecrets` over one shared fixture set (§4).
2. Adopt the one that catches more; no third copy (§4).
3. File a follow-up card for any pattern only the other one catches (§4).
4. Redact before send and emit a warning with the count (E37).

## Acceptance

- [x] one shared fixture set run through both implementations
- [x] the adopted one catches at least what the other catches, or a follow-up card is filed
- [x] E37: Secret inside file content → redacted before send; warning with count
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 298323bc, e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/content-redact.ts redactContent (built on security_scan/intake.ts safeRedact, fail-closed to InputError), l2/input-error.ts, l2/inputs.ts hook, security_scan/intake.ts redactSecrets/safeRedact opt-in keepLines, l2/content-redact.test.ts (9 shared fixtures through both implementations; intake adopted, it covers every scan-pipeline pattern so no follow-up card). E37 pinned by tests. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. Deviations: redaction runs on the whole text before slicing, which closes a mid-PEM-range leak found in review; a per-line redaction approach was rejected because it missed secrets spanning lines; the security scan path is unchanged, pinned by a test.

## Out of scope

Secret-path deny list (L2-06), log redaction (L2-15), the SEC-05 deny list and redaction tests.
