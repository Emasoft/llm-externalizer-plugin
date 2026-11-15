---
trdd-id: 2GC5DHR7
title: TTY refusal and empty-stdin tests for classify stdin input
column: testing
status: tasked
created: 2026-11-14T15:39:24+0100
updated: 2026-11-14T15:49:40+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T15:39:24+0100
implementation-commits: [f37884d1, 08e2b389, dad08140]
---

# TTY refusal and empty-stdin tests for classify stdin input

2026-11-14T15:39+0100 Follow-up to the archived TRDD-XM2OSVC0 (test 1c41b721, card 48c4f1f5), which is frozen, so its corrections are recorded here.

Owed: (1) the TTY refusal (stdin is a terminal, exit 1) has no test. A pseudo-terminal through script(1) works by hand on macOS (script -q /dev/null <cmd>); util-linux takes script -qec <cmd> /dev/null. A platform-conditional test was not attempted; it was not shown to be impossible. (2) empty stdin (immediate EOF) into classify filter --estimate is not covered.

Corrections to the XM2OSVC0 closing (review of 48c4f1f5): its Acceptance checklist was written at closing, because the archive gate refused a card with none, and was derived from the Task paragraph. Box 2's no catalog fetch is narrower than the truth: one profile-selection endpoints GET happens, answered from the p02 fixture. These are worker-reported, not measured by the main agent: the five test-side mutations red, the first-chunk-only bundle copy failing with exit 1 (it needed a symlinked node_modules and a temporary CLI_SCRIPT swap, later restored), 31/31, tsc 0, eslint 0, and the token counts 138 and 68219. The main agent read the test file and the diff, and confirmed CLI_SCRIPT is restored and dist unmodified. The ubs pre-commit scan of 1c41b721 timed out on its own at 180 s, with no bypass. The 15:06 caveat on XM2OSVC0 is resolved for the committed dist: dd283255 contains readAllFrom and the test runs against it. No release after 14.2.0 ships it yet.

Acceptance:
- [ ] a test covers the TTY refusal on macOS and Linux, or a recorded decision says it stays untested
- [x] a test pipes empty stdin and pins the exit code and message

## Approval log

- 2026-11-14T15:39:24+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T15:43:47+0100 — column → testing by main-agent@llm-externalizer-plugin. both tests landed f37884d1; linux branch of the TTY test still unrun

## Notes

2026-11-14T15:40+0100 further corrections (review of 4bb78121): the 1c41b721 commit message lists 31/31, tsc 0 and eslint 0 without saying they are worker-reported (history not rewritten); XM2OSVC0 box 3, same npm test step, was read from package.json and not run. Never run on Linux is meant as not run on Linux as of 2026-11-14 (local macOS runs only, not pushed). The empty-stdin and TTY cases stay on this one card because one worker lands both in the same test file and commit; this Notes section is a record, not work.
2026-11-14T15:41+0100 the archive refuses even an Approval-log append on XM2OSVC0 (archived cards are immutable, TRDD-MQE5D28T D8), so the archived card cannot point here; find these corrections from XM2OSVC0 with trddgrep XM2OSVC0.
2026-11-14T15:43+0100 landed as f37884d1 in src/cli/classify-stdin-cli.test.ts. Empty stdin, measured on the built CLI: exit 1, the same cannot read the JSON input from stdin refusal as truncated JSON, empty stdout, no fetch; it is a clean refusal, so it is pinned (box 2 ticked). TTY refusal: runs on a pseudo-terminal made by script(1), BSD syntax on darwin and util-linux on linux, skipped without script(1) (Windows). It passes on macOS; the linux branch never ran (Docker daemon down, no Linux host), so box 1 stays open until a Linux run (CI or a container). Both cases landed in one commit with a clean empty-stdin result, so the 1c32b0ac reason for not splitting this card now holds. Worker-reported (reports_dev/2gc5dhr7/20261114_154307+0100-stdin-tests.md): 7 new assertions red under test-side mutations, 5/5 alone, 33/33 with the two sibling spawned-CLI files, tsc 0, eslint 0. On commit, ubs flagged an informational arrow-with-braces note on the EPIPE handler; its void return is intended.
2026-11-14T15:47+0100 correction to the f37884d1 note (review): the empty-stdin measurement (exit 1, same refusal as truncated JSON) and the Docker daemon being down are worker-reported, not measured by the main agent. The test pins current behaviour; the refusal does not tell empty input from truncated input (an open question, not a decision). 08e2b389 applies the rest of that review: linux needs util-linux script (BusyBox skipped), SHELL=/bin/sh on the linux pty run, and the guard is the message (contains stdin is a terminal, not from stdin: Unexpected), because exit 1 alone does not discriminate. A scratch bundle with the TTY check forced off failed the message assertion (worker-reported).
2026-11-14T15:49+0100 dad08140 applies the second review: the pty test asserts the CLI-owned clause no --input given and stdin is a terminal (the V8-tied negative stays secondary); the linux probe reads script --version stdout plus stderr. Decisions recorded: the linux branch stays enabled though it has never run, and the risk that the first Linux CI run goes red is accepted (fail-fast: it goes red, never falsely green; YHGYWPHQ requires it running and not skipped). The runOnPty rename is declined: out of scope; the null-means-pty overload is documented on runWithStdin. Correction to the f37884d1 commit message (history not rewritten): Measured first means measured by the worker, not by the main agent.
