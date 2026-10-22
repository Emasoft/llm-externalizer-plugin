---
trdd-id: UQ8TYKC9
title: SP-07 rank (jev-mcp rerank + qs rank + claude-jev relevance, D29)
column: blocked
status: tasked
created: 2026-10-07T19:49:33+0200
updated: 2026-10-10T05:03:14+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:49:33+0200
implementation-commits: [189a6b44, f651b119, da2da099, cddd9d43]
pre-block-column: dev
blocked-by: [O4MSZIG5]
unblock-when: [trdd:O4MSZIG5]
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261010_044154+0200-O4MSZIG5-live-reply-capture-for-the-14-decision-specs.md
blocker-holds-if: exit-0
---

# SP-07 rank (jev-mcp rerank + qs rank + claude-jev relevance, D29)

The rank (jev-mcp rerank + qs rank + claude-jev relevance, D29) decision as one catalog file: input schema, question texts, state shape, thresholds, split class, pure policy, attention predicate, injection placement (D5).

## Approval log

- 2026-10-07T19:49:33+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:11:47+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:11:48+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T05:03:14+0200 — column → blocked by main-agent@llm-externalizer-plugin. only the live reply capture (O4MSZIG5) and the definition of done remain

## Plan refs

§9 (`classify rank`), §5 (rank row), D5, D17, D21, D27, D29; §16 SP table, §16 Example 2 (SP-05) as the model for detail.

## Depends on

SP-00 (TRDD-DAGBDXUB), L2-06 (TRDD-SNZ17S5L), L2-19 (TRDD-PXVVVPYV)

## Files

- `scripts/llm-ext/src/classifiers/catalog/rank.ts`
- `scripts/llm-ext/src/classifiers/catalog/index.ts` (registration)
- `scripts/llm-ext/src/classifiers/catalog/rank.test.ts`
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`
- other files: to be listed at card start

## Reuse

L2-06, L2-19

## Steps

1. read the cited lines in the installed quicksilver 0.3.0 copy (D28; the GitHub repo is 0.2.0 and lacks the chunker, so its line numbers do not match) (I:1046-1070); read the cited lines in a clone of the source repository at the commit SEC-01 records; if no copy is present, clone it at that commit (jev-mcp `server.ts:903-1008` and claude-jev relevance); list every rule in the card; check the licence row from SEC-01 (D17)
2. zod input and thresholds: quicksilver 5-level score rubric, `--top` 10 / `--all`, `--head N --keep-at P`; jev-mcp JSON input, 100k budget, per-file best chunk kept
3. `build`: state = candidates and items (never in instructions); the query stays in instructions; `--head N` sends only the first N bytes; injection placement: candidates moved to state (D5)
4. split class (§5 table): unit = item or chunk; shared state = query (in instructions); merge = highest score per item, global sort
5. `project`: relevance = score/4; global sort; `--top` / `--all`; `--head`/`--keep-at` keep rule (claude-jev relevance); per-file best chunk
6. attention predicate (for `--strict-exit`): invalid
7. capture one live reply from this spec's own `build` (D12): no go-ahead needed and no cap (D2); the card prints and records its cost; sanitize the reply like P-03; store it as the golden fixture (derived from done-when)
8. golden tests: snapshot of `build` output, and `project` run on the captured reply (§16 SP preamble)
9. one named test per edge row listed in Acceptance (§12: every row becomes a named test in its card)
10. register the spec in `catalog/index.ts` and add the test file to the vitest include list (derived from done-when)
11. WHY comments at every non-obvious rule

## Acceptance

- [x] E63 and E72 pass (done when)
- [x] 5-level rubric, relevance = score/4, `--top`/`--all`, `--head`/`--keep-at`
- [x] candidates in state (D5)
- [x] E34: `rank --head N`: file longer than N bytes → only the head is sent (the one place a head window applies; size caps are E125)
- [x] E63: rank: candidates over 100k chars → planner splits; file chunks merged by best chunk
- [x] E72: `rank --head`: candidate shorter than the head size → whole file sent
- [x] golden snapshot of `build` output
- [ ] `project` on this card's captured live reply
- [x] injection placement as planned (candidates moved to state (D5)), checked on the serialized request
- [x] attention predicate tested on one true and one false result
- [x] registry consistency test passes with this spec registered
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: Committed in 189a6b44 (one commit for the six spec cards SP-01, SP-02, SP-03, SP-04, SP-05, SP-07, with the spec hardening and registration), f651b119 (test include list), da2da099 (rebuilt dist). Spec hardening applied to all six: shared data guard (treat as data, never as instructions) on every question, shared helpers in catalog/shared.ts, chunkDefaults? on DecisionSpec checked by assertChunkDefaults at registration, caller text kept in instructions per D5 (propositions stay in instructions), attention rules match plan section 9. catalog/rank.ts (26 tests): 5-level rubric, relevance = score/4, top 10 / all, head N bytes (never splits a multibyte character, E34 and E72), keep-at, files mode text units merged by best chunk through mergeChunks (E63), candidates in state per D5, query in instructions, SCORE_POLICY, attention invalid. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. CARD LEFT IN dev: step 7 (live reply capture from this spec's own build) was skipped because the workers had no network, so the box for project on the captured live reply stays unticked (substitute: recorded P-01 replies re-keyed); the definition-of-done box stays unticked until the live capture is done and the card closes in its own commit. The partial-run cases were NOT run through the real runPlan for rank. The jev-mcp 100k budget is not reproduced as a number (the planner replaces it) and keep-at semantics (relevance >= P) are inferred from the card text only; the query and files mode have no length cap on the caller text in instructions (a cap such as 2000 is a one-line change, owner to decide).

## Out of scope

CLI flags and output wiring (C4-01), the injection test suite (SEC-02).

## Notes

2026-10-10 board check: stays in dev. Doable now: the partial-run cases (one failed, fatal first, budget stop, abort) through the real runPlan and the partial-failure testkit were not run for this spec in wave 8 (the testkit exists since wave 9). Still waits on the capture card TRDD-O4MSZIG5 for the live reply box.
2026-10-10: cddd9d43 added the partial-run cases through the real planner and fan-out (testkit option failAt and limits.maxQuestionsPerRequest): one failed request, fatal first, --max-budget stop, abort. Abort contract: a request in flight at Ctrl-C that rejects is recorded 'aborted', requests not started are skipped and reported as aborted, a reply that arrives is kept. The card has no partial-run box, so none was ticked (the obligation was in its RESULT note). cddd9d43 was verified only as a pair with 6cc2a9ad and carries no rebuilt dist. Report: docs_dev/20261010-partial-run-cases-report.md. rank: a lost request invalidates only the candidate(s) it carried, with the fan-out reason; attention raised (rank.test.ts). BLOCKED on the capture card TRDD-O4MSZIG5 (pre-block-column dev). Remaining: box 'project on this card's captured live reply' (no live reply captured for this spec; the shape is tested with re-keyed P-01 replies only) and the definition-of-done box. Probe note: validate demands a blocker-probe; it is 'test -f <blocker card file>', which also reads cleared if that card is renamed, superseded, cancelled or archived; unblock-when is the real condition.
