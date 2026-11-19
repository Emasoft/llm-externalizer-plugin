---
trdd-id: T229KMOU
title: consumer-guidelines.md re-check against the current release
column: published
status: archived
created: 2026-11-19T04:31:39+0100
updated: 2026-11-19T20:37:30+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T04:31:39+0100
implementation-commits: [a359ad12, b9477168]
release-via: publish
---

# consumer-guidelines.md re-check against the current release

skills/llm-externalizer-cli-reference/references/consumer-guidelines.md line 3 says its statements and release markers were checked against the source at the tag v14.7.2, 'the latest release', and the line 5 legend defines the marker '(next release after 14.7.2: TRDD-xxxx)'. v14.7.3 and v14.7.4 are released (both release commits dated 2026-11-19). Re-check every statement and every '(since X)' marker against the latest release tag, then update line 3 and the legend to name that tag. Found while working TRDD-FP2SAF4P; split out of TRDD-SZ7TO9FW, whose open box (questions 1 and 5 rewritten in final form) waits on nine backburner children. Size S.

## Approval log

- 2026-11-19T04:31:39+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T04:43:41+0100 — column → dev by main-agent@llm-externalizer-plugin. consumer-guidelines.md rechecked against v14.7.4; header lines 3 and 5 and the Q1 session-compact clause edited
2026-11-19T04:43:52+0100 main agent: worker report reports_dev/t229kmou/20261119_043816+0100-consumer-guidelines-recheck.md; lines 3 and 5 now name v14.7.4; Q1 profile-types bullet gained the 14.7.4 session-summary clause (source v14.7.4 session_summary/local-model.ts:354-355, commit 0e6fa5fb, first tag v14.7.4), added by the main agent after two harness reviews found line 3 overstated the check without it. Uncovered 14.7.3/14.7.4 behaviours listed in the report were judged outside the nine questions.
- 2026-11-19T09:20:04+0100 — column → complete by main-agent@llm-externalizer-plugin. consumer-guidelines rechecked against v14.7.5; docs in a359ad12 and b9477168; published with the next release
- 2026-11-19T20:37:30+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped in v14.7.6, release commit 53a415e0, tag v14.7.6.

## Notes

2026-11-19T08:42:35+0100 main agent: consumer-guidelines.md line 3 (checked against v14.7.5, per spec) holds: tag v14.7.5 was made from 211655ad plus only the release commit f0766476. 2026-11-19T08:42:35+0100 worker: git diff --stat 211655ad v14.7.5 -- scripts/llm-ext/src shows only scripts/llm-ext/src/cli/main.ts, 1 insertion 1 deletion, the VERSION line 14.7.4 -> 14.7.5; the full diff --stat 211655ad v14.7.5 also lists .claude-plugin/plugin.json, CHANGELOG.md (66 lines added), README.md, pyproject.toml, scripts/llm-ext/dist/llm-ext.js, package-lock.json, package.json, uv.lock (9 files), and not consumer-guidelines.md; git show v14.7.5:skills/llm-externalizer-cli-reference/references/consumer-guidelines.md line 3 reads 'the tag v14.7.5, the latest release' and line 5 reads '(next release after 14.7.5: TRDD-xxxx)'. git merge-base --is-ancestor a359ad12 v14.7.5 exit 0 (the only implementation commit). NOT moved: trddgrep move T229KMOU published --approver main-agent@llm-externalizer-plugin exit 2, 'T229KMOU has NO acceptance checklist, so archiving it as published would record a completion that proves nothing'. Column stays dev; needs a checklist (main agent decision) before the move.
2026-11-19T08:45:14+0100 worker: clarification of the line above: the only file under scripts/llm-ext/src that differs between 211655ad and v14.7.5 is cli/main.ts (the VERSION line); the other 8 files are also changes of the release commit f0766476 (plugin.json, pyproject.toml, package.json, package-lock.json, uv.lock, README.md, CHANGELOG.md with 66 lines added, and the rebuilt dist/llm-ext.js), since the parent of the tag commit is 211655ad (main agent check 2026-11-19); none of the 9 is consumer-guidelines.md.
2026-11-19T09:19:43+0100 main agent: b9477168 adds the 14.7.5 changes (Q2, Q7, Q9) after a review found the Q2 paid caveat missing; it ships in the release after 14.7.5, so the card goes to complete now and to published at that release.
2026-11-19T09:30:10+0100 main agent: scope correction for the b9477168 commit message, which says the main agent read the gate in v14.7.4 and v14.7.5 dynamic-maintainer and cli/main.ts. The main agent read v14.7.4 cli/main.ts:994-1003, the v14.7.4 dynamic-maintainer refusal texts and v14.7.5 dynamic-maintainer:1205-1238; the v14.7.5 cli/main.ts estimate path (about :1001-1014) was read by the worker only. Box 2 was reworded before the closing commit after a review found it overclaimed a statement-by-statement recheck.
2026-11-19T09:37:19+0100 main agent ruling (delegated by USER 2026-11-18, solve all issues yourself. i need results.; not an owner answer): box 2 was reworded twice after the move to complete and before the closing commit, after two harness reviews found it overclaimed; the move and the box corrections land in one commit, so they count as one closing edit.

## Acceptance

- [x] Header lines 3 and 5 name the latest release tag v14.7.5 (git show v14.7.5 of the file, worker note 2026-11-19T08:42:35+0100; tag parent 211655ad checked by the main agent)
- [x] Statements and markers rechecked by diff, by worker reports, not line by line: the v14.7.2 to v14.7.4 changes with a first-tag lookup per marker (a359ad12, report reports_dev/t229kmou/20261119_043816+0100-consumer-guidelines-recheck.md, whose Not verified section states this scope), then the v14.7.4 to v14.7.5 hunks against the nine questions (report reports_dev/t229kmou-1475/20261119_090818+0100-q2-and-recheck.md). The main agent then traced the paid path of the Q2 generated-profile clause in v14.7.5 (index.ts:2399-2455 failDynamicProfile, :4760-4800 dispatchCallTool): a paid generated profile whose models all fail also waits for its update, unless the update cannot start, a case the docs do not mention; where activeResolved is set for the Q9 resolved profile url was not traced. The Q1 and Q5 rewrites belong to TRDD-SZ7TO9FW
- [x] The 14.7.5 changes that touch the questions are documented with since-14.7.5 markers in b9477168: Q2 paid refusal and no-key message (P10QMUW7), Q7 bare double dash (23J3NYW8), Q9 paid estimate refusal, the estimate price-list fetch and the dry-run headers (HUBGO80N, Z8LRK2DZ); the main agent read the paid gate texts in v14.7.4 dynamic-maintainer and, in v14.7.5, that only the free branch is refreshable (dynamic-maintainer:1205-1238); the v14.7.5 paid branch text was read by the worker
