---
trdd-id: 61EINA10
title: Windows CI job so the README platform claim is checked
column: todo
status: tasked
created: 2026-11-17T14:06:45+0100
updated: 2026-11-18T05:35:00+0100
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
