---
trdd-id: S3QEQBYV
title: Classify tests read stdin from a real stream so R4 is unnecessary
column: complete
status: archived
created: 2026-11-04T14:11:25+0100
updated: 2026-11-04T16:44:22+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T14:11:25+0100
implementation-commits: [085e9eeb, 9fec6c04, 898c51e3, bc9d1157, 5586d0c1, 0de251d8, 50a6ba91, 0bb339cd, c259ca52, 1065b047, 2b1006ff, 5461497d, 7db335c5, 4a94ff0a, d5335100]
---

# Classify tests read stdin from a real stream so R4 is unnecessary

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-04
- Column complete. Committed: readAllFrom (9fec6c04, tests 898c51e3 and bc9d1157); B1 and A9 receipt.test.ts (085e9eeb, 5586d0c1); A1 definitions-classify.test.ts (0de251d8); A2 classify-launch.test.ts (50a6ba91); A3 review-fixes.test.ts (c259ca52); A4 and A6 input-args.test.ts (2b1006ff); A5, A7 and A8 input-args-document.test.ts (5461497d); A10 to A12 run-decision.test.ts (4a94ff0a); review nits and comment fixes (0bb339cd, 1065b047, 7db335c5, d5335100).
- Remaining: none. Optional follow-up, not carded: the stdinBytes, unreadStreams and unreadStdin helpers and the afterEach guard are copied in three test files (input-args, input-args-document, run-decision); one shared test helper next to src/cli/read-all.ts would remove the copies.
- Never-called sites (A1 to A6, A10 and A11): probe first whether production reads stdin. Each test, or a per-test factory, makes one ENDED PassThrough holding at least one byte; readStdin reads it through readAllFrom; after the outcome assertions the test asserts readableDidRead === false; one run per stream. If production reads stdin, make the test stop before stdin honestly (as A1: --input with a missing file plus the ENOENT message). Mutation-check one test. Two accepted shapes: an explicit neverRead in each test (A1 to A3), or a module-level registry filled by unreadStdin and checked in a top-level afterEach after cleanup (the files of A4 to A8 and A10 to A12; tests run one at a time).
- Data sites (A6 to A12; A6 also held one never-called double): readStdin builds a fresh ENDED PassThrough with the bytes inside the closure, so no stream is shared across runs (an ended stream is read once). Nothing is asserted on that stream.
- Clean check per conversion: git archive of an explicit recorded SHA, node_modules symlinked to the main tree, the edited test copied in, then vitest on the file and tsc --noEmit. Deps and the vitest cache are shared with the main tree; a fresh-install check belongs to TRDD-S5KOOT2S.
- Findings: the throwing double was a hole only in A1, where production read stdin on 47 of the 50 flag and threshold runs and swallowed the throw (A1 report reports_dev/s3qeqbyv/20261104_150852+0100-a1.md). Elsewhere the outcome assertions would have caught a swallowed or discarded read wherever production reaches stdin (A3 on the runFindings path only; A4 10 tests; A5 5 of 8, the other 3 refuse before reaching stdin; A10 and A12 10 tests, which are 6 of the 7 io data tests and all 4 dry tests). The guard adds detection of a read that leaves the outcome unchanged (A3 mutation 2, A4 mutation 1, A5 mutation 1, A10 and A11 mutation a, 8 of 8 guarded sites). In run-decision the 8 never-called sites used to return fixed bytes silently, so an extra production read there was undetectable until the guard. A6 split into 3 data sites plus 1 never-called site; A7 and A8 are six data doubles, each called once. The non-JSON stdin test still passes when the read is discarded, because an empty read also yields "cannot read the JSON input from stdin" (inferred from the test's assertion, which only matches that message; not run). This is a known weak test: it cannot tell a read of "not json" from a read of nothing; not fixed here.
- Superseded: the body protocol line; the 15:22:34 claim about the --input flag argv; the claim that A9 calls run() three times; the 15:05:58 wording about a HEAD export.
- Open: no spawned-CLI stdin test, tracked as TRDD-XM2OSVC0. R4 on TRDD-M2H4RJVQ stays an owner item; the agent findings only make it moot per site.

## Goal

R4 (readStdin and readFile test doubles allowed) becomes unnecessary when every classify test reads stdin from a real stream.

Production change: extract readAllFrom(stream) from readAllStdin (scripts/llm-ext/src/cli/main.ts:732-739; keep the TTY refusal in the process.stdin wrapper). Another session has an uncommitted hunk at main.ts:457-467, so stage only this hunk (git diff > patch, git apply --cached, check git diff --cached).

Sites:

- B1 receipt.test.ts:64 readFile becomes readFileSync (ship first)
- A1 definitions-classify.test.ts:37
- A2 classify-launch.test.ts:163-164 (fix the :3 and :163 comments that claim the launcher has no stdin seam and that classify-launch-cli pipes stdin: it does not)
- A3 review-fixes.test.ts noStdin
- A4 and A6 input-args.test.ts
- A5, A7 and A8 input-args-document.test.ts
- A9 receipt.test.ts:65
- A10, A11, A12 run-decision.test.ts:206, :413, :502

Data-returning stdin: a real stream with bytes, ended. Never-called stdin: a real unended PassThrough; assert readableDidRead false and readableLength unchanged. Each file: single-file vitest, then tsc --noEmit and eslint . --quiet. (Superseded by the Notes line Conversion protocol for A1-A12 of 2026-11-04T14:54:17+0100, which splits by site kind; that line is current.)

## Acceptance

- [x] production readAllFrom(stream) extracted to src/cli/read-all.ts and wired into main.ts readAllStdin; only this session's hunks staged; tsc and eslint clean
- [x] receipt.test.ts (B1, A9) converted, single-file vitest green
- [x] definitions-classify.test.ts (A1) converted, single-file vitest green
- [x] classify-launch.test.ts (A2) converted and its :3 and :163 comments corrected, single-file vitest green
- [x] review-fixes.test.ts (A3) converted, single-file vitest green
- [x] input-args.test.ts (A4, A6) converted, single-file vitest green
- [x] input-args-document.test.ts (A5, A7, A8) converted, single-file vitest green
- [x] run-decision.test.ts (A10, A11, A12) converted, single-file vitest green
- [x] no readStdin or readFile double left in the classify tests (grep)
- [x] readAllFrom lives in scripts/llm-ext/src/cli/read-all.ts, main.ts imports it, readAllStdin is a two-line wrapper, only this session's hunks staged (git diff --cached -- main.ts)
- [x] tsc --noEmit and the touched single-file tests green in a fresh worktree at the final commit
- [x] commit subjects cite TRDD-S3QEQBYV and implementation-commits is filled

## Notes
2026-11-04T14:14:25+0100 production change goes in a new module scripts/llm-ext/src/cli/read-all.ts exporting readAllFrom(stream), imported by main.ts, so readAllStdin becomes a two-line wrapper (TTY refusal kept) and tests never import main.ts. This corrects the Goal wording that extracts it inside main.ts.
2026-11-04T14:14:25+0100 patch rule: the patch must contain only the readAllStdin hunk, cut from git diff -U3 -- scripts/llm-ext/src/cli/main.ts with fastedit on the patch file; check with git diff --cached -- scripts/llm-ext/src/cli/main.ts that only that hunk is staged (the other session's main.ts:457-467 hunk must stay unstaged).
2026-11-04T14:14:25+0100 after committing, run tsc --noEmit and the touched single-file tests in a fresh worktree at that commit, because the main tree carries another session's uncommitted edits.
2026-11-04T14:14:25+0100 why a PassThrough is not a double: it is the production reader on a real stream, and only the source is injected (category (c) signal source, or (a): the test process stdin cannot be produced).
2026-11-04T14:14:25+0100 cards owning R4-reliant lines (read with trddgrep show 2026-11-04): MVT4DCHS backburner, 17FAR6HF backburner, BH78CSJO backburner, APQ601NV backburner, G168KDE1 backburner, LMS3JT0C backburner, V8Q20MLW complete; CONVERT makes their lines strictly compliant.
2026-11-04T14:27:17+0100 the blocker-probe fields on the cards blocked on this card and on TRDD-YGF9YXF2 are decoration: drift never runs probes, and the paths go stale when a blocker is archived.
2026-11-04T14:27:17+0100 LMSYDGVB, AQ82IO1T, DCI7C2Y7 and XZZ2NSWY own no R4 site; they wait on this card only through TRDD-YGF9YXF2 (npt), an accepted trade of one full suite run instead of two.
2026-11-04T14:27:17+0100 MVT4DCHS, 17FAR6HF, BH78CSJO, APQ601NV, G168KDE1 and LMS3JT0C are in backburner although their commits landed; each needs a per-card judgment (done but not moved, or partial), not a bulk sweep.
2026-11-04T14:54:17+0100 B1 closure for deps.readFile: its only call is run-decision.ts:547, behind --input, so the receipt.test.ts argv (--profile c, plus --json or --estimate) never reaches it. The main agent read :536-552 and grepped run-decision.ts; that inputFile is set only at :501, the cross-module trace and the profile seam (deps.settings) come from a worker trace, not re-read. The path does read real files, though not through deps.readFile: catalog.json (l0/catalog.ts:112-113) and history.log (usage-history.ts:423), both under the test temp dirs, each behind a catch that swallows errors (catalog.ts:116, receipt.ts:13); not a hazard. This closes point 3 of the 7b06c8c7 review for deps.readFile.
2026-11-04T14:54:17+0100 Step 2 landed. 9fec6c04 adds readAllFrom(stream) in src/cli/read-all.ts; main.ts readAllStdin keeps the TTY refusal and wraps it. 898c51e3 adds a multi-chunk test that fails when the loop keeps only the first chunk (mutation-checked). bc9d1157 measures the never-called premise in the conversion form (ended stream, negative and positive control). This is the real byte-collection loop below the deps seam, not real stdin: tests still inject ArgvDeps.readStdin. The card is in dev; it moves toward complete only when A1-A12 are converted.
2026-11-04T14:54:17+0100 Conversion protocol for A1-A12 (premise measured by bc9d1157), split by site kind. Data sites (A6-A12, including A9; readStdinOnce calls the closure at most once per run): readStdin builds a fresh ENDED PassThrough holding the bytes inside the closure, one per call (readStdinOnce memoizes within one run, run-decision.ts:454-458); nothing is asserted on that stream. Never-called sites (A1-A5): the test body creates one ENDED PassThrough with at least one byte (never at describe scope), the readStdin closure captures it, the code runs to completion, then the test asserts readableDidRead === false on that handle; at most one run() per stream. This is stronger than a throwing double, which proves never-called only if production does not catch the throw.
2026-11-04T14:54:17+0100 Coverage gap, out of scope for this card: no spawned-CLI test pipes stdin into main.ts readAllStdin (the TTY refusal and the process.stdin wiring). The clean-checkout piped run is in: a built export of 9fec6c04 given an open brace on stdin exits 1 with "cannot read the JSON input from stdin". Sibling card TRDD-XM2OSVC0 covers the gap; it is not an eht of this card.
2026-11-04T14:54:17+0100 moved todo to dev: three implementation commits landed (9fec6c04, 898c51e3, bc9d1157).
2026-11-04T15:05:58+0100 A9 converted in 5586d0c1 (fresh ended stream per call; a mutation to an empty items list failed 6 of 15 tests). The clean checks (git archive exports of 9fec6c04 and bc9d1157) prove the committed source type-checks, lints and passes in isolation; they used the main tree installed node_modules, whose package.json the other session has modified, so a fresh-install check stays with TRDD-S5KOOT2S. No node_modules symlink within depth 2 points into src; node_modules/node_modules is a self-loop dated Oct 30, not made in this session. Every conversion is also checked in a clean git archive HEAD export, because src/config.ts (on the classify path) and src/tools/definitions.ts are modified by the other session.
2026-11-04T15:14:13+0100 A1 converted in 0de251d8. The throwing readStdin double was a hole, not an assertion: production read stdin for 5 shared flags and all 42 threshold flags, and run-decision.ts:546-552 swallowed the throw into exit 1, which the tests did not check. Each argv now ends in --input with a missing file (real ENOENT before stdin) and asserts the ENOENT message plus readableDidRead === false. This answers R4 on TRDD-M2H4RJVQ for A1: a throwing never-called double was not an assertion there.
2026-11-04T15:22:33+0100 Correction (review of b8f9a517): box 10 is verified by git show 9fec6c04 -- scripts/llm-ext/src/cli/main.ts, which holds only the readAllFrom import and the readAllStdin body change; box 1 eslint covered main.ts in the 9fec6c04 and bc9d1157 export checks (reports_dev/s3qeqbyv/20261104_144239+0100-clean-check-export.md, 20261104_145245+0100-clean-check-bc9d1157.md). The b8f9a517 subject says 12 duplicate boxes were removed; they were never committed, so its diff shows no deletion.
2026-11-04T15:22:34+0100 Correction to the 14:54:17 protocol line: data sites need a fresh stream per call because an ended stream can be read only once and the A9 test calls run() three times. Correction to the 15:05:58 line: clean checks export the commit SHA of each conversion, never HEAD, because the other session may commit; the sentence on node_modules symlinks within depth 2 has no recorded command and is unverified.
2026-11-04T15:22:34+0100 Correction to the 15:14:13 line: the 5 shared-flag and 42 threshold-flag counts come from the A1 worker probe, since removed (reports_dev/s3qeqbyv/20261104_150852+0100-a1.md); the argv of the --input flag itself and of the --not-a-flag test do not end in --input with a missing file. "This answers R4" means R4 is moot for A1 as an agent finding; the owner ruling on TRDD-M2H4RJVQ is untouched.
2026-11-04T15:25:38+0100 A2 converted in 50a6ba91 (classify-launch.test.ts, 11 io() tests). Production read stdin in none of them, and every test pins its exit code and messages, so a swallowed read would have failed them: unlike A1, the old throwing double was not a hole here. The readableDidRead guard adds detection of a read that leaves the outcome unchanged (an eager or unawaited read); only the exit-5 test is mutation-checked. classify-launch-cli.test.ts has no stdin test (grep -E for stdin or input finds only --input argv), so the old line-3 claim was false; that gap is TRDD-XM2OSVC0.
2026-11-04T15:39:41+0100 Corrections from the review of c1f7dc7f. The 15:22:34 line is wrong about the --input flag: its own argv is --input c402-missing.json, and only the --not-a-flag test lacks the missing file. Clean exports use an explicit recorded SHA (the parent before the commit), never a bare HEAD. The A2 note should read: every test pins its exit code, and the exit-1 tests also pin the exact message. Its grep found no stdin match; the input matches were the INPUT fixture and --input argv. The 15:22:33 line meant the b8f9a517 body, not its subject. receipt.test.ts calls run() 9 times in 8 tests, not three. A3 converted in c259ca52; an outcome-neutral eager read fails only at the guard (mutation 2), and 0bb339cd applied review nits.
2026-11-04T16:01:29+0100 A4 and A6 converted in 2b1006ff (input-args.test.ts, 58 tests). Never-called streams are registered and checked by one afterEach guard. Mutations: an eager read fails 47 tests at the guard, a swallowed read fails 10 tests on outcomes, and changed data bytes fail 2 tests. The `-` plus `--items -` data double was never called (input-args.ts:129 refuses first). Comment fixes landed in 1065b047. The STATE block was updated per the review of 1065b047 and ae64d52d.
2026-11-04T16:11:55+0100 A5, A7 and A8 converted in 5461497d (input-args-document.test.ts, 18 tests). noStdin was never called; the six data doubles are each called once. Mutations: eager reads fail 9 and 11 tests (mutation 1a: 8 at the guard plus the D2 counter, expected 2 to be 1; mutation 1b: 11 at the guard); a swallowed read (mutation 2: drop --input, so unmodified production takes its JSON stdin path) fails 5 of the 8 default run() tests on outcomes; on the other 3, production refuses before reaching stdin, so those tests pass under the mutation and only the guard would detect a read there; changed bytes fail 3. STATE updated per the reviews of 2b1006ff and b2831282 (A6 relabel, registry shape, remaining WHY fixes).
2026-11-04T16:12:47+0100 Site map for input-args-document.test.ts, chosen by the A5 worker and recorded here so the box 9 grep uses the same map: A5 = noStdin (never-called); A7 = the two run() data doubles D1 and D2; A8 = the four direct assembleFileInput data doubles D3 to D6. D2 is a counting spy around the real reader (stdinBytes), not a fixed-bytes double; the box 9 grep must classify it as a spy. Commit message 5461497d omits the mutation 2 mechanism (drop --input) and words the 3 pre-stdin refusals as failures; the line above is the correct wording.
2026-11-04T16:17:50+0100 WHY comment fixes landed in 7db335c5: the input-args.test.ts Measured line, the it.concurrent caveat in input-args and input-args-document, and the /etc/hosts class-only clause in review-fixes. Checked after the commit: the class-only claim holds for the direct assembleFileInput case at review-fixes.test.ts:174 (rejects.toThrow(InputError)); the runFindings /etc/hosts cases at :79-81 also pin the message, so the comment should say direct.
2026-11-04T16:41:24+0100 A10 to A12 converted in 4a94ff0a (run-decision.test.ts, 65 tests). Site map from the worker: A10 = the io helper (readStdin called 8 times in 7 tests, never called in the rank --save refusal and the --nope half of the unknown-flag test); A11 = the run helper (never called by the 6 argv rows, all refused first); A12 = the dry helper (called once in each of its 4 tests). readFile is the real readFileSync in all three helpers and no test calls it (no --input argv in the file). Mutations: an eager read fails 8 of 65 tests, all at the guard, and no body assertion failed (the commit message says every outcome unchanged; this is the exact wording); a discarded read fails 10 of 65 on outcomes; changed bytes in dry fail 4. Report reports_dev/s3qeqbyv/20261104_162200+0100-a10-a12.md.
2026-11-04T16:41:25+0100 d5335100 names the direct assembleFileInput /etc/hosts case (:174) as the only class-only case; the three runFindings /etc/hosts rows (:79-81) also pin the message.
2026-11-04T16:41:26+0100 Final checks at d5335100 (report reports_dev/s3qeqbyv/20261104_163309+0100-final-checks.md): no fixed-bytes or throwing stdin or readFile double is left in the 8 test files, and no other *.test.ts under src has a readStdin site; the input-args-document D2 counter is a spy around stdinBytes. A clean export of d5335100 passes the 8 files one at a time (230 tests) and tsc --noEmit (vitest 4.1.8, tsc 5.9.3, node v26.12.1); no tracked file touched; deps and vitest cache are shared with the main tree. All 15 implementation commit subjects cite TRDD-S3QEQBYV. Box 11 covers the 8 files and tsc, not the full suite (that is TRDD-YGF9YXF2).

## Approval log

- 2026-11-04T14:11:25+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-04T14:55:08+0100 — column → dev. three implementation commits landed (9fec6c04, 898c51e3, bc9d1157)
- 2026-11-04T16:44:22+0100 — COMPLETE by main-agent@llm-externalizer-plugin. all 12 acceptance boxes ticked; final checks at d5335100 in reports_dev/s3qeqbyv/20261104_163309+0100-final-checks.md.
