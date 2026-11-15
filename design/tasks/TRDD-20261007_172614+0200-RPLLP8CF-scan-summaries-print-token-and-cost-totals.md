---
trdd-id: RPLLP8CF
title: Scan summaries print token and cost totals
column: todo
status: tasked
created: 2026-10-07T17:26:14+0200
updated: 2026-11-05T01:10:13+0100
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T17:26:14+0200
release-via: publish
target-release: 14.1.0
implementation-commits: [d1f17e71, 34b0bf4d, ed040185]
---

# Scan summaries print token and cost totals

Read the ⏵ STATE block below first; it is authoritative; it sits lower in the card.

## Issue item
Issue 16 smaller note: no token or cost totals at the end of a scan.

## Trace and status
OPEN. scan-folder/core.ts summaries (lines 342, 400, 421) carry counts only; no usage or cost field is aggregated.

## Acceptance
- [ ] SCAN COMPLETE shows summed tokens in/out and cost (0.0000 on a free profile) for scan_folder and the other per-file tools
- [x] test with a recorded usage object from a real local server

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:14+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Ordering

Lands after TRDD-PN84WC1L: both edit the scan-folder/core.ts summary block.

## Notes

2026-10-31: box 2 ticked on commit d1f17e71 and the real node:http test in src/scan-folder-http-failures.test.ts passing on 2026-10-31. Box 1 left open: that test covers scan_folder only, and does not show the 0.0000 free-profile line or the other per-file tools. Card not moved.
2026-11-04T22:51+0100 audit (read-only; reports_dev/rpllp8cf/20261104_224642+0100-per-file-tools-audit.md and 20261104_224929+0100-measure.md): formatUsageTotals already runs in scan folder (scan-folder/core.ts:362, 421, 443), scan quality (same core) and batch check (index.ts:6811, 6821); of the commands audited (review_plan and rules_check were not read), no other prints a COMPLETE summary while holding per-file usage.
2026-11-04T22:51+0100 measured: a raw OpenRouter reply from nvidia/nemotron-3.5-lightning:free carried usage.cost 0 with no request option (one request; a second free model returned 429); the WebFetch summary of the OpenRouter usage-accounting page says usage is always included. On the single-model path a free run therefore prints cost $0.0000 only when every file reply carried cost 0 (assuming free rotation passes the usage block unchanged: index.ts:4242 was read, 3330-3390 was not; the ensemble merge can turn a missing cost into a known sum, see TRDD-8Y0LXT93); one rejected reply without a cost makes the run cost unknown.
2026-11-04T22:51+0100 box 1 not ticked, because its scope is the owner call. Reading proposed to the owner: the other per-file tools are scan quality and batch check, the commands that print a COMPLETE summary. Outside that reading: llm ask and llm code with one report per file (answer mode 0) and grouped batch check, which print one report path per line; the alternative is to print their totals on stderr or after the path list, leaving stdout unchanged.
2026-11-04T22:51+0100 d1f17e71 and 34b0bf4d are in no tag (git tag --contains printed nothing) and only on release/13.6.1, so no shipped build is expected to print the totals line yet (inferred: a cherry-pick under another hash would escape git tag --contains, and the installed 14.2.0 was not run on a scan).
2026-11-04T22:55+0100 correction to the Trace and status section: since d1f17e71 the scan-folder/core.ts summaries carry the summed usage and cost (formatUsageTotals in usage-totals.ts), and its line numbers are stale. Untested so far: the merged batch check summary at index.ts:6811 (answer mode 1 or 2 with every file ok) and the Usage part of SCAN COMPLETE in answer modes 1 and 2 (scan-folder/core.ts:421, 362).
2026-11-04T22:55+0100 related: TRDD-8Y0LXT93 (the ensemble merge reports a partial cost sum as a known cost).
2026-11-04T23:14+0100 tests landed as ed040185 (test only): a reported cost of 0 prints cost $0.0000 on the SCAN COMPLETE line (answer mode 0), and batch check answer mode 0 prints its totals (index.ts:6821). The file ran alone twice with vitest --root on the package, 7 of 7 both times; tsc --noEmit and eslint exit 0. The tree held another session uncommitted edits (among them config.ts, cli/main.ts, tools/definitions.ts, the governor, broker and calibration files, and vitest.config.ts), so a clean-tree run at a commit containing ed040185 is still owed. The zcost0 test covers the single-model local path only, not free rotation or the ensemble merge.
2026-11-04T23:14+0100 hazard: a vitest run with a file filter but without --root, whose RUN banner showed the repo root, ran 8 files and 41 tests (inferred: copies of the file in nested worktrees), not this file; pass --root with the package path for a single-file run.
2026-11-04T23:14+0100 update to the 22:55 untested list: batch check answer mode 0 (index.ts:6821) is now tested by ed040185; still untested are index.ts:6811 and SCAN COMPLETE answer modes 1 and 2 (scan-folder/core.ts:421, 362). The file is in the explicit vitest include list (vitest.config.ts:598 at ebeab4fd), so npm test runs it.
Correction to commit cf14ec34 message (2026-11-05): by an earlier session account, two review rounds covered the 23:14 Notes lines; the qualifier and STATE pass was read in full by the main agent, not reviewed; "8 unrelated files" is unmeasured, the 23:14 hazard line says inferred worktree copies.
2026-11-05T01:10+0100 The owed clean-tree run exists: run 4b at c668389e (contains d1f17e71, 34b0bf4d, ed040185; TRDD-YGF9YXF2) passed npm test end to end, exit 0; the ed040185 tests ran in stage 1 (inferred from the +2 test count, 5723 to 5725, F4: the reporter prints no per-file pass lines). Box 1 stays unticked (owner decision).

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-05

- NOW: box 2 ticked (d1f17e71, test passing 2026-10-31). Box 1: the totals line exists in scan folder, scan quality and batch check, and ed040185 tests it on the single-model local path in answer mode 0; box 1 is not ticked.
- WAITING ON OWNER (only the box-1 tick waits on the owner; the release needs the owner; the answer-mode 1/2 and :6811 tests are parked; the free-rotation path test is workable; the ensemble path test waits on TRDD-8Y0LXT93): the scope of box 1 is the owner decision, see the 22:51 Notes line (only scan quality and batch check, or also llm ask, llm code and grouped batch check with their totals on stderr).
- OWED: a release containing d1f17e71, 34b0bf4d and ed040185; tests for index.ts:6811 and SCAN COMPLETE answer modes 1 and 2; the free-rotation and ensemble request paths are untested.
- RELATED: TRDD-8Y0LXT93 (the ensemble merge reports a partial cost sum as a known cost).
