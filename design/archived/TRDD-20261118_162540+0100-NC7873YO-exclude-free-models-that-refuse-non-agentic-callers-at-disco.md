---
trdd-id: NC7873YO
title: Exclude free models that refuse non-agentic callers at discovery, not only at runtime
column: published
status: archived
created: 2026-11-18T16:25:40+0100
updated: 2026-11-19T03:34:00+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:25:40+0100
implementation-commits: [b268f43b, 99e7d896]
release-via: publish
---

# Exclude free models that refuse non-agentic callers at discovery, not only at runtime

GitHub issue 15 item 3 (Emasoft/llm-externalizer-plugin). Since 14.4.0 such models are excluded at runtime by the gone cooldown and the persisted eviction, not at discovery.

## Acceptance

- [x] a discovery-time exclusion of free models that refuse non-agentic callers, with a test

## Approval log

- 2026-11-18T16:25:40+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T03:34:00+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped in v14.7.4 (main-agent fact F1).

## Notes

2026-11-19T01:55:57+0100 Implemented in commit b268f43b (ships in 14.7.4). resolveFreePool takes an exclude set and cuts only blocked auto-discovered ids before the top-N slice; configured ids are never cut. --bench-free-pool, the --update-all free phase and the background maintainer catalog candidates pass goneEvictedModels(). Tests and mutations cover discover.ts, update-all.ts and dynamic-maintainer.ts. Not covered by any test: the --bench-free-pool wiring (benchmark/index.ts main() is not exported and fetches the catalog first; the CLI tests spawn the built bundle). It is the same one-line exclude as update-all.
2026-11-19T01:59:18+0100 Corrections (main agent, checked 2026-11-19): (a) the mutations of discover.ts, update-all.ts and dynamic-maintainer.ts were run and reported by the worker, not reproduced by the main agent; the main agent re-ran tsc, eslint and the four test files (162 passed). (b) The maintainer filter is wider than the b268f43b commit message says: catalogFreeQualified feeds the free candidate queue, the provisional pool of an unpopulated free profile, and the free pool fingerprint (default-profiles.ts:431, :458, :618 via dynamic-maintainer.ts:917), so a blocked catalog id leaves all three. (c) The persisted gone eviction and the agentic-harnesses classification first shipped in v14.1.0 (commit 4bdd9b1b), not 14.4.0 as the card body and the commit message say.
2026-11-19T03:33:59+0100 main agent: shipped in v14.7.4 (commits b268f43b and 99e7d896; F1). 99e7d896 makes the profile detector use the same catalogFreeCandidateIds list as the maintainer, so a gone-evicted id no longer makes the detector report changed on every dispatch; it also adds an ubs:ignore comment at profile-detector.test.ts:348 (env-var reference flagged as a secret).
