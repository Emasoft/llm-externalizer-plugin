---
trdd-id: KNSQAQ1S
title: Classifier tests replace forbidden test doubles with real inputs
column: blocked
status: tasked
created: 2026-11-04T10:08:11+0100
updated: 2026-11-18T15:35:11+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T10:08:11+0100
implementation-commits: [3140eaaf, aaf521c2, a3beab9f, 46a6bf84, 79a4bf0d, ddf17705]
blocked-by: [052F3ZC9]
pre-block-column: dev
unblock-when: [decision:owner-answers-three-test-doubles-in-052F3ZC9]
blocker-probe: grep -c OWNER.ANSWER design/proposals/TRDD-20261104_223020+0100-052F3ZC9-owner-decision-on-three-test-doubles-with-no-observable.md
blocker-holds-if: not-match:^([4-9]|[1-9][0-9]+)$
---

# Classifier tests replace forbidden test doubles with real inputs

The 2026-11-04 definition-of-done drain found test doubles outside the 2026-10-31 PERMISSIVE ruling (GlobalFetch seam plus categories a, b, c on TRDD-ZB41KG62). Verifier-reported sites, to be confirmed at card start: hand-built settings or Profile objects at input-args.test.ts:76, definitions-classify.test.ts:153, run-decision.test.ts:57, :72-76, :470 and :534, extract.test.ts:78, findings.test.ts:390-391; vi.mock of node:fs at l0/catalog.test.ts:10; vi.spyOn of JSON.stringify at l2/evidence.test.ts:89; a throwing readFile stub at run-decision.test.ts:198, :405 and :494. Precedent fix 441ce3fa: a real settings.yaml in a temp dir read by loadSettings. Holds the definition-of-done box of LMSYDGVB, DCI7C2Y7, AQ82IO1T, XHHH0N1E, 4Q1IVJOE, BUL4EEBP, XZZ2NSWY and OHLMZONY. Each fix commit names the card ids it serves in its subject. Several of these files sit next to other sessions' uncommitted edits (cli/main.ts, config.ts, tools/definitions.ts): rerun the gate after the fix and say what it measured.

## Approval log

- 2026-11-04T10:08:11+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-04T12:54:14+0100 — column → dev by main-agent@llm-externalizer-plugin. pulled after the S5KOOT2S checks; one worker confirms each listed site and fixes it with real inputs
- 2026-11-04T22:30:38+0100 — column → blocked. waits on the owner decision for three test doubles with no observable, TRDD-052F3ZC9

## STATE

2026-11-04: 11 of the 13 listed sites fixed with real inputs in five commits (3140eaaf input-args, aaf521c2 definitions-classify, a3beab9f run-decision, 46a6bf84 extract, 79a4bf0d findings); the main agent re-ran the five touched test files plus evidence.test.ts at HEAD (255/255 over the six) and tsc (exit 0); loadSettings reads settings.yaml fresh on every call (config.ts loadSettings), so the per-call helpers are not order-dependent. Report reports_dev/knsqaq1s/20261104_130117+0100-test-doubles.md.
Left, decision for the user (the user’s standing rule allows a double only when nothing else is possible, the ZB41KG62 ruling forbids every double outside three categories, and these two sites fall between the two rules): l0/catalog.test.ts:10 vi.mock of node:fs (it counts cache reads, which have no observable without a seam) and l2/evidence.test.ts:89 vi.spyOn of JSON.stringify. The worker’s evidence replacement used a 1 GB input whose RangeError guard catches only a stringify of the whole input, not the 400-character bound, so it was not committed: it is kept as git stash "TRDD-KNSQAQ1S evidence.test.ts attempt" and as reports_dev/knsqaq1s/20261104_130458+0100-evidence-test-attempt.diff. Options for both: drop the count or bound assertion and rely on the WHY comment at the production site, or add a production seam (an injected reader or estimator), which is itself a double of no ruling category.
Reported, not fixed (outside the card’s list): findings.test.ts:233 vi.spyOn of String.prototype.split; definitions-classify.test.ts:22-25 parserDeps with a settings {} literal and throwing readFile and readStdin. The empty-profiles literals of run-decision.test.ts (old lines 470 and 534) were changed although arguably allowed. NEXT: rerun the definition-of-done gate over the seven files and say what it measured (cli/main.ts, config.ts and tools/definitions.ts carry another session’s uncommitted edits); judge each of the eight blocked cards on its own; the card stays in dev until the two left sites are decided.
2026-11-04T13:31:30+0100 doubles found after the lists: extract.test.ts:536-537 is an assertion of non-use under R4 (ZB41KG62), not a forbidden double (read 2026-11-04; the drain verifier verdict is withdrawn); index.test.ts:1105 spyOn dynamicProfileGate and :1866, :2119 spyOn globalThis.fetch are pre-existing, owned by no classifier card under R2, and moved to their own card (step 5).
2026-11-04T13:31:30+0100 definitions-classify.test.ts:22 (settings {} literal) and :24 (throwing readFile) are forbidden under R4; :25 (throwing readStdin) is allowed under R4. Under R2 the site is owned by BUL4EEBP (blame: parserDeps and all its call sites come from 6cc2a9ad; 6cc2a9ad and 3c3db86f are in BUL4EEBP implementation-commits), so it blocks only BUL4EEBP.
2026-11-04T13:31:30+0100 the settings path is resolved per call because config.ts:1131 loadSettings reads the file on every call (code read), not because tests pass.
2026-11-04T13:31:30+0100 NEXT ACTION: fix definitions-classify.test.ts:22 (real settings.yaml via loadSettings) and :24 (real readFileSync); then BUL4EEBP and OHLMZONY (:233) are the only cards still blocked here.
2026-11-04T13:36:11+0100 SUPERSEDED 2026-11-04T13:31 by the R2/R4 lines above; the four 13:22:52 lines below were replaced in place before any commit and are kept here verbatim:
- 2026-11-04T13:22:52+0100 two forbidden doubles not on this card's lists: scripts/llm-ext/src/classifiers/catalog/extract.test.ts:536-537 hostile fake {spawn, timeoutMs} cast as never (1111c2f6; blocks XZZ2NSWY and 4Q1IVJOE; drain verifier: a real worker spawn can be produced); scripts/llm-ext/src/index.test.ts:1105 spyOn dynamicProfileGate, :1866 and :2119 spyOn globalThis.fetch (pre-existing; user decision whether in scope for 4Q1IVJOE).
- 2026-11-04T13:22:52+0100 definitions-classify.test.ts:22-25: the settings {} literal and the throwing readFile are forbidden (real settings.yaml through loadSettings and real readFileSync are possible); the throwing readStdin is (c) like classify-launch.test.ts:164. Fixing :22 and :24 unblocks LMSYDGVB, AQ82IO1T and XHHH0N1E and is one of BUL4EEBP's and 4Q1IVJOE's open sites.
- 2026-11-04T13:22:52+0100 per-test temp dirs passing in the five fixed files show the settings path is resolved per call (config.ts loadSettings reads the file on every call).
- 2026-11-04T13:22:52+0100 NEXT ACTION: fix definitions-classify.test.ts:22,24 and extract.test.ts:536-537, then rerun the eight blocked cards' judgment.
2026-11-04T13:39:36+0100 ddf17705 fixed definitions-classify.test.ts:22 (real settings.yaml through loadSettings) and :24 (real readFileSync); vitest on the file 18/18, tsc 0, eslint 0. NEXT ACTION: OHLMZONY findings.test.ts:233 (spyOn String.prototype.split) is the last open site; then the headcheck result is written back onto the testing cards.
2026-11-04T13:43:03+0100 a temporary detached worktree of 23f40c1e (node_modules symlinked from the main tree) holds the headcheck build; remove it after its logs are read.
2026-11-04T13:39:57+0100 trddgrep facts (measured on a scratch copy): edit does not bump updated; set with an empty value does leave a trailing space.
2026-11-04T13:41:31+0100 the owner decision card is now TRDD-M2H4RJVQ (7X2BGHLH superseded).
2026-11-04T13:43:03+0100 the defs-trace of ddf17705: no config-dir access, shown by the code trace (every argv returns at run-decision.ts:547-550 or the unknown-option return, before runDecision at :570; worker trace, not re-read by the main agent); the empty-dir run confirms no writes only.
2026-11-04T13:43:03+0100 NEXT ACTION (supersedes the 13:39 NEXT ACTION): OHLMZONY findings.test.ts:233; a full suite at a HEAD that includes ddf17705 and cbb23d59; and a committed dist rebuilt from HEAD (the committed dist is stale: built-CLI tests read it, so full npm test green is unreachable until it is rebuilt and committed; the main tree dist carries another session uncommitted rebuild, so it cannot be committed from there). trddgrep defects measured: edit does not bump updated; set with an empty value leaves a trailing space.
2026-11-04T13:49:32+0100 rerun at 23f40c1e on a fresh build (same worktree, node_modules symlinked): the four files that failed in the headcheck (stop-on-errors, classify-launch-cli, classify-review-cli, profile-help-visibility) passed 64/64, so the 20 headcheck failures came from the stale committed dist. The broker/governor run is still in progress.
2026-11-04T13:49:32+0100 tree qualifier for the 13:39:36 line: that 18/18 run used the main tree, which carries another session's uncommitted edits to config.ts and tools/definitions.ts; the full suite at a HEAD including ddf17705 is the check that covers it.
2026-11-04T22:15+0100 Stage 1 of the full suite passed at ebeab4fd, which includes ddf17705 and cbb23d59 (merge-base --is-ancestor, measured 21:52); tsc exit 0; the two stage-2 failures are governor tests, not in this card's files. The npm test call as a whole exited 1 (TRDD-YGF9YXF2, report reports_dev/ygf9yxf2/20261104_220707+0100-ci3-suite.md); the run used a dist built at 62e2c030 that matches ebeab4fd source, the committed dist is stale (TRDD-6XMCY4ZE).
2026-11-04T22:15+0100 the owner decision for the test-double sites l0/catalog.test.ts:10 (vi.mock of node:fs) and l2/evidence.test.ts:89 (vi.spyOn of JSON.stringify) lives only on this card; no proposal card exists for it (TRDD-M2H4RJVQ covers R1, R4 and the index.test.ts spies, not these sites). findings.test.ts:233 (counting wrapper on String.prototype.split, no observable without a seam) is the same class and joins that decision, with the same options as in the Left line above (drop the count or bound assertion and rely on the WHY comment at the production site, or add a production seam).
2026-11-04T22:15+0100 NEXT ACTION (supersedes the 13:43:03 NEXT ACTION): (1) the user decides catalog.test.ts:10, evidence.test.ts:89 and findings.test.ts:233 together; (2) the full-suite item stays open until TRDD-YGF9YXF2 has one green npm test (stage 1 passed at ebeab4fd; whether the failing governor tests depend on files this card touched is unverified); (3) the committed dist rebuild stays with TRDD-6XMCY4ZE. The card is blocked on TRDD-052F3ZC9 until the three sites are decided.
2026-11-04T22:31+0100 correction to the 22:15+0100 line: the claim that no proposal card exists was a grep-negative (trddgrep text searches; the archived hit JDMY8LPJ was not read at the time); now read, JDMY8LPJ records no owner decision for any of the three sites. It is superseded by TRDD-052F3ZC9, the owner decision card minted for catalog.test.ts:10, evidence.test.ts:89 and findings.test.ts:233; this card is blocked on it (unblock-when decision predicate, cleared by hand once the owner answers).
2026-11-04T22:31+0100 correction to the 22:15+0100 line: the statement that TRDD-M2H4RJVQ covers R1, R4 and the index.test.ts spies and not these sites is inferred from M2H4RJVQ text (it names R1, R4 and the BL44BC32 scope), not verified.
2026-11-04T22:31+0100 correction: the lines dated 2026-11-04T22:15+0100 were written between 22:12 and 22:13, not at 22:15.
2026-11-05T01:44+0100 the full-suite item (2) of the 22:15 NEXT ACTION is met: run 4b at c668389e, one npm test, exit 0 (TRDD-YGF9YXF2, archived). The seven cards once blocked on YGF9YXF2 do not wait on this card: BUL4EEBP, XHHH0N1E, LMSYDGVB, DCI7C2Y7, AQ82IO1T restored to testing; 4Q1IVJOE and XZZ2NSWY re-pointed to TRDD-M2H4RJVQ. This card stays blocked on TRDD-052F3ZC9.
2026-11-05T01:55+0100 the 01:44 line supersedes the 13:31 NEXT ACTION for the seven cards; BUL4EEBP is no longer blocked here.
2026-11-18T15:35:11+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): TRDD-052F3ZC9 was ruled option A for all three sites (l0/catalog.test.ts:10, l2/evidence.test.ts:89, catalog/findings.test.ts:233): kept as pass-through observers (call the real function, return its result unchanged, assert only a count or length), no code change. With that, 11 of 13 sites are fixed (3140eaaf, aaf521c2, a3beab9f, 46a6bf84, 79a4bf0d, ddf17705) and the other three are exempted, so no listed site is open. The blocker-probe (counts OWNER.ANSWER lines in the 052F3ZC9 file) will not reach 4 because the ruling is an agent ruling, not an owner answer; blocked-by and the decision predicate are cleared by the main agent when moving the card. This card has no acceptance boxes, so none was ticked. Evidence: triage report b1-blocked (KNSQAQ1S), 052F3ZC9 Approval log.
