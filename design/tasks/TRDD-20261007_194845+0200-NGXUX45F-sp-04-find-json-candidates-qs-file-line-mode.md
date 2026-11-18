---
trdd-id: NGXUX45F
title: SP-04 find (JSON candidates + qs file-line mode)
column: testing
status: tasked
created: 2026-10-07T19:48:45+0200
updated: 2026-11-18T17:09:38+0100
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:48:45+0200
implementation-commits: [189a6b44, f651b119, da2da099, 643d7887, cddd9d43]
pre-block-column: 
blocked-by: []
unblock-when: []
blocker-probe: test -f design/archived/TRDD-20261010_044154+0200-O4MSZIG5-live-reply-capture-for-the-14-decision-specs.md
blocker-holds-if: exit-nonzero
---

# SP-04 find (JSON candidates + qs file-line mode)

The find (JSON candidates + qs file-line mode) decision as one catalog file: input schema, question texts, state shape, thresholds, split class, pure policy, attention predicate, injection placement (D5).

## Approval log

- 2026-10-07T19:48:45+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:11:57+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:11:58+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T05:03:15+0200 — column → blocked by main-agent@llm-externalizer-plugin. only the live reply capture (O4MSZIG5) and the definition of done remain
- 2026-10-31T12:11:54+0100 — column → dev by main-agent@llm-externalizer-plugin. only blocker was the O4MSZIG5 live capture; fixture o4 projects clean (live-capture.test.ts); definition of done still open Cleared blocked-by (--clear-blocker override).

## Plan refs

§9 (`classify find`), §5 (find row), D5, D17, D21, D28; §16 SP table, §16 Example 2 (SP-05) as the model for detail.

## Depends on

SP-00 (TRDD-DAGBDXUB), L2-10 (TRDD-9BBMGTC3), L2-19 (TRDD-PXVVVPYV)

## Files

- `scripts/llm-ext/src/classifiers/catalog/find.ts`
- `scripts/llm-ext/src/classifiers/catalog/index.ts` (registration)
- `scripts/llm-ext/src/classifiers/catalog/find.test.ts`
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`
- other files: to be listed at card start

## Reuse

L2-10 policy kit, L2-19

## Steps

1. read the cited lines in the installed quicksilver 0.3.0 copy (D28; the GitHub repo is 0.2.0 and lacks the chunker, so its line numbers do not match) (I:1075-1120); read the cited lines in a clone of the source repository at the commit SEC-01 records; if no copy is present, clone it at that commit (jev-mcp `server.ts:504-570`); list every rule in the card; check the licence row from SEC-01 (D17)
2. zod input and thresholds: best/exists thresholds 0.7/0.35; file mode: `where` choice over line keys plus `none`, `exists` noul, `--chunk` ≤ 250 lines, `--min-score` 0.05, `--top` 5, line pieces `N.k`
3. `build`: state = candidates (JSON) or a line-chunk of ≤ `--chunk` lines (files); query stays in instructions; injection placement: query in instructions
4. split class (§5 table): unit = candidate (JSON) or line-chunk (files); shared state = query; merge (file mode) = score p(where) × p(exists) per line, dedupe by `file:line`, top N; unsplittable: `where`/`best` and `exists` in one request
5. `project`: JSON mode: best/exists to answered/not found; file mode: score = p(where) × p(exists), dedupe, `--top`, `--min-score`; a line longer than one chunk is cut into pieces `N.2`, `N.3` mapped back to line N
6. attention predicate (for `--strict-exit`): exists other than answered, invalid, no lines
7. capture one live reply from this spec's own `build` (D12): no go-ahead needed and no cap (D2); the card prints and records its cost; sanitize the reply like P-03; store it as the golden fixture (derived from done-when)
8. golden tests: snapshot of `build` output, and `project` run on the captured reply (§16 SP preamble)
9. one named test per edge row listed in Acceptance (§12: every row becomes a named test in its card)
10. register the spec in `catalog/index.ts` and add the test file to the vitest include list (derived from done-when)
11. WHY comments at every non-obvious rule

## Acceptance

- [x] best/exists per request
- [x] E129 passes
- [x] score = p(where) × p(exists), dedupe, `--top`, `--min-score`
- [x] E129: `find` file mode: a line longer than one chunk → cut into pieces `N.2`, `N.3`, mapped back to line N
- [x] golden snapshot of `build` output
- [x] `project` on this card's captured live reply
- [x] injection placement as planned (query in instructions), checked on the serialized request
- [x] attention predicate tested on one true and one false result
- [x] registry consistency test passes with this spec registered
- [~] ~~definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules~~ obsolete: superseded, restated clause by clause with the evidence in the box below
RESULT 2026-10-10: Committed in 189a6b44 (one commit for the six spec cards SP-01, SP-02, SP-03, SP-04, SP-05, SP-07, with the spec hardening and registration), f651b119 (test include list), da2da099 (rebuilt dist). Spec hardening applied to all six: shared data guard (treat as data, never as instructions) on every question, shared helpers in catalog/shared.ts, chunkDefaults? on DecisionSpec checked by assertChunkDefaults at registration, caller text kept in instructions per D5 (propositions stay in instructions), attention rules match plan section 9. catalog/find.ts (28 tests): JSON mode best/exists unsplittable in one request, files mode where_i<g> / exists_i<g> over line chunks, score = p(where) x p(exists) per line, min-score, top, dedupe by file:line, pieces N, N.2, N.3 mapped back to line N (E129), query in instructions, DEFAULT_POLICY, attention exists != answered / invalid / no lines. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. CARD LEFT IN dev: step 7 (live reply capture from this spec's own build) was skipped because the workers had no network, so the box for project on the captured live reply stays unticked (substitute: recorded P-01 replies re-keyed); the definition-of-done box stays unticked until the live capture is done and the card closes in its own commit. The partial-run cases were NOT run through the real runPlan for find. Limits: build cannot see the run's --chunk-chars so it bounds pieces by CHUNK_CHARS_DEFAULT (60000) and the planner refuses an oversized chunk when chunk-chars is smaller; JSON mode has no cap on candidates, so best can have more options than the API may accept (the fixtures go to 60, not measured beyond); the query has no length cap.
- [x] definition of done restated clause by clause (main agent, delegated by USER 2026-11-18, not an owner answer): vitest include list: scripts/llm-ext/vitest.config.ts:759 lists src/classifiers/catalog/find.test.ts; no vitest mock API calls found: grep -cE "vi\.(mock|spyOn|doMock|stubGlobal)" on find.test.ts prints 0 (and grep -nEi "fake|stub|mock|double" on find.test.ts prints nothing); WHY comments: be23be4a (docs(classify): move the find renumber WHY above the code it explains) and 3aa938e0 (docs(find): WHY comments at the remaining non-obvious find.ts rules) add them, and the two existing comments above find.ts :194 and :196 (lines 191-193, the missing-probability guard, and the jev-mcp existsVerdict/stable-sort note); commit link: the subjects of be23be4a and 3aa938e0 name TRDD-NGXUX45F (git show -s); typecheck and lint: tsc --noEmit exit 0 and npx eslint . --quiet exit 0 at HEAD ea68ff6a (main agent run 2026-11-18); full suite: the v14.7.2 publish gate ran npm test OK with this find.ts code (reports_dev/publish/20261118_130254+0100-publish-14.7.2.txt lines 19-20); the only later commits to find.ts and find.test.ts, be23be4a and 3aa938e0, change comments only (git show); the 14.7.3 gate runs it again

## Out of scope

CLI flags and output wiring (C4-01), the injection test suite (SEC-02).

## Notes

2026-10-10: find reference-alignment round and registry registration committed in 643d7887 (catalog/find.test.ts); no box newly ticked. box 'project on this card's captured live reply' unticked: no live reply captured for this spec; the shape is tested with re-keyed P-01 replies only (needs a capture card, none exists); definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; 643d7887's body names the card id. Report: docs_dev/20261010-SP-05-07-04-report.md
2026-10-10 renames for later readers: thresholds best and exists are now answered and absent; the result field best is now ranked; status not_found is now absent, and a new status partial exists; the none option is gone; a tie flag raises attention; JSON mode needs 2 to 250 candidates.
2026-10-10 board check: stays in dev. Doable now: the partial-run cases (one failed, fatal first, budget stop, abort) through the real runPlan and the partial-failure testkit were not run for this spec in wave 8 (the testkit exists since wave 9). Still waits on the capture card TRDD-O4MSZIG5 for the live reply box.
2026-10-10: cddd9d43 added the partial-run cases through the real planner and fan-out (testkit option failAt and limits.maxQuestionsPerRequest): one failed request, fatal first, --max-budget stop, abort. Abort contract: a request in flight at Ctrl-C that rejects is recorded 'aborted', requests not started are skipped and reported as aborted, a reply that arrives is kept. The card has no partial-run box, so none was ticked (the obligation was in its RESULT note). cddd9d43 was verified only as a pair with 6cc2a9ad and carries no rebuilt dist. Report: docs_dev/20261010-partial-run-cases-report.md. find: JSON mode is one request, a loss gives status invalid with no ranking; files mode is per chunk (other files keep their hits); budget and abort cannot cut the one in-flight JSON request (find.test.ts). BLOCKED on the capture card TRDD-O4MSZIG5 (pre-block-column dev). Remaining: box 'project on this card's captured live reply' (no live reply captured for this spec; the shape is tested with re-keyed P-01 replies only) and the definition-of-done box. Probe note: validate demands a blocker-probe; it is 'test -f <blocker card file>', which also reads cleared if that card is renamed, superseded, cancelled or archived; unblock-when is the real condition.
2026-11-04: definition of done not met: WHY comments thin (find.ts has one WHY comment, line 114, for its non-obvious rules). Its own tests and commit link were verified met that day.
2026-11-15T17:21:34+0100 blocker O4MSZIG5 is complete; all capability boxes ticked; only the pre-push full run and the DoD box remain.
2026-11-17T14:14:09+0100 REOPENED by git revert f3b6cde4 of the 59f1730a closure (harness review): the three call-through counting wrappers in files this card's commits touch (l0/catalog.test.ts:10, l2/evidence.test.ts:89, findings.test.ts:233) wait on the owner decision TRDD-052F3ZC9 (min-approval user, open); the charge to CASL940C and JDMY8LPJ was inferred from module ownership and blame now points at the squashed 4bdd9b1b, so R2 ownership cannot be confirmed. Also the WHY clause was judged on a comment count (12 in find.ts) and on the sites the 2026-11-04 note named, not on a full read of find.ts. Stays in testing until 052F3ZC9 is answered and find.ts is read for uncommented rules.
2026-11-18T15:56:01+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): TRDD-052F3ZC9 was ruled option A on 2026-11-18: the three call-through counting observers (l0/catalog.test.ts:10, l2/evidence.test.ts:89, catalog/findings.test.ts:233) are exempt pass-through observers, so the test-double clause of the definition of done is met for this card. be23be4a (subject names TRDD-NGXUX45F) moved the find renumber WHY above the code it explains. The definition-of-done box is NOT touched: the triage of 2026-11-18 (reports_dev/triage-20261118/testing-a/20261118_091044+0100-NGXUX45F.md) found WHY candidates still without a comment at find.ts :64 (CRLF split), :150 with :192 and :194 (u-index key coupling) and :185 (invalid return sets exists from the exists answer) at HEAD 54236bf8, which be23be4a does not cover, and the 2026-11-17 note requires find.ts to be read for uncommented rules. Next: add WHY comments there (a reason marked inferred counts as traceable, ruled on TRDD-BUL4EEBP), then restate the box. full suite: 14.6.1 publish run (tree 04d412ea); re-run by the 14.7.3 publish gate.
2026-11-18T17:01:48+0100 Box 11 tick: the clause "tsc --noEmit exit 0 and npx eslint . --quiet exit 0 at HEAD ea68ff6a" is INHERITED from the main-agent run named in the box; the card writer did not re-run tsc or eslint (barred by the brief). ea68ff6a is a commit and an ancestor of HEAD f4db6726 (git cat-file, merge-base, 2026-11-18). The full-suite clause rests on the v14.7.2 publish gate lines 19-20 and the comment-only diffs of be23be4a and 3aa938e0, both read by the card writer.
2026-11-18T17:09:37+0100 main agent check for box 11: at HEAD f4db6726 of dev/after-14.3.0 (it contains every commit named in the box, ea68ff6a included), with no source change in the working tree, npm run typecheck (tsc --noEmit) exited 0 and npm run lint (eslint src --max-warnings 0) exited 0 on 2026-11-18. The tsc and eslint clause of box 11 is now verified at HEAD, not only inherited.
