---
trdd-id: DAGBDXUB
title: SP-00 DecisionSpec type, registry, consistency tests
column: complete
status: archived
created: 2026-10-07T19:47:25+0200
updated: 2026-10-10T05:02:50+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:47:25+0200
implementation-commits: [f2a4e8d1, 161a2819, 0b59bb6a]
blocked-by: []
unblock-when: [trdd:V8Q20MLW]
pre-block-column: 
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_200010+0200-V8Q20MLW-c4-02-definitions-ts-classify-entries.md
blocker-holds-if: exit-0
---

# SP-00 DecisionSpec type, registry, consistency tests

Define the `DecisionSpec` type and the registry in `catalog/index.ts`, and add the consistency tests that every spec registers against.

## Approval log

- 2026-10-07T19:47:25+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:01:01+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:01+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T04:43:03+0200 — column → blocked by main-agent@llm-externalizer-plugin. remaining work waits on: V8Q20MLW
- 2026-10-10T05:02:50+0200 — COMPLETE by main-agent@llm-externalizer-plugin. last box ticked on the C4-02 consistency test. Cleared blocked-by (--clear-blocker override).

## Plan refs

§3 L3 row and the `DecisionSpec` signature; §4 (catalog is the only owner of question text, criteria, state shape, default thresholds, policy, attention predicate, split class, injection placement, validation-policy choice); §16 SP table.

## Depends on

L1-01 (TRDD-V6HL0ERI), L1-03 (TRDD-P7OR5OQP)

## Files

- `scripts/llm-ext/src/classifiers/catalog/index.ts` (registry; owner)
- the file holding the `DecisionSpec` type: to be listed at card start
- the registry test file: to be listed at card start
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`

## Reuse

L1-01 (question types), L1-03 (validation policy presets); to be confirmed at card start.

## Steps

1. read the §3 `DecisionSpec` signature and the §4 owner table; list every field a spec must carry (derived from done-when).
2. define the type: `interface DecisionSpec<I, R> { id: string; input: ZodType<I>; thresholds: Record<string, ThresholdSpec>; split: SplitClass; injection: "index-scoped" | "params-in-instructions"; validation: ValidationPolicy; build(i: I, t: Thresholds): Built; project(answers: Answers, i: I, t: Thresholds, ctx: ProjectCtx): R; attention(r: R): boolean; }` (§3, L3 row).
3. create the registry in `catalog/index.ts`: one entry per decision spec; specs register themselves there (SP-01..SP-21 each add their own line).
4. consistency tests: the registry lists every spec file under `catalog/`; every spec has a unique id, a validation policy, a split class and an injection placement; the `definitions.ts` entries are checked against the registry (§4: command flags/defaults text are owned by the catalog spec, checked by test).
5. add the test file to the vitest include list (derived from done-when).
6. WHY comments at every non-obvious rule.

## Acceptance

- [x] registry lists every spec
- [x] `definitions.ts` check
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed f2a4e8d1, 161a2819 and 0b59bb6a (vitest include list) — catalog/spec.ts (DecisionSpec types), catalog/index.ts (DECISION_SPECS registry, defineRegistry, assertSpecShape, getSpec, unregisteredClassifyTools), catalog/index.test.ts 9 tests. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. Box 2 (definitions.ts check) left UNTICKED: the check runs over the real buildTools but is vacuous until C4-02 adds the first classify_* tool, and the flag/default text comparison belongs to C4-02. OPEN ITEMS: ThresholdSpec, SplitClass, Built, Answers and ProjectCtx are not defined by the plan and were derived (ThresholdSpec now extends the policy kit's, 161a2819); the classify_<id> tool-name convention is an assumption; L2-01 should alias its SplitJob input to Built. The registry-lists-every-spec test is vacuous until SP-01 adds the first spec.
2026-10-10: `Built.unsplittable` has no per-question unit reference list; the planner (L2-02) treats every unit as referenced. Add a reference list here only if a command card needs the subset.

## Out of scope

Individual specs (SP-01 onward), the regex worker (SP-22), CLI flags (C4-01).

## Notes

2026-10-10 BLOCKED (pre-block-column dev): its only open box, the definitions.ts check, waits on TRDD-V8Q20MLW (C4-02, which registers the classify entries in tools/definitions.ts); unblock-when trdd:V8Q20MLW. Probe note: as on the other blocked cards.
2026-10-10: box 2 ticked on the C4-02 evidence: definitions-classify.test.ts (commits 6cc2a9ad, 3c3db86f) checks every definitions.ts classify entry against the registry (entry per spec, flags, defaults, ranges, help equal to the spec); all boxes ticked.
