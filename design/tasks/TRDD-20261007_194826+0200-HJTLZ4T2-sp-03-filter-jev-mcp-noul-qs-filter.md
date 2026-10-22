---
trdd-id: HJTLZ4T2
title: SP-03 filter (jev-mcp noul + qs filter)
column: blocked
status: tasked
created: 2026-10-07T19:48:26+0200
updated: 2026-10-10T08:27:27+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:48:26+0200
implementation-commits: [189a6b44, f651b119, da2da099]
blocked-by: [O4MSZIG5, XHHH0N1E, LWDKZO2A]
unblock-when: [trdd:O4MSZIG5, trdd:XHHH0N1E, trdd:LWDKZO2A]
pre-block-column: dev
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261010_044154+0200-O4MSZIG5-live-reply-capture-for-the-14-decision-specs.md -o -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261010_082128+0200-XHHH0N1E-in-01-shared-input-modes-through-collectinputs-filter-rank-f.md -o -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261010_082309+0200-LWDKZO2A-in-07-text-output-json-and-the-filter-flags-no-collapse-save.md
blocker-holds-if: exit-0
---

# SP-03 filter (jev-mcp noul + qs filter)

The filter (jev-mcp noul + qs filter) decision as one catalog file: input schema, question texts, state shape, thresholds, split class, pure policy, attention predicate, injection placement (D5).

## Approval log

- 2026-10-07T19:48:26+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:11:31+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:11:32+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T04:43:02+0200 — column → blocked by main-agent@llm-externalizer-plugin. remaining work waits on: O4MSZIG5, V8Q20MLW
- 2026-10-10T08:27:27+0200 — blocker change by main-agent@llm-externalizer-plugin: EVORI1LK was superseded by IN-01..IN-09; blockers re-pointed to the input card(s) and the text-output card this spec needs.

## Plan refs

§9 (`classify filter`), §5 (filter row), D5, D14, D17, D21, D27, D28, D31; §16 SP table, §16 Example 2 (SP-05) as the model for detail.

## Depends on

SP-00 (TRDD-DAGBDXUB), L2-10 (TRDD-9BBMGTC3), L2-19 (TRDD-PXVVVPYV)

## Files

- `scripts/llm-ext/src/classifiers/catalog/filter.ts`
- `scripts/llm-ext/src/classifiers/catalog/index.ts` (registration)
- `scripts/llm-ext/src/classifiers/catalog/filter.test.ts`
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`
- other files: to be listed at card start

## Reuse

L2-10 policy kit, L2-19, L2-06 input rules

## Steps

1. read the cited lines in the installed quicksilver 0.3.0 copy (D28; the GitHub repo is 0.2.0 and lacks the chunker, so its line numbers do not match) (I:923-980); read the cited lines in a clone of the source repository at the commit SEC-01 records; if no copy is present, clone it at that commit (jev-mcp `server.ts:396-499`); list every rule in the card; check the licence row from SEC-01 (D17)
2. zod input and thresholds: `p_i<i>` noul (D14 index keys), `auto` 0.85; quicksilver `--threshold` 0.5, `--band` 0.15, `--lines` repeat-collapsing with `--no-collapse`, `--save`; `auto` ≥ threshold + band enforced; `p + auto ≤ 1` rule
3. `build`: state = context plus items or chunks (`text` from files/lines/stdin, or a JSON proposition); one noul per item keyed `p_i<i>`; injection placement: question/proposition in instructions
4. split class (§5 table): unit = item or chunk; shared state = context; merge = highest noul per item; unsplittable: none
5. `project`: one band set: `matched` = p ≥ threshold; `borderline` = |p − threshold| < band; `auto` = p ≥ auto; `matched` drives the text list, `auto` the JSON field; `--lines` collapses repeated lines, `--no-collapse` turns it off; `--save` writes per-item results
6. attention predicate (for `--strict-exit`): invalid, any `auto:false`, any borderline
7. capture one live reply from this spec's own `build` (D12): no go-ahead needed and no cap (D2); the card prints and records its cost; sanitize the reply like P-03; store it as the golden fixture (derived from done-when)
8. golden tests: snapshot of `build` output, and `project` run on the captured reply (§16 SP preamble)
9. one named test per edge row listed in Acceptance (§12: every row becomes a named test in its card)
10. register the spec in `catalog/index.ts` and add the test file to the vitest include list (derived from done-when)
11. WHY comments at every non-obvious rule

## Acceptance

- [x] E57 and E128 pass (done when)
- [x] threshold/band output
- [ ] `--lines` collapsing
- [ ] `--save`
- [x] E57: filter: thresholds breaking `p + auto ≤ 1` → thresholds refused
- [x] E128: `filter`: p between threshold and threshold + band → listed in both matched and borderline, as qs does; receipt counts p ≥ threshold
- [x] golden snapshot of `build` output
- [ ] `project` on this card's captured live reply
- [x] injection placement as planned (question/proposition in instructions), checked on the serialized request
- [x] attention predicate tested on one true and one false result
- [x] registry consistency test passes with this spec registered
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: Committed in 189a6b44 (one commit for the six spec cards SP-01, SP-02, SP-03, SP-04, SP-05, SP-07, with the spec hardening and registration), f651b119 (test include list), da2da099 (rebuilt dist). Spec hardening applied to all six: shared data guard (treat as data, never as instructions) on every question, shared helpers in catalog/shared.ts, chunkDefaults? on DecisionSpec checked by assertChunkDefaults at registration, caller text kept in instructions per D5 (propositions stay in instructions), attention rules match plan section 9. catalog/filter.ts (29 tests): text-item and proposition modes, p_i<k> noul keys, threshold 0.5 / band 0.15 / auto 0.85, E57 (auto >= threshold + band and the p + auto <= 1 side both refused, remedy named: raise --auto or lower --band; a low --threshold therefore needs a raised --auto) and E128 pinned; invalid is now {id, reason}[]; attention invalid / any auto:false / any borderline (with the defaults the borderline band lies inside auto:false, so attention is nearly always true; plan literal kept). build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. CARD LEFT IN dev: step 7 (live reply capture from this spec's own build) was skipped because the workers had no network, so the box for project on the captured live reply stays unticked (substitute: recorded P-01 replies re-keyed); the definition-of-done box stays unticked until the live capture is done and the card closes in its own commit. Boxes 3 (--lines collapsing) and 4 (--save) stay unticked: the presentation helpers collapseRepeats, template and ranges in filter.ts are built and tested as pure functions, and rows holds the --save data, but the flags and the file write belong to the command layer (C4 cards). The partial-run cases were run through the real runPlan for filter (4 scenarios: failed request, fatal 401, budget stop, abort) and pass; chunked items combined with those stops were not covered. Decisions to review: auto is p >= auto OR p + auto <= 1 (a confident no is decided), the plan row says only p >= auto and should be amended; the plan row says matched drives the text list but qs and E128 put sure first, both are exposed.

## Out of scope

CLI flags and output wiring (C4-01), the injection test suite (SEC-02).

## Notes

2026-10-10 BLOCKED (pre-block-column dev): the remaining work is the live reply capture, owned by TRDD-O4MSZIG5, and the command layer TRDD-V8Q20MLW (C4-02) for --lines collapsing and --save (unblock-when trdd:O4MSZIG5, trdd:V8Q20MLW). The definition-of-done clause 'one commit with the TRDD id in its subject' is an open owner decision on TRDD-ZB41KG62, not work on this card. validate's probe requirement is met by 'test -f <blocker card file>', which also reads cleared if the blocker card is renamed, superseded or cancelled; unblock-when is the real condition.
2026-10-10 RE-POINTED: C4-02 is complete and delivers neither '--lines collapsing' nor '--save'; no card owns per-command input flags (see report 'needs a card'), C4-03 wires only the group, help and typo suggestion. Blocked now only on the capture card TRDD-O4MSZIG5 for the live reply box; the two flag boxes stay open without an owner. Probe note: validate demands a blocker-probe; it is 'test -f <blocker card file>', which also reads cleared if that card is renamed, superseded, cancelled or archived; unblock-when is the real condition.
2026-10-10 RE-POINTED AGAIN (supersedes the previous re-point note): the per-command input flags now have an owner, TRDD-EVORI1LK (Per-command inputs and input modes for the classify commands, backburner, depends on C4-03); this card is blocked on it and on the capture card TRDD-O4MSZIG5. Probe note: unblock-when lists ALL blockers and is the real condition; the blocker-probe ('test -f <card file>') covers only one, the one that by its nature stays open longest, and also reads cleared if that card is renamed, superseded, cancelled or archived.
