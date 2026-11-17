---
trdd-id: 61EINA10
title: Windows CI job so the README platform claim is checked
column: todo
status: tasked
created: 2026-11-17T14:06:45+0100
updated: 2026-11-17T14:06:45+0100
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
---

# Windows CI job so the README platform claim is checked

README.md:15 and :129 claim macOS, Linux and Windows; .github/workflows/ci.yml:20 and release.yml:16 run only on ubuntu-latest, and no Windows run of the CLI or the tests exists. Needed by RL-08 (TRDD-YHGYWPHQ), whose box 1 asks for the cross-platform checks to pass on every listed platform. Scope: a windows-latest job that builds the bundle, runs llm-ext --version and --help through the bin shim, and runs the test files that do not need lsof, script(1) or a POSIX shell; each test that cannot run on Windows gets a platform gate with a WHY comment naming the POSIX-only feature, never a plain skip. The job lands only through scripts/publish.py; its first run will likely be red, and that is accepted (fail-fast). Acceptance: the Windows job is green on a main push, or each remaining failure has its own card.

## Approval log

- 2026-11-17T14:06:45+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
