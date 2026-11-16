---
trdd-id: OZIIABLY
title: classify --profile lands in an input slot when the command line has a bare --
column: published
status: archived
created: 2026-11-14T13:35:46+0100
updated: 2026-11-16T20:14:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T13:35:46+0100
implementation-commits: [f90f1055]
blocked-by: []
unblock-when: [trdd:G0MS9B63]
pre-block-column: 
blocker-probe: node -e "new (require('./scripts/llm-ext/node_modules/better-sqlite3'))(':memory:')"
blocker-holds-if: exit-nonzero
---

# classify --profile lands in an input slot when the command line has a bare --

Symptom: llm-ext classify <cmd> with --profile and a bare -- fails with llm-ext: no such file or directory: --profile. Cause: runClassifyCommand (scripts/llm-ext/src/cli/launcher.ts:194) appends --profile <name> AFTER the argv; the runner reads every token after -- as a positional, the question first and then inputs (inferred from the 87c34c1d test passing; not traced in run-decision.ts), so the appended --profile lands in an input slot (run-decision.ts, if (raw === "--")). Measured 2026-11-14T13:35+0100 in reports_dev/58cfbqhn/logs/dashdash3-vitest.log (test call with profileFlag c and argv [--, --estimate, question, file]). Likely fix: put --profile <name> in front of the argv, as --estimate already is (launcher.ts:193), plus a test with profileFlag set and a --. Found while writing the TRDD-58CFBQHN test (87c34c1d).

## Approval log

- 2026-11-14T13:35:46+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T14:04:15+0100 — column → dev by main-agent@llm-externalizer-plugin. keep-going mode; confirmed defect with a located cause
- 2026-11-14T14:33:01+0100 — column → blocked by main-agent@llm-externalizer-plugin. fix landed (f90f1055); only box 6, the full npm test, remains and it needs the better-sqlite3 binding (TRDD-G0MS9B63)
- 2026-11-16T09:24:51+0100 — column → testing by main-agent@llm-externalizer-plugin. blocker G0MS9B63 complete Cleared blocked-by (--clear-blocker override).
- 2026-11-16T20:14:29+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (squash c4dc6bd5; sampled added lines of its commits present in v14.3.0); full npm test green in the v14.4.0 publish 2026-11-16.

## Notes

2026-11-14T13:37+0100 Correction to the body (review): measured only at the runClassifyCommand level (one unit-test call with profileFlag c, argv [--, --estimate, question, file]; stderr: llm-ext: no such file or directory: --profile); the CLI-level symptom is inferred, since how main.ts hands a --profile to the launcher was not run. After --, the first positional fills the question slot and later positionals are inputs, so the appended --profile lands in an input slot; the body's every token after -- as a file name is too broad. The fix's test must combine --profile, -- and --estimate. Created straight into todo because it is a confirmed defect found while working, with a known one-line cause.
2026-11-14T13:38+0100 Body and title reworded to the narrower claim; the 13:37 note's with a known one-line cause is a guess: the cause is located at launcher.ts:194, but the fix interacts with the --estimate hoist and classifyArgv.
2026-11-14T14:31+0100 Fix landed as f90f1055. Box 1: before the fix the new paid test failed with no such file or directory: --profile (captured under vitest 5.1.0 run from /tmp; an earlier --estimate variant failed the same way under the repo vitest 4.1.8); after, it passes under 4.1.8. Box 2: profile z (api_key $C403_Z_KEY) differs from active_classifier c; the test asserts the decision request carries z's key. Box 3 (subset): classify-launch 26/26, definitions-classify 21/21, built-CLI classify-launch-cli 19/19 and classify-review-cli 9/9, tsc and eslint clean (main agent's own runs). Box 5: main.ts:661-676 extractProfileFlag strips the first --profile anywhere in argv, including after --, so the user-facing case is fixed here; a literal --profile typed after -- is therefore eaten as a flag, the same class of question as --estimate after -- (open owner question on TRDD-58CFBQHN).
2026-11-14T14:33+0100 Box 4: a fresh worktree at f90f1055 (builds_dev/wt-oziiably), npm ci --ignore-scripts and npm run build both exit 0; dist/llm-ext.js and dist/benchmark.js cmp identical to the committed files (llm-ext.js SHA-1 69efd764032797...), worktree status empty after the build. Box 1 exact proof: in a worktree at the parent 6eb08a3a with the new test file copied in, the repo vitest 4.1.8 runs the new test and it fails with llm-ext: no such file or directory: --profile (exit 1).
2026-11-14T14:33+0100 Not covered (review of f90f1055): no test drives main.ts with --profile and -- together, so the CLI-level symptom stays inferred; a second --profile typed by the user is not stripped by main.ts (only the first is) and was not tested before or after the fix. The test's stderr filter (lines starting with an em dash and a space) matches the neighbouring paid test at classify-launch.test.ts:185.
2026-11-14T14:33+0100 Unblock rules: the blocker-probe is the ground truth (run it from the repo root; exit 1 is also produced by a wrong cwd, a node ABI or architecture mismatch, so confirm with the error text Could not locate the bindings file). When it passes, close TRDD-G0MS9B63 too, so unblock-when agrees; then the card returns to testing (pre-block-column) for the box-6 full npm test. Scratch worktrees from the proofs: builds_dev/wt-oziiably (f90f1055, clean, used for box 4) and builds_dev/wt-oziiably-parent (6eb08a3a plus an uncommitted copy of the new test, used only for the box-1 fail-before run); neither is a source of truth.
2026-11-16T20:14:20+0100 main agent: full npm test green in the v14.4.0 publish run (all 4 stages: 6334, 221, 12, 1 passed; log builds_dev/dev-after-14.3.0/reports_dev/publish/test.log), with the better-sqlite3 binding rebuilt by publish.py. Box ticked on this evidence.

## Acceptance

- [x] the new test fails on the unfixed code with no such file or directory: --profile and passes after the fix (paid path, profileFlag set, a bare --)
- [x] the test proves the profile is applied, not dropped, using a profile that differs from the default active_classifier
- [x] classify-launch tests and every test file using runClassifyCommand pass; tsc and eslint clean
- [x] dist rebuilt from the fixed source and committed, byte-identical to a build in a fresh worktree after npm ci; better-sqlite3 stays external
- [x] main.ts handling of a --profile typed after -- is reported with file:line, and either covered by this fix or filed as its own card
- [x] full npm test green after TRDD-G0MS9B63 (the box-3 run is a subset while the sqlite binding is missing)
