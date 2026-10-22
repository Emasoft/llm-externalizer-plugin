---
trdd-id: BUL4EEBP
title: C4-01 runDecision generic runner
column: blocked
status: tasked
created: 2026-10-07T19:59:56+0200
updated: 2026-10-10T08:29:45+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:59:56+0200
implementation-commits: [643d7887, 67649b69, 6cc2a9ad, 3c3db86f, 5933dc06]
blocked-by: [ZB41KG62]
unblock-when: [decision:test-doubles-ruling]
pre-block-column: dev
blocker-probe: 'grep -qF OWNER-RULING-test-doubles: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_050214+0200-ZB41KG62-classifiers-command-group-system-one-inference-with-the-jev-.md'
blocker-holds-if: exit-nonzero
---

# C4-01 runDecision generic runner

## Goal

One generic runner, `runDecision`, that serves every classify spec through one code path, taking input from `--input file.json` or stdin plus the flags each spec declares.

## Approval log

- 2026-10-07T19:59:56+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:33+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T08:16:45+0200 — column → blocked by main-agent@llm-externalizer-plugin. waits on the owner ruling about test doubles (plan card ZB41KG62, OWNER DECISION single open item)

## Plan refs

- §3 L4 row (`classifiers/run-decision.ts`, Deps seam pattern of `text-tools/core.ts`; signature `runDecision<I, R>(spec, argv, deps): Promise<ExitCode>`), §9 (input modes shared by every command; exit codes), D2, D10, D18.
- §9: exit codes follow llm-ext's existing conventions; the qs mapping (3 key/credits, 4 request rejected, 5 failed after retries) is kept where llm-ext has no code of its own; C4-01 reads `cli/main.ts` first.

## Depends on

SP-00 (TRDD-DAGBDXUB), L0-02 (TRDD-CWQOWEHO), L2-04 (TRDD-M2X02VG9), L2-12 (TRDD-B3R1SCSX), L2-13 (TRDD-9FE4Q3H3), L2-17 (TRDD-7BT0W914)

## Files

- `scripts/llm-ext/src/classifiers/run-decision.ts` (create).
- Other files (test file, vitest include entry): to be listed at card start.

## Reuse

- `Deps` seam pattern of `text-tools/core.ts` (plan §3). `cli/main.ts` exit conventions (read first). Otherwise read the code at card start.

## Steps

1. Read `cli/main.ts` and record llm-ext's existing exit codes; map qs codes 3, 4, 5 only where llm-ext has none.
2. Read `text-tools/core.ts` and copy its `Deps` seam pattern for `RunDeps`.
3. Implement `runDecision(spec, argv, deps)`: parse `--input file.json` or stdin, plus the flags the spec declares.
4. Route build, plan, execute, project and emit through L2/L3 only; the runner holds no decision text (§3 "Must NOT: re-implement anything below").
5. Document in WHY comments why there is exactly one path for all specs (derived from done-when).

## Acceptance

- [x] input via `--input file.json` or stdin, plus spec-declared flags
- [x] one code path for all specs
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

`definitions.ts` entries (C4-02), launcher wiring (C4-03), `ask` (C4-04), `-o` and `--strict-exit` (C4-09), receipt (C4-12).

## Notes

2026-10-10: runDecision core and runDecisionArgv (--input or stdin, --profile, --max-budget, --chunk-chars, --default, spec threshold flags), one code path for all specs, tested in classifiers/run-decision.test.ts, committed in 643d7887; boxes 1 and 2 ticked. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62), and the test file uses a vi.mock passthrough read counter, arguably a double beyond the GlobalFetch seam; commit traceability: implementation-commits on this card; 643d7887's body names the card id. Still owed beyond the boxes: no CLI command is wired to the runner yet (C4-02 onwards) and text-mode inputs (--items, files, --lines) are not in it. Reports: docs_dev/20261010-C4-01-report.md, docs_dev/20261010-runner-registry-report.md, docs_dev/20261010-catalog-read-once-report.md, docs_dev/20261010-wave9-leftovers-report.md
2026-10-10: 67649b69 changed the runner: one record of bills per request in l2/fan-out.ts so a reply billed and then lost to Ctrl-C or a run-stopping failure keeps its cost exactly once; a deadline expiry keeps class timeout instead of 'internal error'; an unexpected programming error names its type and prints its stack once per run when LLM_EXT_DEBUG is 1 or true (new environment variable, documented); a malformed catalog model id is reported as malformed; 67649b69's body names this card id. Known and not fixed: a retried request counts only its last bill; an internal error shares exit code 5 with a provider bad response. Report: docs_dev/20261010-wave9-final-fixes-report.md
2026-10-10: 6cc2a9ad exported the shared flags from run-decision.ts (then moved to classifiers/shared-flags.ts, a leaf module, with the parser reading the list; 3c3db86f made boolean flags a typed union with required 'sets'). Its last item, the CLI wiring, lands with C4-03 (TRDD-4Q1IVJOE); this card stays in dev and is closed in the same records commit. For the coordinator to decide, no verdict given here: the definition-of-done clause reads 'no test doubles beyond the GlobalFetch seam'; scripts/llm-ext/src/classifiers/run-decision.test.ts has, at line 23 vi.mock("./l0/catalog.js", async (orig) => {, line 30 vi.mock("./l0/response.js", async (orig) => {, line 35 vi.mock("node:fs", async (orig) => {, and at lines 552, 570 and 582 vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => { written.push(String(c)); return true; }) as never).
2026-10-10T08:01:21+0200 5933dc06: vi.mock wrappers of catalog, response, node:fs and the process.stderr spy removed; catalog loads counted as catalog fetches with ttlMs 0; RunDeps gains an optional stderr writer (default process.stderr; the CLI passes its own writer, which only adds a newline: run-decision.ts:320, main.ts:818). Now UNTESTED, code kept: a billed reply followed by an unclassified throw keeps its cost and its siblings' answers; a deadline after billing keeps the timeout class; the LLM_EXT_DEBUG stack is key-redacted. OPEN DEFECT: a reply whose price cannot be read and whose usage has no cost is reported as 'internal error in this request (Error)', exit 5, a programming-error label for a provider-data condition; the follow-up 2 and last-pass-2 tests pin that current classification. Still not double-free: hand-built spec objects at run-decision.test.ts:267, 278, 352 (the withBuild helper used by many tests), 580, 595; and injected sigint EventEmitter and stderr/stdout sinks. Definition-of-done box stays unticked pending the owner ruling on the plan card.
2026-10-10T08:13:23+0200 Earlier notes on vi.mock pass-throughs are superseded by the 08:01:21 note (5933dc06 removed them).
