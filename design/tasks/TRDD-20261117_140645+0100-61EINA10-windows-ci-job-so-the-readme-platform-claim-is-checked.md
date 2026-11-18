---
trdd-id: 61EINA10
title: Windows CI job so the README platform claim is checked
column: todo
status: tasked
created: 2026-11-17T14:06:45+0100
updated: 2026-11-18T16:54:56+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T14:06:45+0100
implementation-commits: [e6cb8295]
---

# Windows CI job so the README platform claim is checked

README.md:15 and :129 claim macOS, Linux and Windows; .github/workflows/ci.yml:20 and release.yml:16 run only on ubuntu-latest, and no Windows run of the CLI or the tests exists. Needed by RL-08 (TRDD-YHGYWPHQ), whose box 1 asks for the cross-platform checks to pass on every listed platform. Scope: a windows-latest job that builds the bundle, runs llm-ext --version and --help through the bin shim, and runs the test files that do not need lsof, script(1) or a POSIX shell; each test that cannot run on Windows gets a platform gate with a WHY comment naming the POSIX-only feature, never a plain skip. The job lands only through scripts/publish.py; its first run will likely be red, and that is accepted (fail-fast). Acceptance: the Windows job is green on a main push, or each remaining failure has its own card.

## Approval log

- 2026-11-17T14:06:45+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-18T05:13:40+0100: windows.yml added (separate workflow); runs build, CLI smoke via Git Bash and PowerShell, test:unit; stages 2-4 excluded at job level, follow-up TRDD-6Y9AIMHI; no test pre-gated (gates follow real Windows failures); lands with the next code release through publish.py.
2026-11-18T05:18:31+0100: review corrections. (1) The CRLF reason (.gitattributes) and the cmd.exe single-quote reason (package.json test:unit) are expected behaviour, unverified until the first windows-latest run. (2) Per-test platform gates are deliberately deferred to the failures of that first run; each remaining failure gets its own card (the acceptance's second branch); TRDD-6Y9AIMHI covers only stages 2-4. (3) The stage-1 file-set proof (352 files, identical old vs new) ran under sh on macOS only, not under npm on cmd.exe. (4) TRDD-6Y9AIMHI was written by a worker to the main agent's spec; created-by main-agent is confirmed by the main agent.
2026-11-18T05:34:59+0100 e6cb8295 adds .github/workflows/windows.yml, .gitattributes (LF checkout) and the shell-neutral npm test stages. The "actionlint and zizmor 1.30.1: no findings" in its message is from the run of the worker, not re-run by the main agent. The workflow has not run yet: it runs on the first push to main or by workflow_dispatch, so the CRLF and cmd.exe quoting expectations stay unverified until then.
2026-11-18T10:24:01+0100 main agent: first Windows run 44269244689 on 26c24ecc (v14.7.1) failed at Unit tests (stage 1), the only failed step: the vitest globalSetup test-tmpdir-guard.ts acquireRunLock got ENOENT on D:\tmp\vitest-llmx-run.lock; vitest then printed "No test files found", which by a worker reading of the vitest 4.1.12 code is a consequence (no test module ran), not a separate fault. Fix chosen: a workflow step creates /tmp before the unit tests (node mkdirSync, on the same drive as the tests); moving the tests off a fixed /tmp is TRDD-OSNHW0W9.
2026-11-18 main agent: second Windows run 44305836777 on v14.7.2. The /tmp step worked: global setup passed (0 matches for vitest-llmx-run.lock). Unit tests (stage 1): 195 failed, 6348 passed, 31 skipped of 6574 tests; 42 of 353 files failed. Triage (worker report reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md; causes marked ? there are unverified), 17 groups: G1 36 config dir "outside allowed paths" (? 8.3 short name RUNNER~1 vs runneradmin); G2 25 missing sqlite3, lsof, /bin/sh; G3 13 and G11a 4 POSIX vs Windows path form in expectations; G4 4 rooted or drive-mangled paths; G5 15 file ids with backslashes; G5b 5 cause not determined; G6 10 Windows-invalid names and /etc/hosts not absolute; G7 6 timeouts; G8 25 readyLocalTarget undefined; G9 8 governor (mode bits, SIGSTOP, ps -o); G10 5 POSIX file modes and read-only dirs; G11b 12 benchmark scores and the hq-scan quality gate; G12 10 misc; G13 9 classify-review CLI exits 1; G14 3 report path form; G15 5 local-fallback warnings absent. Next per the Acceptance: a fix or a card per group.
2026-11-18T16:54:35+0100 Run 44305836777 (v14.7.2): 195 failed of 6574 tests. The 17 groups of report-v3 became 12 cards, all parent-trdd 61EINA10, column backburner, counts 36+25+20+4+15+5+10+36+13+12+10+9 = 195: LA1MA1EL (G1, 36), A5J6E4JB (G2, 25), Z3YW19WC (G3+G11a+G14, 20), PX0X1JRD (G4, 4), J6O3YJC0 (G5, 15), 5KZJQ9N4 (G5b, 5), NIEDC62V (G6, 10), 1MT68BAJ (G7+G8+G15, 36), 1Y9UK5MK (G9+G10, 13), WANWRYNT (G11b, 12), VQ0VEK3L (G12, 10), CEBZRG4Y (G13, 9). Group ids G1 to G15 are those of reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md.
2026-11-18T16:54:35+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): The acceptance text allows its second branch, "each remaining failure has its own card"; the run is red, so only that branch is reachable. The group cards are parent-trdd only (no npt, no eht) on purpose, so this card is not held by them; Windows stays experimental (README.md:15, 16719d1d). OSNHW0W9 keeps the top-level /tmp part; G1 has its own card LA1MA1EL.

## Acceptance

- [x] windows.yml exists and ran on a main push (runs 44269244689, 44305836777)
- [x] each remaining failure group has its own card (ids listed in Notes)
