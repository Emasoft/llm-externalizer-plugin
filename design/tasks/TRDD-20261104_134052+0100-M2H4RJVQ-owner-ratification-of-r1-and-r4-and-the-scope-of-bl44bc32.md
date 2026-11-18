---
trdd-id: M2H4RJVQ
title: Owner ratification of R1 and R4 and the scope of BL44BC32
column: planned
status: tasked
created: 2026-11-04T13:40:52+0100
updated: 2026-11-18T15:44:08+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: user
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:44:08+0100
---

# Owner ratification of R1 and R4 and the scope of BL44BC32

Three coordinator readings await the owner (recorded on TRDD-ZB41KG62): R1 (2026-11-04 drain line: a commit body plus implementation-commits meets the commit-subject clause; six cards closed under it), R4 (2026-11-04T13:31: a throwing never-called seam is an assertion; a data-returning readStdin is read as category (a), assumed not measured; if rejected LMSYDGVB, AQ82IO1T, XHHH0N1E, DCI7C2Y7, BUL4EEBP and XZZ2NSWY return to blocked), and whether the index.test.ts spies of TRDD-BL44BC32 are in scope for TRDD-4Q1IVJOE before publish. No definition-of-done box of a card resting on R4 is ticked before this is answered.

## Approval log
2026-11-18T15:34:35+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): R1 ACCEPT: a commit body plus implementation-commits meets the commit-subject clause; history is never rewritten. R4 ACCEPT, both halves: the readStdin half is moot (S3QEQBYV complete, every readStdin site passes a real ended stream); a throwing never-called seam (extract.test.ts:539-540) is an injected sink that asserts non-use. BL44BC32 scope: OUT for 4Q1IVJOE (its commits add no spy; the index.test.ts spies blame 4bdd9b1b). Evidence: triage reports b1-blocked (4Q1IVJOE, XZZ2NSWY) and b3-review2 (M2H4RJVQ).
- 2026-11-18T15:44:08+0100 — APPROVED by main-agent@llm-externalizer-plugin (min-approval-requirement: user). ruled by the main agent under the 2026-11-18 USER delegation, see Approval log.

## Notes

2026-11-04T13:49:32+0100 disclosure: the superseded card TRDD-7X2BGHLH was created by main-agent at 13:36 with min-approval-requirement none, approved true and approval-judge main-agent (committed in cbb23d59); that was wrong for a decision reserved to the owner, and nothing was ratified. trddgrep refuses any write to an archived card, so this disclosure is recorded here.
2026-11-04T13:49:32+0100 alternative that makes R4 unnecessary for the six cards: replace each data-returning readStdin stub with real stdin (for example a child process with piped input), so no test depends on reading R4 permissively.
2026-11-04T13:55:00+0100 correction to the 13:49:32 alternative line: replacing data-returning readStdin stubs with real stdin removes only the readStdin half of R4 (a data-returning readStdin read as category (a)); the other half (a throwing never-called seam is an assertion) still needs the owner's ruling. Which of the six cards carry data-returning readStdin stubs is not measured: the known ones are in run-decision.test.ts, owned by BUL4EEBP, and the other five depend on them through shared files under R2. It is an option for the owner, offered instead of ratifying that half of R4.
2026-11-04T13:55:00+0100 the 13:49:32 disclosure also covers mandate true with mandated-by none on 7X2BGHLH (committed in cbb23d59): it asserted a grant nobody made.
2026-11-04T13:59:03+0100 cost of rejecting R1: the six cards closed under R1 (0G2IVEVU, SILI0HS8, N2TDAXL4, QFPC4Z8P, N1FQ8A8K, FPD1G0VB) are archived, and trddgrep refuses any write to an archived card, so a rejection means a new card that brings their commits in line with the commit-subject clause; the archived cards themselves cannot be reopened.
2026-11-04T14:04:32+0100 correction to the 13:59:03 line: a commit subject cannot change without rewriting git history, which is not done; rejecting R1 leaves the commit-subject clause unmet for those six closed cards for good. The remedy is the owner's choice: a waiver, or a new card that records the gap.
2026-11-04T14:04:32+0100 current state: BUL4EEBP, 4Q1IVJOE, XZZ2NSWY, XHHH0N1E, LMSYDGVB, DCI7C2Y7 and AQ82IO1T are already blocked on this card (commit 0a3e7c7c), each with a decision predicate that only a human clears. Approving this card alone unblocks nothing: record each answer as one line in the Approval log (ACCEPT or REJECT for R1, for R4, and for the BL44BC32 scope); each card's predicate is then cleared by hand for the answer that concerns it. A blame inventory of the R4-reliant test seams is in progress; converting them to real dependencies would make R4 unnecessary.
2026-11-04T14:12:18+0100 correction to the 14:04 current-state line: the owner answers in the conversation, one word per item (R1, R4, BL44BC32 scope); the agent records the answer here verbatim and clears the matching predicate. A decision predicate never clears on its own; it is cleared on the card once the owner has answered.
2026-11-04T14:12:18+0100 R4 is now optional: CONVERT (TRDD-S3QEQBYV) replaces every R4-reliant seam with a real stream; once it completes, only 4Q1IVJOE still waits here (BL44BC32 scope). Six cards no longer wait on this card.
2026-11-04T14:12:18+0100 correction to the 13:55 R2 sentence: under R2 each card owns the lines its own commits introduced (blame); BUL4EEBP (A1), XHHH0N1E (A4 A6 A10 A11) and 4Q1IVJOE (A2) own R4-reliant lines; LMSYDGVB, AQ82IO1T, DCI7C2Y7 and XZZ2NSWY own none.
2026-11-04T14:14:40+0100 the decision predicates committed in 0a3e7c7c contained spaces, which drift's grammar (^decision:\S+$) treats as malformed; that failed safe (cards stayed blocked); they are replaced by single-token predicates.
2026-11-04T14:14:40+0100 cards owning R4-reliant lines outside the seven blocked cards: MVT4DCHS, 17FAR6HF, BH78CSJO, APQ601NV, G168KDE1, LMS3JT0C (all backburner, not closed, on 2026-11-04) and V8Q20MLW (complete); if R4 is rejected without TRDD-S3QEQBYV, their test-doubles clause is unmet.
2026-11-04T14:27:17+0100 once the owner answers the BL44BC32 scope question, the agent removes M2H4RJVQ from 4Q1IVJOE's blocked-by together with its decision predicate: drift releases a blocked-by id only when that card reaches a done column, and this proposal may never reach one.
